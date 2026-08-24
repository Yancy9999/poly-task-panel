/**
 * PasteGuard — 粘贴换行 vs 手动 Enter 的判定状态机（纯逻辑，无 pi 依赖）。
 *
 * 问题：终端不支持 bracketed paste 时，粘贴的多行文本会以原始字符流进入
 * stdin，每个 \r 被拆成独立的 enter 事件，从而触发 submit。
 *
 * 判定规则（时间窗口启发式）：
 *  - 紧跟快速输入（< rapidMs）到达的 enter → 粘贴中的换行 → newline
 *  - 孤立的 enter（前面没有快速输入）→ 挂起 pending，由调用方等待一个
 *    窗口；窗口内若有新输入到达则把挂起 enter 转成换行，否则真正提交
 *  - \r\n 行尾对只插入一个换行（\n 被忽略）
 *
 * 粘贴字符到达间隔是亚毫秒级，人手按键间隔 > 40ms，阈值不会误伤正常打字。
 */
export type PasteGuardAction = "pass" | "pending";

export interface PasteActions {
  /** 插入一个换行符（粘贴中的换行），trigger 为触发换行的原始输入 */
  newline(trigger: string): void;
}

export class PasteGuard {
  /** 上次 pass/newline 输入的时间戳 */
  lastInputTime = 0;
  /** 挂起的 enter 原始数据（等待确认是否提交） */
  pendingTrigger: string | null = null;
  /** 上次把 \r 转成换行的时间戳，用于识别 \r\n 行尾对 */
  convertedCrAt = 0;

  readonly rapidMs: number;
  readonly crlfMs: number;

  constructor(rapidMs = 10, crlfMs = 5) {
    this.rapidMs = rapidMs;
    this.crlfMs = crlfMs;
  }

  /**
   * @param now       当前时间戳（毫秒）
   * @param isSubmit  本次输入是否命中 submit 键
   * @param data      输入原始数据（用于 \r\n 行尾对识别）
   * @param actions   换行插入回调（可能被调用 0/1 次）
   * @returns
   *   - "pass"    正常处理当前输入（调用方原样转发；粘贴换行已通过 actions 插入）
   *   - "pending" 挂起等待：调用方应在窗口内等待；若期间又有输入到达，
   *               再次调用 classify() 会自动把挂起 enter 转成换行，
   *               否则窗口结束后调用方执行真正提交
   */
  classify(now: number, isSubmit: boolean, data: string, actions: PasteActions): PasteGuardAction {
    // 1) 消费挂起：又有输入到达 → 之前那个 enter 是粘贴的一部分，转成换行
    if (this.pendingTrigger !== null) {
      const pending = this.pendingTrigger;
      this.pendingTrigger = null;
      this.applyNewline(now, pending, actions);
    }

    // 2) submit 触发
    if (isSubmit) {
      // 紧跟快速输入 → 粘贴中的换行
      if (now - this.lastInputTime < this.rapidMs) {
        this.applyNewline(now, data, actions);
        return "pass";
      }
      // 孤立 enter → 挂起
      this.pendingTrigger = data;
      return "pending";
    }

    // 3) 普通输入
    this.lastInputTime = now;
    return "pass";
  }

  private applyNewline(now: number, trigger: string, actions: PasteActions): void {
    // \r 已转成换行，紧跟的 \n 属于同一个行尾对 → 忽略
    if (trigger === "\n" && now - this.convertedCrAt < this.crlfMs) {
      this.lastInputTime = now;
      return;
    }
    this.lastInputTime = now;
    // 只有 \r 会构成 \r\n 行尾对；\n、kitty CSI-u enter 等不标记
    this.convertedCrAt = trigger === "\r" ? now : 0;
    actions.newline(trigger);
  }
}
