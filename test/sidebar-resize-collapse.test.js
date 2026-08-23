// 侧栏拖拽调宽 + 折叠功能的 DOM 级验证（jsdom）
// 加载真实 index.html 的 DOM，stub 掉网络/终端，eval 内联脚本后断言行为。
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

// 提取最后一个无 src 的内联 <script> 内容
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
if (!scripts.length) throw new Error('未找到内联脚本');
const inlineScript = scripts[scripts.length - 1][1] + '\nwindow.__termSessions = termSessions; window.__getPanes = () => panes;';

const dom = new JSDOM(html, {
  url: 'http://localhost:7777/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;

// --- stubs：网络 / 终端 / WS / Pointer API（jsdom 未实现）---
// fetch 可变：先返回空列表，后续测试覆盖带项目列表的 renderList
let fakeProjects = [];
window.fetch = async () => ({ json: async () => fakeProjects });
window.WebSocket = class { constructor() {} send() {} close() {} };
window.Terminal = class {};
window.FitAddon = { FitAddon: class { fit() {} loadAddon() {} } };
window.HTMLElement.prototype.setPointerCapture = function () {};
window.HTMLElement.prototype.releasePointerCapture = function () {};

// --- 注入页面 body 内容（jsdom 从 html 构造后 body 已含真实节点，无需再注入）---
window.eval(inlineScript);

// 等 loadProjects 的 fetch 落地（空项目列表）
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// jsdom 无 PointerEvent，用 MouseEvent 模拟（代码只用到 clientX / preventDefault / pointerId）
const fire = (el, type, init) =>
  el.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, ...init }));

function assert(cond, msg) {
  if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; }
  else console.log('PASS: ' + msg);
}

(async () => {
  await wait(20);

  const doc = window.document;
  const sb = doc.getElementById('sidebar');
  const resizer = doc.getElementById('sidebarResizer');
  const collapseBtn = doc.getElementById('collapseBtn');

  assert(!!sb, '存在 #sidebar');
  assert(!!resizer, '存在 #sidebarResizer（分隔条）');
  assert(!!collapseBtn, '存在 #collapseBtn（折叠按钮）');
  assert(sb.style.width === '280px', '初始宽度 280px（默认）');

  // --- 取字规则 ---
  assert(window.projectIconText('裕租后台') === '裕', '中文名首字符「裕租后台」→ 裕');
  assert(window.projectIconText('My Backend') === 'MB', '多单词「My Backend」→ MB');
  assert(window.projectIconText('TAC') === 'TA', '单单词「TAC」→ TA');
  assert(window.projectIconText('') === '?', '空名 → ?');
  assert(window.projectIconText('  Vue Demo  ') === 'VD', '含空白「Vue Demo」→ VD');

  // --- 折叠 ---
  window.toggleSidebar();
  assert(sb.classList.contains('collapsed'), 'toggleSidebar() 后 sidebar 带 collapsed 类');
  assert(sb.style.width === '48px', '折叠态宽度 48px');
  assert(window.localStorage.getItem('sidebarCollapsed') === '1', '折叠态已持久化 localStorage');

  // --- 折叠态禁止拖拽（pointerdown 应被忽略）---
  fire(resizer, 'pointerdown', { clientX: 300, pointerId: 1 });
  assert(!sb.classList.contains('dragging'), '折叠态 pointerdown 不进入拖拽（dragging 类未加）');

  // --- 展开恢复记忆宽度 ---
  window.toggleSidebar();
  assert(!sb.classList.contains('collapsed'), '再次 toggle 恢复展开');
  assert(sb.style.width === '280px', '展开恢复记忆宽度 280px');
  assert(window.localStorage.getItem('sidebarCollapsed') === '0', '展开态已持久化');

  // --- 拖拽调宽 ---
  sb.style.width = '280px';
  fire(resizer, 'pointerdown', { clientX: 280, pointerId: 2 });
  assert(sb.classList.contains('dragging'), '拖拽开始加 dragging 类');
  fire(resizer, 'pointermove', { clientX: 400, pointerId: 2 });
  assert(sb.style.width === '400px', '右移 120px → 宽度 400px');
  fire(resizer, 'pointermove', { clientX: 50, pointerId: 2 });
  assert(sb.style.width === '180px', '左移超界 → clamp 到最小 180px');
  fire(resizer, 'pointermove', { clientX: 2000, pointerId: 2 });
  assert(sb.style.width === '480px', '右移超界 → clamp 到最大 480px');
  fire(resizer, 'pointerup', { clientX: 2000, pointerId: 2 });
  assert(!sb.classList.contains('dragging'), '拖拽结束移除 dragging 类');
  assert(window.localStorage.getItem('sidebarWidth') === '480', '拖拽宽度已持久化 480');
  assert(sb.style.width === '480px', '结束后宽度保持 480px');

  // --- 折叠后展开恢复记忆的 480 而非默认 ---
  window.toggleSidebar();
  assert(sb.style.width === '48px', '再次折叠 48px');
  window.toggleSidebar();
  assert(sb.style.width === '480px', '展开后恢复记忆的 480px');

  // --- 取字规则混排场景：首字符非中文时取前两词首字母 ---
  assert(window.projectIconText('TAC 项目') === 'T项', '混排「TAC 项目」→ T项');

  // --- 带项目列表时 renderList 生成折叠态头像 ---
  fakeProjects = [
    { id: 'p1', name: '裕租后台', type: 'node', running: true, pid: 123, projectPath: 'D:/yz' },
    { id: 'p2', name: 'My Backend', type: 'springboot', running: false, projectPath: 'D:/be' },
  ];
  await window.loadProjects();
  // 展开态：avatar 节点存在但行文本也在
  let listHtml = doc.getElementById('sidebarList').innerHTML;
  assert(listHtml.includes('class="avatar"'), '展开态渲染 avatar 节点');
  assert(listHtml.includes('>裕租后台<'), '展开态渲染项目名文本');
  assert(listHtml.includes('新建 Claude'), '展开态保留新建 Claude 按钮');
  // 合并：会话区块应为项目卡片内部子区域（非独立兄弟节点）
  const firstCard = doc.querySelector('#sidebarList .project-item');
  const termBlock = firstCard && firstCard.querySelector(':scope > .term-block');
  assert(!!termBlock, '会话区块已合并进项目卡片内部');
  assert(!!termBlock.querySelector('.term-new-row'), '卡片内含新建会话按钮');
  // 注入一个会话，验证会话二级菜单也渲染在卡片内
  window.__termSessions.set('c_1', { projectId: 'p1', sessionNumber: 1, type: 'claude' });
  window.renderList();
  const subItem = doc.querySelector('#sidebarList .project-item .term-block .sub-menu-item');
  assert(!!subItem, '卡片内含会话二级菜单项（有会话时）');
  assert(subItem.textContent.includes('Claude Code #1'), '会话项文案渲染在卡片内');
  // 折叠态：项目卡片 title 显示完整名，avatar 取字正确
  window.toggleSidebar();
  await wait(0);
  listHtml = doc.getElementById('sidebarList').innerHTML;
  assert(listHtml.includes('title="裕租后台"'), '折叠态项目卡片带 title（完整名）');
  assert(listHtml.includes('>裕<') && listHtml.includes('>MB<'), '折叠态头像取字 裕 / MB');
  assert(listHtml.includes('class="dot running"'), '运行中项目头像带运行绿点');
  window.toggleSidebar();

  // --- 回归：会话二级菜单高亮跟随终端激活栏；查日志（抽屉）不影响终端激活栏 ---
  // 新架构：日志进抽屉（logPanes），终端会话栏（panes）独立。会话高亮绑定终端激活栏。
  window.__termSessions.set('c_1', {
    projectId: 'p1', sessionNumber: 1, type: 'claude',
    host: doc.createElement('div'), term: { cols: 80, rows: 24, write() {}, focus() {} }, fit: { fit() {} },
  });
  window.renderList();
  const p1Card = () => [...doc.querySelectorAll('#sidebarList .project-item')].find(el => el.querySelector('.name')?.textContent === '裕租后台');
  const c1Item = () => [...p1Card().querySelectorAll('.sub-menu-item')].find(el => el.textContent.includes('Claude Code #1'));

  // 激活 p1 的 claude#1（显示到终端激活栏）
  window.selectView('p1', 'c_1');
  await wait(30);
  assert(!!c1Item() && c1Item().classList.contains('active'), '激活 p1 claude#1 后二级菜单项高亮');
  assert(window.activePane().view === 'c_1', '终端激活栏为 c_1');

  // 查 p1 日志 → 抽屉打开、日志进 logPanes；终端激活栏仍为 c_1，高亮保留
  await window.selectProject('p1');
  assert(window.activePane().view === 'c_1', '查日志后终端激活栏不变（日志在抽屉）');
  assert(!!c1Item() && c1Item().classList.contains('active'), '查日志后 claude#1 高亮保留（终端栏未变）');

  // 终端激活栏切到空栏 → c_1 不再显示 → 高亮清除
  let emptyPane = window.__getPanes().find(p => p.view === 'empty');
  if (!emptyPane) {
    window.__getPanes().push({ id: 'pe', projectId: null, view: 'empty' });
    emptyPane = window.__getPanes()[window.__getPanes().length - 1];
  }
  window.activatePane('term', emptyPane.id);
  assert(!c1Item().classList.contains('active'), '终端激活栏切走后 claude#1 高亮清除（回归）');


  console.log('\n侧栏折叠/拖拽 jsdom 验证完成');
})().catch((e) => { console.error('TEST ERROR:', e); process.exitCode = 1; });
