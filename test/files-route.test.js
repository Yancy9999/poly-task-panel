'use strict';
// /api/projects/:id/files 路由：列出项目目录（或子目录）一层条目。
// 用临时目录构造项目，断言：目录优先排序、隐藏文件过滤、路径沙箱化（../ 逃逸拒绝）、
// 子目录懒加载、项目/目录不存在返回 404。
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let srv = null;
let tmpDir, projectsFile, projRoot, subDir, hiddenFile, regFile;

before(() => {
  // 拦截 createServer 拿到实例，after 里关闭，避免 listen 挂住事件循环
  const origCreate = http.createServer;
  http.createServer = (...a) => { srv = origCreate.apply(http, a); return srv; };

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptp-files-'));
  projRoot = path.join(tmpDir, 'myproj');
  subDir = path.join(projRoot, 'src');
  fs.mkdirSync(subDir, { recursive: true });
  // 普通文件 + 隐藏文件 + 子目录内文件
  regFile = path.join(projRoot, 'readme.md');
  fs.writeFileSync(regFile, 'hello');
  hiddenFile = path.join(projRoot, '.gitignore');
  fs.writeFileSync(hiddenFile, 'secret');
  fs.writeFileSync(path.join(subDir, 'index.js'), 'console.log(1)');

  projectsFile = path.join(tmpDir, 'projects.json');
  fs.writeFileSync(projectsFile, JSON.stringify([
    { id: 'good', name: 'MyProj', projectPath: projRoot, type: 'folder' },
    { id: 'missing', name: 'Missing', projectPath: path.join(tmpDir, 'no-such-xyz'), type: 'folder' },
  ], null, 2));
  process.env.PORT = '7956';
  process.env.PROJECTS_FILE = projectsFile;
  process.env.__PTP_TMPDIR__ = tmpDir;

  require('../server.js');
});

after(async () => {
  if (srv && srv.listening) await new Promise((r) => srv.close(r));
  const tmp = process.env.__PTP_TMPDIR__;
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

function get(queryPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port: 7956, path: queryPath }, (res) => {
      let raw = '';
      res.on('data', (d) => raw += d);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw || '{}') }));
    }).on('error', reject);
  });
}

test('根目录：目录优先排序、隐藏文件默认过滤', async () => {
  const r = await get('/api/projects/good/files');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.path, '');
  const names = r.body.items.map(i => i.name);
  // src（目录）排在前，readme.md 在后；.gitignore 被过滤
  assert.ok(names.indexOf('src') < names.indexOf('readme.md'), '目录应排在文件前');
  assert.ok(!names.includes('.gitignore'), '隐藏文件应默认隐藏');
  const src = r.body.items.find(i => i.name === 'src');
  assert.strictEqual(src.isDir, true);
  assert.strictEqual(src.size, null);
  const file = r.body.items.find(i => i.name === 'readme.md');
  assert.strictEqual(file.isDir, false);
  assert.strictEqual(file.size, 5);
});

test('all=1 显示隐藏文件', async () => {
  const r = await get('/api/projects/good/files?all=1');
  const names = r.body.items.map(i => i.name);
  assert.ok(names.includes('.gitignore'));
});

test('子目录懒加载：sub=src 列出 index.js', async () => {
  const r = await get('/api/projects/good/files?sub=src');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  const names = r.body.items.map(i => i.name);
  assert.deepStrictEqual(names, ['index.js']);
  assert.strictEqual(r.body.items[0].isDir, false);
});

test('路径沙箱化：../ 逃逸出项目目录返回 400', async () => {
  const r = await get('/api/projects/good/files?sub=' + encodeURIComponent('../../'));
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.ok, false);
  assert.ok(r.body.msg.includes('超出项目目录'));
});

test('目录不存在：返回 404', async () => {
  const r = await get('/api/projects/missing/files');
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.ok, false);
});

test('项目不存在：返回 404', async () => {
  const r = await get('/api/projects/nope/files');
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.ok, false);
  assert.strictEqual(r.body.msg, '项目不存在');
});
