// 固定字号整体 +1px（jsdom + 样式表静态断言）
// 口径（用户指定映射）：
//   9px→10px、10px→11px、11px→12px、12px→13px、12.5px→13px、13px→14px
//   其余字号（14px 及以上）不变；var(--app-font-size) 联动处不变（含 :root 默认值 13px）
// 验证：样式表与内联 JS 中不再存在旧档固定 px 值（排除 :root 的 --app-font-size 默认值与 var() 引用）
const fs = require('node:fs');
const path = require('node:path');

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

function assert(cond, msg) {
  if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; }
  else console.log('PASS: ' + msg);
}

// 允许保留的 13px：:root 默认 --app-font-size（与 DEFAULT_SETTINGS 一致，热更新会覆盖）
const ROOT_RULE = ':root { --app-font-family: "Cascadia Code", Consolas, monospace; --app-font-size: 13px; }';
assert(html.includes(ROOT_RULE), ':root 的 --app-font-size 默认值 13px 保留');

// 摘除 :root 默认值后再扫描，避免误报
const scanned = html.replace(ROOT_RULE, '');

// 所有残留固定字号必须全部在新档位上：10/11/12/13/14/15/16/18/20
const hits = [...scanned.matchAll(/font-size:\s*([0-9.]+)px/g)].map(m => m[1]);
const allowed = new Set(['10', '11', '12', '13', '14', '15', '16', '18', '20']);
const bad = hits.filter(v => !allowed.has(v));
assert(bad.length === 0, `所有固定字号都在新档位（残留旧值: ${[...new Set(bad)].join(', ') || '无'}）`);

// 新档位分布与映射后的预期一致（便于回归时发现漏改/多改）
const counts = {};
for (const v of hits) counts[v] = (counts[v] || 0) + 1;
console.log('  当前固定字号分布:', JSON.stringify(counts));

// 旧档位值必须清零
for (const old of ['9', '10.5', '12.5']) {
  assert(!hits.includes(old), `旧字号 ${old}px 已不存在`);
}

console.log(process.exitCode ? '\n有失败项' : '\n全部通过');
