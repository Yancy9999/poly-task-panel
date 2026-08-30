'use strict';
// /api/projects/:id/file-content 写入（PUT）与 /files/new 新建（POST）路由。
// 用临时目录构造项目，断言：PUT 保存成功并返回新 mtime、mtime 冲突 409、路径沙箱化（../ 逃逸拒绝）、
// 二进制拒绝 415、内容超限 413；POST 新建文件/文件夹、重名 409、name 含路径段拒绝、父目录不存在 404。
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let srv = null;
let tmpDir, projRoot;

before(() => {
  // 拦截 createServer 拿到实例，after 里关闭，避免 listen 挂住事件循环
  const origCreate = http.createServer;
  http.createServer = (...a) => { srv = origCreate.apply(http, a); return srv; };

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptp-edit-'));
  projRoot = path.join(tmpDir, 'myproj');
  fs.mkdirSync(path.join(projRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projRoot, 'a.txt'), 'hello');
  fs.writeFileSync(path.join(projRoot, 'bin.dat'), Buffer.from([1, 0, 2, 0, 3]));

  const projectsFile = path.join(tmpDir, 'projects.json');
  fs.writeFileSync(projectsFile, JSON.stringify([
    { id: 'good', name: 'MyProj', projectPath: projRoot, type: 'folder' },
  ], null, 2));
  process.env.PORT = '7957';
  process.env.PROJECTS_FILE = projectsFile;
  process.env.SETTINGS_FILE = path.join(tmpDir, 'settings.json');
  process.env.__PTP_TMPDIR__ = tmpDir;

  require('../server.js');
});

after(async () => {
  if (srv && srv.listening) await new Promise((r) => srv.close(r));
  const tmp = process.env.__PTP_TMPDIR__;
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

function req(method, reqPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const r = http.request({
      host: 'localhost', port: 7957, path: reqPath, method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
    }, (res) => {
      let raw = '';
      res.on('data', (d) => raw += d);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw || '{}') }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ---------- PUT file-content ----------

test('PUT 保存成功：内容落盘并返回新 mtime', async () => {
  // 先 GET 拿 mtime
  const g = await req('GET', '/api/projects/good/file-content?sub=a.txt');
  assert.strictEqual(g.body.ok, true);
  const r = await req('PUT', '/api/projects/good/file-content?sub=a.txt', { content: 'world\n', mtime: g.body.mtime });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(typeof r.body.mtime, 'number');
  assert.strictEqual(fs.readFileSync(path.join(projRoot, 'a.txt'), 'utf8'), 'world\n');
  // 新 mtime 与磁盘一致：再 PUT 不冲突
  const r2 = await req('PUT', '/api/projects/good/file-content?sub=a.txt', { content: 'again', mtime: r.body.mtime });
  assert.strictEqual(r2.status, 200);
});

test('PUT mtime 冲突：返回 409 conflict，磁盘内容不变', async () => {
  const r = await req('PUT', '/api/projects/good/file-content?sub=a.txt', { content: 'clobber', mtime: 1 });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.conflict, true);
  assert.notStrictEqual(fs.readFileSync(path.join(projRoot, 'a.txt'), 'utf8'), 'clobber');
});

test('PUT mtime 缺省：直接覆盖（兼容无 mtime 的调用方）', async () => {
  const r = await req('PUT', '/api/projects/good/file-content?sub=a.txt', { content: 'no-mtime' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(fs.readFileSync(path.join(projRoot, 'a.txt'), 'utf8'), 'no-mtime');
});

test('PUT 二进制文件：返回 415 不写入', async () => {
  const r = await req('PUT', '/api/projects/good/file-content?sub=bin.dat', { content: 'text' });
  assert.strictEqual(r.status, 415);
  assert.strictEqual(r.body.isBinary, true);
  assert.deepStrictEqual(fs.readFileSync(path.join(projRoot, 'bin.dat')), Buffer.from([1, 0, 2, 0, 3]));
});

test('PUT 内容超 2MB：返回 413', async () => {
  const big = 'x'.repeat(2 * 1024 * 1024 + 1);
  const r = await req('PUT', '/api/projects/good/file-content?sub=a.txt', { content: big });
  assert.strictEqual(r.status, 413);
});

test('PUT 路径沙箱化：../ 逃逸返回 400', async () => {
  const r = await req('PUT', '/api/projects/good/file-content?sub=' + encodeURIComponent('../outside.txt'), { content: 'x' });
  assert.strictEqual(r.status, 400);
  assert.ok(r.body.msg.includes('超出项目目录'));
});

test('PUT 不存在的文件：返回 404（不支持 PUT 新建）', async () => {
  const r = await req('PUT', '/api/projects/good/file-content?sub=no-such.txt', { content: 'x' });
  assert.strictEqual(r.status, 404);
});

// ---------- POST files/new ----------

test('POST 新建文件：空文件落盘，sub 返回 / 分隔路径', async () => {
  const r = await req('POST', '/api/projects/good/files/new', { parentSub: 'src', name: 'new.js', isDir: false });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.sub, 'src/new.js');
  assert.strictEqual(fs.readFileSync(path.join(projRoot, 'src', 'new.js'), 'utf8'), '');
});

test('POST 新建文件夹：目录创建成功', async () => {
  const r = await req('POST', '/api/projects/good/files/new', { parentSub: '', name: 'assets', isDir: true });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.isDir, true);
  assert.ok(fs.statSync(path.join(projRoot, 'assets')).isDirectory());
});

test('POST 重名：返回 409', async () => {
  const r = await req('POST', '/api/projects/good/files/new', { parentSub: '', name: 'a.txt', isDir: false });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.exists, true);
});

test('POST name 含路径段/特殊字符：拒绝 400', async () => {
  for (const name of ['a/b', '..', '<x>', 'a:b']) {
    const r = await req('POST', '/api/projects/good/files/new', { parentSub: '', name, isDir: false });
    assert.strictEqual(r.status, 400, 'name=' + name);
  }
});

test('POST 父目录不存在：返回 404', async () => {
  const r = await req('POST', '/api/projects/good/files/new', { parentSub: 'no-such-dir', name: 'x.txt', isDir: false });
  assert.strictEqual(r.status, 404);
});

test('POST 路径沙箱化：parentSub 逃逸返回 400', async () => {
  const r = await req('POST', '/api/projects/good/files/new', { parentSub: '../', name: 'x.txt', isDir: false });
  assert.strictEqual(r.status, 400);
  assert.ok(r.body.msg.includes('超出项目目录'));
});

test('POST 空名称：返回 400', async () => {
  const r = await req('POST', '/api/projects/good/files/new', { parentSub: '', name: '  ', isDir: false });
  assert.strictEqual(r.status, 400);
});
