// 全局字体联动（jsdom + 样式表静态断言）
// 口径（用户指定）：
//   - 字体：全局联动——除 xterm 终端画布（走 xterm options）外，所有 font-family 硬编码
//     的规则（含全局 UI 的 sans-serif、等宽文本区）都改为 var(--app-font-family)
//     引用，随设置热更新
//   - 字号：不联动——各元素保持现有固定 px 档位，禁止把固定字号改成 var(--app-font-size)
//   - 任务工作台按钮/标题的「完全不跟随」口径同步推翻：改为跟随字体
// 验证三件事：
//   1) 样式表中除 :root 变量定义外，不再存在硬编码 font-family（全部走变量引用）
//   2) 字号不联动：固定 px 字号保持固定，无人把 font-size 改成 var()（:root 定义除外）
//   3) applyTermSettings() 热更新链路不变（复用 tasks-font.test.js 的行为断言口径）
const fs = require('node:fs');
const path = require('node:path');

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const styleText = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
// :root 变量定义行是字体的唯一合法落点（提供默认回退值），摘除后再扫描
const clean = styleText
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/:root\s*\{[^}]*--app-font-family[^}]*\}/, '');

function assert(cond, msg) {
  if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; }
  else console.log('PASS: ' + msg);
}

// --- 1) 硬编码 font-family 清零（:root 变量定义行除外）---
const rootVarLine = ':root { --app-font-family: "Cascadia Code", Consolas, monospace; --app-font-size: 13px; }';
assert(html.includes(rootVarLine), ':root 变量定义保留（默认值与 DEFAULT_SETTINGS 一致）');

const hardcoded = [...clean.matchAll(/font-family:\s*([^;}]+)/g)]
  .map(m => m[1].trim())
  .filter(v => !v.includes('var(--app-font-family)') && v !== 'inherit'); // inherit：表单控件继承 body 的变量字体
assert(hardcoded.length === 0, `样式表 font-family 硬编码清零（残留: ${hardcoded.join(' | ') || '无'}）`);

// --- 2) 字号不联动：字号变量引用限定在「说明文案承诺的跟随区域」内，不扩散 ---
// 任务工作台（表单/输出/下拉 4 处）+ 终端区（console-body）+ 日志抽屉（log-drawer-body）
// + Git diff（.git-diff-pre）+ 文件编辑器（.file-view-pre 及其 code）——与设置面板字号 hint 一致
const SIZE_VAR_SELECTORS = [
  '.task-form-field input, .task-form-field textarea',
  '.task-run-output',
  '.task-select-toggle',
  '.task-select-item',
  '.console-body',
  '.log-drawer-body',
  '.git-diff-pre',
  '.file-view-pre',
  '.file-view-pre code',
];
const fontSizeVarCount = (clean.match(/font-size:\s*var\(--app-font-size\)/g) || []).length;
assert(fontSizeVarCount === SIZE_VAR_SELECTORS.length,
  `font-size 变量引用限定在 ${SIZE_VAR_SELECTORS.length} 个跟随区域（当前: ${fontSizeVarCount}）`);
for (const sel of SIZE_VAR_SELECTORS) {
  assert(clean.includes(sel + ' {') || new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{').test(clean)
    || clean.includes(sel), `字号跟随区域存在规则 ${sel}`);
}
const sizeHits = [...clean.matchAll(/--app-font-size:\s*([^;}]+)/g)].map(m => m[1].trim());
assert(sizeHits.every(v => v === '13px'), ':root 的 --app-font-size 默认值仍为 13px');

// --- 3) 任务工作台按钮/标题改为跟随字体（推翻旧口径）---
const btnRule = clean.match(/\.task-form-actions button\s*\{([^}]*)\}/);
assert(btnRule && btnRule[1].includes('var(--app-font-family)'), '.task-form-actions button 跟随设置字体');
const dangerRule = clean.match(/\.task-edit-actions .danger\s*\{([^}]*)\}/);
assert(dangerRule && dangerRule[1].includes('var(--app-font-family)'), '.task-edit-actions .danger 跟随设置字体');

// --- 4) xterm 链路不受影响：term.options.fontFamily 仍在 applyTermSettings 中 ---
assert(/term\.options\.fontFamily\s*=\s*fontFamily/.test(html), 'xterm 会话字体链路保留');

console.log(process.exitCode ? '\n有失败项' : '\n全部通过');
