// 任务抽屉/任务工作台跟随设置字体（jsdom + 样式表静态断言）
// 口径（全局字体联动后，见 global-font-linkage.test.js）：
//   - 字体（--app-font-family）：全局跟随——工作台所有元素（含按钮、列标题/弹窗标题
//     经 body 继承）都跟随设置字体
//   - 字号（--app-font-size）：不全局扩散——仅「选项」（下拉闭合态+弹出列表）、
//     「目标」（textarea/只读行）、「agent 输出」（.task-run-output）跟随；其余元素字号保持不变
// 验证两件事：
//   1) applyTermSettings() 把字体/字号写入根元素 CSS 变量（设置热更新链路）
//   2) 样式表中相关选择器引用变量、排除项不引用（:root 提供默认回退值）
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const styleText = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');

// 解析样式表为 [{ selector, decl }]（selector 为逗号拆分后的单个选择器；先去块注释）
function parseRules(text) {
  const rules = [];
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decl = m[2];
    for (const sel of m[1].split(',')) {
      const s = sel.trim();
      if (s && !s.startsWith('@')) rules.push({ selector: s, decl });
    }
  }
  return rules;
}
const rules = parseRules(styleText);
const find = (selector) => rules.filter(r => r.selector === selector);

function assert(cond, msg) {
  if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; }
  else console.log('PASS: ' + msg);
}

// 字体+字号都跟随的规则（选项 / 目标 / 输出）
// （.task-edit-readonly 已随弹窗改版移除：原目标行不再显示，新目标 textarea 由 .task-form-field textarea 覆盖）
const FONT_AND_SIZE = [
  '.task-select-toggle',
  '.task-select-item',
  '.task-form-field textarea',
  '.task-run-output',
];
// 仅字体跟随、字号保持的规则（工作台其余元素；按钮此前被排除，全局联动后同样跟随字体）
const FONT_ONLY = ['.task-card', '.task-form-field label', '.task-form-actions button', '.task-edit-actions .danger'];
// 完全不跟随字体：无（全局联动后按钮/标题已改为跟随）
const EXCLUDED = [];

for (const sel of FONT_AND_SIZE) {
  // 至少有一条规则引用字体+字号变量（:focus 等伪类规则只改描边色，无变量引用是正常的）
  const hits = find(sel);
  assert(hits.some(r => r.decl.includes('var(--app-font-family)') && r.decl.includes('var(--app-font-size)')),
    `${sel} 字体/字号引用 var(--app-font-family/--app-font-size)`);
}
for (const sel of FONT_ONLY) {
  const hits = find(sel);
  assert(hits.length > 0, `样式表存在规则 ${sel}`);
  for (const r of hits) {
    assert(r.decl.includes('var(--app-font-family)'), `${sel} 字体引用 var(--app-font-family)`);
    assert(!r.decl.includes('var(--app-font-size)'), `${sel} 字号不引用变量（保持原字号）`);
  }
}
for (const sel of EXCLUDED) {
  for (const r of find(sel)) {
    assert(!r.decl.includes('var(--app-font-family)') && !r.decl.includes('var(--app-font-size)'),
      `${sel} 不跟随设置字体/字号`);
  }
}
// :root 默认回退值（与 DEFAULT_SETTINGS 一致：Cascadia Code + 13px）
const rootRule = find(':root');
assert(rootRule.length > 0, '样式表存在 :root 规则');
assert(rootRule.some(r => r.decl.includes('--app-font-family')), ':root 定义 --app-font-family 默认值');
assert(rootRule.some(r => r.decl.includes('--app-font-size')), ':root 定义 --app-font-size 默认值');

// --- 行为：applyTermSettings 热更新根元素 CSS 变量 ---
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
const inlineScript = scripts[scripts.length - 1][1];

const dom = new JSDOM(html, {
  url: 'http://localhost:7777/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;
window.fetch = async () => ({ json: async () => [] });
window.WebSocket = class { constructor() {} send() {} close() {} };
window.Terminal = class {};
window.FitAddon = { FitAddon: class { fit() {} loadAddon() {} } };
window.HTMLElement.prototype.setPointerCapture = function () {};
window.HTMLElement.prototype.releasePointerCapture = function () {};
window.eval(inlineScript);

(async () => {
  await new Promise(r => setTimeout(r, 20));
  // 走设置保存链路：saveSettings 内部更新 termSettings 后调用 applyTermSettings；
  // PUT 回包需回显归一后的 settings（真实服务端行为），否则会被 Object.assign 重置为默认
  window.fetch = async (url, opts) => ({
    json: async () => ({ ok: true, settings: JSON.parse(opts.body) }),
  });
  // 打开设置弹窗：注入字体下拉选项（__custom__ 选项由 openSettingsModal 动态创建，
  // 静态 HTML 没有，不先打开则 sel.value 赋值静默失败回落默认 preset）
  await window.openSettingsModal();
  window.document.getElementById('setFontFamily').value = '__custom__';
  window.document.getElementById('setCustomFont').value = '"My Font", monospace';
  window.document.getElementById('setFontSize').value = '17';
  await window.saveSettings();
  const root = window.document.documentElement.style;
  assert(root.getPropertyValue('--app-font-family') === '"My Font", monospace',
    '保存设置后根元素写入 --app-font-family');
  assert(root.getPropertyValue('--app-font-size') === '17px',
    '保存设置后根元素写入 --app-font-size');
})();
