'use strict';
// 任务单轮执行路由测试（进程内 require server.js，覆盖率计入）。
// 覆盖：POST /api/tasks/:id/run（404/运行中拒绝/项目目录不存在 400/
//       fake CLI 执行成功 → status=agent-success + startedAt/finishedAt + cliSessionId 捕获 + 输出可回放/落盘、
//       fake CLI 非零退出 → status=agent-fail、
//       完成后再次 run → resume（argv 带 cliSessionId，goal 仍走 stdin））、
//       GET /api/tasks/:id/output（404/成功回放全文）。
// CLI 全部注入 fixtures 假可执行（fake-run-claude / fake-run-codex / fake-run-pi），
// 不依赖外部 CLI 行为与网络。运行：npm test （node --test test/）
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(ROOT, 'fixtures');

let srv = null;
let tmpDir, tasksFile;
const PORT = 7959;
// fake CLI 是 node 脚本：BIN=node，ARGS=脚本路径（server 端 BIN/ARGS 均有 env 覆盖口）
const ENV = {
  claude: { bin: process.execPath, args: path.join(FIXTURES, 'fake-run-claude.js') },
  codex: { bin: process.execPath, args: path.join(FIXTURES, 'fake-run-codex.js') },
  pi: { bin: process.execPath, args: path.join(FIXTURES, 'fake-run-pi.js') },
};

before(() => {
  const origCreate = http.createServer;
  http.createServer = (...a) => { srv = origCreate.apply(http, a); return srv; };

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptp-tasks-run-'));
  tasksFile = path.join(tmpDir, 'tasks.json');
  fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify([
    { id: 'p_seed', name: '种子项目', type: 'folder', projectPath: tmpDir },
    // 预置坏目录项目（创建接口会校验路径存在，故直接写种子）：run 时应 400
    { id: 'p_bad', name: '坏目录项目', type: 'folder', projectPath: path.join(tmpDir, 'no-such-dir') },
  ], null, 2));
  process.env.PORT = String(PORT);
  process.env.PROJECTS_FILE = path.join(tmpDir, 'projects.json');
  process.env.SETTINGS_FILE = path.join(tmpDir, 'settings.json');
  process.env.TASKS_FILE = tasksFile;
  process.env.LOCALAPPDATA = path.join(tmpDir, 'appdata');
  process.env.__PTP_TMPDIR__ = tmpDir;
  // 任务执行的三条注入口（server 按 agent 取对应变量）
  process.env.TASK_CLAUDE_BIN = ENV.claude.bin;
  process.env.TASK_CLAUDE_ARGS = ENV.claude.args;
  process.env.TASK_CODEX_BIN = ENV.codex.bin;
  process.env.TASK_CODEX_ARGS = ENV.codex.args;
  process.env.TASK_PI_BIN = ENV.pi.bin;
  process.env.TASK_PI_ARGS = ENV.pi.args;

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

// 轮询任务字段直到 pred 成立或超时（执行是异步的，run 接口返回即 accepted）
async function waitTask(id, pred, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await get('/api/tasks');
    const t = (Array.isArray(list.body) ? list.body : []).find((x) => x.id === id);
    if (t && pred(t)) return t;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitTask 超时');
}

async function createTask(goal, agent) {
  const r = await post('/api/tasks', { projectId: 'p_seed', agent: agent || 'claude', goal, column: 'todo' });
  assert.equal(r.body.ok, true);
  return r.body.task;
}

// ---- run 路由：校验 ----

test('run：任务不存在 404', async () => {
  const r = await post('/api/tasks/t_ghost/run', {});
  assert.equal(r.status, 404);
});

test('run：项目目录不存在 400', async () => {
  const t = await createTask('x');
  const rr = await request('PUT', `/api/tasks/${t.id}`, { projectId: 'p_bad' });
  assert.equal(rr.body.ok, true);
  const r = await post(`/api/tasks/${t.id}/run`, {});
  assert.equal(r.status, 400);
  assert.match(r.body.msg, /目录/);
});

test('run：运行中重复发起 409', async () => {
  const t = await createTask('slow');
  const first = await post(`/api/tasks/${t.id}/run`, {});
  assert.equal(first.status, 200);
  const second = await post(`/api/tasks/${t.id}/run`, {});
  assert.equal(second.status, 409);
  await waitTask(t.id, (x) => x.status === 'agent-success');
});

// ---- run：成功链路（claude 假 CLI） ----

test('run：fake claude 执行成功 → agent-success + 时间戳 + cliSessionId 捕获 + 输出可回放', async () => {
  const t = await createTask('帮我总结 README');
  const r = await post(`/api/tasks/${t.id}/run`, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);

  const done = await waitTask(t.id, (x) => x.status === 'agent-success' || x.status === 'agent-fail');
  assert.equal(done.status, 'agent-success', 'fake claude exit 0 → 成功');
  assert.ok(done.startedAt, 'startedAt 已记录');
  assert.ok(done.finishedAt, 'finishedAt 已记录');
  assert.ok(done.cliSessionId, '已从 stream-json init 事件捕获 cliSessionId');
  assert.match(done.cliSessionId, /^fake-claude-session-\d+$/);

  // 输出回放：含 fake CLI 的输出（stream-json 转文本后的 assistant 文本）
  const out = await get(`/api/tasks/${t.id}/output`);
  assert.equal(out.status, 200);
  assert.ok(out.body.ok);
  assert.ok(out.body.output.includes('FAKE-RUN-CLAUDE-OUTPUT'), '回放含 CLI 输出');

  // 落盘断言
  const persisted = JSON.parse(fs.readFileSync(tasksFile, 'utf8')).find((x) => x.id === t.id);
  assert.equal(persisted.status, 'agent-success');
  assert.equal(persisted.cliSessionId, done.cliSessionId);
});

// ---- run：失败链路 ----

test('run：fake codex 非零退出 → agent-fail + finishedAt 已记录', async () => {
  const t = await createTask('让 codex 失败 FAIL', 'codex');
  const r = await post(`/api/tasks/${t.id}/run`, {});
  assert.equal(r.status, 200);
  const done = await waitTask(t.id, (x) => x.status === 'agent-fail');
  assert.ok(done.startedAt);
  assert.ok(done.finishedAt);
});

// ---- run：resume（原会话续跑） ----

test('run：完成后再次发起 → resume（argv 带 cliSessionId，goal 走 stdin）', async () => {
  const t = await createTask('第一轮目标');
  await post(`/api/tasks/${t.id}/run`, {});
  const done1 = await waitTask(t.id, (x) => x.status === 'agent-success');

  const out1 = await get(`/api/tasks/${t.id}/output`);
  const len1 = out1.body.output.length;
  assert.ok(len1 > 0, '第一轮已有输出');

  const t2 = await request('PUT', `/api/tasks/${t.id}`, { goal: '第二轮目标（原会话续跑）' });
  assert.equal(t2.body.ok, true);
  const r = await post(`/api/tasks/${t.id}/run`, {});
  assert.equal(r.status, 200);
  // 等第二轮完成（finishedAt 已变），否则 waitTask 会命中第一轮的旧成功态
  const done2 = await waitTask(t.id, (x) => x.status === 'agent-success' && x.finishedAt !== done1.finishedAt);

  // fake CLI 把 argv 与 stdin 写进输出：resume 时应带 --resume <发起前的 cliSessionId>
  // （第二轮 close 后 cliSessionId 已被更新为第二轮捕获的新值，故用第一轮的 done1）
  const out = await get(`/api/tasks/${t.id}/output`);
  assert.ok(new RegExp(`--resume ${done1.cliSessionId}`).test(out.body.output), `期望 --resume ${done1.cliSessionId}，实际输出尾部: ` + out.body.output.slice(-400));
  assert.ok(out.body.output.includes('第二轮目标（原会话续跑）'), 'goal 经 stdin 传入');
  assert.ok(out.body.output.length > len1, '输出为追加而非覆盖');
});

test('run：codex/pi 的 argv 透传（exec resume / --session）', async () => {
  // codex：第一次跑出 thread id，第二次 resume（id 捕获进 task.cliSessionId，
  // argv 透传经 fake CLI 的 stderr 回显进入输出）
  const tc = await createTask('codex 第一轮', 'codex');
  await post(`/api/tasks/${tc.id}/run`, {});
  const donec = await waitTask(tc.id, (x) => x.status === 'agent-success');
  assert.match(donec.cliSessionId, /^fake-codex-thread-\d+$/, 'codex thread id 已捕获');
  await post(`/api/tasks/${tc.id}/run`, {});
  await waitTask(tc.id, (x) => x.status === 'agent-success');
  const outc2 = await get(`/api/tasks/${tc.id}/output`);
  assert.ok(new RegExp(`resume ${donec.cliSessionId}`).test(outc2.body.output), 'codex resume 子命令: ' + outc2.body.output.slice(-300));

  // pi：--session <id>
  const tp = await createTask('pi 第一轮', 'pi');
  await post(`/api/tasks/${tp.id}/run`, {});
  const donep = await waitTask(tp.id, (x) => x.status === 'agent-success');
  assert.match(donep.cliSessionId, /^fake-pi-session-\d+$/, 'pi session id 已捕获');
  await post(`/api/tasks/${tp.id}/run`, {});
  await waitTask(tp.id, (x) => x.status === 'agent-success');
  const outp2 = await get(`/api/tasks/${tp.id}/output`);
  assert.ok(new RegExp(`--session ${donep.cliSessionId}`).test(outp2.body.output), 'pi --session <id>: ' + outp2.body.output.slice(-300));
});

test('output：任务不存在 404；未运行过返回空输出', async () => {
  assert.equal((await get('/api/tasks/t_ghost/output')).status, 404);
  const t = await createTask('从未运行');
  const r = await get(`/api/tasks/${t.id}/output`);
  assert.equal(r.status, 200);
  assert.equal(r.body.output, '');
});
