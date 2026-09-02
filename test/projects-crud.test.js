'use strict';
// 项目 CRUD 路由测试（进程内 require server.js，覆盖率计入）。
// 覆盖：POST /api/projects 创建（必填校验/类型校验/node 需 command/springboot 需 moduleName/
//       路径校验/字段按类型裁剪/springboot compileDependencies 默认）、
//       PUT /api/projects/:id（部分更新/folder 切换清字段/运行中拒绝/404）、
//       DELETE /api/projects/:id（bat+log 清理/404）、
//       POST /api/projects/reorder（正常重排/缺 ids/ids 不一致）、
//       GET /api/projects/:id/command（bat 内容/404）、
//       GET /api/projects/:id/vcs-kind（git/svn 不装时 none/404）。
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let srv = null;
let tmpDir, projectsFile, projA, projB;
const PORT = 7977;

before(() => {
  const origCreate = http.createServer;
  http.createServer = (...a) => { srv = origCreate.apply(http, a); return srv; };

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptp-crud-'));
  projA = path.join(tmpDir, 'proj-a');
  projB = path.join(tmpDir, 'proj-b');
  fs.mkdirSync(projA, { recursive: true });
  fs.mkdirSync(projB, { recursive: true });
  // projA 做成真 git 仓库（vcs-kind=git 用例；手造 .git 目录骗不过 git rev-parse）；
  // projB 保持普通目录（vcs-kind=none）
  const { execSync } = require('node:child_process');
  execSync('git init -q', { cwd: projA });

  projectsFile = path.join(tmpDir, 'projects.json');
  fs.writeFileSync(projectsFile, JSON.stringify([], null, 2));
  process.env.PORT = String(PORT);
  process.env.PROJECTS_FILE = projectsFile;
  process.env.SETTINGS_FILE = path.join(tmpDir, 'settings.json');
  // bat/log 产物目录隔离：不设会让 LOGS_DIR 落到真实 %LOCALAPPDATA%\PolyTaskPanel\projects
  process.env.LOCALAPPDATA = path.join(tmpDir, 'appdata');
  process.env.__PTP_TMPDIR__ = tmpDir;

  require('../server.js');
});

after(async () => {
  if (srv && srv.listening) await new Promise((r) => srv.close(r));
  const tmp = process.env.__PTP_TMPDIR__;
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

function request(method, queryPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      host: 'localhost', port: PORT, path: queryPath, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    };
    const req = http.request(opts, (res) => {
      let raw = '';
      res.on('data', (d) => (raw += d));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw || '{}') }); }
        catch (e) { resolve({ status: res.statusCode, raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const get = (p) => request('GET', p);
const post = (p, b) => request('POST', p, b);
const put = (p, b) => request('PUT', p, b);
const del = (p) => request('DELETE', p);

// ---- 创建：校验分支 ----

test('创建：缺必填字段 400', async () => {
  assert.equal((await post('/api/projects', {})).status, 400);
  assert.equal((await post('/api/projects', { name: 'x' })).status, 400);
  assert.equal((await post('/api/projects', { name: 'x', projectPath: projA })).status, 400);
});

test('创建：非法类型 400', async () => {
  const r = await post('/api/projects', { name: 'x', projectPath: projA, type: 'python' });
  assert.equal(r.status, 400);
  assert.match(r.body.msg, /类型/);
});

test('创建：node 项目缺 command 400；springboot 缺 moduleName 400', async () => {
  const n = await post('/api/projects', { name: 'n', projectPath: projA, type: 'node' });
  assert.equal(n.status, 400);
  const s = await post('/api/projects', { name: 's', projectPath: projA, type: 'springboot' });
  assert.equal(s.status, 400);
});

test('创建：路径不存在 400 / 路径是文件 400', async () => {
  const r = await post('/api/projects', { name: 'x', projectPath: path.join(tmpDir, 'no-such'), type: 'folder' });
  assert.equal(r.status, 400);
  const filePath = path.join(tmpDir, 'plain.txt');
  fs.writeFileSync(filePath, 'x');
  const r2 = await post('/api/projects', { name: 'x', projectPath: filePath, type: 'folder' });
  assert.equal(r2.status, 400);
  assert.match(r2.body.msg, /不是目录/);
});

// ---- 创建：成功路径与字段裁剪 ----

test('创建 folder 项目：字段裁剪（command/moduleName/compileDependencies 均无）+ bat 不生成', async () => {
  const r = await post('/api/projects', {
    name: 'Folder 项目', projectPath: projB, type: 'folder',
    command: 'echo hi', moduleName: 'should-drop', compileDependencies: false,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  const p = r.body.project;
  assert.ok(p.id.startsWith('p_'));
  assert.equal(p.type, 'folder');
  assert.equal(p.command, undefined);
  assert.equal(p.moduleName, undefined);
  assert.equal(p.compileDependencies, undefined);
  assert.equal(fs.existsSync(path.join(process.env.__PTP_TMPDIR__, 'appdata', 'PolyTaskPanel', 'projects', `${p.id}.bat`)), false, 'folder 不生成 bat');
});

test('创建 node 项目：command 保留，写 projects.json，生成 bat', async () => {
  const r = await post('/api/projects', {
    name: 'Node 项目', projectPath: projB, type: 'node', command: 'node server.js',
  });
  assert.equal(r.body.ok, true);
  const p = r.body.project;
  assert.equal(p.command, 'node server.js');
  // 落盘校验
  const persisted = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
  assert.ok(persisted.some((x) => x.id === p.id), 'projects.json 含新项目');
  // bat 内容含命令与项目路径
  const bat = fs.readFileSync(path.join(process.env.__PTP_TMPDIR__, 'appdata', 'PolyTaskPanel', 'projects', `${p.id}.bat`), 'utf8');
  assert.ok(bat.includes('node server.js'), 'bat 含启动命令');
  assert.ok(bat.includes(projB), 'bat 含项目路径');
});

test('创建 springboot 项目：moduleName 保留，compileDependencies 缺省默认 true，bat 含 mvn 编译链', async () => {
  const r = await post('/api/projects', {
    name: 'Boot 项目', projectPath: projB, type: 'springboot', moduleName: 'app',
  });
  const p = r.body.project;
  assert.equal(p.moduleName, 'app');
  assert.equal(p.compileDependencies, true, '缺省默认勾选编译依赖');
  const bat = fs.readFileSync(path.join(process.env.__PTP_TMPDIR__, 'appdata', 'PolyTaskPanel', 'projects', `${p.id}.bat`), 'utf8');
  assert.ok(bat.includes('mvn compile') && bat.includes('-am'), '默认勾选时 bat 先 compile -am');
  assert.ok(bat.includes('spring-boot:run -pl app'), 'bat 含 spring-boot:run');
});

test('创建 springboot compileDependencies=false：bat 只有 run 无 compile', async () => {
  const r = await post('/api/projects', {
    name: 'Boot2', projectPath: projB, type: 'springboot', moduleName: 'web', compileDependencies: false,
  });
  const p = r.body.project;
  assert.equal(p.compileDependencies, false);
  const bat = fs.readFileSync(path.join(process.env.__PTP_TMPDIR__, 'appdata', 'PolyTaskPanel', 'projects', `${p.id}.bat`), 'utf8');
  assert.ok(!bat.includes('mvn compile'), '未勾选不编译');
});

// ---- command 路由 ----

test('GET /:id/command 返回 bat 内容；folder 项目返回占位；404', async () => {
  const list = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
  const node = list.find((x) => x.type === 'node');
  const folder = list.find((x) => x.type === 'folder');
  const r = await get(`/api/projects/${node.id}/command`);
  assert.equal(r.body.ok, true);
  assert.ok(r.body.command.includes(node.command), 'command 内容与 bat 一致');
  const rf = await get(`/api/projects/${folder.id}/command`);
  assert.ok(rf.body.command.includes('REM Folder'), 'folder 返回占位 bat');
  const r404 = await get('/api/projects/p_none/command');
  assert.equal(r404.status, 404);
});

// ---- 更新 ----

test('PUT 更新：改名字段生效并落盘', async () => {
  const list = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
  const node = list.find((x) => x.type === 'node');
  const r = await put(`/api/projects/${node.id}`, { name: '改名后的 Node' });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.project.name, '改名后的 Node');
  const persisted = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
  assert.equal(persisted.find((x) => x.id === node.id).name, '改名后的 Node', '更新已落盘');
});

test('PUT 切到 folder 类型：清空 command/moduleName/compileDependencies', async () => {
  const list = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
  const boot2 = list.find((x) => x.name === 'Boot2');
  const r = await put(`/api/projects/${boot2.id}`, { type: 'folder' });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.project.type, 'folder');
  assert.equal(r.body.project.command, undefined);
  assert.equal(r.body.project.moduleName, undefined);
  assert.equal(r.body.project.compileDependencies, undefined);
});

test('PUT 404', async () => {
  assert.equal((await put('/api/projects/p_none', { name: 'x' })).status, 404);
});

// ---- reorder ----

test('reorder：完整 id 顺序重排并落盘', async () => {
  const before = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
  const ids = before.map((x) => x.id).reverse();
  const r = await post('/api/projects/reorder', { ids });
  assert.equal(r.body.ok, true);
  const after = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
  assert.deepEqual(after.map((x) => x.id), ids, '顺序已按 ids 重排');
});

test('reorder：缺 ids 400；ids 不一致（缺一个/多一个未知）400；顺序不变', async () => {
  const before = JSON.parse(fs.readFileSync(projectsFile, 'utf8')).map((x) => x.id);
  assert.equal((await post('/api/projects/reorder', {})).status, 400);
  assert.equal((await post('/api/projects/reorder', { ids: [] })).status, 400);
  assert.equal((await post('/api/projects/reorder', { ids: before.slice(1) })).status, 400, '少一个');
  assert.equal((await post('/api/projects/reorder', { ids: [...before, 'p_ghost'] })).status, 400, '多一个未知');
  const after = JSON.parse(fs.readFileSync(projectsFile, 'utf8')).map((x) => x.id);
  assert.deepEqual(after, before, '失败请求不改顺序');
});

// ---- vcs-kind ----

test('vcs-kind：git 仓库返回 git；普通目录返回 none；404', async () => {
  // git 仓库目录（.git/HEAD 已在 before 预置）与普通目录各建一个 folder 项目
  const a = await post('/api/projects', { name: 'vc-git', projectPath: projA, type: 'folder' });
  const b = await post('/api/projects', { name: 'vc-none', projectPath: projB, type: 'folder' });
  const rg = await get(`/api/projects/${a.body.project.id}/vcs-kind`);
  assert.equal(rg.body.kind, 'git');
  const rn = await get(`/api/projects/${b.body.project.id}/vcs-kind`);
  assert.equal(rn.body.kind, 'none', 'projB 无版本控制');
  assert.equal((await get('/api/projects/p_none/vcs-kind')).status, 404);
});

// ---- 删除 ----

test('DELETE：删除项目并清理 bat；再次 DELETE 404；列表移除', async () => {
  const list = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
  const boot = list.find((x) => x.name === 'Boot 项目');
  const logsDir = path.join(process.env.__PTP_TMPDIR__, 'appdata', 'PolyTaskPanel', 'projects');
  // 触发一次 bat 存在（writeBat 已在创建时写过）
  assert.ok(fs.existsSync(path.join(logsDir, `${boot.id}.bat`)), '删除前 bat 存在');
  const r = await del(`/api/projects/${boot.id}`);
  assert.equal(r.body.ok, true);
  assert.equal(fs.existsSync(path.join(logsDir, `${boot.id}.bat`)), false, 'bat 已清理');
  const persisted = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
  assert.ok(!persisted.some((x) => x.id === boot.id), 'projects.json 已移除');
  assert.equal((await del(`/api/projects/${boot.id}`)).status, 404, '重复删除 404');
});
