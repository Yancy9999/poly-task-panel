'use strict';
// 自绘确认框 showConfirm 行为（jsdom）
// 回归背景：
//   1. 旧实现直接覆盖 onclick，并发两个确认框时先到的 Promise 永久挂起（await 卡死）——
//      现实现按调用队列排队，后到的等先到的 close 后再显示。
//   2. opts.third 三按钮（编辑器保存冲突「覆盖磁盘版本」）、okText/cancelText 自定义按钮文字。
// 覆盖：确定/取消/遮罩/关闭按钮的 resolve 值、并发排队次序、三按钮 value、
//       自定义文案、用后恢复默认文案（不残留上一次定制）。
// 时序注意：showConfirm 内部经 confirmChain.then(run) 排队，run 在微任务后才执行——
// 点击前必须等对话框真正显示（waitShown），否则点击落在上一轮已解绑的按钮上被静默丢弃。
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
if (!scripts.length) throw new Error('未找到内联脚本');
const inlineScript = scripts[scripts.length - 1][1] + `
window.__sc = (msg, title, opts) => showConfirm(msg, title, opts);
window.__waitShown = () => new Promise((resolve, reject) => {
  const ov = document.getElementById('confirmOverlay');
  const t0 = Date.now();
  (function poll() {
    if (ov.classList.contains('show') && document.getElementById('confirmMsg').textContent) return resolve();
    if (Date.now() - t0 > 1000) return reject(new Error('dialog not shown in 1s'));
    setTimeout(poll, 5);
  })();
});
`;

const dom = new JSDOM(html, {
  url: 'http://localhost:7777/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;

window.fetch = async (url) => {
  const u = String(url);
  const body = u.includes('/api/projects') ? [] : { ok: true };
  return { json: async () => body };
};
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
  await window.loadProjects();
  const doc = window.document;
  const click = (el) => el.dispatchEvent(new window.Event('click', { bubbles: true }));
  const overlay = () => doc.getElementById('confirmOverlay');

  // --- 基础：确定 true / 取消 / 关闭 / 遮罩 均 false ---
  let p1 = window.__sc('msg1', '标题1');
  await window.__waitShown();
  assert(overlay().classList.contains('show'), '调用后确认框显示');
  assert(doc.getElementById('confirmMsg').textContent === 'msg1', '消息文本写入');
  assert(doc.getElementById('confirmTitle').textContent === '标题1', '标题文本写入');
  click(doc.getElementById('confirmOk'));
  assert(await p1 === true, '点确定 resolve true');
  assert(!overlay().classList.contains('show'), 'done 后确认框隐藏');

  p1 = window.__sc('msg', '标题');
  await window.__waitShown();
  click(doc.getElementById('confirmCancel'));
  assert(await p1 === false, '点取消 resolve false');

  p1 = window.__sc('msg', '标题');
  await window.__waitShown();
  click(doc.getElementById('confirmClose'));
  assert(await p1 === false, '点关闭按钮 resolve false');

  p1 = window.__sc('msg', '标题');
  await window.__waitShown();
  overlay().dispatchEvent(new window.Event('click', { bubbles: true })); // e.target === overlay
  assert(await p1 === false, '点遮罩 resolve false');

  // --- 并发排队：两个确认框依次弹出，先到的 Promise 不挂起 ---
  const first = window.__sc('first', 'A');
  const second = window.__sc('second', 'B');
  await window.__waitShown();
  assert(doc.getElementById('confirmMsg').textContent === 'first', '并发时先显示第一个');
  click(doc.getElementById('confirmOk'));
  assert(await first === true, '第一个确认框正常 resolve（不再永久挂起）');
  await window.__waitShown();
  assert(doc.getElementById('confirmMsg').textContent === 'second', '第一个关闭后第二个自动显示');
  click(doc.getElementById('confirmCancel'));
  assert(await second === false, '第二个确认框正常 resolve');

  // --- 三按钮：opts.third 点它 resolve 自定义 value ---
  const three = window.__sc('msg', '标题', { third: { text: '第三项', value: 'overwrite' } });
  await window.__waitShown();
  const thirdBtn = doc.getElementById('confirmThird');
  assert(thirdBtn.style.display !== 'none' && thirdBtn.textContent === '第三项', '三按钮显示且文字正确');
  click(thirdBtn);
  assert(await three === 'overwrite', '点第三按钮 resolve 自定义 value');

  // 两按钮调用后第三按钮隐藏（不残留显示态）
  p1 = window.__sc('msg', '标题');
  await window.__waitShown();
  assert(doc.getElementById('confirmThird').style.display === 'none', '无 third 选项时第三按钮隐藏');
  click(doc.getElementById('confirmOk'));
  await p1;

  // --- okText/cancelText 自定义文案 + 用后恢复默认 ---
  const custom = window.__sc('msg', '标题', { okText: '重新加载', cancelText: '保留本地内容' });
  await window.__waitShown();
  assert(doc.getElementById('confirmOk').textContent === '重新加载', 'okText 生效');
  assert(doc.getElementById('confirmCancel').textContent === '保留本地内容', 'cancelText 生效');
  click(doc.getElementById('confirmOk'));
  assert(await custom === true, '自定义文案确认框正常 resolve');
  assert(doc.getElementById('confirmOk').textContent === '确定', 'done 后恢复默认「确定」（不残留定制）');
  assert(doc.getElementById('confirmCancel').textContent === '取消', 'done 后恢复默认「取消」');

  // --- 排队中的第二个框拿到的是自己传入的文案（第一个的定制不残留） ---
  const c1 = window.__sc('m1', 'T1', { okText: 'A按钮' });
  const c2 = window.__sc('m2', 'T2');
  await window.__waitShown();
  assert(doc.getElementById('confirmOk').textContent === 'A按钮', '排队中第一个框显示定制文案');
  click(doc.getElementById('confirmOk'));
  assert(await c1 === true, '定制文案第一个框正常 resolve');
  await window.__waitShown();
  assert(doc.getElementById('confirmOk').textContent === '确定', '第二个框（未传 okText）显示默认文案');
  click(doc.getElementById('confirmOk'));
  assert(await c2 === true, '排队中的第二个框正常 resolve');

  console.log(process.exitCode ? '\n有失败项' : '\n全部通过');
})();
