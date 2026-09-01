// Claude 启动参数契约测试（--dangerously-skip-permissions）。
// 与 claude-session.contract.test.js 同一测试 seam：独立 server.js 子进程 + 假 claude，
// 通过 fake-claude 回显自身收到的 argv，断言 server spawn 时传入了默认跳权限参数。
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

// 与 claude-session.contract.test.js 相同的启动方式（CLAUDE_ARGS 指向 fake-claude）。
// 本文件不设 CLAUDE_ARGS → server 用默认 args（含 --dangerously-skip-permissions），
// 走 codex 风格的裸名 spawn 会失败，故 CLAUDE_BIN=node、CLAUDE_ARGS 仍需注入脚本路径。
async function startServer() {
  const port = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tac-test-'));
  const projectsFile = path.join(tmp, 'projects.json');
  const publicDir = path.join(tmp, 'public');
  fs.mkdirSync(publicDir, { recursive: true });
  const hostProjectDir = path.join(tmp, 'host-project');
  fs.mkdirSync(hostProjectDir, { recursive: true });

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

// fake-claude 把自身 argv 写到 stdout，测试断言 spawn 参数里带上了
// --dangerously-skip-permissions（CLAUDE_ARGS 整体覆盖语义不变：测试注入的
// CLAUDE_ARGS=脚本路径替换了默认参数，fake-claude 从 argv 侧观察不到默认值）。
// 这里直接单测 TERMINAL_TYPES.claude.args 的默认值——契约层面 fake-claude
// 只需证明 argv 透传链路正常。
test('TERMINAL_TYPES.claude 默认参数含 --dangerously-skip-permissions', async () => {
  // server.js 在 require 时会启动 HTTP 监听，为避免端口冲突用环境变量隔离端口；
  // 这里复用已启动的 base server 进程不现实（args 在其进程内），故用子进程求值。
  const out = spawn(process.execPath, ['-e', `
    process.env.PROJECTS_FILE = 'skip';
    const src = require('fs').readFileSync(${JSON.stringify(SERVER)}, 'utf-8');
    // 提取 TERMINAL_TYPES 定义段做静态断言，避免真正 require（会起监听）。
    const m = src.match(/claude:\\s*\\{[\\s\\S]*?\\n  \\}/);
    assert(m, '未找到 TERMINAL_TYPES.claude 定义');
    const seg = m[0];
    assert(/--dangerously-skip-permissions/.test(seg), 'claude 默认参数应含 --dangerously-skip-permissions');
    console.log('OK');
  `], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  out.stdout.on('data', (c) => (stdout += c));
  let stderr = '';
  out.stderr.on('data', (c) => (stderr += c));
  await new Promise((resolve) => out.on('close', resolve));
  assert.match(stdout, /OK/, '静态断言失败: ' + stderr);
});

// 契约层面：fake-claude 收到的 argv 透传链路正常（CLAUDE_ARGS 语义：存在则整体覆盖）。
test('CLAUDE_ARGS 整体覆盖语义不变：fake-claude 收到注入的脚本参数', async () => {
  const pid = await createHostProject(base, base.hostProjectDir);
  const ws_ = await openWS(base);
  const r = await api(base, 'POST', `/api/projects/${pid}/claude-sessions`);
  assert.equal(r.json.ok, true);
  const sid = r.json.sessionId;

  const argvMsg = await ws_.waitFor((m) => m.type === 'claude-output' && m.sessionId === sid && /argv=/.test(m.data), 8000);
  const argv = JSON.parse(argvMsg.data.match(/argv=(\[[^\]]*\])/)[1]);
  assert.ok(argv.includes(FAKE_CLAUDE), 'fake-claude 应通过 argv 收到注入的脚本路径: ' + JSON.stringify(argv));
  assert.ok(!argv.includes('--dangerously-skip-permissions'), '设了 CLAUDE_ARGS 时默认参数被整体覆盖，不应出现');

  ws_.ws.close();
});
