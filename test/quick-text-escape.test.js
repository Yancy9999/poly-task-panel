'use strict';
// 「T」常用文本条目的转义解析 expandQuickText（jsdom）
// 回归背景：常用文本此前为纯文本原样写入 PTY，无法在末尾携带 \r（回车提交）等控制字符。
// 现约定：仅「T」按钮弹出的常用文本在发送前做转义解析，其他输入路径（键盘/粘贴/「/」命令）不经过该函数。
// 覆盖：\r \n \t \\ 四种转义、\r 在条目末尾（提交场景）、路径中的 \\（统一转义规则 A：
//       C:\\repos\\test 解析为 C:\repos\test）、未知转义按字面保留（\d 保持 \d）、纯文本不受影响。
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
if (!scripts.length) throw new Error('未找到内联脚本');
const inlineScript = scripts[scripts.length - 1][1] + `
window.__expand = (t) => expandQuickText(t);
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

function assert(cond, msg) {
  if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; }
  else console.log('PASS: ' + msg);
}

const E = window.__expand;

// \r：末尾回车（提交）
assert(E('npm test\r') === 'npm test\r', '末尾 \\r 解析为回车');
assert(E('echo hi\r') === 'echo hi\r', 'echo 命令末尾 \\r');
// \n：换行；\t：Tab
assert(E('a\nb') === 'a\nb', '\\n 解析为换行');
assert(E('a\tb') === 'a\tb', '\\t 解析为 Tab');
// \\：字面反斜杠（统一转义规则，路径场景）
assert(E('C:\\\\repos\\\\test') === 'C:\\repos\\test', '路径反斜杠写作 \\\\ 解析为 \\');
// 未知转义按字面保留
assert(E('a\\db') === 'a\\db', '未知转义 \\d 保持字面');
// 无转义的纯文本不受影响
assert(E('plain text') === 'plain text', '纯文本原样');
// 转义出现在中间也解析
assert(E('git\\tcheckout\\r') === 'git\tcheckout\r', '中间转义同样解析');
