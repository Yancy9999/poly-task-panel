'use strict';
// /api/projects/:id/files 路由：列出项目目录（或子目录）一层条目。
// 用临时目录构造项目，断言：目录优先排序、黑名单过滤（.git/.svn 隐藏、.gitignore 显示）、
// hide 参数覆盖、路径沙箱化（../ 逃逸拒绝）、子目录懒加载、项目/目录不存在返回 404。
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
  // 普通文件 + 点号文件（.gitignore 应显示）+ 黑名单目录 + 子目录内文件
  regFile = path.join(projRoot, 'readme.md');
  fs.writeFileSync(regFile, 'hello');
  hiddenFile = path.join(projRoot, '.gitignore');
  fs.writeFileSync(hiddenFile, 'secret');
  fs.mkdirSync(path.join(projRoot, '.git'));
  fs.writeFileSync(path.join(projRoot, '.git', 'HEAD'), 'ref');
  fs.mkdirSync(path.join(projRoot, '.svn'));
  fs.writeFileSync(path.join(subDir, 'index.js'), 'console.log(1)');

  projectsFile = path.join(tmpDir, 'projects.json');
  fs.writeFileSync(projectsFile, JSON.stringify([
    { id: 'good', name: 'MyProj', projectPath: projRoot, type: 'folder' },
    { id: 'missing', name: 'Missing', projectPath: path.join(tmpDir, 'no-such-xyz'), type: 'folder' },
  ], null, 2));
  process.env.PORT = '7956';
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

function get(queryPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port: 7956, path: queryPath }, (res) => {
      let raw = '';
      res.on('data', (d) => raw += d);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw || '{}') }));
    }).on('error', reject);
  });
}

test('根目录：目录优先排序、黑名单默认过滤（.git/.svn 隐藏、.gitignore 显示）', async () => {
  const r = await get('/api/projects/good/files');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.path, '');
  const names = r.body.items.map(i => i.name);
  // src（目录）排在前，readme.md 在后；.gitignore 不在黑名单，正常显示
  assert.ok(names.indexOf('src') < names.indexOf('readme.md'), '目录应排在文件前');
  assert.ok(!names.includes('.git'), '黑名单目录 .git 应隐藏');
  assert.ok(!names.includes('.svn'), '黑名单目录 .svn 应隐藏');
  assert.ok(names.includes('.gitignore'), '点号文件 .gitignore 不应被隐藏');
  const src = r.body.items.find(i => i.name === 'src');
  assert.strictEqual(src.isDir, true);
  assert.strictEqual(src.size, null);
  const file = r.body.items.find(i => i.name === 'readme.md');
  assert.strictEqual(file.isDir, false);
  assert.strictEqual(file.size, 5);
});

test('hide 参数覆盖黑名单：hide=.gitignore 时显示 .git 之外仍按传入名单', async () => {
  // 覆盖名单只含 .gitignore：.git/.svn 不再隐藏，.gitignore 反而隐藏
  const r = await get('/api/projects/good/files?hide=' + encodeURIComponent('.gitignore'));
  const names = r.body.items.map(i => i.name);
  assert.ok(names.includes('.git'), '覆盖后 .git 不应隐藏');
  assert.ok(names.includes('.svn'), '覆盖后 .svn 不应隐藏');
  assert.ok(!names.includes('.gitignore'), '覆盖名单中的 .gitignore 应隐藏');
});

test('hide 参数精确匹配：hide=node_modules 不影响点号文件', async () => {
  const r = await get('/api/projects/good/files?hide=node_modules');
  const names = r.body.items.map(i => i.name);
  assert.ok(names.includes('.git'), '.git 应隐藏（默认名单生效）');
  assert.ok(names.includes('.gitignore'), '.gitignore 不应隐藏（精确匹配非前缀）');
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
