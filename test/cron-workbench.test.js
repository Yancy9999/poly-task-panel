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
  assert(!!doc.getElementById('taskProjectSel'), '新建任务表单含项目下拉');
  assert(!!doc.getElementById('taskAgentSel'), '新建任务表单含 agent 下拉');
  assert(!!doc.getElementById('taskGoalInput'), '新建任务表单含目标输入框');
  assert(doc.getElementById('panelTask').textContent.includes('添加到想法'), '新建任务表单含「添加到想法」按钮');
  assert(doc.getElementById('panelTask').textContent.includes('添加到待执行'), '新建任务表单含「添加到待执行」按钮');
  assert(!!doc.getElementById('panelCron'), '存在定时任务面板 #panelCron');
  assert(doc.getElementById('panelCron').textContent.includes('定时任务'), '定时任务面板标题为「定时任务」');
  assert(doc.getElementById('panelCron').textContent.includes('建设中'), '定时任务面板显示建设中占位');
  assert(!!wb && wb.closest('.console'), '工作台 #workbench 位于终端区 .console 内');
  const colNames = [...wb.querySelectorAll('.task-col-title')].map((el) => el.textContent.trim());
  assert(JSON.stringify(colNames) === JSON.stringify(['想法', '待执行', '任务中', '待审核', '已完成']), '工作台为 5 列固定看板（想法/待执行/任务中/待审核/已完成）');

  // --- 工作台卡片结构：项目名徽标 + agent logo、右上角状态圆点 ---
  window.toggleTaskWorkbench();
  const colBody = wb.querySelector('.task-col[data-column="idea"] .task-col-body');
  colBody.innerHTML = window.taskCardHtml({ id: 't_x', projectId: 'p1', agent: 'codex', goal: '目标目标目标目标目标目标目标', column: 'idea', createdAt: '2026-09-03T10:00:00Z' });
  const card = colBody.querySelector('.task-card');
  assert(!!card.querySelector('.task-card-head .badge'), '卡片首行项目名带类型徽标（同分栏标题）');
  assert(card.querySelector('.task-card-head .badge + .task-card-dot + .task-card-agent') !== null, '项目名与 agent logo 之间有白点分隔');
  assert(!!card.querySelector('.task-card-head .codex-logo'), '卡片首行 agent 用 logo 展示');
  assert(!!card.querySelector('.task-card-status'), '卡片右上角有状态圆点');
  assert(card.querySelector('.task-card-status').classList.contains('idle'), '未发起 agent 执行的圆点为白色（idle）');

  // --- 卡片右下角启动按钮：idle 可点发起单轮任务，运行中禁用，完成后可再次启动 ---
  const runBtn = card.querySelector('.task-card-run');
  assert(!!runBtn, '卡片右下角有启动按钮');
  assert(runBtn.getAttribute('title') === '启动任务', 'idle 态按钮 title 为启动任务');
  // 点击启动按钮 → POST /api/tasks/:id/run（runTaskFromCard 先查 tasks 数组拿任务，
  // 经 loadTasks 灌入；卡片 DOM 也用重渲染后的活节点——游离节点不冒泡到 wb 委托监听）
  window.fetch = async (url) => {
    if (url === '/api/tasks') return { json: async () => [{ id: 't_x', projectId: 'p1', agent: 'codex', goal: 'x', column: 'idea', createdAt: '2026-09-03T10:00:00Z' }] };
    if (url === '/api/tasks/t_x/run') return { json: async () => ({ ok: true }) };
    return { json: async () => [] };
  };
  await window.loadTasks();
  let ranTaskId = null;
  const prevFetch = window.fetch;
  window.fetch = async (url, opts) => {
    if (url === '/api/tasks/t_x/run') { ranTaskId = 't_x'; return { json: async () => ({ ok: true }) }; }
    return prevFetch(url, opts);
  };
  const liveCard = wb.querySelector('.task-card[data-task-id="t_x"]');
  assert(!!liveCard, 'loadTasks 重渲染后卡片在看板 DOM 中');
  liveCard.querySelector('.task-card-run').click();
  await wait(10);
  assert(ranTaskId === 't_x', '点击启动按钮发起单轮任务（POST /api/tasks/:id/run）');

  // 运行中：按钮禁用（旋转图标）+ 状态圆点蓝闪 + 显示启动时间
  colBody.innerHTML = window.taskCardHtml({ id: 't_r', projectId: 'p1', agent: 'claude', goal: '运行中任务', column: 'idea', createdAt: '2026-09-03T10:00:00Z', status: 'agent-running', startedAt: '2026-09-03T11:00:00Z' });
  const cardRun = colBody.querySelector('.task-card');
  assert(cardRun.querySelector('.task-card-run').disabled, '运行中启动按钮禁用（不可重复发起）');
  assert(cardRun.querySelector('.task-card-run .spin'), '运行中按钮为旋转加载图标');
  assert(cardRun.querySelector('.task-card-status').classList.contains('agent-running'), '运行中圆点为蓝闪（agent-running）');
  assert(cardRun.textContent.includes('启动 '), '运行中卡片显示启动时间');
  // meta 两行：第一行创建时间，第二行启动/完成/用时；运行中第二行无用时
  const runMetas = cardRun.querySelectorAll('.task-card-meta');
  assert(runMetas.length === 2 && runMetas[0].textContent.startsWith('创建 '), 'meta 第一行仅创建时间');
  assert(runMetas[1].textContent.includes('启动 ') && !runMetas[1].textContent.includes('完成 '), '运行中 meta 第二行仅启动时间');
  assert(!/[0-9]+[smh]/.test(runMetas[1].textContent.replace(/\d{2}:\d{2}/g, '')), '运行中不显示用时');

  // 完成后：圆点绿 + 显示完成时间 + 按钮恢复可用（可再次发起续会话）
  colBody.innerHTML = window.taskCardHtml({ id: 't_d', projectId: 'p1', agent: 'claude', goal: '已完成任务', column: 'idea', createdAt: '2026-09-03T10:00:00Z', status: 'agent-success', startedAt: '2026-09-03T11:00:00Z', finishedAt: '2026-09-03T11:05:00Z' });
  const cardDone = colBody.querySelector('.task-card');
  assert(cardDone.querySelector('.task-card-status').classList.contains('agent-success'), '完成后圆点为绿（agent-success）');
  assert(cardDone.textContent.includes('完成 '), '完成卡片显示完成时间');
  assert(!cardDone.querySelector('.task-card-run').disabled, '完成后启动按钮恢复可用（可再次发起）');
  // 完成卡片 meta 第二行：启动 · 完成 · 用时（分钟档）
  const doneMetas = cardDone.querySelectorAll('.task-card-meta');
  assert(doneMetas.length === 2, '完成卡片 meta 拆两行');
  assert(doneMetas[1].textContent.includes('启动 ') && doneMetas[1].textContent.includes('完成 '), '完成卡片 meta 第二行含启动/完成时间');
  assert(doneMetas[1].textContent.includes('5m'), '完成卡片显示用时 5m（分钟档）');

  // 失败：圆点红
  colBody.innerHTML = window.taskCardHtml({ id: 't_f', projectId: 'p1', agent: 'claude', goal: '失败任务', column: 'idea', createdAt: '2026-09-03T10:00:00Z', status: 'agent-fail', startedAt: '2026-09-03T11:00:00Z', finishedAt: '2026-09-03T11:01:00Z' });
  assert(colBody.querySelector('.task-card .task-card-status').classList.contains('agent-fail'), '失败圆点为红（agent-fail）');
  const failMetas = colBody.querySelectorAll('.task-card .task-card-meta');
  assert(failMetas.length === 2 && failMetas[1].textContent.includes('1m'), '失败卡片显示用时 1m');

  // 目标行独立 class（上下间距用）+ 秒/小时档用时
  colBody.innerHTML = window.taskCardHtml({ id: 't_g', projectId: 'p1', agent: 'claude', goal: '间距', column: 'idea', createdAt: '2026-09-03T10:00:00Z', status: 'agent-success', startedAt: '2026-09-03T11:00:00Z', finishedAt: '2026-09-03T11:00:00Z' });
  assert(!!colBody.querySelector('.task-card .task-card-goal'), '目标行有独立 class 控制间距');
  colBody.innerHTML = window.taskCardHtml({ id: 't_h', projectId: 'p1', agent: 'claude', goal: '小时档', column: 'idea', createdAt: '2026-09-03T10:00:00Z', status: 'agent-success', startedAt: '2026-09-03T11:00:00Z', finishedAt: '2026-09-03T13:30:00Z' });
  assert(colBody.querySelector('.task-card').textContent.includes('2h'), '小时档用时显示 2h');

  // --- 弹窗运行态：卡片化布局（卡片头 → 创建时间 → 输出 → 启动/用时 meta → 按钮行） ---
  window.fetch = async (url) => {
    if (url === '/api/tasks') return { json: async () => [{ id: 't_r', projectId: 'p1', agent: 'claude', goal: '运行中任务', column: 'idea', createdAt: '2026-09-03T10:00:00Z', status: 'agent-running', startedAt: '2026-09-03T11:00:00Z', sessionTitle: '整理任务看板会话标题' }] };
    if (url === '/api/tasks/t_r/output') return { json: async () => ({ ok: true, output: '第一行输出\n' }) };
    return { json: async () => [] };
  };
  await window.loadTasks();
  window.openTaskEditModal('t_r');
  await wait(10);
  assert(doc.getElementById('taskEditOverlay').classList.contains('show'), '运行中点卡片打开弹窗');
  assert(doc.getElementById('taskEditTitle').textContent === '任务面板', '弹窗标题统一为「任务面板」');
  // 第一行=卡片头，与看板卡片同序：项目徽标 → · → agent logo → 会话标题（无状态圆点）
  const runHead = doc.getElementById('taskEditReadonly');
  const runHeadCls = [...runHead.children].map((el) => el.className.split(' ')[0]);
  assert(JSON.stringify(runHeadCls) === JSON.stringify(['badge', 'task-card-dot', 'task-card-agent', 'task-card-session-title']),
    '首行顺序与卡片一致：徽标 · logo · 会话标题（实际：' + runHeadCls.join(',') + '）');
  assert(!!runHead.querySelector('.badge') && !!runHead.querySelector('.claude-logo'), '查看态首行=卡片头（项目徽标 + agent logo）');
  assert(runHead.querySelector('.task-card-session-title').textContent === '整理任务看板会话标题', '查看态首行含会话标题（同卡片）');
  assert(!runHead.querySelector('.task-card-status'), '弹窗卡片头无状态圆点（状态由 meta 行表达）');
  // 首行容器必须随 started 态显示出来（此前 HTML 里 display:none 且从未切回，导致首行整体不可见）
  assert(doc.getElementById('taskEditReadonlyField').style.display === '', '发起过的任务首行容器必须显示');
  // 无会话标题时首行不渲染标题节点（顺序为 徽标 · logo）
  window.fetch = async (url) => {
    if (url === '/api/tasks') return { json: async () => [{ id: 't_n', projectId: 'p1', agent: 'codex', goal: '无标题任务', column: 'idea', createdAt: '2026-09-03T10:00:00Z', status: 'agent-success', startedAt: 'x', finishedAt: 'y' }] };
    return { json: async () => ({ ok: true, output: '' }) };
  };
  await window.loadTasks();
  window.openTaskEditModal('t_n');
  await wait(10);
  const noTitleHead = doc.getElementById('taskEditReadonly');
  const noTitleCls = [...noTitleHead.children].map((el) => el.className.split(' ')[0]);
  assert(JSON.stringify(noTitleCls) === JSON.stringify(['badge', 'task-card-dot', 'task-card-agent']),
    '无会话标题时首行只到 logo（实际：' + noTitleCls.join(',') + '）');
  // 恢复 t_r 场景（后续断言基于 t_r 弹窗）
  window.fetch = async (url) => {
    if (url === '/api/tasks') return { json: async () => [{ id: 't_r', projectId: 'p1', agent: 'claude', goal: '运行中任务', column: 'idea', createdAt: '2026-09-03T10:00:00Z', status: 'agent-running', startedAt: '2026-09-03T11:00:00Z', sessionTitle: '整理任务看板会话标题' }] };
    if (url === '/api/tasks/t_r/output') return { json: async () => ({ ok: true, output: '第一行输出\n' }) };
    return { json: async () => [] };
  };
  await window.loadTasks();
  window.openTaskEditModal('t_r');
  await wait(10);
  // 第二行=创建时间（输出前）；第四行 meta=启动时间（运行中无完成/用时，输出后）
  const runCreated = doc.getElementById('taskEditModalCreated');
  assert(runCreated.style.display !== 'none' && runCreated.textContent.startsWith('创建 '), '第二行显示创建时间');
  const runModalMetas = doc.querySelectorAll('#taskEditModalMeta .task-card-meta');
  assert(runModalMetas.length === 1 && runModalMetas[0].textContent.includes('启动 ') && !runModalMetas[0].textContent.includes('完成 '), 'meta 行显示启动时间（运行中无完成/用时）');
  // 第三行=输出区；原目标行不再显示
  assert(doc.getElementById('taskEditOutputField').style.display !== 'none', '第三行输出区显示');
  assert(doc.getElementById('taskEditOutput').textContent.includes('第一行输出'), '输出区回放历史输出');
  assert(doc.getElementById('taskEditGoalReadonly') === null, '原目标行已移除（元素不存在）');
  // 运行中：无新目标输入、无保存/执行按钮；按钮行只有取消
  assert(doc.getElementById('taskEditNewGoalField').style.display === 'none', '运行中无新目标输入');
  assert(doc.getElementById('taskEditSaveGoalBtn').style.display === 'none', '运行中无保存按钮');
  assert(doc.getElementById('taskEditRunBtn').style.display === 'none', '运行中无执行按钮');
  assert(doc.getElementById('taskEditActionsEdit').style.display === 'none', '非编辑态无删除按钮行');
  assert(doc.getElementById('taskEditCloseBtn').style.display !== 'none', '运行中有取消按钮');
  // WS 推输出：追加到输出区
  window.appendTaskRunOutput('t_r', '第二行输出\n');
  assert(doc.getElementById('taskEditOutput').textContent.includes('第二行输出'), 'WS 输出增量追加到输出区');

  // --- 弹窗尺寸：查看态加大 + 可拖拽缩放，编辑态保持原尺寸 ---
  const modal = doc.querySelector('#taskEditOverlay .modal');
  assert(modal.classList.contains('task-modal-wide'), '查看态弹窗加宽（task-modal-wide）');
  assert(!!modal.querySelector('.task-modal-resizer'), '查看态弹窗右下角有缩放手柄');
  // 拖拽缩放：pointerdown + pointermove 改宽高，pointerup 持久化
  // （jsdom 默认视口 1024px 放不下 960 初始宽，先调大视口模拟真实桌面）
  window.innerWidth = 2000;
  window.innerHeight = 1200;
  const resizer = modal.querySelector('.task-modal-resizer');
  const startW = parseFloat(modal.style.width) || 960;
  const startH = parseFloat(modal.style.height) || 680;
  resizer.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: 800, clientY: 600 }));
  resizer.dispatchEvent(new window.PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: 860, clientY: 660 }));
  resizer.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
  const wAfter = parseFloat(modal.style.width);
  const hAfter = parseFloat(modal.style.height);
  assert(wAfter === startW + 60, '拖拽手柄向右下移动 60px 后弹窗宽度 +60（' + wAfter + '）');
  assert(hAfter === startH + 60, '拖拽手柄向右下移动 60px 后弹窗高度 +60（' + hAfter + '）');
  assert(window.localStorage.getItem('taskModalSize') === JSON.stringify({ w: wAfter, h: hAfter }), '缩放尺寸持久化到 localStorage');
  window.closeTaskEditModal();
  // 编辑态：无 task-modal-wide、无手柄、清空 inline 尺寸
  // （t_x 已被乐观置 agent-running，编辑态用干净任务 t_e）
  window.fetch = async (url) => {
    if (url === '/api/tasks') return { json: async () => [{ id: 't_e', projectId: 'p1', agent: 'codex', goal: '未发起任务', column: 'idea', createdAt: '2026-09-03T10:00:00Z' }] };
    return { json: async () => ({ ok: true }) };
  };
  await window.loadTasks();
  window.openTaskEditModal('t_e');
  await wait(10);
  assert(!modal.classList.contains('task-modal-wide'), '编辑态弹窗保持原尺寸（无加宽类）');
  assert(!modal.querySelector('.task-modal-resizer') || resizer.style.display === 'none', '编辑态无缩放手柄');
  assert(!modal.style.width && !modal.style.height, '编辑态清空拖拽 inline 尺寸');
  assert(doc.getElementById('taskEditActionsEdit').style.display !== 'none', '编辑态显示编辑按钮行（删除/取消/保存）');
  assert(doc.getElementById('taskEditActionsView').style.display === 'none', '编辑态不显示查看按钮行（单行按钮）');
  window.closeTaskEditModal();
  // 回归：首次（此前未开过查看态）打开编辑态也不得加宽。此前 bug：started=undefined 时
  // classList.toggle(name, undefined) 按规范视为无 force 翻转——上面的用例恰好先开过查看态
  // （类已存在，翻转=移除）侥幸通过，真实使用中第一次打开编辑弹窗反而会把类加上。
  const wideBefore = modal.classList.contains('task-modal-wide');
  modal.classList.remove('task-modal-wide'); // 模拟从未开过查看态
  await window.openTaskEditModal('t_e');
  await wait(10);
  assert(!modal.classList.contains('task-modal-wide'), '首次打开编辑态弹窗不加宽（回归：toggle 无 force 翻转）');
  if (wideBefore) modal.classList.add('task-modal-wide'); // 还原，不影响后续用例
  window.closeTaskEditModal();

  // --- 弹窗完成态：卡片化布局（卡片头 → 创建时间 → 输出 → 启动/完成/用时 → 新目标 → 按钮） ---
  window.fetch = async (url, opts) => {
    if (url === '/api/tasks') return { json: async () => [{ id: 't_d', projectId: 'p1', agent: 'claude', goal: '已完成任务', column: 'idea', createdAt: '2026-09-03T10:00:00Z', status: 'agent-success', startedAt: '2026-09-03T11:00:00Z', finishedAt: '2026-09-03T11:05:00Z', sessionTitle: '整理任务看板会话标题' }] };
    if (url === '/api/tasks/t_d/output') return { json: async () => ({ ok: true, output: '第一轮结果\n' }) };
    if (url === '/api/tasks/t_d' && (!opts || opts.method === 'PUT')) return { json: async () => ({ ok: true }) };
    if (url === '/api/tasks/t_d/run') { ranAgain = true; return { json: async () => ({ ok: true }) }; }
    return { json: async () => ({ ok: true }) };
  };
  await window.loadTasks();
  let ranAgain = false;
  window.openTaskEditModal('t_d');
  await wait(10);
  assert(doc.getElementById('taskEditTitle').textContent === '任务面板', '完成态标题同样为「任务面板」');
  // 首行=卡片头（项目徽标 · 会话标题 · agent logo）
  const doneHead = doc.getElementById('taskEditReadonly');
  assert(doneHead.querySelector('.task-card-session-title').textContent === '整理任务看板会话标题', '完成态首行含会话标题');
  // 第二行创建时间（输出前）+ meta 行（启动 · 完成 · 用时 5m，输出后）
  const doneCreated = doc.getElementById('taskEditModalCreated');
  assert(doneCreated.style.display !== 'none' && doneCreated.textContent.startsWith('创建 '), '完成态第二行创建时间');
  const doneModalMetas = doc.querySelectorAll('#taskEditModalMeta .task-card-meta');
  assert(doneModalMetas.length === 1 && doneModalMetas[0].textContent.includes('启动 ') && doneModalMetas[0].textContent.includes('完成 ') && doneModalMetas[0].textContent.includes('5m'), '完成态 meta 行含启动/完成/用时');
  // DOM 顺序：创建时间 → 输出 → meta → 新目标 → 按钮行
  const form = doc.querySelector('#taskEditOverlay .task-form');
  const formIds = [...form.querySelectorAll('[id]')].map((el) => el.id);
  assert(formIds.indexOf('taskEditModalCreated') < formIds.indexOf('taskEditOutputField') &&
    formIds.indexOf('taskEditOutputField') < formIds.indexOf('taskEditModalMeta') &&
    formIds.indexOf('taskEditModalMeta') < formIds.indexOf('taskEditNewGoalField'), 'DOM 顺序：创建时间 → 输出 → meta → 新目标');
  assert(doc.getElementById('taskEditNewGoalField').style.display !== 'none', '完成态显示新目标输入（最底部）');
  // 按钮行：取消 / 保存 / 执行（非编辑态无删除按钮行）
  assert(doc.getElementById('taskEditActionsEdit').style.display === 'none', '完成态无删除按钮行');
  assert(doc.getElementById('taskEditCloseBtn').textContent === '取消', '查看态按钮=取消');
  assert(doc.getElementById('taskEditSaveGoalBtn').textContent === '保存', '查看态按钮=保存');
  assert(doc.getElementById('taskEditRunBtn').textContent === '执行', '查看态按钮=执行');
  // 保存按钮：只保存新目标（PUT goal），不发起执行
  let savedGoal = null;
  let runCalled = false;
  window.fetch = async (url, opts) => {
    if (url === '/api/tasks/t_d' && opts && opts.method === 'PUT') { savedGoal = JSON.parse(opts.body).goal; return { json: async () => ({ ok: true }) }; }
    if (url === '/api/tasks/t_d/run') { runCalled = true; return { json: async () => ({ ok: true }) }; }
    if (url === '/api/tasks') return { json: async () => [{ id: 't_d', projectId: 'p1', agent: 'claude', goal: savedGoal || '已完成任务', column: 'idea', createdAt: '2026-09-03T10:00:00Z', status: 'agent-success', startedAt: '2026-09-03T11:00:00Z', finishedAt: '2026-09-03T11:05:00Z' }] };
    return { json: async () => ({ ok: true, output: '' }) };
  };
  doc.getElementById('taskEditNewGoal').value = '只保存不执行的目标';
  await window.saveTaskGoalFromEdit();
  await wait(10);
  assert(savedGoal === '只保存不执行的目标', '保存按钮只 PUT 新目标');
  assert(!runCalled, '保存按钮不发起执行');
  // 执行按钮：保存新目标 + 发起执行（原会话续跑）
  doc.getElementById('taskEditNewGoal').value = '第二轮新目标';
  await window.runTaskFromEdit();
  await wait(10);
  assert(runCalled, '执行按钮发起单轮任务（原会话续跑）');
  window.closeTaskEditModal();

  // --- 弹窗拖动位置：按住标题 h2 拖拽移动弹窗（transform translate），持久化 taskModalPos ---
  // （放在完成态段后：此段 tasks 已加载 t_d，openTaskEditModal 能真正打开）
  // 标题栏 cursor:move 由样式表断言（jsdom 不做布局，getComputedStyle 读不到 inline 表）
  const styleText2 = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
  assert(/#taskEditTitle\s*\{[^}]*cursor:\s*move/.test(styleText2), '样式表：#taskEditTitle cursor:move（拖动热区提示）');
  // 查看态：拖动 (40, -30) → translate 同步 + 松手持久化
  window.openTaskEditModal('t_d');
  await wait(10);
  assert(doc.getElementById('taskEditOverlay').classList.contains('show'), '拖动用例前置：完成态弹窗已打开');
  const titleBar = doc.getElementById('taskEditTitle');
  titleBar.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, pointerId: 2, clientX: 100, clientY: 100 }));
  titleBar.dispatchEvent(new window.PointerEvent('pointermove', { bubbles: true, pointerId: 2, clientX: 140, clientY: 70 }));
  titleBar.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true, pointerId: 2 }));
  assert(modal.style.transform === 'translate(40px, -30px)', '拖动后弹窗位移 (40, -30)（' + modal.style.transform + '）');
  assert(window.localStorage.getItem('taskModalPos') === JSON.stringify({ x: 40, y: -30 }), '拖动位置持久化到 localStorage');
  // 关闭再打开：位置恢复
  window.closeTaskEditModal();
  assert(!modal.style.transform, '关闭弹窗清空拖动位移（下次打开居中基准重算）');
  window.openTaskEditModal('t_d');
  await wait(10);
  assert(modal.style.transform === 'translate(40px, -30px)', '重新打开弹窗恢复上次位置');
  // 关闭按钮与拖动热区互不干扰：拖动监听挂 h2，modal-close 按钮在 h2 外（结构断言，
  // jsdom outside-only 不编译 HTML onclick 属性，click 断不了行为）
  const closeBtn = doc.querySelector('#taskEditOverlay .modal-close');
  assert(closeBtn && !titleBar.contains(closeBtn) && !closeBtn.contains(titleBar), '关闭按钮不在拖动热区（h2）内，互不干扰');
  // 编辑态同样可拖动：位置跨态延续（打开先恢复 40,-30，再拖 30,40 → 70,10）
  window.fetch = async (url) => {
    if (url === '/api/tasks') return { json: async () => [{ id: 't_e', projectId: 'p1', agent: 'codex', goal: '未发起任务', column: 'idea', createdAt: '2026-09-03T10:00:00Z' }] };
    return { json: async () => ({ ok: true }) };
  };
  await window.loadTasks();
  window.openTaskEditModal('t_e');
  await wait(10);
  assert(modal.style.transform === 'translate(40px, -30px)', '编辑态打开同样恢复上次位置（跨态延续）');
  doc.getElementById('taskEditTitle').dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, pointerId: 3, clientX: 200, clientY: 200 }));
  doc.getElementById('taskEditTitle').dispatchEvent(new window.PointerEvent('pointermove', { bubbles: true, pointerId: 3, clientX: 230, clientY: 240 }));
  doc.getElementById('taskEditTitle').dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true, pointerId: 3 }));
  assert(modal.style.transform === 'translate(70px, 10px)', '编辑态拖动位移同步（基准 40,-30 + 拖 30,40）（' + modal.style.transform + '）');
  assert(window.localStorage.getItem('taskModalPos') === JSON.stringify({ x: 70, y: 10 }), '编辑态拖动位置持久化');
  // 钳制（纯函数直测；jsdom 无布局，拖动链路 rect.width=0 跳过钳制）：视口 1920x1080，
  // 弹窗 960 宽居中 → 未位移基准 left=480, top=200。左拖超界 → 标题栏留 48px；上拖 → 贴顶；
  // 右/下拖超界 → 距视口右/底 48px。
  const cur0 = { x: 0, y: 0 };
  const rect0 = { left: 480, top: 200, width: 960 };
  const cl = window.clampTaskModalPos(-2000, -2000, cur0, rect0, 1920, 1080);
  assert(cl.x === 48 - 960 - 480, '钳制：左拖超界 → 标题栏右缘留 48px（' + cl.x + '）');
  assert(cl.y === -200, '钳制：上拖超界 → 标题栏贴视口顶（' + cl.y + '）');
  const cl2 = window.clampTaskModalPos(2000, 2000, cur0, rect0, 1920, 1080);
  assert(cl2.x === 1920 - 48 - 480, '钳制：右拖超界 → 标题栏左缘距视口右 48px（' + cl2.x + '）');
  assert(cl2.y === 1080 - 48 - 200, '钳制：下拖超界 → 标题栏距视口底 48px（' + cl2.y + '）');
  // 既有位移参与基准还原：cur=(10,5) → 未位移基准 left=510/top=175，拖到 (30,-20) 在界内 → 原样返回
  const cl3 = window.clampTaskModalPos(30, -20, { x: 10, y: 5 }, { left: 520, top: 180, width: 960 }, 1920, 1080);
  assert(cl3.x === 30 && cl3.y === -20, '钳制：范围内拖动不额外干预（' + cl3.x + ',' + cl3.y + '）');
  window.closeTaskEditModal();
  assert(!modal.style.transform, '关闭弹窗清空拖动位移（收尾还原）');
  window.localStorage.removeItem('taskModalPos');

  wb.querySelector('.task-col[data-column="idea"] .task-col-body').innerHTML = '';
  window.exitWorkbench();
  window.closeTaskDrawer();

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
