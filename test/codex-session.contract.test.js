// Codex 会话契约测试（会话区块新建 Codex 功能）。
// 与 claude-session.contract.test.js 同构：测试 seam = 启动器后端 HTTP/WS
// 的外部可观察行为；用假的 codex（fixtures/fake-codex.js）替代真 CLI，
// 避免依赖外部 CLI 行为与网络。只断言外部行为，不断言实现细节。
//
// 覆盖：codex 会话创建/多开/关闭/自退/不污染持久化/宿主生命周期解耦，
// 以及 claude 与 codex 在同项目下按类型独立编号、并存互不串流。
//
// 运行：npm test （node --test test/）
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const http = require('node:http');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server.js');
const FAKE_CLAUDE = path.join(ROOT, 'fixtures', 'fake-claude.js');
const FAKE_CODEX = path.join(ROOT, 'fixtures', 'fake-codex.js');

// 选空闲端口：bind 0 让 OS 分配，立即释放交给 server。
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// 启动独立 server.js 子进程：临时 projects.json + 临时 public + 注入假 CLI。
// claude 与 codex 都注入假实现（CLAUDE_BIN=node CLAUDE_ARGS=fake-claude.js，
// CODEX_BIN=node CODEX_ARGS=fake-codex.js），"claude/codex 并存"测试才有意义。
async function startServer() {
  const port = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tac-codex-test-'));
  const projectsFile = path.join(tmp, 'projects.json');
  const publicDir = path.join(tmp, 'public');
  fs.mkdirSync(publicDir, { recursive: true });
  const hostProjectDir = path.join(tmp, 'host-project');
  fs.mkdirSync(hostProjectDir, { recursive: true });

  const child = spawn(process.execPath, [SERVER, `--port=${port}`], {
    cwd: ROOT,
    env: {
      ...process.env,
      CLAUDE_BIN: process.execPath,        // node
      CLAUDE_ARGS: FAKE_CLAUDE,            // fake-claude.js 脚本路径
      CODEX_BIN: process.execPath,         // node
      CODEX_ARGS: FAKE_CODEX,              // fake-codex.js 脚本路径
      PROJECTS_FILE: projectsFile,
      PUBLIC_DIR: publicDir,
      PORT: String(port),
      LOCALAPPDATA: path.join(tmp, 'appdata'), // 日志目录隔离，不污染真实 LOCALAPPDATA
      // 模拟 VSCode/Claude Code 扩展注入的 IDE 标记：断言 codex 子进程 env
      // 被 sanitizeTerminalEnv 净化（与 cmd 启动一致），同时保留正常变量 TEST_KEEP_VAR。
      CLAUDE_CODE_ENTRYPOINT: 'claude-vscode',
      CLAUDE_CODE_SESSION_ID: 'test-session-id',
      CLAUDE_CODE_EXECPATH: 'C:\\fake\\claude.exe',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_AGENT_SDK_VERSION: '0.3.233',
      CLAUDE_EFFORT: 'high',
      CLAUDE_PID: '4242',
      CLAUDECODE: '1',
      AI_AGENT: 'claude-code_test',
      TRACEPARENT: '00-test',
      TRACESTATE: 'test-state',
      VSCODE_PID: '9999',
      TEST_KEEP_VAR: 'keep-me',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {}); // 吞掉避免 unhandled

  // 等待 server 监听端口（最多 10s）
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const tick = () => {
      const req = http.get(`http://127.0.0.1:${port}/api/projects`, (res) => {
        res.resume();
        res.on('end', () => resolve());
      });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('server 10s 内未启动'));
        else setTimeout(tick, 100);
      });
    };
    tick();
  });

  return {
    child, port, tmp, projectsFile, hostProjectDir,
    stop: () => {
      try { child.kill(); } catch (e) {}
      // 销毁 stdio 管道，避免子进程管道让测试运行器事件循环不退出
      try { child.stdout.destroy(); } catch (e) {}
      try { child.stderr.destroy(); } catch (e) {}
    },
  };
}

async function api(base, method, pathStr, body) {
  const opts = { method, hostname: '127.0.0.1', port: base.port, path: pathStr };
  if (body) {
    opts.headers = { 'Content-Type': 'application/json' };
  }
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, raw: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// 收集 WS 消息流；waitFor 轮询已收到的消息数组，取第一条满足谓词的（带超时）。
// 简单优于巧妙：所有消息都进 messages 数组，waitFor 既查历史也订阅新消息。
function openWS(base) {
  const ws = new WebSocket(`ws://127.0.0.1:${base.port}`);
  const messages = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    messages.push(msg);
    if (process.env.TEST_DEBUG) process.stderr.write('[WS] ' + JSON.stringify(msg).slice(0, 160) + '\n');
    for (let i = 0; i < waiters.length; i++) {
      if (waiters[i].pred(msg)) { waiters.splice(i, 1); break; }
    }
  });
  function waitFor(pred, timeoutMs = 8000) {
    const hit = messages.findIndex(pred);
    if (hit >= 0) { const m = messages[hit]; return Promise.resolve(m); }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WS 等待消息超时')), timeoutMs);
      waiters.push({ pred: (m) => { if (pred(m)) { clearTimeout(t); resolve(m); return true; } return false; } });
    });
  }
  return new Promise((resolve) => ws.on('open', () => resolve({ ws, waitFor, messages })));
}

// 创建一个宿主项目，返回 projectId。
async function createHostProject(base, dir) {
  const r = await api(base, 'POST', '/api/projects', {
    name: 'host', projectPath: dir, type: 'node', command: 'echo no-run',
  });
  assert.equal(r.json.ok, true);
  return r.json.project.id;
}

let base;
before(async () => { base = await startServer(); });
after(() => { if (base) base.stop(); });

// 创建 codex 会话返回 x_ 前缀会话 id；PTY 起来后 isatty 为真、输出经 WS 到达前端。
// 消息走 codex 专属通道（codex-session / codex-output），与 claude 通道互不干扰。
test('创建 codex 会话返回会话 id 且 PTY 输出经 WS 到达前端', async () => {
  const pid = await createHostProject(base, base.hostProjectDir);
  const ws_ = await openWS(base);
  const r = await api(base, 'POST', `/api/projects/${pid}/codex-sessions`);
  assert.equal(r.json.ok, true);
  assert.ok(r.json.sessionId && r.json.sessionId.startsWith('x_'));
  if (process.env.TEST_DEBUG) process.stderr.write('[TEST] POST resp sessionId=' + r.json.sessionId + '\n');

  const createEvt = await ws_.waitFor((m) => m.type === 'codex-session' && m.event === 'create' && m.sessionId === r.json.sessionId);
  assert.equal(createEvt.projectId, pid);
  assert.equal(createEvt.sessionType, 'codex');

  const wantSid = r.json.sessionId;
  const out = await ws_.waitFor((m) => m.type === 'codex-output' && m.sessionId === wantSid && /fake-codex/.test(m.data), 8000);
  assert.ok(out, '应收到含 fake-codex 的输出');
  const isattyMsg = await ws_.waitFor((m) => m.type === 'codex-output' && m.sessionId === wantSid && /isatty=true/.test(m.data), 8000);
  assert.ok(isattyMsg, 'PTY 下 isatty 应为 true');

  ws_.ws.close();
});

// 多开会话并存且输出互不串流。
test('多开 codex 会话并存且输出不串流', async () => {
  const pid = await createHostProject(base, base.hostProjectDir);
  const ws_ = await openWS(base);

  const a = await api(base, 'POST', `/api/projects/${pid}/codex-sessions`);
  const b = await api(base, 'POST', `/api/projects/${pid}/codex-sessions`);
  assert.ok(a.json.sessionId !== b.json.sessionId);

  // 各自喂一行 stdin，期待各自 ECHO 回来且只回到各自会话
  ws_.ws.send(JSON.stringify({ type: 'codex-input', sessionId: a.json.sessionId, data: 'hello-a\n' }));
  ws_.ws.send(JSON.stringify({ type: 'codex-input', sessionId: b.json.sessionId, data: 'hello-b\n' }));

  const echoA = await ws_.waitFor((m) => m.type === 'codex-output' && m.sessionId === a.json.sessionId && /ECHO: hello-a/.test(m.data));
  const echoB = await ws_.waitFor((m) => m.type === 'codex-output' && m.sessionId === b.json.sessionId && /ECHO: hello-b/.test(m.data));
  assert.ok(echoA && echoB);

  ws_.ws.close();
});

// 关闭会话后其 WS 流终止、菜单项（exit 事件）到达。
test('主动关闭 codex 会话后收到 exit 事件', async () => {
  const pid = await createHostProject(base, base.hostProjectDir);
  const ws_ = await openWS(base);
  const a = await api(base, 'POST', `/api/projects/${pid}/codex-sessions`);
  await ws_.waitFor((m) => m.type === 'codex-session' && m.event === 'create' && m.sessionId === a.json.sessionId);

  const del = await api(base, 'DELETE', `/api/projects/${pid}/codex-sessions/${a.json.sessionId}`);
  assert.equal(del.json.ok, true);

  const exitEvt = await ws_.waitFor((m) => m.type === 'codex-session' && m.event === 'exit' && m.sessionId === a.json.sessionId);
  assert.ok(exitEvt);

  // 关闭后再列表应为空
  const list = await api(base, 'GET', `/api/projects/${pid}/codex-sessions`);
  assert.equal(list.json.sessions.length, 0);
  ws_.ws.close();
});

// 会话自退（PTY exit）也触发 exit 事件（不靠主动关闭）。
test('codex 自退后自动收到 exit 事件', async () => {
  const pid = await createHostProject(base, base.hostProjectDir);
  const ws_ = await openWS(base);
  const a = await api(base, 'POST', `/api/projects/${pid}/codex-sessions`);
  await ws_.waitFor((m) => m.type === 'codex-session' && m.event === 'create' && m.sessionId === a.json.sessionId);

  // 喂 EXIT 0 让 fake-codex 自己退出
  ws_.ws.send(JSON.stringify({ type: 'codex-input', sessionId: a.json.sessionId, data: 'EXIT 0\n' }));
  const exitEvt = await ws_.waitFor((m) => m.type === 'codex-session' && m.event === 'exit' && m.sessionId === a.json.sessionId);
  assert.ok(exitEvt);
  ws_.ws.close();
});

// 会话创建后 projects.json 内容不变（持久化未被污染）。
test('创建 codex 会话不污染 projects.json', async () => {
  const pid = await createHostProject(base, base.hostProjectDir);
  const before = fs.readFileSync(base.projectsFile, 'utf-8');
  await api(base, 'POST', `/api/projects/${pid}/codex-sessions`);
  const after = fs.readFileSync(base.projectsFile, 'utf-8');
  assert.equal(before, after, 'projects.json 在创建 codex 会话后不应变化');
});

// 同项目下 claude 与 codex 并存：按类型独立编号，输出走各自通道、互不串流。
// 两个通道的 create 事件互不触发对方 —— 验证消息类型 key 碰撞类缺陷（type 覆盖 msgSession）。
test('claude 与 codex 同项目并存、独立编号且不串流', async () => {
  const pid = await createHostProject(base, base.hostProjectDir);
  const ws_ = await openWS(base);

  const c1 = await api(base, 'POST', `/api/projects/${pid}/claude-sessions`);
  const x1 = await api(base, 'POST', `/api/projects/${pid}/codex-sessions`);
  const x2 = await api(base, 'POST', `/api/projects/${pid}/codex-sessions`);
  const c2 = await api(base, 'POST', `/api/projects/${pid}/claude-sessions`);
  assert.ok(c1.json.sessionId.startsWith('c_'));
  assert.ok(x1.json.sessionId.startsWith('x_'));
  assert.ok(x2.json.sessionId.startsWith('x_'));
  // 独立编号：两类型各自从 #1 起，互不消耗对方序号
  assert.equal(c1.json.sessionNumber, 1);
  assert.equal(c2.json.sessionNumber, 2);
  assert.equal(x1.json.sessionNumber, 1);
  assert.equal(x2.json.sessionNumber, 2);

  // 各通道 create 事件类型正确（claude 走 claude-session，codex 走 codex-session）
  const c1evt = await ws_.waitFor((m) => m.type === 'claude-session' && m.event === 'create' && m.sessionId === c1.json.sessionId);
  const x1evt = await ws_.waitFor((m) => m.type === 'codex-session' && m.event === 'create' && m.sessionId === x1.json.sessionId);
  assert.equal(c1evt.sessionType, 'claude');
  assert.equal(x1evt.sessionType, 'codex');
  // claude 通道不应收到 codex 的 session 事件（类型字段未被错配覆盖）
  assert.ok(!ws_.messages.some((m) => m.type === 'claude-session' && m.sessionId === x1.json.sessionId));

  // 各自喂一行，ECHO 只回各自通道
  ws_.ws.send(JSON.stringify({ type: 'claude-input', sessionId: c1.json.sessionId, data: 'from-claude\n' }));
  ws_.ws.send(JSON.stringify({ type: 'codex-input', sessionId: x1.json.sessionId, data: 'from-codex\n' }));
  const echoC = await ws_.waitFor((m) => m.type === 'claude-output' && m.sessionId === c1.json.sessionId && /ECHO: from-claude/.test(m.data));
  const echoX = await ws_.waitFor((m) => m.type === 'codex-output' && m.sessionId === x1.json.sessionId && /ECHO: from-codex/.test(m.data));
  assert.ok(echoC, 'claude 应在 claude 通道收到回显');
  assert.ok(echoX, 'codex 应在 codex 通道收到回显');
  // codex 通道不应夹带 claude 的 ECHO
  assert.ok(!ws_.messages.some((m) => m.type === 'codex-output' && m.sessionId === x1.json.sessionId && /from-claude/.test(m.data)));

  ws_.ws.close();
});

// 解耦：对宿主项目执行 start/stop，已开 codex 会话仍存活、输出流不中断。
test('宿主项目启停不影响 codex 会话', async () => {
  const pid = await createHostProject(base, base.hostProjectDir);
  const ws_ = await openWS(base);
  const a = await api(base, 'POST', `/api/projects/${pid}/codex-sessions`);
  await ws_.waitFor((m) => m.type === 'codex-session' && m.event === 'create' && m.sessionId === a.json.sessionId);

  ws_.ws.send(JSON.stringify({ type: 'codex-input', sessionId: a.json.sessionId, data: 'alive1\n' }));
  await ws_.waitFor((m) => m.type === 'codex-output' && m.sessionId === a.json.sessionId && /ECHO: alive1/.test(m.data));

  // 启动宿主项目（echo no-run 立即退出也无所谓，只验证 codex 不受影响）
  await api(base, 'POST', `/api/projects/${pid}/start`);
  await api(base, 'POST', `/api/projects/${pid}/stop`);

  ws_.ws.send(JSON.stringify({ type: 'codex-input', sessionId: a.json.sessionId, data: 'alive2\n' }));
  const echo = await ws_.waitFor((m) => m.type === 'codex-output' && m.sessionId === a.json.sessionId && /ECHO: alive2/.test(m.data));
  assert.ok(echo, '宿主项目启停后 codex 会话应仍可交互');

  const list = await api(base, 'GET', `/api/projects/${pid}/codex-sessions`);
  assert.ok(list.json.sessions.some((s) => s.sessionId === a.json.sessionId));
  ws_.ws.close();
});

// 删除宿主项目：名下 codex 会话一并递归杀（广播 exit），不留 cwd 指向已删路径的孤儿会话。
test('删除宿主项目杀掉名下 codex 会话', async () => {
  const pid = await createHostProject(base, base.hostProjectDir);
  const ws_ = await openWS(base);
  const a = await api(base, 'POST', `/api/projects/${pid}/codex-sessions`);
  await ws_.waitFor((m) => m.type === 'codex-session' && m.event === 'create' && m.sessionId === a.json.sessionId);

  const del = await api(base, 'DELETE', `/api/projects/${pid}`);
  assert.equal(del.json.ok, true);

  // 删项目后会话应收到 exit 事件（随项目清理），且会话列表不再包含它
  const exit = await ws_.waitFor((m) => m.type === 'codex-session' && m.event === 'exit' && m.sessionId === a.json.sessionId);
  assert.ok(exit, '删除宿主项目后 codex 会话应收到 exit');
  const list = await api(base, 'GET', `/api/projects/${pid}/codex-sessions`);
  assert.equal(list.status, 404, '项目已删除，会话列表路由应 404');
  ws_.ws.close();
});

// codex 子进程 env 必须与"cmd 直接启动 codex"一致：
// 不继承 IDE/Claude Code 注入的标记（与 claude 同因 sanitizeTerminalEnv 净化），
// 也不能剔除正常变量。
test('codex 子进程 env 已净化：不含 IDE 注入标记、保留正常变量', async () => {
  const pid = await createHostProject(base, base.hostProjectDir);
  const ws_ = await openWS(base);
  const r = await api(base, 'POST', `/api/projects/${pid}/codex-sessions`);
  assert.equal(r.json.ok, true);
  const sid = r.json.sessionId;

  const keysMsg = await ws_.waitFor((m) => m.type === 'codex-output' && m.sessionId === sid && /env-ide-keys=/.test(m.data), 8000);
  const ideKeys = JSON.parse(keysMsg.data.match(/env-ide-keys=(\[[^\]]*\])/)[1]);
  assert.deepStrictEqual(ideKeys, [], 'codex 子进程不应继承任何 IDE 注入环境变量');

  const keepMsg = await ws_.waitFor((m) => m.type === 'codex-output' && m.sessionId === sid && /env-keep-var=/.test(m.data), 8000);
  assert.match(keepMsg.data, /env-keep-var=keep-me/, '正常环境变量 TEST_KEEP_VAR 不应被剔除');

  const pathMsg = await ws_.waitFor((m) => m.type === 'codex-output' && m.sessionId === sid && /env-has-path=/.test(m.data), 8000);
  assert.match(pathMsg.data, /env-has-path=yes/, 'PATH 不应丢失');

  ws_.ws.close();
});