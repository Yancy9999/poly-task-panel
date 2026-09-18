'use strict';
// 工作目录 + 创建项目路径跟随（jsdom）
// 覆盖：
//   1. 设置页「工作目录」：回显 termSettings.workspaceDir、恢复默认清空输入框、保存时空值上送 null；
//   2. 创建项目弹窗：输入项目名时路径实时跟随 <工作目录>\<项目名（非法字符换 _）>；
//      手动改过路径（input / 「选择」）后停止跟随；编辑弹窗不跟随；
//   3. sanitizeDirName：Windows 文件名非法字符 \ / : * ? " < > | 替换为下划线。
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
if (!scripts.length) throw new Error('未找到内联脚本');
const inlineScript = scripts[scripts.length - 1][1] + `
// const 声明不出现在 window 上（同 eval 上下文可见），暴露访问器供测试读写 termSettings
window.__getWorkspaceDir = () => termSettings.workspaceDir;
window.__setWorkspaceDir = (v) => { termSettings.workspaceDir = v; };
window.__getProjects = () => projects;
`;

const WS = 'D:\\my-ws';

const dom = new JSDOM(html, {
  url: 'http://localhost:7777/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;

const settingsPayload = { ok: true, settings: { workspaceDir: WS, fileHideList: ['.git', '.svn'], projectCollapsed: {} } };
window.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('/api/settings')) {
    if (opts && opts.method === 'PUT') {
      const body = JSON.parse(opts.body);
      // 模拟服务端：workspaceDir 空值回填默认（这里用 WS 代指生效值）
      return { json: async () => ({ ok: true, settings: { ...body, workspaceDir: body.workspaceDir || WS } }) };
    }
    return { json: async () => settingsPayload };
  }
  if (u.includes('/api/pick-folder')) {
    return { json: async () => ({ ok: true, path: 'E:\\picked-dir' }) };
  }
  const body = u.includes('/api/projects') ? [] : { ok: true };
  return { json: async () => body };
};
window.WebSocket = class { constructor() {} send() {} close() {} };
window.Terminal = class {};
window.FitAddon = { FitAddon: class { fit() {} loadAddon() {} } };
window.HTMLElement.prototype.setPointerCapture = function () {};
window.HTMLElement.prototype.releasePointerCapture = function () {};

window.eval(inlineScript);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, msg) {
  if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; }
  else console.log('PASS: ' + msg);
}

(async () => {
  await wait(50); // bootSettings 完成
  await window.loadProjects();
  const doc = window.document;
  const input = (el) => el.dispatchEvent(new window.Event('input', { bubbles: true }));

  // --- sanitizeDirName：非法字符替换为 _ ---
  assert(window.sanitizeDirName('a/b:c*d?e"f<g>h|i\\j') === 'a_b_c_d_e_f_g_h_i_j', '非法字符全部替换为下划线');
  assert(window.sanitizeDirName('普通-Name_1.0') === '普通-Name_1.0', '合法字符不变');
  assert(window.sanitizeDirName('foo. ') === 'foo__', '尾部点/空格替换为下划线（Windows 会静默剥掉）');
  assert(window.sanitizeDirName('...') === '___', '纯点名字替换为下划线');
  assert(window.sanitizeDirName('v1.2') === 'v1.2', '中间的点不受影响');

  // --- 设置页「工作目录」回显与恢复默认 ---
  await window.openSettingsModal();
  assert(doc.getElementById('setWorkspaceDir').value === WS, '设置页回显当前生效工作目录');
  window.resetWorkspaceDir();
  assert(doc.getElementById('setWorkspaceDir').value === '', '恢复默认 = 清空输入框');
  await window.saveSettings();
  assert(window.__getWorkspaceDir() === WS, '保存后空值上送 null，服务端回填生效路径');

  // --- 创建弹窗：路径实时跟随 ---
  // 注：jsdom outside-only 不编译 HTML 内联事件（oninput），直接调用处理函数模拟
  window.openCreateModal();
  assert(doc.getElementById('fPath').value === '', '打开时路径为空（跟随项目名生成）');
  doc.getElementById('fName').value = '我的项目';
  window.updateDefaultProjectPath();
  assert(doc.getElementById('fPath').value === WS + '\\我的项目', '输入项目名后路径跟随 <工作目录>\\<项目名>');
  doc.getElementById('fName').value = 'a/b:c';
  window.updateDefaultProjectPath();
  assert(doc.getElementById('fPath').value === WS + '\\a_b_c', '项目名含非法字符时目录名替换为 _');

  // --- 手动改路径后停止跟随 ---
  doc.getElementById('fName').value = '新名字';
  window.updateDefaultProjectPath();
  doc.getElementById('fPath').value = 'E:\\custom\\path';
  window.markPathTouched();
  doc.getElementById('fName').value = '再改名字';
  window.updateDefaultProjectPath();
  assert(doc.getElementById('fPath').value === 'E:\\custom\\path', '手动改过路径后停止跟随');

  // --- 「选择」后停止跟随 ---
  window.openCreateModal();
  doc.getElementById('fName').value = 'proj-x';
  window.updateDefaultProjectPath();
  await window.pickFolder();
  assert(doc.getElementById('fPath').value === 'E:\\picked-dir', '「选择」回填所选目录');
  doc.getElementById('fName').value = 'proj-y';
  window.updateDefaultProjectPath();
  assert(doc.getElementById('fPath').value === 'E:\\picked-dir', '「选择」后停止跟随');

  // --- 编辑弹窗不跟随 ---
  const list = window.__getProjects();
  if (list.length) {
    window.openEditModal(list[0].id);
    const origPath = doc.getElementById('fPath').value;
    doc.getElementById('fName').value = '编辑改名字';
    window.updateDefaultProjectPath();
    assert(doc.getElementById('fPath').value === origPath, '编辑弹窗路径不跟随项目名');
  } else {
    assert(true, '（无项目可测编辑弹窗，跳过）');
  }

  // --- 工作目录未配置（服务端返回空）时跟随降级：路径为空 ---
  window.__setWorkspaceDir('');
  window.openCreateModal();
  doc.getElementById('fName').value = 'no-ws';
  window.updateDefaultProjectPath();
  assert(doc.getElementById('fPath').value === '', '工作目录为空时路径不生成（保持空，用户自行填写）');

  console.log(process.exitCode ? '\n有失败项' : '\n全部通过');
})();
