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

const projects = [
  { id: 'p1', name: 'SVN 项目', type: 'node', projectPath: 'D:/wc' },
  { id: 'p2', name: 'SVN 项目2', type: 'node', projectPath: 'D:/wc2' },
  { id: 'p3', name: 'SVN 项目3', type: 'node', projectPath: 'D:/wc3' },
  { id: 'p4', name: 'SVN 项目4', type: 'node', projectPath: 'D:/wc4' },
  { id: 'p5', name: 'SVN 项目5', type: 'node', projectPath: 'D:/wc5' },
  { id: 'p6', name: 'SVN 项目6', type: 'node', projectPath: 'D:/wc6' },
];
// memo 带 behind（远端检测写入前端状态）；服务端 status 响应不带 behind（真实服务端如此，
// behind 只由 remote-status 检测写入，applySvnStatus 负责同项目内继承）
const memoData = { ok: true, rev: '42', url: 'https://svn.example.com/repo/trunk', behind: 3, fetchedAt: Date.now(), files: [{ st: 'M', file: 'a.txt' }] };
// 更新后的新 status：rev 提升（模拟 update 拉到远端新版本）
const freshData = { ok: true, rev: '43', url: memoData.url, fetchedAt: Date.now(), files: memoData.files };
// 场景 2 用：更新后远端无变化（fresh 与 memo 完全一致 → loadGitStatus 走「无变化不重渲染」分支）
const memoData2 = { ...memoData, url: 'https://svn.example.com/repo/trunk2' };
const freshData2 = { ok: true, rev: '42', url: memoData2.url, fetchedAt: Date.now(), files: memoData2.files };
// 场景 3 用：文件有变化（走 applySvnStatus → 触发打开抽屉时的远端检测）但版本号未变
const memoData3 = { ...memoData, url: 'https://svn.example.com/repo/trunk3', files: [{ st: 'M', file: 'c.txt' }] };
const freshData3 = { ok: true, rev: '42', url: memoData3.url, fetchedAt: Date.now(), files: [{ st: 'M', file: 'c.txt' }, { st: 'M', file: 'd.txt' }] };
// 场景 4 用：切项目目标，fresh 与 memo 一致（no-change 路径，不触发额外远端检测）
const memoData4 = { ok: true, rev: '42', url: 'https://svn.example.com/repo/trunk4', behind: 2, fetchedAt: Date.now(), files: [{ st: 'M', file: 'e.txt' }] };
const freshData4 = { ok: true, rev: '42', url: memoData4.url, fetchedAt: Date.now(), files: memoData4.files };
// 场景 5 用：p5 为发起更新的项目（behind:4），p6 为在途期间切过去的项目（behind:1）
const memoData5 = { ok: true, rev: '42', url: 'https://svn.example.com/repo/trunk5', behind: 4, fetchedAt: Date.now(), files: [{ st: 'M', file: 'f.txt' }] };
const freshData5 = { ok: true, rev: '43', url: memoData5.url, fetchedAt: Date.now(), files: memoData5.files };
const memoData6 = { ok: true, rev: '42', url: 'https://svn.example.com/repo/trunk6', behind: 1, fetchedAt: Date.now(), files: [{ st: 'M', file: 'g.txt' }] };
const freshData6 = { ok: true, rev: '42', url: memoData6.url, fetchedAt: Date.now(), files: memoData6.files };
// 预置前端渲染缓存（svnStatusMemo.v1）：svnUpdate 刷新时走 memo 秒出分支
window.localStorage.setItem('svnStatusMemo.v1', JSON.stringify({ p1: memoData, p2: memoData2, p3: memoData3, p4: memoData4, p5: memoData5, p6: memoData6 }));

// 服务端状态桩：status 全程拖慢（模拟大工作副本同步重扫 10s+ 的缩放版），
// 保证 memo 秒出渲染与新数据回填两个阶段可被稳定观察
const statusDelayMs = 300;
// 按项目覆盖 status 延迟：场景 4 拖慢 p6 的后台 status，使其落在 p5 更新完成之后
const statusDelayByProj = { p6: 800 };
let statusCalls = 0;
// remote-status 延迟（默认 0 = 秒回）；场景 3 调大模拟打开抽屉时的远端检测慢于 update
let remoteDelayMs = 0;
// update 接口延迟（默认 0 = 秒回）；场景 4 调大让「更新在途」可观察
let updateDelayMs = 0;
// 模拟真实服务端：update 成功后工作副本 BASE 已同步到远端最新，
// 其后该项目收到的 remote-status 应返回空 revs（没有待更新提交）
const updatedProjects = new Set();
const pidOf = (s) => (s.match(/\/api\/projects\/([^/]+)\//) || [])[1];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
window.fetch = async (url, opts) => {
  const u = String(url);
  const j = (body) => ({ json: async () => body });
  const pid = pidOf(u);
  if (u.endsWith('/api/projects')) return j(projects);
  if (u.endsWith('/api/settings')) return j({ ok: true, settings: {} });
  if (u.includes('/sessions')) return j([]);
  if (u.includes('/svn/update')) { await delay(updateDelayMs); updatedProjects.add(pid); return j({ ok: true, msg: 'Updated to revision 43.' }); }
  // 注意先于 /svn/status 判断（路由前缀包含）；status-meta 同样被拖慢（骨架路径会撞上）
  if (u.includes('/svn/status-refresh-done')) return j({ ok: true, done: false, busy: false, manual: false });
  if (u.includes('/svn/status')) { statusCalls++; await delay(statusDelayByProj[pid] || statusDelayMs); return j(u.includes('/p3/') ? freshData3 : u.includes('/p2/') ? freshData2 : u.includes('/p5/') ? freshData5 : u.includes('/p6/') ? freshData6 : freshData); }
  if (u.includes('/svn/log')) return j({ ok: true, commits: [] });
  // revs 数组格式：svnRealBehind 走排除口径；更新后该项目 revs 为空（BASE 已同步）
  if (u.includes('/svn/remote-status')) { await delay(remoteDelayMs); return j(updatedProjects.has(pid) ? { ok: true, remoteRev: '45', revs: [] } : { ok: true, remoteRev: '45', revs: [43, 44, 45] }); }
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

  // 点更新：update 秒回，loadGitStatus 走 memo 分支（status 在途 300ms）。
  // 按钮禁用是 svnUpdate 同步前置动作，发起后立即观察；后台刷新期间防重复点击
  // 由 svnNetInFlight 重入守卫兜底（更新操作本身秒级完成即恢复按钮）
  const updatePromise = window.svnUpdate();
  assert(!!updateBtn() && updateBtn().disabled === true, '更新发起：按钮立即禁用（防重复点击）');
  await wait(100);
  const htmlDuring = body().innerHTML;
  assert(!htmlDuring.includes('git-loading') && !htmlDuring.includes('加载中'), '更新刷新期间：不显示「加载中」');
  assert(!htmlDuring.includes('变更列表加载中'), '更新刷新期间：不出现骨架屏文案');
  assert(!!body().querySelector('#svnFilesArea'), '更新刷新期间：旧变更列表保持可见');
  assert(body().textContent.includes('r42'), '更新刷新期间：仍显示旧版本号（memo 秒出）');
  await updatePromise;

  // 后台拉到新 status（rev 43）：自动回填，版本号与列表更新
  await wait(statusDelayMs + 200);
  assert(statusCalls >= 2, '更新后拉取了新 status');
  assert(body().textContent.includes('r43'), '新 status 回填：版本号更新为 r43');
  assert(!!body().querySelector('#svnFilesArea'), '新 status 回填后列表正常渲染');
  assert(!!updateBtn() && updateBtn().disabled === false, '更新完成后更新按钮恢复可用');
  // 回归背景：memo 命中时 remote-status 检测有 60s 节流，更新前检测出的 behind
  // 徽标会一直挂在按钮上；本地清零后不等待节流窗口，立即消失
  assert(!updateBtn().querySelector('.git-ab.behind'), '更新成功后更新按钮上的 behind 徽标数字消失');
  assert(!body().textContent.includes('更新3'), '更新按钮不再显示旧 behind 数字');

  // ---------- 场景 2：更新后远端无变化（Already at revision） ----------
  // fresh 与 memo 完全一致 → loadGitStatus 走「无变化：仅替换对象」分支，不重渲染。
  // 回归背景：svnNetInFlight 期间 memo 秒出渲染的更新按钮带 disabled，此分支没人恢复它
  window.openGitDrawer('p2');
  await wait(statusDelayMs + 200); // 首次打开的后台 status 在途/完成均不影响后续断言
  assert(body().textContent.includes('r42'), '场景2：打开 p2 显示 memo 版本号 r42');
  const updateBtn2 = () => body().querySelector('button[data-net="update"]');
  assert(!!updateBtn2().querySelector('.git-ab.behind'), '场景2：更新前 behind 徽标存在（memo 带 behind:3）');
  await window.svnUpdate();
  assert(!!updateBtn2() && updateBtn2().disabled === false, '场景2：无变化分支下更新按钮也恢复可用');
  assert(!updateBtn2().querySelector('.git-ab.behind'), '场景2：无变化分支下 behind 徽标同样清零');

  // ---------- 场景 3：打开抽屉触发的远端检测晚于更新完成回包 ----------
  // 远端检测走 svn log 联网可能数秒：抽屉打开时按「更新前的 BASE」发起，若它在
  // update 清零之后才回包，旧数字会把刚清掉的徽标顶回来（原始 bug 的复发路径）。
  remoteDelayMs = 0;
  window.openGitDrawer('p3');
  await wait(50); // memo 秒出；远端检测要等后台 status 回包才发起（applySvnStatus 末尾触发）
  assert(!!body().querySelector('#svnFilesArea'), '场景3：打开 p3 memo 秒出列表');
  await wait(statusDelayMs + 100); // 后台 status 完成 → 远端检测已发起（remoteDelayMs=0 已回包并写徽标）
  assert(!!updateBtn().querySelector('.git-ab.behind'), '场景3：打开抽屉自动检测出 behind 徽标（复现前置）');
  // 现在拖慢远端检测，再完成 update：drawer-open 的检测已被 60s 节流挡住，
  // update 内 loadGitStatus 走 memo 分支不发新检测 → 时序上无并发检测可打架
  remoteDelayMs = 600;
  await window.svnUpdate();
  assert(!updateBtn().querySelector('.git-ab.behind'), '场景3：update 完成后徽标清零');
  remoteDelayMs = 0;
  await wait(50);
  assert(!updateBtn().querySelector('.git-ab.behind'), '场景3：后续无并发检测回包顶回旧数字');
  assert(!body().textContent.includes('更新3'), '场景3：旧 behind 数字不回显');

  // ---------- 场景 4：更新在途时切换项目 ----------
  // p5 更新在途（update 接口拖慢 500ms），期间切到 p6：清零必须只作用于发起
  // 更新的项目（按 pid 锚定），不能误清当前抽屉项目 p6 的真实未更新数字。
  updateDelayMs = 500;
  window.openGitDrawer('p5');
  await wait(50);
  assert(!!body().querySelector('.git-ab.behind'), '场景4：p5 徽标存在（memo behind:4）');
  const p5UpdatePromise = window.svnUpdate(); // 在途（update 接口挂起 500ms）
  await wait(30);
  window.openGitDrawer('p6'); // 切到 p6（memo behind:1，status 拖慢 800ms）
  await p5UpdatePromise;
  await wait(statusDelayByProj.p6 + 200);
  assert(!!body().querySelector('.git-ab.behind'), '场景4：p6 徽标不被 p5 的更新误清（按项目隔离）');
  const memoRaw = JSON.parse(window.localStorage.getItem('svnStatusMemo.v1'));
  assert(memoRaw.p5.behind === 0, '场景4：p5 memo behind 已清零');
  assert(memoRaw.p6.behind === 1, '场景4：p6 memo behind 保持不变');
  updateDelayMs = 0;

  console.log('\nsvn 更新后刷新不闪加载中 jsdom 验证完成');
  process.exit(process.exitCode || 0); // 遗留轮询 timer 会让事件循环不退出，显式结束
})().catch((e) => { console.error('TEST ERROR:', e); process.exit(1); });
