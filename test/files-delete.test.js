'use strict';
// /api/projects/:id/files/delete 删除路由（进回收站，PS 不可用时降级物理删除）。
// 用临时目录构造项目，断言：文件/文件夹删除成功（目录递归）、项目根拒绝（sub='' 与 sub='.'）、
// 路径沙箱化（../ 逃逸拒绝）、目标不存在 404、项目不存在 404。
// 注：测试环境的 %TEMP% 下 PowerShell Shell.Application 可正常移入回收站（recycled:true），
// 不对 recycled 值做强断言——本机 false 时走物理删除，两种路径都覆盖删除语义本身。
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

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptp-del-'));
  projRoot = path.join(tmpDir, 'myproj');
  fs.mkdirSync(path.join(projRoot, 'dir', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(projRoot, 'a.txt'), 'hello');
  fs.writeFileSync(path.join(projRoot, 'dir', 'inner.txt'), 'world');
  fs.writeFileSync(path.join(projRoot, 'dir', 'nested', 'deep.txt'), '!');

  const projectsFile = path.join(tmpDir, 'projects.json');
  fs.writeFileSync(projectsFile, JSON.stringify([
    { id: 'good', name: 'MyProj', projectPath: projRoot, type: 'folder' },
  ], null, 2));
  process.env.PORT = '7978';
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
      host: 'localhost', port: 7978, path: reqPath, method,
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

test('删除文件：ok:true，目标消失', async () => {
  const r = await req('POST', '/api/projects/good/files/delete', { sub: 'a.txt' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.isDir, false);
  assert.strictEqual(typeof r.body.recycled, 'boolean');
  assert.strictEqual(fs.existsSync(path.join(projRoot, 'a.txt')), false);
});

test('删除文件夹：递归删除整个目录', async () => {
  const r = await req('POST', '/api/projects/good/files/delete', { sub: 'dir' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.isDir, true);
  assert.strictEqual(fs.existsSync(path.join(projRoot, 'dir')), false);
});

test('sub 为空字符串（项目根）：拒绝 400', async () => {
  const r = await req('POST', '/api/projects/good/files/delete', { sub: '' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.ok, false);
});

test("sub='.'（resolve 后落在项目根）：拒绝 400", async () => {
  const r = await req('POST', '/api/projects/good/files/delete', { sub: '.' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.ok, false);
});

test('路径逃逸（../）：拒绝 400', async () => {
  const r = await req('POST', '/api/projects/good/files/delete', { sub: '../outside.txt' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.ok, false);
});

test('目标不存在：404', async () => {
  const r = await req('POST', '/api/projects/good/files/delete', { sub: 'no-such.txt' });
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.ok, false);
});

test('项目不存在：404', async () => {
  const r = await req('POST', '/api/projects/nope/files/delete', { sub: 'a.txt' });
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.ok, false);
});
