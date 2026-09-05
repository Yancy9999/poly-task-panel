#!/usr/bin/env node
// 假 pi 可执行：单轮任务执行链路测试用（非 PTY 交互会话）。
// 模拟真 `pi -p --mode json` 的行为：
//   1. 从 stdin 读 goal（server 以 stdin 传 goal）；
//   2. stdout 输出 JSONL：session 事件（含 id）→ message_end（assistant 文本）；
//   3. stderr 回显 argv（供测试断言 --session 等参数透传）；
//   4. 退出码：goal 含 "FAIL" 时非零退出，否则 0。
'use strict';

const counterFile = require('path').join(require('os').tmpdir(), 'fake-run-pi-counter');
let n = 0;
try { n = parseInt(require('fs').readFileSync(counterFile, 'utf8'), 10) || 0; } catch (e) {}
n += 1;
require('fs').writeFileSync(counterFile, String(n));
const sessionId = `fake-pi-session-${n}`;

process.stderr.write(`[fake-run-pi] argv=${process.argv.slice(2).join(" ")}\n`);

let goal = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (goal += c));
process.stdin.on('end', () => {
  goal = goal.trim();
  process.stdout.write(JSON.stringify({ type: 'session', version: 3, id: sessionId }) + '\n');
  process.stdout.write(JSON.stringify({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: `FAKE-RUN-PI-OUTPUT goal=${goal}` }] },
  }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\n');
  if (goal.includes('FAIL')) process.exit(5);
  process.exit(0);
});
