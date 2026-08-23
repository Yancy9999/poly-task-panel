// 刷新后重连会话视图：reconnectSessionPanes 按服务端存活状态恢复终端 / 回退空白栏
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
const inlineScript = scripts[scripts.length - 1][1] +
  '\nwindow.__panes = panes; window.__termSessions = termSessions;' +
  '\nwindow.__setProjects = (v) => { projects = v; };' +
  '\nwindow.__setActive = (id) => { activePaneId = id; };';

const dom = new JSDOM(html, { url: 'http://localhost:7777/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;

// 服务端会话注册表 mock：claude-sessions / codex-sessions 路由分别返回存活列表；
// 其余路由（如 /api/projects）返回空数组。
const aliveSessions = { 'claude-sessions': ['c_1'], 'codex-sessions': [] };
window.fetch = async (url) => {
  const u = String(url);
  const route = u.endsWith('/claude-sessions') ? 'claude-sessions'
    : u.endsWith('/codex-sessions') ? 'codex-sessions' : null;
  if (route) {
    return { json: async () => ({
      ok: true,
      sessions: aliveSessions[route].map((sid, i) => ({ sessionId: sid, sessionNumber: i + 1, pid: 1 })),
    }) };
  }
  return { json: async () => [] };
};
window.WebSocket = class { constructor() {} send() {} close() {} };
// 富 Terminal stub：createTerm 会调 loadAddon/open/onData/attachCustomKeyEventHandler；
// renderPanes 的 fit/focus 都在 try/catch 内，缺方法也不抛。
window.Terminal = class {
  loadAddon() {} open() {} onData() {} onTitleChange() {} attachCustomKeyEventHandler() {} dispose() {} focus() {}
};
window.FitAddon = { FitAddon: class { fit() {} loadAddon() {} } };
window.HTMLElement.prototype.setPointerCapture = function () {};
window.HTMLElement.prototype.releasePointerCapture = function () {};
window.requestAnimationFrame = (cb) => setTimeout(cb, 0);

window.eval(inlineScript);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
function assert(cond, msg) {
  if (!cond) { fails++; console.error('FAIL: ' + msg); }
  else console.log('PASS: ' + msg);
}

(async () => {
  await wait(20); // 让 eval 时的 loadProjects() 先跑完（初始单空栏，无重连目标）
  const doc = window.document;
  const P = () => window.__panes;
  const TS = () => window.__termSessions;
  window.__setProjects([{ id: 'A', name: '裕租后台', type: 'springboot', projectPath: 'x', running: true, pid: 1 }]);

  // --- 1. 存活会话：重建 xterm，栏保持终端视图，标题恢复 ---
  P().length = 0;
  P().push({ id: 'p1', projectId: 'A', view: 'log' });
  P().push({ id: 'p2', projectId: 'A', view: 'c_1' });
  window.__setActive('p2');
  await window.reconnectSessionPanes();
  assert(TS().has('c_1'), '存活会话 c_1 已重建 xterm');
  assert(P().find(p => p.id === 'p2').view === 'c_1', '存活会话栏保持终端视图');
  assert(TS().get('c_1').projectId === 'A', '重建会话 projectId 正确');
  assert(TS().get('c_1').type === 'claude', '重建会话类型按 c_ 前缀推断为 claude');
  const title = doc.querySelector('.pane[data-pane-id="p2"] .pane-title').textContent;
  assert(title === '裕租后台 · Claude #1', `重连后 tab 标题 = 项目名 · Claude #1 (got "${title}")`);

  // --- 2. 已死会话（x_9 不在服务端列表）：回退空白栏，清 projectId ---
  P().push({ id: 'p3', projectId: 'A', view: 'x_9' });
  await window.reconnectSessionPanes();
  const p3 = P().find(p => p.id === 'p3');
  assert(p3.view === 'empty' && p3.projectId === null, '死会话栏回退空白（清 projectId）');
  assert(!TS().has('x_9'), '死会话未创建 xterm');

  // --- 3. 项目不存在：回退空白 ---
  P().push({ id: 'p4', projectId: 'GHOST', view: 'c_7' });
  await window.reconnectSessionPanes();
  const p4 = P().find(p => p.id === 'p4');
  assert(p4.view === 'empty' && p4.projectId === null, '项目不存在的会话栏回退空白');

  // --- 4. 无会话栏：直接返回不报错 ---
  P().length = 0;
  P().push({ id: 'p5', projectId: 'A', view: 'log' });
  await window.reconnectSessionPanes();
  assert(true, '无会话栏调用不抛错');

  // --- 5. 重连幂等：c_1 再次重连复用既有 xterm，不新建 ---
  const c1term = TS().get('c_1');
  P().push({ id: 'p6', projectId: 'A', view: 'c_1' });
  await window.reconnectSessionPanes();
  assert(TS().get('c_1') === c1term, '重复重连复用既有 xterm（createTerm 幂等）');

  console.log(fails ? `\n${fails} FAIL` : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})();
