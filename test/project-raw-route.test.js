'use strict';
// /api/projects/:id/raw 路由：项目内文件原样只读回包（md 预览相对图片的加载源）。
// 用临时目录构造项目，断言：二进制原样回包、Content-Type 按扩展名映射、
// 未映射扩展名回包不设类型、路径沙箱化（../ 逃逸拒绝）、文件/项目不存在 404、
// 未指定 sub 400。
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let srv = null;
let tmpDir, projectsFile, projRoot, pngFile;
const PORT = '7985'; // 与其它 *-route 测试错开（全占用清单见各 test 文件头部 PORT 常量）

before(() => {
  const origCreate = http.createServer;
  http.createServer = (...a) => { srv = origCreate.apply(http, a); return srv; };

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptp-raw-'));
  projRoot = path.join(tmpDir, 'myproj');
  fs.mkdirSync(path.join(projRoot, 'docs'), { recursive: true });
  // 带 NUL 的假 png（二进制探测意义上的真二进制）
  pngFile = path.join(projRoot, 'docs', 'img.png');
  fs.writeFileSync(pngFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x01]));
  fs.writeFileSync(path.join(projRoot, 'docs', 'data.xyz'), Buffer.from([0x01, 0x02, 0x03]));

  projectsFile = path.join(tmpDir, 'projects.json');
  fs.writeFileSync(projectsFile, JSON.stringify([
    { id: 'good', name: 'MyProj', projectPath: projRoot, type: 'folder' },
    { id: 'missing', name: 'Missing', projectPath: path.join(tmpDir, 'no-such-xyz'), type: 'folder' },
  ], null, 2));
  process.env.PORT = PORT;
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
    http.get({ host: 'localhost', port: PORT, path: queryPath }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('png：二进制原样回包 + Content-Type 按扩展名映射', async () => {
  const r = await get('/api/projects/good/raw?sub=' + encodeURIComponent('docs/img.png'));
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x01]));
  assert.strictEqual(r.headers['content-type'], 'image/png');
});

test('未映射扩展名：原样回包，Content-Type 不设映射值', async () => {
  const r = await get('/api/projects/good/raw?sub=' + encodeURIComponent('docs/data.xyz'));
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, Buffer.from([0x01, 0x02, 0x03]));
  assert.ok(!/image\//.test(r.headers['content-type'] || ''), '未映射类型不应伪装成 image');
});

test('路径沙箱化：../ 逃逸出项目目录返回 400', async () => {
  const r = await get('/api/projects/good/raw?sub=' + encodeURIComponent('../secret.txt'));
  assert.strictEqual(r.status, 400);
  const body = JSON.parse(r.body.toString('utf8'));
  assert.strictEqual(body.ok, false);
  assert.ok(body.msg.includes('超出项目目录'));
});

test('文件不存在：返回 404', async () => {
  const r = await get('/api/projects/good/raw?sub=' + encodeURIComponent('docs/nope.png'));
  assert.strictEqual(r.status, 404);
});

test('项目不存在：返回 404', async () => {
  const r = await get('/api/projects/missing/raw?sub=' + encodeURIComponent('docs/img.png'));
  assert.strictEqual(r.status, 404);
});

test('未指定 sub：返回 400', async () => {
  const r = await get('/api/projects/good/raw');
  assert.strictEqual(r.status, 400);
});
