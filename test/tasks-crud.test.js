'use strict';
// 任务 CRUD 路由测试（进程内 require server.js，覆盖率计入）。
// 覆盖：GET /api/tasks 列表、POST /api/tasks 创建（必填校验/agent 校验/列校验/项目存在校验/
//       成功返回 t_ id + createdAt/落盘 tasks.json）、
//       POST /api/tasks/sync（拖动后整表同步列与顺序/缺 tasks/ids 不一致/非法列/失败不改数据）、
//       PUT /api/tasks/:id（编辑：goal/projectId/agent/校验/404）、DELETE /api/tasks/:id（删除落盘/404）。
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let srv = null;
let tmpDir, projectsFile, tasksFile;
const PORT = 7978;

before(() => {
  const origCreate = http.createServer;
  http.createServer = (...a) => { srv = origCreate.apply(http, a); return srv; };

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptp-tasks-'));
  projectsFile = path.join(tmpDir, 'projects.json');
  tasksFile = path.join(tmpDir, 'tasks.json');
  // 预置一个种子项目（任务创建需要挂在真实项目下）
  fs.writeFileSync(projectsFile, JSON.stringify([
    { id: 'p_seed', name: '种子项目', type: 'folder', projectPath: tmpDir },
  ], null, 2));
  process.env.PORT = String(PORT);
  process.env.PROJECTS_FILE = projectsFile;
  process.env.SETTINGS_FILE = path.join(tmpDir, 'settings.json');
  process.env.TASKS_FILE = tasksFile;
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

// ---- 列表 ----

test('GET /api/tasks：初始返回空数组', async () => {
  const r = await get('/api/tasks');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, []);
});

// ---- 创建 ----

test('创建：缺必填字段 400', async () => {
  assert.equal((await post('/api/tasks', {})).status, 400);
  assert.equal((await post('/api/tasks', { projectId: 'p_seed' })).status, 400);
  assert.equal((await post('/api/tasks', { projectId: 'p_seed', agent: 'claude' })).status, 400);
  assert.equal((await post('/api/tasks', { projectId: 'p_seed', agent: 'claude', goal: 'x' })).status, 400);
});

test('创建：非法 agent 400；非法列 400', async () => {
  const r = await post('/api/tasks', { projectId: 'p_seed', agent: 'gpt', goal: 'x', column: 'idea' });
  assert.equal(r.status, 400);
  assert.match(r.body.msg, /agent/);
  const r2 = await post('/api/tasks', { projectId: 'p_seed', agent: 'claude', goal: 'x', column: 'backlog' });
  assert.equal(r2.status, 400);
  assert.match(r2.body.msg, /列/);
});

test('创建：项目不存在 400', async () => {
  const r = await post('/api/tasks', { projectId: 'p_none', agent: 'claude', goal: 'x', column: 'idea' });
  assert.equal(r.status, 400);
  assert.match(r.body.msg, /项目/);
});

test('创建成功：t_ id + createdAt，落盘 tasks.json', async () => {
  const r = await post('/api/tasks', { projectId: 'p_seed', agent: 'claude', goal: '完成登录功能', column: 'idea' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  const t = r.body.task;
  assert.ok(t.id.startsWith('t_'));
  assert.equal(t.projectId, 'p_seed');
  assert.equal(t.agent, 'claude');
  assert.equal(t.goal, '完成登录功能');
  assert.equal(t.column, 'idea');
  assert.ok(t.createdAt, 'createdAt 已生成');
  const persisted = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  assert.ok(persisted.some((x) => x.id === t.id), 'tasks.json 含新任务');
});

test('创建成功：column 待执行（todo）', async () => {
  const r = await post('/api/tasks', { projectId: 'p_seed', agent: 'codex', goal: '重构设置页', column: 'todo' });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.task.column, 'todo');
});

// ---- sync（拖动后整表同步） ----

test('sync：整表更新列与顺序并落盘', async () => {
  const before = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  const [a, b] = before; // a=idea 的登录功能, b=todo 的重构设置页
  // 模拟把 a 拖到 任务中（doing）并放到 b 后面
  const r = await post('/api/tasks/sync', {
    tasks: [
      { id: b.id, column: 'todo' },
      { id: a.id, column: 'doing' },
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  const persisted = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  assert.deepEqual(persisted.map((x) => x.id), [b.id, a.id], '全局顺序已按提交顺序重排');
  assert.equal(persisted.find((x) => x.id === a.id).column, 'doing', 'a 列已改为 doing');
  assert.equal(persisted.find((x) => x.id === b.id).column, 'todo', 'b 列保持 todo');
});

test('sync：缺 tasks 400；ids 不一致（少/多）400；非法列 400；失败不改数据', async () => {
  const before = JSON.parse(fs.readFileSync(tasksFile, 'utf8')).map((x) => x.id);
  assert.equal((await post('/api/tasks/sync', {})).status, 400);
  const full = JSON.parse(fs.readFileSync(tasksFile, 'utf8')).map((x) => ({ id: x.id, column: x.column }));
  assert.equal((await post('/api/tasks/sync', { tasks: full.slice(1) })).status, 400, '少一个');
  assert.equal((await post('/api/tasks/sync', { tasks: [...full, { id: 't_ghost', column: 'idea' }] })).status, 400, '多一个未知');
  assert.equal((await post('/api/tasks/sync', { tasks: full.map((x) => ({ ...x, column: 'backlog' })) })).status, 400, '非法列');
  const after = JSON.parse(fs.readFileSync(tasksFile, 'utf8')).map((x) => x.id);
  assert.deepEqual(after, before, '失败请求不改数据');
});

// ---- 编辑（卡片弹窗：项目/agent/目标均可改） ----

test('编辑：goal 修改成功并落盘，column/createdAt 不变', async () => {
  const seed = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  const t = seed.find((x) => x.goal === '完成登录功能');
  const r = await put(`/api/tasks/${t.id}`, { goal: '完成登录功能（含验证码）' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  const persisted = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  const cur = persisted.find((x) => x.id === t.id);
  assert.equal(cur.goal, '完成登录功能（含验证码）');
  assert.equal(cur.column, t.column, 'column 不变');
  assert.equal(cur.createdAt, t.createdAt, 'createdAt 不变');
});

test('编辑：projectId + agent 一起修改成功', async () => {
  // 再造一个项目供切换（server 的 projects 启动时载入内存，须走 API 创建）
  const pr = await post('/api/projects', { name: '另一个项目', type: 'folder', projectPath: tmpDir });
  assert.equal(pr.body.ok, true);
  const pOther = pr.body.project;
  const seed = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  const t = seed.find((x) => x.goal === '完成登录功能（含验证码）');
  const r = await put(`/api/tasks/${t.id}`, { projectId: pOther.id, agent: 'codex' });
  assert.equal(r.status, 200);
  const persisted = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  const cur = persisted.find((x) => x.id === t.id);
  assert.equal(cur.projectId, pOther.id);
  assert.equal(cur.agent, 'codex');
});

test('编辑：goal 空串 400；非法 agent 400；项目不存在 400', async () => {
  const seed = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  const t = seed.find((x) => x.goal === '重构设置页');
  assert.equal((await put(`/api/tasks/${t.id}`, { goal: '' })).status, 400);
  assert.equal((await put(`/api/tasks/${t.id}`, { goal: '   ' })).status, 400);
  assert.equal((await put(`/api/tasks/${t.id}`, { agent: 'gpt' })).status, 400);
  assert.equal((await put(`/api/tasks/${t.id}`, { projectId: 'p_none' })).status, 400);
  const after = JSON.parse(fs.readFileSync(tasksFile, 'utf8')).find((x) => x.id === t.id);
  assert.equal(after.goal, '重构设置页', '失败请求不改数据');
});

test('编辑：不存在的任务 404', async () => {
  const r = await put('/api/tasks/t_ghost', { goal: 'x' });
  assert.equal(r.status, 404);
});

// ---- 删除 ----

test('删除：成功并落盘，返回 ok', async () => {
  const seed = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  const t = seed.find((x) => x.goal === '完成登录功能（含验证码）');
  const r = await del(`/api/tasks/${t.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  const persisted = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  assert.ok(!persisted.some((x) => x.id === t.id), 'tasks.json 已移除该任务');
});

test('删除：不存在的任务 404', async () => {
  assert.equal((await del('/api/tasks/t_ghost')).status, 404);
});
