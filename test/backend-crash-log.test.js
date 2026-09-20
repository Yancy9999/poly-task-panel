'use strict';
// 后端崩溃日志：全局兜底把未捕获异常/未处理的 Promise 拒绝落到 backend.log，
// 让"后端静默死掉、事后查无痕迹"的场景可事后归因。
// 用子进程跑 server.js 抛真实异常验证（node:test 运行器自己监听 uncaughtException，
// 进程内 process.emit 会被 runner 截获并把测试标记为失败，不能走那条路）。
// 覆盖：uncaughtException/unhandledRejection 写入 %LOCALAPPDATA%\PolyTaskPanel\backend.log
//       （ISO 时间戳 + 类型标注 + 堆栈）、多次错误按序追加不覆盖、出错后进程仍能服务请求。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('node:child_process');

const PORT = 7983;
const SERVER = path.resolve(__dirname, '..', 'server.js');

test('uncaughtException/unhandledRejection 落盘 backend.log，进程不退出', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ptp-crashlog-'));
  const backendLog = path.join(tmp, 'appdata', 'PolyTaskPanel', 'backend.log');
  const childJs = path.join(tmp, 'child.js');
  // 子进程：require server.js（注册兜底钩子）→ 依次抛未捕获异常 / 未处理拒绝 →
  // 最后请求自身 HTTP 接口证明进程还活着，输出 ALIVE 供父进程断言。
  fs.writeFileSync(childJs, [
    `process.env.PORT = '${PORT}';`,
    `require(${JSON.stringify(SERVER)});`,
    `setTimeout(() => { throw new Error('boom-uncaught'); }, 400);`,
    `setTimeout(() => { Promise.reject(new Error('boom-rejection')); }, 600);`,
    `setTimeout(() => { throw new Error('second-error'); }, 800);`,
    `setTimeout(async () => {`,
    `  const r = await fetch('http://localhost:${PORT}/api/projects');`,
    `  console.log('ALIVE ' + r.status);`,
    `  process.exit(0);`,
    `}, 1100);`,
  ].join('\n'));

  const out = await new Promise((resolve) => {
    execFile(process.execPath, [childJs], {
      cwd: path.dirname(SERVER),
      env: { ...process.env, LOCALAPPDATA: path.join(tmp, 'appdata') },
      timeout: 15000,
    }, (e, stdout, stderr) => resolve({ e, stdout, stderr }));
  });
  assert.match(out.stdout, /ALIVE 200/, `抛异常后进程仍服务请求（stderr: ${out.stderr && out.stderr.slice(0, 300)}）`);
  const log = fs.readFileSync(backendLog, 'utf8');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}

  assert.ok(/\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[uncaughtException\]/.test(log), 'uncaughtException 带 ISO 时间戳与类型标注');
  assert.ok(log.includes('boom-uncaught'), '包含错误消息');
  assert.ok(log.includes('child.js'), '包含堆栈');
  assert.ok(log.includes('[unhandledRejection]'), 'unhandledRejection 同样落盘');
  assert.ok(log.includes('boom-rejection'), '包含拒绝原因');
  const i1 = log.indexOf('boom-uncaught');
  const i2 = log.indexOf('boom-rejection');
  const i3 = log.indexOf('second-error');
  assert.ok(i1 !== -1 && i2 > i1 && i3 > i2, '多次错误按序追加不覆盖');
});
