/**
 * PasteGuard — 粘贴换行 vs 手动 Enter 的判定状态机（纯逻辑，无 pi 依赖）。
 *
 * 问题：终端不支持 bracketed paste 时，粘贴的多行文本会以原始字符流进入
 * stdin，每个行尾 \r 被拆成独立的 enter 事件，从而触发 submit。
 *
 * 判定规则（时间窗口启发式）：
 *  - 紧跟快速输入（< rapidMs）到达的 enter → 粘贴中的换行 → 转成 newline，
 *    返回 "swallow"（调用方必须丢弃原输入，否则 \r 会再次触发 submit）
 *  - 孤立的 enter（前面没有快速输入）→ 返回 "pending"，由调用方挂起等待；
 *    窗口内若有新输入到达，下次 classify() 自动把挂起 enter 转成换行；
 *    窗口结束仍无输入，调用方才真正提交
 *  - \r\n 行尾对只插入一个换行（紧跟被转换过的 \r 的 \n 会被吞掉）
 *
 * 粘贴字符到达间隔是亚毫秒级，人手按键间隔 > 40ms，阈值不会误伤正常打字。
 */
export type PasteGuardAction = "pass" | "pending" | "swallow";

export interface PasteActions {
  /** 插入一个换行符（粘贴中的换行），trigger 为触发换行的原始输入 */
  newline(trigger: string): void;
}

export class PasteGuard {
  /** 上次 pass/newline 输入的时间戳 */
  lastInputTime = 0;
  /** 挂起的 enter 原始数据（等待确认是否提交）；被消费后为 null */
  pendingTrigger: string | null = null;
  /** 上次把 \r 转成换行的时间戳，用于识别 \r\n 行尾对（0 = 无） */
  convertedCrAt = 0;

  readonly rapidMs: number;
  readonly crlfMs: number;

  constructor(rapidMs = 10, crlfMs = 10) {
    this.rapidMs = rapidMs;
    this.crlfMs = crlfMs;
  }

  /**
   * @param now       当前时间戳（毫秒）
   * @param isSubmit  本次输入是否命中 submit 键
   * @param data      输入原始数据（用于 \r\n 行尾对识别）
   * @param actions   换行插入回调（可能被调用 0/1 次）
   * @returns
   *   - "pass"    正常处理当前输入（调用方原样转发）
   *   - "pending" 挂起等待：调用方应启动定时器；若期间又有输入到达，本方法
   *               会随下次调用自动把挂起 enter 转成换行；窗口结束后无输入
   *               则调用方执行真正提交
   *   - "swallow" 当前输入已被消费（粘贴换行，或 \r\n 的 \n 后半段），
   *               调用方必须丢弃该输入、不得转发
   */
  classify(now: number, isSubmit: boolean, data: string, actions: PasteActions): PasteGuardAction {
    // 1) 消费挂起：又有输入到达 → 之前那个 enter 是粘贴的一部分，转成换行
    if (this.pendingTrigger !== null) {
      const pending = this.pendingTrigger;
      this.pendingTrigger = null;
      this.applyNewline(now, pending, actions);
      // \r\n 行尾对：刚把挂起的 \r 转成换行，紧跟的 \n 属于同一行尾对 → 吞掉
      if (data === "\n" && this.convertedCrAt !== 0 && now - this.convertedCrAt < this.crlfMs) {
        this.lastInputTime = now;
        return "swallow";
      }
    } else if (data === "\n" && this.convertedCrAt !== 0 && now - this.convertedCrAt < this.crlfMs) {
      // 快速路径：\r 已被转成换行，紧跟的 \n 是同一行尾对 → 吞掉
      this.lastInputTime = now;
      return "swallow";
    }

    // 2) submit 触发
    if (isSubmit) {
      // 紧跟快速输入 → 粘贴中的换行
      if (now - this.lastInputTime < this.rapidMs) {
        this.applyNewline(now, data, actions);
        return "swallow";
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
    if (trigger === "\n" && this.convertedCrAt !== 0 && now - this.convertedCrAt < this.crlfMs) {
      this.lastInputTime = now;
      return;
    }
    this.lastInputTime = now;
    // 只有 \r 会构成 \r\n 行尾对；\n、kitty CSI-u enter 等不标记
    this.convertedCrAt = trigger === "\r" ? now : 0;
    actions.newline(trigger);
  }
}
