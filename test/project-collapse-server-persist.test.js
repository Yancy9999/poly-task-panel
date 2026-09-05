// 项目卡片折叠状态服务端持久化的 DOM 级验证（jsdom）。
// 回归背景：折叠状态原存 localStorage['projectCollapsed']，改为走服务端
// settings.json（GET/PUT /api/settings 的 projectCollapsed 字段），与设置面板同通道。
// 覆盖：termSettings.projectCollapsed 驱动渲染、三个折叠入口写内存+PUT、
// 启动迁移（localStorage 旧值合并上服务端后清除）、PUT 失败 toast。
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

// 提取最后一个无 src 的内联 <script> 内容（const 声明不挂 window，eval 尾部显式暴露）
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
if (!scripts.length) throw new Error('未找到内联脚本');
const inlineScript = scripts[scripts.length - 1][1]
  + '\nwindow.__termSettings = termSettings;'
  + '\nObject.defineProperty(window, "__settingsReady", { get: () => settingsReady });';

const PROJECTS = [
  { id: 'p1', name: '项目一', projectPath: 'D:/tmp/p1', type: 'node', running: false },
  { id: 'p2', name: '项目二', projectPath: 'D:/tmp/p2', type: 'folder', running: false },
  { id: 'p3', name: '项目三', projectPath: 'D:/tmp/p3', type: 'springboot', running: false },
];

function boot({ legacyCollapsed, legacySettings, serverCollapsed } = {}) {
  const dom = new JSDOM(html, {
    url: 'http://localhost:7777/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  // localStorage 预置必须在 eval 前完成：内联脚本末尾自动执行 bootSettings()，
  // 其同步首步就读 localStorage——eval 后再写会错过迁移读取（真实页面数据本就先于脚本存在）
  if (legacyCollapsed) window.localStorage.setItem('projectCollapsed', JSON.stringify(legacyCollapsed));
  if (legacySettings) window.localStorage.setItem('tacTermSettings', JSON.stringify(legacySettings));

  const state = { puts: [] };
  // 服务端 settings.json 模拟：内存对象，PUT 整体覆盖
  const serverSettings = { projectCollapsed: serverCollapsed ? { ...serverCollapsed } : {} };
  window.__state = state;
  window.__serverSettings = serverSettings;
  window.__projects = PROJECTS;
  window.fetch = async (url, opts) => {
    const u = String(url);
    if (u === '/api/projects') return { json: async () => window.__projects };
    if (u === '/api/settings') {
      if (opts && opts.method === 'PUT') {
        const body = JSON.parse(opts.body);
        state.puts.push(body);
        if (state.failPut) return { json: async () => ({ ok: false, msg: '模拟失败' }) };
        Object.assign(serverSettings, body);
        return { json: async () => ({ ok: true, settings: serverSettings }) };
      }
      return { json: async () => ({ ok: true, settings: serverSettings }) };
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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// 内联脚本末尾自动执行 bootSettings()（真实页面行为）；等 settingsReady 置位即启动完成。
// 不要再手动调 bootSettings——重复调用会二次触发迁移 PUT，污染 PUT 计数断言。
async function waitBoot(window) {
  for (let i = 0; i < 100 && !window.__settingsReady; i++) await wait(10);
  await wait(10);
}

function assert(cond, msg) {
  if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; }
  else console.log('PASS: ' + msg);
}

function collapsedIds(window) {
  return [...window.document.querySelectorAll('#sidebarList .project-item.collapsed')]
    .map(el => el.dataset.projectId).sort();
}

(async () => {
  // --- 场景 1：服务端已有折叠数据 → 渲染跟随 ---
  const w1 = boot({ serverCollapsed: { p1: 1, p3: 1 } });
  await waitBoot(w1);
  await w1.loadProjects();
  await wait(20);
  assert(JSON.stringify(collapsedIds(w1)) === JSON.stringify(['p1', 'p3']), '服务端折叠数据驱动渲染（p1/p3 折叠）');
  assert(w1.localStorage.getItem('projectCollapsed') === null, '无本地旧数据时 localStorage 保持干净');

  // --- 场景 2：单卡折叠 → PUT 服务端（含其它设置字段全量），本地不写 ---
  w1.__state.puts.length = 0;
  w1.toggleProjectCollapsed('p1');
  await wait(20);
  assert(JSON.stringify(collapsedIds(w1)) === JSON.stringify(['p3']), '再点 p1 折叠按钮 → p1 展开，只剩 p3');
  assert(w1.__state.puts.length === 1 && w1.__state.puts[0].projectCollapsed
    && JSON.stringify(w1.__state.puts[0].projectCollapsed) === JSON.stringify({ p3: 1 }),
    'toggleProjectCollapsed PUT {p3:1} 到服务端');
  assert(w1.__serverSettings.projectCollapsed.p3 === 1 && !w1.__serverSettings.projectCollapsed.p1,
    '服务端 settings 内存同步更新');
  assert(w1.localStorage.getItem('projectCollapsed') === null, '折叠操作不再写 localStorage');

  // --- 场景 3：全部折叠 / 全部展开 ---
  w1.__state.puts.length = 0;
  w1.collapseAllProjects();
  await wait(20);
  assert(JSON.stringify(collapsedIds(w1)) === JSON.stringify(['p1', 'p2', 'p3']), 'collapseAllProjects 全部折叠');
  assert(w1.__state.puts.length === 1 && JSON.stringify(w1.__state.puts[0].projectCollapsed) === JSON.stringify({ p1: 1, p2: 1, p3: 1 }),
    'collapseAllProjects PUT 全量折叠 map');
  w1.__state.puts.length = 0;
  w1.expandAllProjects();
  await wait(20);
  assert(collapsedIds(w1).length === 0, 'expandAllProjects 全部展开');
  assert(w1.__state.puts.length === 1 && JSON.stringify(w1.__state.puts[0].projectCollapsed) === JSON.stringify({}),
    'expandAllProjects PUT 空对象');

  // --- 场景 4：localStorage 旧数据迁移（服务端为空时合并上服务端，迁移后清除本地） ---
  const w2 = boot({ legacyCollapsed: { p2: 1 }, serverCollapsed: {} });
  await waitBoot(w2);
  await wait(20);
  assert(w2.__state.puts.length >= 1 && JSON.stringify(w2.__state.puts[0].projectCollapsed) === JSON.stringify({ p2: 1 }),
    '启动迁移：localStorage 旧折叠数据 PUT 上服务端');
  assert(w2.__serverSettings.projectCollapsed.p2 === 1, '服务端收到迁移数据');
  assert(w2.localStorage.getItem('projectCollapsed') === null, '迁移后 localStorage 旧 key 清除');

  // --- 场景 5：服务端已有数据时不迁移（以服务端为准） ---
  const w3 = boot({ legacyCollapsed: { p1: 1 }, serverCollapsed: { p2: 1 } });
  await waitBoot(w3);
  await wait(20);
  assert(w3.__serverSettings.projectCollapsed.p2 === 1 && !w3.__serverSettings.projectCollapsed.p1,
    '服务端已有数据时不迁移，保持服务端值');
  assert(w3.localStorage.getItem('projectCollapsed') === null, '仍清除 localStorage 旧 key');

  // --- 场景 5b：设置迁移与折叠数据并存 —— 设置迁移不得抹掉服务端已有折叠数据 ---
  // （回归：曾把 serverIsDefault 条件丢弃，旧设置迁移载荷 projectCollapsed 恒 {} 覆盖服务端）
  const w3b = boot({ legacySettings: { fontFamily: 'Consolas', fontSize: 15 }, serverCollapsed: { p2: 1 } });
  await waitBoot(w3b);
  await wait(20);
  assert(w3b.__serverSettings.projectCollapsed.p2 === 1,
    '旧设置迁移触发时服务端已有折叠数据保持不变');
  assert(w3b.__termSettings.fontFamily === 'Consolas, monospace', '旧设置照常迁移生效（normalize 补 monospace 兜底）');

  // --- 场景 5c：老版本升级（旧设置 + 旧折叠同时存在，服务端全空）→ 一次 PUT 全部迁移 ---
  const w3c = boot({ legacyCollapsed: { p3: 1 }, legacySettings: { fontFamily: 'JetBrains Mono', fontSize: 14 }, serverCollapsed: {} });
  await waitBoot(w3c);
  await wait(20);
  assert(w3c.__serverSettings.projectCollapsed.p3 === 1, '老版本升级：旧折叠数据迁移');
  assert(w3c.__termSettings.fontFamily === 'JetBrains Mono, monospace', '老版本升级：旧设置迁移（normalize 补 monospace 兜底）');
  const settingsPuts = w3c.__state.puts.length;
  assert(settingsPuts === 1, '两路迁移合并为一次 PUT');

  // --- 场景 6：PUT 失败 → toast 提示、内存回滚前保持原渲染 ---
  const w4 = boot({ serverCollapsed: {} });
  await waitBoot(w4);
  await w4.loadProjects();
  await wait(20);
  const toasts = [];
  w4.showToast = (msg, type) => toasts.push([msg, type]);
  w4.__state.failPut = true;
  w4.toggleProjectCollapsed('p1');
  await wait(20);
  assert(toasts.some(t => t[1] === 'error' && /折叠状态/.test(t[0])), 'PUT 失败弹 error toast 说明原因');
  // 失败不落服务端
  assert(!w4.__serverSettings.projectCollapsed || !w4.__serverSettings.projectCollapsed.p1, '失败时服务端未写入');

  console.log(process.exitCode ? '\n有失败项' : '\n全部通过');
})().catch((e) => { console.error('TEST ERROR:', e); process.exitCode = 1; });
