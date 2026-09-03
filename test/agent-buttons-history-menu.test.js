// 项目卡片 codex / pi 按钮右键「历史会话」的 DOM 级验证（jsdom）。
// 回归背景：claude 按钮已有右键菜单「历史会话」弹窗；codex / pi 按钮补齐同款：
//   右键按钮 → 菜单「历史会话」→ 弹窗按 agent 类型拉对应 -history 路由,
//   点选会话行后按 CLI 各自方式恢复（codex / pi 走通用 resumeHistorySession）。
// 加载真实 index.html 的 DOM，stub 掉网络/终端，eval 内联脚本后断言行为。
// 左键断言取按钮 onclick 属性编译执行；右键菜单直接调入口函数 + 派发菜单项事件。
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

// 提取最后一个无 src 的内联 <script> 内容
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
if (!scripts.length) throw new Error('未找到内联脚本');
const inlineScript = scripts[scripts.length - 1][1];

const PROJECTS = [
  { id: 'p1', name: 'Node项目', projectPath: 'D:/tmp/p1', type: 'node', running: false },
];

function boot() {
  const dom = new JSDOM(html, {
    url: 'http://localhost:7777/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // --- stubs：网络 / 终端 / WS（jsdom 未实现）---
  window.__projects = PROJECTS;
  window.fetch = async (url) => {
    const u = String(url);
    if (u === '/api/projects') return { json: async () => window.__projects };
    if (u.includes('/codex-history')) {
      return { json: async () => ({ ok: true, sessions: [
        { sessionId: 'cx-1', summary: 'codex 摘要A', timestamp: new Date().toISOString(), contextTokens: 32000 },
      ], hasMore: false }) };
    }
    if (u.includes('/pi-history')) {
      return { json: async () => ({ ok: true, sessions: [
        { sessionId: 'pi-1', summary: 'pi 摘要B', timestamp: new Date().toISOString(), contextTokens: null },
      ], hasMore: false }) };
    }
    return { json: async () => ({ ok: true }) };
  };
  window.WebSocket = class { constructor() {} send() {} close() {} };
  window.Terminal = class {};
  window.FitAddon = { FitAddon: class { fit() {} loadAddon() {} } };
  window.HTMLElement.prototype.setPointerCapture = function () {};
  window.HTMLElement.prototype.releasePointerCapture = function () {};

  window.eval(inlineScript);
  return window;
}

// 编译执行按钮的内联 onclick（jsdom outside-only 不编译 HTML 属性事件）
function fireOnclick(window, btn) {
  const fn = window.eval(`(function (event) { ${btn.getAttribute('onclick')} })`);
  fn.call(btn, { stopPropagation() {} });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, msg) {
  if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; }
  else console.log('PASS: ' + msg);
}

(async () => {
  const window = boot();
  await window.loadProjects();
  await wait(20);
  const doc = window.document;

  // tooltip 初始化把 title 改名为 data-tip，选择器用 data-tip
  const codexBtn = () => doc.querySelector('.project-item[data-project-id="p1"] .term-new-row button[data-tip^="新建 codex"]');
  const piBtn = () => doc.querySelector('.project-item[data-project-id="p1"] .term-new-row button[data-tip^="新建 pi"]');

  // --- 结构：codex / pi 按钮存在，带右键处理与 data-project-id ---
  assert(!!codexBtn() && !!piBtn(), 'codex / pi 按钮存在');
  assert((codexBtn().getAttribute('oncontextmenu') || '').includes('showAgentBtnContextMenu'), 'codex 按钮右键调 showAgentBtnContextMenu');
  assert((piBtn().getAttribute('oncontextmenu') || '').includes('showAgentBtnContextMenu'), 'pi 按钮右键调 showAgentBtnContextMenu');
  assert(codexBtn().getAttribute('data-agent-type') === 'codex' && piBtn().getAttribute('data-agent-type') === 'pi', '按钮带 data-agent-type');

  // --- claude 按钮同样走右键菜单（回归：曾漏带 data-agent-type 导致历史会话打不开） ---
  const claudeBtn = () => doc.querySelector('.project-item[data-project-id="p1"] .term-new-row button[data-tip^="新建 claude"]');
  assert(!!claudeBtn() && claudeBtn().getAttribute('data-agent-type') === 'claude' && (claudeBtn().getAttribute('oncontextmenu') || '').includes('showAgentBtnContextMenu'), 'claude 按钮带 data-agent-type 且右键调 showAgentBtnContextMenu');
  const menuAgentType = (() => {
    window.showAgentBtnContextMenu({ currentTarget: claudeBtn(), clientX: 10, clientY: 10, preventDefault() {}, stopPropagation() {} });
    const m = doc.getElementById('agentBtnContextMenu');
    const t = m.dataset.agentType;
    window.hideAgentBtnContextMenu();
    return t;
  })();
  assert(menuAgentType === 'claude', 'claude 右键菜单记录 agentType=claude');
  assert((codexBtn().getAttribute('data-tip') || '').includes('历史会话') && (piBtn().getAttribute('data-tip') || '').includes('历史会话'), 'tooltip 提示右键历史会话');

  // --- 历史会话时间格式：5 天内「相对时间 · 日期 时间」，超过 5 天「日期 时间」 ---
  const fmtTime = window.eval('fmtClaudeHistoryTime');
  const now = Date.now();
  const pad = (n) => String(n).padStart(2, '0');
  const fmtAbs = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  assert(fmtTime(new Date(now - 30 * 1000).toISOString()) === `刚刚 · ${fmtAbs(now - 30 * 1000)}`, '30 秒前 → 刚刚 · 日期 时间');
  assert(fmtTime(new Date(now - 5 * 60 * 1000).toISOString()) === `5 分钟前 · ${fmtAbs(now - 5 * 60 * 1000)}`, '5 分钟前 → 相对时间 · 日期 时间');
  assert(fmtTime(new Date(now - 3 * 3600 * 1000).toISOString()) === `3 小时前 · ${fmtAbs(now - 3 * 3600 * 1000)}`, '3 小时前 → 相对时间 · 日期 时间');
  assert(fmtTime(new Date(now - 4 * 86400 * 1000).toISOString()) === `4 天前 · ${fmtAbs(now - 4 * 86400 * 1000)}`, '4 天前 → 相对时间 · 日期 时间');
  assert(fmtTime(new Date(now - 5 * 86400 * 1000 - 60 * 1000).toISOString()) === fmtAbs(now - 5 * 86400 * 1000 - 60 * 1000), '超过 5 天 → 仅日期 时间');
  assert(fmtTime('not-a-date') === '', '非法时间 → 空串');

  // --- 左键行为不回归：仍直接新建对应类型会话 ---
  const created = [];
  const origNewTerm = window.newTermSession;
  window.newTermSession = (pid, type) => created.push([pid, type]);
  fireOnclick(window, codexBtn());
  fireOnclick(window, piBtn());
  assert(created.length === 2 && created[0][1] === 'codex' && created[1][1] === 'pi', '左键仍直接新建 codex / pi 会话');

  // --- codex 右键菜单：一项「历史会话」→ 弹窗 ---
  // 先捕获真函数：后面 monkey-patch window.resumeHistorySession 会遮蔽 window.eval 取到的同名函数
  const realResume = window.eval('resumeHistorySession');
  window.showAgentBtnContextMenu({
    clientX: 10, clientY: 10,
    currentTarget: { dataset: { projectId: 'p1', agentType: 'codex' } },
  });
  const menu = doc.getElementById('agentBtnContextMenu');
  assert(!!menu && menu.classList.contains('show'), '右键 codex 按钮后菜单显示');
  assert(menu.dataset.projectId === 'p1' && menu.dataset.agentType === 'codex', '菜单记录项目 id 与 agent 类型');
  const histBtn = menu.querySelector('button[data-act="history"]');
  assert(!!histBtn && histBtn.textContent.includes('历史会话'), '菜单含「历史会话」项');

  // 点菜单项 → 打开通用历史会话弹窗（title 带 agent 标签、列表拉 codex 路由）
  const origOpen = window.openAgentHistoryModal;
  let openedModal = null;
  window.openAgentHistoryModal = (pid, type) => { openedModal = [pid, type]; };
  histBtn.dispatchEvent(new window.Event('mousedown', { bubbles: true }));
  assert(!menu.classList.contains('show'), '执行后菜单收起');
  assert(openedModal && openedModal[0] === 'p1' && openedModal[1] === 'codex', '点「历史会话」打开 codex 历史弹窗');
  window.openAgentHistoryModal = origOpen;

  // --- 弹窗真实行为：拉对应路由、点选行走通用恢复 ---
  await window.openAgentHistoryModal('p1', 'codex');
  await wait(20);
  const overlay = doc.getElementById('agentHistoryOverlay');
  assert(overlay.classList.contains('show'), '历史会话弹窗显示');
  assert(doc.getElementById('agentHistoryTitle').textContent === '历史会话 - Node项目（codex）', '弹窗标题含 agent 标签');
  const item = overlay.querySelector('.agent-history-item');
  assert(!!item && item.dataset.sid === 'cx-1', '列表渲染 codex 会话行');
  const posted = [];
  window.resumeHistorySession = async (pid, type, sid) => { posted.push([pid, type, sid]); };
  // 会话行是内联 onclick 属性，jsdom outside-only 不编译，用 fireOnclick 编译执行
  fireOnclick(window, item);
  assert(posted.length === 1 && posted[0][0] === 'p1' && posted[0][1] === 'codex' && posted[0][2] === 'cx-1', '点选会话行走通用恢复（codex）');

  // --- pi：同弹窗复用，拉 pi 路由 ---
  await window.openAgentHistoryModal('p1', 'pi');
  await wait(20);
  const itemPi = overlay.querySelector('.agent-history-item');
  assert(!!itemPi && itemPi.dataset.sid === 'pi-1', 'pi 复用同弹窗渲染会话行');
  fireOnclick(window, itemPi);
  assert(posted[posted.length - 1][1] === 'pi' && posted[posted.length - 1][2] === 'pi-1', '点选会话行走通用恢复（pi）');

  // --- resumeHistorySession 通用恢复：按类型 POST 到对应 -sessions 路由 ---
  // 成功后调 renderList()，fetch stub 需继续支持 GET /api/projects 返回项目数组
  const posts = [];
  window.fetch = async (url, opts) => {
    if (opts && opts.method === 'POST') {
      posts.push([String(url), JSON.parse(opts.body)]);
      return { json: async () => ({ ok: true }) };
    }
    if (String(url) === '/api/projects') return { json: async () => window.__projects };
    return { json: async () => ({ ok: true }) };
  };
  await realResume('p1', 'codex', 'cx-9');
  await realResume('p1', 'pi', 'pi-9');
  assert(posts.length === 2
    && posts[0][0] === '/api/projects/p1/codex-sessions' && posts[0][1].resume === 'cx-9'
    && posts[1][0] === '/api/projects/p1/pi-sessions' && posts[1][1].resume === 'pi-9',
    'resumeHistorySession 按类型 POST 对应 -sessions 路由带 resume id');

  // --- claude 弹窗不回归：老入口仍指向通用弹窗 ---
  const claudeOverlayOk = !!doc.getElementById('claudeHistoryOverlay') || !!doc.getElementById('agentHistoryOverlay');
  assert(claudeOverlayOk, 'claude 历史弹窗元素仍存在（兼容或通用化）');

  console.log(process.exitCode ? '\n有失败项' : '\n全部通过');
})();
