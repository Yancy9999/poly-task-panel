'use strict';
// /api/projects/:id/explorer 路由：用 explorer.exe 打开项目目录（或指定子目录）。
// monkey-patch child_process.spawn 拦截真实弹窗，仅断言调用参数与返回 JSON。
// 覆盖：根目录、子目录(sub)、沙箱化(../ 逃逸)、目录不存在、项目不存在。
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const calls = [];
let srv = null;
let tmpDir, projRoot, subDir, projectsFile;

before(() => {
  // 拦截 spawn：记录 explorer 调用，不真弹窗；fake child 忽略 error 注册
  cp.spawn = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    return { on: () => {}, once: () => {}, unref() {} };
  };
  // 拦截 createServer 拿到实例，after 里关闭，避免 listen 挂住事件循环
  const origCreate = http.createServer;
  http.createServer = (...a) => { srv = origCreate.apply(http, a); return srv; };

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptp-explorer-'));
  projRoot = path.join(tmpDir, 'myproj');
  subDir = path.join(projRoot, 'src');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'a.js'), 'x');
  // 用一个不存在的项目路径测目录不存在分支
  const missingPath = path.join(tmpDir, 'no-such-xyz');
  projectsFile = path.join(tmpDir, 'projects.json');
  fs.writeFileSync(projectsFile, JSON.stringify([
    { id: 'good', name: 'Good', projectPath: projRoot, type: 'folder' },
    { id: 'missing', name: 'Missing', projectPath: missingPath, type: 'folder' },
  ], null, 2));
  process.env.PORT = '7955';
  process.env.PROJECTS_FILE = projectsFile;
  process.env.__PTP_TMPDIR__ = tmpDir; // 供 after 清理

  require('../server.js');
});

after(async () => {
  if (srv && srv.listening) await new Promise((r) => srv.close(r));
  const tmp = process.env.__PTP_TMPDIR__;
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

function post(bodyPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: 'localhost', port: 7955, path: bodyPath, method: 'POST',
    }, (res) => {
      let raw = '';
      res.on('data', (d) => raw += d);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw || '{}') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('根目录：spawn explorer.exe 打开该目录并返回 ok:true', async () => {
  calls.length = 0;
  const r = await post('/api/projects/good/explorer');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].bin, 'explorer.exe');
  assert.deepStrictEqual(calls[0].args, [projRoot]);
});

test('子目录(sub)：spawn explorer.exe 打开指定子目录', async () => {
  calls.length = 0;
  const r = await post('/api/projects/good/explorer?sub=' + encodeURIComponent('src'));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].args, [subDir]);
});

test('沙箱化：../ 逃逸出项目目录返回 400 且不调用 explorer', async () => {
  calls.length = 0;
  const r = await post('/api/projects/good/explorer?sub=' + encodeURIComponent('../../'));
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.ok, false);
  assert.ok(r.body.msg.includes('超出项目目录'));
  assert.deepStrictEqual(calls, []);
});

test('目录不存在：返回 404 且不调用 explorer', async () => {
  calls.length = 0;
  const r = await post('/api/projects/missing/explorer');
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.ok, false);
  assert.strictEqual(r.body.msg.includes('目录不存在'), true);
  assert.deepStrictEqual(calls, []);
});

test('项目不存在：返回 404', async () => {
  const r = await post('/api/projects/nope/explorer');
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.ok, false);
  assert.strictEqual(r.body.msg, '项目不存在');
});
