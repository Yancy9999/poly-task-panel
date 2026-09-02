// WebSocket 通道 in-process 回归：连接推送 / 状态广播 / log-batch 广播 / 脏消息容错。
// 另覆盖 /about.md 路由与 sanitizeTerminalEnv（经 broadcast 导出探针）。
const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

let srv = null;
const origCreate = http.createServer;
http.createServer = (...a) => { srv = origCreate.apply(http, a); return srv; };

process.env.PORT = '7980';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ptp-ws-'));
process.env.PROJECTS_FILE = path.join(TMP, 'projects.json');
process.env.SETTINGS_FILE = path.join(TMP, 'settings.json');
process.env.LOCALAPPDATA = path.join(TMP, 'appdata');
process.env.__PTP_TMPDIR__ = TMP;

const base = require('../server.js');
const { broadcast, sanitizeTerminalEnv } = base;

function req(method, reqPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = payload
      ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      : undefined;
    const r = http.request(
      { host: 'localhost', port: 7980, path: reqPath, method, headers },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(buf); } catch (_) {}
          resolve({ status: res.statusCode, json, text: buf });
        });
      }
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function wsConnect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://localhost:7980');
    const msgs = [];
    ws.on('message', (raw) => msgs.push(JSON.parse(raw)));
    ws.on('open', () => resolve({ ws, msgs }));
    ws.on('error', reject);
  });
}

let projId = null;

test('setup: 创建项目', async () => {
  fs.writeFileSync(process.env.PROJECTS_FILE, JSON.stringify([]));
  fs.mkdirSync(path.join(TMP, 'ws-proj'), { recursive: true });
  const res = await req('POST', '/api/projects', {
    name: 'ws-proj',
    projectPath: path.join(TMP, 'ws-proj'),
    type: 'node',
    command: 'node -e "console.log(1)"',
  });
  assert.equal(res.status, 200);
  assert.ok(res.json.ok);
  projId = res.json.project.id;
  assert.ok(projId, '创建应返回项目 id');
});

test('WS 连接：推送所有项目运行状态', async () => {
  const { ws, msgs } = await wsConnect();
  const status = msgs.find((m) => m.type === 'status' && m.projectId);
  assert.ok(status, '连接时应收到 status 推送');
  assert.equal(status.running, false);
  ws.close();
});

test('WS 状态广播：启动与停止都会推送给所有客户端', async () => {
  const { ws, msgs } = await wsConnect();
  await wait(50); // 等 connection 初始推送消费完
  const start = await req('POST', `/api/projects/${projId}/start`);
  assert.ok(start.json.ok);
  await wait(600); // 等子进程 stdout 触发 log-batch 与 status
  const stop = await req('POST', `/api/projects/${projId}/stop`);
  assert.ok(stop.json.ok);
  await wait(300);
  ws.close();

  const runningTrue = msgs.find((m) => m.type === 'status' && m.running === true);
  const runningFalse = msgs.find(
    (m) => m.type === 'status' && m.running === false && m.pid === null
  );
  assert.ok(runningTrue, '应收到 running:true 广播');
  assert.ok(runningFalse, '停止后应收到 running:false 广播');
  const batch = msgs.find((m) => m.type === 'log-batch' && m.projectId === projId);
  assert.ok(batch, '子进程输出应触发 log-batch 广播');
  assert.ok(Array.isArray(batch.entries) && batch.entries.length > 0);
});

test('WS 脏消息：非 JSON 消息不应导致连接断开', async () => {
  const { ws, msgs } = await wsConnect();
  ws.send('not-json{{{');
  ws.send(JSON.stringify({ type: 'claude-input', sessionId: 'no-such', data: 'x' }));
  await wait(200);
  assert.equal(ws.readyState, WebSocket.OPEN, '连接应保持');
  // 再次广播仍能收到 → 客户端未被移除
  broadcast({ type: 'ping-test' });
  await wait(100);
  assert.ok(msgs.some((m) => m.type === 'ping-test'), '广播应仍送达该客户端');
  ws.close();
});

test('WS 不存在的输入会话：写 stdin 静默忽略', async () => {
  const { ws } = await wsConnect();
  ws.send(JSON.stringify({ type: 'claude-input', sessionId: 'ghost', data: 'hi' }));
  await wait(150);
  assert.equal(ws.readyState, WebSocket.OPEN);
  ws.close();
});

test('/about.md：返回 ABOUT.md 并同步版本号', async () => {
  const res = await req('GET', '/about.md');
  assert.equal(res.status, 200);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const m = res.text.match(/\*\*版本\*\*：(.+)/);
  assert.ok(m, '应含版本行');
  assert.equal(m[1].trim(), pkg.version, '版本号应与 package.json 同步');
});

test('sanitizeTerminalEnv：剥离 IDE/Agent 注入的环境变量', () => {
  const out = sanitizeTerminalEnv({
    PATH: 'x',
    CLAUDE_CODE_SSE_PORT: '1',
    CLAUDE_ENTRYPOINT: 'cli',
    VSCODE_PID: '9',
    CLAUDECODE: '1',
    AI_AGENT: '1',
    TRACEPARENT: 't',
    TRACESTATE: 's',
    KEEP_ME: 'yes',
  });
  assert.equal(out.PATH, 'x');
  assert.equal(out.KEEP_ME, 'yes');
  for (const k of [
    'CLAUDE_CODE_SSE_PORT', 'CLAUDE_ENTRYPOINT', 'VSCODE_PID',
    'CLAUDECODE', 'AI_AGENT', 'TRACEPARENT', 'TRACESTATE',
  ]) {
    assert.ok(!(k in out), `${k} 应被剥离`);
  }
});

test.after(() => {
  try {
    if (srv && srv.listening) srv.close(() => {});
  } catch (_) {}
  const tmp = process.env.__PTP_TMPDIR__;
  if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} }
});
