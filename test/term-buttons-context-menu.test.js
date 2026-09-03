// 项目卡片「文件目录 / 命令行」按钮左右键分工的 DOM 级验证（jsdom）。
// 回归背景：
//   1. 文件目录按钮：左键打开文件抽屉不变，右键弹菜单「在资源管理器中打开」。
//   2. 命令行按钮：左键从"弹 shell 选择菜单"改为"直接新建 cmd 会话"，右键才弹
//      cmd / Git Bash 下拉（菜单里保留 cmd 项，与左键等价）。
// 加载真实 index.html 的 DOM，stub 掉网络/终端，eval 内联脚本后断言行为。
// 左键断言取按钮 onclick 属性编译执行（jsdom outside-only 不编译内联属性）；
// 右键菜单直接调入口函数 + 派发菜单项事件验证行为。
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

// 提取最后一个无 src 的内联 <script> 内容
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
if (!scripts.length) throw new Error('未找到内联脚本');
const inlineScript = scripts[scripts.length - 1][1];

const PROJECTS = [
  { id: 'p1', name: 'Node项目', projectPath: 'D:/tmp/p1', type: 'node', running: false },
  { id: 'p2', name: '纯目录', projectPath: 'D:/tmp/p2', type: 'folder' },
];

function boot() {
  const dom = new JSDOM(html, {
    url: 'http://localhost:7777/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // --- stubs：网络 / 终端 / WS（jsdom 未实现）---
  window.__projects = PROJECTS;
  window.fetch = async (url) => {
    const u = String(url);
    if (u === '/api/projects') return { json: async () => window.__projects };
    return { json: async () => ({ ok: true }) };
  };
  window.WebSocket = class { constructor() {} send() {} close() {} };
  window.Terminal = class {};
  window.FitAddon = { FitAddon: class { fit() {} loadAddon() {} } };
  window.HTMLElement.prototype.setPointerCapture = function () {};
  window.HTMLElement.prototype.releasePointerCapture = function () {};

  window.eval(inlineScript);
  return window;
}

// 编译执行按钮的内联 onclick（jsdom outside-only 不编译 HTML 属性事件；
// 用 window.eval 编译才能取到 window 作用域里的函数）
function fireOnclick(window, btn) {
  const fn = window.eval(`(function (event) { ${btn.getAttribute('onclick')} })`);
  fn.call(btn, { stopPropagation() {} });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, msg) {
  if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; }
  else console.log('PASS: ' + msg);
}

(async () => {
  const window = boot();
  await window.loadProjects();
  await wait(20);

  const doc = window.document;

  // 注：全局自绘 tooltip 初始化时把 title 属性改名为 data-tip，选择器用 data-tip
  const fileBtn = (pid) => doc.querySelector(`.project-item[data-project-id="${pid}"] .term-new-row button[data-tip^="文件目录浏览"]`);
  const shellBtn = (pid) => doc.querySelector(`.project-item[data-project-id="${pid}"] .term-new-row button[data-tip^="打开 cmd"]`);

  // --- 结构：两个按钮存在且带右键处理 ---
  assert(!!fileBtn('p1') && !!fileBtn('p2'), '文件目录按钮存在（node/folder 卡片都有）');
  assert(!!shellBtn('p1') && !!shellBtn('p2'), '命令行按钮存在（node/folder 卡片都有）');
  assert((fileBtn('p1').getAttribute('oncontextmenu') || '').includes('showFileBtnContextMenu'), '文件目录按钮右键调 showFileBtnContextMenu');
  assert(fileBtn('p1').getAttribute('data-project-id') === 'p1', '文件目录按钮带 data-project-id');
  assert((shellBtn('p1').getAttribute('oncontextmenu') || '').includes("toggleShellMenu(event, 'p1')"), '命令行按钮右键调 toggleShellMenu');

  // --- 文件目录按钮左键：仍打开文件抽屉 ---
  let opened = [];
  const origOpenFileDrawer = window.openFileDrawer;
  window.openFileDrawer = (pid) => opened.push(pid);
  fireOnclick(window, fileBtn('p1'));
  assert(opened.join() === 'p1', '文件目录按钮左键打开文件抽屉');

  // --- 命令行按钮左键：直接新建 cmd 会话，不再弹菜单 ---
  const created = [];
  const origNewTerm = window.newTermSession;
  window.newTermSession = (pid, type) => created.push([pid, type]);
  fireOnclick(window, shellBtn('p1'));
  assert(created.length === 1 && created[0][0] === 'p1' && created[0][1] === 'cmd', '命令行按钮左键直接新建 cmd 会话');
  assert(!shellBtn('p1').getAttribute('onclick').includes('toggleShellMenu'), '命令行按钮左键不再弹 shell 选择菜单');
  window.newTermSession = origNewTerm;

  // --- 文件目录按钮右键菜单：一项「在资源管理器中打开」→ openExplorer ---
  const explorer = [];
  const origOpenExplorer = window.openExplorer;
  window.openExplorer = (pid) => explorer.push(pid);
  window.showFileBtnContextMenu({
    clientX: 10, clientY: 10,
    currentTarget: { dataset: { projectId: 'p1' } },
  });
  const fbMenu = doc.getElementById('fileBtnContextMenu');
  assert(!!fbMenu && fbMenu.classList.contains('show'), '右键文件目录按钮后菜单显示');
  assert(fbMenu.dataset.projectId === 'p1', '菜单记录项目 id');
  const revealBtn = fbMenu.querySelector('button[data-act="reveal"]');
  assert(!!revealBtn && revealBtn.textContent.includes('在资源管理器中打开'), '菜单含「在资源管理器中打开」项');
  revealBtn.dispatchEvent(new window.Event('mousedown', { bubbles: true }));
  assert(explorer.join() === 'p1', '点菜单项后调用 openExplorer 打开资源管理器');
  assert(!fbMenu.classList.contains('show'), '执行后菜单收起');
  window.openExplorer = origOpenExplorer;

  // --- 命令行按钮右键：弹 cmd / Git Bash 下拉，点选新建对应会话 ---
  const shellCreated = [];
  window.newTermSession = (pid, type) => shellCreated.push([pid, type]);
  window.toggleShellMenu({}, 'p1');
  const shellMenu = doc.getElementById('shellMenu');
  assert(!!shellMenu, '右键命令行按钮后 shell 下拉显示');
  const items = [...shellMenu.querySelectorAll('.term-shell-item')].map((el) => el.dataset.type);
  assert(items.includes('cmd') && items.includes('gitbash'), '下拉仍含 cmd 与 Git Bash 两项');
  shellMenu.querySelector('.term-shell-item[data-type="gitbash"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert(shellCreated.length === 1 && shellCreated[0][0] === 'p1' && shellCreated[0][1] === 'gitbash', '下拉选 Git Bash 新建 gitbash 会话');
  assert(!doc.getElementById('shellMenu'), '选择后下拉收起');
  window.newTermSession = origNewTerm;

  window.openFileDrawer = origOpenFileDrawer;

  console.log(process.exitCode ? '\n有失败项' : '\n全部通过');
})();
