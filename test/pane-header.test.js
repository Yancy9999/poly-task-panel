// pane 标题栏回归：tab 形标题合并 + 日志栏控制按钮（启动/停止/重启）+ 最右分栏图标按钮。
// 架构：日志分栏（logPanes，渲染于 #logConsoleBody）与终端会话分栏（panes，渲染于 #consoleBody）分离。
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

window.eval(inlineScript);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
function assert(cond, msg) {
  if (!cond) { fails++; console.error('FAIL: ' + msg); }
  else console.log('PASS: ' + msg);
}

(async () => {
  await wait(20);
  const doc = window.document;
  const P = () => window.__panes;
  const LP = () => window.__logPanes;

  // --- 1. 顶部独立标题栏已删除 ---
  assert(!doc.querySelector('.console-header'), '不存在 .console-header 独立标题栏');

  // --- 2. 构造状态：终端分栏 3 栏（empty/c_1/x_2），日志分栏 1 栏（A log）+ folder 1 栏 ---
  fakeProjects.push({ id: 'A', name: '裕租后台', type: 'springboot', projectPath: 'x', running: true, pid: 1 });
  fakeProjects.push({ id: 'B', name: 'portal-web', type: 'folder', projectPath: 'y', running: false });
  window.__termSessions.set('c_1', { projectId: 'A', sessionNumber: 1, type: 'claude' });
  window.__termSessions.set('x_2', { projectId: 'A', sessionNumber: 2, type: 'codex' });
  P().length = 0;
  P().push({ id: 'p2', projectId: null, view: 'empty' });
  P().push({ id: 'p3', projectId: 'A', view: 'c_1' });
  P().push({ id: 'p4', projectId: 'A', view: 'x_2' });
  LP().length = 0;
  LP().push({ id: 'l1', projectId: 'A', view: 'log' });
  LP().push({ id: 'l2', projectId: 'B', view: 'log' });
  window.renderPanes();
  window.renderLogPanes();
  await wait(10);

  // --- 3. 终端区渲染 3 栏，日志区渲染 2 栏 ---
  const termPanes = doc.querySelectorAll('#consoleBody .pane');
  const logPanesDom = doc.querySelectorAll('#logConsoleBody .pane');
  assert(termPanes.length === 3, `终端区渲染 3 栏 (got ${termPanes.length})`);
  assert(logPanesDom.length === 2, `日志区渲染 2 栏 (got ${logPanesDom.length})`);

  // --- 4. tab 标题：终端 empty/claude/codex；日志 项目名·日志 ---
  const termTitles = [...termPanes].map(p => p.querySelector('.pane-title').textContent);
  assert(termTitles[0] === '空白', `终端空栏 = 空白 (got "${termTitles[0]}")`);
  assert(termTitles[1] === '裕租后台 · Claude #1', `claude tab = 项目名 · Claude #1 (got "${termTitles[1]}")`);
  assert(termTitles[2] === '裕租后台 · Codex #2', `codex tab = 项目名 · Codex #2 (got "${termTitles[2]}")`);
  const logTitles = [...logPanesDom].map(p => p.querySelector('.pane-title').textContent);
  assert(logTitles[0] === '裕租后台 · 日志', `log tab = 项目名 · 日志 (got "${logTitles[0]}")`);
  assert(logTitles[1] === 'portal-web · 日志', `folder log tab (got "${logTitles[1]}")`);

  // --- 5. 终端栏无日志控制按钮；日志栏有 4 控制按钮（folder 除外） ---
  for (const [id, label] of [['p2', '终端空栏'], ['p3', 'claude 终端栏'], ['p4', 'codex 终端栏']]) {
    const el = doc.querySelector(`#consoleBody .pane[data-pane-id="${id}"]`);
    assert(el.querySelectorAll('.pane-log-controls').length === 0, `${label}无控制按钮`);
  }
  const ctl = logPanesDom[0].querySelectorAll('.pane-log-controls .pane-btn');
  assert(ctl.length === 4, `log 栏有启/停/重/清 4 按钮 (got ${ctl.length})`);
  assert(ctl[0].disabled === true && ctl[1].disabled === false && ctl[2].disabled === false,
    `running 态：start 禁用、stop/restart 可用`);
  assert(logPanesDom[1].querySelectorAll('.pane-log-controls').length === 0, 'folder 日志栏无控制按钮');

  // --- 6. 各区分栏按钮独立：终端区最右栏 p4、日志区最右栏 l2 各一个 ---
  const termSplits = doc.querySelectorAll('#consoleBody .pane-split');
  const logSplits = doc.querySelectorAll('#logConsoleBody .pane-split');
  assert(termSplits.length === 1 && logSplits.length === 1, '终端区/日志区各 1 个分栏按钮');
  assert(termSplits[0].closest('.pane').dataset.paneId === 'p4', '终端区分栏按钮在最右栏 p4');
  assert(logSplits[0].closest('.pane').dataset.paneId === 'l2', '日志区分栏按钮在最右栏 l2');

  // --- 7. updatePaneLogButtons 随 running 变化原地更新（仅日志栏） ---
  fakeProjects.find(x => x.id === 'A').running = false;
  window.updatePaneLogButtons();
  const ctl2 = logPanesDom[0].querySelectorAll('.pane-log-controls .pane-btn');
  assert(ctl2[0].disabled === false && ctl2[1].disabled === true && ctl2[2].disabled === true,
    `停止后：start 可用、stop/restart 禁用`);

  // --- 8. addPane('term')/addPane('log') 各自增栏，互不影响 ---
  window.addPane('term');
  window.addPane('log');
  assert(P().length === 4 && LP().length === 3, 'addPane 按区增栏：终端 4、日志 3');
  // 终端区已满 4，再 addPane('term') 被拦
  window.addPane('term');
  assert(P().length === 4, '终端区满 4 后 addPane 被拦');

  // --- 9. removePane('term', id) 仅影响终端区 ---
  window.removePane('term', 'p4');
  await wait(10);
  assert(P().length === 3 && LP().length === 3, 'removePane(term) 仅终端区减栏');

  // --- 10. 右键菜单 DOM 存在、5 项 ---
  const menu = doc.getElementById('paneContextMenu');
  assert(!!menu, '右键菜单 DOM 存在');
  const items = menu.querySelectorAll('button');
  assert(items.length === 5, `右键菜单 5 项 (got ${items.length})`);
  assert(['close-current','close-left','close-right','close-others','close-all'].every((a,i) => items[i].dataset.act === a), '菜单项 act 顺序');

  // --- 11. 右键终端区 p2（最左，3 栏）：关闭左侧禁用 ---
  window.showPaneContextMenu({ clientX: 10, clientY: 10 }, 'term', 'p2');
  const bs = menu.querySelectorAll('button');
  assert(bs[1].disabled === true, 'p2 关闭左侧禁用（最左）');
  assert(bs[2].disabled === false, 'p2 关闭右侧可用');
  assert(menu.dataset.paneKind === 'term' && menu.dataset.paneId === 'p2', '菜单记录 kind=term + paneId');

  // --- 12. 关闭终端区右侧所有栏 ---
  window.execPaneContextAction('close-right');
  assert(P().length === 1 && P()[0].id === 'p2', '终端区关闭右侧后只剩 p2');
  assert(LP().length === 3, '日志区不受终端区右键关闭影响');

  // --- 13. 单栏时关闭全部：保留唯一栏（转空白兜底） ---
  window.execPaneContextAction('close-all');
  assert(P().length === 1 && P()[0].view === 'empty', '终端区单栏关闭全部：保留唯一栏转空白');

  // --- 14. 单栏时关闭按钮仍显示；removePane(term) 单栏转空白不删栏 ---
  {
    const beforeLen = P().length;
    const singleClose = doc.querySelector(`#consoleBody .pane[data-pane-id="${P()[0].id}"] .pane-close`);
    assert(!!singleClose, '终端区单栏仍显示关闭按钮');
    // 单栏原本是 empty（由第 13 步兜底得到）；先挂个会话再关，验证转空白清理 view
    P()[0].view = 'c_1'; P()[0].projectId = 'A';
    window.renderPanes();
    await wait(10);
    window.removePane('term', P()[0].id);
    await wait(10);
    assert(P().length === beforeLen, '终端区单栏 removePane 不减栏');
    assert(P()[0].view === 'empty' && P()[0].projectId === null, '终端区单栏 removePane 转空白（view=empty, projectId=null）');
  }

  // --- 15. 日志区单栏：关闭按钮显示 + removePane(log) 单栏转空白 ---
  {
    LP().length = 0;
    LP().push({ id: 'l3', projectId: 'A', view: 'log' });
    window.renderLogPanes();
    await wait(10);
    const singleLogClose = doc.querySelector(`#logConsoleBody .pane[data-pane-id="l3"] .pane-close`);
    assert(!!singleLogClose, '日志区单栏仍显示关闭按钮');
    window.removePane('log', 'l3');
    await wait(10);
    assert(LP().length === 1, '日志区单栏 removePane 不减栏');
    assert(LP()[0].view === 'empty' && LP()[0].projectId === null, '日志区单栏 removePane 转空白');
  }

  console.log(fails ? `\n${fails} FAIL` : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})();
