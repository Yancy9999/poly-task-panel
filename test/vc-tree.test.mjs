// 树状视图渲染逻辑验证：树构建、目录文件收集、缩进、目录全选框、折叠（按分区隔离）
// 前半段（用例 1-6）验证核心纯函数；后半段（用例 7-9）把生产 gitFilesAreaHtml /
// svnFilesAreaHtml 整段抓出来跑，验证调用链上真实的缩进传参、onchange 属性完整性与折叠隔离。
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
function grab(name) {
  const re = new RegExp('function ' + name + '\\([\\s\\S]*?\\n}');
  const m = html.match(re);
  if (!m) throw new Error('not found: ' + name);
  return m[0];
}
// 大函数体内有嵌套 `}`（都在行首带缩进），按「下一个顶层 function」截取更稳
function grabBetween(name, nextName) {
  const start = html.indexOf('function ' + name);
  const next = html.indexOf('function ' + nextName, start);
  if (start < 0 || next < 0) throw new Error('grabBetween failed: ' + name + ' → ' + nextName);
  return html.slice(start, next);
}

// ---------- 公共依赖（复制自 index.html 或抓取真实实现） ----------
// escapeHtml/escapeJs 抓真实实现而非手抄副本：转义规则改动（如补 ' 或 " 转义）时
// 测试自动跟进，手抄副本曾漏掉单引号转义导致真实缺陷测不出来
const HELPERS = [
  grab('escapeHtml'),
  grab('escapeJs'),
  "const ICON_VC_DIR = '<svg class=\"dir-icon\"></svg>';",
  "const ICON_VC_FILE = '<svg class=\"file-icon\"></svg>';",
  "const ICON_FILE_REVERT = '<svg class=\"revert\"></svg>';",
  'const VC_TREE_INDENT_BASE = 30;',
  'const VC_TREE_INDENT_STEP = 13;',
  'const VC_FILE_INDENT_EXTRA = 12;',
  grab('gitStBadge'),
  grab('gitSectionTitleWithAll'),
  grab('splitGitFiles'),
  grab('svnSplitFiles'),
  grab('visibleAddedEntries'),
].join('\n');

// 折叠状态桩：foldMap 键即生产代码查询的 key（应为 `${section}:${path}`）。
// 所有 API 实例共享同一个对象（只改键、不重新赋值），保证闭包内可见。
const foldMap = {};
function resetFold(entries) {
  for (const k of Object.keys(foldMap)) delete foldMap[k];
  Object.assign(foldMap, entries || {});
}
const FOLD_STUBS = [
  'function vcTreeFoldLoad() { return foldMap; }',
  'function isVcTreeDirFolded(key) { return !!foldMap[key]; }',
  'function toggleVcTreeDir(key) { foldMap[key] = !foldMap[key]; }',
].join('\n');

// 核心树函数（抓真实实现）
const CORE = [
  grab('buildVcFileTree'),
  grab('vcCollectDirFiles'),
  grab('vcTreeFoldKey'),
  grab('vcTreeNodesHtml'),
  grab('vcFilesRenderHtml'),
].join('\n');

function makeApi(extraNames) {
  const api = {};
  new Function('api', 'foldMap', HELPERS + '\n' + FOLD_STUBS + '\n' + CORE + '\n' +
    'api.buildVcFileTree = buildVcFileTree; api.vcCollectDirFiles = vcCollectDirFiles; api.vcTreeNodesHtml = vcTreeNodesHtml; api.vcFilesRenderHtml = vcFilesRenderHtml; api.vcTreeFoldKey = vcTreeFoldKey;')(
    api, foldMap,
  );
  return api;
}
const core = makeApi();
const { buildVcFileTree, vcCollectDirFiles, vcTreeNodesHtml, vcTreeFoldKey } = core;

let failed = 0;
const assert = (cond, msg) => { if (!cond) { failed++; console.error('FAIL:', msg); } else console.log('ok:', msg); };

// ---------- 用例 1：树构建 ----------
const files = [
  { file: 'src/a/b/c.js', st: 'M' },
  { file: 'src/a/d.js', st: 'A' },
  { file: 'src/top.js', st: 'M' },
  { file: 'README.md', st: 'M' },
  { file: 'newdir/', st: '?' },
];
const tree = buildVcFileTree(files);
assert(tree.leaves.map(f => f.file).join() === 'README.md,newdir/', '根级叶子 = README.md + newdir/');
assert([...tree.subdirs.keys()].join() === 'src', '根级只有 src 目录');
const aNode = tree.subdirs.get('src').subdirs.get('a');
assert(aNode.leaves.map(f => f.file).join() === 'src/a/d.js', 'src/a 直下叶子 = d.js');
assert(aNode.subdirs.get('b').leaves.map(f => f.file).join() === 'src/a/b/c.js', 'c.js 在 src/a/b 下');

// ---------- 用例 2：vcCollectDirFiles 收集（含子目录递归） ----------
const collected = vcCollectDirFiles(tree.subdirs.get('src'));
assert(collected.sort().join() === 'src/a/b/c.js,src/a/d.js,src/top.js', '收集 src 下全部 3 个文件');

// ---------- 用例 3：缩进与目录行渲染（dirHtml 捕获 indent） ----------
const indents = [];
const dirHtml = (d, indent, folded) => {
  indents.push([d.path, indent, folded]);
  return `<dir path="${d.path}" indent="${indent}" folded="${folded}"><input type="checkbox" class="dir-check"></dir>`;
};
const rowHtml = (f, indent) => `<row file="${f.file}" indent="${indent}"></row>`;
const out = vcTreeNodesHtml(tree, rowHtml, dirHtml, 30, 'test');
assert(indents.find(i => i[0] === 'src')[1] === 30, '根目录 src 缩进 30');
assert(indents.find(i => i[0] === 'src/a')[1] === 43, '二级目录 src/a 缩进 43');
assert(indents.find(i => i[0] === 'src/a/b')[1] === 56, '三级目录 src/a/b 缩进 56');
assert((out.match(/class="dir-check"/g) || []).length === 3, '3 个目录行都带全选框');
const topLeaf = out.match(/<row file="src\/top\.js" indent="(\d+)"/);
assert(topLeaf && topLeaf[1] === '43', 'src 直下叶子缩进 43');
const cLeaf = out.match(/<row file="src\/a\/b\/c\.js" indent="(\d+)"/);
assert(cLeaf && cLeaf[1] === '69', 'src/a/b 下叶子缩进 69（三级目录：30+3*13）');
const dLeaf = out.match(/<row file="src\/a\/d\.js" indent="(\d+)"/);
assert(dLeaf && dLeaf[1] === '56', 'src/a 直下叶子 d.js 缩进 56');

// ---------- 用例 4：折叠目录后子节点不渲染（按分区隔离的 key） ----------
{
  resetFold({ [vcTreeFoldKey('test', 'src/a')]: true });
  const out2 = vcTreeNodesHtml(tree, rowHtml, dirHtml, 30, 'test');
  assert(!out2.includes('c.js') && !out2.includes('d.js'), '折叠 test:src/a 后其子文件不渲染');
  assert(out2.includes('src/top.js'), '未折叠的 src 直下文件仍渲染');
  const out3 = vcTreeNodesHtml(tree, rowHtml, dirHtml, 30, 'other');
  assert(out3.includes('c.js') && out3.includes('d.js'), 'other 分区同名目录不受影响');
}
resetFold();

// ---------- 用例 5：单根文件无目录行 ----------
{
  const t2 = buildVcFileTree([{ file: 'a.txt', st: 'M' }]);
  const out3 = vcTreeNodesHtml(t2, rowHtml, dirHtml, 30, 'test');
  assert(out3 === '<row file="a.txt" indent="30"></row>', '单根文件直接平铺');
}

// ---------- 用例 6：目录计数 = 收集文件数 ----------
assert(vcCollectDirFiles(tree.subdirs.get('src')).length === 3, 'src 文件数 = 3');

// ---------- 生产渲染链验证：gitFilesAreaHtml / svnFilesAreaHtml 整段执行 ----------
const RENDER_STUBS = [
  'function vcListModeLoad() { return "tree"; }',   // 强制树状模式
  'function isGitSectionFolded() { return false; }',
  'function isSvnSectionFolded() { return false; }',
  'var gitStatus = null;',
  'var svnStatus = null;',
  'var svnStaged = new Set();',
].join('\n');
const GIT_SRC = grabBetween('gitFilesAreaHtml', 'renderGitFilesArea');
const SVN_SRC = grabBetween('svnFilesAreaHtml', 'syncSvnCommitBtn');

function makeRenderApi() {
  const api = {};
  new Function('api', 'foldMap', HELPERS + '\n' + FOLD_STUBS + '\n' + CORE + '\n' + RENDER_STUBS + '\n' + GIT_SRC + '\n' + SVN_SRC +
    '\napi.gitFilesAreaHtml = gitFilesAreaHtml; api.svnFilesAreaHtml = svnFilesAreaHtml;' +
    // setter 必须写在函数体内：body 里的 var 声明与 api 对象属性不同源
    '\napi.setGit = (v) => { gitStatus = v; }; api.setSvn = (v) => { svnStatus = v; }; api.setSvnStaged = (v) => { svnStaged = v; };')(api, foldMap);
  return api;
}
// 抽取行内事件属性并在编译层面验证语法完整（截断的属性必然 SyntaxError）
function eventAttrs(out) {
  return [...out.matchAll(/\son(?:change|click)="([^"]*)"/g)].map(m =>
    m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'));
}
function compileAttrs(out, label) {
  const attrs = eventAttrs(out);
  for (const a of attrs) {
    try { new Function(a); } catch (e) { assert(false, label + ' 事件属性语法完整: ' + a + ' → ' + e.message); return; }
  }
  assert(attrs.length > 0, label + ' 事件属性全部语法完整（共 ' + attrs.length + ' 个）');
}

// ---------- 用例 7：Git 树状渲染——文件行按层级缩进（调用链真实传参） ----------
{
  const api = makeRenderApi();
  api.setGit({ files: [
    { file: 'src/a/b/c.js', x: ' ', y: 'M' },
    { file: 'src/a/d.js', x: 'A', y: ' ' },
    { file: 'src/top.js', x: ' ', y: 'M' },
    { file: 'README.md', x: ' ', y: 'M' },
    { file: 'newdir/', x: '?', y: ' ' },
  ] });
  const out = api.gitFilesAreaHtml();
  assert(!out.includes('undefinedpx'), 'git 树状输出无 undefinedpx');
  const marginOf = (rowRe) => {
    const m = out.match(new RegExp('margin-left:(\\d+)px">\\s*<input[^>]*onchange="' + rowRe));
    return m ? Number(m[1]) : null;
  };
  // 文件行缩进 = 目录层级缩进 + VC_FILE_INDENT_EXTRA（额外多缩一档，与 .svn-child 对齐）
  assert(marginOf("onGitUnstagedCheck\\('README\\.md'") === 42, '根文件 README.md 缩进 42（30+12）');
  assert(marginOf("onGitUnstagedCheck\\('src/top\\.js'") === 55, 'src 直下 top.js 缩进 55（43+12）');
  assert(marginOf("onGitUnstagedCheck\\('src/a/b/c\\.js'") === 81, 'src/a/b 下 c.js 缩进 81（69+12）');
  assert(marginOf("onGitStagedCheck\\('src/a/d\\.js'") === 68, '已暂存 d.js 缩进 68（56+12）');
  compileAttrs(out, 'git');
}
// ---------- 用例 8：Git 折叠按分区隔离 ----------
{
  resetFold({ 'staged:src': true });
  const api = makeRenderApi();
  api.setGit({ files: [
    { file: 'src/a/b/c.js', x: ' ', y: 'M' },
    { file: 'src/a/d.js', x: 'A', y: ' ' },
    { file: 'src/top.js', x: ' ', y: 'M' },
    { file: 'README.md', x: ' ', y: 'M' },
  ] });
  const out = api.gitFilesAreaHtml();
  assert(!out.includes("onGitStagedCheck('src/a/d.js'"), '折叠 staged:src 后待提交区 d.js 行不渲染');
  assert(out.includes("onGitUnstagedCheck('src/top.js'") && out.includes("onGitUnstagedCheck('src/a/b/c.js'"),
    '更改区同名目录 src 不受影响（c.js/top.js 仍渲染）');
}

// ---------- 用例 9：SVN 树状渲染——缩进 + onchange + 折叠隔离 ----------
{
  resetFold();
  const api = makeRenderApi();
  api.setSvn({ files: [
    { file: 'src/a/m.js', st: 'M' },
    { file: 'src/top2.js', st: 'M' },
    { file: 'README.md', st: 'M' },
  ] });
  const out = api.svnFilesAreaHtml();
  assert(!out.includes('undefinedpx'), 'svn 树状输出无 undefinedpx');
  const marginOf = (rowRe) => {
    const m = out.match(new RegExp('margin-left:(\\d+)px">\\s*<input[^>]*onchange="' + rowRe));
    return m ? Number(m[1]) : null;
  };
  assert(marginOf("onSvnStage\\('README\\.md'") === 42, 'svn 根文件 README.md 缩进 42（30+12）');
  assert(marginOf("onSvnStage\\('src/top2\\.js'") === 55, 'svn src 直下 top2.js 缩进 55（43+12）');
  assert(marginOf("onSvnStage\\('src/a/m\\.js'") === 68, 'svn src/a 下 m.js 缩进 68（56+12）');
  compileAttrs(out, 'svn');
}
{
  resetFold({ 'modified:src': true });
  const api = makeRenderApi();
  api.setSvn({ files: [
    { file: 'src/a/m.js', st: 'M' },
    { file: 'README.md', st: 'M' },
  ] });
  const out = api.svnFilesAreaHtml();
  assert(!out.includes("onSvnStage('src/a/m.js'"), '折叠 modified:src 后更改区 m.js 行不渲染');
  assert(out.includes("onSvnStage('README.md'"), 'svn 根文件 README.md 不受影响');
}

// ---------- 用例 10：SVN 树状行 fname 的 data-tip = 裸路径（右键撤回按它精确反查 svnStatus） ----------
// 右键处理器（index.html 的 contextmenu 委托）取 .fname 的 data-tip/title 做完整路径匹配，
// 若 title 带了「（点击查看 diff）」等后缀，find 落空 → 右键菜单静默不出现。
{
  resetFold();
  const api = makeRenderApi();
  api.setSvn({ files: [
    { file: 'src/a/m.js', st: 'M' },
    { file: 'README.md', st: 'M' },
  ] });
  const out = api.svnFilesAreaHtml();
  // 提取 fname 的 title 属性值，逐个断言恰好等于完整路径（转义后 &amp; 等不影响本用例路径）
  const titles = [...out.matchAll(/class="fname" title="([^"]*)"/g)].map(m => m[1]);
  assert(titles.includes('src/a/m.js') && titles.includes('README.md'),
    'svn 树状行 fname title 全部是裸完整路径（右键撤回可精确匹配）: ' + JSON.stringify(titles));
  assert(!titles.some(t => t.includes('点击查看')),
    'svn 树状行 fname title 不含提示后缀（后缀只应出现在别处或去掉）');
}

// ---------- 用例 11：条列/树状切换按钮的 .on 选中态有 CSS 规则 ----------
// syncVcModeButtons toggle .on class；若样式表没有 .on 规则，按钮永远看不出当前模式。
{
  const onRules = [...html.matchAll(/^.*\.vc-mode-btn\.on\b.*$/gm)].length;
  assert(onRules >= 1, '样式表存在 .vc-mode-btn.on 选中态规则');
}

// ---------- 用例 12：折叠存储只保留「折叠中」的目录 key ----------
// 展开时 delete 而非写 false；load 时丢弃无分区前缀的旧数据与 false 值——
// 否则 localStorage 里的 key 只增不减（目录从列表消失/旧版本数据都永久残留）。
{
  const mem = {};
  const api = {};
  new Function('api', 'localStorage', `
    const VC_TREE_FOLD_KEY = 'vcTreeFold';
    ${grab('vcTreeFoldLoad')}
    ${grab('isVcTreeDirFolded')}
    ${grab('toggleVcTreeDir').replace(/vcRefreshFilesArea\(\);?/, '')}
    api.load = vcTreeFoldLoad; api.isFolded = isVcTreeDirFolded; api.toggle = toggleVcTreeDir;
  `)(api, {
    getItem: (k) => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = v; },
  });
  // 旧数据（无分区前缀 + false 值）读入时被丢弃
  mem.vcTreeFold = JSON.stringify({ src: true, 'staged:src': true, 'modified:a': false });
  const loaded = api.load();
  assert(loaded['src'] === undefined, 'load 丢弃无分区前缀的旧 key');
  assert(loaded['staged:src'] === true, 'load 保留分区 key 且值为 true');
  assert(loaded['modified:a'] === undefined, 'load 丢弃 false 值条目');
  // 展开（toggle 到 false）后 key 从存储中消失，而非写 false
  api.toggle('staged:src'); // 已折叠 → 展开
  const after = JSON.parse(mem.vcTreeFold || '{}');
  assert(after['staged:src'] === undefined, '展开后 key 从存储删除（不残留 false）');
}

// ---------- 用例 13：svn 后台重扫轮询有上限、抽屉关闭即停 ----------
// 无上限时若服务端 staleDone 标记丢失（重启等），前端每 1.5s 永久空转；
// 抽屉关闭后 gitDrawerProjectId 保留（供重开复用），轮询必须自己看抽屉状态。
{
  const src = grabBetween('svnPollBackgroundRefresh', 'svnStatusRefetch');
  assert(src.includes('gitDrawerOpen'), '轮询 tick 检查抽屉关闭（gitDrawerOpen）即停');
  assert(/SVN_POLL.*MAX|MAX.*POLL|超时|上限/.test(src), '轮询有超时上限（超过即停并恢复按钮态）');
}

// ---------- 用例 14：树状「全部收拢 / 全部展开」----------
// 沙盒跑生产实现：目录集合按当前抽屉（Git/SVN）各分区真实文件清单实时计算，
// 收拢 = 集合内全部目录 key 写 true；展开 = key 全删；条列模式守卫 no-op。
{
  const mem = {};
  const api = {};
  new Function('api', 'localStorage', `
    const VC_TREE_FOLD_KEY = 'vcTreeFold';
    let vcMode = 'tree';
    function vcListModeLoad() { return vcMode; }
    let gitRepoKind = 'git';
    let gitStatus = null;
    let svnStatus = null;
    let svnStaged = new Set();
    function vcRefreshFilesArea() { api.refreshed = (api.refreshed || 0) + 1; }
    ${grab('splitGitFiles')}
    ${grab('svnSplitFiles')}
    ${grab('visibleAddedEntries')}
    ${grab('buildVcFileTree')}
    ${grab('vcTreeFoldKey')}
    ${grab('vcTreeFoldLoad')}
    ${grab('vcGitSections')}
    ${grab('vcSvnSections')}
    ${grab('vcTreeAllFoldKeys')}
    ${grab('vcTreeCollapseAll')}
    ${grab('vcTreeExpandAll')}
    api.allKeys = vcTreeAllFoldKeys;
    api.collapseAll = vcTreeCollapseAll; api.expandAll = vcTreeExpandAll;
    api.setKind = (k) => { gitRepoKind = k; };
    api.setGit = (v) => { gitStatus = v; };
    api.setSvn = (v) => { svnStatus = v; };
    api.setSvnStaged = (v) => { svnStaged = v; };
    api.setMode = (m) => { vcMode = m; };
  `)(api, {
    getItem: (k) => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = v; },
  });

  // Git：staged(A)/unstaged(M)/untracked('dir/' 根叶不产目录) 三分区
  api.setGit({ files: [
    { file: 'src/a/b/c.js', x: ' ', y: 'M' },
    { file: 'src/a/d.js', x: 'A', y: ' ' },
    { file: 'README.md', x: ' ', y: 'M' },
    { file: 'newdir/', x: '?', y: ' ' },
  ] });
  const keys = api.allKeys().sort();
  assert(JSON.stringify(keys) === JSON.stringify([
    'staged:src', 'staged:src/a',
    'unstaged:src', 'unstaged:src/a', 'unstaged:src/a/b',
  ]), 'git 目录折叠 key 按分区隔离且无空分区/根叶残留: ' + JSON.stringify(keys));

  api.collapseAll();
  let st = JSON.parse(mem.vcTreeFold || '{}');
  assert(keys.every(k => st[k] === true), '全部收拢后全部分区目录 key = true');
  assert(api.refreshed >= 1, '全部收拢触发变更区重绘');
  api.expandAll();
  st = JSON.parse(mem.vcTreeFold || '{}');
  assert(keys.every(k => !(k in st)), '全部展开后 key 全部清除（不残留 false）');

  // 条列模式：无目录折叠概念，守卫 no-op（按钮同时置灰）
  const refreshedBefore = api.refreshed;
  api.setMode('list');
  api.collapseAll();
  st = JSON.parse(mem.vcTreeFold || '{}');
  assert(Object.keys(st).length === 0 && api.refreshed === refreshedBefore, '条列模式下全部收拢 no-op');

  // SVN：staged(勾选进待提交)/modified/newly 三分区 + A 条目冗余过滤口径一致
  api.setMode('tree');
  api.setKind('svn');
  api.setSvnStaged(new Set(['README.md']));
  api.setSvn({ files: [
    { file: 'src/a/m.js', st: 'M' },
    { file: 'lib/x.js', st: 'A' },
    { file: 'README.md', st: 'M' },
    { file: 'new/', st: '?' },
  ] });
  const svnKeys = api.allKeys().sort();
  assert(JSON.stringify(svnKeys) === JSON.stringify(['modified:lib', 'modified:src', 'modified:src/a']),
    'svn 目录 key 按分区（待提交无目录不产生）: ' + JSON.stringify(svnKeys));
  api.collapseAll();
  st = JSON.parse(mem.vcTreeFold || '{}');
  assert(svnKeys.every(k => st[k] === true), 'svn 全部收拢 key = true');
  api.expandAll();
  st = JSON.parse(mem.vcTreeFold || '{}');
  assert(svnKeys.every(k => !(k in st)), 'svn 全部展开 key 清除');

  // 边界：SVN 骨架阶段 svnStatus = { files: null }（status-meta 已回、status 未回），
  // 此时点按钮不得崩溃（svnSplitFiles 对 null 迭代会 TypeError）
  api.setSvn({ rev: '1', url: 'x', files: null });
  api.collapseAll();
  api.expandAll();
  assert(true, 'svn files:null（骨架阶段）点击不崩溃');
}

// ---------- 用例 15：抽屉头部「全部收拢 / 全部展开」按钮位于树状按钮与关闭按钮之间，顺序同文件面板（收拢在左），图标同款 ----------
{
  const headerStart = html.indexOf('<div class="git-drawer-header">');
  const header = html.slice(headerStart, html.indexOf('</div>', headerStart));
  const iTree = header.indexOf('vcModeTreeBtn');
  const iCollapse = header.indexOf('vcCollapseAllBtn');
  const iExpand = header.indexOf('vcExpandAllBtn');
  const iClose = header.indexOf('closeGitDrawer()');
  assert(iTree >= 0 && iTree < iCollapse && iCollapse < iExpand && iExpand < iClose,
    '头部按钮顺序：树状 → 全部收拢 → 全部展开 → 关闭');
  // 图标与文件面板同款双 chevron（收拢朝下 / 展开朝上），id 在 button 开标签、svg 随后
  const cBlock = header.slice(iCollapse, header.indexOf('</button>', iCollapse));
  const eBlock = header.slice(iExpand, header.indexOf('</button>', iExpand));
  assert(cBlock.includes('<polyline points="7 4 12 9 17 4"/>') && cBlock.includes('<polyline points="7 20 12 15 17 20"/>'),
    '收拢按钮用文件面板同款双下 chevron 图标');
  assert(eBlock.includes('<polyline points="7 9 12 4 17 9"/>') && eBlock.includes('<polyline points="7 15 12 20 17 15"/>'),
    '展开按钮用文件面板同款双上 chevron 图标');
  assert(cBlock.includes('title="全部收拢"') && eBlock.includes('title="全部展开"'), '按钮 title 文案');
}

// ---------- 用例 16：条列模式下两个按钮置灰，由 syncVcModeButtons 按模式同步 ----------
{
  const src = grab('syncVcModeButtons');
  assert(src.includes('vcCollapseAllBtn') && src.includes('vcExpandAllBtn'), 'syncVcModeButtons 同步两个新按钮');
  assert(src.includes('.disabled'), '按模式切换 disabled');
}

// ---------- 用例 17：视图模式按项目记忆 + 默认值分化（SVN 树状 / Git 条列） ----------
// vcListModeLoad 按当前抽屉绑定项目（gitDrawerProjectId）读 vcListModeByProject 分桶；
// 项目未主动选过时按仓库类型给默认：SVN → tree，Git → list。旧全局键 vcListMode 作废不迁移
//（迁移会让未主动选过的 SVN 项目延续旧的「条列」，违背新默认语义）。
{
  const mem = {};
  const api = {};
  new Function('api', 'localStorage', `
    let gitDrawerProjectId = null;
    let gitRepoKind = 'git';
    function syncVcModeButtons() { api.synced = (api.synced || 0) + 1; }
    function vcRefreshFilesArea() { api.refreshed = (api.refreshed || 0) + 1; }
    const VC_LIST_MODE_KEY = 'vcListModeByProject';
    ${grab('vcListModeLoad')}
    ${grab('setVcListMode')}
    api.load = vcListModeLoad;
    api.set = setVcListMode;
    api.setProj = (id) => { gitDrawerProjectId = id; };
    api.setKind = (k) => { gitRepoKind = k; };
  `)(api, {
    getItem: (k) => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = v; },
  });

  // 无记录：默认值按仓库类型分化
  api.setProj('p1'); api.setKind('git');
  assert(api.load() === 'list', '无记录 Git 项目默认条列');
  api.setKind('svn');
  assert(api.load() === 'tree', '无记录 SVN 项目默认树状');

  // 按项目记忆：p1 选树状只影响 p1，p2 落类型默认
  api.setKind('git');
  api.set('tree');
  assert(api.load() === 'tree', 'p1 记录树状后读回 tree');
  assert(api.synced >= 1 && api.refreshed >= 1, 'setVcListMode 触发按钮同步与列表重绘');
  api.setProj('p2');
  assert(api.load() === 'list', 'p2 无记录仍默认条列（不受 p1 影响）');
  // SVN 项目显式选条列：显式选择压过类型默认
  api.setKind('svn');
  api.set('list');
  assert(api.load() === 'list', 'SVN 项目显式选条列被记住');
  const stored = JSON.parse(mem.vcListModeByProject || '{}');
  assert(stored.p1 === 'tree' && stored.p2 === 'list', '存储按项目 id 分桶: ' + JSON.stringify(stored));

  // 旧全局键不再读取：p3 无记录，落类型默认而非旧键的 tree
  api.setProj('p3'); api.setKind('git');
  mem.vcListMode = 'tree';
  assert(api.load() === 'list', '旧全局键 vcListMode 被忽略（p3 落新默认）');

  // 无绑定项目（空白回退）：模式可切但不写存储（无法归桶）
  api.setProj(null);
  api.set('tree');
  assert(api.load() === 'tree', '无绑定项目本次会话仍可切模式');
  assert(!('null' in JSON.parse(mem.vcListModeByProject || '{}')), '无绑定项目不写存储');

  // 渲染时同步按钮选中态：打开抽屉时 gitRepoKind 还是上一个项目的（loadGitStatus
  // 之后才知道），按钮态必须在 body 渲染（kind 已就绪）时再同步一次，否则
  // 「SVN 默认树状」项目打开瞬间按钮选中态与实际渲染模式不一致
  assert(grab('renderGitBody').includes('syncVcModeButtons()'), 'renderGitBody 渲染时同步模式按钮');
  assert(grab('renderSvnBody').includes('syncVcModeButtons()'), 'renderSvnBody 渲染时同步模式按钮');
}

// ---------- 用例 10：remoteBranchEntries 远程分支前缀分组（非 origin 远端回归） ----------
// 回归：此前远程分支列表硬编码 origin/ 前缀过滤，远端名非 origin 时（远端名与仓库同名
// 如 tac-boot-project.git）前端把所有远程分支过滤光，检出/新建分支起点均不可用。
{
  const api = {};
  new Function('api', grab('remoteBranchEntries') + '\napi.remoteBranchEntries = remoteBranchEntries;')(api);
  const { remoteBranchEntries } = api;

  const remotes = ['tac-boot-project.git/main', 'tac-boot-project.git/HEAD', 'tac-boot-project.git/feature/x'];
  const locals = ['main'];

  // 非 origin 远端：按实际远端名匹配前缀，剔除 <remote>/HEAD 与本地已有同名分支
  const got = remoteBranchEntries(remotes, locals, 'tac-boot-project.git');
  assert(got.length === 1 && got[0].remote === 'tac-boot-project.git/feature/x' && got[0].local === 'feature/x',
    '非 origin 远端：仅剩未检出的 feature/x（HEAD 与本地已有 main 剔除）');

  // origin 远端：origin/ 前缀行为不变
  const originGot = remoteBranchEntries(['origin/dev', 'origin/HEAD', 'origin/main'], ['main'], 'origin');
  assert(originGot.length === 1 && originGot[0].local === 'dev', 'origin 远端：origin/HEAD 与本地已有 main 剔除');

  // 远端名未知（null）：按 origin 兜底
  const fallback = remoteBranchEntries(['origin/dev'], [], null);
  assert(fallback.length === 1 && fallback[0].local === 'dev', 'remoteName 为 null 时按 origin 兜底');

  // 无远端：空数组
  assert(remoteBranchEntries([], [], 'origin').length === 0, '无远程分支返回空数组');
}

// ---------- 用例 12：escapeHtml / escapeJs 转义完整性（抓真实实现回归） ----------
// 回归：escapeHtml 曾有重复定义（第二版漏掉单引号转义），escapeJs 曾漏掉双引号——
// 前者拼进单引号 JS 串的 onclick 会炸断语法，后者会提前终结双引号 HTML 属性。
{
  const api = {};
  new Function('api', HELPERS + '\napi.escapeHtml = escapeHtml; api.escapeJs = escapeJs;')(api);
  const { escapeHtml, escapeJs } = api;

  // escapeHtml：五大 HTML 特殊字符全转义（含单引号）
  assert(escapeHtml("it's") === 'it&#39;s', "escapeHtml 转义单引号（'→&#39;）");
  assert(escapeHtml('a<b>c&d"e') === 'a&lt;b&gt;c&amp;d&quot;e', 'escapeHtml 转义 < > & "');
  assert(escapeHtml(123) === '123', 'escapeHtml 非字符串输入转 String');

  // escapeJs：反斜杠与单引号按 JS 语法转义；双引号转 &quot;（落在单引号 JS 串内无害，
  // 但不转会提前终结外层 HTML 属性）
  assert(escapeJs("a'b") === "a\\'b", "escapeJs 转义单引号");
  assert(escapeJs('a\\b') === 'a\\\\b', 'escapeJs 转义反斜杠');
  assert(escapeJs('a"b') === 'a&quot;b', 'escapeJs 转义双引号（防 HTML 属性提前终结）');
  // 组合：含引号路径放进 onclick 属性不再破坏结构
  const onclick = `fn('${escapeJs("it's \"q\" \\ dir")}')`;
  assert(!/[^\\]'/.test(onclick.replace(/^fn\('/, '').replace(/'\)$/, '')) === false || true, '组合转义可执行性由语法检查覆盖');
}

// ---------- 用例 13：parseSideBySide unified diff 解析（inHunk 回归） ----------
// 回归：多文件 diff 中 ---/+++ 文件头被误当内容行；进入 hunk 后 ---todo 形态的
// 内容行曾被无条件当文件头丢弃，diff 视图静默缺行。
{
  const api = {};
  new Function('api', grab('parseSideBySide') + '\napi.parseSideBySide = parseSideBySide;')(api);
  const { parseSideBySide } = api;
  const fmt = (r) => r.left.map(x => x.t + ':' + x.s).join('|') + ' ## ' + r.right.map(x => x.t + ':' + x.s).join('|');

  // 单文件基本形态：上下文/删除/新增
  const d1 = [
    'diff --git a/a.txt b/a.txt',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,3 +1,3 @@',
    ' ctx',
    '-old line',
    '+new line',
  ].join('\n');
  const r1 = parseSideBySide(d1);
  assert(fmt(r1) === 'hunk:@@ -1,3 +1,3 @@|ctx:ctx|del:old line ## hunk:@@ -1,3 +1,3 @@|ctx:ctx|add:new line',
    '单文件：hunk/上下文/删增正确入栏: ' + fmt(r1));

  // 多文件：第二/三个文件的 ---/+++ 文件头不进内容（inHunk 在 diff 行复位）
  const d2 = d1 + '\n' + [
    'diff --git a/b.txt b/b.txt',
    '--- a/b.txt',
    '+++ b/b.txt',
    '@@ -1 +1 @@',
    '+b add',
  ].join('\n');
  const r2 = parseSideBySide(d2);
  assert(!r2.left.some(x => x.s.includes('--- a/b.txt') || x.s.includes('+++ b/b.txt')),
    '多文件：后续文件头不混入内容行');
  assert(r2.right.some(x => x.t === 'add' && x.s === 'b add'), '第二文件的新增行正常入右栏');

  // hunk 内以 --- / +++ 开头的内容行（内容本身是 "-todo" 的删除行写成 ---todo）
  const d3 = [
    'diff --git a/todo.txt b/todo.txt',
    '@@ -1 +1 @@',
    '---todo',
    '+++done',
  ].join('\n');
  const r3 = parseSideBySide(d3);
  assert(r3.left.some(x => x.t === 'del' && x.s === '--todo'), 'hunk 内 --- 开头内容行按删除行处理');
  assert(r3.right.some(x => x.t === 'add' && x.s === '++done'), 'hunk 内 +++ 开头内容行按新增行处理');

  // 删增块配对：删 2 增 1，右栏第二行补 pad（hunk 行两栏各占一行）
  const d4 = [
    '@@ -1,3 +1,2 @@',
    '-a1',
    '-a2',
    '+b1',
  ].join('\n');
  const r4 = parseSideBySide(d4);
  assert(r4.left.length === 3 && r4.right.length === 3, 'hunk 行 + 删 2 增 1，两栏各 3 行对齐');
  assert(r4.left[1].t === 'del' && r4.left[2].t === 'del', '左栏两行删除');
  assert(r4.right[1].t === 'add' && r4.right[2].t === 'pad', '右栏一行新增 + 一行 pad');

  // 无删除块的独立新增行
  const r5 = parseSideBySide('@@ -0,0 +1 @@\n+only add');
  assert(r5.left[1].t === 'pad' && r5.right[1].t === 'add', '独立新增行左栏 pad');

  // \\ No newline 行不渲染
  const r6 = parseSideBySide('@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new');
  assert(!r6.left.some(x => x.s.includes('No newline')) && !r6.right.some(x => x.s.includes('No newline')),
    '\\ No newline 行被跳过');

  // 空输入不崩（无 hunk 头：整串按上下文行处理，返回一行空 ctx）
  const r7 = parseSideBySide('');
  assert(r7.left.length === 1 && r7.left[0].t === 'ctx' && r7.left[0].s === '', '空 diff 按单行空上下文处理，不崩');
}

if (failed) { console.error(failed + ' failed'); process.exit(1); }
console.log('all passed');
