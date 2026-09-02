'use strict';
// 编辑器保存冲突前端路径（jsdom）
// 回归背景：服务端按 mtime 做冲突检测，PUT file-content 回 conflict:true 时前端弹
// 三按钮确认框（重新加载 / 保留本地内容 / 覆盖磁盘版本），三条分支各自闭环：
//   - 覆盖：二次 PUT mtime:null 强制写，成功后以本地内容为新基线（dirty=false、撤销栈重建）
//   - 重新加载：GET file-content 回填磁盘内容为新基线
//   - 保留本地内容：什么都不发生（tab 保持 dirty，用户可再次保存）
// 覆盖：conflict 三分支 + 非冲突正常保存（mtime 更新/脏标清除）+ mtime 未加载禁止保存。
// 时序注意：saveFileViewActive 用 tab.content（stashActiveFvTab 从 DOM 写回），需先有
// contenteditable 的 code 元素内容；showConfirm 经 confirmChain 排队，点击前必须等显示。
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
if (!scripts.length) throw new Error('未找到内联脚本');
const inlineScript = scripts[scripts.length - 1][1] + `
window.__fv = () => {
  const t = fvTabs.get(fvActiveSub);
  return t ? { sub: t.sub, content: t.content, mtime: t.mtime, dirty: t.dirty, saved: t.savedContent } : null;
};
window.__setMtime = (v) => { fvTabs.get(fvActiveSub).mtime = v; };
window.__save = () => saveFileViewActive();
window.__waitShown = () => new Promise((resolve, reject) => {
  const ov = document.getElementById('confirmOverlay');
  const t0 = Date.now();
  (function poll() {
    if (ov.classList.contains('show') && document.getElementById('confirmMsg').textContent) return resolve();
    if (Date.now() - t0 > 1000) return reject(new Error('dialog not shown in 1s'));
    setTimeout(poll, 5);
  })();
});
`;

const dom = new JSDOM(html, {
  url: 'http://localhost:7777/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;

// --- 可控后端：PUT 按测试脚本设定回包（默认成功；conflict 分支由用例切换）---
let putHandler = null;   // (urlBody) => body —— PUT file-content 时调用
let getHandler = null;   // () => body —— GET file-content（重新加载分支）时调用
const fakeProjects = [
  { id: 'p1', name: 'Alpha', type: 'folder', running: false, projectPath: 'D:/a' },
];
window.fetch = async (url, opts) => {
  const u = String(url);
  const method = (opts && opts.method) || 'GET';
  if (u.includes('/file-content')) {
    if (method === 'PUT') {
      const reqBody = JSON.parse(opts.body);
      if (putHandler) return { json: async () => putHandler(reqBody) };
      return { json: async () => ({ ok: true, mtime: 200 }) };
    }
    // GET
    if (getHandler) return { json: async () => getHandler() };
    return { json: async () => ({ ok: true, content: 'disk version\n', mtime: 300 }) };
  }
  if (u === '/api/projects') return { json: async () => fakeProjects };
  if (u.includes('/files')) return { json: async () => ({ ok: true, items: [] }) };
  return { json: async () => ({ ok: true }) };
};
window.WebSocket = class { constructor() {} send() {} close() {} };
window.Terminal = class {};
window.FitAddon = { FitAddon: class { fit() {} loadAddon() {} } };
window.HTMLElement.prototype.setPointerCapture = function () {};
window.HTMLElement.prototype.releasePointerCapture = function () {};
// jsdom 未实现 innerText：编辑器 stash/撤销栈读写它，代理到 textContent
Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
  get() { return this.textContent; },
  set(v) { this.textContent = v; },
});

window.eval(inlineScript);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, msg) {
  if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; }
  else console.log('PASS: ' + msg);
}

// 往确认框点按钮（与 confirm-dialog.test.js 同手法：bubbles 事件）
function clickConfirm(window_, id) {
  window_.document.getElementById(id).dispatchEvent(new window_.Event('click', { bubbles: true }));
}

(async () => {
  await wait(20);
  await window.loadProjects();
  const doc = window.document;

  // --- 准备：打开文件查看器并让 tab 处于可保存态（mtime 已加载） ---
  window.openFileDrawer('p1');
  await window.openFileViewer('README.md');
  await wait(20);
  // 模拟用户编辑：直接改 code 元素文本并派发 input（dirty 由 input 监听置位，
  // stashActiveFvTab 从 DOM 读回 tab.content 并去掉末尾换行）
  const codeEl = doc.getElementById('fileViewCode');
  if (!codeEl) throw new Error('未找到编辑器 code 元素（fileViewCode）');
  const edit = (text) => {
    codeEl.textContent = text;
    codeEl.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  edit('local edit');

  // --- 1. mtime 未加载（null）禁止保存 ---
  {
    const t = window.__fv();
    const savedMtime = t.mtime;
    // 临时把 mtime 置 null 模拟内容未加载完成
    window.__setMtime(null);
    window.__save();
    await wait(10);
    assert(doc.getElementById('confirmOverlay').classList.contains('show') === false, 'mtime 未加载：不弹任何框');
    // 无 PUT 发生：恢复 mtime 后 dirty 应仍为初始态（无变化写入）
    window.__setMtime(savedMtime);
  }

  // --- 2. 非冲突正常保存：mtime 更新、脏标清除、savedContent 为新基线 ---
  {
    window.__save();
    await wait(30);
    const t = window.__fv();
    assert(t.mtime === 200, '正常保存：mtime 更新为服务端返回值');
    assert(t.dirty === false, '正常保存：脏标清除');
    assert(t.saved === 'local edit', '正常保存：savedContent 为新基线（本地编辑内容）');
  }

  // --- 3. 冲突 → 覆盖磁盘版本：二次 PUT mtime:null，成功后以本地内容为基线 ---
  {
    edit('conflict edit');
    let secondPutBody = null;
    let putCalls = 0;
    putHandler = (reqBody) => {
      putCalls++;
      if (putCalls === 1) return { conflict: true }; // 第一次：冲突
      secondPutBody = reqBody;
      return { ok: true, mtime: 400 }; // 第二次（force）：成功
    };
    const savePromise = window.__save();
    await window.__waitShown();
    assert(doc.getElementById('confirmThird').textContent === '覆盖磁盘版本', '冲突弹三按钮：第三按钮「覆盖磁盘版本」');
    clickConfirm(window, 'confirmThird');
    await savePromise;
    await wait(10);
    const t = window.__fv();
    assert(secondPutBody && secondPutBody.mtime === null, '覆盖分支：二次 PUT mtime 为 null（绕过冲突检测）');
    assert(t.mtime === 400, '覆盖分支：mtime 更新为强制保存返回值');
    assert(t.dirty === false && t.saved === 'conflict edit', '覆盖分支：本地内容成为新基线');
    putHandler = null;
  }

  // --- 4. 冲突 → 重新加载：GET 回填磁盘内容为新基线 ---
  {
    edit('another conflict edit');
    putHandler = () => ({ conflict: true });
    getHandler = () => ({ ok: true, content: 'disk version 2\n', mtime: 500 });
    const savePromise = window.__save();
    await window.__waitShown();
    clickConfirm(window, 'confirmOk'); // okText「重新加载」= resolve true
    await savePromise;
    await wait(10);
    const t = window.__fv();
    assert(t.content === 'disk version 2\n', '重新加载分支：内容回填磁盘版本'); // GET 回填带原样换行，不去尾
    assert(t.mtime === 500, '重新加载分支：mtime 取磁盘值');
    assert(t.dirty === false, '重新加载分支：脏标清除');
    putHandler = null; getHandler = null;
  }

  // --- 5. 冲突 → 保留本地内容：什么都不发生（保持 dirty） ---
  {
    edit('keep me');
    putHandler = () => ({ conflict: true });
    const savePromise = window.__save();
    await window.__waitShown();
    clickConfirm(window, 'confirmCancel'); // cancelText「保留本地内容」= resolve false
    await savePromise;
    await wait(10);
    const t = window.__fv();
    assert(t.content === 'keep me', '保留分支：本地内容不动');
    assert(t.dirty === true, '保留分支：tab 保持脏态（可再次保存）');
    putHandler = null;
  }

  // --- 6. 冲突 → 强制覆盖失败：toast 报错且 tab 不落基线 ---
  {
    edit('fail overwrite');
    let putCalls = 0;
    putHandler = () => { putCalls++; return putCalls === 1 ? { conflict: true } : { ok: false, msg: '磁盘写入失败' }; };
    const savePromise = window.__save();
    await window.__waitShown();
    clickConfirm(window, 'confirmThird');
    await savePromise;
    await wait(10);
    const t = window.__fv();
    assert(t.dirty === true, '覆盖失败分支：tab 仍为脏态（不落基线）');
    assert(t.mtime === 500, '覆盖失败分支：mtime 不变');
    putHandler = null;
  }

  console.log(process.exitCode ? '\n有失败项' : '\n全部通过');
})();
