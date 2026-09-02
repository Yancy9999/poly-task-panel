'use strict';
// GET /api/clipboard/file-paths 路由：读取剪贴板中"从资源管理器复制的文件"的绝对路径列表
// （终端里 Ctrl+V 粘贴文件 → 前端检测 clipboardData.files 非空后调本路由）。
// 实现走 PowerShell Get-Clipboard -Format FileDropList；monkey-patch child_process.spawnSync
// 拦截真实调用，仅断言调用参数与返回 JSON。
// 覆盖：多个路径、空剪贴板、powershell 非零退出、powershell 启动失败(ENOENT)。
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let lastCall = null;
let mockResult = { status: 0, stdout: '', stderr: '' };
let srv = null;
let tmpDir, projectsFile;

before(() => {
  // 拦截 spawnSync：记录 powershell 调用参数，返回 mockResult，不真调 PowerShell
  cp.spawnSync = (bin, args, opts) => {
    lastCall = { bin, args, opts };
    return mockResult;
  };
  // 拦截 createServer 拿到实例，after 里关闭，避免 listen 挂住事件循环
  const origCreate = http.createServer;
  http.createServer = (...a) => { srv = origCreate.apply(http, a); return srv; };

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptp-clipboard-'));
  projectsFile = path.join(tmpDir, 'projects.json');
  fs.writeFileSync(projectsFile, JSON.stringify([
    { id: 'p1', name: 'P1', projectPath: tmpDir, type: 'folder' },
  ], null, 2));
  process.env.PORT = '7956';
  process.env.PROJECTS_FILE = projectsFile;
  process.env.__PTP_TMPDIR__ = tmpDir; // 供 after 清理

  require('../server.js');
});

after(async () => {
  if (srv && srv.listening) await new Promise((r) => srv.close(r));
  const tmp = process.env.__PTP_TMPDIR__;
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

function get() {
  return new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port: 7956, path: '/api/clipboard/file-paths' }, (res) => {
      let raw = '';
      res.on('data', (d) => raw += d);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw || '{}') }));
    }).on('error', reject);
  });
}

test('剪贴板有 2 个文件：返回绝对路径数组（含中文路径）', async () => {
  lastCall = null;
  // PowerShell 端输出 Base64(UTF-8)，绕开控制台代码页——中文路径不乱码
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  mockResult = {
    status: 0,
    stdout: b64('D:\\my project\\a b.txt\nD:\\资料\\说明.md\n'),
    stderr: '',
  };
  const r = await get();
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.deepStrictEqual(r.body.paths, ['D:\\my project\\a b.txt', 'D:\\资料\\说明.md']);
  // 断言实现确实走 PowerShell FileDropList + Base64 输出（编码不受控制台代码页影响）
  assert.strictEqual(lastCall.bin, 'powershell.exe');
  assert.ok(lastCall.args.some((a) => a.includes('Get-Clipboard -Format FileDropList')));
  assert.ok(lastCall.args.some((a) => a.includes('ToBase64String')));
});

test('剪贴板无文件（空输出）：返回空数组', async () => {
  mockResult = { status: 0, stdout: '', stderr: '' };
  const r = await get();
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.deepStrictEqual(r.body.paths, []);
});

test('powershell 非零退出：返回 500 + ok:false', async () => {
  mockResult = { status: 1, stdout: '', stderr: 'some error' };
  const r = await get();
  assert.strictEqual(r.status, 500);
  assert.strictEqual(r.body.ok, false);
  assert.ok(r.body.msg.includes('读取剪贴板文件路径失败'));
});

test('powershell 启动失败(ENOENT)：返回 500 + ok:false', async () => {
  mockResult = { status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) };
  const r = await get();
  assert.strictEqual(r.status, 500);
  assert.strictEqual(r.body.ok, false);
  assert.ok(r.body.msg.includes('读取剪贴板文件路径失败'));
});
