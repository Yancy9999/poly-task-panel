// 项目卡片头部行（项目名 + 徽标）右键菜单的 DOM 级验证（jsdom）。
// 需求：右键卡片头部行 → 菜单列出卡片全部功能（每项带图标）：
//   运行类（启动/停止/重启/查看命令）+ 工具类（文件目录/在资源管理器中打开/版本管理）
//   + 终端类（cmd/Git Bash/claude/codex/pi 会话）+ 管理类（编辑/删除）。
// 置灰规则：Folder 类型 → 运行类全灰；非运行 → 停止/重启灰、启动可点；
//   运行中 → 启动灰、停止/重启可点（与卡片按钮 disabled 条件一致）。
// 加载真实 index.html 的 DOM，stub 掉网络/终端，eval 内联脚本后断言行为。
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
  { id: 'p2', name: '运行中项目', projectPath: 'D:/tmp/p2', type: 'springboot', running: true, pid: 1234 },
  { id: 'p3', name: '文件夹', projectPath: 'D:/tmp/p3', type: 'folder', running: false },
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
    if (String(url) === '/api/projects') return { json: async () => window.__projects };
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

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

function assert(cond, msg) {
  if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; }
  else console.log('PASS: ' + msg);
}

// 打开某项目头部行右键菜单（row 是 .project-item .row）
function openRowMenu(window, projectId) {
  const doc = window.document;
  const row = doc.querySelector(`.project-item[data-project-id="${projectId}"] .row`);
  window.showProjectCardContextMenu({
    clientX: 10, clientY: 10,
    currentTarget: row,
  });
  return doc.getElementById('projectCardContextMenu');
}

(async () => {
  const window = boot();
  await window.loadProjects();
  await wait(20);
  const doc = window.document;

  // --- 结构：菜单节点存在，头部行带右键处理 ---
  assert(!!doc.getElementById('projectCardContextMenu'), '菜单节点 projectCardContextMenu 存在');
  const row = doc.querySelector('.project-item[data-project-id="p1"] .row');
  assert((row.getAttribute('oncontextmenu') || '').includes('showProjectCardContextMenu'), '头部行右键调 showProjectCardContextMenu');

  // --- 菜单项齐全（12 项，每项带图标）---
  const menu = openRowMenu(window, 'p1');
  assert(!!menu && menu.classList.contains('show'), '右键头部行后菜单显示');
  assert(menu.dataset.projectId === 'p1', '菜单记录项目 id');
  const acts = ['start', 'stop', 'restart', 'command', 'files', 'reveal', 'vcs', 'cmd', 'gitbash', 'claude', 'codex', 'pi', 'edit', 'delete'];
  const labels = {
    start: '启动', stop: '停止', restart: '重启', command: '查看命令',
    files: '文件目录', reveal: '在资源管理器中打开', vcs: '版本管理',
    cmd: 'cmd', gitbash: 'Git Bash', claude: 'claude', codex: 'codex', pi: 'pi',
    edit: '编辑', delete: '删除',
  };
  for (const act of acts) {
    const btn = menu.querySelector(`button[data-act="${act}"]`);
    assert(!!btn && btn.textContent.includes(labels[act]), `菜单项「${labels[act]}」存在`);
    assert(!!btn && btn.querySelector('svg, img'), `菜单项「${labels[act]}」带图标`);
  }

  // --- 置灰规则：node 未运行 → 停止/重启灰，其余可点 ---
  for (const act of ['start', 'command', 'files', 'reveal', 'vcs', 'cmd', 'gitbash', 'claude', 'codex', 'pi', 'edit', 'delete']) {
    assert(!menu.querySelector(`button[data-act="${act}"]`).disabled, `未运行项目「${labels[act]}」可点`);
  }
  assert(menu.querySelector('button[data-act="stop"]').disabled, '未运行「停止」置灰');
  assert(menu.querySelector('button[data-act="restart"]').disabled, '未运行「重启」置灰');

  // --- 图标颜色与卡片按钮一致（jsdom 支持样式表级联的 computed color） ---
  const iconColor = (m, act) => {
    const svg = m.querySelector(`button[data-act="${act}"] svg`);
    return svg ? window.getComputedStyle(svg).color : null;
  };
  assert(iconColor(menu, 'start') === 'rgb(0, 180, 42)', '「启动」图标绿色同卡片');
  assert(iconColor(menu, 'command') === 'rgb(199, 155, 255)', '「查看命令」图标紫色同卡片');
  for (const act of ['files', 'reveal', 'vcs', 'cmd', 'claude', 'codex', 'pi']) {
    assert(iconColor(menu, act) === 'rgb(217, 119, 87)', `「${labels[act]}」图标品牌橙同卡片`);
  }
  // 置灰项图标随文字变灰（未运行 → 停止置灰，:disabled 灰盖过按项配色）
  assert(iconColor(menu, 'stop') === 'rgb(107, 114, 128)', '置灰「停止」图标变灰');
  // 运行中的 p2 菜单：停止/重启可点，图标红/橙同卡片
  window.hideProjectCardContextMenu();
  const menuRun = openRowMenu(window, 'p2');
  assert(iconColor(menuRun, 'stop') === 'rgb(245, 106, 106)', '「停止」图标红色同卡片');
  assert(iconColor(menuRun, 'restart') === 'rgb(255, 143, 31)', '「重启」图标橙色同卡片');

  // --- 置灰规则：运行中 → 启动灰，停止/重启可点 ---
  window.hideProjectCardContextMenu();
  const menu2 = openRowMenu(window, 'p2');
  assert(menu2.dataset.projectId === 'p2', '右键另一项目更新菜单项目 id');
  assert(menu2.querySelector('button[data-act="start"]').disabled, '运行中「启动」置灰');
  for (const act of ['stop', 'restart', 'command']) {
    assert(!menu2.querySelector(`button[data-act="${act}"]`).disabled, `运行中「${labels[act]}」可点`);
  }

  // --- 置灰规则：Folder → 运行类全灰，工具/管理可用 ---
  window.hideProjectCardContextMenu();
  const menu3 = openRowMenu(window, 'p3');
  for (const act of ['start', 'stop', 'restart', 'command']) {
    assert(menu3.querySelector(`button[data-act="${act}"]`).disabled, `Folder「${labels[act]}」置灰`);
  }
  for (const act of ['files', 'reveal', 'vcs', 'cmd', 'gitbash', 'claude', 'codex', 'pi', 'edit', 'delete']) {
    assert(!menu3.querySelector(`button[data-act="${act}"]`).disabled, `Folder「${labels[act]}」可点`);
  }

  // --- 各菜单项触发对应函数 ---
  window.hideProjectCardContextMenu();
  const calls = [];
  const fns = {
    startProject: ['start', ['p1']], stopProject: ['stop', ['p1']], restartProject: ['restart', ['p1']],
    showCommand: ['command', ['p1']], openFileDrawer: ['files', ['p1']], openExplorer: ['reveal', ['p1']],
    openGitDrawer: ['vcs', ['p1']], openEditModal: ['edit', ['p1']], deleteProject: ['delete', ['p1']],
  };
  for (const [fn, [act, args]] of Object.entries(fns)) {
    window[fn] = (...a) => calls.push([fn, ...a]);
  }
  window.newTermSession = (pid, type) => calls.push(['newTermSession', pid, type]);
  const m = openRowMenu(window, 'p1');
  for (const [act] of Object.values(fns)) {
    // 未运行的 p1 菜单里 停止/重启 置灰（正确行为），这两项从运行中的 p2 菜单触发
    if (act === 'stop' || act === 'restart') continue;
    m.querySelector(`button[data-act="${act}"]`).dispatchEvent(new window.Event('mousedown', { bubbles: true }));
  }
  const m2 = openRowMenu(window, 'p2');
  m2.querySelector('button[data-act="stop"]').dispatchEvent(new window.Event('mousedown', { bubbles: true }));
  m2.querySelector('button[data-act="restart"]').dispatchEvent(new window.Event('mousedown', { bubbles: true }));
  // 菜单是单例节点：上面打开 p2 覆盖了 dataset，重新打开 p1 菜单再做终端类触发
  openRowMenu(window, 'p1');
  m.querySelector('button[data-act="cmd"]').dispatchEvent(new window.Event('mousedown', { bubbles: true }));
  m.querySelector('button[data-act="gitbash"]').dispatchEvent(new window.Event('mousedown', { bubbles: true }));
  m.querySelector('button[data-act="claude"]').dispatchEvent(new window.Event('mousedown', { bubbles: true }));
  m.querySelector('button[data-act="codex"]').dispatchEvent(new window.Event('mousedown', { bubbles: true }));
  m.querySelector('button[data-act="pi"]').dispatchEvent(new window.Event('mousedown', { bubbles: true }));
  const expect = [
    ['startProject', 'p1'], ['showCommand', 'p1'],
    ['openFileDrawer', 'p1'], ['openExplorer', 'p1'], ['openGitDrawer', 'p1'],
    ['openEditModal', 'p1'], ['deleteProject', 'p1'],
    ['stopProject', 'p2'], ['restartProject', 'p2'],
    ['newTermSession', 'p1', 'cmd'], ['newTermSession', 'p1', 'gitbash'],
    ['newTermSession', 'p1', 'claude'], ['newTermSession', 'p1', 'codex'], ['newTermSession', 'p1', 'pi'],
  ];
  assert(JSON.stringify(calls) === JSON.stringify(expect), '各菜单项触发对应函数（带项目 id）');

  // --- 置灰项点击无效果 ---
  window.hideProjectCardContextMenu();
  calls.length = 0;
  window.stopProject = () => calls.push('stopProject');
  const mStopped = openRowMenu(window, 'p1'); // 未运行 → 停止灰
  mStopped.querySelector('button[data-act="stop"]').dispatchEvent(new window.Event('mousedown', { bubbles: true }));
  assert(calls.length === 0, '置灰「停止」点击不触发');

  // --- 打开新菜单时互斥收起旧菜单；Escape / 点外部关闭 ---
  window.hideProjectCardContextMenu();
  openRowMenu(window, 'p1');
  const shellPop = doc.createElement('div');
  shellPop.id = 'shellMenu';
  doc.body.appendChild(shellPop);
  openRowMenu(window, 'p2');
  assert(!doc.getElementById('shellMenu'), '打开项目卡片菜单时收起 shellMenu');
  assert(doc.getElementById('projectCardContextMenu').classList.contains('show'), '新菜单显示');
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert(!doc.getElementById('projectCardContextMenu').classList.contains('show'), 'Escape 关闭菜单');

  // --- 右键处理绑在头部行而非项目名：项目名本身无 onclick / oncontextmenu 属性 ---
  const nameEl = doc.querySelector('.project-item[data-project-id="p1"] .name');
  assert(!nameEl.getAttribute('onclick') && !nameEl.getAttribute('oncontextmenu'), '项目名无 onclick / oncontextmenu，右键处理绑在头部行');

  console.log(process.exitCode ? '\n有失败项' : '\n全部通过');
})();
