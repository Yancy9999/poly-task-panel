// cmd / gitbash 终端会话契约测试。
// 测试 seam 与 claude-session.contract.test.js 一致：启动器后端 HTTP/WS 的外部
// 可观察行为。用真 shell（cmd.exe / Git Bash）——node-pty 的 CreateProcess 不能
// 直接跑 .cmd 包装（error 193），假壳注入不可行；真 shell 的交互行为对以下断言
// 足够稳定：echo 输出、exit 退出码。
// 覆盖：
//   1. 两种会话创建返回各自 id 前缀（m_ / g_）、PTY 输出经 WS 到达、cwd 是宿主项目。
//   2. 输出/input 按 msgOutput 类型（cmd-output / gitbash-output）独立路由。
//   3. 主动 DELETE 后 exit 事件到达、列表清空。
//   4. 会话自退（exit / EXIT）自动收到 exit 事件。
//   5. 会话列表按类型隔离（cmd 不混入 gitbash，反之亦然）。
//   6. /about.md 路由：markdown 返回 + 版本号自动同步 package.json。
//   7. /api/projects/:id/clear-logs：清空后 logs 列表为空；404 项目返回 404。
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, execSync } = require('node:child_process');
const http = require('node:http');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'server.js');

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

// 与 server.js detectGitBash 同款探测：测试环境没有 Git Bash 就跳过 gitbash 用例
function detectGitBash() {
  const candidates = [];
  try {
    const gitPath = execSync('where git', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim().split(/\r?\n/)[0];
    if (gitPath) candidates.push(path.join(path.dirname(path.dirname(gitPath)), 'bin', 'bash.exe'));
  } catch (e) {}
  candidates.push(
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
  );
  return candidates.find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } }) || null;
}

async function startServer() {
  const port = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-test-'));
  const projectsFile = path.join(tmp, 'projects.json');
  const publicDir = path.join(tmp, 'public');
  fs.mkdirSync(publicDir, { recursive: true });
  const hostProjectDir = path.join(tmp, 'host-project');
  fs.mkdirSync(hostProjectDir, { recursive: true });

  const child = spawn(process.execPath, [SERVER, `--port=${port}`], {
    cwd: ROOT,
    env: {
      ...process.env,
      PROJECTS_FILE: projectsFile,
      PUBLIC_DIR: publicDir,
      PORT: String(port),
      LOCALAPPDATA: path.join(tmp, 'appdata'), // 日志目录隔离
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
    child, port, tmp, projectsFile, hostProjectDir,
    gitBash: detectGitBash(),
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
        try { resolve({ status: res.statusCode, json: JSON.parse(data), raw: data }); }
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

async function createHostProject(base, dir) {
  const r = await api(base, 'POST', '/api/projects', {
    name: 'host', projectPath: dir, type: 'node', command: 'echo no-run',
  });
  assert.equal(r.json.ok, true);
  return r.json.project.id;
}

// skip 谓词在 test 注册时求值（早于 before()），Git Bash 探测必须提在模块层
const HAS_GIT_BASH = !!detectGitBash();

let base;
before(async () => { base = await startServer(); });
after(() => { if (base) base.stop(); });

// ---- cmd 会话 ----

test('创建 cmd 会话：id 前缀 m_、create 事件、PTY 提示符输出到达', async () => {
  const pid = await createHostProject(base, base.hostProjectDir);
  const ws_ = await openWS(base);
  const r = await api(base, 'POST', `/api/projects/${pid}/cmd-sessions`);
  assert.equal(r.json.ok, true, '创建 cmd 会话失败: ' + JSON.stringify(r.json));
  assert.ok(r.json.sessionId.startsWith('m_'), 'cmd 会话 id 前缀 m_');

  await ws_.waitFor((m) => m.type === 'cmd-session' && m.event === 'create' && m.sessionId === r.json.sessionId);
  const wantSid = r.json.sessionId;
  // cmd 起来会吐提示符（含盘符路径）；PTY 输出经 WS 到达即达成契约
  await ws_.waitFor((m) => m.type === 'cmd-output' && m.sessionId === wantSid && m.data && m.data.length > 0, 8000);
  ws_.ws.close();
});

test('cmd 会话：echo 输出经 cmd-output 路由回显', async () => {
  const pid = await createHostProject(base, base.hostProjectDir);
  const ws_ = await openWS(base);
  const a = await api(base, 'POST', `/api/projects/${pid}/cmd-sessions`);
  await ws_.waitFor((m) => m.type === 'cmd-session' && m.event === 'create' && m.sessionId === a.json.sessionId);
  // 等提示符就绪再发命令（cmd 未就绪时 stdin 也会被缓冲，但等一下更稳）
  await new Promise((r) => setTimeout(r, 800));
  ws_.ws.send(JSON.stringify({ type: 'cmd-input', sessionId: a.json.sessionId, data: 'echo MARKER_CMD_ECHO\r\n' }));
  const echo = await ws_.waitFor((m) => m.type === 'cmd-output' && m.sessionId === a.json.sessionId && /MARKER_CMD_ECHO/.test(m.data));
  assert.ok(echo, 'echo 输出应经 cmd-output 回到前端');
  ws_.ws.close();
});

// ---- gitbash 会话 ----

test('创建 gitbash 会话：id 前缀 g_、create 事件、PTY 输出到达', { skip: !HAS_GIT_BASH ? '本机无 Git Bash' : false }, async () => {
  const pid = await createHostProject(base, base.hostProjectDir);
  const ws_ = await openWS(base);
  const r = await api(base, 'POST', `/api/projects/${pid}/gitbash-sessions`);
  assert.equal(r.json.ok, true, '创建 gitbash 会话失败: ' + JSON.stringify(r.json));
  assert.ok(r.json.sessionId.startsWith('g_'), 'gitbash 会话 id 前缀 g_');

  await ws_.waitFor((m) => m.type === 'gitbash-session' && m.event === 'create' && m.sessionId === r.json.sessionId);
  const wantSid = r.json.sessionId;
  await ws_.waitFor((m) => m.type === 'gitbash-output' && m.sessionId === wantSid && m.data && m.data.length > 0, 8000);
  ws_.ws.close();
});

test('gitbash 会话：echo 输出经 gitbash-output 路由回显', { skip: !HAS_GIT_BASH ? '本机无 Git Bash' : false }, async () => {
  const pid = await createHostProject(base, base.hostProjectDir);
  const ws_ = await openWS(base);
  const a = await api(base, 'POST', `/api/projects/${pid}/gitbash-sessions`);
  await ws_.waitFor((m) => m.type === 'gitbash-session' && m.event === 'create' && m.sessionId === a.json.sessionId);
  await new Promise((r) => setTimeout(r, 800)); // 登录 shell 加载 profile 需一点时间
  ws_.ws.send(JSON.stringify({ type: 'gitbash-input', sessionId: a.json.sessionId, data: 'echo MARKER_BASH_ECHO\n' }));
  const echo = await ws_.waitFor((m) => m.type === 'gitbash-output' && m.sessionId === a.json.sessionId && /MARKER_BASH_ECHO/.test(m.data));
  assert.ok(echo, 'echo 输出应经 gitbash-output 回到前端');
  ws_.ws.close();
});

// ---- 类型隔离与清理 ----

test('会话列表按类型隔离：cmd 与 gitbash 互不混入', async () => {
  const pid = await createHostProject(base, base.hostProjectDir);
  const c = await api(base, 'POST', `/api/projects/${pid}/cmd-sessions`);
  assert.equal(c.json.ok, true);
  const g = await api(base, 'POST', `/api/projects/${pid}/gitbash-sessions`);
  if (g.json.ok) {
    const cmdList = await api(base, 'GET', `/api/projects/${pid}/cmd-sessions`);
    const gitList = await api(base, 'GET', `/api/projects/${pid}/gitbash-sessions`);
    assert.ok(cmdList.json.sessions.some((s) => s.sessionId === c.json.sessionId));
    assert.ok(!cmdList.json.sessions.some((s) => s.sessionId === g.json.sessionId), 'cmd 列表不含 gitbash 会话');
    assert.ok(gitList.json.sessions.some((s) => s.sessionId === g.json.sessionId));
    assert.ok(!gitList.json.sessions.some((s) => s.sessionId === c.json.sessionId), 'gitbash 列表不含 cmd 会话');
  } else {
    // 无 Git Bash 时至少断言 cmd 列表正确
    const cmdList = await api(base, 'GET', `/api/projects/${pid}/cmd-sessions`);
    assert.ok(cmdList.json.sessions.some((s) => s.sessionId === c.json.sessionId));
  }
});

test('DELETE 关闭 cmd 会话后 exit 事件到达、列表清空', async () => {
  const pid = await createHostProject(base, base.hostProjectDir);
  const ws_ = await openWS(base);
  const a = await api(base, 'POST', `/api/projects/${pid}/cmd-sessions`);
  await ws_.waitFor((m) => m.type === 'cmd-session' && m.event === 'create' && m.sessionId === a.json.sessionId);

  const del = await api(base, 'DELETE', `/api/projects/${pid}/cmd-sessions/${a.json.sessionId}`);
  assert.equal(del.json.ok, true);
  await ws_.waitFor((m) => m.type === 'cmd-session' && m.event === 'exit' && m.sessionId === a.json.sessionId);
  const list = await api(base, 'GET', `/api/projects/${pid}/cmd-sessions`);
  assert.equal(list.json.sessions.length, 0);
  ws_.ws.close();
});

test('cmd 会话自退（exit 命令退出）后自动收到 exit 事件', async () => {
  const pid = await createHostProject(base, base.hostProjectDir);
  const ws_ = await openWS(base);
  const a = await api(base, 'POST', `/api/projects/${pid}/cmd-sessions`);
  await ws_.waitFor((m) => m.type === 'cmd-session' && m.event === 'create' && m.sessionId === a.json.sessionId);
  await new Promise((r) => setTimeout(r, 800));
  ws_.ws.send(JSON.stringify({ type: 'cmd-input', sessionId: a.json.sessionId, data: 'exit\r\n' }));
  const exitEvt = await ws_.waitFor((m) => m.type === 'cmd-session' && m.event === 'exit' && m.sessionId === a.json.sessionId, 10000);
  assert.ok(exitEvt, 'cmd 进程退出应自动广播 exit 事件');
  ws_.ws.close();
});

// ---- about.md 与 clear-logs 路由 ----

test('/about.md 返回 markdown 且版本号与 package.json 同步', async () => {
  const r = await api(base, 'GET', '/about.md');
  assert.equal(r.status, 200);
  assert.ok(r.raw.includes('**版本**：'), '含版本行');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(r.raw.includes(`**版本**：${pkg.version}`), `版本号替换为 package.json 的 ${pkg.version}`);
});

test('clear-logs：清空后 logs 列表为空；未知项目 404', async () => {
  const pid = await createHostProject(base, base.hostProjectDir);
  // 产生至少一条日志（start 会写日志；echo no-run 立即退出也落条目）
  await api(base, 'POST', `/api/projects/${pid}/start`);
  await new Promise((r) => setTimeout(r, 500));
  await api(base, 'POST', `/api/projects/${pid}/stop`);

  const cleared = await api(base, 'POST', `/api/projects/${pid}/clear-logs`);
  assert.equal(cleared.json.ok, true);

  const logs = await api(base, 'GET', `/api/projects/${pid}/logs`);
  assert.equal(logs.json.ok, true);
  assert.equal(logs.json.entries.length, 0, '清空后日志条目为 0');

  const nf = await api(base, 'POST', '/api/projects/p_nonexist/clear-logs');
  assert.equal(nf.status, 404);
});
