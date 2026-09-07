// 项目卡片激活联动 + 日志抽屉彻底解耦（jsdom DOM 级验证）
// 需求：
//   1. 折叠卡片点击（展开按钮以外区域）→ 只激活不展开；点展开按钮 → 仅展开不激活
//   2. 展开卡片点击 → 激活项目：终端分栏有该项目窗口 → 激活第一个；已激活 → 不变；
//      没有 → 终端分栏全部取消激活（栏内容保留，仅卡片竖线亮）
//   3. 激活竖线：.project-item.active 左缘橙色竖线 CSS 存在
//   4. 日志抽屉彻底纯显示：不渲染激活态、点击无反应、布局不持久化 active、
//      showProjectLog / 运行状态按钮不改 currentId
//   5. 第一排按钮（启动/停止/重启/查看命令/编辑/删除）与折叠按钮不激活；
//      第二排按钮（文件/版本管理/shell/会话类）激活项目
//   6. 激活项目时未固定的展开日志抽屉跟随收起；固定（pinned）时不收起
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
  + 'window.__getActive = () => activePaneId; window.__setActive = (id) => activePaneId = id;'
  + 'window.__logDrawerOpen = () => logDrawerOpen;';

const dom = new JSDOM(html, { url: 'http://localhost:7777/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;

let fakeProjects = [];
window.fetch = async (url) => {
  const u = String(url);
  if (/\/(claude|codex|cmd|gitbash|pi)-sessions/.test(u)) return { json: async () => ({ ok: true, sessions: [] }) };
  if (u === '/api/projects') return { json: async () => fakeProjects };
  if (u.includes('/logs')) return { json: async () => ({ ok: true, entries: [] }) };
  return { json: async () => ({ ok: true }) };
};
window.WebSocket = class { constructor() {} send() {} close() {} };
window.Terminal = class {};
window.FitAddon = { FitAddon: class { fit() {} loadAddon() {} } };
window.HTMLElement.prototype.setPointerCapture = function () {};
window.HTMLElement.prototype.releasePointerCapture = function () {};
window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
window.showToast = () => {};

window.eval(inlineScript);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// jsdom runScripts:'outside-only' 不执行内联 onclick 属性：读取属性后经 window.eval
// 在页面全局作用域编译执行（模拟浏览器内联处理器语义），this 绑定为元素本身。
// 元素自身无 onclick 时向上找最近带 onclick 的祖先编译执行（模拟事件冒泡到内联处理器）。
const click = (el) => {
  const t = el.closest('[onclick]') || (el.getAttribute('onclick') ? el : null);
  const attr = t && t.getAttribute('onclick');
  if (attr) {
    const fn = window.eval(`(function (event) { ${attr} })`);
    fn.call(t, { button: 0, clientX: 0, clientY: 0, stopPropagation() {}, preventDefault() {} });
  } else {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  }
};

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

  fakeProjects.push({ id: 'pa', name: '项目A', type: 'springboot', projectPath: 'x', running: false });
  fakeProjects.push({ id: 'pb', name: '项目B', type: 'node', projectPath: 'y', running: false });
  await window.loadProjects();
  window.__termSessions.set('c_1', { projectId: 'pa', sessionNumber: 1, type: 'claude' });

  // 终端分栏：tp1 显示 pa 的 c_1，tp2 空栏；激活 tp1
  P().length = 0;
  P().push({ id: 'tp1', projectId: 'pa', view: 'c_1' });
  P().push({ id: 'tp2', projectId: null, view: 'empty' });
  window.__setActive('tp1');
  window.renderPanes();
  window.renderList();

  const card = (id) => doc.querySelector(`#sidebarList .project-item[data-project-id="${id}"]`);
  // currentId 是内联脚本作用域 let（不在 window 上），经 getter 间接断言
  const getCurrentId = () => doc.querySelector('#sidebarList .project-item.active')?.dataset.projectId || null;

  // --- 基线 ---
  assert(getCurrentId() === null, '初始 currentId 为空');

  // --- 1. 展开卡片点击：终端无该项目窗口 → 全部分栏取消激活，仅卡片亮 ---
  click(card('pb'));
  assert(getCurrentId() === 'pb', '点击项目B卡片 → currentId=pb');
  assert(window.__getActive() === null, '终端无 pb 窗口 → 全部分栏取消激活');
  assert(doc.querySelectorAll('#consoleBody .pane.active').length === 0, '终端分栏无激活高亮');
  assert(card('pb').classList.contains('active'), '项目B卡片带 active 竖线标记');
  assert(!card('pa').classList.contains('active'), '项目A卡片无 active 标记');

  // --- 2. 终端有该项目窗口 → 激活第一个 ---
  window.__setActive('tp2'); // 先切到空栏（pa 处于未激活态）
  window.renderPanes();
  click(card('pa'));
  assert(window.__getActive() === 'tp1', 'pa 未激活时点击卡片 → 激活第一个 pa 窗口 tp1');
  assert(getCurrentId() === 'pa', 'currentId 同步为 pa');
  assert(doc.querySelector('#consoleBody .pane.active')?.dataset.paneId === 'tp1', 'tp1 栏高亮');

  // --- 2b. 已激活该项目 → 不变 ---
  click(card('pa'));
  assert(window.__getActive() === 'tp1', '已激活 tp1 再点击卡片 → 不变');

  // --- 3. 日志抽屉彻底纯显示 ---
  click(card('pb')); // 基线：currentId=pb、分栏全取消激活
  const beforeId = getCurrentId();
  await window.showProjectLog('pa');
  await wait(10);
  assert(getCurrentId() === beforeId, 'showProjectLog 不改 currentId');
  assert(LP().some(p => p.view === 'log' && p.projectId === 'pa'), '日志栏已建立');
  assert(doc.querySelectorAll('#logConsoleBody .pane.active').length === 0, '日志分栏无激活态');
  const logPaneEl = doc.querySelector('#logConsoleBody .pane[data-pane-kind="log"]');
  assert(!!logPaneEl && !logPaneEl.getAttribute('onclick'), '日志栏不绑定点击激活');
  click(logPaneEl);
  assert(getCurrentId() === beforeId, '点击日志栏不改 currentId/激活');
  window.renderLogPanes();
  assert(doc.querySelectorAll('#logConsoleBody .pane.active').length === 0, 'renderLogPanes 不渲染激活类');
  window.persistLogPanes();
  const savedLog = JSON.parse(window.localStorage.getItem('logPaneLayout'));
  assert(savedLog && !('active' in savedLog), '日志布局不持久化 active 字段');

  // --- 4. 运行状态按钮 / 第一排按钮 / 折叠按钮不激活 ---
  click(card('pa')); // currentId=pa
  click(card('pb')); // currentId=pb
  click(card('pa').querySelector('.project-actions .start'));
  assert(getCurrentId() === 'pb', '点击第一排「启动」按钮不激活 pa');
  await window.selectProject('pa'); // 运行状态按钮同款路径（查日志）
  await wait(10);
  assert(getCurrentId() === 'pb', '点击运行状态按钮（查日志）不激活 pa');
  click(card('pa').querySelector('.collapse-item-btn'));
  assert(getCurrentId() === 'pb', '点击折叠按钮不激活');

  // --- 5. 折叠卡片：点展开按钮仅展开；点卡片其他区域只激活、不展开 ---
  assert(card('pa').classList.contains('collapsed'), 'pa 已折叠');
  click(card('pa').querySelector('.collapse-item-btn')); // 折叠态再点 → 展开
  assert(!card('pa').classList.contains('collapsed'), '点展开按钮 → 卡片展开');
  assert(getCurrentId() === 'pb', '点展开按钮不激活项目');
  window.toggleProjectCollapsed('pa'); // 重新折叠
  click(card('pa'));
  assert(card('pa').classList.contains('collapsed'), '点折叠卡片（其他区域）→ 保持折叠');
  assert(getCurrentId() === 'pa', '点折叠卡片 → 激活项目');

  // --- 6. 第二排按钮激活项目 ---
  const actCalls = [];
  const origActivate = window.activateProject;
  const origOpenFileDrawer = window.openFileDrawer;
  const origOpenGitDrawer = window.openGitDrawer;
  const origNewTermSession = window.newTermSession;
  window.activateProject = (id) => { actCalls.push(id); origActivate(id); };
  window.openFileDrawer = () => {};
  window.openGitDrawer = () => {};
  window.newTermSession = () => {};
  click(card('pa').querySelector('.term-new-row button[data-project-id="pa"]')); // 文件目录按钮
  click(card('pa').querySelector('.term-new-row button[title^="版本管理"]'));
  click(card('pa').querySelector('#shellBtn-pa'));
  assert(JSON.stringify(actCalls) === JSON.stringify(['pa', 'pa', 'pa']), '第二排按钮（文件/版本/shell）激活项目');
  // term-block 空白区（非按钮/条目）点击冒泡到卡片 → 激活一次
  actCalls.length = 0;
  click(card('pa').querySelector('.term-block'));
  assert(JSON.stringify(actCalls) === JSON.stringify(['pa']), 'term-block 空白区点击冒泡到卡片激活');
  window.activateProject = origActivate;
  window.openFileDrawer = origOpenFileDrawer;
  window.openGitDrawer = origOpenGitDrawer;
  window.newTermSession = origNewTermSession;

  // --- 7. 激活竖线 CSS 存在 ---
  const cssText = [...doc.querySelectorAll('style')].map(s => s.textContent).join('\n');
  assert(/\.project-item\.active[^{]*::before\s*\{[^}]*#ff8f1f/.test(cssText), '存在激活竖线样式（.project-item.active::before 橙色）');

  // --- 8. 抽屉跟随收起（未固定）/ 保持展开（固定）---
  window.closeLogDrawer();
  window.openLogDrawer();
  assert(window.__logDrawerOpen() === true, '日志抽屉已展开（未固定）');
  window.activateProject('pb');
  assert(window.__logDrawerOpen() === false, '激活项目（未固定）→ 抽屉跟随收起');
  window.toggleLogDrawerPin();
  window.openLogDrawer();
  window.activateProject('pa');
  assert(window.__logDrawerOpen() === true, '激活项目（固定）→ 抽屉保持展开');

  // --- 9. 文件/Git 抽屉展开时跟随卡片激活的项目（该项目无终端窗口也跟随） ---
  window.toggleSidePanel('file');
  window.openFileDrawer('pb');
  assert(doc.getElementById('fileDrawerTitle').textContent.includes('项目B'), '文件抽屉先绑定 pb');
  window.activateProject('pa'); // pa 无终端窗口 → 激活栏为 null
  assert(doc.getElementById('fileDrawerTitle').textContent.includes('项目A'), '卡片激活 pa（无窗口）→ 文件抽屉跟随切到 pa');
  window.toggleSidePanel('git');
  window.openGitDrawer('pb');
  assert(doc.getElementById('gitDrawerTitle').textContent.includes('项目B'), 'Git 抽屉先绑定 pb');
  window.activateProject('pa');
  assert(doc.getElementById('gitDrawerTitle').textContent.includes('项目A'), '卡片激活 pa（无窗口）→ Git 抽屉跟随切到 pa');
  window.toggleSidePanel('file'); // 收起，恢复默认面板态

  // --- 10. 抽屉关闭时激活 → 活动栏打开抽屉（无参调用）跟随激活项目 ---
  // 修复前：无参回退链只看激活栏（卡片激活无窗口项目时为 null）→ 落到共享指针（上次项目）
  window.closeFileDrawer();
  window.activateProject('pa'); // 抽屉关闭态激活（pa 无终端窗口）
  window.openFileDrawer(); // 活动栏文件按钮：无参
  assert(doc.getElementById('fileDrawerTitle').textContent.includes('项目A'), '抽屉关闭态激活 pa → 活动栏打开文件抽屉显示 pa');
  window.closeFileDrawer();
  window.activateProject('pb');
  window.openGitDrawer(); // 活动栏 Git 按钮：无参
  assert(doc.getElementById('gitDrawerTitle').textContent.includes('项目B'), '抽屉关闭态激活 pb → 活动栏打开 Git 抽屉显示 pb');
  window.closeGitDrawer();

  // --- 11. 点击已激活的终端栏 / 已激活项目卡片 → 抽屉同步仍执行（早退分支，与 activateProject alreadyActive 同语义） ---
  P().length = 0;
  P().push({ id: 'tp1', projectId: 'pa', view: 'c_1' });
  P().push({ id: 'tp2', projectId: 'pb', view: 'c_2' });
  window.__termSessions.set('c_2', { projectId: 'pb', sessionNumber: 2, type: 'claude' });
  window.activateProject('pa'); // 真实路径建立状态：激活 tp1 + currentId=pa
  assert(window.__getActive() === 'tp1', '11 前置：pa 卡片激活 tp1');
  window.openFileDrawer('pb'); // 直调绑定（抽屉与 currentId 脱钩）
  window.activatePane('term', 'tp1'); // 已激活栏再点击（早退分支）
  assert(doc.getElementById('fileDrawerTitle').textContent.includes('项目A'), '已激活栏再点击 → 文件抽屉同步回 currentId 项目');
  window.activateProject('pb'); // 激活 tp2 + currentId=pb
  window.openFileDrawer('pa'); // 反向：抽屉脱钩到 pa
  window.activateProject('pb'); // tp2 已激活 → alreadyActive 分支
  assert(doc.getElementById('fileDrawerTitle').textContent.includes('项目B'), '卡片点已激活项目 → 文件抽屉同步回 pb');
  window.closeFileDrawer();

  console.log(fails ? `\n${fails} FAIL` : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
