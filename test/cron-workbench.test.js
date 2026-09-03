// 任务/定时任务共用工作台 + 两个抽屉面板的 DOM 级验证（jsdom）
// 加载真实 index.html 的 DOM，stub 掉网络/终端，eval 内联脚本后断言行为。
// 覆盖：活动栏分隔线+双按钮结构、工作台/抽屉开关联动、再点收抽屉、任务↔定时任务模式切换、
//       上方按钮切回终端、抽屉关闭按钮只收抽屉、项目卡片入口（文件/Git 抽屉）切回终端、
//       刷新恢复 + 旧持久化值（cronWorkbench='1'）迁移。
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

// 提取最后一个无 src 的内联 <script> 内容
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
if (!scripts.length) throw new Error('未找到内联脚本');
const inlineScript = scripts[scripts.length - 1][1];

// 启动一个页面实例：seeds 会在 eval 内联脚本前写入 localStorage（模拟刷新前的持久化状态）
function boot(seeds = {}) {
  const dom = new JSDOM(html, {
    url: 'http://localhost:7777/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  for (const [k, v] of Object.entries(seeds)) window.localStorage.setItem(k, v);

  // --- stubs：网络 / 终端 / WS（jsdom 未实现）---
  window.fetch = async () => ({ json: async () => [] });
  window.WebSocket = class { constructor() {} send() {} close() {} };
  window.Terminal = class {};
  window.FitAddon = { FitAddon: class { fit() {} loadAddon() {} } };
  window.HTMLElement.prototype.setPointerCapture = function () {};
  window.HTMLElement.prototype.releasePointerCapture = function () {};

  window.eval(inlineScript);
  return window;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, msg) {
  if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; }
  else console.log('PASS: ' + msg);
}

(async () => {
  const window = boot();
  await wait(20);

  const doc = window.document;
  const drawer = doc.getElementById('sideDrawer');
  const bar = doc.querySelector('.activity-bar');
  const taskBtn = doc.getElementById('activityTaskBtn');
  const cronBtn = doc.getElementById('activityCronBtn');
  const wb = doc.getElementById('workbench');

  // --- 结构：分隔线位于文件编辑器按钮与任务按钮之间；任务在定时任务上方；齿轮在最底 ---
  const ids = [...bar.children].map(el => el.id || el.className);
  const iEditor = ids.indexOf('activityEditorBtn');
  const iDivider = ids.indexOf('abDivider');
  const iTask = ids.indexOf('activityTaskBtn');
  const iCron = ids.indexOf('activityCronBtn');
  const iGear = ids.findIndex(c => String(c).includes('gear-btn'));
  assert(!!taskBtn, '活动栏含任务按钮');
  assert(iEditor >= 0 && iDivider > iEditor && iTask > iDivider, '分隔线位于文件编辑器按钮与任务按钮之间');
  assert(iCron > iTask, '任务按钮位于定时任务按钮上方');
  assert(iGear > iCron, '设置齿轮仍在最底部');
  assert(!!doc.getElementById('panelTask'), '存在任务面板 #panelTask');
  assert(doc.getElementById('panelTask').textContent.includes('任务'), '任务面板标题为「任务」');
  assert(doc.getElementById('panelTask').textContent.includes('建设中'), '任务面板显示建设中占位');
  assert(!!doc.getElementById('panelCron'), '存在定时任务面板 #panelCron');
  assert(doc.getElementById('panelCron').textContent.includes('定时任务'), '定时任务面板标题为「定时任务」');
  assert(doc.getElementById('panelCron').textContent.includes('建设中'), '定时任务面板显示建设中占位');
  assert(!!wb && wb.closest('.console'), '工作台 #workbench 位于终端区 .console 内');
  assert(wb.textContent.includes('建设中'), '工作台显示建设中占位');

  // --- 初始态 ---
  assert(!wb.classList.contains('show'), '初始不进工作台（终端区正常显示）');
  assert(!taskBtn.classList.contains('active'), '终端模式下任务按钮不高亮');
  assert(!cronBtn.classList.contains('active'), '终端模式下定时任务按钮不高亮');
  assert(!drawer.classList.contains('open'), '初始抽屉收起');

  // --- 点击任务：抽屉展开任务面板 + 终端区进工作台 ---
  window.toggleTaskWorkbench();
  assert(drawer.classList.contains('open'), '点击任务后抽屉展开');
  assert(doc.getElementById('panelTask').style.display === 'flex', '任务面板显示');
  assert(doc.getElementById('panelProject').style.display === 'none', '项目面板隐藏（互斥）');
  assert(doc.getElementById('panelFile').style.display === 'none', '文件面板隐藏（互斥）');
  assert(doc.getElementById('panelGit').style.display === 'none', 'Git 面板隐藏（互斥）');
  assert(doc.getElementById('panelCron').style.display === 'none', '定时任务面板隐藏（互斥）');
  assert(wb.classList.contains('show'), '终端区切换为工作台');
  assert(taskBtn.classList.contains('active'), '工作台任务模式下任务按钮高亮');
  assert(!cronBtn.classList.contains('active'), '工作台任务模式下定时任务按钮不高亮');
  assert(window.localStorage.getItem('sideDrawerPanel') === 'task', '面板选择持久化为 task');
  assert(window.localStorage.getItem('workbench') === 'task', '工作台模式持久化为 task');

  // --- 工作台任务模式下再点任务：只收抽屉，工作台保持 ---
  window.toggleTaskWorkbench();
  assert(!drawer.classList.contains('open'), '再点任务后抽屉收起');
  assert(wb.classList.contains('show'), '收抽屉后工作台保持不变');
  assert(taskBtn.classList.contains('active'), '收抽屉后任务按钮仍高亮');
  assert(window.localStorage.getItem('sideDrawerPanel') === null, '收抽屉后清除面板持久化');

  // --- 抽屉已收、工作台开着：再点任务重新展开抽屉 ---
  window.toggleTaskWorkbench();
  assert(drawer.classList.contains('open'), '抽屉收起后再点任务重新展开抽屉');
  assert(wb.classList.contains('show'), '工作台保持开启');

  // --- 任务面板的关闭按钮：只收抽屉，不动工作台 ---
  window.closeTaskDrawer();
  assert(!drawer.classList.contains('open'), '任务面板关闭按钮只收抽屉');
  assert(wb.classList.contains('show'), '任务面板关闭按钮不影响工作台');

  // --- 工作台开着时点定时任务：共用工作台，切换当前功能（工作台不闪断） ---
  window.toggleCronWorkbench();
  assert(wb.classList.contains('show'), '任务切定时任务：工作台保持开启（共用）');
  assert(doc.getElementById('panelCron').style.display === 'flex', '抽屉切换为定时任务面板');
  assert(doc.getElementById('panelTask').style.display === 'none', '任务面板隐藏（互斥）');
  assert(cronBtn.classList.contains('active'), '定时任务按钮高亮');
  assert(!taskBtn.classList.contains('active'), '任务按钮取消高亮');
  assert(window.localStorage.getItem('workbench') === 'cron', '工作台模式持久化切换为 cron');

  // --- 工作台定时任务模式下再点定时任务：只收抽屉，工作台保持 ---
  window.toggleCronWorkbench();
  assert(!drawer.classList.contains('open'), '再点定时任务后抽屉收起');
  assert(wb.classList.contains('show'), '收抽屉后工作台保持不变');
  assert(cronBtn.classList.contains('active'), '收抽屉后定时任务按钮仍高亮');

  // --- 分隔线上方按钮：先切回终端，再执行原有逻辑 ---
  window.toggleSidePanel('project');
  assert(!wb.classList.contains('show'), '点项目按钮退出工作台（终端区恢复）');
  assert(!taskBtn.classList.contains('active'), '退出工作台后任务按钮取消高亮');
  assert(!cronBtn.classList.contains('active'), '退出工作台后定时任务按钮取消高亮');
  assert(doc.getElementById('panelProject').style.display === 'flex', '项目按钮原有逻辑照常执行（项目面板打开）');
  assert(window.localStorage.getItem('workbench') === null, '退出工作台后清除工作台持久化');

  // --- 终端模式下点项目按钮（工作台本来就关）：不影响工作台态 ---
  window.toggleSidePanel('project'); // 再点收抽屉
  assert(!wb.classList.contains('show'), '终端模式下点上方按钮不误开工作台');

  // --- 工作台模式下点项目卡片入口（文件/Git 抽屉）：同样先切回终端 ---
  window.fetch = async () => ({ json: async () => [
    { id: 'p1', name: '裕租后台', type: 'node', running: false, projectPath: 'D:/yz' },
  ] });
  await window.loadProjects();
  window.toggleTaskWorkbench();
  assert(wb.classList.contains('show'), '重新进入工作台（任务模式）');
  window.openFileDrawer('p1');
  assert(!wb.classList.contains('show'), '项目卡片打开文件抽屉时退出工作台');
  assert(doc.getElementById('panelFile').style.display === 'flex', '文件抽屉照常打开');

  window.toggleCronWorkbench();
  assert(wb.classList.contains('show'), '再次进入工作台');
  window.openGitDrawer('p1');
  assert(!wb.classList.contains('show'), '项目卡片打开 Git 抽屉时退出工作台');
  assert(doc.getElementById('panelGit').style.display === 'flex', 'Git 抽屉照常打开');

  // --- 工作台模式下点文件编辑器按钮：先切回终端，再开编辑器窗口 ---
  window.toggleCronWorkbench();
  assert(wb.classList.contains('show'), '进入工作台（编辑器按钮用例前置）');
  window.toggleFileViewWindow();
  assert(!wb.classList.contains('show'), '点文件编辑器按钮退出工作台');
  assert(doc.getElementById('fileViewOverlay').classList.contains('show'), '编辑器窗口照常打开');

  // --- 刷新恢复：持久化 workbench='cron' 后重启，工作台自动回到定时任务模式 ---
  const w2 = boot({ workbench: 'cron', sideDrawerPanel: 'cron' });
  await wait(20);
  const doc2 = w2.document;
  assert(doc2.getElementById('workbench').classList.contains('show'), '刷新后恢复定时任务工作台');
  assert(doc2.getElementById('activityCronBtn').classList.contains('active'), '刷新后定时任务按钮恢复高亮');
  assert(!doc2.getElementById('activityTaskBtn').classList.contains('active'), '刷新后任务按钮不高亮');

  // --- 旧值迁移：升级前只存了 cronWorkbench='1'（无 workbench 键），刷新后按定时任务模式恢复 ---
  const w3 = boot({ cronWorkbench: '1' });
  await wait(20);
  const doc3 = w3.document;
  assert(doc3.getElementById('workbench').classList.contains('show'), '旧持久化值迁移为定时任务工作台');
  assert(doc3.getElementById('activityCronBtn').classList.contains('active'), '迁移后定时任务按钮恢复高亮');
  assert(w3.localStorage.getItem('workbench') === 'cron', '迁移结果写回 workbench 键');

  console.log('\n任务/定时任务共用工作台 jsdom 验证完成');
})().catch((e) => { console.error('TEST ERROR:', e); process.exitCode = 1; });
