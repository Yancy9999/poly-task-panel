// 验证：日志分栏与终端会话分栏分离后仍可并存（日志在 logPanes、会话在 panes）；
// 同一内容不重复显示；满栏不替换。
// 对应 B 语义：点击视图落空栏，不强占非空栏。
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
const inlineScript = scripts[scripts.length - 1][1]
  + '\nwindow.__termSessions = termSessions;'
  + 'Object.defineProperty(window, "__panes", { get: () => panes, configurable: true });'
  + 'Object.defineProperty(window, "__logPanes", { get: () => logPanes, configurable: true });'
  + 'window.__MAX = MAX_PANES;';

const dom = new JSDOM(html, { url: 'http://localhost:7777/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;

let fakeProjects = [];
window.fetch = async () => ({ json: async () => fakeProjects });
window.WebSocket = class { constructor() {} send() {} close() {} };
window.Terminal = class {};
window.FitAddon = { FitAddon: class { fit() {} loadAddon() {} } };
window.HTMLElement.prototype.setPointerCapture = function () {};
window.HTMLElement.prototype.releasePointerCapture = function () {};
window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
let toastMsg = null;
window.showToast = (msg) => { toastMsg = msg; };
let confirmRet = false;
window.showConfirm = async () => confirmRet;

window.eval(inlineScript);
window.showToast = (msg) => { toastMsg = msg; };
window.showConfirm = async () => confirmRet;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
function assert(cond, msg) {
  if (!cond) { fails++; console.error('FAIL: ' + msg); }
  else console.log('PASS: ' + msg);
}

(async () => {
  await wait(20);
  const P = () => window.__panes;
  const LP = () => window.__logPanes;

  fakeProjects.push({ id: 'A', name: 'demo', type: 'springboot', projectPath: 'x', running: false });
  window.__termSessions.set('c_1', { projectId: 'A', sessionNumber: 1, type: 'claude' });
  window.__termSessions.set('c_2', { projectId: 'A', sessionNumber: 2, type: 'claude' });
  window.__termSessions.set('x_3', { projectId: 'A', sessionNumber: 3, type: 'codex' });
  window.__termSessions.set('c_4', { projectId: 'A', sessionNumber: 4, type: 'claude' });

  // 起点：终端单空白栏 + 日志单空白栏
  P().length = 0; P().push({ id: 'p1', projectId: null, view: 'empty' });
  LP().length = 0; LP().push({ id: 'l1', projectId: null, view: 'empty' });

  // --- 1. 项目A 日志 → 落日志区 l1 ---
  window.showProjectLog('A');
  await wait(10);
  assert(LP().length === 1 && LP()[0].view === 'log' && LP()[0].projectId === 'A', '日志落 l1');
  assert(P().length === 1 && P()[0].view === 'empty', '终端区仍空栏（日志不占终端栏）');

  // --- 2. 点 claude#1 → 终端区空栏 p1 被占用放置，与日志跨区并存 ---
  window.selectView('A', 'c_1');
  await wait(10);
  assert(P().length === 1, '终端区点新会话落空栏 p1（不增栏）');
  assert(P()[0].view === 'c_1' && P()[0].projectId === 'A', 'p1 是 claude#1');
  assert(LP()[0].view === 'log' && LP()[0].projectId === 'A', '日志栏仍在（跨区并存）');

  // --- 3. 再点项目A 日志 → 已有日志栏 l1，激活它，不新建不复制 ---
  const logPaneBefore = LP().find(p => p.view === 'log');
  window.showProjectLog('A');
  await wait(10);
  const logPaneAfter = LP().find(p => p.view === 'log');
  assert(LP().length === 1, '仍 1 日志栏（不复制）');
  assert(logPaneBefore.id === logPaneAfter.id, '日志栏未变（去重命中激活）');

  // --- 4. 连续点新会话自动建栏直到终端区 4 栏满（p1 非空 → 自动建栏）---
  window.selectView('A', 'c_2'); await wait(10); // p2
  window.selectView('A', 'x_3'); await wait(10); // p3
  window.selectView('A', 'c_4'); await wait(10); // p4
  assert(P().length === 4, '终端区 4 栏全满（c_1/c_2/x_3/c_4）');
  const before = P().map(p => p.view).join(',');

  // --- 5. 满栏点已存在视图 → 去重激活，不弹确认 ---
  confirmRet = false;
  window.selectView('A', 'c_1'); await wait(10);
  assert(P().length === 4, '点已存在的 c_1 不增栏');
  assert(before === P().map(p => p.view).join(','), '点已存在视图不替换');

  // --- 6. 满栏点全新视图 + 确认框选「取消」→ 不替换 ---
  confirmRet = false;
  window.displaySession('A', 'c_99'); await wait(10);
  assert(P().length === 4, '满栏点新视图+取消：不增栏');
  assert(before === P().map(p => p.view).join(','), '满栏点新视图+取消：不替换');

  // --- 7. 满栏点全新视图 + 确认框选「确定」→ 覆盖激活栏 ---
  window.activatePane('term', P().find(p => p.view === 'c_1').id);
  confirmRet = true;
  window.displaySession('A', 'c_99'); await wait(10);
  assert(P().length === 4, '满栏点新视图+确定：不增栏（覆盖）');
  assert(!!P().find(p => p.view === 'c_99'), 'c_99 已覆盖到原 c_1 栏');
  assert(!P().find(p => p.view === 'c_1'), '原 c_1 不再显示（被覆盖）');

  // --- 8. 移除一栏腾出空位后，新会话自动落空栏（无确认） ---
  confirmRet = false;
  window.removePane('term', P().find(p => p.view === 'c_99').id);
  await wait(10);
  window.selectView('A', 'x_3'); await wait(10); // x_3 已在他栏 → 去重激活
  assert(!confirmRet, '有空白栏时不弹确认');

  console.log(fails ? `\n${fails} FAIL` : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})();
