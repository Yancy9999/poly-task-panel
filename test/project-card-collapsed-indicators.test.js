// 项目卡片折叠态标记的 DOM 级验证（jsdom）
// 加载真实 index.html 的 DOM，stub 掉网络/终端，eval 内联脚本后断言渲染结果。
// 覆盖：折叠后运行中绿点（badge 左侧）与有会话打开的橙色卡片；展开态不受影响。
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

// 提取最后一个无 src 的内联 <script> 内容
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
if (!scripts.length) throw new Error('未找到内联脚本');
const inlineScript = scripts[scripts.length - 1][1] + '\nwindow.__termSessions = termSessions;';

const dom = new JSDOM(html, {
  url: 'http://localhost:7777/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;

// --- stubs：网络 / 终端 / WS / Pointer API（jsdom 未实现）---
window.fetch = async () => ({ json: async () => [] });
window.WebSocket = class { constructor() {} send() {} close() {} };
window.Terminal = class {};
window.FitAddon = { FitAddon: class { fit() {} loadAddon() {} } };
window.HTMLElement.prototype.setPointerCapture = function () {};
window.HTMLElement.prototype.releasePointerCapture = function () {};

window.eval(inlineScript);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, msg) {
  if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; }
  else console.log('PASS: ' + msg);
}

(async () => {
  await wait(20);

  const doc = window.document;

  // --- 三个项目：运行中的 node / 停止的 springboot / folder ---
  window.loadProjects && (window.fetch = async () => ({ json: async () => [
    { id: 'p1', name: '运行项目', type: 'node', running: true, pid: 123, projectPath: 'D:/p1' },
    { id: 'p2', name: '停着项目', type: 'springboot', running: false, projectPath: 'D:/p2' },
    { id: 'p3', name: '纯文件夹', type: 'folder', projectPath: 'D:/p3' },
  ] }));
  await window.loadProjects();

  // p1 开一个 claude 会话，p2 开一个 cmd 会话（命令行也算"打开会话"）
  const mkSession = (sid, projectId, type) => ({
    projectId, sessionNumber: 1, type,
    host: doc.createElement('div'), term: { cols: 80, rows: 24, write() {}, focus() {} }, fit: { fit() {} },
  });
  window.__termSessions.set('c_1', mkSession('c_1', 'p1', 'claude'));
  window.__termSessions.set('s_1', mkSession('s_1', 'p2', 'cmd'));
  window.renderList();

  // 全部折叠
  window.collapseAllProjects();

  const card = (id) => doc.querySelector(`#sidebarList .project-item[data-project-id="${id}"]`);
  assert(!!card('p1') && card('p1').classList.contains('collapsed'), 'p1 卡片处于折叠态');

  // --- 折叠态：运行中绿点 ---
  const p1Row = card('p1').querySelector(':scope > .row');
  const p1Dot = p1Row.querySelector('.run-dot');
  assert(!!p1Dot, '折叠 + 运行中：名称行渲染绿点');
  assert(p1Dot.nextElementSibling && p1Dot.nextElementSibling.classList.contains('badge'), '绿点位于类型 badge 左侧');

  // --- 折叠态：有会话打开的橙色卡片 ---
  assert(card('p1').classList.contains('has-sessions'), '折叠 + 有 claude 会话：卡片带 has-sessions 标记');
  assert(card('p2').classList.contains('has-sessions'), '折叠 + 有 cmd 会话：命令行同样算打开会话');

  // --- 未满足条件不显示 ---
  assert(!card('p2').querySelector('.run-dot'), '折叠 + 未运行：不渲染绿点');
  assert(!card('p3').querySelector('.run-dot') && !card('p3').classList.contains('has-sessions'), '折叠 + 无会话无运行：两者都没有');

  // --- CSS 规则存在（绿点样式 / 橙色卡片边框背景）---
  const cssText = [...doc.querySelectorAll('style')].map(s => s.textContent).join('\n');
  // 折叠 + 有会话：样式同未激活会话条目（淡橙边框 rgba(255,143,31,.45) + 深色背景 #1d1f21）
  assert(/\.project-item\.collapsed\.has-sessions\s*\{[^}]*rgba\(255,143,31,\.45\)/.test(cssText), '存在淡橙边框样式规则');
  assert(/\.project-item\.collapsed\.has-sessions\s*\{[^}]*#1d1f21/.test(cssText), '存在深色背景样式规则');
  assert(/\.project-item\.collapsed\.has-sessions\.drag-placeholder\s*\{[^}]*#165dff/.test(cssText), '拖拽占位符样式压过橙色规则');
  assert(/\.project-item \.run-dot\s*\{[^}]*#00b42a/.test(cssText), '存在绿色圆点样式规则');

  // --- 展开态：标记清除 ---
  window.expandAllProjects();
  assert(!card('p1').querySelector('.run-dot'), '展开后不渲染绿点');
  assert(!card('p1').classList.contains('has-sessions'), '展开后卡片不带 has-sessions 标记');

  console.log('\n项目卡片折叠态标记 jsdom 验证完成');
})().catch((e) => { console.error('TEST ERROR:', e); process.exitCode = 1; });
