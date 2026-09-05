'use strict';
// 任务卡片会话标题 + goal 自适应测试。
// 后端（进程内 require server.js）：GET /api/tasks 为 claude 任务按 cliSessionId 读
//   会话文件最后一条 ai-title 以 sessionTitle 带回（codex/pi 无标题不带；无 ai-title 不带；
//   sessionTitle 不落盘 tasks.json）；任务 close 的 task-run-status 广播携带 sessionTitle。
// 前端（jsdom）：卡片 logo 后渲染会话标题（无标题不渲染）；goal 不再 JS 截 10 字，
//   CSS ellipsis 自适应（.task-card-goal / .task-card-session-title 均有省略号规则）。
// claude 会话目录经 CLAUDE_PROJECTS_DIR 注入临时目录隔离。运行：npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');

let srv = null;
let tmpDir, claudeProjectsDir, sessionFile, tasksFile;
const PORT = 7961;
const SESSION_ID = 'test-session-with-title';

before(() => {
  const origCreate = http.createServer;
  http.createServer = (...a) => { srv = origCreate.apply(http, a); return srv; };

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptp-task-title-'));
  tasksFile = path.join(tmpDir, 'tasks.json');
  fs.writeFileSync(path.join(tmpDir, 'projects.json'), JSON.stringify([
    { id: 'p_seed', name: '种子项目', type: 'folder', projectPath: tmpDir },
  ], null, 2));
  // claude 会话文件：两条 ai-title（取最后一条），项目目录名按 claude 编码规则
  claudeProjectsDir = path.join(tmpDir, 'claude-projects');
  const projDir = path.join(claudeProjectsDir, tmpDir.replace(/[^a-zA-Z0-9-]/g, '-'));
  fs.mkdirSync(projDir, { recursive: true });
  sessionFile = path.join(projDir, `${SESSION_ID}.jsonl`);
  fs.writeFileSync(sessionFile, [
    JSON.stringify({ type: 'user', message: { content: '目标文本' } }),
    JSON.stringify({ type: 'ai-title', aiTitle: '旧标题' }),
    JSON.stringify({ type: 'ai-title', aiTitle: '整理任务看板会话标题' }),
  ].join('\n'));

  process.env.PORT = String(PORT);
  process.env.PROJECTS_FILE = path.join(tmpDir, 'projects.json');
  process.env.SETTINGS_FILE = path.join(tmpDir, 'settings.json');
  process.env.TASKS_FILE = tasksFile;
  process.env.CLAUDE_PROJECTS_DIR = claudeProjectsDir;
  process.env.LOCALAPPDATA = path.join(tmpDir, 'appdata');
  process.env.__PTP_TMPDIR__ = tmpDir;
  // 任务执行注入假 claude CLI：会话文件（末条 ai-title）写进 CLAUDE_PROJECTS_DIR 的
  // 编码项目目录层（server 按 <项目路径编码>/<sessionId>.jsonl 定位，同 listClaudeHistory），
  // session id 固定 fake-title-session-1。
  const fakeCli = path.join(tmpDir, 'fake-title-claude.js');
  fs.writeFileSync(fakeCli, `'use strict';
const fs = require('fs');
const path = require('path');
let goal = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (goal += c));
process.stdin.on('end', () => {
  goal = goal.trim();
  const sid = 'fake-title-session-1';
  const dir = process.env.FAKE_TITLE_SESSION_DIR;
  fs.writeFileSync(path.join(dir, sid + '.jsonl'), [
    JSON.stringify({ type: 'user', message: { content: goal } }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'FAKE 旧标题' }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'FAKE 标题：帮我总结任务' }),
  ].join('\\n'));
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: sid }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }) + '\\n');
  process.exit(0);
});
`);
  process.env.TASK_CLAUDE_BIN = process.execPath;
  process.env.TASK_CLAUDE_ARGS = fakeCli;
  process.env.FAKE_TITLE_SESSION_DIR = projDir;

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

async function createTask(agent, cliSessionId) {
  const r = await post('/api/tasks', { projectId: 'p_seed', agent, goal: '目标', column: 'idea' });
  assert.equal(r.body.ok, true);
  return r.body.task;
}

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

// ---- 后端：GET /api/tasks 带回 sessionTitle ----

test('GET /api/tasks：无 cliSessionId 的任务不带 sessionTitle', async () => {
  await createTask('claude');
  await createTask('codex');
  const list = await get('/api/tasks');
  assert.equal(list.status, 200);
  const claudeTask = list.body.find((t) => t.agent === 'claude');
  assert.ok(claudeTask, '存在 claude 任务');
  assert.equal(claudeTask.sessionTitle, undefined, '无 cliSessionId 的 claude 任务不带 sessionTitle');
  const codexTask = list.body.find((t) => t.agent === 'codex');
  assert.ok(codexTask, '存在 codex 任务');
  assert.equal(codexTask.sessionTitle, undefined, 'codex 任务不带 sessionTitle');
});

// 真 run 链路：fake CLI 生成含 ai-title 的会话文件（会话 id = session 文件名），
// 运行完成后 GET /api/tasks 带回 sessionTitle（末条 ai-title），codex/pi 不带。
test('run 后：claude 任务带回 ai-title 会话标题；codex/pi 不带', async () => {
  const t = await createTask('claude');
  assert.equal(t.agent, 'claude');
  const r = await post(`/api/tasks/${t.id}/run`, {});
  assert.equal(r.status, 200);
  const done = await waitTask(t.id, (x) => x.status === 'agent-success');
  assert.ok(done.cliSessionId, 'cliSessionId 已捕获');
  const list = await get('/api/tasks');
  const claude = list.body.find((x) => x.id === t.id);
  assert.equal(claude.sessionTitle, 'FAKE 标题：帮我总结任务', 'sessionTitle 取会话文件末条 ai-title');

  const persisted = JSON.parse(fs.readFileSync(tasksFile, 'utf8')).find((x) => x.id === t.id);
  assert.equal(persisted.sessionTitle, undefined, 'sessionTitle 不落盘 tasks.json');
});

// ---- 前端：卡片渲染（jsdom） ----

const htmlPath = path.join(ROOT, 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
const inlineScript = scripts[scripts.length - 1][1];

function boot() {
  const dom = new (require('jsdom').JSDOM)(html, {
    url: 'http://localhost:7777/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.fetch = async () => ({ json: async () => [] });
  window.WebSocket = class { constructor() {} send() {} close() {} };
  window.Terminal = class {};
  window.FitAddon = { FitAddon: class { fit() {} loadAddon() {} } };
  window.HTMLElement.prototype.setPointerCapture = function () {};
  window.HTMLElement.prototype.releasePointerCapture = function () {};
  window.eval(inlineScript);
  return window;
}

function cardHtml(window, task) {
  const colBody = window.document.createElement('div');
  colBody.innerHTML = window.taskCardHtml(task);
  return colBody.querySelector('.task-card');
}

test('卡片：claude 会话标题渲染在 agent logo 后（完整文本，不 JS 截断）', () => {
  const window = boot();
  const card = cardHtml(window, {
    id: 't_1', projectId: 'p1', agent: 'claude', goal: '目标', column: 'idea',
    createdAt: '2026-09-04T10:00:00Z', sessionTitle: '整理任务看板会话标题',
  });
  const title = card.querySelector('.task-card-head .task-card-session-title');
  assert.ok(title, '标题节点存在');
  const agent = card.querySelector('.task-card-agent');
  assert.ok(agent.nextElementSibling === title, '标题紧跟 agent logo');
  assert.equal(title.textContent, '整理任务看板会话标题', '完整文本不截断');
  assert.equal(title.getAttribute('title'), '整理任务看板会话标题', 'title 属性悬浮看全文');
});

test('卡片：无 sessionTitle（codex/pi/未跑过）不渲染标题节点', () => {
  const window = boot();
  for (const agent of ['codex', 'pi', 'claude']) {
    const card = cardHtml(window, {
      id: 't_2', projectId: 'p1', agent, goal: '目标', column: 'idea',
      createdAt: '2026-09-04T10:00:00Z',
    });
    assert.equal(card.querySelector('.task-card-session-title'), null, `${agent} 无标题节点`);
  }
});

test('卡片：goal 不再 JS 截 10 字（长目标完整进 DOM，交给 CSS 省略）', () => {
  const window = boot();
  const longGoal = '这是一个超过十个字的目标文本用来验证自适应';
  const card = cardHtml(window, {
    id: 't_3', projectId: 'p1', agent: 'claude', goal: longGoal, column: 'idea',
    createdAt: '2026-09-04T10:00:00Z',
  });
  const goalEl = card.querySelector('.task-card-goal');
  assert.ok(goalEl, '目标行存在');
  assert.equal(goalEl.textContent, longGoal, '目标全文进 DOM（无 JS 截断的 …）');
  assert.ok(!goalEl.textContent.endsWith('…'), '无硬编码省略号');
});

test('CSS：goal 与会话标题均为 ellipsis 自适应（不固定截断）', () => {
  const styleText = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const ruleOf = (sel) => {
    for (const m of styleText.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      for (const s of m[1].split(',')) if (s.trim() === sel) return m[2];
    }
    return '';
  };
  const goalRule = ruleOf('.task-card-goal');
  assert.ok(goalRule.includes('text-overflow: ellipsis') && goalRule.includes('white-space: nowrap'),
    '.task-card-goal 单行省略号自适应');
  const titleRule = ruleOf('.task-card-session-title');
  assert.ok(titleRule.includes('text-overflow: ellipsis') && titleRule.includes('white-space: nowrap'),
    '.task-card-session-title 单行省略号自适应');
});
