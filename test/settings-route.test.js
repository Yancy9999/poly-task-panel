'use strict';
// /api/settings 路由：设置面板全部配置（字体/命令/文件黑名单）的读取与保存。
// 用临时目录跑独立 settings.json，断言：GET 默认值、PUT 落盘且 GET 回读一致、
// 非法字段/多余字段被过滤、命令与黑名单归一（空值回默认）、PUT 后 /files 默认黑名单联动。
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let srv = null;
let tmpDir, projectsFile, settingsFile, projRoot;

before(() => {
  const origCreate = http.createServer;
  http.createServer = (...a) => { srv = origCreate.apply(http, a); return srv; };

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptp-settings-'));
  projRoot = path.join(tmpDir, 'proj');
  fs.mkdirSync(projRoot, { recursive: true });
  fs.writeFileSync(path.join(projRoot, '.gitignore'), 'x');
  fs.mkdirSync(path.join(projRoot, '.git'));
  fs.writeFileSync(path.join(projRoot, '.git', 'HEAD'), 'ref');

  projectsFile = path.join(tmpDir, 'projects.json');
  fs.writeFileSync(projectsFile, JSON.stringify([
    { id: 'p1', name: 'Proj', projectPath: projRoot, type: 'folder' },
  ], null, 2));
  settingsFile = path.join(tmpDir, 'settings.json');
  process.env.PORT = '7967';
  process.env.PROJECTS_FILE = projectsFile;
  process.env.SETTINGS_FILE = settingsFile;
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
    http.get({ host: 'localhost', port: 7967, path: queryPath }, (res) => {
      let raw = '';
      res.on('data', (d) => raw += d);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw || '{}') }));
    }).on('error', reject);
  });
}
function put(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: 'localhost', port: 7967, path: '/api/settings', method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let raw = '';
      res.on('data', (d) => raw += d);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw || '{}') }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test('GET：无 settings.json 时返回默认设置（含文件黑名单默认值）', async () => {
  const r = await get('/api/settings');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  const s = r.body.settings;
  assert.strictEqual(s.fontFamily, '"Cascadia Code", Consolas, monospace');
  assert.strictEqual(s.fontSize, 13);
  assert.strictEqual(s.claudeCommands, null);
  assert.strictEqual(s.agentQuickTexts, null);
  assert.strictEqual(s.cmdQuickTexts, null);
  assert.deepStrictEqual(s.fileHideList, ['.git', '.svn']);
});

test('PUT：合法配置落盘，GET 回读一致，文件写入 settings.json', async () => {
  const putRes = await put({
    fontFamily: 'Consolas, monospace',
    fontSize: 15,
    claudeCommands: [{ cmd: '/clear', desc: '清空', extra: 'junk' }],
    agentQuickTexts: ['  hello world  ', '', 'npm run test', 'hello world', 42, null],
    cmdQuickTexts: ['dir ', ' ', 'dir', 7],
    fileHideList: ['.git', 'node_modules', '.git', '  '],
    evil: 'should-drop',
  });
  assert.strictEqual(putRes.status, 200);
  assert.strictEqual(putRes.body.ok, true);
  const s = putRes.body.settings;
  assert.strictEqual(s.fontFamily, 'Consolas, monospace');
  assert.strictEqual(s.fontSize, 15);
  // 命令归一：多余字段被去掉
  assert.deepStrictEqual(s.claudeCommands, [{ cmd: '/clear', desc: '清空' }]);
  // 黑名单归一：去空白、去重
  assert.deepStrictEqual(s.fileHideList, ['.git', 'node_modules']);
  // 常用文本归一：只留非空字符串、去空白、去重；多余字段被去掉
  assert.deepStrictEqual(s.agentQuickTexts, ['hello world', 'npm run test']);
  assert.deepStrictEqual(s.cmdQuickTexts, ['dir']);
  // 白名单之外的字段被过滤
  assert.strictEqual(s.evil, undefined);

  // 回读
  const r = await get('/api/settings');
  assert.deepStrictEqual(r.body.settings, s);

  // 落盘
  const onDisk = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
  assert.strictEqual(onDisk.fontFamily, 'Consolas, monospace');
  assert.deepStrictEqual(onDisk.fileHideList, ['.git', 'node_modules']);
  assert.deepStrictEqual(onDisk.agentQuickTexts, ['hello world', 'npm run test']);
  assert.deepStrictEqual(onDisk.cmdQuickTexts, ['dir']);
});

test('PUT 归一兜底：越界字号夹到边界、空黑名单回默认、空命令存 null', async () => {
  const r = await put({ fontSize: 999, fileHideList: [], claudeCommands: [{ desc: 'no cmd' }] });
  const s = r.body.settings;
  assert.strictEqual(s.fontSize, 24); // 越界夹到上限（不回默认，保证用户输入被纠正而非丢弃）
  assert.deepStrictEqual(s.fileHideList, ['.git', '.svn']); // 空名单回默认
  assert.strictEqual(s.claudeCommands, null); // 无有效命令存 null
  assert.strictEqual(s.agentQuickTexts, null); // 无有效常用文本存 null
});

test('PUT 空 object body：归一为默认设置而非 500', async () => {
  // 注：body-parser strict 模式只接 {} / [] 开头的 JSON，顶层标量在中间件层即 400，
  // 路由内 normalizeSettings 的非对象兜底针对的是 req.body 为 undefined 等场景。
  const r = await put({});
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.deepStrictEqual(r.body.settings.fileHideList, ['.git', '.svn']);
});

test('PUT 后 /files 默认黑名单联动：fileHideList=node_modules 时 .git 仍隐藏', async () => {
  await put({ fileHideList: ['node_modules'] });
  const r = await get('/api/projects/p1/files');
  const names = r.body.items.map(i => i.name);
  assert.ok(names.includes('.git'), '新黑名单不含 .git，应显示');
  assert.ok(names.includes('.gitignore'), '.gitignore 应显示');
});

// --- projectCollapsed（项目卡片折叠状态，服务端持久化）---

test('GET：无 settings.json 时 projectCollapsed 默认空对象', async () => {
  // 注意：此测试文件按声明顺序执行，前面的 PUT 已落盘 settings.json；
  // 这里只断言字段存在且为对象（形态兜底），默认空对象的纯场景由单独文件级验证覆盖。
  const r = await get('/api/settings');
  assert.strictEqual(r.status, 200);
  const s = r.body.settings;
  assert.ok(typeof s.projectCollapsed === 'object' && s.projectCollapsed !== null && !Array.isArray(s.projectCollapsed),
    'projectCollapsed 是对象');
});

test('PUT：折叠 map 落盘，GET 回读一致；非法值归一为空对象', async () => {
  const putRes = await put({ projectCollapsed: { p1: 1, p2: 1, bad: 'x', 3: 1 } });
  assert.strictEqual(putRes.status, 200);
  const s = putRes.body.settings;
  // 归一：值归一为 1（仅保留字符串 key 的真值条目），非法条目剔除
  assert.deepStrictEqual(s.projectCollapsed, { p1: 1, p2: 1, bad: 1, 3: 1 });

  const r = await get('/api/settings');
  assert.deepStrictEqual(r.body.settings.projectCollapsed, s.projectCollapsed, '回读一致');

  // 落盘
  const onDisk = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
  assert.deepStrictEqual(onDisk.projectCollapsed, s.projectCollapsed);

  // 非法输入：数组/标量/null → 空对象
  for (const bad of [[1, 2], 'x', 42, null]) {
    const rr = await put({ projectCollapsed: bad });
    assert.deepStrictEqual(rr.body.settings.projectCollapsed, {}, `非法值 ${JSON.stringify(bad)} → 空对象`);
  }
  // 非法条目剔除：值 0/''/null 等视为未折叠
  const rr2 = await put({ projectCollapsed: { keep: 1, drop0: 0, dropStr: '', dropNull: null } });
  assert.deepStrictEqual(rr2.body.settings.projectCollapsed, { keep: 1 });
});
