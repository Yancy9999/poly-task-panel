// Claude 历史会话契约测试。
// 测试 seam：启动器后端 HTTP/WS 的外部可观察行为。
// 历史会话数据来自 ~/.claude/projects/<编码路径>/<sessionId>.jsonl，
// 测试用 CLAUDE_PROJECTS_DIR 指到临时目录并塞入伪造 jsonl，不依赖真实 CLI 数据。
// 只断言外部行为，不断言实现细节。
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

// 与 Claude Code 实际目录编码一致：路径中非 [a-zA-Z0-9-] 字符全部替换为 '-'。
// 例：D:\ai-coding\yancy\poly-task-panel → D--ai-coding-yancy-poly-task-panel
function encodeClaudeProjectDir(p) {
  return p.replace(/[^a-zA-Z0-9-]/g, '-');
}

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

async function startServer() {
  const port = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tac-hist-'));
  const projectsFile = path.join(tmp, 'projects.json');
  const publicDir = path.join(tmp, 'public');
  fs.mkdirSync(publicDir, { recursive: true });
  const claudeProjectsDir = path.join(tmp, 'claude-projects'); // 伪造 ~/.claude/projects

  const child = spawn(process.execPath, [SERVER, `--port=${port}`], {
    cwd: ROOT,
    env: {
      ...process.env,
      CLAUDE_BIN: process.execPath,
      CLAUDE_ARGS: FAKE_CLAUDE,
      PROJECTS_FILE: projectsFile,
      PUBLIC_DIR: publicDir,
      PORT: String(port),
      LOCALAPPDATA: path.join(tmp, 'appdata'),
      CLAUDE_PROJECTS_DIR: claudeProjectsDir, // 历史会话目录隔离
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
    child, port, tmp, claudeProjectsDir,
    stop: () => {
      try { child.kill(); } catch (e) {}
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
    if (hit >= 0) { const m = messages[hit]; return Promise.resolve(m); }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WS 等待消息超时')), timeoutMs);
      waiters.push({ pred: (m) => { if (pred(m)) { clearTimeout(t); resolve(m); return true; } return false; } });
    });
  }
  return new Promise((resolve) => ws.on('open', () => resolve({ ws, waitFor, messages })));
}

// 创建项目（独立目录）并返回 { id, projectPath }（projectPath 取服务端回包，避免归一化差异）。
async function createProject(base, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tac-hist-proj-'));
  const r = await api(base, 'POST', '/api/projects', {
    name, projectPath: dir, type: 'node', command: 'echo no-run',
  });
  assert.equal(r.json.ok, true);
  const pid = r.json.project.id;
  const list = await api(base, 'GET', '/api/projects');
  const p = list.json.find((x) => x.id === pid);
  assert.ok(p, '创建后应能从列表取回项目');
  return { id: pid, projectPath: p.projectPath };
}

// 在伪造的 claude projects 目录下种一个会话 jsonl。
// entries 为对象数组（逐行 JSON.stringify），mtime 控制排序与"最后活动时间"。
function seedSession(base, projectPath, sessionId, entries, mtime) {
  const dir = path.join(base.claudeProjectsDir, encodeClaudeProjectDir(projectPath));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.utimesSync(file, mtime, mtime);
}

const userMsg = (content, extra = {}) => ({
  type: 'user', message: { role: 'user', content }, ...extra,
});
// assistant 记录（带 usage：上下文占用 = input + cache_read + cache_creation）
const asstMsg = (usage, extra = {}) => ({
  type: 'assistant', message: { role: 'assistant', usage }, ...extra,
});

let base;
before(async () => { base = await startServer(); });
after(() => { if (base) base.stop(); });

// 基本形状：返回摘要（首条真实用户消息，跳过 meta/快照行）+ 最后活动时间，按最近活动排序。
test('claude-history 返回摘要与时间，按最近活动倒序，跳过 meta 行', async () => {
  const proj = await createProject(base, 'hist-basic');
  const t = (min) => new Date(Date.UTC(2026, 0, 1, 0, min));

  seedSession(base, proj.projectPath, 'sess-old', [
    userMsg('帮我修复登录页的 bug，点击按钮无响应'),
    { type: 'assistant', message: { role: 'assistant', content: '好的' } },
  ], t(10));
  seedSession(base, proj.projectPath, 'sess-meta', [
    { type: 'file-history-snapshot', messageId: 'x' },
    { type: 'user', isMeta: true, message: { role: 'user', content: 'caveat: 这行是元信息，不算用户消息' } },
    { type: 'mode', mode: 'default' },
    userMsg('重构 server.js 的会话注册逻辑'),
  ], t(30));
  seedSession(base, proj.projectPath, 'sess-mid', [
    userMsg('写一个 cron 表达式解析器'),
    // usage 记录：上下文占用取整个文件的最大值（1000+2000+0+0=3000；前面的 250 不是最大）
    asstMsg({ input_tokens: 250, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    asstMsg({ input_tokens: 1000, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 }),
  ], t(20));
  // 超长摘要截断
  seedSession(base, proj.projectPath, 'sess-long', [
    userMsg('长'.repeat(120)),
  ], t(40));

  const r = await api(base, 'GET', `/api/projects/${proj.id}/claude-history`);
  assert.equal(r.json.ok, true);
  const sessions = r.json.sessions;
  assert.ok(Array.isArray(sessions));

  assert.equal(sessions.length, 4);
  // 倒序：mtime 最新的在前
  assert.deepEqual(sessions.map((s) => s.sessionId), ['sess-long', 'sess-meta', 'sess-mid', 'sess-old']);
  // 摘要 = 首条真实用户消息（meta/caveat 被跳过）
  assert.equal(sessions[0].summary, '长'.repeat(80) + '…', '超长摘要截断到 80 字符加省略号');
  assert.equal(sessions[1].summary, '重构 server.js 的会话注册逻辑');
  assert.equal(sessions[2].summary, '写一个 cron 表达式解析器');
  assert.equal(sessions[3].summary, '帮我修复登录页的 bug，点击按钮无响应');
  // 最后活动时间为合法时间戳
  for (const s of sessions) {
    assert.ok(s.timestamp && !Number.isNaN(Date.parse(s.timestamp)), `timestamp 应为合法时间: ${s.timestamp}`);
  }
  assert.equal(new Date(sessions[1].timestamp).getTime(), t(30).getTime(), 'timestamp 取文件最后活动时间');
  // 上下文大小 = 文件内 usage 最大值（input + cache_read + cache_creation），无 usage 记录时为 null
  assert.equal(sessions[0].contextTokens, null, '无 usage 记录的会话 contextTokens 为 null');
  assert.equal(sessions[2].contextTokens, 3000, 'contextTokens 取 usage 三项之和的最大值');
});

// 上限：默认仍只返回 20 个（最近活动的 20 个），不带分页参数时行为不回归。
test('claude-history 最多返回 20 个会话', async () => {
  const proj = await createProject(base, 'hist-limit');
  for (let i = 1; i <= 25; i++) {
    seedSession(base, proj.projectPath, `f${String(i).padStart(2, '0')}`, [
      userMsg(`填充会话 ${i}`),
    ], new Date(Date.UTC(2026, 0, 2, 0, i)));
  }
  const r = await api(base, 'GET', `/api/projects/${proj.id}/claude-history`);
  assert.equal(r.json.ok, true);
  const sessions = r.json.sessions;
  assert.equal(sessions.length, 20, '超过 20 个时只取最近 20 个');
  assert.equal(sessions[0].summary, '填充会话 25');
  assert.equal(sessions[19].summary, '填充会话 6', '最旧的 5 个被截掉');
});

// 分页：offset/limit 供前端滚动加载（打开取 20 条，滚到底再取 20 条）。
// limit 缺省 20；offset 越界返回空数组；回包带 hasMore 供前端判断是否继续加载。
test('claude-history 支持 offset/limit 分页', async () => {
  const proj = await createProject(base, 'hist-paging');
  for (let i = 1; i <= 45; i++) {
    seedSession(base, proj.projectPath, `p${String(i).padStart(2, '0')}`, [
      userMsg(`分页会话 ${i}`),
    ], new Date(Date.UTC(2026, 0, 3, 0, i)));
  }
  const page1 = await api(base, 'GET', `/api/projects/${proj.id}/claude-history?offset=0&limit=20`);
  assert.equal(page1.json.ok, true);
  assert.equal(page1.json.sessions.length, 20);
  assert.deepEqual(page1.json.sessions.map((s) => s.sessionId),
    Array.from({ length: 20 }, (_, i) => `p${String(45 - i).padStart(2, '0')}`),
    '第一页 = 最近 20 个（p45→p26）');
  assert.equal(page1.json.hasMore, true, '还有更多时 hasMore 为 true');

  const page2 = await api(base, 'GET', `/api/projects/${proj.id}/claude-history?offset=20&limit=20`);
  assert.equal(page2.json.sessions.length, 20);
  assert.equal(page2.json.sessions[0].sessionId, 'p25');
  assert.equal(page2.json.sessions[19].sessionId, 'p06');
  assert.equal(page2.json.hasMore, true);

  const page3 = await api(base, 'GET', `/api/projects/${proj.id}/claude-history?offset=40&limit=20`);
  assert.equal(page3.json.sessions.length, 5, '最后一页只返回剩余的 5 个');
  assert.equal(page3.json.sessions[0].sessionId, 'p05');
  assert.equal(page3.json.sessions[4].sessionId, 'p01');
  assert.equal(page3.json.hasMore, false, '取完后 hasMore 为 false');

  const empty = await api(base, 'GET', `/api/projects/${proj.id}/claude-history?offset=100&limit=20`);
  assert.deepEqual(empty.json.sessions, [], 'offset 越界返回空数组');
  assert.equal(empty.json.hasMore, false);

  // 无参数时等价 offset=0&limit=20（默认行为兼容）
  const def = await api(base, 'GET', `/api/projects/${proj.id}/claude-history`);
  assert.equal(def.json.sessions.length, 20);
  assert.equal(def.json.hasMore, true);
});

// 目录不存在（该项目从未在此机器开过 claude）：返回空列表而非报错。
test('claude-history 目录缺失时返回空列表', async () => {
  const proj = await createProject(base, 'hist-empty');
  const r = await api(base, 'GET', `/api/projects/${proj.id}/claude-history`);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.sessions, []);
});

// 点选历史会话 → 创建带 --resume <sessionId> 的 claude 会话。
test('POST claude-sessions 带 resume 时 claude 启动参数含 --resume <id>', async () => {
  const proj = await createProject(base, 'hist-resume');
  seedSession(base, proj.projectPath, 'seed-abc123', [
    userMsg('历史会话内容'),
  ], new Date(Date.UTC(2026, 0, 3)));

  const ws_ = await openWS(base);
  const r = await api(base, 'POST', `/api/projects/${proj.id}/claude-sessions`, { resume: 'seed-abc123' });
  assert.equal(r.json.ok, true);
  assert.ok(r.json.sessionId.startsWith('c_'));

  // fake-claude 启动时把 argv 写到 stderr，PTY 合并后出现在 claude-output 里
  const argvMsg = await ws_.waitFor((m) => m.type === 'claude-output' && m.sessionId === r.json.sessionId && /fake-claude\] argv=/.test(m.data));
  const argv = JSON.parse(argvMsg.data.match(/fake-claude\] argv=(\[[^\]]*\])/)[1]);
  assert.ok(argv.includes('--resume'), '启动参数应包含 --resume');
  assert.equal(argv[argv.indexOf('--resume') + 1], 'seed-abc123', '--resume 后应紧跟历史会话 id');

  // 对照：不带 resume 的普通创建不应带 --resume（现有行为不回归）
  const r2 = await api(base, 'POST', `/api/projects/${proj.id}/claude-sessions`);
  assert.equal(r2.json.ok, true);
  const argvMsg2 = await ws_.waitFor((m) => m.type === 'claude-output' && m.sessionId === r2.json.sessionId && /fake-claude\] argv=/.test(m.data));
  const argv2 = JSON.parse(argvMsg2.data.match(/fake-claude\] argv=(\[[^\]]*\])/)[1]);
  assert.ok(!argv2.includes('--resume'), '普通创建不应带 --resume');

  ws_.ws.close();
});
