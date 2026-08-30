'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn, exec, execSync, execFile } = require('child_process');
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

// 终端会话 spawn 的命令/参数/消息类型，按类型区分 claude 与 codex。
// 默认 `claude` / `codex`；可用 CLAUDE_BIN/CLAUDE_ARGS、CODEX_BIN/CODEX_ARGS 覆盖
// （测试时注入假的 CLI 可执行，避免依赖外部 CLI 行为与网络）。
// CLAUDE_ARGS 类似：空格分隔的额外参数（测试用 `node fake-claude.js` 时传脚本路径）。
// 各类型的 args 为"默认值，env 覆盖优先"：codex 未设 CODEX_ARGS 时默认 `-a never`。
// binResolved 在定义后统一填（见 resolveTerminalBin 下方）。
const TERMINAL_TYPES = {
  claude: {
    bin: process.env.CLAUDE_BIN || 'claude',
    args: process.env.CLAUDE_ARGS
      ? process.env.CLAUDE_ARGS.split(' ').filter(Boolean)
      : [],
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
const sessionSeqs = { claude: 0, codex: 0, cmd: 0, pi: 0 };

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

// 创建一个终端会话（claude / codex）：spawn 真 PTY，cwd = 宿主项目 projectPath。
function createTerminalSession(projectId, type) {
  const cfg = TERMINAL_TYPES[type];
  const p = getProject(projectId);
  if (!p) return { ok: false, msg: '项目不存在' };
  if (!pty) return { ok: false, msg: `node-pty 未加载，${type} 终端不可用` };
  if (!fs.existsSync(p.projectPath)) {
    return { ok: false, msg: '项目目录不存在: ' + p.projectPath };
  }

  const sessionId = newSessionId(type);
  const sessionNumber = allocSessionNumber(projectId, type);

  let term;
  try {
    // name: 'xterm-256color' 让 CLI 以为自己在 xterm，TUI 色彩/光标序列完整。
    // cwd 取宿主 projectPath；env 继承当前进程但剔除 IDE 注入变量（sanitizeTerminalEnv），
    // 使 claude/codex 子进程环境与"cmd 直接启动"一致（登录态、PATH 等照常继承）。
    term = pty.spawn(cfg.binResolved, cfg.args, {
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
    const parts = p.command.split(/\s+/);
    proc = spawn(parts[0], parts.slice(1), {
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
const staticOpts = { maxAge: '1d' };
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
  // 校验：ids 必须恰好覆盖现有全部项目，既不多也不少，避免静默丢项
  const known = ids.filter((id) => byId.has(id));
  if (known.length !== projects.length) {
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
      const m = noCommit ? { 1: noCommit[1] } : head.match(/^([^.\s]+)/);
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
// push 用 -u origin HEAD：不依赖 upstream 已设置，本地新建分支第一次推送即可成功，
// -u 顺带建立跟踪关系（已有 upstream 的分支行为等价，HEAD detached 时报错同裸 push）
registerGitNetworkRoute('push', ['push', '-u', 'origin', 'HEAD'], 'push');
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
// 同时附带远程分支列表（git branch -r，origin/xxx 原样），前端"新建分支"的起点下拉用；
// 无远端时 remote 为空数组。
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
  const rr = await runGit(p, ['branch', '-r', '--format=%(refname:short)']);
  const remote = rr.ok
    ? rr.stdout.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.endsWith('/HEAD'))
    : [];
  res.json({ ok: true, branches, current, remote });
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

// 远端 origin 的读取/设置：
// GET  remote-url  → { ok, url }（无 origin 时 url 为 null，非仓库走 notRepo）
// POST remote-set body { url } → 已有 origin 则 set-url，否则 add origin
// url 为任意字符串直接传给 git remote，不经 shell 无注入风险；凭证会明文存入 .git/config，前端弹窗有提示。
app.get('/api/projects/:id/git/remote-url', async (req, res) => {
  const p = getGitProject(req, res);
  if (!p) return;
  const r = await runGit(p, ['remote', 'get-url', 'origin']);
  if (r.ok) return res.json({ ok: true, url: r.stdout.trim() });
  if (/No such remote/i.test(r.msg)) return res.json({ ok: true, url: null });
  if (r.notRepo) return res.json({ ok: false, notRepo: true });
  res.json({ ok: false, msg: r.msg || '读取远端失败' });
});

app.post('/api/projects/:id/git/remote-set', async (req, res) => {
  const p = getGitProject(req, res);
  if (!p) return;
  const url = String((req.body && req.body.url) || '').trim();
  if (!url) return res.status(400).json({ ok: false, msg: '远端 URL 不能为空' });
  const cur = await runGit(p, ['remote', 'get-url', 'origin']);
  const r = cur.ok
    ? await runGit(p, ['remote', 'set-url', 'origin', url])
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
// 终端会话 REST API(claude / codex;会话仅运行时内存,不落盘)
// 两类型路由平行:/api/projects/:id/claude-sessions 与 .../codex-sessions,
// 同一套 handler 按类型参数化注册;sessionId 前缀已含类型,其余逻辑共用。
// ---------------------------------------------------------------------------
const SESSION_ROUTE_SUFFIX = { claude: 'claude-sessions', codex: 'codex-sessions', cmd: 'cmd-sessions', pi: 'pi-sessions' };
for (const type of ['claude', 'codex', 'cmd', 'pi']) {
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

  // 创建终端会话:cwd = 宿主项目 projectPath
  app.post(base, (req, res) => {
    const result = createTerminalSession(req.params.id, type);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  });

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
// 启动
// ---------------------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`启动器运行于 http://localhost:${PORT}`);
});
