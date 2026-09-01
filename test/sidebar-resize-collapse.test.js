// 左侧固定抽屉（活动栏 + 项目/文件/Git 三面板）的 DOM 级验证（jsdom）
// 加载真实 index.html 的 DOM，stub 掉网络/终端，eval 内联脚本后断言行为。
// 覆盖：面板开关/互斥/收起、拖拽调宽与持久化、文件/Git 面板恢复持久化项目。
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
  const drawer = doc.getElementById('sideDrawer');
  const resizer = doc.getElementById('sideDrawerResizer');
  const bar = doc.querySelector('.activity-bar');

  assert(!!drawer, '存在 #sideDrawer（左侧固定抽屉容器）');
  assert(!!resizer, '存在 #sideDrawerResizer（调宽分隔条）');
  assert(!!bar, '存在活动栏 .activity-bar');
  assert(!!doc.getElementById('activityProjectBtn'), '活动栏含项目按钮');
  assert(!!doc.getElementById('activityFileBtn'), '活动栏含文件按钮');
  assert(!!doc.getElementById('activityGitBtn'), '活动栏含 Git 按钮');
  assert(!!bar.querySelector('.gear-btn'), '活动栏底部含设置齿轮按钮');
  assert(!!doc.getElementById('panelProject'), '存在项目面板 #panelProject');
  assert(!!doc.getElementById('panelFile'), '存在文件面板 #panelFile');
  assert(!!doc.getElementById('panelGit'), '存在 Git 面板 #panelGit');
  assert(!drawer.classList.contains('open'), '无持久化面板时抽屉默认收起');
  assert(drawer.style.width === '280px', '抽屉初始宽度 280px（默认）');

  // --- 项目面板开关 ---
  window.toggleSidePanel('project');
  assert(drawer.classList.contains('open'), 'toggleSidePanel("project") 后抽屉展开');
  assert(doc.getElementById('panelProject').style.display === 'flex', '项目面板显示');
  assert(doc.getElementById('panelFile').style.display === 'none', '文件面板隐藏');
  assert(doc.getElementById('panelGit').style.display === 'none', 'Git 面板隐藏');
  assert(doc.getElementById('activityProjectBtn').classList.contains('active'), '项目按钮高亮');
  assert(window.localStorage.getItem('sideDrawerPanel') === 'project', '面板选择已持久化');

  // --- 三面板互斥 ---
  window.toggleSidePanel('file');
  assert(doc.getElementById('panelProject').style.display === 'none', '切文件面板后项目面板隐藏');
  assert(doc.getElementById('panelFile').style.display === 'flex', '文件面板显示');
  assert(doc.getElementById('activityFileBtn').classList.contains('active'), '文件按钮高亮');
  assert(doc.getElementById('activityProjectBtn').classList.contains('active') === false, '项目按钮取消高亮');

  window.toggleSidePanel('git');
  assert(doc.getElementById('panelFile').style.display === 'none', '切 Git 面板后文件面板隐藏');
  assert(doc.getElementById('panelGit').style.display === 'flex', 'Git 面板显示');
  assert(window.localStorage.getItem('sideDrawerPanel') === 'git', '面板选择更新为 git');

  // --- 再点激活按钮收起整个抽屉 ---
  window.toggleSidePanel('git');
  assert(!drawer.classList.contains('open'), '再点激活按钮后抽屉收起');
  assert(window.localStorage.getItem('sideDrawerPanel') === null, '收起后清除持久化面板选择');

  // --- 拖拽调宽（展开态）---
  window.toggleSidePanel('project');
  drawer.style.width = '280px';
  fire(resizer, 'pointerdown', { clientX: 280, pointerId: 2 });
  assert(drawer.classList.contains('dragging'), '拖拽开始加 dragging 类');
  fire(resizer, 'pointermove', { clientX: 400, pointerId: 2 });
  assert(drawer.style.width === '400px', '右移 120px → 宽度 400px');
  fire(resizer, 'pointermove', { clientX: 50, pointerId: 2 });
  assert(drawer.style.width === '180px', '左移超界 → clamp 到最小 180px');
  fire(resizer, 'pointermove', { clientX: 2000, pointerId: 2 });
  assert(drawer.style.width === '1024px', '右移超界 → clamp 到最大 1024px');
  fire(resizer, 'pointerup', { clientX: 2000, pointerId: 2 });
  assert(!drawer.classList.contains('dragging'), '拖拽结束移除 dragging 类');
  assert(window.localStorage.getItem('sideDrawerWidth') === '1024', '拖拽宽度已持久化 1024');
  assert(drawer.style.width === '1024px', '结束后宽度保持 1024px');

  // --- 收起再展开恢复记忆宽度 ---
  window.toggleSidePanel('project');
  assert(!drawer.classList.contains('open'), '再次收起');
  window.toggleSidePanel('project');
  assert(drawer.style.width === '1024px', '展开后恢复记忆的 1024px');

  // --- 文件面板打开绑定项目（带参）+ 恢复持久化项目（无参）---
  fakeProjects = [
    { id: 'p1', name: '裕租后台', type: 'node', running: true, pid: 123, projectPath: 'D:/yz' },
    { id: 'p2', name: 'My Backend', type: 'springboot', running: false, projectPath: 'D:/be' },
  ];
  await window.loadProjects();
  window.openFileDrawer('p1');
  assert(doc.getElementById('panelFile').style.display === 'flex', '带参 openFileDrawer 打开文件面板');
  assert(doc.getElementById('panelGit').style.display === 'none', '文件面板打开时 Git 面板隐藏（互斥）');
  assert(doc.getElementById('fileDrawerTitle').textContent.includes('裕租后台'), '文件面板标题绑定项目名');
  // 无参打开（活动栏）：恢复上次持久化的项目
  window.toggleSidePanel('file'); // 收起
  window.openFileDrawer();
  assert(doc.getElementById('fileDrawerTitle').textContent.includes('裕租后台'), '无参 openFileDrawer 恢复上次项目');

  // --- Git 面板绑定项目 + 互斥 ---
  window.openGitDrawer('p2');
  assert(doc.getElementById('panelGit').style.display === 'flex', 'openGitDrawer 打开 Git 面板');
  assert(doc.getElementById('panelFile').style.display === 'none', 'Git 面板打开时文件面板隐藏（互斥）');
  assert(doc.getElementById('gitDrawerTitle').textContent.includes('My Backend'), 'Git 面板标题绑定项目名');

  // --- 项目卡片渲染（新面板内）---
  const listHtml = doc.getElementById('sidebarList').innerHTML;
  assert(listHtml.includes('>裕租后台<'), '项目面板渲染项目名文本');
  assert(listHtml.includes('新建 claude 会话'), '项目卡片保留新建 claude 会话按钮');
  const firstCard = doc.querySelector('#sidebarList .project-item');
  const termBlock = firstCard && firstCard.querySelector(':scope > .term-block');
  assert(!!termBlock, '会话区块合并进项目卡片内部');
  assert(!doc.getElementById('sidebarList').querySelector('.avatar'), '整体折叠已移除，不再渲染 avatar 节点');

  // --- 回归：会话二级菜单高亮跟随终端激活栏；查日志（抽屉）不影响终端激活栏 ---
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

  console.log('\n左侧固定抽屉 jsdom 验证完成');
})().catch((e) => { console.error('TEST ERROR:', e); process.exitCode = 1; });
