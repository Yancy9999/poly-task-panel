// 文件编辑器多 tab 跨项目同名文件不覆盖（jsdom）
// 回归：tab key 由 sub 改为 projectId/sub 复合键——此前跨项目同路径文件共用一个 key，
// 后开的 tab 直接覆盖先开的（未保存内容无确认丢失）。
// 覆盖：双项目各开同名文件 → 两个 tab 共存；同名 tab 显示名带项目/目录区分；
// 切换激活不丢 tab；关闭其中一个不影响另一个；tab 悬浮提示含项目名。
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

// 提取最后一个无 src 的内联 <script> 内容，追加内部状态的测试出口
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
if (!scripts.length) throw new Error('未找到内联脚本');
const inlineScript = scripts[scripts.length - 1][1] + '\nwindow.__fv = () => ({ tabs: fvTabs, active: fvActiveSub });';

const dom = new JSDOM(html, {
  url: 'http://localhost:7777/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;

// --- stubs：网络 / 终端 / WS / Pointer API（jsdom 未实现）---
const fakeProjects = [
  { id: 'p1', name: 'Alpha', type: 'node', running: false, projectPath: 'D:/a' },
  { id: 'p2', name: 'Beta', type: 'node', running: false, projectPath: 'D:/b' },
];
window.fetch = async (url) => {
  const u = String(url);
  let body;
  if (u === '/api/projects') body = fakeProjects;
  else if (u.includes('/git/status') || u.includes('/svn/status')) body = { ok: false };
  else if (u.includes('/files')) body = { ok: true, items: [] };
  else if (u.includes('/file-content')) body = { ok: true, content: 'hello\n', mtime: 1 };
  else body = { ok: true };
  return { json: async () => body };
};
window.WebSocket = class { constructor() {} send() {} close() {} };
window.Terminal = class {};
window.FitAddon = { FitAddon: class { fit() {} loadAddon() {} } };
window.HTMLElement.prototype.setPointerCapture = function () {};
window.HTMLElement.prototype.releasePointerCapture = function () {};
// jsdom 未实现 innerText：编辑器 stash/撤销栈读写它，代理到 textContent
Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
  get() { return this.textContent; },
  set(v) { this.textContent = v; },
});

window.eval(inlineScript);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, msg) {
  if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; }
  else console.log('PASS: ' + msg);
}

(async () => {
  await wait(20);
  await window.loadProjects();
  const doc = window.document;

  // --- 项目 A 打开 README.md ---
  window.openFileDrawer('p1');
  await window.openFileViewer('README.md');
  assert(window.__fv().tabs.size === 1, '项目 A 打开 README.md 后 1 个 tab');

  // --- 项目 B 打开同名文件：不覆盖 A 的 tab（核心回归）---
  window.openFileDrawer('p2');
  await window.openFileViewer('README.md');
  const { tabs, active } = window.__fv();
  assert(tabs.size === 2, '项目 B 打开同名文件后共 2 个 tab（不覆盖）');
  assert(tabs.has('p1/README.md') && tabs.has('p2/README.md'), 'tab key 为 projectId/sub 复合键');
  assert(active === 'p2/README.md', '后开的 tab 激活');
  assert(tabs.get('p1/README.md').projectId === 'p1' && tabs.get('p1/README.md').sub === 'README.md', 'A 的 tab 数据完整保留');

  // --- tab 栏渲染：两个同名 tab 都可见，显示名带项目名区分 ---
  const tabEls = [...doc.querySelectorAll('#fvTabbar .fv-tab')];
  assert(tabEls.length === 2, 'tab 栏渲染 2 个 tab');
  const labels = tabEls.map((el) => el.querySelector('.fv-tab-name').textContent);
  assert(labels.some((t) => t.includes('Alpha') && t.includes('README.md')), '同名 tab 显示名含项目名 Alpha');
  assert(labels.some((t) => t.includes('Beta') && t.includes('README.md')), '同名 tab 显示名含项目名 Beta');

  // --- 悬浮提示含项目名（全局 tooltip 把 title 改名为 data-tip）---
  await wait(20); // 等 MutationObserver 把 title 改名 data-tip
  const tips = tabEls.map((el) => el.getAttribute('data-tip') || el.getAttribute('title') || '');
  assert(tips.some((t) => t.includes('Alpha / README.md')), 'tab 悬浮提示含项目名前缀（Alpha / README.md）');

  // --- 切回 A 的 tab：B 的 tab 保留 ---
  window.openFileDrawer('p1');
  await window.openFileViewer('README.md');
  assert(window.__fv().active === 'p1/README.md', '切回项目 A 同名文件激活 A 的 tab');
  assert(window.__fv().tabs.size === 2, '切回后 B 的 tab 仍在');
  const title = doc.getElementById('fileViewTitle').textContent;
  assert(title.includes('Alpha'), '窗口标题显示当前项目名 Alpha');

  // --- 关闭 A 的 tab：B 的 tab 不受影响 ---
  await window.closeFvTab('p1/README.md');
  assert(window.__fv().tabs.size === 1, '关闭 A 的 tab 后剩 1 个');
  assert(window.__fv().tabs.has('p2/README.md'), 'B 的 tab 保留');
  assert(window.__fv().active === 'p2/README.md', '关闭后自动切到 B 的 tab');

  // --- 同项目内不同目录的同名文件：显示名加父目录名区分（不加项目名前缀）---
  await window.openFileViewer('a/config.json');
  await window.openFileViewer('b/config.json');
  await wait(20);
  const labels2 = [...doc.querySelectorAll('#fvTabbar .fv-tab .fv-tab-name')].map((el) => el.textContent);
  assert(labels2.some((t) => t === 'a / config.json'), '同项目多目录同名 tab 显示父目录名（a / config.json）');
  assert(labels2.some((t) => t === 'b / config.json'), '同项目多目录同名 tab 显示父目录名（b / config.json）');
  assert(labels2.some((t) => t === 'README.md'), '无同名冲突的 tab 保持只显示文件名');

  console.log(process.exitCode ? '\n有失败项' : '\n全部通过');
})();
