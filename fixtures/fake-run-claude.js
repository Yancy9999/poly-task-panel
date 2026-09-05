#!/usr/bin/env node
// 假 claude 可执行：单轮 -p 任务执行链路测试用（非 PTY 交互会话）。
// 模拟真 `claude -p --output-format stream-json --verbose` 的行为：
//   1. 从 stdin 读 goal（server 以 stdin 传 goal）；
//   2. stdout 输出 stream-json：init 事件（含 session_id）→ assistant 文本 → result；
//   3. stderr 回显 argv（供测试断言 server spawn 的参数透传：--resume 等）；
//   4. 退出码：goal 含 "FAIL" 时非零退出，否则 0。
// 每次运行的 session_id 递增（fake-claude-session-N），验证捕获与 resume 传参。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// argv 回显到 stderr：测试经 output 回放读取（server 会把 stderr 并入任务输出）
process.stderr.write(`[fake-run-claude] argv=${process.argv.slice(2).join(" ")}\n`);

// session 计数器：放在临时目录下的共享文件，跨多次 spawn 递增
const counterFile = path.join(os.tmpdir(), 'fake-run-claude-counter');
let n = 0;
try { n = parseInt(fs.readFileSync(counterFile, 'utf8'), 10) || 0; } catch (e) {}
n += 1;
fs.writeFileSync(counterFile, String(n));
const sessionId = `fake-claude-session-${n}`;

let goal = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (goal += c));
process.stdin.on('end', () => {
  goal = goal.trim();
  // stream-json 输出：首行 init（server 从这里捕获 session_id），再一行 assistant 文本，再 result
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }) + '\n');
  process.stdout.write(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: `FAKE-RUN-CLAUDE-OUTPUT goal=${goal}` }] },
  }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: goal }) + '\n');
  if (goal.includes('FAIL')) process.exit(3);
  process.exit(0);
});
