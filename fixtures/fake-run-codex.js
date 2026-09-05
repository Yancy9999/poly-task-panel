#!/usr/bin/env node
// 假 codex 可执行：单轮任务执行链路测试用（非 PTY 交互会话）。
// 模拟真 `codex exec --json` 的行为：
//   1. 从 stdin 读 goal（server 以 stdin + "-" 占位传 goal）；
//   2. stdout 输出 JSONL：thread.started（含 thread_id）→ item.completed（assistant 文本）；
//   3. stderr 回显 argv（供测试断言 exec resume 等参数透传）；
//   4. 退出码：goal 含 "FAIL" 时非零退出，否则 0。
'use strict';

const counterFile = require('path').join(require('os').tmpdir(), 'fake-run-codex-counter');
let n = 0;
try { n = parseInt(require('fs').readFileSync(counterFile, 'utf8'), 10) || 0; } catch (e) {}
n += 1;
require('fs').writeFileSync(counterFile, String(n));
const threadId = `fake-codex-thread-${n}`;

process.stderr.write(`[fake-run-codex] argv=${process.argv.slice(2).join(" ")}\n`);

let goal = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (goal += c));
process.stdin.on('end', () => {
  goal = goal.trim();
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: threadId }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'turn.started' }) + '\n');
  process.stdout.write(JSON.stringify({
    type: 'item.completed',
    item: { id: 'item_0', type: 'agent_message', text: `FAKE-RUN-CODEX-OUTPUT goal=${goal}` },
  }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: {} }) + '\n');
  if (goal.includes('FAIL')) process.exit(4);
  process.exit(0);
});
