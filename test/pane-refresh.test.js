// 分栏切换后 xterm 需全量重绘：renderPanes/fitAndResize 在 fit 之后必须调 term.refresh(0, rows-1)。
// 背景：xterm 6.0 默认 DOM 渲染器不感知 .term-host 跨栏搬移，fit 只改 cols/rows 不重绘，
// 导致多栏来回切换后文字错位（cols 与视觉宽度错开）、滚动后旧渲染行残留（鬼影）。
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
const inlineScript = scripts[scripts.length - 1][1] +
  '\nwindow.__panes = panes; window.__termSessions = termSessions;' +
  '\nwindow.__setProjects = (v) => { projects = v; };' +
  '\nwindow.__setActive = (id) => { activePaneId = id; };' +
  '\nwindow.__fitAndResize = fitAndResize;';

const dom = new JSDOM(html, { url: 'http://localhost:7777/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;

window.fetch = async () => ({ json: async () => [] });
window.WebSocket = class { constructor() {} send() {} close() {} };
// Terminal stub：refresh(cols 起始行, 结束行) 记录调用，供断言 fit 后被触发。
window.Terminal = class {
  constructor() {
    this.rows = 24;
    this.refreshCalls = [];
    this.textarea = { addEventListener() {} };
  }
  refresh(start, end) { this.refreshCalls.push([start, end]); }
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
  await wait(20);

  window.__setProjects([{ id: 'A', name: 'demo', type: 'claude', projectPath: 'x' }]);

  // 造两个会话、两栏各显示一个
  const mkSession = (sid) => {
    const host = window.document.createElement('div');
    window.document.getElementById('xtermWrap').appendChild(host);
    const term = new window.Terminal();
    term.open(host);
    const fit = new window.FitAddon.FitAddon();
    window.__termSessions.set(sid, { term, fit, projectId: 'A', type: 'claude', host });
  };
  mkSession('c_1'); mkSession('c_2');
  const P = window.__panes;
  P.length = 0;
  P.push({ id: 'p1', projectId: 'A', view: 'c_1' });
  P.push({ id: 'p2', projectId: 'A', view: 'c_2' });
  window.__setActive('p1');

  // --- 1. renderPanes 后：所有显示中的会话都被 refresh(0, rows-1) 全量重绘 ---
  window.document.getElementById('consoleBody').innerHTML = '';
  window.renderPanes();
  await wait(10); // rAF 已被 stub 为 setTimeout 0
  const t1 = window.__termSessions.get('c_1').term;
  const t2 = window.__termSessions.get('c_2').term;
  assert(
    t1.refreshCalls.some(([s, e]) => s === 0 && e === t1.rows - 1),
    'renderPanes 后会话1 refresh(0, rows-1) 被调用'
  );
  assert(
    t2.refreshCalls.some(([s, e]) => s === 0 && e === t2.rows - 1),
    'renderPanes 后会话2（非激活栏）refresh(0, rows-1) 被调用'
  );

  // --- 2. fitAndResize 后同样触发 refresh ---
  t1.refreshCalls.length = 0; t2.refreshCalls.length = 0;
  window.__fitAndResize();
  await wait(10);
  assert(
    t1.refreshCalls.some(([s, e]) => s === 0 && e === t1.rows - 1) &&
    t2.refreshCalls.some(([s, e]) => s === 0 && e === t2.rows - 1),
    'fitAndResize 后两个显示中的会话均 refresh(0, rows-1)'
  );

  // --- 3. 空白栏不触发 refresh（无会话） ---
  t1.refreshCalls.length = 0; t2.refreshCalls.length = 0;
  P.length = 0;
  P.push({ id: 'p3', projectId: null, view: 'empty' });
  window.__setActive('p3');
  window.renderPanes();
  await wait(10);
  assert(
    t1.refreshCalls.length === 0 && t2.refreshCalls.length === 0,
    '空白栏不触发任何 refresh'
  );

  console.log(fails ? `\n${fails} failed` : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
