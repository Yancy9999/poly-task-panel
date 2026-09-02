// 抽屉渲染边缘路径（jsdom）
// 三块回归：
//   1. 提交说明草稿回填——Git/SVN 整段重渲染会重建 textarea，草稿不能丢
//     （saveXxxCommitMsg 在重渲前抓值，restoreXxxCommitMsg 在重建后回填）。
//   2. SVN 骨架 null 容错——status-meta 回包 rev/url 为 null 时骨架照常渲染
//     （r? 占位 + 「SVN 工作副本」占位），不抛异常白屏。
//   3. ANSI 分块——流式输出把 ANSI 序列拆到两段（\x1b[3 | 2m、孤立 \x1b）时，
//     appendLog 缓冲残尾等下一段凑齐，不把半截序列当字面文本渲染出乱码。
// 时序注意：renderGitBody/renderSvnBody 前需 gitStatus/svnStatus 就绪；appendLog
// 走 pendingRender → requestAnimationFrame（pretendToBeVisual 提供 raf）。
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
if (!scripts.length) throw new Error('未找到内联脚本');
const inlineScript = scripts[scripts.length - 1][1] + `
window.__draft = {
  get git() { return gitCommitMsgDraft; },
  get svn() { return svnCommitMsgDraft; },
  saveGit() { saveGitCommitMsg(); },
  restoreGit() { restoreGitCommitMsg(); },
  saveSvn() { saveSvnCommitMsg(); },
  restoreSvn() { restoreSvnCommitMsg(); },
};
window.__ansi = {
  toHtml: (t) => ansiToHtml(t),
  append: (paneId, text) => appendLog({ id: paneId }, text),
  buffer: (paneId) => paneBuffer(paneId),
  flush: () => flushPendingRender(),
};
window.__renderSkeleton = () => renderSvnSkeleton();
window.__setSvnStatus = (s) => { svnStatus = s; };
// 注意：后续 window.eval 看不到 inlineScript 顶层 let 绑定（gitStatus/svnStatus 等），
// 在 eval 里赋值会落到 window 属性、被页面函数读到的还是旧绑定——所有状态变更必须
// 走这里定义的探针（探针与页面函数共享同一词法作用域）
window.__setGitStatus = (s) => { gitStatus = s; };
window.__renderGitBody = () => renderGitBody();
window.__renderSvnBody = () => renderSvnBody();
`;

const dom = new JSDOM(html, {
  url: 'http://localhost:7777/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;

window.fetch = async (url) => {
  const u = String(url);
  // 精确匹配项目列表（/api/projects/p1/... 也含 "/api/projects"，见 drawer-race-guard 的教训）
  const body = u.endsWith('/api/projects')
    ? [{ id: 'p1', name: 'Alpha', type: 'folder', running: false, projectPath: 'D:/a' }]
    : u.includes('/git/status')
      ? { ok: true, branch: 'main', files: [], ahead: null, behind: null }
      : u.includes('/git/log') || u.includes('/svn/log')
        ? { ok: true, commits: [] }
        : { ok: true };
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

  // ========== 1. Git 提交说明草稿回填 ==========
  {
    window.openGitDrawer('p1');
    await wait(30);
    // renderGitBody 重建 body：此时 files 为空，无提交框——补一个有变更的 status 重渲
    window.__setGitStatus({ branch: 'main', files: [{ file: 'a.txt', x: 'M', y: ' ' }], ahead: null, behind: null });
    window.__renderGitBody();
    const ta = doc.getElementById('gitCommitMsg');
    assert(!!ta, 'Git：变更非空时提交说明框渲染');
    ta.value = 'fix: 草稿内容';
    // 模拟整段重渲前的抓取 + 重建 + 回填（saveGitCommitMsg 由 renderGitBody 开头调用）
    window.__draft.saveGit();
    window.__setGitStatus({ branch: 'main', files: [{ file: 'a.txt', x: 'M', y: ' ' }, { file: 'b.txt', x: '?', y: '?' }], ahead: null, behind: null });
    window.__renderGitBody();
    const ta2 = doc.getElementById('gitCommitMsg');
    assert(!!ta2 && ta2 !== ta, 'Git：重渲后 textarea 是新节点');
    assert(ta2.value === 'fix: 草稿内容', 'Git：草稿跨整段重渲染保留');
  }

  // ========== 2. SVN 提交说明草稿回填 ==========
  {
    window.__setSvnStatus({ rev: '100', url: 'https://svn.example/trunk', files: [{ file: 'x.txt', st: 'M' }] });
    window.__renderSvnBody();
    const ta = doc.getElementById('svnCommitMsg');
    assert(!!ta, 'SVN：body 渲染出提交说明框');
    ta.value = 'svn 草稿';
    window.__draft.saveSvn();
    window.__renderSvnBody(); // 整段重渲（内部先 save 再 restore）
    const ta2 = doc.getElementById('svnCommitMsg');
    assert(!!ta2 && ta2 !== ta, 'SVN：重渲后 textarea 是新节点');
    assert(ta2.value === 'svn 草稿', 'SVN：草稿跨整段重渲染保留');
  }

  // ========== 3. SVN 骨架 null 容错 ==========
  {
    window.__setSvnStatus({ rev: null, url: null, files: null });
    let threw = false;
    try { window.__renderSkeleton(); } catch (e) { threw = true; console.error(e.message); }
    assert(!threw, '骨架：rev/url 为 null 不抛异常');
    const body = doc.getElementById('gitDrawerBody');
    assert(body.textContent.includes('SVN 工作副本'), '骨架：url 为 null 显示「SVN 工作副本」占位');
    assert(body.textContent.includes('r?'), '骨架：rev 为 null 显示 r? 占位');
  }

  // ========== 4. ANSI：完整序列转 HTML ==========
  {
    const html1 = window.__ansi.toHtml('\x1b[31m红\x1b[0m末尾');
    assert(html1.includes('<span style="color:') && html1.includes('红') && html1.endsWith('末尾'), 'ANSI：颜色序列转 span 且 reset 后文本裸出');
    assert(!html1.includes('\x1b'), 'ANSI：输出不残留 ESC 字符');
  }

  // ========== 5. ANSI：序列拆两段（\x1b[3 | 2m）不出现乱码 ==========
  {
    const paneId = 'test-pane-1';
    // 建 log 容器（appendLogLine 需要 .pane-log[data-log-pane]）
    const logEl = doc.createElement('div');
    logEl.className = 'pane-log';
    logEl.setAttribute('data-log-pane', paneId);
    doc.getElementById('logConsoleBody').appendChild(logEl);
    window.__ansi.append(paneId, 'text before \x1b[3');
    window.__ansi.append(paneId, '2m red text\x1b[0m');
    window.__ansi.flush();
    await wait(30); // 等 raf
    const rendered = logEl.textContent;
    assert(rendered.includes('text before') && rendered.includes('red text'), 'ANSI 分块：两段拼齐后文本完整');
    assert(!rendered.includes('[3') && !rendered.includes('[32m'), 'ANSI 分块：无半截序列字面乱码');
    assert(window.__ansi.buffer(paneId) === '', 'ANSI 分块：序列凑齐后残尾缓冲清空');
  }

  // ========== 6. ANSI：孤立 ESC 结尾（\x1b | [32m…）同样缓冲 ==========
  {
    const paneId = 'test-pane-2';
    const logEl = doc.createElement('div');
    logEl.className = 'pane-log';
    logEl.setAttribute('data-log-pane', paneId);
    doc.getElementById('logConsoleBody').appendChild(logEl);
    window.__ansi.append(paneId, 'plain \x1b');
    assert(window.__ansi.buffer(paneId) === '\x1b', 'ANSI：孤立 ESC 进入残尾缓冲');
    assert(!logEl.textContent.includes('\x1b'), 'ANSI：孤立 ESC 不被当文本渲染');
    window.__ansi.append(paneId, '[32mgreen\x1b[0m');
    window.__ansi.flush();
    await wait(30);
    const html2 = logEl.innerHTML;
    assert(html2.includes('green') && html2.includes('color:'), 'ANSI：跨段序列凑齐后颜色生效');
    assert(!logEl.textContent.includes('[32m'), 'ANSI：跨段后无字面 [32m 乱码');
  }

  console.log(process.exitCode ? '\n有失败项' : '\n全部通过');
})();
