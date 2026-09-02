'use strict';
// 跨项目异步竞态归属校验（jsdom）
// 回归背景：Git/SVN 抽屉的 log/branches、文件抽屉目录缓存等异步请求没有归属校验，
// 慢仓库上切项目后旧项目的响应回来直接写入新项目的缓存/列表——新项目抽屉渲染出
// 旧项目的数据。现实现统一 reqProj 模式：fetch 前捕获 gitDrawerProjectId（或
// fileDrawerProjectId），回来后不一致则丢弃响应。
// 覆盖：loadGitLog / loadSvnLog / loadGitBranches / loadFileDir 四条路径，
//       「请求发出 → 切项目 → 响应返回」时序下旧数据不得写入新项目状态。
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
if (!scripts.length) throw new Error('未找到内联脚本');
const inlineScript = scripts[scripts.length - 1][1] + `
window.__st = () => ({
  gitDrawerProjectId, gitLogCache, gitBranchesCache, gitRemoteBranchesCache,
  svnLogCache, fileDrawerProjectId,
  rootCache: renderFileTree.cache ? [...renderFileTree.cache.entries()] : [],
});
`;

const dom = new JSDOM(html, {
  url: 'http://localhost:7777/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;

// 可控 fetch：按 URL 前缀分发到测试注册的 handler（默认立即 ok）。
// gate 一律按「含项目 id 的 URL 段」注册（如 /p1/git/log），不按调用次序区分——
// openGitDrawer 本身会触发后台加载链，按次序计数会和测试假设错位。
const fetchHandlers = new Map(); // key(urlIncludes) -> (url) => body
window.fetch = async (url) => {
  const u = String(url);
  for (const [key, fn] of fetchHandlers) {
    if (u.includes(key)) return { json: async () => fn(u) };
  }
  // 注意精确匹配：/api/projects/p2/git/status 也包含 "/api/projects"，
  // 用 includes 会让所有项目级 API 拿到项目数组（data.ok 为 undefined，
  // loadGitStatus 提前 return，branches/log 后台链整个不触发）
  const body = u.endsWith('/api/projects')
    ? [
        { id: 'p1', name: 'Alpha', type: 'folder', running: false, projectPath: 'D:/a' },
        { id: 'p2', name: 'Beta', type: 'folder', running: false, projectPath: 'D:/b' },
      ]
    : u.includes('/git/status')
      ? { ok: true, branch: 'main', files: [], ahead: null, behind: null } // 完整 status：让 loadGitStatus 走正常 git 分支（顺带触发 loadGitBranches）
      : u.includes('/git/branches')
        ? { ok: true, branches: ['p2-branch'], remote: [], remoteName: 'origin' } // 非 gate 挂起的 branches 请求（如切项目后的 p2）正常回数据
        : u.includes('/git/log') || u.includes('/svn/log')
          ? { ok: true, commits: [] } // 带 commits：log 加载走完整写入路径（gitLogCache 不至于被置 undefined）
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

// 释放 pending 响应（deferred fetch）
function deferred() {
  let resolveBody;
  const promise = new Promise((r) => { resolveBody = r; });
  return { promise, resolve: resolveBody };
}

(async () => {
  await wait(20);
  // Git/SVN 抽屉的历史区默认折叠（isGitSectionFolded/isSvnSectionFolded 对 history
  // 未操作过时返回 true），折叠态下 loadGitLog/loadSvnLog 在容器守卫处直接 return——
  // 请求发不出去，断言会「真空通过」。预置 localStorage 展开历史区，让容器真实渲染。
  window.localStorage.setItem('gitSectionFold', JSON.stringify({ history: false }));
  window.localStorage.setItem('svnSectionFold', JSON.stringify({ history: false }));
  await window.loadProjects();
  const doc = window.document;

  // 打开 p1 的 Git 抽屉（建 gitLogList 等容器）
  window.openGitDrawer('p1');
  await wait(30);

  // ---------- 1. loadGitLog：慢响应期间切项目，旧 commits 不写入新项目 ----------
  {
    // 绑定显式归位 p1（前序块可能停在 p2）
    window.openGitDrawer('p1');
    await wait(30);
    const gate = deferred();
    fetchHandlers.set('/p1/git/log', () => gate.promise);
    const logPromise = window.loadGitLog(); // p1 的请求挂起
    await wait(5);
    window.openGitDrawer('p2'); // 切到 p2（同步改 gitDrawerProjectId 并触发新加载）
    await wait(5);
    gate.resolve({ ok: true, commits: [{ hash: 'old1', author: 'x', at: 0, subject: 'old commit', files: [] }] });
    await logPromise;
    await wait(10);
    // p2 的后续加载走默认 handler（立即 resolve 空提交），p1 的迟到响应不得污染
    assert(!window.__st().gitLogCache.some(c => c.hash === 'old1'),
      'loadGitLog：切项目后旧响应不写入 gitLogCache');
    fetchHandlers.delete('/p1/git/log');
  }

  // ---------- 2. loadSvnLog：同规则 ----------
  // 脚手架是 git 仓库 mock，SVN body 永远不渲染，#svnLogList 不存在——loadSvnLog
  // 在容器守卫处 return，什么都不会发生。手动注入容器（含折叠守卫要过的展开态）
  // 让 svn/log 请求真正发出。
  {
    window.openGitDrawer('p1');
    await wait(30);
    const fakeSvnLogList = doc.createElement('div');
    fakeSvnLogList.id = 'svnLogList';
    doc.body.appendChild(fakeSvnLogList);
    const gate = deferred();
    fetchHandlers.set('/p1/svn/log', () => gate.promise);
    const logPromise = window.loadSvnLog();
    await wait(5);
    window.openGitDrawer('p2');
    await wait(5);
    gate.resolve({ ok: true, commits: [{ rev: '99', author: 'x', at: 0, subject: 'stale svn', files: [] }] });
    await logPromise;
    await wait(10);
    assert(!window.__st().svnLogCache.some(c => c.rev === '99'),
      'loadSvnLog：切项目后旧响应不写入 svnLogCache');
    fetchHandlers.delete('/p1/svn/log');
    fakeSvnLogList.remove();
  }

  // ---------- 3. loadGitBranches：旧分支列表不写入新项目 ----------
  // gate 按 URL 里的项目 id 分发（/p1/git/branches），只挂起 p1 的请求；
  // openGitDrawer('p2') 触发的 p2 后台加载链走默认 handler，正常写入。
  {
    window.openGitDrawer('p1');
    await wait(30);
    const gate = deferred();
    fetchHandlers.set('/p1/git/branches', () => gate.promise);
    const brPromise = window.loadGitBranches();
    await wait(5);
    window.openGitDrawer('p2');
    await wait(30); // 等 p2 自己的 branches 响应写入
    gate.resolve({ ok: true, branches: ['stale-branch'], remote: ['origin/stale'], remoteName: 'origin' });
    await brPromise;
    await wait(10);
    assert(!window.__st().gitBranchesCache.includes('stale-branch'),
      'loadGitBranches：切项目后旧分支列表不写入 gitBranchesCache');
    assert(!window.__st().gitRemoteBranchesCache.includes('origin/stale'),
      'loadGitBranches：旧远程分支列表同样不写入');
    assert(window.__st().gitBranchesCache.includes('p2-branch'),
      'loadGitBranches：p2 自己的响应正常写入');
    fetchHandlers.delete('/p1/git/branches');
  }

  // ---------- 4. loadGitBranches 正常路径：归属未变时数据照常写入（防过度拦截） ----------
  {
    window.openGitDrawer('p1');
    await wait(30);
    fetchHandlers.set('/p1/git/branches', () => ({ ok: true, branches: ['main', 'dev'], remote: ['origin/dev'], remoteName: 'origin' }));
    await window.loadGitBranches();
    assert(window.__st().gitBranchesCache.includes('main') && window.__st().gitBranchesCache.includes('dev'),
      'loadGitBranches：归属未变时正常写入（不过度拦截）');
    fetchHandlers.delete('/p1/git/branches');
  }

  // ---------- 5. loadFileDir：切项目后旧目录条目不写进新项目缓存 ----------
  {
    window.openFileDrawer('p1');
    await wait(20);
    const gate = deferred();
    fetchHandlers.set('/files', () => gate.promise);
    const dirPromise = window.loadFileDir('subdir', true); // toCache 路径
    await wait(5);
    window.openFileDrawer('p2'); // 切项目：清空缓存
    await wait(5);
    gate.resolve({ ok: true, items: [{ name: 'stale.txt', isDir: false, size: 1 }] });
    await dirPromise;
    await wait(10);
    const st = window.__st();
    const p2Root = st.rootCache.find(([k]) => k === 'subdir');
    assert(!p2Root || !p2Root[1].some(i => i.name === 'stale.txt'),
      'loadFileDir：切项目后旧项目目录条目不写入新项目缓存');
    fetchHandlers.delete('/files');
  }

  // ---------- 6. loadFileDir 正常路径：归属未变时照常写缓存 ----------
  {
    fetchHandlers.set('/files', () => ({ ok: true, items: [{ name: 'fresh.txt', isDir: false, size: 1 }] }));
    await window.loadFileDir('subdir', true);
    const st = window.__st();
    const entry = st.rootCache.find(([k]) => k === 'subdir');
    assert(entry && entry[1].some(i => i.name === 'fresh.txt'),
      'loadFileDir：归属未变时正常写入缓存');
    fetchHandlers.delete('/files');
  }

  console.log(process.exitCode ? '\n有失败项' : '\n全部通过');
})();
