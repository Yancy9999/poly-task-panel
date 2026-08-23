// 分栏布局持久化：persistPanes 原样存储（会话栏保留 sessionId）+ restorePaneLayout 恢复与兜底
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
const inlineScript = scripts[scripts.length - 1][1] +
  '\nwindow.__getPanes = () => panes; window.__getActive = () => activePaneId; window.__setActive = (id) => activePaneId = id;'
  + 'window.__getLogPanes = () => logPanes; window.__getLogActive = () => activeLogPaneId; window.__setLogActive = (id) => activeLogPaneId = id;'
  + 'window.__termSessions = termSessions;';

const dom = new JSDOM(html, { url: 'http://localhost:7777/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;

let fakeProjects = [];
// reconnectSessionPanes（async 版）会 fetch /api/projects/<id>/(claude|codex)-sessions 判会话存活，
// 期望 { ok, sessions:[{sessionId,...}] }；其它路径（如 /logs）返回项目数组即可。
window.fetch = async (url) => {
  const u = String(url);
  if (/\/(claude|codex)-sessions/.test(u)) {
    return { json: async () => ({ ok: true, sessions: [...window.__termSessions.entries()]
      .filter(([sid]) => String(sid).startsWith(u.includes('codex') ? 'x_' : 'c_'))
      .map(([sid, s]) => ({ sessionId: sid, sessionNumber: s.sessionNumber })) }) };
  }
  return { json: async () => fakeProjects };
};
window.WebSocket = class { constructor() {} send() {} close() {} };
window.Terminal = class {};
window.FitAddon = { FitAddon: class { fit() {} loadAddon() {} } };
window.HTMLElement.prototype.setPointerCapture = function () {};
window.HTMLElement.prototype.releasePointerCapture = function () {};
window.requestAnimationFrame = (cb) => setTimeout(cb, 0);

window.eval(inlineScript);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
function assert(cond, msg) {
  if (!cond) { fails++; console.error('FAIL: ' + msg); }
  else console.log('PASS: ' + msg);
}

(async () => {
  await wait(20);
  const P = () => window.__getPanes();
  const ls = window.localStorage;
  // reconnectSessionPanes（async 版）按 projects.find 判项目存在性，需先注入项目 A/B。
  fakeProjects.push({ id: 'A', name: 'a', type: 'springboot', projectPath: 'x', running: false });
  fakeProjects.push({ id: 'B', name: 'b', type: 'springboot', projectPath: 'y', running: false });

  // --- 1. persistPanes 原样存储：empty 直存，会话视图保留 sessionId，激活栏按下标 ---
  //     日志视图已分离到 logPanes，终端 panes 只存 empty/会话。
  P().length = 0;
  P().push({ id: 'p1', projectId: null, view: 'empty' });
  P().push({ id: 'p2', projectId: 'A', view: 'c_1' });
  window.__setActive('p2');
  window.renderPanes();
  await wait(10);

  const saved = JSON.parse(ls.getItem('paneLayout'));
  assert(!!saved, 'renderPanes 后 paneLayout 已写入 localStorage');
  assert(saved.panes.length === 2, `保存 2 栏 (got ${saved.panes.length})`);
  assert(saved.panes[0].view === 'empty' && saved.panes[0].projectId === null, 'empty 栏原样保存');
  assert(saved.panes[1].view === 'c_1' && saved.panes[1].projectId === 'A', '会话视图原样保存 sessionId');
  assert(saved.active === 1, `激活栏按下标保存 (got ${saved.active})`);

  // --- 1b. 日志分栏独立持久化到 logPaneLayout ---
  const LP = () => window.__getLogPanes();
  LP().length = 0;
  LP().push({ id: 'l1', projectId: 'A', view: 'log' });
  LP().push({ id: 'l2', projectId: null, view: 'empty' });
  window.__setLogActive('l1');
  window.renderLogPanes();
  await wait(10);
  const savedLog = JSON.parse(ls.getItem('logPaneLayout'));
  assert(!!savedLog, 'renderLogPanes 后 logPaneLayout 已写入');
  assert(savedLog.panes.length === 2 && savedLog.panes[0].view === 'log' && savedLog.panes[0].projectId === 'A', '日志栏独立持久化');
  assert(savedLog.active === 0, '日志激活栏按下标保存');

  // --- 2. restorePaneLayout 恢复：重建栏数、empty/会话视图、激活栏 ---
  window.restorePaneLayout();
  const ps = P();
  assert(ps.length === 2, `恢复 2 栏 (got ${ps.length})`);
  assert(ps[0].view === 'empty' && ps[0].projectId === null, '恢复 empty 栏');
  assert(ps[1].view === 'c_1' && ps[1].projectId === 'A', '恢复会话视图（保留 projectId 供重连判定）');
  assert(window.__getActive() === ps[1].id, '激活栏恢复到保存的下标');

  // --- 2b. restoreLogPaneLayout 恢复日志分栏 ---
  window.restoreLogPaneLayout();
  const lps = LP();
  assert(lps.length === 2, `恢复 2 日志栏 (got ${lps.length})`);
  assert(lps[0].view === 'log' && lps[0].projectId === 'A', '恢复日志栏');
  assert(window.__getLogActive() === lps[0].id, '日志激活栏恢复到保存的下标');

  // --- 2c. 终端 panes 中残留的 log 视图在恢复时降级为 empty（日志已剥离） ---
  ls.setItem('paneLayout', JSON.stringify({ panes: [{ projectId: 'A', view: 'log' }], active: 0 }));
  window.restorePaneLayout();
  assert(P().length === 1 && P()[0].view === 'empty', '终端布局残留 log 视图 → 恢复为 empty');

  // --- 3. active 越界兜底 ---
  ls.setItem('paneLayout', JSON.stringify({ panes: [{ projectId: null, view: 'empty' }], active: 5 }));
  window.restorePaneLayout();
  assert(P().length === 1 && window.__getActive() === P()[0].id, 'active 越界兜底为唯一栏');

  // --- 4. 损坏数据兜底为单栏空白 ---
  ls.setItem('paneLayout', 'not-json');
  window.restorePaneLayout();
  assert(P().length === 1 && P()[0].view === 'empty' && P()[0].projectId === null, '损坏数据兜底单栏空白');

  // --- 5. 无数据兜底为单栏空白 ---
  ls.removeItem('paneLayout');
  window.restorePaneLayout();
  assert(P().length === 1 && P()[0].view === 'empty', '无数据兜底单栏空白');

  // --- 6. reconnectSessionPanes 存活判定：WS 已重建的会话原地保留，已死的回退空白 ---
  //     日志栏已分离，终端 panes 只含 empty/会话；empty 栏不参与重连。
  P().length = 0;
  P().push({ id: 'q1', projectId: 'A', view: 'c_1' });  // 存活：termSessions 有 c_1
  P().push({ id: 'q2', projectId: 'B', view: 'c_2' });  // 已死：termSessions 无 c_2
  P().push({ id: 'q3', projectId: null, view: 'empty' });  // empty 栏不受影响
  window.__setActive('q2');
  window.__termSessions.set('c_1', { projectId: 'A', sessionNumber: 1, type: 'claude' });
  await window.reconnectSessionPanes();

  const rc = P();
  assert(rc[0].view === 'c_1' && rc[0].projectId === 'A', '存活会话栏原地保留（重连）');
  assert(rc[1].view === 'empty' && rc[1].projectId === null, '已死会话栏回退空白');
  assert(rc[2].view === 'empty' && rc[2].projectId === null, 'empty 栏不受影响');
  assert(window.__getActive() === rc[1].id, '激活栏（已死会话）降级空白后仍保持激活');

  // --- 6b. 全部存活时 reconnectSessionPanes 不做任何变更 ---
  P().length = 0;
  P().push({ id: 'r1', projectId: 'A', view: 'c_1' });
  window.__setActive('r1');
  await window.reconnectSessionPanes();
  assert(P()[0].view === 'c_1' && P()[0].projectId === 'A', '全部存活时保持原布局');

  window.__termSessions.clear();

  console.log(fails ? `\n${fails} FAIL` : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})();
