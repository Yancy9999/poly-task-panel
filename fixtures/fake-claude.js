#!/usr/bin/env node
// 假 claude 可执行：替代真 claude CLI 供契约测试使用。
// 行为：
//   1. 断言自身是 TTY（claude 会检测 isatty；若不是 TTY 说明 PTY 没起对），
//      把检测结果写到 stderr 让测试可观察。
//   2. 回显 stdin：收到一行就把 "ECHO: <line>" 写回 stdout，便于测试断言输出流。
//   3. 读到 "EXIT <code>" 时以该退出码退出，模拟用户 /exit 或 claude 崩溃。
// 不依赖外部 CLI 行为与网络。
'use strict';

const isTty = process.stdin.isTTY;
process.stderr.write(`[fake-claude] isatty=${isTty}\n`);
process.stdout.write(`[fake-claude] ready cwd=${process.cwd()}\n`);

// 报告子进程收到的 IDE 注入标记与关键正常变量，供契约测试断言
// server 已按 sanitizeTerminalEnv 净化 env（与"cmd 里直接启动 claude"一致）。
const IDE_PREFIXES = ['CLAUDE_CODE_', 'CLAUDE_', 'VSCODE_'];
const IDE_EXACT = ['CLAUDECODE', 'AI_AGENT', 'TRACEPARENT', 'TRACESTATE'];
const ideKeys = Object.keys(process.env).filter(
  (k) => IDE_PREFIXES.some((p) => k.startsWith(p)) || IDE_EXACT.includes(k)
);
process.stderr.write(`[fake-claude] env-ide-keys=${JSON.stringify(ideKeys)}\n`);
process.stderr.write(`[fake-claude] env-keep-var=${process.env.TEST_KEEP_VAR || ''}\n`);
process.stderr.write(`[fake-claude] env-has-path=${process.env.PATH ? 'yes' : 'no'}\n`);
// 报告自身完整 argv：供契约测试断言 server spawn 时的参数透传链路（如默认跳权限
// 参数与 CLAUDE_ARGS 覆盖语义）。报全量 argv，测试自行断言关心的元素。
process.stderr.write(`[fake-claude] argv=${JSON.stringify(process.argv)}\n`);

// 关键：ConPTY 下 node 的 TTY stdin 在默认 cooked 模式不会触发 'data' 事件。
// 真正的交互式 TUI（含真 claude CLI）都会把终端设为 raw 模式读键；
// 这里 setRawMode(true) 让 stdin 真正流动起来，模拟真 CLI 的读取行为。
if (isTty && process.stdin.setRawMode) {
  try { process.stdin.setRawMode(true); } catch (e) {}
}
process.stdin.setEncoding('utf8');
process.stdin.resume();

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).replace(/\r$/, '');
    buf = buf.slice(nl + 1);
    if (line.startsWith('EXIT ')) {
      const code = parseInt(line.slice(5), 10);
      process.exit(isNaN(code) ? 0 : code);
    }
    process.stdout.write(`ECHO: ${line}\n`);
  }
});

process.stdin.on('end', () => process.exit(0));
