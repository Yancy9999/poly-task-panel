/**
 * Paste-safe editor — 防止粘贴多行提示词时换行触发 submit（直接发送）。
 *
 * 背景：
 *   pi 依赖终端的 bracketed paste mode（\x1b[?2004h / \x1b[200~...\x1b[201~）
 *   来区分"粘贴的换行"和"手动按 Enter"。但部分终端（如 Git Bash/mintty、
 *   cmd/PowerShell conhost 等）不支持或未启用 bracketed paste，粘贴时会把
 *   原始字符流直接送入 stdin。此时 stdin 缓冲把每个非转义字符单独发出，
 *   粘贴文本里的每个 \r 都被当成一次 Enter（tui.input.submit）→ 提示词
 *   在第一行就被发送。
 *
 * 方案（不改动 pi 源码，项目级扩展）：
 *   用 PasteGuard（时间窗口启发式）区分"粘贴中的换行"与"手动 Enter"：
 *   - 紧跟快速输入（< 10ms）到达的 enter → 粘贴换行：插入换行符并吞掉
 *     原输入，绝不转发（旧版把 \r 转发给编辑器，导致换行后仍被提交）；
 *   - 孤立的 enter → 挂起 30ms：期间任何新输入到达即取消挂起（说明是
 *     粘贴，挂起 enter 转成换行）；窗口内无输入才真正提交；
 *   - \r\n 行尾对只插入一个换行。
 *   粘贴字符到达间隔是亚毫秒级，人手按键间隔 > 40ms，阈值不会误伤正常打字。
 *
 * 安装：放入 .pi/extensions/ 自动发现，pi 内 /reload 生效。
 *
 * 临时调试：默认把每个输入事件写入 .pi/extensions/paste-debug.log
 * （见 lib/paste-debug.mts），诊断完成后移除。
 */
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PasteGuard } from "./lib/paste-guard.mts";
import { debugLog, initDebugLog } from "./lib/paste-debug.mts";

/** 孤立 enter 的等待窗口(ms)：超过该时间无新输入则视为手动提交 */
const SUBMIT_WAIT_MS = 30;

export class PasteSafeEditor extends CustomEditor {
  private guard = new PasteGuard();
  private submitTimer: ReturnType<typeof setTimeout> | null = null;
  private lastLogTime = 0;

  constructor(
    tui: any,
    theme: any,
    keybindings: any,
    options?: Record<string, unknown>,
  ) {
    super(tui, theme, options);
    initDebugLog();
    debugLog(`[editor] constructed`);
  }

  override handleInput(data: string): void {
    const now = Date.now();
    const isSubmit = this.keybindings.matches(data, "tui.input.submit");
    debugLog(
      `input t=${now} gap=${this.lastLogTime ? now - this.lastLogTime : "-"} ` +
        `rapidGap=${now - this.guard.lastInputTime} ` +
        `data=${JSON.stringify(data)} isSubmit=${isSubmit} ` +
        `pending=${JSON.stringify(this.guard.pendingTrigger)} ` +
        `timer=${this.submitTimer !== null}`,
    );
    this.lastLogTime = now;

    // 任何新输入到达都证明之前挂起的 enter 是粘贴的一部分 → 取消挂起提交
    if (this.submitTimer !== null) {
      this.clearSubmitTimer();
      debugLog(`  [timer] cancelled`);
    }

    const action = this.guard.classify(now, isSubmit, data, {
      newline: () => this.addNewLine(),
    });
    debugLog(`  -> action=${action}`);

    switch (action) {
      case "pending": {
        // 孤立 enter → 挂起等待窗口，确认不是粘贴
        this.submitTimer = setTimeout(() => {
          this.submitTimer = null;
          // 窗口内无后续输入（挂起 enter 未被消费）→ 真正提交
          if (this.guard.pendingTrigger === data) {
            this.guard.pendingTrigger = null;
            debugLog(`  [timer] fired -> submit`);
            super.handleInput(data);
          }
        }, SUBMIT_WAIT_MS);
        return;
      }
      case "swallow":
        // 粘贴换行已通过 newline 回调插入（或 \r\n 的 \n 后半段）→ 丢弃原输入
        return;
      case "pass":
        // 正常转发（含 bracketed paste 整块、普通字符、控制序列等）
        super.handleInput(data);
        return;
    }
  }

  private clearSubmitTimer(): void {
    if (this.submitTimer !== null) {
      clearTimeout(this.submitTimer);
      this.submitTimer = null;
    }
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, keybindings) => new PasteSafeEditor(tui, theme, keybindings));
  });
}
