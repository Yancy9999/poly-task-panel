'use strict';
// SVN 抽屉「切回项目」busy 指示语义：凭 status-refresh-done 的 busy+manual 区分
// 「手动刷新触发的重扫」（用户在等 → 恢复转圈/禁用态并接续轮询）与「TTL 过期的
// 例行重扫」（没人请求它 → 静默，数据到了由轮询回填，绝不打扰）。
// 探测与后台 status 串行（先探测后拉取），防 status 回包复位 busy 态的竞态。
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
// 预置前端渲染缓存（svnStatusMemo.v1）：切回项目走 memo 秒出分支
window.localStorage.setItem('svnStatusMemo.v1', JSON.stringify({ p1: memoData }));

// 服务端状态桩（按用例拨动）
let busyNow = false;    // status-refresh-done.busy（重扫进行中）
let manualNow = false;  // status-refresh-done.manual（手动刷新触发）
let staleNow = false;   // svn/status 响应是否带 stale 标志
let refreshDoneCalls = 0;
window.fetch = async (url) => {
  const u = String(url);
  const j = (body) => ({ json: async () => body });
  if (u.endsWith('/api/projects')) return j(projects);
  if (u.endsWith('/api/settings')) return j({ ok: true, settings: {} });
  if (u.includes('/sessions')) return j([]);
  // 注意先于 /svn/status 判断（路由前缀包含）
  if (u.includes('/svn/status-refresh-done')) { refreshDoneCalls++; return j({ ok: true, done: false, busy: busyNow, manual: manualNow && busyNow }); }
  if (u.includes('/svn/status')) return j({ ...memoData, stale: staleNow });
  if (u.includes('/svn/log')) return j({ ok: true, commits: [] });
  if (u.includes('/svn/remote-status')) return j({ ok: false }); // 短路：不参与本组断言
  if (u.includes('/git/status')) return j({ notRepo: true }); // 先探 git → notRepo 走 SVN 分支
  return j({ ok: true }); // git/fetch 等其余请求
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
  const spin = () => doc.getElementById('svnUrlSpin');
  const btn = () => doc.getElementById('gitDrawerRefresh');

  // --- 场景 1：手动刷新触发的重扫进行中（busy+manual）切回 → 恢复转圈/禁用 ---
  busyNow = true; manualNow = true; staleNow = true;
  window.openGitDrawer('p1');
  await wait(50);
  assert(refreshDoneCalls > 0, '切回项目后查询了 status-refresh-done（busy+manual 探测）');
  assert(!!spin() && spin().hidden === false, '手动重扫进行中：切回后 spinner 转圈恢复');
  assert(!!btn() && btn().disabled === true, '手动重扫进行中：切回后刷新按钮禁用恢复');

  // --- 场景 2：例行重扫（busy 但 manual=false）切回 → 不转圈、按钮可用 ---
  busyNow = true; manualNow = false; staleNow = true;
  window.openGitDrawer('p1'); // 同项目重开也走 loadGitStatus 全量复位
  await wait(50);
  assert(!!spin() && spin().hidden === true, '例行重扫：切回后不转圈（静默等回填）');
  assert(!!btn() && btn().disabled === false, '例行重扫：刷新按钮可用');

  // --- 场景 3：无重扫、缓存新鲜（busy=false 且不带 stale）切回 → 全静默 ---
  busyNow = false; staleNow = false;
  window.openGitDrawer('p1');
  await wait(50);
  assert(!!spin() && spin().hidden === true, '无重扫：切回后不转圈');
  assert(!!btn() && btn().disabled === false, '无重扫：刷新按钮可用');

  // --- 场景 4（卡死回归）：探测时手动重扫在跑，但 status 回包时恰好扫完（无 stale）
  // → 不得置 busy：此时无 stale 就没有轮询去复位，置上即永久卡死转圈/禁按钮
  busyNow = true; manualNow = true; staleNow = false;
  window.openGitDrawer('p1');
  await wait(50);
  assert(!!spin() && spin().hidden === true, '探测后重扫恰好完成：不转圈（防卡死）');
  assert(!!btn() && btn().disabled === false, '探测后重扫恰好完成：刷新按钮可用');

  console.log('\nsvn 切回 busy 指示语义（manual 分流）jsdom 验证完成');
  process.exit(process.exitCode || 0); // 遗留轮询 timer 会让事件循环不退出，显式结束
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
