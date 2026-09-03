'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn, exec, execSync, execFile, spawnSync } = require('child_process');
const express = require('express');
const WebSocket = require('ws');

// node-pty：claude 是交互式 TTY 程序，检测 isatty，管道喂 stdin 不认。
// 必须起真 PTY，claude 才认为自己在跟真终端对话，TUI 才完整可用。
// node-pty 是 native C++ addon，ABI 必须与运行它的 node 一致——
// release 构建用打包进 resources 的固定 node（ticket 01），ABI 必然匹配。
let pty = null;
try {
  pty = require('node-pty');
} catch (e) {
  // dev 机未装 node-pty 时不致命：claude 终端功能不可用，但启动器其余功能照常。
  // 创建 claude 会话时会返回明确错误。
  console.error('node-pty 加载失败，claude 终端功能不可用:', e.message);
}

// ---------------------------------------------------------------------------
// 配置
// 端口优先级：命令行 --port=N > 环境变量 PORT > 默认 7777。
// 套壳（Tauri）时由 Rust 壳选空闲端口传入，避免与已占用端口冲突；
// 直连（run.bat）时无参，仍用 7777，向后兼容。
// ---------------------------------------------------------------------------
const PORT = (() => {
  const arg = process.argv.find((a) => a.startsWith('--port='));
  if (arg) {
    const n = parseInt(arg.slice('--port='.length), 10);
    if (n > 0 && n < 65536) return n;
  }
  if (process.env.PORT) {
    const n = parseInt(process.env.PORT, 10);
    if (n > 0 && n < 65536) return n;
  }
  return 7777;
})();
const ROOT_DIR = __dirname;
// PROJECTS_FILE / PUBLIC_DIR 允许环境变量覆盖：测试在临时目录跑独立 projects.json，
// 断言"创建 claude 会话不污染持久化"时不会动到真实数据。
const PROJECTS_FILE = process.env.PROJECTS_FILE
  ? path.resolve(process.env.PROJECTS_FILE)
  : path.join(ROOT_DIR, 'projects.json');
// SETTINGS_FILE 同理：设置面板全部配置（字体/命令/文件黑名单）持久化文件，测试用临时目录隔离。
const SETTINGS_FILE = process.env.SETTINGS_FILE
  ? path.resolve(process.env.SETTINGS_FILE)
  : path.join(ROOT_DIR, 'settings.json');
const PUBLIC_DIR = process.env.PUBLIC_DIR
  ? path.resolve(process.env.PUBLIC_DIR)
  : path.join(ROOT_DIR, 'public');
// Claude Code 历史会话根目录（~/.claude/projects），测试可指向临时目录隔离。
// 目录编码规则与 Claude Code 一致：绝对路径中非 [a-zA-Z0-9-] 全部替换为 '-'。
const CLAUDE_PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR
  ? path.resolve(process.env.CLAUDE_PROJECTS_DIR)
  : path.join(os.homedir(), '.claude', 'projects');
// Codex 历史会话根目录（~/.codex/sessions，按 YYYY/MM/DD 分层存放 rollout-*.jsonl）。
// pi 历史会话根目录（~/.pi/agent/sessions，下按编码后的项目路径分目录）。测试可覆盖隔离。
const CODEX_SESSIONS_DIR = process.env.CODEX_SESSIONS_DIR
  ? path.resolve(process.env.CODEX_SESSIONS_DIR)
  : path.join(os.homedir(), '.codex', 'sessions');
const PI_SESSIONS_DIR = process.env.PI_SESSIONS_DIR
  ? path.resolve(process.env.PI_SESSIONS_DIR)
  : path.join(os.homedir(), '.pi', 'agent', 'sessions');
// 编码函数作为 createTerminalSession 同级工具，历史会话查询与 CLI 目录名共用一套规则。
function encodeClaudeProjectDir(p) {
  return p.replace(/[^a-zA-Z0-9-]/g, '-');
}

// 终端会话 spawn 的命令/参数/消息类型，按类型区分 claude 与 codex。
// 默认 `claude` / `codex`；可用 CLAUDE_BIN/CLAUDE_ARGS、CODEX_BIN/CODEX_ARGS 覆盖
// （测试时注入假的 CLI 可执行，避免依赖外部 CLI 行为与网络）。
// CLAUDE_ARGS 类似：空格分隔的额外参数（测试用 `node fake-claude.js` 时传脚本路径）。
// 各类型的 args 为"默认值，env 覆盖优先"：codex 未设 CODEX_ARGS 时默认 `-a never`。
// Git Bash 可执行探测：`where git` 找到 git.exe（如 C:\Program Files\Git\cmd\git.exe），
// 同一安装根下的 bin\bash.exe 即 Git Bash。找不到时回退常见安装路径，仍失败返回
// 裸名 'bash'（让 spawn 报原错，便于排错）。非 Windows 直接返回 'bash'。
function detectGitBash() {
  if (process.platform !== 'win32') return 'bash';
  const candidates = [];
  try {
    const gitPath = execSync('where git', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim().split(/\r?\n/)[0];
    if (gitPath) {
      // <Git 根>/cmd/git.exe -> <Git 根>/bin/bash.exe
      candidates.push(path.join(path.dirname(path.dirname(gitPath)), 'bin', 'bash.exe'));
    }
  } catch (e) {}
  candidates.push(
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
  );
  return candidates.find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } }) || 'bash';
}

// binResolved 在定义后统一填（见 resolveTerminalBin 下方）。
const TERMINAL_TYPES = {
  claude: {
    bin: process.env.CLAUDE_BIN || 'claude',
    // 默认跳过权限确认（与 codex 的 -a never 思路一致）；设了 CLAUDE_ARGS 则整体覆盖
    args: process.env.CLAUDE_ARGS
      ? process.env.CLAUDE_ARGS.split(' ').filter(Boolean)
      : ['--dangerously-skip-permissions'],
    binResolved: null,
    idPrefix: 'c_',        // 会话 id 前缀：与项目 id（p_ 前缀）命名空间区分
    msgOutput: 'claude-output',
    msgInput: 'claude-input',
    msgSession: 'claude-session',
  },
  codex: {
    bin: process.env.CODEX_BIN || 'codex',
    args: process.env.CODEX_ARGS
      ? process.env.CODEX_ARGS.split(' ').filter(Boolean)
      : ['-a', 'never'],   // 默认让 codex 不自动批准工具调用；设了 CODEX_ARGS 则整体覆盖
    binResolved: null,
    idPrefix: 'x_',
    msgOutput: 'codex-output',
    msgInput: 'codex-input',
    msgSession: 'codex-session',
  },
  // cmd：在项目目录里开一个交互式 Windows cmd shell（COMSPEC 通常是 cmd.exe 的绝对路径）。
  // 不带任何参数——直接进入 cmd 交互式提示符，与“在资源管理器里打开 cmd”一致。
  cmd: {
    bin: process.env.COMSPEC || 'cmd.exe',
    args: [],
    binResolved: null,
    idPrefix: 'm_',        // m_ = monitor/命令行，与 c_(claude)/x_(codex) 命名空间区分
    msgOutput: 'cmd-output',
    msgInput: 'cmd-input',
    msgSession: 'cmd-session',
  },
  // gitbash：在项目目录里开一个交互式 Git Bash（Git for Windows 自带的 bash.exe），
  // 走真 PTY + xterm，与 cmd 会话同一套会话管理。bin 默认按安装目录探测，
  // 可用 GIT_BASH_BIN 环境变量覆盖（测试可注入假可执行）。登录 shell（-l）
  // 使 PATH 等环境与双击 Git Bash 图标一致。
  gitbash: {
    bin: process.env.GIT_BASH_BIN || detectGitBash(),
    args: ['-l'],           // 登录 shell：加载 /etc/profile，PATH 含 Git 工具链
    binResolved: null,
    idPrefix: 'g_',        // g_ = git bash，与 c_(claude)/x_(codex)/m_(cmd)/i_(pi) 命名空间区分
    msgOutput: 'gitbash-output',
    msgInput: 'gitbash-input',
    msgSession: 'gitbash-session',
  },
  // pi：与 claude/codex 同级的交互式 agent CLI，走真 PTY + xterm。
  // 默认 `pi`；可用 PI_BIN/PI_ARGS 覆盖（测试可注入假可执行）。无默认参数。
  // idPrefix 用 i_——p_ 已被项目 id 占用，前缀反推 type 时不能与项目 id 混淆。
  pi: {
    bin: process.env.PI_BIN || 'pi',
    args: process.env.PI_ARGS
      ? process.env.PI_ARGS.split(' ').filter(Boolean)
      : [],
    binResolved: null,
    idPrefix: 'i_',
    msgOutput: 'pi-output',
    msgInput: 'pi-input',
    msgSession: 'pi-session',
  },
};

// Windows 下 node-pty.spawn 直接调 CreateProcess，不解析 PATHEXT，也不自动补 .cmd。
// npm 全局装的 `claude`/`codex` 实为 .cmd 包装脚本，裸名 spawn 会 error code 2（文件未找到）。
// 故 Windows 上对裸命令名用 where 解析出带扩展名的真实路径（.cmd/.bat/.exe）。
// 绝对路径 / 已带扩展名 / 非 Windows 则原样返回。
function resolveTerminalBin(bin) {
  if (process.platform !== 'win32') return bin;
  if (path.isAbsolute(bin) || /\.[a-z]+$/i.test(bin)) return bin;
  try {
    const out = execSync(`where ${bin}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim().split(/\r?\n/);
    // 优先 .cmd/.bat/.exe；where 按 PATHEXT 顺序列出，取第一个即可
    const hit = out.find((p) => /\.(cmd|bat|exe)$/i.test(p)) || out[0];
    if (hit && fs.existsSync(hit)) return hit;
  } catch (e) {}
  return bin; // 解析失败原样返回，让 spawn 报原错（便于排错）
}
for (const key of Object.keys(TERMINAL_TYPES)) {
  TERMINAL_TYPES[key].binResolved = resolveTerminalBin(TERMINAL_TYPES[key].bin);
}

// ---------------------------------------------------------------------------
// 持久化：projects.json
// ---------------------------------------------------------------------------
function loadProjects() {
  try {
    const raw = fs.readFileSync(PROJECTS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('读取 projects.json 失败:', e.message);
    return [];
  }
}

function saveProjects(projects) {
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2), 'utf-8');
}

let projects = loadProjects();

// id -> project 的索引，热路径（appendFileChain / flushPendingLogs / clearLogFile /
// readLogHistory 每条日志都会查）用它 O(1) 取代 projects.find 的 O(n) 线性扫描。
// 与 projects 数组同步维护：增删/重排/加载处都走 rebuildProjectsIndex。
const projectsById = new Map();
function rebuildProjectsIndex() {
  projectsById.clear();
  for (const p of projects) projectsById.set(p.id, p);
}
function getProject(id) {
  return projectsById.get(id);
}

// 旧数据迁移：SpringBoot 项目缺少 compileDependencies 字段时按默认（勾选）补齐，
// 并重新生成 start.bat，让"默认勾选"对既有项目也生效。
let migrated = false;
for (const p of projects) {
  if (p.type === 'springboot' && p.compileDependencies === undefined) {
    p.compileDependencies = true;
    migrated = true;
  }
}
if (migrated) saveProjects(projects);
rebuildProjectsIndex();

// ---------------------------------------------------------------------------
// 持久化：settings.json（设置面板全部配置：终端字体 / 各类命令 / 文件树黑名单）
// 与 projects.json 同模式：启动读入内存，保存整体写回。字段做白名单过滤与
// 容错归一（localStorage 旧数据 / 手改坏文件都不至于让接口 500）。
// ---------------------------------------------------------------------------
// 文件树黑名单默认值：精确匹配条目名（非前缀），.gitignore / .env 等不受影响。
const DEFAULT_FILE_HIDE_LIST = ['.git', '.svn'];
// 默认字体与前端 FONT_PRESETS[0].value 保持一致（前端自定义字体时存的是完整 font-family 串）
const DEFAULT_SETTINGS = {
  fontFamily: '"Cascadia Code", Consolas, monospace',
  fontSize: 13,
  claudeCommands: null,
  codexCommands: null,
  piCommands: null,
  agentQuickTexts: null,
  cmdQuickTexts: null,
  fileHideList: DEFAULT_FILE_HIDE_LIST.slice(),
};
// 命令列表归一：[{cmd,desc}]，cmd 非空字符串；空列表/非法结构存 null（读取端回退默认命令集）
function sanitizeCommandList(list) {
  if (!Array.isArray(list)) return null;
  const out = list
    .filter((c) => c && typeof c === 'object' && typeof c.cmd === 'string' && c.cmd.trim())
    .map((c) => ({ cmd: c.cmd.trim(), desc: typeof c.desc === 'string' ? c.desc.trim() : '' }));
  return out.length ? out : null;
}
// 常用文本归一（终端状态栏「常用文本」按钮）：非空字符串数组，去空白、去重；空列表/非法结构存 null
function sanitizeQuickTexts(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const s = item.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out.length ? out : null;
}
// 黑名单归一：字符串数组，去空白、去重；非法输入回退默认
function sanitizeFileHideList(list) {
  if (!Array.isArray(list)) return DEFAULT_FILE_HIDE_LIST.slice();
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const s = item.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out.length ? out : DEFAULT_FILE_HIDE_LIST.slice();
}
// 设置对象归一：只挑白名单字段，缺失字段用默认值补齐（前端逐版本加字段时旧文件也能读）
function normalizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const fontSize = Number(src.fontSize);
  return {
    fontFamily: typeof src.fontFamily === 'string' && src.fontFamily.trim() ? src.fontFamily.trim() : DEFAULT_SETTINGS.fontFamily,
    fontSize: Number.isFinite(fontSize) ? Math.min(24, Math.max(10, fontSize)) : DEFAULT_SETTINGS.fontSize,
    claudeCommands: sanitizeCommandList(src.claudeCommands),
    codexCommands: sanitizeCommandList(src.codexCommands),
    piCommands: sanitizeCommandList(src.piCommands),
    agentQuickTexts: sanitizeQuickTexts(src.agentQuickTexts),
    cmdQuickTexts: sanitizeQuickTexts(src.cmdQuickTexts),
    fileHideList: sanitizeFileHideList(src.fileHideList),
  };
}
function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    return normalizeSettings(JSON.parse(raw));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('读取 settings.json 失败:', e.message);
    return DEFAULT_SETTINGS; // 无文件/坏文件：用默认（内存态），首次保存才落盘
  }
}
function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
}
let settings = loadSettings();

// ---------------------------------------------------------------------------
// 运行时进程注册表：projectId -> { proc, pid, pendingFlush }
// 历史日志全量落盘到 start.log（readLogHistory 读文件尾部），无需内存缓冲。
// ---------------------------------------------------------------------------
const runs = new Map();

// 文件写入：批量缓冲 + 串行链 + 清空 epoch。
// 高频日志下每块都 appendFile 会把磁盘写入与 promise 链变成瓶颈；
// 改为每项目一个内存待写缓冲 pendingFlush，由定时器（每 FLUSH_INTERVAL_MS）
// 批量落盘一次，把 N 次小写合并成 1 次。
// 串行链仍保留：清空（clearLogFile）用 writeFileSync 截断，飞行中的 flush 可能把旧日志
// 写回文件（清空后内容"又回来"）。故 flush 写盘前校验 epoch，清空时递增 epoch 让飞行中的旧写入失效。
const logChains = new Map();
const fileEpochs = new Map();
const FLUSH_INTERVAL_MS = 200;
// flush 计数器：每 FLUSH_SIZE_CHECK 次 flush 才 stat 一次文件大小做轮转检查，避免每次 flush 都 stat
const FLUSH_SIZE_CHECK_EVERY = 50;
const flushCounter = new Map();

// 启动器产生的日志/脚本统一放在用户本地数据目录下，按项目 id 命名，
// 不再写进项目目录 —— 否则会落在 Vite 的 watch 范围内，
// 冷启动期间触发 handleHotUpdate 时 plugin-vue 的 compiler 尚未就绪，
// 崩在 invalidateTypeCache。
// 用 %LOCALAPPDATA%\PolyTaskPanel\projects，让运行时产物与源码彻底分离。
// 目录名与 productName 保持一致（installer 装在 Program Files\PolyTaskPanel）。
const LOGS_DIR = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'PolyTaskPanel', 'projects')
  : path.join(ROOT_DIR, 'logs');
try { fs.mkdirSync(LOGS_DIR, { recursive: true }); } catch (e) {}

function projectLogPath(projectId) {
  return path.join(LOGS_DIR, `${projectId}.log`);
}
function projectBatPath(projectId) {
  return path.join(LOGS_DIR, `${projectId}.bat`);
}

function ensureBuffer(projectId) {
  if (!runs.has(projectId)) {
    runs.set(projectId, { proc: null, pid: null, pendingFlush: '' });
  }
  return runs.get(projectId);
}

// 追加到该项目的待写盘缓冲（不立即写盘）。由 flushPendingLogs 定时批量落盘。
// 仅当项目存在时缓冲；清空（clearLogFile）会重置 epoch，flush 时据此丢弃过期内容。
function appendFileChain(projectId, line) {
  const p = getProject(projectId);
  if (!p) return Promise.resolve();
  const rec = ensureBuffer(projectId);
  rec.pendingFlush += line;
  return Promise.resolve();
}

// 单项目待写缓冲落盘（串行链，配合清空 epoch 防止旧写入污染）。
function flushProjectLog(projectId) {
  const rec = runs.get(projectId);
  if (!rec || !rec.pendingFlush) return Promise.resolve();
  const line = rec.pendingFlush;
  rec.pendingFlush = '';
  const logPath = projectLogPath(projectId);
  const epoch = fileEpochs.get(projectId) || 0;
  const prev = logChains.get(projectId) || Promise.resolve();
  const next = prev.then(() => {
    // 清空在排队期间发生 -> epoch 变了 -> 丢弃这条过期的旧写入
    if (epoch !== (fileEpochs.get(projectId) || 0)) return;
    return new Promise((resolve) => {
      fs.appendFile(logPath, line, () => resolve());
    });
  });
  logChains.set(projectId, next);
  return next;
}

// 日志文件大小上限：超过 MAX_LOG_FILE_BYTES 时裁剪到尾部尾部 MAX_LOG_KEEP_BYTES，
// 避免长跑项目日志文件无限膨胀。每 FLUSH_SIZE_CHECK_EVERY 次 flush 才 stat 一次，摊薄开销。
const MAX_LOG_FILE_BYTES = 5 * 1024 * 1024;      // 5MB 触发裁剪
const MAX_LOG_KEEP_BYTES = 256 * 1024;           // 裁剪后保留尾部 256KB
function maybeRotateLog(projectId) {
  const logPath = projectLogPath(projectId);
  let st;
  try { st = fs.statSync(logPath); } catch (e) { return; }
  if (!st || st.size <= MAX_LOG_FILE_BYTES) return;
  try {
    const fd = fs.openSync(logPath, 'r');
    const keep = Buffer.alloc(MAX_LOG_KEEP_BYTES);
    const start = st.size - MAX_LOG_KEEP_BYTES;
    fs.readSync(fd, keep, 0, MAX_LOG_KEEP_BYTES, start);
    fs.closeSync(fd);
    fs.writeFileSync(logPath, keep);
  } catch (e) {}
}

// 定时批量落盘所有项目的待写缓冲
function flushPendingLogs() {
  for (const projectId of runs.keys()) {
    const p = getProject(projectId);
    if (!p) continue;
    const cnt = (flushCounter.get(projectId) || 0) + 1;
    flushCounter.set(projectId, cnt);
    flushProjectLog(projectId).then(() => {
      if (cnt % FLUSH_SIZE_CHECK_EVERY === 0) maybeRotateLog(projectId);
    });
  }
}
// unref：该定时器不阻止进程退出（否则测试/退出时事件循环被挂住）。
// 真正退出时由 stopAllOnExit 同步 flush 残留缓冲，不依赖此定时器。
const flushTimer = setInterval(flushPendingLogs, FLUSH_INTERVAL_MS);
flushTimer.unref();

// 同步清空文件，并让排队中的旧写入失效；同时丢弃内存待写缓冲（清空后不应再落旧内容）
function clearLogFile(projectId) {
  fileEpochs.set(projectId, (fileEpochs.get(projectId) || 0) + 1);
  const p = getProject(projectId);
  if (!p) return;
  const rec = runs.get(projectId);
  if (rec) rec.pendingFlush = '';
  const logPath = projectLogPath(projectId);
  try { fs.writeFileSync(logPath, '', 'utf-8'); } catch (e) {}
}

// ---------------------------------------------------------------------------
// 日志：写文件 + 内存缓冲 + WebSocket 广播
// ---------------------------------------------------------------------------
// 广播批量缓冲：高频日志下每个 stdout chunk 都 broadcast 一次会让后端
// JSON.stringify + ws.send 成为瓶颈（前端 rAF 批量渲染缓解的是下游 DOM 压力，
// 上游这一环同样需要合并）。按项目累积 entries，由 broadcastFlushTimer
// 每 BROADCAST_INTERVAL_MS 合并成一条 {type:'log-batch'} 广播。
// status / session 等控制消息不合并，仍即时发。
const pendingBroadcast = new Map();   // projectId -> entries[]
const BROADCAST_INTERVAL_MS = 50;
let broadcastFlushScheduled = false;
function scheduleBroadcastFlush() {
  if (broadcastFlushScheduled) return;
  broadcastFlushScheduled = true;
  // 用 setTimeout 而非 setInterval：每次窗口起算自首条到达，避免空转，
  // 也让窗口自然贴合突发流量。unref 不阻止进程退出。
  const t = setTimeout(flushBroadcast, BROADCAST_INTERVAL_MS);
  if (t.unref) t.unref();
}
function flushBroadcast() {
  broadcastFlushScheduled = false;
  if (!pendingBroadcast.size) return;
  for (const [projectId, entries] of pendingBroadcast) {
    if (entries.length) {
      broadcast({ type: 'log-batch', projectId, entries });
      entries.length = 0;
    }
  }
}

function appendLog(projectId, line) {
  const entry = { ts: Date.now(), line };
  ensureBuffer(projectId);

  // 落盘（串行链，配合清空 epoch 防止旧写入污染）
  appendFileChain(projectId, line);

  // 广播给正在看该项目的客户端：累积进批量缓冲，下一窗口合并发一条 log-batch
  let entries = pendingBroadcast.get(projectId);
  if (!entries) { entries = []; pendingBroadcast.set(projectId, entries); }
  entries.push(entry);
  scheduleBroadcastFlush();
}

// 历史日志只读尾部 MAX_HISTORY_BYTES，避免大文件同步读冻结事件循环 +
// 前端渲染巨量节点。小文件（≤ 阈值）整读，保持原行为。仍按 64KB 块切。
const MAX_HISTORY_BYTES = 256 * 1024;
function readLogHistory(projectId) {
  const p = getProject(projectId);
  if (!p) return [];
  const logPath = projectLogPath(projectId);
  try {
    let raw;
    let st;
    try { st = fs.statSync(logPath); } catch (e2) {
      if (e2.code === 'ENOENT') return [];
      throw e2;
    }
    if (st.size > MAX_HISTORY_BYTES) {
      // 只读尾部 MAX_HISTORY_BYTES：用 fd 定位偏移读取
      const fd = fs.openSync(logPath, 'r');
      const buf = Buffer.alloc(MAX_HISTORY_BYTES);
      fs.readSync(fd, buf, 0, MAX_HISTORY_BYTES, st.size - MAX_HISTORY_BYTES);
      fs.closeSync(fd);
      raw = buf.toString('utf-8');
    } else {
      raw = fs.readFileSync(logPath, 'utf-8');
    }
    // 按 64KB 块切，避免单条过大；每块作为一条历史 entry
    const entries = [];
    const CHUNK = 65536;
    let ts = Date.now();
    for (let i = 0; i < raw.length; i += CHUNK) {
      entries.push({ ts: ts++, line: raw.slice(i, i + CHUNK) });
    }
    return entries;
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('读取历史日志失败:', e.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// 进程停止：taskkill /T /PID 递归杀进程树
// mvn 会 fork java 子进程，必须 /T 才不残留孤儿 java 进程占端口。
// ---------------------------------------------------------------------------
function killProcessTree(pid, cb) {
  if (!pid) return cb && cb();
  exec(`taskkill /T /F /PID ${pid}`, (err, stdout, stderr) => {
    if (cb) cb(err);
  });
}

function stopProject(projectId) {
  return new Promise((resolve) => {
    const rec = runs.get(projectId);
    if (!rec || !rec.pid) {
      resolve({ ok: true, msg: '未在运行' });
      return;
    }
    const pid = rec.pid;
    killProcessTree(pid, (err) => {
      appendLog(projectId, `\r\n[启动器] 进程已停止 (PID ${pid})\r\n`);
      if (rec.proc) {
        try { rec.proc.kill(); } catch (e) {}
      }
      rec.proc = null;
      rec.pid = null;
      broadcast({ type: 'status', projectId, running: false });
      resolve({ ok: !err, msg: err ? `停止失败: ${err.message}` : '已停止' });
    });
  });
}

// web 服务退出时：对所有在跑项目走一遍递归杀，确保不残留孤儿进程
function stopAllOnExit() {
  // 退出前同步 flush 残留的待写日志缓冲，避免最后一批日志丢失
  for (const projectId of runs.keys()) {
    const rec = runs.get(projectId);
    if (rec && rec.pendingFlush) {
      try { fs.appendFileSync(projectLogPath(projectId), rec.pendingFlush); } catch (e) {}
      rec.pendingFlush = '';
    }
  }
  for (const [projectId, rec] of runs) {
    if (rec.pid) {
      try { exec(`taskkill /T /F /PID ${rec.pid}`); } catch (e) {}
    }
  }
}
process.on('exit', stopAllOnExit);
process.on('SIGINT', () => { stopAllOnExit(); process.exit(0); });
process.on('SIGTERM', () => { stopAllOnExit(); process.exit(0); });

// ---------------------------------------------------------------------------
// 终端会话注册表（claude / codex）：sessionId -> { pty, pid, projectId, sessionNumber, type }
// 与项目进程注册表（runs Map）完全分离——终端会话只借宿主项目 projectPath
// 当 cwd，生命周期独立于宿主项目启停。不持久化，仅运行时内存。
// 会话 id 带类型前缀（c_=claude / x_=codex），与项目 id（p_ 前缀）命名空间区分，
// 避免前端混用。
// ---------------------------------------------------------------------------
const ptySessions = new Map();
const sessionSeqs = { claude: 0, codex: 0, cmd: 0, gitbash: 0, pi: 0 };

function newSessionId(type) {
  sessionSeqs[type] += 1;
  return TERMINAL_TYPES[type].idPrefix + sessionSeqs[type];
}

// 每个 projectId 下按类型独立分配会话序号（claude #1/#2、codex #1/#2…），
// 用于二级菜单显示。会话关闭后序号不复用（与"菜单项消失"语义一致，避免编号跳动混淆）。
const perProjectSeq = new Map();
function allocSessionNumber(projectId, type) {
  const key = projectId + '::' + type;
  const n = (perProjectSeq.get(key) || 0) + 1;
  perProjectSeq.set(key, n);
  return n;
}

// 递归杀 PTY 进程树：终端 CLI 可能 spawn 子进程（如执行工具命令），
// 必须 /T 才不残留孤儿。复用 CREATE_NO_WINDOW 抑制 taskkill 黑框。
function killPtySession(sessionId, reason) {
  const rec = ptySessions.get(sessionId);
  if (!rec) return;
  if (rec.pid) {
    try { exec(`taskkill /T /F /PID ${rec.pid}`); } catch (e) {}
  }
  // 关闭 PTY 句柄；node-pty 的 kill 走的是 TerminateProcess，已是兜底
  try { rec.pty.kill(); } catch (e) {}
  removePtySession(sessionId, reason);
}

function removePtySession(sessionId, reason) {
  const rec = ptySessions.get(sessionId);
  if (!rec) return;
  ptySessions.delete(sessionId);
  broadcast({
    type: TERMINAL_TYPES[rec.type].msgSession,
    event: 'exit',
    sessionId,
    projectId: rec.projectId,
    sessionType: rec.type,
    reason: reason || 'closed',
  });
}

// 终端会话子进程的 env 净化：启动器可能运行在 VSCode 等 IDE 环境（例如经本
// claude 会话的 Bash 拉起 dev 服务器），process.env 会混入 IDE/Claude Code 注入的
// 标记（CLAUDE_CODE_ENTRYPOINT=claude-vscode、CLAUDE_CODE_SESSION_ID、VSCODE_*、
// AI_AGENT、TRACEPARENT…）。claude 一看到 CLAUDE_CODE_ENTRYPOINT 就认为自己
// 是"IDE 拉起的会话"，会连回扩展拉取编辑器选区 context（输入框旁常驻
// "⧉ 1 line selected"）。故按前缀黑名单剔除这些注入变量，使 claude/codex 子进程
// 环境与"直接在 cmd 里启动"一致——不额外增加 IDE 变量，也不减少正常变量。
// 仅终端会话使用；宿主项目自身的 start 命令 env 不动。
function sanitizeTerminalEnv(baseEnv) {
  const out = { ...baseEnv };
  const IDE_PREFIXES = ['CLAUDE_CODE_', 'CLAUDE_', 'VSCODE_'];
  const IDE_EXACT = ['CLAUDECODE', 'AI_AGENT', 'TRACEPARENT', 'TRACESTATE'];
  for (const key of Object.keys(out)) {
    if (
      IDE_PREFIXES.some((p) => key.startsWith(p)) ||
      IDE_EXACT.includes(key)
    ) {
      delete out[key];
    }
  }
  return out;
}

// 创建一个终端会话（claude / codex / pi 等）：spawn 真 PTY，cwd = 宿主项目 projectPath。
// opts.resume：历史会话 id，按 CLI 各自的恢复方式追加启动参数：
//   claude `--resume <id>`；codex `resume <id>`（子命令）；pi `--session <id>`
//   （pi 的 --resume 是交互选择器，不能指定会话）。
const RESUME_ARGS = {
  claude: (id) => ['--resume', id],
  codex: (id) => ['resume', id],
  pi: (id) => ['--session', id],
};
function createTerminalSession(projectId, type, opts = {}) {
  const cfg = TERMINAL_TYPES[type];
  const p = getProject(projectId);
  if (!p) return { ok: false, msg: '项目不存在' };
  if (!pty) return { ok: false, msg: `node-pty 未加载，${type} 终端不可用` };
  if (!fs.existsSync(p.projectPath)) {
    return { ok: false, msg: '项目目录不存在: ' + p.projectPath };
  }

  const sessionId = newSessionId(type);
  const sessionNumber = allocSessionNumber(projectId, type);

  // resume：在默认/env 覆盖参数之后追加（CLAUDE_ARGS 等会整体覆盖默认参数，
  // 故必须 append 而非前置），按类型映射为各 CLI 的恢复参数。
  const args = cfg.args.slice();
  if (opts.resume) {
    const mk = RESUME_ARGS[type];
    if (mk) args.push(...mk(String(opts.resume)));
  }

  let term;
  try {
    // name: 'xterm-256color' 让 CLI 以为自己在 xterm，TUI 色彩/光标序列完整。
    // cwd 取宿主 projectPath；env 继承当前进程但剔除 IDE 注入变量（sanitizeTerminalEnv），
    // 使 claude/codex 子进程环境与"cmd 直接启动"一致（登录态、PATH 等照常继承）。
    term = pty.spawn(cfg.binResolved, args, {
      name: 'xterm-256color',
      cwd: p.projectPath,
      env: sanitizeTerminalEnv(process.env),
    });
  } catch (e) {
    return { ok: false, msg: `启动 ${type} 失败: ` + e.message };
  }

  const rec = {
    pty: term,
    pid: term.pid,
    projectId,
    sessionNumber,
    type,
  };
  ptySessions.set(sessionId, rec);

  // PTY 输出流 -> 广播给前端对应会话面板（xterm.js 渲染）
  term.onData((data) => {
    broadcast({
      type: cfg.msgOutput,
      sessionId,
      data,
    });
  });

  // PTY 子进程退出（用户退出、CLI 崩溃、或主动关闭）-> 自动移除菜单项。
  // exit 事件在 onData 之后触发，残留输出已发完。
  term.onExit(({ exitCode }) => {
    removePtySession(sessionId, `exit code ${exitCode}`);
  });

  broadcast({
    type: cfg.msgSession,
    event: 'create',
    sessionId,
    projectId,
    sessionNumber,
    sessionType: type,
    pid: term.pid,
  });

  return { ok: true, sessionId, sessionNumber, type, pid: term.pid };
}

// 后端退出二级兜底：对终端会话注册表遍历递归杀（壳层 taskkill /T 是一级兜底）。
// 复用 killProcessTree 递归杀语义，避免重复内联 taskkill 字面量。
function stopAllPtyOnExit() {
  for (const [, rec] of ptySessions) {
    if (rec && rec.pid) killProcessTree(rec.pid);
  }
  ptySessions.clear();
}
process.on('exit', stopAllPtyOnExit);
process.on('SIGINT', () => { stopAllPtyOnExit(); process.exit(0); });
process.on('SIGTERM', () => { stopAllPtyOnExit(); process.exit(0); });

// ---------------------------------------------------------------------------
// 启动项目
// ---------------------------------------------------------------------------
function startProject(projectId) {
  const p = getProject(projectId);
  if (!p) return { ok: false, msg: '项目不存在' };
  // Folder 类型不可启动（前端已隐藏按钮，这里兜底）
  if (p.type === 'folder') return { ok: false, msg: 'Folder 类型不支持启动' };

  const rec = ensureBuffer(projectId);
  if (rec.pid) return { ok: false, msg: '项目已在运行' };

  // attach 到 Node 后端：浏览器断连不影响，关 web 服务才停
  let proc;
  if (p.type === 'node') {
    // Node（Vite）项目直接 exec 启动命令，不经 cmd /c bat 中间层，
    // 行为更贴近在项目目录直接 `pnpm dev`，日志/信号处理也更直接。
    // shell:true 下整串命令交给 shell 解析：引号路径/带参命令（npm run x -- --y）原样可用，
    // 按空白 split 反而会把含空格的路径切碎。
    proc = spawn(p.command, {
      cwd: p.projectPath,
      env: process.env,
      shell: true,          // Windows 下 pnpm/npm/yarn 实为 .cmd，需要 shell 找到它们
      windowsHide: false,
    });
  } else {
    const batPath = projectBatPath(projectId);
    proc = spawn('cmd', ['/c', batPath], {
      cwd: p.projectPath,
      env: process.env,
      windowsHide: false,
    });
  }

  rec.proc = proc;
  rec.pid = proc.pid;

  appendLog(projectId, `[启动器] 启动进程 PID ${proc.pid} 于 ${p.projectPath}\r\n`);
  broadcast({ type: 'status', projectId, running: true, pid: proc.pid });

  proc.stdout.on('data', (data) => appendLog(projectId, data.toString()));
  proc.stderr.on('data', (data) => appendLog(projectId, data.toString()));

  proc.on('exit', (code, signal) => {
    appendLog(projectId, `\r\n[启动器] 进程退出 (code=${code}, signal=${signal})\r\n`);
    if (rec.pid === proc.pid) {
      rec.proc = null;
      rec.pid = null;
      broadcast({ type: 'status', projectId, running: false });
    }
  });

  proc.on('error', (err) => {
    appendLog(projectId, `\r\n[启动器] 进程错误: ${err.message}\r\n`);
    rec.proc = null;
    rec.pid = null;
    broadcast({ type: 'status', projectId, running: false });
  });

  return { ok: true, msg: '已启动', pid: proc.pid };
}

// ---------------------------------------------------------------------------
// 生成 start.bat
// ---------------------------------------------------------------------------
function generateBat(p) {
  if (p.type === 'folder') {
    return `@echo off\r\nREM Folder 项目，无启动命令\r\n`;
  }
  let cmd;
  if (p.type === 'node') {
    cmd = p.command;
  } else {
    const runCmd = `call mvn spring-boot:run -pl ${p.moduleName}`;
    // 打包前编译所有依赖项目：先 compile -am（连同上游模块一起编译），再 run
    if (p.compileDependencies) {
      const compileCmd = `call mvn compile -Dmaven.test.skip=true -pl ${p.moduleName} -am`;
      cmd = `${compileCmd}\r\n${runCmd}`;
    } else {
      cmd = runCmd;
    }
  }
  return `@echo off\r\nREM 启动器生成 - ${p.name}\r\ncd /d "${p.projectPath}"\r\n${cmd}\r\n`;
}

function writeBat(p) {
  if (p.type === 'folder') return; // Folder 无启动脚本，不生成 bat
  const batPath = projectBatPath(p.id);
  fs.writeFileSync(batPath, generateBat(p), 'utf-8');
}

function deleteBatAndLog(p) {
  // 只删启动器自己生成的文件（bat 在 logs/ 目录，log 同理），绝不碰项目自身代码
  for (const f of [projectBatPath(p.id), projectLogPath(p.id)]) {
    try { fs.unlinkSync(f); } catch (e) {}
  }
}

// 启动时为每个项目重新生成 start.bat，确保模板更新后旧项目也同步
for (const p of projects) {
  try { writeBat(p); } catch (e) { console.error(`生成 ${p.name} 的 start.bat 失败:`, e.message); }
}

// ---------------------------------------------------------------------------
// Express REST API
// ---------------------------------------------------------------------------
const app = express();
// json body 上限放宽到 3MB：编辑器保存（PUT file-content）内容上限 2MB，留余量给 JSON 包装
app.use(express.json({ limit: '3mb' }));
// 静态资源带短期缓存：开发期 1d，减少重复请求的重新验证。
// index.html 例外：必须 no-cache——单文件应用的所有 JS/CSS 都内联在里面，
// 缓存住它会导致发版后用户最长一天仍看到旧界面/旧逻辑。
const staticOpts = {
  maxAge: '1d',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
};
app.use(express.static(PUBLIC_DIR, staticOpts));

// xterm.js 静态资源：前端从 /vendor/xterm/ 加载 xterm.css / xterm.js，
// 从 /vendor/xterm-addon-fit/ 加载 addon-fit.js。直接映射 node_modules 下的包目录。
// （打包时 node_modules 进 resources，release 下路径同样有效。）
app.use('/vendor/xterm', express.static(
  path.join(ROOT_DIR, 'node_modules', '@xterm', 'xterm'), staticOpts
));
app.use('/vendor/xterm-addon-fit', express.static(
  path.join(ROOT_DIR, 'node_modules', '@xterm', 'addon-fit'), staticOpts
));
// highlight.js：文件查看模态框的语法高亮。用法同 xterm——前端从 /vendor/hljs/
// 加载 highlight.min.js 与深色主题 css，直接映射 node_modules 下的包目录。
app.use('/vendor/hljs', express.static(
  path.join(ROOT_DIR, 'node_modules', '@highlightjs', 'cdn-assets'), staticOpts
));

// 关于页内容源：根目录 ABOUT.md（前端 fetch 后本地渲染 markdown）。
// 版本号自动同步：以 package.json 的 version 为准，替换 ABOUT.md 中的
// 「**版本**：x.y.z」行，避免发版时 ABOUT.md 版本号遗漏不同步。
app.get('/about.md', (req, res) => {
  fs.readFile(path.join(ROOT_DIR, 'ABOUT.md'), 'utf8', (err, text) => {
    if (err) {
      res.status(404).type('text/plain').send('ABOUT.md not found');
      return;
    }
    try {
      const { version } = require(path.join(ROOT_DIR, 'package.json'));
      if (version) {
        text = text.replace(
          /(\*\*版本\*\*：).+/,
          `$1${version}`
        );
      }
    } catch (_) { /* package.json 读取失败则原样返回 ABOUT.md */ }
    res.type('text/markdown; charset=utf-8').send(text);
  });
});

// 版本号：供壳标题栏显示（与 package.json 单一来源，避免多处硬编码不同步）。
app.get('/api/version', (req, res) => {
  try {
    res.json({ version: require(path.join(ROOT_DIR, 'package.json')).version || '' });
  } catch (_) {
    res.json({ version: '' });
  }
});

// 文件夹选取：调 PowerShell 弹 Windows 标准「选择文件夹」对话框（FolderBrowserDialog）。
// WebView2 的 <input type=file webkitdirectory> 在 Tauri 外链源下会被当成上传对话框，
// 只能走后端原生选择器。选中目录由 stdout 单行回传（UTF-8），取消时为空。
app.post('/api/pick-folder', (req, res) => {
  // 编辑场景：对话框默认定位到输入框当前目录（若是有效路径）
  const cur = (req.body && req.body.current) || '';
  const esc = String(cur).replace(/'/g, "''"); // PowerShell 单引号字符串内转义
  let script =
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' +
    'Add-Type -AssemblyName System.Windows.Forms;' +
    '$f=New-Object System.Windows.Forms.FolderBrowserDialog;' +
    "$f.Description='选择项目目录';";
  if (esc) script += "$f.SelectedPath='" + esc + "';";
  script += "if($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){$f.SelectedPath}";

  execFile('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
    {
      windowsHide: true, // 不弹黑窗
      timeout: 300000, // 对话框可能停留较久；应用关窗时进程树被 job object 一并回收
      maxBuffer: 1024 * 1024,
    },
    (err, stdout) => {
      if (err) {
        res.json({ ok: false, msg: '文件夹选择失败: ' + (err.message || '') });
        return;
      }
      const p = (stdout || '').trim();
      if (!p) {
        res.json({ ok: false, canceled: true, msg: '未选择目录' });
        return;
      }
      res.json({ ok: true, path: p });
    });
});

function newId() {
  return 'p_' + Math.random().toString(36).slice(2, 10);
}

// 列出项目
app.get('/api/projects', (req, res) => {
  res.json(projects.map((p) => ({
    ...p,
    running: !!(runs.get(p.id) && runs.get(p.id).pid),
    pid: runs.get(p.id) ? runs.get(p.id).pid : null,
  })));
});

// 创建项目
app.post('/api/projects', (req, res) => {
  const { name, projectPath, type, command, moduleName, compileDependencies } = req.body || {};
  if (!name || !projectPath || !type) {
    return res.status(400).json({ ok: false, msg: '缺少必填字段' });
  }
  if (type !== 'springboot' && type !== 'node' && type !== 'folder') {
    return res.status(400).json({ ok: false, msg: '类型必须是 springboot、node 或 folder' });
  }
  if (type === 'node' && !command) {
    return res.status(400).json({ ok: false, msg: 'Node 项目需要启动命令' });
  }
  if (type === 'springboot' && !moduleName) {
    return res.status(400).json({ ok: false, msg: 'SpringBoot 项目需要入口模块名' });
  }
  // 只校验路径存在，不查工具链
  try {
    const st = fs.statSync(projectPath);
    if (!st.isDirectory()) {
      return res.status(400).json({ ok: false, msg: '路径不是目录' });
    }
  } catch (e) {
    return res.status(400).json({ ok: false, msg: '项目目录不存在: ' + e.message });
  }

  const p = {
    id: newId(),
    name,
    projectPath,
    type,
    command: type === 'node' ? command : undefined,
    moduleName: type === 'springboot' ? moduleName : undefined,
    // SpringBoot 默认勾选"打包前编译所有依赖项目"
    compileDependencies: type === 'springboot' ? (compileDependencies !== false) : undefined,
  };
  projects.push(p);
  saveProjects(projects);
  projectsById.set(p.id, p);
  writeBat(p);
  res.json({ ok: true, project: p });
});

// 编辑项目（覆盖重写 bat + 更新 projects.json）
app.put('/api/projects/:id', (req, res) => {
  const p = getProject(req.params.id);
  if (!p) return res.status(404).json({ ok: false, msg: '项目不存在' });
  const { name, projectPath, type, command, moduleName, compileDependencies } = req.body || {};
  const rec = runs.get(p.id);
  if (rec && rec.pid) {
    return res.status(400).json({ ok: false, msg: '项目运行中，请先停止' });
  }
  if (name) p.name = name;
  if (projectPath) p.projectPath = projectPath;
  if (type) p.type = type;
  if (command !== undefined) p.command = command;
  if (moduleName !== undefined) p.moduleName = moduleName;
  if (compileDependencies !== undefined) p.compileDependencies = compileDependencies;
  // folder 类型不持有任何启动配置；从其他类型切到 folder 时清掉旧字段
  if (p.type === 'folder') {
    p.command = undefined;
    p.moduleName = undefined;
    p.compileDependencies = undefined;
  }
  saveProjects(projects);
  writeBat(p);
  res.json({ ok: true, project: p });
});

// 调整项目顺序：接收前端拖拽落定后的完整 id 顺序，按其重排 projects.json。
// 仅按 id 重排（不增删），任何未知/缺失 id 一律忽略；保持其它字段不动。
app.post('/api/projects/reorder', (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
  if (!ids.length) return res.status(400).json({ ok: false, msg: '缺少 ids' });
  const byId = new Map(projects.map((p) => [p.id, p]));
  // 校验：ids 必须恰好覆盖现有全部项目，既不多也不少，避免静默丢项。
  // ids 含未知 id 或重复 id 都算不一致（map 后会出现 undefined，污染 projects 数组）
  const known = ids.filter((id) => byId.has(id));
  if (known.length !== projects.length || known.length !== ids.length) {
    return res.status(400).json({ ok: false, msg: 'ids 与现有项目不一致' });
  }
  const ordered = ids.map((id) => byId.get(id));
  projects = ordered;
  saveProjects(projects);
  rebuildProjectsIndex();
  res.json({ ok: true });
});

// 删除项目
app.delete('/api/projects/:id', async (req, res) => {
  const idx = projects.findIndex((x) => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, msg: '项目不存在' });
  const p = projects[idx];
  // 先停掉运行中的进程
  await stopProject(p.id);
  // 该项目名下的终端会话（claude/codex/cmd/gitbash/pi）一并递归杀并广播退出，
  // 否则 PTY 会话继续存活且 cwd 指向已删目录，侧栏菜单残留
  for (const [sessionId, rec] of [...ptySessions]) {
    if (rec.projectId === p.id) killPtySession(sessionId, 'project deleted');
  }
  deleteBatAndLog(p);
  projects.splice(idx, 1);
  saveProjects(projects);
  projectsById.delete(p.id);
  runs.delete(p.id);
  pendingBroadcast.delete(p.id); // 清理待广播缓冲，避免对已删项目 flush 出孤儿消息
  res.json({ ok: true });
});

// 启动
app.post('/api/projects/:id/start', (req, res) => {
  const result = startProject(req.params.id);
  res.json(result);
});

// 停止
app.post('/api/projects/:id/stop', async (req, res) => {
  const result = await stopProject(req.params.id);
  res.json(result);
});

// 重启：先停再启。停的过程是异步的（taskkill 杀进程树 + 端口释放），
// 需等停止彻底完成再启动，否则新进程可能因旧端口未释放而启动失败。
app.post('/api/projects/:id/restart', async (req, res) => {
  await stopProject(req.params.id);
  // taskkill 返回后操作系统释放端口仍需片刻，给个短缓冲避免新进程撞上旧端口
  await new Promise((r) => setTimeout(r, 500));
  const result = startProject(req.params.id);
  res.json(result);
});

// 查看命令：返回启动器为该项目生成的 start.bat 内容（即实际执行的 cmd 命令）
app.get('/api/projects/:id/command', (req, res) => {
  const p = getProject(req.params.id);
  if (!p) return res.status(404).json({ ok: false, msg: '项目不存在' });
  res.json({ ok: true, command: generateBat(p) });
});

// 读取剪贴板文件路径：前端终端检测到粘贴的是"从资源管理器复制的文件"（clipboardData.files
// 非空）时调用本路由。Node 读不了资源管理器的文件剪贴板，走 PowerShell
// Get-Clipboard -Format FileDropList 拿文件绝对路径列表，前端拼好再粘进终端。
app.get('/api/clipboard/file-paths', (req, res) => {
  // PowerShell 端输出 Base64(UTF-8)：直接输出文本时走控制台代码页（中文 Windows 是 GBK），
  // Node 按 utf8 解码必乱码；Base64 字节流与代码页无关，中文路径才能原样带回来。
  const script = '[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }) -join "`n"))';
  let r;
  try {
    r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, msg: '读取剪贴板文件路径失败: ' + (err.message || '') });
  }
  if (r.error || r.status !== 0) {
    const detail = (r.error && r.error.message) || r.stderr || ('退出码 ' + r.status);
    return res.status(500).json({ ok: false, msg: '读取剪贴板文件路径失败: ' + detail });
  }
  // Base64(UTF-8) 解码回文本，按 \n 切行（-join 拼接，无尾随空行）；空剪贴板 = 空串 = 空数组
  const text = Buffer.from(String(r.stdout || '').trim(), 'base64').toString('utf8');
  const paths = text ? text.split('\n').filter(Boolean) : [];
  res.json({ ok: true, paths });
});

// 打开资源管理器：在项目目录打开一个 Windows 资源管理器窗口
app.post('/api/projects/:id/explorer', (req, res) => {
  const p = getProject(req.params.id);
  if (!p) return res.status(404).json({ ok: false, msg: '项目不存在' });
  const base = p.projectPath;
  if (!fs.existsSync(base)) return res.status(404).json({ ok: false, msg: '目录不存在: ' + base });
  // 可选 sub：相对 projectPath 的子路径，定位到具体子目录（如右键某目录行在资源管理器打开）。
  // 与 /files 路由同样的沙箱化：resolve 后必须仍在 base 之下。
  const sub = req.query.sub ? String(req.query.sub) : '';
  let dir = base;
  if (sub) {
    dir = path.resolve(path.join(base, sub));
    const rel = path.relative(base, dir);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return res.status(400).json({ ok: false, msg: '路径超出项目目录' });
    }
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return res.status(404).json({ ok: false, msg: '目录不存在: ' + sub });
  }
  // 不能用 execFile 判断失败：explorer.exe 成功打开窗口时退出码也常为 1
  // （委托给已运行的 Explorer 实例），非零退出码会被 execFile 当错误上报。
  // 改用 spawn + 默认 stdio（让窗口正常打开），只监听 spawn 层 'error' 事件（ENOENT 等），
  // 不处理 'exit'，于是 explorer 的退出码 1 不会被误报为失败。
  const child = spawn('explorer.exe', [dir]);
  child.once('error', (err) => {
    if (!res.headersSent) res.status(500).json({ ok: false, msg: '打开资源管理器失败: ' + (err.message || '') });
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 设置面板 API：GET /api/settings 读取，PUT /api/settings 保存（整体覆盖写回）。
// 前端所有设置（字体/命令/文件黑名单）统一持久化到 settings.json，不再走 localStorage。
// PUT 做白名单 + 归一（normalizeSettings），多余字段与非法值一律丢弃/回默认。
// ---------------------------------------------------------------------------
app.get('/api/settings', (req, res) => {
  res.json({ ok: true, settings });
});
app.put('/api/settings', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  settings = normalizeSettings(body);
  try {
    saveSettings(settings);
  } catch (e) {
    return res.status(500).json({ ok: false, msg: '保存设置失败: ' + (e.message || '') });
  }
  res.json({ ok: true, settings });
});

// 文件目录浏览：列出某项目目录（或其子目录）下的一层条目，供右侧文件浏览抽屉懒加载树。
// 参数 sub：相对 projectPath 的子路径（前端展开某目录时传入）。做 path 沙箱化：
// resolve 后必须仍在 projectPath 之下（或等于），防止 ../ 逃逸到项目目录外。
// 过滤走黑名单：默认 .git/.svn（settings.json 的 fileHideList），前端可传 ?hide=逗号分隔
// 覆盖（保存设置后无需重启即生效）。精确匹配条目名，.gitignore / .env 等不受影响。
// node_modules 等大目录仍列出但不递归（前端按需展开）。
app.get('/api/projects/:id/files', (req, res) => {
  const p = getProject(req.params.id);
  if (!p) return res.status(404).json({ ok: false, msg: '项目不存在' });
  const base = p.projectPath;
  if (!fs.existsSync(base)) return res.status(404).json({ ok: false, msg: '目录不存在: ' + base });
  const sub = req.query.sub ? String(req.query.sub) : '';
  const hideList = req.query.hide !== undefined
    ? sanitizeFileHideList(String(req.query.hide).split(','))
    : settings.fileHideList;
  // 拼接并规范化：join 再 resolve，确保分隔符正确；最终校验仍在 base 下
  const target = path.resolve(path.join(base, sub));
  const rel = path.relative(base, target);
  // rel 以 '..' 开头或为绝对路径 => 逃逸出项目目录
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return res.status(400).json({ ok: false, msg: '路径超出项目目录' });
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    return res.status(404).json({ ok: false, msg: '子目录不存在: ' + sub });
  }
  let entries;
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch (err) {
    return res.status(500).json({ ok: false, msg: '读取目录失败: ' + (err.message || '') });
  }
  const items = entries
    .filter((e) => !hideList.includes(e.name))
    .map((e) => {
      // Dirent 无 size 属性，文件条目需 stat 取大小；目录不附带（懒加载子层）
      let size = null;
      if (e.isFile()) {
        try { size = fs.statSync(path.join(target, e.name)).size; } catch (_) {}
      }
      return { name: e.name, isDir: e.isDirectory(), size };
    })
    // 目录优先、再按名称排序（Windows 资源管理器习惯）
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  res.json({ ok: true, path: sub || '', items });
});

// 文件内容只读查看：返回文本内容供前端文件查看模态框渲染（本期只做查看，不做编辑）。
// 参数 sub：相对 projectPath 的文件路径。与 /files 相同的沙箱化：resolve 后必须仍在 base 之下。
// 防护：
//   1. 大小限制 MAX_VIEW_FILE_SIZE（2MB）——超限返回 tooLarge 标记，前端展示友好提示，
//      避免把几 MB 的日志/构建产物整个塞进 WebView。
//   2. 二进制检测——读取后扫描 NUL 字节（\0），文本文件几乎不会含 NUL；
//      是二进制则返回 isBinary 标记，前端不渲染乱码。
app.get('/api/projects/:id/file-content', (req, res) => {
  const MAX_VIEW_FILE_SIZE = 2 * 1024 * 1024; // 2MB
  const p = getProject(req.params.id);
  if (!p) return res.status(404).json({ ok: false, msg: '项目不存在' });
  const base = p.projectPath;
  if (!fs.existsSync(base)) return res.status(404).json({ ok: false, msg: '目录不存在: ' + base });
  const sub = req.query.sub ? String(req.query.sub) : '';
  if (!sub) return res.status(400).json({ ok: false, msg: '未指定文件路径' });
  const target = path.resolve(path.join(base, sub));
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return res.status(400).json({ ok: false, msg: '路径超出项目目录' });
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return res.status(404).json({ ok: false, msg: '文件不存在: ' + sub });
  }
  const stat = fs.statSync(target);
  if (stat.size > MAX_VIEW_FILE_SIZE) {
    return res.json({ ok: true, tooLarge: true, size: stat.size });
  }
  let buf;
  try {
    buf = fs.readFileSync(target);
  } catch (err) {
    return res.status(500).json({ ok: false, msg: '读取文件失败: ' + (err.message || '') });
  }
  // 二进制检测：前 8KB 内出现 NUL 字节即判定为二进制
  const probe = buf.subarray(0, 8192);
  if (probe.includes(0)) {
    return res.json({ ok: true, isBinary: true, size: stat.size });
  }
  // UTF-8 解码；非法字节序列会被替换为 U+FFFD（与编辑器打开乱码的行为一致）
  // mtime：读取时的修改时间（毫秒），保存（PUT）时回传做冲突检测
  res.json({ ok: true, content: buf.toString('utf8'), size: stat.size, mtime: stat.mtimeMs });
});

// 文件保存（编辑器写入）：body { content, mtime }。与读取相同的沙箱化。
// 冲突检测：mtime 与读取时不一致 => 说明文件被外部（git 操作/其他编辑器）改过，
// 返回 conflict 标记，前端提示用户选择重新加载或强制覆盖，避免无声覆盖外部修改。
// 限制：内容 ≤2MB（与查看上限一致）、目标必须是已存在的文件（不支持 PUT 新建，新建走 /files/new）。
app.put('/api/projects/:id/file-content', (req, res) => {
  const MAX_EDIT_FILE_SIZE = 2 * 1024 * 1024; // 2MB，与 GET 查看上限一致
  const p = getProject(req.params.id);
  if (!p) return res.status(404).json({ ok: false, msg: '项目不存在' });
  const base = p.projectPath;
  if (!fs.existsSync(base)) return res.status(404).json({ ok: false, msg: '目录不存在: ' + base });
  const sub = req.query.sub ? String(req.query.sub) : '';
  if (!sub) return res.status(400).json({ ok: false, msg: '未指定文件路径' });
  const target = path.resolve(path.join(base, sub));
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return res.status(400).json({ ok: false, msg: '路径超出项目目录' });
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return res.status(404).json({ ok: false, msg: '文件不存在: ' + sub });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const content = typeof body.content === 'string' ? body.content : '';
  if (Buffer.byteLength(content, 'utf8') > MAX_EDIT_FILE_SIZE) {
    return res.status(413).json({ ok: false, msg: '内容超过大小上限（2MB）' });
  }
  // 冲突检测：客户端读取时记录的 mtime 与当前不一致 => 文件被外部修改过
  const stat = fs.statSync(target);
  const clientMtime = typeof body.mtime === 'number' ? body.mtime : null;
  if (clientMtime !== null && stat.mtimeMs !== clientMtime) {
    return res.status(409).json({ ok: false, conflict: true, mtime: stat.mtimeMs, msg: '文件已被外部修改' });
  }
  // 二进制防护：读取现有内容判 NUL——编辑器只服务文本文件，防止把二进制写坏
  let old;
  try {
    old = fs.readFileSync(target);
  } catch (err) {
    return res.status(500).json({ ok: false, msg: '读取文件失败: ' + (err.message || '') });
  }
  if (old.subarray(0, 8192).includes(0)) {
    return res.status(415).json({ ok: false, isBinary: true, msg: '二进制文件不支持编辑' });
  }
  try {
    fs.writeFileSync(target, content, 'utf8');
  } catch (err) {
    return res.status(500).json({ ok: false, msg: '写入文件失败: ' + (err.message || '') });
  }
  // 返回写入后的新 mtime，前端更新 tab 记录，后续保存继续以此做冲突检测
  res.json({ ok: true, size: Buffer.byteLength(content, 'utf8'), mtime: fs.statSync(target).mtimeMs });
});

// 新建文件/文件夹：body { parentSub, name, isDir }。parentSub 为目标父目录（'' = 项目根）。
// 沙箱化同 /files；name 只取 basename（防止 name 里夹路径逃逸）；重名返回 409 冲突。
app.post('/api/projects/:id/files/new', (req, res) => {
  const p = getProject(req.params.id);
  if (!p) return res.status(404).json({ ok: false, msg: '项目不存在' });
  const base = p.projectPath;
  if (!fs.existsSync(base)) return res.status(404).json({ ok: false, msg: '目录不存在: ' + base });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const parentSub = typeof body.parentSub === 'string' ? body.parentSub : '';
  let name = typeof body.name === 'string' ? body.name.trim() : '';
  const isDir = !!body.isDir;
  if (!name) return res.status(400).json({ ok: false, msg: '名称不能为空' });
  // name 必须是单段路径：含分隔符（a/b）、点号项（. / ..）或 Windows 非法字符一律拒绝，
  // 杜绝借 name 夹带路径逃逸（parentSub 才是定位目录的唯一入口）
  if (/[\\/]/.test(name) || name === '.' || name === '..' || /["<>|:*?]/.test(name)) {
    return res.status(400).json({ ok: false, msg: '名称不合法（不能含路径分隔符或特殊字符）' });
  }
  const parent = path.resolve(path.join(base, parentSub));
  const rel = path.relative(base, parent);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return res.status(400).json({ ok: false, msg: '路径超出项目目录' });
  }
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    return res.status(404).json({ ok: false, msg: '父目录不存在: ' + (parentSub || '项目根') });
  }
  const target = path.join(parent, name);
  if (fs.existsSync(target)) {
    return res.status(409).json({ ok: false, exists: true, msg: '同名条目已存在: ' + name });
  }
  try {
    if (isDir) {
      fs.mkdirSync(target);
    } else {
      fs.writeFileSync(target, '', 'utf8');
    }
  } catch (err) {
    return res.status(500).json({ ok: false, msg: '创建失败: ' + (err.message || '') });
  }
  // sub 一律用 / 分隔（与前端树、GET file-content 的 sub 参数一致）
  const sub = parentSub ? parentSub.replace(/\\/g, '/').replace(/\/$/, '') + '/' + name : name;
  res.json({ ok: true, sub, isDir });
});

// 删除文件/文件夹（进回收站）：body { sub, isDir }。sub 为相对 projectPath 的路径（'' = 项目根，拒绝删除）。
// 沙箱化同 /files；isDir 仅用于确认框语义提示，删除方式由 target 实际类型决定。
// 回收站实现：Windows 用 PowerShell Shell.Application 的 NameSpace(10)（回收站不可脚本直写，
// 但其 MoveHere 对源路径做删除语义移动时经系统 shell，实际效果即移入回收站）；
// VSCode/资源管理器均如此。PowerShell 调用失败（PS 不在/策略拦截）时降级为物理删除并返回
// recycled:false，前端提示告知未进回收站，保证功能可用。
app.post('/api/projects/:id/files/delete', (req, res) => {
  const p = getProject(req.params.id);
  if (!p) return res.status(404).json({ ok: false, msg: '项目不存在' });
  const base = p.projectPath;
  if (!fs.existsSync(base)) return res.status(404).json({ ok: false, msg: '目录不存在: ' + base });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const sub = typeof body.sub === 'string' ? body.sub : '';
  if (!sub) return res.status(400).json({ ok: false, msg: '不能删除项目根目录' });
  const target = path.resolve(path.join(base, sub));
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return res.status(400).json({ ok: false, msg: '路径超出项目目录' });
  }
  // 项目根本身（rel === ''）同样拒绝：sub 非空但 resolve 后落在 base 上（如 sub='.'）
  if (!rel) return res.status(400).json({ ok: false, msg: '不能删除项目根目录' });
  if (!fs.existsSync(target)) {
    return res.status(404).json({ ok: false, msg: '文件不存在: ' + sub });
  }
  const isDir = fs.statSync(target).isDirectory();
  let recycled = false;
  try {
    recycled = moveToRecycleBin(target);
  } catch (err) {
    return res.status(500).json({ ok: false, msg: '删除失败: ' + (err.message || '') });
  }
  if (!recycled) {
    // 降级：物理删除（目录递归）。尽力而为，失败再报错
    try {
      if (isDir) fs.rmSync(target, { recursive: true, force: true });
      else fs.rmSync(target, { force: true });
    } catch (err) {
      return res.status(500).json({ ok: false, msg: '删除失败: ' + (err.message || '') });
    }
  }
  res.json({ ok: true, isDir, recycled });
});

// 移入回收站：PowerShell + Shell.Application。返回 true=已进回收站；
// PowerShell 不可用/失败抛错或返回 false（由调用方降级物理删除）。
function moveToRecycleBin(target) {
  // execFile 同步等待；PowerShell 单行脚本，路径用单引号包裹（路径内单引号翻倍转义）
  const ps = `'
    $sh = New-Object -ComObject Shell.Application;
    $recycle = $sh.NameSpace(10);
    $item = $recycle.MoveHere('${target.replace(/'/g, "''")}');
  '`;
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 15000 });
    if (r.error || r.status !== 0) return false;
    return fs.existsSync(target) ? false : true;
  } catch (_) {
    return false;
  }
}

// 日志历史：start.log 是全量历史（appendLog 同时写文件和内存缓冲），
// 直接返回文件内容即可。之前用 memBuffer.slice(fileHistory.length) 拼接，
// 但 fileHistory 按 64KB 块切、memBuffer 按行切，两者计量单位不一致，
// 导致切换项目时大部分内存内容与文件历史重复输出。
app.get('/api/projects/:id/logs', (req, res) => {
  const p = getProject(req.params.id);
  if (!p) return res.status(404).json({ ok: false, msg: '项目不存在' });
  res.json({ ok: true, entries: readLogHistory(p.id) });
});

// 清空日志：start.log 落盘文件 + 待广播缓冲一并清空
app.post('/api/projects/:id/clear-logs', (req, res) => {
  const p = getProject(req.params.id);
  if (!p) return res.status(404).json({ ok: false, msg: '项目不存在' });
  // 丢弃待广播的旧条目，否则清空后下一窗口仍会 flush 出一批旧日志
  const pending = pendingBroadcast.get(p.id);
  if (pending) pending.length = 0;
  clearLogFile(p.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Git 集成 REST API：/api/projects/:id/git/{status,stage,commit,push,pull,branches,checkout,log,diff}
// 统一 execFile('git', ...) 不走 shell（防注入）；文件路径参数做与 /files 相同的
// resolve 沙箱化。非 git 仓库统一返回 { ok:false, notRepo:true }，前端据此显示占位。
// push/pull 涉及网络与远端凭证：命令行已配好凭证即可直接推拉，失败原样返回 git
// 输出，不做凭证管理。
// ---------------------------------------------------------------------------
const GIT_TIMEOUT_MS = 60 * 1000; // push/pull 等网络操作超时
const GIT_LOG_LIMIT_MAX = 200;

// 执行 git 子命令。opts.sandboxRel 可传相对 projectPath 的路径用于沙箱校验
// （diff 单文件用：只校验不切换 cwd——git 的 pathspec 相对 cwd 解析，
// 换了 cwd 传参就得相应改写，直接在项目根跑最简单），逃逸则返回 { sandbox:true }。
function runGit(project, args, opts) {
  return new Promise((resolve) => {
    const o = opts || {};
    if (o.sandboxRel !== undefined && o.sandboxRel !== '') {
      const target = path.resolve(path.join(project.projectPath, o.sandboxRel));
      const rel = path.relative(project.projectPath, target);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        resolve({ ok: false, sandbox: true, msg: '路径超出项目目录' });
        return;
      }
    }
    const cwd = project.projectPath;
    // -c core.quotepath=false：非 ASCII 文件名不转义成 \xxx 八进制，直接输出 UTF-8
    const fullArgs = ['-c', 'core.quotepath=false', ...args];
    execFile('git', fullArgs, {
      cwd,
      windowsHide: true,
      timeout: o.timeout || GIT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        // git 在非仓库目录执行报 "not a git repository"（exit code 128）
        const isNotRepo = err.code === 128 && /not a git repository/i.test((stderr || '') + (stdout || ''));
        resolve({
          ok: false,
          notRepo: isNotRepo || undefined,
          code: err.code,
          msg: (stderr || stdout || err.message || '').trim(),
        });
        return;
      }
      resolve({ ok: true, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function getGitProject(req, res) {
  const p = getProject(req.params.id);
  if (!p) { res.status(404).json({ ok: false, msg: '项目不存在' }); return null; }
  if (!fs.existsSync(p.projectPath)) {
    res.status(404).json({ ok: false, msg: '目录不存在: ' + p.projectPath });
    return null;
  }
  return p;
}

// 解析 porcelain=v1 -b 输出：
// 首行 ## 分支信息（如 "## main...origin/main [ahead 1, behind 2]"），其余行 XY<space>路径。
// 重命名行形如 "R  old -> new"，取 -> 后的新路径。
// ahead/behind 从分支行的 [ahead N, behind M] 段解析（无 upstream 或已同步时为 null）。
function parseGitStatusPorcelain(stdout) {
  const lines = stdout.split(/\r?\n/);
  let branch = null;
  let ahead = null;
  let behind = null;
  const files = [];
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('## ')) {
      const head = line.slice(3);
      // 空仓库首行为 "## No commits yet on master"——branch 取行尾的分支名
      const noCommit = head.match(/^No commits yet on (.+)$/);
      // 分支名取 "..."（upstream 分隔）或行尾之前的整段：不能用 [^.\s]+，
      // 否则含点号的分支名（v1.0、release/2.0.beta）会被截断
      const m = noCommit ? { 1: noCommit[1] } : head.match(/^(.+?)(?:\.\.\.|$)/);
      branch = m ? m[1] : null;
      const aheadM = head.match(/\bahead (\d+)/);
      const behindM = head.match(/\bbehind (\d+)/);
      if (aheadM) ahead = parseInt(aheadM[1], 10);
      if (behindM) behind = parseInt(behindM[1], 10);
      continue;
    }
    const x = line[0]; // staged 状态
    const y = line[1]; // unstaged 状态
    let file = line.slice(3);
    const arrow = file.indexOf(' -> ');
    if (arrow >= 0) file = file.slice(arrow + 4);
    files.push({ x, y, file });
  }
  return { branch, files, ahead, behind };
}

app.get('/api/projects/:id/git/status', async (req, res) => {
  const p = getGitProject(req, res);
  if (!p) return;
  const r = await runGit(p, ['status', '--porcelain=v1', '-b', '--untracked-files=all']);
  if (!r.ok) {
    return res.json(r.notRepo
      ? { ok: false, notRepo: true }
      : { ok: false, msg: r.msg || 'git status 失败' });
  }
  const { branch, files, ahead, behind } = parseGitStatusPorcelain(r.stdout);
  res.json({ ok: true, branch, files, ahead, behind });
});

// stage/unstage：body { files: string[], unstage?: bool }
app.post('/api/projects/:id/git/stage', async (req, res) => {
  const p = getGitProject(req, res);
  if (!p) return;
  const files = Array.isArray(req.body && req.body.files) ? req.body.files.filter(Boolean) : [];
  if (!files.length) return res.status(400).json({ ok: false, msg: '未指定文件' });
  const r = await runGit(p, (req.body.unstage ? ['reset', 'HEAD', '--'] : ['add', '--']).concat(files));
  if (!r.ok) {
    return res.json(r.notRepo ? { ok: false, notRepo: true } : { ok: false, msg: r.msg || 'git 操作失败' });
  }
  res.json({ ok: true });
});

// 撤销单文件本地修改（丢弃未提交改动）：body { file }。不可逆（改动直接丢弃，无暂存可寻），
// 前端弹确认框后才调用。git checkout -- <file> 恢复到暂存区/HEAD 版本。
app.post('/api/projects/:id/git/discard', async (req, res) => {
  const p = getGitProject(req, res);
  if (!p) return;
  const file = String((req.body && req.body.file) || '').trim();
  if (!file) return res.status(400).json({ ok: false, msg: '未指定文件' });
  const r = await runGit(p, ['checkout', '--', file]);
  if (!r.ok) {
    return res.json(r.notRepo ? { ok: false, notRepo: true } : { ok: false, msg: r.msg || '撤销修改失败' });
  }
  res.json({ ok: true });
});

// commit：body { message }。git commit -m 不经 shell，无注入风险。
app.post('/api/projects/:id/git/commit', async (req, res) => {
  const p = getGitProject(req, res);
  if (!p) return;
  const message = String((req.body && req.body.message) || '').trim();
  if (!message) return res.status(400).json({ ok: false, msg: '提交说明不能为空' });
  const r = await runGit(p, ['commit', '-m', message]);
  if (!r.ok) {
    return res.json(r.notRepo ? { ok: false, notRepo: true } : { ok: false, msg: r.msg || '提交失败' });
  }
  res.json({ ok: true, msg: r.stdout.trim() });
});

// push / pull：返回合并输出，供前端 toast 展示
function registerGitNetworkRoute(routePath, gitArgs, label) {
  app.post(`/api/projects/:id/git/${routePath}`, async (req, res) => {
    const p = getGitProject(req, res);
    if (!p) return;
    const r = await runGit(p, gitArgs);
    if (!r.ok) {
      return res.json(r.notRepo ? { ok: false, notRepo: true } : { ok: false, msg: r.msg || `${label}失败` });
    }
    res.json({ ok: true, msg: (r.stdout + '\n' + r.stderr).trim() });
  });
}
// push 用 -u <remote> HEAD：不依赖 upstream 已设置，本地新建分支第一次推送即可成功，
// -u 顺带建立跟踪关系（已有 upstream 的分支行为等价，HEAD detached 时报错同裸 push）。
// 远端名动态解析（优先 origin，兼容任意名字的远端）；无远端时退回 origin 让 git 报原始错误。
app.post('/api/projects/:id/git/push', async (req, res) => {
  const p = getGitProject(req, res);
  if (!p) return;
  const name = (await resolveRemoteName(p)) || 'origin';
  const r = await runGit(p, ['push', '-u', name, 'HEAD']);
  if (!r.ok) {
    return res.json(r.notRepo ? { ok: false, notRepo: true } : { ok: false, msg: r.msg || 'push失败' });
  }
  res.json({ ok: true, msg: (r.stdout + '\n' + r.stderr).trim() });
});
registerGitNetworkRoute('pull', ['pull'], 'pull');
// fetch：只更新远端跟踪指针（origin/main 等），不动工作区——
// 供前端打开抽屉/点刷新时刷新 ahead/behind 徽标，安全无副作用
registerGitNetworkRoute('fetch', ['fetch', '--prune'], 'fetch');

// 撤回最新一条提交（软撤回）：git reset --soft HEAD~1，改动回到已暂存区，文件内容不丢。
// 安全约束：仅当 HEAD 未推送（upstream 是 HEAD~1 或更早的祖先）时允许——已推送的提交
// 撤回会造成本地/远端分叉，需要 force push，不在本功能范围内。
app.post('/api/projects/:id/git/undo-commit', async (req, res) => {
  const p = getGitProject(req, res);
  if (!p) return;
  // 前置：有 upstream 才谈得上"未推送"
  const up = await runGit(p, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (!up.ok || !up.stdout.trim()) {
    return res.json({ ok: false, msg: '分支没有上游（upstream），无法判断是否已推送，拒绝撤回' });
  }
  // upstream 必须是 HEAD~1 的祖先：HEAD 未推送且是最新提交。
  // （upstream==HEAD~1 时 ahead=1；更早时 ahead>1，同样只撤最新一条。）
  const anc = await runGit(p, ['merge-base', '--is-ancestor', '@{upstream}', 'HEAD~1']);
  if (!anc.ok) {
    return res.json({ ok: false, msg: '最新提交已推送到远端（或无更早提交），不能撤回' });
  }
  const r = await runGit(p, ['reset', '--soft', 'HEAD~1']);
  if (!r.ok) {
    return res.json({ ok: false, msg: r.msg || '撤回失败' });
  }
  res.json({ ok: true, msg: '已撤回最新提交，改动回到已暂存区' });
});

// 分支列表：--format 直接给 JSON 友好的字段（%(refname:short)\t%(HEAD)），避免解析 * 前缀的本地化歧义。
// 同时附带远程分支列表（git branch -r，<remote>/xxx 原样）与实际远端名 remoteName
// （前端"新建分支"起点下拉、远程分支检出都用 <remote>/ 前缀匹配，不再假设 origin）；
// 无远端时 remote 为空数组、remoteName 为 null。
app.get('/api/projects/:id/git/branches', async (req, res) => {
  const p = getGitProject(req, res);
  if (!p) return;
  const r = await runGit(p, ['branch', '--format=%(refname:short)%09%(HEAD)']);
  if (!r.ok) {
    return res.json(r.notRepo ? { ok: false, notRepo: true } : { ok: false, msg: r.msg || '获取分支失败' });
  }
  const branches = [];
  let current = null;
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line) continue;
    const tab = line.lastIndexOf('\t');
    const name = line.slice(0, tab);
    const isHead = line.slice(tab + 1) === '*';
    branches.push(name);
    if (isHead) current = name;
  }
  const remoteName = await resolveRemoteName(p);
  const rr = await runGit(p, ['branch', '-r', '--format=%(refname:short)']);
  const remote = rr.ok
    ? rr.stdout.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.endsWith('/HEAD'))
    : [];
  res.json({ ok: true, branches, current, remote, remoteName });
});

// 版本控制类型探测（轻量）：git rev-parse 成功 → git；失败再探 svn info → svn；
// 都失败 → none（无版本控制）。供项目卡片名称前的 VCS logo 使用，结果不缓存——
// 目录可能被 init/删除 .git，卡片重渲染时每次探测；git rev-parse 本地执行开销极小。
app.get('/api/projects/:id/vcs-kind', async (req, res) => {
  const p = getProject(req.params.id);
  if (!p) return res.status(404).json({ ok: false, msg: '项目不存在' });
  const g = await runGit(p, ['rev-parse', '--is-inside-work-tree']);
  if (g.ok) return res.json({ ok: true, kind: 'git' });
  const s = await runSvn(p, ['info']);
  if (s.ok) return res.json({ ok: true, kind: 'svn' });
  // svn 未安装时无法区分“是 SVN 工作副本”与“无版本控制”，按无版本控制处理
  res.json({ ok: true, kind: 'none' });
});

// 初始化 git 仓库：git init（幂等，已 init 过的目录只是 reinitialize 无副作用）。
// init 后抽屉重渲染即进入空仓库状态（默认分支 + 全量未跟踪文件），用户自行暂存提交。
app.post('/api/projects/:id/git/init', async (req, res) => {
  const p = getGitProject(req, res);
  if (!p) return;
  const r = await runGit(p, ['init']);
  if (!r.ok) return res.json({ ok: false, msg: r.msg || 'git init 失败' });
  res.json({ ok: true, msg: r.stdout.trim() });
});

// 解析仓库实际使用的远端名：优先 origin，没有则取 `git remote` 列表首个（远端名可能是
// 任意名字，如与仓库同名的 `xxx.git`），无任何远端时返回 null。
async function resolveRemoteName(p) {
  const r = await runGit(p, ['remote']);
  if (!r.ok) return null;
  const names = r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!names.length) return null;
  if (names.includes('origin')) return 'origin';
  return names[0];
}

// 远端的读取/设置（远端名优先 origin，兼容任意名字的远端）：
// GET  remote-url  → { ok, url }（无远端时 url 为 null，非仓库走 notRepo）
// POST remote-set body { url } → 已有远端则 set-url，否则 add origin
// url 为任意字符串直接传给 git remote，不经 shell 无注入风险；凭证会明文存入 .git/config，前端弹窗有提示。
app.get('/api/projects/:id/git/remote-url', async (req, res) => {
  const p = getGitProject(req, res);
  if (!p) return;
  const probe = await runGit(p, ['remote']);
  if (!probe.ok) {
    if (probe.notRepo) return res.json({ ok: false, notRepo: true });
    return res.json({ ok: false, msg: probe.msg || '读取远端失败' });
  }
  const name = await resolveRemoteName(p);
  if (!name) return res.json({ ok: true, url: null });
  const r = await runGit(p, ['remote', 'get-url', name]);
  if (r.ok) return res.json({ ok: true, url: r.stdout.trim() });
  res.json({ ok: false, msg: r.msg || '读取远端失败' });
});

app.post('/api/projects/:id/git/remote-set', async (req, res) => {
  const p = getGitProject(req, res);
  if (!p) return;
  const url = String((req.body && req.body.url) || '').trim();
  if (!url) return res.status(400).json({ ok: false, msg: '远端 URL 不能为空' });
  // 已有任意远端：改写它的地址（不新增 origin，避免仓库里出现两个远端）
  const cur = await resolveRemoteName(p);
  const r = cur
    ? await runGit(p, ['remote', 'set-url', cur, url])
    : await runGit(p, ['remote', 'add', 'origin', url]);
  if (!r.ok) return res.json({ ok: false, msg: r.msg || '设置远端失败' });
  res.json({ ok: true });
});

// 新建分支：body { name, from? }。from 为空从当前 HEAD 建；为远程分支名（origin/xxx）
// 时以其为起点，git checkout -b 自动建立 tracking。失败返回 git 原始报错（分支已存在等）。
app.post('/api/projects/:id/git/branch-create', async (req, res) => {
  const p = getGitProject(req, res);
  if (!p) return;
  const name = String((req.body && req.body.name) || '').trim();
  const from = String((req.body && req.body.from) || '').trim();
  if (!name) return res.status(400).json({ ok: false, msg: '未指定分支名' });
  if (/\s/.test(name)) return res.status(400).json({ ok: false, msg: '分支名不能包含空格' });
  const args = ['checkout', '-b', name];
  if (from) args.push(from);
  const r = await runGit(p, args);
  if (!r.ok) {
    return res.json(r.notRepo ? { ok: false, notRepo: true } : { ok: false, msg: r.msg || '新建分支失败' });
  }
  res.json({ ok: true, msg: (r.stdout + '\n' + r.stderr).trim() });
});

// 切换分支：body { branch }
app.post('/api/projects/:id/git/checkout', async (req, res) => {
  const p = getGitProject(req, res);
  if (!p) return;
  const branch = String((req.body && req.body.branch) || '').trim();
  if (!branch) return res.status(400).json({ ok: false, msg: '未指定分支' });
  const r = await runGit(p, ['checkout', branch]);
  if (!r.ok) {
    return res.json(r.notRepo ? { ok: false, notRepo: true } : { ok: false, msg: r.msg || '切换分支失败' });
  }
  res.json({ ok: true, msg: (r.stdout + '\n' + r.stderr).trim() });
});

// 提交历史：--pretty 用 %x1f（单元分隔符）/ %x1e（记录分隔符）拼字段，按分隔符切，
// 避免作者名或 message 里出现 | 或换行导致解析错位。
// --name-only 附带每次提交的变更文件列表（前端历史条目展开用），记录分隔符 %x1e 在
// 文件列表之后输出，切分时每条记录 = 元数据行 + 文件行们。
// 每条提交附带 pushed 标记：当前分支有 upstream 时用 rev-list <upstream>..HEAD
// 取未推送提交集合，命中的 pushed=false，其余 true；无 upstream 时全部 false。
app.get('/api/projects/:id/git/log', async (req, res) => {
  const p = getGitProject(req, res);
  if (!p) return;
  let limit = parseInt(req.query.limit, 10);
  if (!(limit > 0)) limit = 30;
  if (limit > GIT_LOG_LIMIT_MAX) limit = GIT_LOG_LIMIT_MAX;
  const r = await runGit(p, ['log', `--max-count=${limit}`, '--name-only',
    '--pretty=format:%x1e%h%x1f%an%x1f%at%x1f%s']);
  if (!r.ok) {
    if (r.notRepo) return res.json({ ok: false, notRepo: true });
    // 空仓库（无任何提交）git log 退出码 128：提示"does not have any commits"
    if (/does not have any commits yet/i.test(r.msg || '')) return res.json({ ok: true, commits: [] });
    return res.json({ ok: false, msg: r.msg || 'git log 失败' });
  }
  // 记录以 %x1e 开头：每条记录 = 元数据行 + 本条提交的文件列表（--name-only）。
  // 这样文件列表归属于自己的记录，不会混进下一条。
  const commits = [];
  for (const rec of r.stdout.split('\x1e')) {
    const t = rec.replace(/^\r?\n/, '');
    if (!t.trim()) continue;
    const lines = t.split(/\r?\n/);
    const [hash, author, at, subject] = (lines.shift() || '').split('\x1f');
    // 元数据行之后全部是 --name-only 的文件列表（过滤空行）
    const files = lines.map(s => s.trim()).filter(Boolean);
    commits.push({ hash, author, at: parseInt(at, 10) || 0, subject, files });
  }
  // pushed 标记：upstream 分支名取自 branch@{upstream}（rev-parse 解析，失败即无 upstream）
  const up = await runGit(p, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (up.ok && up.stdout.trim()) {
    const un = await runGit(p, ['rev-list', up.stdout.trim() + '..HEAD']);
    const unpushed = new Set(un.ok ? un.stdout.split(/\r?\n/).filter(Boolean) : []);
    for (const c of commits) {
      // rev-list 输出全 hash，log 的 %h 是短 hash：按前缀匹配（短串必为全 hash 前缀）
      c.pushed = ![...unpushed].some(h => c.hash === h || h.startsWith(c.hash));
    }
  } else {
    for (const c of commits) c.pushed = false;
  }
  res.json({ ok: true, commits });
});

// diff：query file（相对 projectPath 的文件路径，沙箱化）、cached=1（已暂存）、
// commit=<hash>（看某次提交的变更，忽略 file）。file 与 cached 均未传时为工作区整体 diff。
app.get('/api/projects/:id/git/diff', async (req, res) => {
  const p = getGitProject(req, res);
  if (!p) return;
  const file = req.query.file ? String(req.query.file) : '';
  const cached = req.query.cached === '1';
  const commit = req.query.commit ? String(req.query.commit) : '';
  if (commit && !/^[0-9a-fA-F]{4,40}$/.test(commit)) {
    return res.status(400).json({ ok: false, msg: '非法的 commit hash' });
  }
  const args = ['diff', '--no-color'];
  if (commit) {
    // 看某次提交自身的变更：diff 其父提交（<hash>^）与该提交，而非 diff 到工作区。
    // 可与 file 组合：只看该提交中单个文件的 diff（历史条目展开点文件用）
    args.push(`${commit}^`, commit);
    if (file) args.push('--', file);
  } else {
    if (cached) args.push('--cached');
    if (file) args.push('--', file);
  }
  const r = await runGit(p, args, file ? { sandboxRel: path.dirname(file) } : undefined);
  if (!r.ok) {
    if (r.sandbox) return res.status(400).json({ ok: false, msg: r.msg });
    return res.json(r.notRepo ? { ok: false, notRepo: true } : { ok: false, msg: r.msg || 'git diff 失败' });
  }
  res.json({ ok: true, diff: r.stdout });
});

// ---------------------------------------------------------------------------
// SVN 集成 REST API：/api/projects/:id/svn/{status,remote-status,update,add,commit,revert,log,diff}
// 与 git 路由平行：统一 execFile('svn', ...) 不走 shell（防注入）；文件路径参数做
// 与 /files 相同的 resolve 沙箱化。非 SVN 工作副本（E155007/W155007）统一返回
// { ok:false, notRepo:true }，svn 命令行不存在（ENOENT）返回 { ok:false, noSvn:true }，
// 前端据此显示占位/安装提示。SVN 无暂存区、无分支概念：commit 即推送远端，
// 撤回以单文件 svn revert 为粒度，凭证沿用命令行缓存（--non-interactive 不做交互）。
// ---------------------------------------------------------------------------
const SVN_TIMEOUT_MS = 60 * 1000; // update 等网络操作超时
const SVN_LOG_LIMIT_MAX = 200;
// svn 错误输出统一带 "svn: Exxxxx:" 前缀；工作副本判定走 E155007（目录非工作副本）
// / W155007（警告变体）。中文/locale 输出靠错误码识别，不匹配文案。
const SVN_NOT_REPO_RE = /svn: [EW]155007/;

// 执行 svn 子命令。opts.sandboxRel 可传相对 projectPath 的路径用于沙箱校验
// （diff 单文件用：只校验不切换 cwd——svn 的目标参数相对 cwd 解析，
// 换了 cwd 传参就得相应改写，直接在项目根跑最简单），逃逸则返回 { sandbox:true }。
function runSvn(project, args, opts) {
  return new Promise((resolve) => {
    const o = opts || {};
    if (o.sandboxRel !== undefined && o.sandboxRel !== '') {
      const target = path.resolve(path.join(project.projectPath, o.sandboxRel));
      const rel = path.relative(project.projectPath, target);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        resolve({ ok: false, sandbox: true, msg: '路径超出项目目录' });
        return;
      }
    }
    const cwd = project.projectPath;
    // --non-interactive：凭证未缓存时直接报错而不是挂起等输入（本工具无 TTY 可交互）
    const fullArgs = ['--non-interactive', ...args];
    execFile('svn', fullArgs, {
      cwd,
      windowsHide: true,
      timeout: o.timeout || SVN_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        // svn 命令行未安装：execFile 产生 ENOENT
        if (err.code === 'ENOENT') {
          resolve({ ok: false, noSvn: true, msg: 'svn 命令行不可用' });
          return;
        }
        const out = (stderr || '') + (stdout || '');
        resolve({
          ok: false,
          notRepo: SVN_NOT_REPO_RE.test(out) || undefined,
          code: err.code,
          msg: (stderr || stdout || err.message || '').trim(),
        });
        return;
      }
      resolve({ ok: true, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

// svn info 输出里按键取值（"Revision: 123" 等），缺失返回 null
function svnInfoPick(stdout, kv) {
  const mm = stdout.match(new RegExp('^' + kv + ': (.*)$', 'm'));
  return mm ? mm[1].trim() : null;
}
// svn info/status 失败的统一响应体：noSvn（未装命令行）/ notRepo（非工作副本）/ 其余报错
function svnCmdFailResponse(r, cmdName) {
  if (r.noSvn) return { ok: false, noSvn: true };
  return r.notRepo ? { ok: false, notRepo: true } : { ok: false, msg: r.msg || ('svn ' + cmdName + ' 失败') };
}

function getSvnProject(req, res) {
  const p = getProject(req.params.id);
  if (!p) { res.status(404).json({ ok: false, msg: '项目不存在' }); return null; }
  if (!fs.existsSync(p.projectPath)) {
    res.status(404).json({ ok: false, msg: '目录不存在: ' + p.projectPath });
    return null;
  }
  return p;
}

// svn status 输出行格式（不带 -v：-v 的作者列宽度可变，固定列切分不适用）：
//   M       modified
//   A       added（svn add 过的新文件）
//   D       deleted
//   R       replaced（删了又加）
//   C       conflicted
//   ?       未版本控制
//   !       丢失（文件被删但未 svn delete）
// 第一列是状态，第 8 列起是路径（前 7 列是各标志位）。手动 svn add 之后
// 状态从 ? 变 A，与 Git 抽屉「勾选加入版本控制」的交互对齐。
function parseSvnStatus(stdout) {
  const files = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const st = line[0];
    let file = line.length > 8 ? line.slice(8) : '';
    if (!file) file = line.slice(1).trim();
    // 统一分隔符为 /（Windows 下 svn status 输出反斜杠路径，前端按 / 展示）
    file = file.replace(/\\/g, '/');
    files.push({ st, file });
  }
  return { files };
}

// .svnignore：SVN 工作副本的项目级忽略规则（.gitignore 的简化版）。SVN 原生没有
// 等价机制（svn:ignore 是逐目录属性、要进版本库，不适合本地噪音过滤），这里用项目
// 根目录的 .svnignore 文件表达，规则命中 .gitignore 直觉：
//   - 每行一条；空行与 # 注释行忽略；\# 等转义还原为字面字符
//   - 条目名匹配：'target' 或 'target/'（尾部 / 只匹配目录）命中任意层级的同名
//     目录/文件；含中间 '/' 的规则锚定项目根：'a/b' 只命中根下 a/b（'**/a/b' 例外）
//   - 通配符：* 任意字符（不含 /）、? 单字符、[abc] 字符类，仅作用于路径段内；
//     ** 作为独立路径段匹配零个或多个段：'**/logs/' 等价 'logs/'（任意层级），
//     'a/**/b' 命中 a/b、a/x/b、a/x/y/b，'target/**' 连 target 目录条目一起忽略
//   - 前导 / 锚定项目根：'/dist' 只匹配根下 dist，不匹配子目录里的 dist
//   - 大小写不敏感（本面板 Windows 专用，NTFS 文件名大小写不敏感，规则同理）
// 生效范围：/svn/status 的 M/A/D/?/! 全部状态——被忽略的条目服务端直接剔除，前端
// 抽屉不显示、无法勾选，自然进不了提交清单（本项目提交永远显式传文件清单，不存在
// 不带参数的“全部提交”，被忽略的改动不会被带进远端提交）。? 目录展开遍历同步跳过
// 被忽略路径（省掉 node_modules 级别的递归）。无 .svnignore 文件时行为完全不变。

// 解析 .svnignore 内容 → 规则数组，统一按 '/' 分段：每条 { segs, dirOnly, anchored }。
// 无效行（解析后为空、含不支持的 \ 用法）直接丢弃。文件不存在由调用方按无规则处理。
function parseSvnIgnore(content) {
  const rules = [];
  for (const rawLine of String(content).split(/\r?\n/)) {
    let line = rawLine;
    // 行首 \# \! 转义：先记住是字面行再剥反斜杠——若先剥成 # 开头会被当注释丢弃，
    // 转义失效。行内 \# \! \空格 等转义随后统一还原为字面字符
    const literalStart = /^\\[#!]/.test(line);
    if (literalStart) line = line.slice(1);
    line = line.replace(/\\([#!\s])/g, '$1');
    let trimmed = line.trim();
    if ((!trimmed || trimmed.startsWith('#')) && !literalStart) continue;
    let anchored = false;
    if (trimmed.startsWith('/')) { anchored = true; trimmed = trimmed.slice(1); }
    let dirOnly = false;
    if (trimmed.endsWith('/')) { dirOnly = true; trimmed = trimmed.slice(0, -1); }
    const segs = trimmed.split('/').filter(Boolean);
    if (!segs.length) continue;
    // gitignore 规范：模式中间含 '/' 时锚定项目根（'a/b' 只命中根下 a/b）；
    // 以 '**/' 开头的除外（'**/logs' 表达任意层级）
    if (!anchored && segs.length > 1 && segs[0] !== '**') anchored = true;
    rules.push({ segs, dirOnly, anchored });
  }
  return rules;
}

// 通配符段 → 正则（含缓存，按段缓存全局共享）。* ? [seq] 语法与 .gitignore 一致，
// 均不跨 '/'。i 标志：大小写不敏感（Windows/NTFS 文件名大小写不敏感，规则同理）
const SVN_IGNORE_SEG_RE_CACHE = new Map();
function svnIgnoreSegToRegExp(seg) {
  let re = SVN_IGNORE_SEG_RE_CACHE.get(seg);
  if (re) return re;
  let src = '';
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (ch === '*') src += '[^/]*';
    else if (ch === '?') src += '[^/]';
    else if (ch === '[') {
      const close = seg.indexOf(']', i + 1);
      if (close === -1 || close === i + 1) { src += '\\['; continue; } // 未闭合 / 空，按字面
      let cls = seg.slice(i + 1, close);
      const negated = cls.startsWith('!') || cls.startsWith('^');
      if (negated) cls = cls.slice(1);
      if (!cls) { src += '\\['; continue; }
      // 非法字符类（如 [z-a] 乱序范围）：new RegExp 会直接 THROW 拖垮整个
      // status 请求，预校验不过就整体按字面量处理（与 gitignore 对坏模式的
      // 宽容处理一致——不生效但不伤害）
      try { new RegExp('[' + (negated ? '^' : '') + cls.replace(/[\\\]]/g, '\\$1') + ']'); }
      catch (e) { src += seg.slice(i, close + 1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); i = close; continue; }
      src += '[' + (negated ? '^' : '') + cls.replace(/[\\\]]/g, '\\$1') + ']';
      i = close;
    } else src += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  re = new RegExp('^' + src + '$', 'i');
  SVN_IGNORE_SEG_RE_CACHE.set(seg, re);
  return re;
}

// 单段匹配：字面段全等（大小写不敏感），含通配符的段走正则
function svnIgnoreSegMatch(seg, name) {
  if (!/[*?[]/.test(seg)) return seg.toLowerCase() === name.toLowerCase();
  return svnIgnoreSegToRegExp(seg).test(name);
}

// 目录路径（相对项目根、'/' 分隔）是否被规则数组忽略。nameMode 'file' 按普通条目
// 匹配，'dir' 按目录匹配（dirOnly 规则只对目录生效）。匹配语义与 .gitignore 对齐：
//   - 非锚定规则可命中任意层级的同名段：'target' 命中 x/y/target
//   - 锚定（前导 /）与 'a/b' 形式的中间路径规则只从项目根起匹配
//   - '**' 段吸收零个或多个路径段（见 parseSvnIgnore 注释）
//   - 目录被忽略 → 其下所有内容视为被忽略（调用方对祖先目录先判定）
function svnIgnoreMatch(rules, relPath, nameMode) {
  if (!rules || !rules.length) return false;
  const segs = relPath.split('/').filter(Boolean);
  if (!segs.length) return false;
  const isDir = nameMode === 'dir';
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    // dirOnly 规则必须命中路径末段（endAlign）；其余规则允许命中中间窗口——
    // 与"目录被忽略则其下全部忽略"语义一致（祖先目录检查之外的双保险）
    const endAlign = rule.dirOnly;
    const maxStart = rule.anchored ? 0 : segs.length - 1;
    for (let start = 0; start <= maxStart; start++) {
      if (svnIgnoreSegsMatch(rule.segs, segs, 0, start, endAlign)) return true;
    }
  }
  return false;
}

// 规则段从 (ri, si) 起逐段匹配；规则段全部消耗即命中（endAlign 时还要求恰好
// 停在路径末段）。'**' 段回溯吸收零个或多个路径段，其余段逐一对上即前进。
function svnIgnoreSegsMatch(ruleSegs, segs, ri, si, endAlign) {
  if (ri === ruleSegs.length) return endAlign ? si === segs.length : true;
  const rs = ruleSegs[ri];
  if (rs === '**') {
    for (let k = si; k <= segs.length; k++) {
      if (svnIgnoreSegsMatch(ruleSegs, segs, ri + 1, k, endAlign)) return true;
    }
    return false;
  }
  if (si >= segs.length || !svnIgnoreSegMatch(rs, segs[si])) return false;
  return svnIgnoreSegsMatch(ruleSegs, segs, ri + 1, si + 1, endAlign);
}

// 读取项目根的 .svnignore；文件不存在 / 读失败返回 null（无忽略规则）
function loadSvnIgnore(p) {
  try {
    return parseSvnIgnore(fs.readFileSync(path.join(p.projectPath, '.svnignore'), 'utf-8'));
  } catch (e) {
    return null;
  }
}

// 展开未版本控制（?）目录：svn status 对整个 ? 目录只报一条（与 git
// --untracked-files=all 不同），前端「未提交列表以文件为单位」需要目录内的
// 具体文件。用文件系统遍历展开（svn 对未版本控制节点不提供 list 能力），
// 逐文件返回 {st:'?', file}。忽略 node_modules / .git / .svn 等噪音目录；
// .svnignore 规则命中（含祖先目录被忽略）的路径直接跳过、不再递归遍历。
const SVN_EXPAND_SKIP_DIRS = new Set(['node_modules', '.git', '.svn']);
function expandSvnUnversionedDir(p, dirRel, out, depth, ignoreRules) {
  if (depth > 8) return; // 防御：异常深的嵌套不再展开
  const abs = path.join(p.projectPath, dirRel);
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch (e) {
    return; // 目录读不到（权限等）就保留原目录条目，不再展开
  }
  for (const ent of entries) {
    if (SVN_EXPAND_SKIP_DIRS.has(ent.name)) continue;
    const rel = dirRel ? dirRel + '/' + ent.name : ent.name;
    if (svnIgnoreMatch(ignoreRules, rel, ent.isDirectory() ? 'dir' : 'file')) continue;
    if (ent.isDirectory()) {
      expandSvnUnversionedDir(p, rel, out, depth + 1, ignoreRules);
    } else if (ent.isFile()) {
      out.push({ st: '?', file: rel });
    }
  }
}

// svn status 路由：附带 rev/url（svn info 的关键输出），前端头部一次渲染。
// 注意先跑 info 探测工作副本：svn status 在非工作副本目录 exit 0（只输出 W155007
// 警告到 stderr），不能作为工作副本判定依据；svn info 才会以 E155007 非零退出。
// svn status 结果内存缓存：SVN 大工作副本（几万文件）status 要 10s+，
// 打开抽屉/连续重绘/刷新按钮不该每次都硬跑。按项目缓存最近一次结果：
//   - TTL（5s）内：直接复用
//   - TTL 外（stale）：立即返回旧数据（秒出），后台静默重扫，扫完自动回填缓存。
//     下次请求拿到新数据。前端凭响应里的 stale 标志转圈轮询，扫完静默更新
//   - 写操作（add/commit/revert/update）后主动失效：下次请求同步重扫（不走 stale）
//   - 并发去重（单飞）：同一项目同一时刻只有一个真扫描在跑（实测并发扫描因
//     wc.db SQLite 锁竞争 13s→43s，越跑越慢），其余请求共享同一 promise
const SVN_STATUS_CACHE_TTL = 5 * 1000;
const svnStatusCache = new Map(); // projectId -> { at, promise }（promise resolve 完整响应体）
const svnStatusStaleJobs = new Set(); // 正在后台重扫的 projectId（防重复投 jobs）
const svnStatusBgManual = new Set(); // 重扫中且由手动刷新（refresh=1）触发的 projectId——前端凭此区分「用户在等的扫描」与例行重扫（TTL 过期），前者才转圈
const svnStatusStaleDone = new Set(); // 后台重扫完成的 projectId（供前端轮询/拉取时清）
const svnStatusBgPromise = new Map(); // projectId -> 后台重扫 promise（单飞共享用）
// 缓存命中返回进行中/已完成的响应 promise（await 即数据），未命中返回 null
function svnStatusCacheGet(id) {
  const e = svnStatusCache.get(id);
  if (!e) return null;
  return e.promise;
}
function svnStatusCacheIsFresh(id) {
  const e = svnStatusCache.get(id);
  return !!e && Date.now() - e.at <= SVN_STATUS_CACHE_TTL;
}
function svnStatusCacheInvalidate(id) {
  svnStatusCache.delete(id);
}

// stale 数据后台重扫：扫完回填缓存。由 status 路由在返回 stale 数据时投递；
// refresh=1 同样走这里（前端立即拿旧数据 + 转圈轮询，不再同步等扫描）。
// 失败静默（旧缓存保留，下次再试）。重扫期间旧缓存保留不删：新请求命中
// 非 fresh 缓存 → 再走 stale 分支秒回旧数据（前端能持续拿到 busy 指示），
// 投递去重由 svnStatusStaleJobs 挡住，不会重复起扫描。
// manual：是否手动刷新（refresh=1）触发。例行重扫（TTL 过期）进行中来了手动
// 刷新 → 升级为 manual：用户点了刷新在等结果，转圈指示该亮。
function svnStatusBackgroundRefresh(p, manual) {
  // 已在跑且本次是手动刷新 → 升级为 manual（用户在等）；例行投递不改动既有标记
  if (svnStatusStaleJobs.has(p.id)) {
    if (manual) svnStatusBgManual.add(p.id);
    return;
  }
  svnStatusStaleJobs.add(p.id);
  if (manual) svnStatusBgManual.add(p.id);
  const startedAt = Date.now();
  const promise = buildSvnStatusResponse(p).then((data) => {
    // 回填前校验：扫描期间若发生了写操作（缓存被重新回填且时间更新），
    // 丢弃本次过期结果，否则会把写操作后的新状态覆盖成扫描前的旧状态
    const cur = svnStatusCache.get(p.id);
    if (data.ok && (!cur || cur.at <= startedAt)) {
      svnStatusCache.set(p.id, { at: Math.max(startedAt, Date.now()), promise });
    }
    return data;
  }).catch((e) => ({ ok: false, msg: 'svn status 异常: ' + (e && e.message || e) })).finally(() => {
    svnStatusStaleJobs.delete(p.id);
    svnStatusBgManual.delete(p.id);
    svnStatusBgPromise.delete(p.id);
    svnStatusStaleDone.add(p.id); // 通知前端：后台刷新完成，可重拉
  });
  svnStatusBgPromise.set(p.id, promise);
}

// 组装 svn status 完整响应（info + status + .svnignore 过滤 + ? 目录展开）。
// 只被带缓存的 status 路由调用；失败响应不进缓存（下次重试）。
async function buildSvnStatusResponse(p) {
  // 测试钩子：人为拖慢扫描，制造确定的「重扫进行中」窗口（仅测试设置）
  const delay = parseInt(process.env.__PTP_SVN_SCAN_DELAY_MS__, 10);
  if (delay > 0) await new Promise((res) => setTimeout(res, delay));
  const info = await runSvn(p, ['info']);
  if (!info.ok) return svnCmdFailResponse(info, 'info');
  const r = await runSvn(p, ['status']);
  if (!r.ok) return svnCmdFailResponse(r, 'status');
  const parsed = parseSvnStatus(r.stdout);
  // .svnignore：项目根有该文件时按规则过滤（M/A/D/?/! 全部状态生效），被忽略的
  // 条目服务端直接剔除，前端抽屉不显示、也进不了提交清单。祖先目录被忽略的条目
  // （如 target/ 整目录被忽略时的 target/cla/ss）一并剔除——目录被忽略即其下
  // 全部内容被忽略。
  const ignoreRules = loadSvnIgnore(p);
  const isIgnoredEntry = (rel, isDir) => {
    if (!ignoreRules || !ignoreRules.length) return false;
    const segs = rel.split('/').filter(Boolean);
    for (let i = 1; i < segs.length; i++) {
      if (svnIgnoreMatch(ignoreRules, segs.slice(0, i).join('/'), 'dir')) return true;
    }
    return svnIgnoreMatch(ignoreRules, rel, isDir ? 'dir' : 'file');
  };
  // ? 目录条目展开为目录内具体文件；目录本身不再出现在列表里（前端以文件为单位），
  // 仅当目录为空（没有任何文件可展开）时保留原条目——否则空目录会从列表消失、无法勾选。
  // 注意 Windows 上 svn status 的 ? 目录条目不带尾部斜杠（"? newpkg"），用
  // 磁盘 stat 判定目录而非看斜杠。
  const files = [];
  for (const f of parsed.files) {
    let isDir = false;
    if (f.st === '?') {
      try {
        isDir = fs.statSync(path.join(p.projectPath, f.file)).isDirectory();
      } catch (e) { /* stat 失败按文件处理 */ }
    }
    if (isIgnoredEntry(f.file, isDir)) continue;
    if (isDir) {
      const expanded = [];
      expandSvnUnversionedDir(p, f.file, expanded, 0, ignoreRules);
      if (expanded.length) {
        files.push(...expanded);
      } else {
        files.push(f);
      }
    } else {
      files.push(f);
    }
  }
  return {
    ok: true,
    rev: svnInfoPick(info.stdout, 'Revision'),
    url: svnInfoPick(info.stdout, 'URL'),
    lastChangedAuthor: svnInfoPick(info.stdout, 'Last Changed Author'),
    lastChangedDate: svnInfoPick(info.stdout, 'Last Changed Date'),
    fetchedAt: Date.now(), // 前端展示数据新鲜度（缓存命中时是旧值，可显示“缓存于 xx 秒前”）
    files,
  };
}

// svn status（带缓存，stale-while-revalidate）：
//   - TTL 内：直接回缓存（秒出）
//   - TTL 外有旧数据（含 ?refresh=1 手动刷新）：立即回旧数据（带 stale:true），
//     同时投后台重扫；重扫完成回填缓存。手动刷新也绝不同步等 10s+ ——
//     旧列表先照常展示，扫完静默更新
//   - 无缓存 / 写操作后失效：同步重扫（首屏或数据变更后必须拿新值）
//   - 全局单飞：同一项目同一时刻只有一个真扫描在跑（后台或同步），
//     期间所有请求（含 refresh）共享进行中的结果——并发 svn status 实测
//     互相拖慢（13s→43s，wc.db SQLite 锁竞争）
app.get('/api/projects/:id/svn/status', async (req, res) => {
  const p = getSvnProject(req, res);
  if (!p) return;
  const force = req.query.refresh === '1';
  const sync = req.query.sync === '1'; // 强制同步扫（绕过缓存与 stale，测试/工具用）
  if (sync) svnStatusCacheInvalidate(p.id);
  if (!sync) {
    const cached = svnStatusCacheGet(p.id);
    if (cached) {
      const data = await cached;
      // 手动刷新（refresh=1）：无论新旧一律走 stale——立即回旧数据 + 后台重扫，
      // 绝不同步等扫描（旧语义 invalidate+同步扫 = 点刷新白屏 10s+，已废除）。
      // 重扫带 manual 来源标记：手动刷新触发的才让前端转圈，例行重扫静默
      if (!force && svnStatusCacheIsFresh(p.id)) return res.json(data);
      svnStatusBackgroundRefresh(p, force);
      return res.json({ ...data, stale: true });
    }
    // 无缓存：若后台任务恰好在跑，直接共享它的结果（单飞）
    if (svnStatusStaleJobs.has(p.id)) {
      const bg = svnStatusBgPromise.get(p.id);
      if (bg) return res.json(await bg);
    }
  }
  const promise = buildSvnStatusResponse(p).then((data) => {
    if (data.ok) svnStatusCache.set(p.id, { at: Date.now(), promise });
    else svnStatusCache.delete(p.id); // 失败不缓存，下次重试
    return data;
  });
  svnStatusCache.set(p.id, { at: Date.now(), promise });
  res.json(await promise);
});

// 轻量轮询：后台重扫是否完成。前端 stale 展示期间定时问一下，完成了就重拉拿新数据。
// 比让前端盲等重拉（每次都打真扫描）轻得多——这里只查内存 Set，零开销。
// busy：该项目是否正在真扫描（后台重扫或无缓存同步扫）
// manual：在跑的扫描是否由手动刷新触发——前端切回项目时凭它区分「用户在等的
// 扫描」（恢复转圈/禁用态）与例行重扫（TTL 过期，静默等数据回填即可）
app.get('/api/projects/:id/svn/status-refresh-done', (req, res) => {
  const id = req.params.id;
  const done = svnStatusStaleDone.has(id) && !svnStatusStaleJobs.has(id);
  if (done) svnStatusStaleDone.delete(id);
  const busy = svnStatusStaleJobs.has(id);
  res.json({ ok: true, done, busy, manual: busy && svnStatusBgManual.has(id) });
});

// svn 头部信息（rev/url）：只跑 svn info（零点几秒），供抽屉骨架屏秒出——
// 完整 status 在大工作副本上要 10s+，头部不该陪绑。不进缓存（本身够快）。
app.get('/api/projects/:id/svn/status-meta', async (req, res) => {
  const p = getSvnProject(req, res);
  if (!p) return;
  const info = await runSvn(p, ['info']);
  if (!info.ok) return res.json(svnCmdFailResponse(info, 'info'));
  res.json({ ok: true, rev: svnInfoPick(info.stdout, 'Revision'), url: svnInfoPick(info.stdout, 'URL') });
});

// 联网比对远端仓库，返回本地未更新的提交条数（behind），仅用于「更新」按钮
// 徽标展示，不做任何本地修改。口径与历史区「未更新」徽标一致：revision 比本地
// 工作副本基准版本（svn info 的 Revision，即 BASE）新的 log 条目数。
app.get('/api/projects/:id/svn/remote-status', async (req, res) => {
  const p = getSvnProject(req, res);
  if (!p) return;
  const info = await runSvn(p, ['info']);
  if (!info.ok) return res.json(svnCmdFailResponse(info, 'info'));
  // svn log -r BASE:HEAD 列出本地基准版本之后的提交（区间含端点，BASE 自身也会
  // 返回，因此下面按 revision > 本地 rev 过滤掉端点条目）。
  const baseRev = parseInt(svnInfoPick(info.stdout, 'Revision'), 10) || 0;
  const r = await runSvn(p, ['log', '--xml', '-r', 'BASE:HEAD']);
  if (!r.ok) {
    if (r.noSvn) return res.json({ ok: false, noSvn: true });
    return res.json({ ok: false, msg: r.msg || 'svn log 失败' });
  }
  let behind = 0;
  const revs = [];   // 比 BASE 新的版本号列表：前端排除本面板自己提交的版本后再算 behind
  const entryRe = /<logentry\b[^>]*\brevision="([^"]+)"/g;
  let m;
  while ((m = entryRe.exec(r.stdout)) !== null) {
    if ((parseInt(m[1], 10) || 0) > baseRev) { behind++; revs.push(parseInt(m[1], 10)); }
  }
  res.json({ ok: true, behind, revs });
});

// svn update：网络操作，返回合并输出供前端展示（冲突文件在 status 里以 C 呈现）
app.post('/api/projects/:id/svn/update', async (req, res) => {
  const p = getSvnProject(req, res);
  if (!p) return;
  const r = await runSvn(p, ['update']);
  svnStatusCacheInvalidate(p.id); // update 改变工作副本状态，status 缓存失效
  if (!r.ok) {
    if (r.noSvn) return res.json({ ok: false, noSvn: true });
    return res.json(r.notRepo ? { ok: false, notRepo: true } : { ok: false, msg: r.msg || 'svn update 失败' });
  }
  res.json({ ok: true, msg: (r.stdout + '\n' + r.stderr).trim() });
});

// svn add：把未版本控制（?）文件加入版本控制。body { files: string[] }
// 未版本控制目录内的文件不能直接 add（E150000: 父目录节点不存在）——须自顶向下：
// 先对路径上每个尚未版本控制的父目录 --depth empty add，再 add 文件本身。
app.post('/api/projects/:id/svn/add', async (req, res) => {
  const p = getSvnProject(req, res);
  if (!p) return;
  const files = Array.isArray(req.body && req.body.files) ? req.body.files.filter(Boolean) : [];
  if (!files.length) return res.status(400).json({ ok: false, msg: '未指定文件' });
  svnStatusCacheInvalidate(p.id); // add 改变版本控制状态，status 缓存失效
  // 沙箱校验每个文件（与 diff 单文件同规则），逃逸直接拒绝
  for (const f of files) {
    const target = path.resolve(path.join(p.projectPath, f));
    const rel = path.relative(p.projectPath, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return res.status(400).json({ ok: false, msg: '路径超出项目目录' });
    }
  }
  // 收集所有待 add 节点（含未版本控制的父目录，深度排序保证父先于子），逐个 add
  const nodes = new Set();
  for (const f of files) {
    const segs = f.replace(/\\/g, '/').split('/').filter(Boolean);
    // 文件是最后一个段；目录段自顶向下加入（svn status 返回的 ? 文件都在工作副本内）
    for (let i = 1; i < segs.length; i++) {
      const parent = segs.slice(0, i).join('/');
      nodes.add({ path: parent, depthEmpty: true }); // 占位，下面重排
    }
    nodes.add({ path: segs.join('/'), depthEmpty: false });
  }
  const ordered = [...nodes].sort((a, b) => a.path.split('/').length - b.path.split('/').length
    || (a.depthEmpty === b.depthEmpty ? 0 : a.depthEmpty ? -1 : 1));
  for (const n of ordered) {
    const args = ['add'];
    if (n.depthEmpty) args.push('--depth', 'empty');
    args.push('--', n.path);
    const r = await runSvn(p, args);
    if (!r.ok) {
      if (r.noSvn) return res.json({ ok: false, noSvn: true });
      // 已在版本控制下的节点（W150002）跳过继续；其余错误原样返回
      if (/W150002/.test(r.msg || '')) continue;
      return res.json(r.notRepo ? { ok: false, notRepo: true } : { ok: false, msg: r.msg || 'svn add 失败' });
    }
  }
  res.json({ ok: true });
});

// svn commit：body { message, files? }。SVN 无暂存区：files 为空提交全部变更，
// 非空则只提交指定文件（相当于 Git 抽屉勾选部分文件提交的语义）。
// 提交即推送远端，成功返回新版本号（stdout 末行的 "Committed revision N."）。
app.post('/api/projects/:id/svn/commit', async (req, res) => {
  const p = getSvnProject(req, res);
  if (!p) return;
  const message = String((req.body && req.body.message) || '').trim();
  if (!message) return res.status(400).json({ ok: false, msg: '提交说明不能为空' });
  svnStatusCacheInvalidate(p.id); // commit 改变工作副本状态，status 缓存失效
  const files = Array.isArray(req.body && req.body.files) ? req.body.files.filter(Boolean) : [];
  // 新增（A）目录里的文件若要提交，其 A 状态祖先目录必须一起进本次提交
  // （E200009: child is part of the commit but parent not known to exist）。
  // 例：新目录 test/ 下 add 了 test1/ 与 test11.md，只勾文件提交会被拒——
  // 补齐路径上所有未提交的 A 目录后按提交 svn 要求（父先于子）排序。
  if (files.length) {
    const addedDirs = new Set((await runSvn(p, ['status'])).stdout
      .split(/\r?\n/).map(l => l[0] === 'A' ? l.slice(8).replace(/\\/g, '/').trim() : '')
      .filter(Boolean));
    const needed = new Set();
    for (const f of files) {
      const segs = f.replace(/\\/g, '/').split('/');
      for (let i = 1; i < segs.length; i++) {
        const dir = segs.slice(0, i).join('/');
        if (addedDirs.has(dir)) needed.add(dir);
      }
    }
    for (const d of needed) files.push(d);
    files.sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1));
  }
  // --force-log：说明文本恰好与工作区内文件名相同时（如提交某文件的改动用了文件名
  // 当说明），svn 默认按"疑似把路径当消息"拒绝（E205000），此开关明确告知就是日志
  const args = ['commit', '--force-log', '-m', message];
  if (files.length) args.push('--', ...files);
  const r = await runSvn(p, args);
  if (!r.ok) {
    if (r.sandbox) return res.status(400).json({ ok: false, msg: r.msg });
    if (r.noSvn) return res.json({ ok: false, noSvn: true });
    return res.json(r.notRepo ? { ok: false, notRepo: true } : { ok: false, msg: r.msg || '提交失败' });
  }
  const m = r.stdout.match(/Committed revision (\d+)\./);
  res.json({ ok: true, rev: m ? m[1] : null, msg: (r.stdout + '\n' + r.stderr).trim() });
});

// svn revert：撤销本地未提交修改（含未提交的 add）。body { files: string[] }。
// 不可逆（本地改动直接丢弃），前端弹确认框后才调用。
app.post('/api/projects/:id/svn/revert', async (req, res) => {
  const p = getSvnProject(req, res);
  if (!p) return;
  const files = Array.isArray(req.body && req.body.files) ? req.body.files.filter(Boolean) : [];
  if (!files.length) return res.status(400).json({ ok: false, msg: '未指定文件' });
  // 沙箱校验每个文件（与 svn add 同规则）：revert --depth infinity 可递归作用
  // 到目录，路径逃逸会撤销项目目录之外的文件，逃逸直接拒绝
  for (const f of files) {
    const target = path.resolve(path.join(p.projectPath, f));
    const rel = path.relative(p.projectPath, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return res.status(400).json({ ok: false, msg: '路径超出项目目录' });
    }
  }
  svnStatusCacheInvalidate(p.id); // revert 改变工作副本状态，status 缓存失效
  const r = await runSvn(p, ['revert', '--depth', 'infinity', '--'].concat(files));
  if (!r.ok) {
    if (r.sandbox) return res.status(400).json({ ok: false, msg: r.msg });
    if (r.noSvn) return res.json({ ok: false, noSvn: true });
    return res.json(r.notRepo ? { ok: false, notRepo: true } : { ok: false, msg: r.msg || 'revert 失败' });
  }
  res.json({ ok: true });
});

// 提交历史：svn log -v --xml 解析成 JSON。--xml 避免 locale 文案差异，
// 结构固定：<logentry revision author date><msg>..<paths><path action>..</path></paths></logentry>
// -r HEAD:0 降序 + -l N 取最新 N 条（limit 作用于遍历起点一端，必须从 HEAD 端截），
// 返回即最新在前。工作副本落后远端（mixed-revision / 未 update）时，不带 -r 的 log
// 只从工作副本的 BASE 往回看，会漏掉远端新提交；HEAD 始终看仓库全量。
app.get('/api/projects/:id/svn/log', async (req, res) => {
  const p = getSvnProject(req, res);
  if (!p) return;
  let limit = parseInt(req.query.limit, 10);
  if (!(limit > 0)) limit = 30;
  if (limit > SVN_LOG_LIMIT_MAX) limit = SVN_LOG_LIMIT_MAX;
  const r = await runSvn(p, ['log', '-v', '--xml', `-l${limit}`, '-r', 'HEAD:0']);
  if (!r.ok) {
    if (r.noSvn) return res.json({ ok: false, noSvn: true });
    return res.json(r.notRepo ? { ok: false, notRepo: true } : { ok: false, msg: r.msg || 'svn log 失败' });
  }
  const commits = [];
  // 逐条 logentry 切分：属性（revision/author/date）+ <msg> + <paths> 下的 <path>
  const entryRe = /<logentry\b([^>]*)>([\s\S]*?)<\/logentry>/g;
  let em;
  while ((em = entryRe.exec(r.stdout)) !== null) {
    const attrs = em[1];
    const body = em[2];
    const revM = attrs.match(/\brevision="([^"]+)"/);
    const authorM = body.match(/<author>([\s\S]*?)<\/author>/);
    const dateM = body.match(/<date>([\s\S]*?)<\/date>/);
    const msgM = body.match(/<msg>([\s\S]*?)<\/msg>/);
    const paths = [];
    const pathRe = /<path\b([^>]*)>([\s\S]*?)<\/path>/g;
    let pm;
    while ((pm = pathRe.exec(body)) !== null) {
      const actM = pm[1].match(/\baction="([^"]+)"/);
      paths.push({ action: actM ? actM[1] : '', file: pm[2].trim() });
    }
    commits.push({
      rev: revM ? revM[1] : '',
      author: authorM ? decodeXmlEntities(authorM[1]) : '',
      // svn 的 date 是 ISO8601 带毫秒与 Z（如 2026-08-31T12:34:56.789Z），转秒级时间戳
      at: dateM ? (new Date(decodeXmlEntities(dateM[1])).getTime() / 1000 || 0) : 0,
      subject: msgM ? decodeXmlEntities(msgM[1]) : '',
      files: paths,
    });
  }
  // HEAD:0 降序输出即最新在前，直接按序返回（前端按数组序渲染）
  res.json({ ok: true, commits });
});

// XML 实体反转义（svn log --xml 对 & < > 等转义；解码仅用于展示文本，不拼 HTML）
function decodeXmlEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// diff：query file（相对 projectPath 的文件路径，沙箱化）、rev=<N>（看某次提交的变更）。
// 均未传时为工作区整体 diff（工作区与 BASE 对比）。unified 格式，前端复用 Git 的
// parseSideBySide 双栏解析。
app.get('/api/projects/:id/svn/diff', async (req, res) => {
  const p = getSvnProject(req, res);
  if (!p) return;
  const file = req.query.file ? String(req.query.file) : '';
  const rev = req.query.rev ? String(req.query.rev) : '';
  if (rev && !/^\d+$/.test(rev)) {
    return res.status(400).json({ ok: false, msg: '非法的版本号' });
  }
  const args = ['diff', '--internal-diff'];
  if (rev) {
    // 看某次提交自身的变更：-c <rev> 等价 diff <rev>-1:<rev>。可与 file 组合
    args.push('-c', rev);
    if (file) args.push('--', file);
  } else if (file) {
    args.push('--', file);
  }
  const r = await runSvn(p, args, file ? { sandboxRel: path.dirname(file) } : undefined);
  if (!r.ok) {
    if (r.sandbox) return res.status(400).json({ ok: false, msg: r.msg });
    if (r.noSvn) return res.json({ ok: false, noSvn: true });
    return res.json(r.notRepo ? { ok: false, notRepo: true } : { ok: false, msg: r.msg || 'svn diff 失败' });
  }
  res.json({ ok: true, diff: r.stdout });
});

// ---------------------------------------------------------------------------
// Claude 历史会话:读取 ~/.claude/projects/<编码路径>/*.jsonl 的外部会话记录。
// 每行一个 JSON:meta/caveat 行(type!=user 或 isMeta)跳过,取首条真实用户消息作摘要;
// 上下文大小取文件内 assistant usage(input+cache_read+cache_creation)的最大值;
// 文件 mtime 即最后活动时间;按 mtime 倒序取前 20 个,供前端弹窗点选后 --resume 恢复。
// ---------------------------------------------------------------------------
function listClaudeHistory(projectPath) {
  const dir = path.join(CLAUDE_PROJECTS_DIR, encodeClaudeProjectDir(projectPath));
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (e) {
    return []; // 目录不存在 = 该项目从未在本机开过 claude,空列表即可
  }
  const sessions = [];
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const sessionId = f.slice(0, -'.jsonl'.length);
    let summary = '';
    let timestamp = null;
    let contextTokens = null;
    try {
      // 逐行扫:摘要取到首条真实用户消息即停;usage 持续跟踪取最大(上下文只增不减,
      // 最后一轮即最大,但 auto-compact 后会回落——取历史最大即"本会话上下文峰值")。
      const lines = fs.readFileSync(path.join(dir, f), 'utf-8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch (e) { continue; }
        const u = obj.message && obj.message.usage;
        if (u) {
          const total = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          if (total > 0 && total > (contextTokens || 0)) contextTokens = total;
        }
        if (summary) continue; // 摘要已取到,只剩 usage 跟踪
        if (obj.type !== 'user' || obj.isMeta) continue;
        const c = obj.message && obj.message.content;
        // content 可能是字符串,也可能是分块数组(取首个 text 块)
        let text = '';
        if (typeof c === 'string') text = c;
        else if (Array.isArray(c)) {
          const t = c.find((b) => b && b.type === 'text');
          if (t) text = t.text || '';
        }
        text = (text || '').trim();
        if (!text) continue;
        summary = text.length > 80 ? text.slice(0, 80) + '…' : text;
      }
      timestamp = fs.statSync(path.join(dir, f)).mtime.toISOString();
    } catch (e) {
      continue; // 单个文件读失败跳过,不影响其余会话
    }
    sessions.push({ sessionId, summary, timestamp, contextTokens });
  }
  sessions.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  return sessions; // 截断交给路由层按 offset/limit 分页
}

// ---------------------------------------------------------------------------
// Codex 历史会话:读取 ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl。
// 首行 session_meta.payload.cwd 标记项目(与 claude 不同,codex 目录名是日期不含
// 项目路径,项目归属只能看 cwd 字段);摘要取首条真实用户消息(response_item 中
// role=user 的 message,跳过 role=developer 的注入指令与 AGENTS.md 内容);
// 上下文取 event_msg token_count.last_token_usage(input+cached+cache_write)峰值;
// mtime = 最后活动时间;输出结构与 listClaudeHistory 一致。
// ---------------------------------------------------------------------------
function listCodexHistory(projectPath) {
  const wanted = path.resolve(projectPath).toLowerCase();
  const sessions = [];
  // 日期分层目录,直接递归三层取 rollout-*.jsonl(目录不存在 = 从未开过 codex)
  const root = CODEX_SESSIONS_DIR;
  let yearDirs;
  try { yearDirs = fs.readdirSync(root); } catch (e) { return []; }
  for (const y of yearDirs) {
    if (!/^\d{4}$/.test(y)) continue;
    let monthDirs;
    try { monthDirs = fs.readdirSync(path.join(root, y)); } catch (e) { continue; }
    for (const m of monthDirs) {
      if (!/^\d{1,2}$/.test(m)) continue;
      let dayDirs;
      try { dayDirs = fs.readdirSync(path.join(root, y, m)); } catch (e) { continue; }
      for (const d of dayDirs) {
        if (!/^\d{1,2}$/.test(d)) continue;
        const dayDir = path.join(root, y, m, d);
        let files;
        try { files = fs.readdirSync(dayDir); } catch (e) { continue; }
        for (const f of files) {
          if (!f.endsWith('.jsonl')) continue;
          let rec = null;
          try { rec = readCodexSessionFile(path.join(dayDir, f), wanted); } catch (e) {}
          if (rec) sessions.push(rec);
        }
      }
    }
  }
  sessions.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  return sessions;
}

function readCodexSessionFile(file, wantedLower) {
  const lines = fs.readFileSync(file, 'utf-8').split('\n');
  let cwd = null;
  let sessionId = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (e) { continue; }
    if (obj.type === 'session_meta') {
      cwd = obj.payload && obj.payload.cwd;
      sessionId = (obj.payload && (obj.payload.session_id || obj.payload.id)) || path.basename(file, '.jsonl');
      break;
    }
  }
  if (!cwd || path.resolve(cwd).toLowerCase() !== wantedLower) return null; // 项目不符
  let summary = '';
  let contextTokens = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (e) { continue; }
    if (obj.type === 'event_msg' && obj.payload && obj.payload.type === 'token_count') {
      const u = obj.payload.info && obj.payload.info.last_token_usage;
      if (u) {
        const total = (u.input_tokens || 0) + (u.cached_input_tokens || 0) + (u.cache_write_input_tokens || 0);
        if (total > 0 && total > (contextTokens || 0)) contextTokens = total;
      }
      continue;
    }
    if (summary || obj.type !== 'response_item') continue;
    const pl = obj.payload || {};
    if (pl.type !== 'message' || pl.role !== 'user') continue;
    const blocks = Array.isArray(pl.content) ? pl.content : [];
    const t = blocks.find((b) => b && b.type === 'input_text');
    let text = (t && t.text || '').trim();
    // 跳过系统注入:developer 角色/AGENTS.md/skills 等指令块(用户消息前常被注入)
    if (!text || /^<skills_instructions>|^# AGENTS\.md|^<INSTRUCTIONS>|^<environment_context>/.test(text)) continue;
    summary = text.length > 80 ? text.slice(0, 80) + '…' : text;
  }
  return { sessionId, summary, timestamp: fs.statSync(file).mtime.toISOString(), contextTokens };
}

// ---------------------------------------------------------------------------
// pi 历史会话:读取 ~/.pi/agent/sessions/<编码目录>/*.jsonl。
// 首行 {"type":"session","cwd":...} 标记项目;摘要取首条 user message;
// 上下文取 assistant 行 usage.totalTokens 峰值;mtime = 最后活动时间。
// ---------------------------------------------------------------------------
function listPiHistory(projectPath) {
  const wanted = path.resolve(projectPath).toLowerCase();
  const root = PI_SESSIONS_DIR;
  let dirs;
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return []; }
  const sessions = [];
  for (const ent of dirs) {
    if (!ent.isDirectory()) continue;
    const sub = path.join(root, ent.name);
    let files;
    try { files = fs.readdirSync(sub); } catch (e) { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      let rec = null;
      try { rec = readPiSessionFile(path.join(sub, f), wanted); } catch (e) {}
      if (rec) sessions.push(rec);
    }
  }
  sessions.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  return sessions;
}

function readPiSessionFile(file, wantedLower) {
  const lines = fs.readFileSync(file, 'utf-8').split('\n');
  let cwd = null;
  let sessionId = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (e) { continue; }
    if (obj.type === 'session') {
      cwd = obj.cwd;
      sessionId = obj.id || path.basename(file, '.jsonl');
      break;
    }
  }
  if (!cwd || path.resolve(cwd).toLowerCase() !== wantedLower) return null;
  let summary = '';
  let contextTokens = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (e) { continue; }
    const msg = obj.message;
    if (msg && msg.role === 'assistant' && msg.usage) {
      const total = msg.usage.totalTokens || 0;
      if (total > 0 && total > (contextTokens || 0)) contextTokens = total;
      continue;
    }
    if (summary || obj.type !== 'message' || !msg || msg.role !== 'user') continue;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const t = blocks.find((b) => b && b.type === 'text');
    const text = ((t && t.text) || '').trim();
    if (!text) continue;
    summary = text.length > 80 ? text.slice(0, 80) + '…' : text;
  }
  return { sessionId, summary, timestamp: fs.statSync(file).mtime.toISOString(), contextTokens };
}

// ---------------------------------------------------------------------------
// 终端会话 REST API(claude / codex;会话仅运行时内存,不落盘)
// 两类型路由平行:/api/projects/:id/claude-sessions 与 .../codex-sessions,
// 同一套 handler 按类型参数化注册;sessionId 前缀已含类型,其余逻辑共用。
// ---------------------------------------------------------------------------
const SESSION_ROUTE_SUFFIX = { claude: 'claude-sessions', codex: 'codex-sessions', cmd: 'cmd-sessions', gitbash: 'gitbash-sessions', pi: 'pi-sessions' };
for (const type of ['claude', 'codex', 'cmd', 'gitbash', 'pi']) {
  const base = `/api/projects/:id/${SESSION_ROUTE_SUFFIX[type]}`;

  // 列出某项目下的活跃终端会话
  app.get(base, (req, res) => {
    const p = getProject(req.params.id);
    if (!p) return res.status(404).json({ ok: false, msg: '项目不存在' });
    const list = [];
    for (const [sessionId, rec] of ptySessions) {
      if (rec.projectId === p.id && rec.type === type) {
        list.push({ sessionId, sessionNumber: rec.sessionNumber, pid: rec.pid });
      }
    }
    res.json({ ok: true, sessions: list });
  });

  // 创建终端会话:cwd = 宿主项目 projectPath;body.resume 可选(claude 历史会话恢复)
  app.post(base, (req, res) => {
    const result = createTerminalSession(req.params.id, type, { resume: req.body && req.body.resume });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  });

  // 历史会话列表:读各 CLI 本地的会话文件,弹窗点选后按各自方式恢复会话。
  // 支持 offset/limit 分页(前端滚动加载):limit 缺省 20,回包带 hasMore 供判断是否继续加载。
  const HISTORY_LISTERS = { claude: listClaudeHistory, codex: listCodexHistory, pi: listPiHistory };
  if (HISTORY_LISTERS[type]) {
    app.get(`/api/projects/:id/${type}-history`, (req, res) => {
      const p = getProject(req.params.id);
      if (!p) return res.status(404).json({ ok: false, msg: '项目不存在' });
      const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
      const all = HISTORY_LISTERS[type](p.projectPath);
      const sessions = all.slice(offset, offset + limit);
      res.json({ ok: true, sessions, hasMore: offset + sessions.length < all.length });
    });
  }

  // 关闭单个终端会话:递归 taskkill /T 杀进程树并移除菜单项
  app.delete(`${base}/:sessionId`, (req, res) => {
    const rec = ptySessions.get(req.params.sessionId);
    if (!rec || rec.projectId !== req.params.id || rec.type !== type) {
      return res.status(404).json({ ok: false, msg: '会话不存在' });
    }
    killPtySession(req.params.sessionId, 'user closed');
    res.json({ ok: true });
  });

  // 调整 PTY 尺寸:xterm.js 面板尺寸变化时通知后端 resize PTY(cols/rows)。
  app.post(`${base}/:sessionId/resize`, (req, res) => {
    const rec = ptySessions.get(req.params.sessionId);
    if (!rec || rec.projectId !== req.params.id || rec.type !== type) {
      return res.status(404).json({ ok: false, msg: '会话不存在' });
    }
    const cols = parseInt(req.body && req.body.cols, 10);
    const rows = parseInt(req.body && req.body.rows, 10);
    if (cols > 0 && rows > 0) {
      try { rec.pty.resize(cols, rows); } catch (e) {}
    }
    res.json({ ok: true });
  });
}

const server = http.createServer(app);

// ---------------------------------------------------------------------------
// WebSocket：实时日志 + 状态推送
// ---------------------------------------------------------------------------
const wss = new WebSocket.Server({ server });

const clients = new Set();

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

wss.on('connection', (ws) => {
  clients.add(ws);
  // 连接时推送所有项目当前运行状态
  for (const p of projects) {
    const rec = runs.get(p.id);
    ws.send(JSON.stringify({
      type: 'status',
      projectId: p.id,
      running: !!(rec && rec.pid),
      pid: rec ? rec.pid : null,
    }));
  }
  // 连接时推送当前所有活跃终端会话（页面刷新后菜单重建）
  for (const [sessionId, rec] of ptySessions) {
    ws.send(JSON.stringify({
      type: TERMINAL_TYPES[rec.type].msgSession,
      event: 'create',
      sessionId,
      projectId: rec.projectId,
      sessionNumber: rec.sessionNumber,
      sessionType: rec.type,
      pid: rec.pid,
    }));
  }
  // 前端键盘输入：xterm.js onData -> WS { type:'claude-input'|'codex-input', sessionId, data }
  // -> 写进对应会话 PTY stdin。真终端语义（方向键、Ctrl+C 等）。
  const PTY_INPUT_TYPES = new Set(Object.values(TERMINAL_TYPES).map((t) => t.msgInput));
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (PTY_INPUT_TYPES.has(msg.type) && msg.sessionId) {
      const rec = ptySessions.get(msg.sessionId);
      if (rec && rec.pty) {
        try { rec.pty.write(msg.data); } catch (e) {}
      }
    }
  });
  ws.on('close', () => clients.delete(ws));
});

// ---------------------------------------------------------------------------
// 导出（仅供 in-process 测试使用，运行时行为不变）
// ---------------------------------------------------------------------------
module.exports = { broadcast, sanitizeTerminalEnv };

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`启动器运行于 http://localhost:${PORT}`);
});
