// 分栏布局持久化：persistPanes 原样存储（会话栏保留 sessionId）+ restorePaneLayout 恢复与兜底
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
const inlineScript = scripts[scripts.length - 1][1] +
  '\nwindow.__getPanes = () => panes; window.__getActive = () => activePaneId; window.__setActive = (id) => activePaneId = id; window.__termSessions = termSessions; window.__setProjects = (arr) => { projects.length = 0; projects.push(...arr); };';

const dom = new JSDOM(html, { url: 'http://localhost:7777/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;

// fetch 桩：按路由模拟后端。会话列表路由返回 { ok, sessions }，
// sessions 只包含 termSessions 里仍存活的会话——模拟「后端只列出真活着的会话」。
// 其余路由（项目列表等）返回空数组，与原桩行为一致。
let fakeProjects = [];
window.fetch = async (url) => {
  const u = String(url);
  const m = u.match(/\/api\/projects\/([^/]+)\/(claude|codex)-sessions(?:\/|$)/);
  if (m) {
    const [, projId, type] = m;
    const sessions = [];
    window.__termSessions.forEach((rec, sid) => {
      if (rec.projectId === projId && rec.type === type && String(sid).startsWith(type[0] + '_')) {
        sessions.push({ sessionId: sid, sessionNumber: rec.sessionNumber });
      }
    });
    return { json: async () => ({ ok: true, sessions }) };
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

  // --- 2. restorePaneLayout 恢复：重建栏数、empty/会话视图、激活栏 ---
  window.restorePaneLayout();
  const ps = P();
  assert(ps.length === 2, `恢复 2 栏 (got ${ps.length})`);
  assert(ps[0].view === 'empty' && ps[0].projectId === null, '恢复 empty 栏');
  assert(ps[1].view === 'c_1' && ps[1].projectId === 'A', '恢复会话视图（保留 projectId 供重连判定）');
  assert(window.__getActive() === ps[1].id, '激活栏恢复到保存的下标');

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
  window.__setProjects([{ id: 'A' }, { id: 'B' }]);
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
