/**
 * PasteDebug — 临时诊断日志：记录编辑器收到的每个输入事件，用于排查
 * cmd/conhost 等终端粘贴失败的真实输入流形态。
 *
 * 日志写入 .pi/extensions/paste-debug.log（每次编辑器创建时清空重写）。
 * 诊断完成后删除本文件并移除 paste-safe-editor.ts 中的引用。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const LOG_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "paste-debug.log",
);

export function initDebugLog(): void {
  try {
    fs.writeFileSync(LOG_PATH, `=== paste-debug ${new Date().toISOString()} ===\n`);
  } catch {
    // 忽略日志错误，不影响编辑器功能
  }
}

export function debugLog(line: string): void {
  try {
    fs.appendFileSync(LOG_PATH, line + "\n");
  } catch {
    // 忽略日志错误
  }
}
