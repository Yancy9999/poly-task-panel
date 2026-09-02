'use strict';
// 项目生命周期（start/stop/restart）与日志系统测试（进程内 require server.js）。
// 覆盖：
//   start：node 项目真起子进程（echo 类命令快速退出也可）、folder 400、不存在 404、
//          重复 start 400、running 徽标（GET /api/projects 的 running/pid 字段）；
//   stop：未运行 ok:true「未在运行」、运行中停止后 running=false；
//   restart：stop→start 复合路径（进程退出后 start 仍成功）；
//   日志：appendLog→flush 定时落盘（/logs 条目结构 {ts,line}）、大文件 readLogHistory
//        只读尾部 256KB（条目行数按 64KB 块切）、clear-logs 截断 + 排队写入失效（epoch）、
//        maybeRotateLog 轮转（>5MB 裁到尾部 256KB）。
// 注：flushPendingLogs 定时器 200ms/次；轮转检查每 50 次 flush 才 stat 一次，
//     轮转用例直接驱动多次 flush 等待累计（总时长约 50*200ms=10s，可接受）。
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execSync } = require('node:child_process');

let srv = null;
let tmpDir, projectsFile, nodeDir;
const PORT = 7979;
const LOGS_DIR = () => path.join(process.env.__PTP_TMPDIR__, 'appdata', 'PolyTaskPanel', 'projects');
const logPathOf = (id) => path.join(LOGS_DIR(), `${id}.log`);

before(() => {
  const origCreate = http.createServer;
  http.createServer = (...a) => { srv = origCreate.apply(http, a); return srv; };

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptp-life-'));
  nodeDir = path.join(tmpDir, 'node-proj');
  fs.mkdirSync(nodeDir, { recursive: true });

  projectsFile = path.join(tmpDir, 'projects.json');
  fs.writeFileSync(projectsFile, JSON.stringify([], null, 2));
  process.env.PORT = String(PORT);
  process.env.PROJECTS_FILE = projectsFile;
  process.env.SETTINGS_FILE = path.join(tmpDir, 'settings.json');
  process.env.LOCALAPPDATA = path.join(tmpDir, 'appdata'); // bat/log 隔离
  process.env.__PTP_TMPDIR__ = tmpDir;

  require('../server.js');
});

after(async () => {
  if (srv && srv.listening) await new Promise((r) => srv.close(r));
  const tmp = process.env.__PTP_TMPDIR__;
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

function request(method, queryPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      host: 'localhost', port: PORT, path: queryPath, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    };
    const req = http.request(opts, (res) => {
      let raw = '';
      res.on('data', (d) => (raw += d));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw || '{}') }); }
        catch (e) { resolve({ status: res.statusCode, raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const get = (p) => request('GET', p);
const post = (p, b) => request('POST', p, b);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function createNodeProject(command, name) {
  const r = await post('/api/projects', { name: name || 'life-node', projectPath: nodeDir, type: 'node', command });
  assert.equal(r.body.ok, true);
  return r.body.project.id;
}

const runningProjects = []; // 测试创建的项目，after 已随 tmpDir 清理；进程由 stopAllOnExit 兜底

// ---- start ----

test('start：node 项目真起进程，running/pid 徽标翻转，日志含启动行', async () => {
  const id = await createNodeProject('node -e "setTimeout(()=>{},8000)"');
  runningProjects.push(id);
  const r = await post(`/api/projects/${id}/start`);
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.ok(r.body.pid > 0);
  // 列表徽标
  const list = await get('/api/projects');
  const p = list.body.find((x) => x.id === id);
  assert.equal(p.running, true);
  assert.equal(p.pid, r.body.pid);
  // 启动日志行：appendLog → pendingFlush → 定时 flush 落盘（200ms 窗口）
  await wait(600);
  const logs = await get(`/api/projects/${id}/logs`);
  assert.equal(logs.body.ok, true);
  const joined = logs.body.entries.map((e) => e.line).join('');
  assert.match(joined, /\[启动器\] 启动进程 PID \d+/, '日志含启动行');
  assert.ok(logs.body.entries.every((e) => typeof e.ts === 'number'), 'entries 结构 {ts,line}');
  // 磁盘文件已落盘
  assert.ok(fs.existsSync(logPathOf(id)), 'start.log 已落盘');
});

test('start：folder 类型 400（不支持启动）；项目不存在 404', async () => {
  const fr = await post('/api/projects', { name: 'f', projectPath: nodeDir, type: 'folder' });
  const fid = fr.body.project.id;
  const r = await post(`/api/projects/${fid}/start`);
  assert.equal(r.status, 200); // startProject 返回 {ok:false} 经 res.json 200
  assert.equal(r.body.ok, false);
  assert.match(r.body.msg, /Folder/);
  const r404 = await post('/api/projects/p_none/start');
  assert.equal(r404.status, 200);
  assert.equal(r404.body.ok, false);
});

test('start：重复 start 400 语义（ok:false 项目已在运行）', async () => {
  const id = await createNodeProject('node -e "setTimeout(()=>{},8000)"');
  runningProjects.push(id);
  const r1 = await post(`/api/projects/${id}/start`);
  assert.equal(r1.body.ok, true);
  const r2 = await post(`/api/projects/${id}/start`);
  assert.equal(r2.body.ok, false);
  assert.match(r2.body.msg, /已在运行/);
});

// ---- stop ----

test('stop：未在运行返回 ok:true「未在运行」', async () => {
  const id = await createNodeProject('node -e "setTimeout(()=>{},8000)"');
  const r = await post(`/api/projects/${id}/stop`);
  assert.equal(r.body.ok, true);
  assert.match(r.body.msg, /未在运行/);
});

test('stop：运行中停止后 running=false、日志含停止行', async () => {
  const id = await createNodeProject('node -e "setTimeout(()=>{},8000)"');
  runningProjects.push(id);
  await post(`/api/projects/${id}/start`);
  await wait(300);
  const r = await post(`/api/projects/${id}/stop`);
  assert.equal(r.body.ok, true);
  assert.match(r.body.msg, /已停止/);
  const list = await get('/api/projects');
  assert.equal(list.body.find((x) => x.id === id).running, false);
  await wait(600);
  const logs = await get(`/api/projects/${id}/logs`);
  assert.match(logs.body.entries.map((e) => e.line).join(''), /进程已停止/, '日志含停止行');
});

// ---- restart ----

test('restart：stop→start 复合路径成功（返回新 pid）', async () => {
  const id = await createNodeProject('node -e "setTimeout(()=>{},8000)"');
  runningProjects.push(id);
  const r1 = await post(`/api/projects/${id}/start`);
  assert.equal(r1.body.ok, true);
  const r2 = await post(`/api/projects/${id}/restart`);
  assert.equal(r2.body.ok, true, JSON.stringify(r2.body));
  assert.ok(r2.body.pid > 0);
  assert.notEqual(r2.body.pid, r1.body.pid, 'restart 起的是新进程');
});

// ---- 日志系统 ----

test('readLogHistory：大文件只读尾部 256KB（64KB 块切分）', async () => {
  const id = await createNodeProject('node -e "setTimeout(()=>{},8000)"');
  // 直接构造 >256KB 的日志文件（绕过 start，避免依赖进程输出时序）
  const big = 'x'.repeat(300 * 1024) + '\n';
  fs.writeFileSync(logPathOf(id), big);
  const logs = await get(`/api/projects/${id}/logs`);
  assert.equal(logs.body.ok, true);
  const total = logs.body.entries.reduce((n, e) => n + e.line.length, 0);
  assert.equal(total, 256 * 1024, '只读尾部 256KB');
  // 300KB = 4.8 个 64KB 块 → 尾部 256KB 按 64KB 切正好 4 块
  assert.equal(logs.body.entries.length, 4, '按 64KB 块切分');
  assert.ok(logs.body.entries.every((e) => e.line.length <= 65536));
});

test('clear-logs：截断文件 + 排队中的旧写入失效（epoch）', async () => {
  const id = await createNodeProject('node -e "setTimeout(()=>{},8000)"');
  await post(`/api/projects/${id}/start`);
  await wait(600); // 产生启动日志并落盘
  const before = await get(`/api/projects/${id}/logs`);
  assert.ok(before.body.entries.length > 0, '清空前有日志');
  const cleared = await post(`/api/projects/${id}/clear-logs`);
  assert.equal(cleared.body.ok, true);
  // 清空后立即读：文件被截断为空（epoch 使排队中的旧 flush 失效）
  const after = await get(`/api/projects/${id}/logs`);
  assert.equal(after.body.entries.length, 0, '清空后日志为空');
  // 再等一个 flush 周期确认旧内容不会「又回来」
  await wait(500);
  const after2 = await get(`/api/projects/${id}/logs`);
  assert.equal(after2.body.entries.length, 0, '排队中的旧写入未回流');
});

test('maybeRotateLog：日志超 5MB 裁到尾部 256KB', async () => {
  // 直写 6MB 日志文件，然后靠 flushPendingLogs 的轮转检查路径触发裁剪：
  // 每 50 次 flush 才 stat 一次 → 需要 50 个 200ms 周期 ≈ 10s。
  // 为不拖慢用例，改为 appendLog 制造 pendingFlush 后短轮询等待轮转发生（上限 15s）。
  const id = await createNodeProject('node -e "setTimeout(()=>{},8000)"');
  fs.writeFileSync(logPathOf(id), Buffer.alloc(6 * 1024 * 1024, 0x61)); // 6MB 'a'
  // 让 flush 路径跑起来：发一条日志（进入 pendingFlush，下个定时器周期 flush 并计数）
  await post(`/api/projects/${id}/start`);
  const deadline = Date.now() + 15000;
  let size = 6 * 1024 * 1024;
  while (Date.now() < deadline) {
    await wait(500);
    try { size = fs.statSync(logPathOf(id)).size; } catch (e) {}
    if (size <= 256 * 1024) break;
  }
  assert.ok(size <= 256 * 1024, `轮转后文件应 ≤256KB（实际 ${size}）`);
});
