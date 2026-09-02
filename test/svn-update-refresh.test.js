'use strict';
// SVN「更新」后刷新不得闪加载中/骨架屏：svnUpdate 复用前端 memo 缓存走
// stale-while-revalidate 路径（与 svnCommit 一致）——旧列表秒出，后台拉新 status
// 有变化才回填。回归背景：曾在此处删 memo 导致 loadGitStatus 走骨架屏路径，
// 大工作副本（服务端同步重扫 10s+）整个抽屉白等十几秒。
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
if (!scripts.length) throw new Error('未找到内联脚本');
const inlineScript = scripts[scripts.length - 1][1];

const dom = new JSDOM(html, { url: 'http://localhost:7777/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;

const projects = [{ id: 'p1', name: 'SVN 项目', type: 'node', projectPath: 'D:/wc' }];
const memoData = { ok: true, rev: '42', url: 'https://svn.example.com/repo/trunk', fetchedAt: Date.now(), files: [{ st: 'M', file: 'a.txt' }] };
// 更新后的新 status：rev 提升（模拟 update 拉到远端新版本）
const freshData = { ...memoData, rev: '43', fetchedAt: Date.now() };
// 预置前端渲染缓存（svnStatusMemo.v1）：svnUpdate 刷新时走 memo 秒出分支
window.localStorage.setItem('svnStatusMemo.v1', JSON.stringify({ p1: memoData }));

// 服务端状态桩：status 全程拖慢（模拟大工作副本同步重扫 10s+ 的缩放版），
// 保证 memo 秒出渲染与新数据回填两个阶段可被稳定观察
const statusDelayMs = 300;
let statusCalls = 0;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
window.fetch = async (url, opts) => {
  const u = String(url);
  const j = (body) => ({ json: async () => body });
  if (u.endsWith('/api/projects')) return j(projects);
  if (u.endsWith('/api/settings')) return j({ ok: true, settings: {} });
  if (u.includes('/sessions')) return j([]);
  if (u.includes('/svn/update')) return j({ ok: true, msg: 'Updated to revision 43.' });
  // 注意先于 /svn/status 判断（路由前缀包含）；status-meta 同样被拖慢（骨架路径会撞上）
  if (u.includes('/svn/status-refresh-done')) return j({ ok: true, done: false, busy: false, manual: false });
  if (u.includes('/svn/status')) { statusCalls++; await delay(statusDelayMs); return j(freshData); }
  if (u.includes('/svn/log')) return j({ ok: true, commits: [] });
  if (u.includes('/svn/remote-status')) return j({ ok: false }); // 短路：不参与本组断言
  if (u.includes('/git/status')) return j({ notRepo: true }); // 先探 git → notRepo 走 SVN 分支
  return j({ ok: true });
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
  const body = () => doc.getElementById('gitDrawerBody');
  const updateBtn = () => body().querySelector('button[data-net="update"]');

  // 打开抽屉：memo 路径秒出列表（后台 status 被拖慢，r42 阶段可观察）
  window.openGitDrawer('p1');
  await wait(50);
  assert(!!body().querySelector('#svnFilesArea'), '打开抽屉：memo 缓存秒出变更列表');
  assert(body().textContent.includes('r42'), '打开抽屉：显示 memo 版本号 r42');

  // 点更新：update 秒回，loadGitStatus 走 memo 分支（status 在途 300ms）
  const updatePromise = window.svnUpdate();
  await wait(100);
  const htmlDuring = body().innerHTML;
  assert(!htmlDuring.includes('git-loading') && !htmlDuring.includes('加载中'), '更新刷新期间：不显示「加载中」');
  assert(!htmlDuring.includes('变更列表加载中'), '更新刷新期间：不出现骨架屏文案');
  assert(!!body().querySelector('#svnFilesArea'), '更新刷新期间：旧变更列表保持可见');
  assert(body().textContent.includes('r42'), '更新刷新期间：仍显示旧版本号（memo 秒出）');
  assert(!!updateBtn() && updateBtn().disabled === true, '更新刷新期间：更新按钮保持禁用（防重复点击）');
  await updatePromise;

  // 后台拉到新 status（rev 43）：自动回填，版本号与列表更新
  await wait(statusDelayMs + 200);
  assert(statusCalls >= 2, '更新后拉取了新 status');
  assert(body().textContent.includes('r43'), '新 status 回填：版本号更新为 r43');
  assert(!!body().querySelector('#svnFilesArea'), '新 status 回填后列表正常渲染');
  assert(!!updateBtn() && updateBtn().disabled === false, '更新完成后更新按钮恢复可用');

  console.log('\nsvn 更新后刷新不闪加载中 jsdom 验证完成');
  process.exit(process.exitCode || 0); // 遗留轮询 timer 会让事件循环不退出，显式结束
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
