// Codex / pi 历史会话契约测试（与 claude-history.contract.test.js 同一套 seam）。
// 测试 seam：启动器后端 HTTP 的外部可观察行为。
// 历史数据来源（测试用环境变量指到临时目录，不依赖真实 CLI 数据）：
//   codex: CODEX_SESSIONS_DIR/YYYY/MM/DD/rollout-*.jsonl，首行 session_meta.payload.cwd 标项目
//   pi:    PI_SESSIONS_DIR/<任意目录名>/*.jsonl，首行 {"type":"session","cwd":...} 标项目
// 摘要 = 首条真实用户消息；上下文 = 文件内用量峰值；mtime = 最后活动时间。
// 点选后按 CLI 各自的方式恢复：codex `resume <id>` 子命令、pi `--session <id>`。
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
const FAKE_CODEX = path.join(ROOT, 'fixtures', 'fake-codex.js');
const FAKE_PI = path.join(ROOT, 'fixtures', 'fake-pi.js');

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

async function startServer() {
  const port = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tac-agent-hist-'));
  const projectsFile = path.join(tmp, 'projects.json');
  const publicDir = path.join(tmp, 'public');
  fs.mkdirSync(publicDir, { recursive: true });

  const child = spawn(process.execPath, [SERVER, `--port=${port}`], {
    cwd: ROOT,
    env: {
      ...process.env,
      CODEX_BIN: process.execPath,
      CODEX_ARGS: FAKE_CODEX,
      PI_BIN: process.execPath,
      PI_ARGS: FAKE_PI,
      PROJECTS_FILE: projectsFile,
      PUBLIC_DIR: publicDir,
      PORT: String(port),
      CODEX_SESSIONS_DIR: path.join(tmp, 'codex-sessions'),
      PI_SESSIONS_DIR: path.join(tmp, 'pi-sessions'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});

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
    child, port, tmp,
    codexSessionsDir: path.join(tmp, 'codex-sessions'),
    piSessionsDir: path.join(tmp, 'pi-sessions'),
    stop: () => {
      try { child.kill(); } catch (e) {}
      try { child.stdout.destroy(); } catch (e) {}
      try { child.stderr.destroy(); } catch (e) {}
    },
  };
}

async function api(base, method, pathStr, body) {
  const opts = { method, hostname: '127.0.0.1', port: base.port, path: pathStr };
  if (body) opts.headers = { 'Content-Type': 'application/json' };
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

function openWS(base) {
  const ws = new WebSocket(`ws://127.0.0.1:${base.port}`);
  const messages = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    messages.push(msg);
    for (let i = 0; i < waiters.length; i++) {
      if (waiters[i].pred(msg)) { waiters.splice(i, 1); break; }
    }
  });
  function waitFor(pred, timeoutMs = 8000) {
    const hit = messages.findIndex(pred);
    if (hit >= 0) return Promise.resolve(messages[hit]);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WS 等待消息超时')), timeoutMs);
      waiters.push({ pred: (m) => { if (pred(m)) { clearTimeout(t); resolve(m); return true; } return false; } });
    });
  }
  return new Promise((resolve) => ws.on('open', () => resolve({ ws, waitFor, messages })));
}

async function createProject(base, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tac-agent-hist-proj-'));
  const r = await api(base, 'POST', '/api/projects', {
    name, projectPath: dir, type: 'node', command: 'echo no-run',
  });
  assert.equal(r.json.ok, true);
  return { id: r.json.project.id, projectPath: r.json.project.projectPath || r.json.project.path || dir };
}

// ---- 造数辅助 ----

// codex 会话文件：YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl，首行 session_meta 带 cwd。
function seedCodexSession(base, projectPath, uuid, entries, mtime) {
  const d = new Date(mtime);
  const dir = path.join(
    base.codexSessionsDir,
    String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0'),
  );
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-01-01T00-00-00-${uuid}.jsonl`);
  const meta = {
    timestamp: new Date(mtime).toISOString(),
    type: 'session_meta',
    payload: { session_id: uuid, cwd: projectPath },
  };
  fs.writeFileSync(file, [meta, ...entries].map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.utimesSync(file, new Date(mtime), new Date(mtime)); // Windows 下 utimesSync 只认 Date
}

// codex 用户消息（response_item.message，content 为 input_text 块数组）
const codexUserMsg = (text, role = 'user') => ({
  type: 'response_item',
  payload: { type: 'message', role, content: [{ type: 'input_text', text }] },
});
// codex token_count 事件（last_token_usage：input + cached + cache_write 即上下文占用）
const codexTokenCount = (input, cached, cacheWrite) => ({
  type: 'event_msg',
  payload: { type: 'token_count', info: { last_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: cacheWrite, output_tokens: 1, total_tokens: input + cached + cacheWrite + 1 } } },
});

// pi 会话文件：<目录名>/<ts>_<uuid>.jsonl，首行 {"type":"session","cwd":...}。
// 目录名按 pi 实际的编码样式（非字母数字转 - 并以 -- 包裹），但匹配靠 cwd 字段而非目录名。
function seedPiSession(base, projectPath, uuid, entries, mtime, dirName) {
  const dir = path.join(base.piSessionsDir, dirName || '--D--test--proj--');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-01-01T00-00-00-000Z_${uuid}.jsonl`);
  const head = { type: 'session', version: 3, id: uuid, timestamp: new Date(mtime).toISOString(), cwd: projectPath };
  fs.writeFileSync(file, [head, ...entries].map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.utimesSync(file, new Date(mtime), new Date(mtime));
}

// pi 用户/助手消息（type:message，message.role 区分；usage.totalTokens 即上下文占用）
const piUserMsg = (text) => ({
  type: 'message',
  message: { role: 'user', content: [{ type: 'text', text }] },
});
const piAsstMsg = (totalTokens) => ({
  type: 'message',
  message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input: 1, output: 1, totalTokens } },
});

let base;
before(async () => { base = await startServer(); });
after(() => { if (base) base.stop(); });

// ---- codex-history ----

test('codex-history 返回摘要与时间，按 mtime 倒序，cwd 不符的会话不出现', async () => {
  const proj = await createProject(base, 'codex-basic');
  const t = (min) => new Date(Date.UTC(2026, 0, 1, 0, min)).getTime();

  seedCodexSession(base, proj.projectPath, '11111111-aaaa-bbbb-cccc-000000000001', [
    codexUserMsg('<skills_instructions>系统注入行，不算用户消息</skills_instructions>', 'developer'),
    codexUserMsg('# AGENTS.md instructions\n\n<INSTRUCTIONS>注入</INSTRUCTIONS>'),
    codexUserMsg('帮我排查 codex 构建失败'),
    codexTokenCount(1000, 2000, 0),
    codexTokenCount(500, 100, 0), // 非最大，不取
  ], t(10));
  // 其他项目的会话：cwd 不匹配，不得混入
  seedCodexSession(base, 'D:\\\\somewhere\\\\else', '11111111-aaaa-bbbb-cccc-000000000002', [
    codexUserMsg('别家项目的会话'),
  ], t(50));
  seedCodexSession(base, proj.projectPath, '11111111-aaaa-bbbb-cccc-000000000003', [
    codexUserMsg('修复登录页 bug'),
  ], t(30));

  const r = await api(base, 'GET', `/api/projects/${proj.id}/codex-history`);
  assert.equal(r.json.ok, true, 'codex-history 路由存在且返回 ok');
  const sessions = r.json.sessions;
  assert.equal(sessions.length, 2, '只含 cwd 匹配的会话');
  assert.deepEqual(sessions.map((s) => s.sessionId), [
    '11111111-aaaa-bbbb-cccc-000000000003',
    '11111111-aaaa-bbbb-cccc-000000000001',
  ], '按 mtime 倒序');
  assert.equal(sessions[1].summary, '帮我排查 codex 构建失败', '摘要取首条真实用户消息（跳过 developer/AGENTS 注入）');
  assert.equal(sessions[0].summary, '修复登录页 bug');
  assert.equal(sessions[1].contextTokens, 3000, 'contextTokens 取 last_token_usage 三项之和的最大值');
  assert.equal(sessions[0].contextTokens, null, '无 token_count 的会话 contextTokens 为 null');
  for (const s of sessions) {
    assert.ok(s.timestamp && !Number.isNaN(Date.parse(s.timestamp)), `timestamp 合法: ${s.timestamp}`);
  }
});

test('codex-history 支持 offset/limit 分页与 hasMore', async () => {
  const proj = await createProject(base, 'codex-paging');
  for (let i = 1; i <= 25; i++) {
    seedCodexSession(base, proj.projectPath, `22222222-aaaa-bbbb-cccc-${String(i).padStart(12, '0')}`, [
      codexUserMsg(`codex 分页会话 ${i}`),
    ], new Date(Date.UTC(2026, 0, 2, 0, i)).getTime());
  }
  const page1 = await api(base, 'GET', `/api/projects/${proj.id}/codex-history?offset=0&limit=20`);
  assert.equal(page1.json.sessions.length, 20);
  assert.equal(page1.json.hasMore, true);
  assert.equal(page1.json.sessions[0].summary, 'codex 分页会话 25');
  const page3 = await api(base, 'GET', `/api/projects/${proj.id}/codex-history?offset=20&limit=20`);
  assert.equal(page3.json.sessions.length, 5);
  assert.equal(page3.json.hasMore, false);
});

// ---- pi-history ----

test('pi-history 返回摘要与时间，按 mtime 倒序，cwd 不符的会话不出现', async () => {
  const proj = await createProject(base, 'pi-basic');
  const t = (min) => new Date(Date.UTC(2026, 0, 3, 0, min)).getTime();

  seedPiSession(base, proj.projectPath, '33333333-aaaa-bbbb-cccc-000000000001', [
    piUserMsg('给 svn 项目加 .gitignore 功能'),
    piAsstMsg(1234),
    piAsstMsg(3000), // totalTokens 取最大
  ], t(10));
  // 其他项目：目录名不同 + cwd 不匹配，不得混入
  seedPiSession(base, 'D:\\\\other\\\\proj', '33333333-aaaa-bbbb-cccc-000000000002', [
    piUserMsg('别家项目的会话'),
  ], t(50), '--D--other--proj--');
  seedPiSession(base, proj.projectPath, '33333333-aaaa-bbbb-cccc-000000000003', [
    piUserMsg('重构会话注册逻辑'),
  ], t(30));

  const r = await api(base, 'GET', `/api/projects/${proj.id}/pi-history`);
  assert.equal(r.json.ok, true, 'pi-history 路由存在且返回 ok');
  const sessions = r.json.sessions;
  assert.equal(sessions.length, 2, '只含 cwd 匹配的会话');
  assert.deepEqual(sessions.map((s) => s.sessionId), [
    '33333333-aaaa-bbbb-cccc-000000000003',
    '33333333-aaaa-bbbb-cccc-000000000001',
  ], '按 mtime 倒序');
  assert.equal(sessions[1].summary, '给 svn 项目加 .gitignore 功能');
  assert.equal(sessions[1].contextTokens, 3000, 'contextTokens 取 totalTokens 最大值');
  assert.equal(sessions[0].contextTokens, null, '无 usage 的会话 contextTokens 为 null');
});

// 目录不存在（该项目从未开过对应 CLI）：返回空列表而非报错。
test('codex/pi-history 目录缺失时返回空列表', async () => {
  const proj = await createProject(base, 'agent-hist-empty');
  const rc = await api(base, 'GET', `/api/projects/${proj.id}/codex-history`);
  assert.equal(rc.json.ok, true);
  assert.deepEqual(rc.json.sessions, []);
  const rp = await api(base, 'GET', `/api/projects/${proj.id}/pi-history`);
  assert.equal(rp.json.ok, true);
  assert.deepEqual(rp.json.sessions, []);
});

// ---- 恢复参数：codex `resume <id>` 子命令、pi `--session <id>` ----

test('POST codex-sessions 带 resume 时 codex 启动参数含 resume <id> 子命令', async () => {
  const proj = await createProject(base, 'codex-resume');
  seedCodexSession(base, proj.projectPath, '44444444-aaaa-bbbb-cccc-000000000001', [
    codexUserMsg('历史会话内容'),
  ], Date.now());

  const ws_ = await openWS(base);
  const r = await api(base, 'POST', `/api/projects/${proj.id}/codex-sessions`, { resume: '44444444-aaaa-bbbb-cccc-000000000001' });
  assert.equal(r.json.ok, true);
  assert.ok(r.json.sessionId.startsWith('x_'), 'codex 会话 id 前缀 x_');

  const argvMsg = await ws_.waitFor((m) => m.type === 'codex-output' && m.sessionId === r.json.sessionId && /fake-codex\] argv=/.test(m.data));
  const argv = JSON.parse(argvMsg.data.match(/fake-codex\] argv=(\[[^\]]*\])/)[1]);
  const i = argv.indexOf('resume');
  assert.ok(i > 0, '启动参数应包含 resume 子命令');
  assert.equal(argv[i + 1], '44444444-aaaa-bbbb-cccc-000000000001', 'resume 后紧跟历史会话 id');

  // 对照：不带 resume 的普通创建不应带 resume 子命令
  const r2 = await api(base, 'POST', `/api/projects/${proj.id}/codex-sessions`);
  assert.equal(r2.json.ok, true);
  const argvMsg2 = await ws_.waitFor((m) => m.type === 'codex-output' && m.sessionId === r2.json.sessionId && /fake-codex\] argv=/.test(m.data));
  const argv2 = JSON.parse(argvMsg2.data.match(/fake-codex\] argv=(\[[^\]]*\])/)[1]);
  assert.ok(!argv2.includes('resume'), '普通创建不应带 resume 子命令');

  ws_.ws.close();
});

test('POST pi-sessions 带 resume 时 pi 启动参数含 --session <id>', async () => {
  const proj = await createProject(base, 'pi-resume');
  seedPiSession(base, proj.projectPath, '55555555-aaaa-bbbb-cccc-000000000001', [
    piUserMsg('历史会话内容'),
  ], Date.now());

  const ws_ = await openWS(base);
  const r = await api(base, 'POST', `/api/projects/${proj.id}/pi-sessions`, { resume: '55555555-aaaa-bbbb-cccc-000000000001' });
  assert.equal(r.json.ok, true);
  assert.ok(r.json.sessionId.startsWith('i_'), 'pi 会话 id 前缀 i_');

  const argvMsg = await ws_.waitFor((m) => m.type === 'pi-output' && m.sessionId === r.json.sessionId && /fake-pi\] argv=/.test(m.data));
  const argv = JSON.parse(argvMsg.data.match(/fake-pi\] argv=(\[[^\]]*\])/)[1]);
  const i = argv.indexOf('--session');
  assert.ok(i > 0, '启动参数应包含 --session（pi 的 --resume 只弹选择器，不能用于指定会话）');
  assert.equal(argv[i + 1], '55555555-aaaa-bbbb-cccc-000000000001', '--session 后紧跟历史会话 id');

  ws_.ws.close();
});
