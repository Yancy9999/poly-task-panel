'use strict';
// 编辑器 Markdown 预览切换前端路径（jsdom）
// 覆盖：
//   - .md 文件打开后默认编辑态，标题栏出现「预览」切换按钮；非 md 文件不显示
//   - 编辑 → 预览：md 源码渲染为 HTML，相对图片路径改写为 raw 地址
//   - 预览 → 编辑：切回后编辑区内容与切换前一致（stash/restore 闭环）
//   - 模式按 tab 记忆：切走再切回，模式与内容保持
//   - isMdFile 扩展名判定
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
if (!scripts.length) throw new Error('未找到内联脚本');
const inlineScript = scripts[scripts.length - 1][1] + `
window.__fv = () => {
  const t = fvTabs.get(fvActiveSub);
  return t ? { sub: t.sub, mode: t.mode, content: t.content, dirty: t.dirty } : null;
};
window.__open = (sub) => openFileViewer(sub);
window.__toggle = () => toggleFvMdPreview();
window.__isMd = (sub) => isMdFile(sub);
window.__rewrite = (md, pid) => rewriteMdRelativeUrls(md, pid);
window.__mdEl = () => document.getElementById('fileViewMd');
window.__codeEl = () => document.getElementById('fileViewCode');
window.__save = () => saveFileViewActive();
window.__undo = () => undoFvEdit();
window.__redo = () => redoFvEdit();
window.__hist = () => { const t = fvTabs.get(fvActiveSub); return { hIndex: t.hIndex, hist: t.history }; };
window.__topBtn = () => document.getElementById('fvMdTopBtn');
`;

const dom = new JSDOM(html, {
  url: 'http://localhost:7777/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;

// --- 可控后端：GET file-content 按用例回包 ---
const MD_SRC = [
  '# 标题一',
  '',
  '- [简介](#简介)',
  '- [重复标题](#重复标题)',
  '',
  '## 简介',
  '',
  '- 列表项',
  '',
  '```js',
  'const x = 1;',
  '```',
  '',
  '![图片](docs/img.png)',
  '',
  '## 重复标题',
  '',
  '## 重复标题',
  '',
].join('\n');

let getContent = (url) => {
  const content = String(url).includes('guide.md') ? MD_TOC_SRC : MD_SRC;
  return { ok: true, content, mtime: 100 };
};
window.fetch = async (url, opts) => {
  const u = String(url);
  const method = (opts && opts.method) || 'GET';
  if (u.includes('/file-content')) {
    if (method === 'PUT') return { json: async () => ({ ok: true, mtime: 200 }) };
    return { json: async () => getContent() };
  }
  if (u === '/api/projects') return { json: async () => fakeProjects };
  if (u.includes('/files')) return { json: async () => ({ ok: true, items: [] }) };
  return { json: async () => ({ ok: true }) };
};
const fakeProjects = [
  { id: 'p1', name: 'Alpha', type: 'folder', running: false, projectPath: 'D:/a' },
];
// 带 TOC 的 md：锚点链接 + 中文标题 + 重复标题（验证 slug 后缀与点击滚动）
const MD_TOC_SRC = [
  '- [简介](#简介)',
  '- [重复标题](#重复标题)',
  '',
  '## 简介',
  '',
  '正文',
  '',
  '## 重复标题',
  '',
  '## 重复标题',
  '',
].join('\n');
window.WebSocket = class { constructor() {} send() {} close() {} };
window.Terminal = class {};
window.FitAddon = { FitAddon: class { fit() {} loadAddon() {} } };
window.HTMLElement.prototype.setPointerCapture = function () {};
window.HTMLElement.prototype.releasePointerCapture = function () {};
// jsdom 未实现 Element.scrollTo（真实 WebView 有）：行为对齐 opts.top 直赋 scrollTop；
// 平滑滚动是浏览器行为，jsdom 不可测，测试只断言最终 scrollTop
window.HTMLElement.prototype.scrollTo = function (opts) {
  this.scrollTop = (opts && typeof opts === 'object') ? opts.top : (arguments[0] || 0);
};
// jsdom 未实现 innerText：编辑器 stash/撤销栈读写它，代理到 textContent
Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
  get() { return this.textContent; },
  set(v) { this.textContent = v; },
});

// markdown-it UMD 桩：验证前端调用链（含渲染产物进 DOM），不重复 markdown-it 自身测试。
// 接口对齐真实库：renderer.rules.link_open 可被前端包装。标题按 GitHub 规则补 id
// （真实 markdown-it 不给标题生成 id，由前端渲染后补挂，这里模拟真实产物）。
window.markdownit = function () {
  const seen = {};
  return {
    renderer: { rules: {} },
    render: (src) => String(src)
      .replace(/^(#{1,6}) (.*)$/gm, (_, hashes, text) => {
        const slug = text.toLowerCase().replace(/[^\p{Letter}\p{Number}\s_-]/gu, '').trim().replace(/\s/g, '-');
        seen[slug] = (seen[slug] || 0) + 1;
        return `<h${hashes.length} id="${slug}${seen[slug] > 1 ? '-' + (seen[slug] - 1) : ''}">${text}</h${hashes.length}>`;
      })
      .replace(/\[([^\]]+)\]\(#([^)\s]+)\)/g, '<a href="#$2">$1</a>'),
  };
};

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
  window.openFileDrawer('p1');

  // --- 1. isMdFile 扩展名判定 ---
  assert(window.isMdFile('README.md') === true, 'isMdFile: .md 判真');
  assert(window.isMdFile('a/b.MD') === true, 'isMdFile: 大写 .MD 判真');
  assert(window.isMdFile('a/b.markdown') === true, 'isMdFile: .markdown 判真');
  assert(window.isMdFile('md') === false, 'isMdFile: 无扩展名判假');
  assert(window.isMdFile('a/b.mdx') === false, 'isMdFile: .mdx 判假');
  assert(window.isMdFile('a/b.md.txt') === false, 'isMdFile: .md.txt 判假');

  // --- 1b. 相对路径改写边界 ---
  const RW = window.__rewrite;
  assert(RW('[x](b.md)', 'p1').includes('/raw?sub=b.md'), '改写：行首链接也命中（负向后行不吞字符）');
  assert(RW('text [x](a/b.md) tail', 'p1').includes(encodeURIComponent('a/b.md')), '改写：文中相对链接');
  assert(RW('[x](https://e.com)', 'p1') === '[x](https://e.com)', '改写：https 链接不动');
  assert(RW('[x](#sec)', 'p1') === '[x](#sec)', '改写：锚点不动');
  assert(RW('![a](data:image/png;base64,AA)', 'p1') === '![a](data:image/png;base64,AA)', '改写：data: 图片不动');
  const nested = RW('[![n](i.png)](link.md)', 'p1');
  assert(nested.includes(encodeURIComponent('i.png')) && !nested.includes('raw?sub=%2Fapi'), '改写：图片嵌在链接里各改一次不叠加前缀');
  assert(RW('[x](/root.md)', 'p1') === '[x](/root.md)', '改写：站内根路径（/ 开头）不叠加前缀');
  assert(RW('![a](docs/my%20img.png)', 'p1').includes('raw?sub=' + encodeURIComponent(decodeURIComponent('docs/my%20img.png'))), '改写：%20 转义路径先 decode 再 encode（不双重编码）');
  assert(RW('[x](a%zz.md)', 'p1').includes(encodeURIComponent('a%zz.md')), '改写：非法 % 序列按原文编码不抛异常');
  // 替换位置正确性：目标必须只替换 href/src 部分，文本区不受污染
  {
    const s1 = RW('[a (b.md)](b.md)', 'p1');
    assert(s1.includes('](/api/projects/p1/raw?sub=b.md)'), '改写：文本含 (xxx) 时 href 精准替换（文本不被污染）');
    assert(s1.startsWith('[a (b.md)]'), '改写：文本含 (xxx) 时显示文本保持原样');
    const s2 = RW('[![n](i.png)](link.md)', 'p1');
    assert(s2.includes('raw?sub=i.png'), '改写：徽章嵌套图片照常改写');
    assert(s2.includes('raw?sub=link.md'), '改写：徽章嵌套外层链接也被改写（文本跨内层 ]）');
    assert(RW('code `[x](y.md)` end', 'p1') === 'code `[x](y.md)` end', '改写：行内代码 span 原样跳过（不污染代码内容）');
    assert(RW('[t](<my doc.md>)', 'p1').includes('my%20doc.md'), '改写：尖括号含空格 dest 命中并转义');
    assert(RW('[t](doc(1).md)', 'p1').includes('raw?sub=doc(1).md'), '改写：dest 含配对圆括号完整命中');
    // 性能回归：病态输入必须毫秒级（回扫/递归实现会在 2MB 上限内卡死预览数十秒）
    {
      const t0 = Date.now();
      RW('['.repeat(50000) + 'x](y.md)', 'p1');                       // 深嵌套
      RW('`'.repeat(100000) + '[x](y.md)', 'p1');                     // 反引号海
      RW('[l](a.md)\n'.repeat(50000), 'p1');                          // 大量正常链接
      const ms = Date.now() - t0;
      assert(ms < 500, `改写：病态输入性能上限（实际 ${ms}ms，回扫实现会 >60s）`);
    }
  }

  // --- 2. md 打开后默认预览态（阅读为主），预览按钮显示且图标联动 ---
  await window.__open('README.md');
  await wait(20);
  {
    const t = window.__fv();
    assert(t && t.sub === 'README.md', 'md 文件已打开为激活 tab');
    assert(t.mode === 'preview', 'md 默认预览态');
    assert(doc.getElementById('fileViewMdToggleBtn').style.display === '', 'md 文件显示预览切换按钮');
    assert(doc.getElementById('fileViewMdIconPreview').style.display === 'none', '预览态隐藏眼睛图标');
    assert(doc.getElementById('fileViewMdIconEdit').style.display === '', '预览态显示笔图标');
    const tip2 = doc.getElementById('fileViewMdToggleBtn').getAttribute('data-tip');
    assert(tip2 === '编辑', '预览态按钮提示为「编辑」');
    assert(doc.getElementById('fileViewMd').style.display === '', '预览容器初始可见');
    assert(doc.getElementById('fileViewPre').style.display === 'none', '编辑区初始隐藏');
  }

  // --- 3. 预览 → 编辑（图标联动回眼睛），渲染闭环 ---
  window.__toggle();
  await wait(30);   // 等全局 tooltip 的 MutationObserver 把新 title 改名 data-tip
  {
    const t = window.__fv();
    assert(t.mode === 'edit', '切换后 tab 进入编辑态');
    assert(doc.getElementById('fileViewMdIconPreview').style.display === '', '编辑态显示眼睛图标');
    assert(doc.getElementById('fileViewMdIconEdit').style.display === 'none', '编辑态隐藏笔图标');
    assert(doc.getElementById('fileViewMdToggleBtn').getAttribute('data-tip') === '预览', '编辑态按钮提示为「预览」');
    assert(doc.getElementById('fileViewMd').style.display === 'none', '预览容器隐藏');
    assert(doc.getElementById('fileViewPre').style.display === '', '编辑区可见');
    // 编辑区内容与磁盘原文一致（渲染时每行补 \n、stash 回读去尾 \n，两者抵消）
    assert(t.content === MD_SRC, 'tab.content 与磁盘原文一致');
    assert(doc.getElementById('fileViewCode').textContent === MD_SRC + '\n', '编辑区内容还原');
  }

  // --- 4. 编辑 → 预览：渲染进预览容器，图片路径改写为 raw 地址 ---
  window.__toggle();
  {
    const t = window.__fv();
    assert(t.mode === 'preview', '切换后 tab 进入预览态');
    assert(doc.getElementById('fileViewMd').style.display === '', '预览容器可见');
    assert(doc.getElementById('fileViewPre').style.display === 'none', '编辑区隐藏');
    const html_ = doc.getElementById('fileViewMd').innerHTML;
    assert(/<h1 id="[^"]*">标题一<\/h1>/.test(html_), 'md 源码经 markdown-it 渲染');
    assert(html_.includes('/api/projects/p1/raw?sub='), '相对图片路径改写为 raw 地址');
    assert(html_.includes(encodeURIComponent('docs/img.png')), 'raw 地址保留原相对路径（URL 编码）');
  }

  // --- 5. 模式按 tab 记忆（切走再切回）；README 此时已为 preview，直接切走 ---
  await window.__open('notes.txt');     // 切到 txt tab
  await wait(20);
  {
    const t = window.__fv();
    assert(t.sub === 'notes.txt' && t.mode === 'edit', 'txt tab 为编辑态');
    assert(doc.getElementById('fileViewMdToggleBtn').style.display === 'none', 'txt 文件不显示预览按钮');
    assert(doc.getElementById('fileViewPre').style.display === '', 'txt 文件显示编辑区');
  }
  await window.__open('README.md');     // 切回 README
  await wait(20);
  {
    const t = window.__fv();
    assert(t.sub === 'README.md' && t.mode === 'preview', '切回 README 保留预览态');
    assert(doc.getElementById('fileViewMd').style.display === '', '切回后预览容器可见');
    assert(doc.getElementById('fileViewPre').style.display === 'none', '切回后编辑区隐藏');
  }

  // --- 6. 预览态行号 gutter 不可见（随编辑区一起隐藏） ---
  assert(doc.getElementById('fvGutter').offsetParent === null, '预览态 gutter 不可见');

  // --- 7. 预览态保存：PUT 走缓存内容，保存后仍只有预览容器可见（不双显） ---
  {
    let putBody = null;
    const origFetch = window.fetch;
    window.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/file-content') && (opts && opts.method) === 'PUT') {
        putBody = JSON.parse(opts.body);
        return { json: async () => ({ ok: true, mtime: 300 }) };
      }
      return origFetch(url, opts);
    };
    // 前置：切回编辑态构造脏内容并保存成功
    window.__toggle();          // README 此时为 preview → edit
    const codeEl0 = doc.getElementById('fileViewCode');
    codeEl0.textContent = 'saved from edit';
    codeEl0.dispatchEvent(new window.Event('input', { bubbles: true }));
    await window.__save();
    await wait(20);
    let t = window.__fv();
    assert(t.dirty === false && t.content === 'saved from edit', '预览态前置：编辑态保存成功脏标清除');
    window.__toggle();          // → preview（切预览时 stash：'saved from edit' 写入缓存）
    t = window.__fv();
    assert(t.mode === 'preview', '预览态前置：进入预览');
    // 预览态直接保存（如点保存钮）：PUT 的应是切预览时 stash 的缓存内容
    putBody = null;
    await window.__save();
    await wait(20);
    assert(putBody && putBody.content === 'saved from edit', '预览态保存：PUT 内容为切预览时 stash 的缓存');
    t = window.__fv();
    assert(t.mode === 'preview', '预览态保存后仍是预览态');
    assert(doc.getElementById('fileViewMd').style.display === '', '预览态保存后预览容器可见');
    assert(doc.getElementById('fileViewPre').style.display === 'none', '预览态保存后编辑区保持隐藏（不双显）');
  }

  // --- 8. 撤销栈口径一致（回归：基线/脏标均去尾，预览往返不产生等价快照顶掉 redo） ---
  {
    window.__toggle();          // → edit
    const h = window.__hist();
    assert(h.hist[0] === MD_SRC.replace(/\n$/, ''), '撤销栈 0 号快照为去尾基线');
    const codeEl1 = doc.getElementById('fileViewCode');
    codeEl1.textContent = 'v3';
    codeEl1.dispatchEvent(new window.Event('input', { bubbles: true }));
    await wait(450);            // 等 debounce 打快照
    window.__undo();
    let t = window.__fv();
    assert(t.dirty === false, 'undo 回基线脏标清除（savedContent 同为去尾口径）');
    const h0 = window.__hist().hIndex;
    window.__toggle();          // → preview
    window.__toggle();          // → edit
    assert(window.__hist().hIndex === h0, '预览往返不压入等价快照（redo 分支保留）');
    window.__redo();
    t = window.__fv();
    assert(t.content === 'v3', '预览往返后 redo 仍可用');
  }

  // --- 9. 预览滚动位置记忆（回归：预览→编辑→预览往返不丢阅读位置） ---
  {
    window.__toggle();          // → preview
    const mdEl9 = doc.getElementById('fileViewMd');
    mdEl9.scrollTop = 321;      // 预览态下滚动（可见容器）
    window.__toggle();          // → edit
    window.__toggle();          // → preview
    assert(mdEl9.scrollTop === 321, '预览往返保留滚动位置');
  }

  // --- 10. 切 tab 的 loading 占位期间不漏显上一个 tab 的预览内容 ---
  {
    // README 当前为预览态（第 9 节结束时）；用慢响应打开新文件，检查 loading 中间态
    const origGet = getContent;
    getContent = () => new Promise((r) => setTimeout(() => r({ ok: true, content: 'x', mtime: 1 }), 80));
    const p = window.__open('slow.txt');   // 不 await：检查 loading 中间态
    await wait(20);
    assert(doc.getElementById('fileViewMd').style.display === 'none', 'loading 占位期间预览容器隐藏（不漏显旧 tab）');
    assert(doc.getElementById('fileViewLoading').style.display === '', 'loading 占位期间显示加载提示');
    await p;
    await wait(20);
    getContent = origGet;
    assert(doc.getElementById('fileViewMd').style.display === 'none', '慢文件加载完成后 txt 编辑态预览容器仍隐藏');
  }

  // --- 10b. 预览打开后 loading 占位隐藏（回归：renderMdPreview 不隐藏 loading，顶部残留「加载中…」） ---
  {
    await window.__open('guide.md');   // 全新 tab 才会走 loading 占位 → 预览渲染链路
    await wait(20);
    assert(window.__fv().sub === 'guide.md', 'guide.md 已打开');
    assert(doc.getElementById('fileViewLoading').style.display === 'none', 'md 预览打开后 loading 占位隐藏');
    assert(doc.getElementById('fileViewMd').style.display === '', 'md 预览容器可见');
  }

  // --- 11. TOC 锚点：标题补 id + 点击滚动（回归：手型可点但不跳转） ---
  {
    const mdEl11 = doc.getElementById('fileViewMd');
    const html11 = mdEl11.innerHTML;
    assert(html11.includes('id="简介"'), '标题补挂 GitHub 风格 id（中文保留）');
    assert(html11.includes('id="重复标题"'), '重复标题第一个不加后缀');
    assert(html11.includes('id="重复标题-1"'), '重复标题第二个加 -1 后缀');
    // slug 规则与 GitHub 一致：下划线保留、多空格逐字符转 '-'
    assert(window.fvMdSlug('foo_bar baz  qux') === 'foo_bar-baz--qux', 'slug：下划线保留、连续空格逐字符转连字符');
    assert(window.fvMdSlug('A (v1.2) [x]') === 'a-v12-x', 'slug：标点去除、点号去除');
    // link_open 规则：锚点链接不加 target="_blank"（新开页会吞掉页内跳转），外链仍加
    {
      const mkToken = (href) => ({
        attrs: [['href', href]],
        attrSet(k, v) { this.attrs.push([k, v]); },
        attrGet(k) { const hit = this.attrs.find(([n]) => n === k); return hit ? hit[1] : null; },
      });
      const rule = window.fvMd().renderer.rules.link_open;
      const t1 = mkToken('#sec'); rule([t1], 0, {}, null, { renderToken: () => '' });
      assert(!t1.attrs.some(([k]) => k === 'target'), '锚点链接不加 target=_blank');
      const t2 = mkToken('https://e.com'); rule([t2], 0, {}, null, { renderToken: () => '' });
      assert(t2.attrs.some(([k, v]) => k === 'target' && v === '_blank'), '外链仍加 target=_blank');
    }
    // 点击委托：点锚点滚动预览容器到目标标题
    mdEl11.scrollTop = 0;
    const anchor = [...mdEl11.querySelectorAll('a')].find((a) => a.getAttribute('href') === '#简介');
    assert(!!anchor, 'TOC 锚点链接存在');
    // jsdom 无布局（getBoundingClientRect 全 0）：stub 目标标题的视口位置模拟真实滚动
    const targetH = mdEl11.querySelector('[id="简介"]');
    targetH.getBoundingClientRect = () => ({ top: 500 });
    anchor.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    assert(mdEl11.scrollTop > 0, '点击锚点后预览容器滚动到目标标题');
    // 链接目标不存在的锚点：不滚动、不报错、不导航
    mdEl11.scrollTop = 0;
    const bad = doc.createElement('a');
    bad.setAttribute('href', '#不存在');
    mdEl11.appendChild(bad);
    bad.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    assert(mdEl11.scrollTop === 0, '点击不存在的锚点不滚动不报错');
    bad.remove();
    // 畸形 % 序列的 href：decode 抛异常路径，静默不动不报错
    const malformed = doc.createElement('a');
    malformed.setAttribute('href', '#a%zz');
    mdEl11.appendChild(malformed);
    malformed.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    assert(mdEl11.scrollTop === 0, '畸形 % 序列 href 静默不动不报错');
    malformed.remove();
  }

  // --- 12. 预览回顶浮动按钮：滚动超一屏浮现、点击平滑回顶、接近顶部隐藏、非预览态隐藏 ---
  // 显隐断言走 .show 类（实现用 opacity+pointer-events 过渡，display 常驻）
  {
    const mdEl12 = doc.getElementById('fileViewMd');
    const btn = window.__topBtn();
    const btnShown = () => btn.classList.contains('show');
    // jsdom 无布局：stub clientHeight 模拟一屏高度
    Object.defineProperty(mdEl12, 'clientHeight', { value: 600, configurable: true });
    mdEl12.scrollTop = 0;
    // 前置：guide.md 已在预览态（11 节末）
    assert(btn && !btnShown(), '回顶按钮初始（顶部）隐藏');
    mdEl12.scrollTop = 700;                      // > clientHeight：浮现
    mdEl12.dispatchEvent(new window.Event('scroll', { bubbles: false }));
    assert(btnShown(), '滚动超过一屏后回顶按钮浮现');
    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    assert(mdEl12.scrollTop === 0, '点击回顶按钮滚回顶部');
    assert(doc.getElementById('fileViewLoading').style.display === 'none', '回顶不误显 loading');
    mdEl12.scrollTop = 100;                      // <= clientHeight：隐藏
    mdEl12.dispatchEvent(new window.Event('scroll', { bubbles: false }));
    assert(!btnShown(), '接近顶部后回顶按钮隐藏');
    // 编辑态隐藏（预览→编辑）
    window.__toggle();
    assert(!btnShown(), '编辑态回顶按钮隐藏');
    window.__toggle();
    // 切到非 md tab 再切回：非 md 编辑态隐藏，切回预览态顶部隐藏
    await window.__open('notes.txt');
    assert(!btnShown(), '非 md tab 回顶按钮隐藏');
    await window.__open('guide.md');
    assert(!btnShown(), '切回 md 预览（顶部）回顶按钮隐藏');
  }

  console.log(process.exitCode ? '\n有失败项' : '\n全部通过');
  process.exit(process.exitCode ? 1 : 0);
})();
