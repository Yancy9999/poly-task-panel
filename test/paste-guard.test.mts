/**
 * PasteGuard 判定逻辑单元测试。
 *
 * 模拟时间戳序列（毫秒）模拟输入流：
 *  - 相邻事件间隔 < rapidMs(10) 视为粘贴（快速输入）
 *  - 间隔 >= rapidMs 视为手动按键
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PasteGuard } from "../.pi/extensions/lib/paste-guard.mts";

interface Ev {
  t: number; // 时间戳
  submit: boolean; // 是否 submit 触发
  data: string;
}

/** 按事件序列驱动 PasteGuard，记录插入的换行次数与挂起状态 */
function drive(events: Ev[], opts?: { rapidMs?: number; crlfMs?: number }) {
  const guard = new PasteGuard(opts?.rapidMs ?? 10, opts?.crlfMs ?? 5);
  const newlines: string[] = [];
  const pendings: string[] = [];
  for (const e of events) {
    const action = guard.classify(e.t, e.submit, e.data, {
      newline: (trigger) => newlines.push(trigger),
    });
    if (action === "pending") {
      pendings.push(e.data);
      // 窗口内新输入到达时，下一次 classify 会自动消费挂起（转成换行）；
      // 序列结束后仍挂起的，由调用方在窗口超时后执行提交。
    }
  }
  // 序列末尾仍挂起的 enter → 模拟调用方窗口超时后提交（手动 Enter 场景）
  const timedOut = guard.pendingTrigger;
  guard.pendingTrigger = null;
  return { guard, newlines, pendings, timedOut };
}

test("多行粘贴：换行不触发提交，转为换行符", () => {
  const { newlines, pendings } = drive([
    { t: 1000, submit: false, data: "a" },
    { t: 1001, submit: true, data: "\r" }, // 紧跟快速输入 → 粘贴换行
    { t: 1002, submit: false, data: "b" },
    { t: 1003, submit: true, data: "\r" },
    { t: 1004, submit: false, data: "c" },
  ]);
  assert.deepEqual(newlines, ["\r", "\r"]);
  assert.deepEqual(pendings, []); // 不应有任何提交
});

test("\\r\\n 行尾对只插入一个换行", () => {
  const { newlines, pendings } = drive([
    { t: 1000, submit: false, data: "a" },
    { t: 1001, submit: true, data: "\r" },
    { t: 1002, submit: true, data: "\n" }, // 紧跟 \r → 忽略
    { t: 1003, submit: false, data: "b" },
  ]);
  assert.deepEqual(newlines, ["\r"]);
  assert.deepEqual(pendings, []);
});

test("Unix 粘贴（纯 \\n 行尾）逐个换行，不误判为 \\r\\n 对", () => {
  const { newlines, pendings } = drive([
    { t: 1000, submit: false, data: "a" },
    { t: 1001, submit: true, data: "\n" },
    { t: 1002, submit: true, data: "\n" }, // 第二个 \n 不能因 convertedCrAt 被忽略
    { t: 1003, submit: false, data: "b" },
  ]);
  assert.deepEqual(newlines, ["\n", "\n"]);
  assert.deepEqual(pendings, []);
});

test("手动按 Enter：前面无快速输入 → 挂起后提交", () => {
  const { newlines, pendings, timedOut } = drive([
    { t: 1000, submit: false, data: "h" },
    { t: 1100, submit: true, data: "\r" }, // 间隔 100ms → 手动
  ]);
  assert.deepEqual(newlines, []);
  assert.deepEqual(pendings, ["\r"]);
  assert.equal(timedOut, "\r"); // 窗口超时 → 真正提交
});

test("粘贴以换行开头：孤立 \\r 挂起，后续字符到达转成换行", () => {
  const { newlines, pendings, timedOut } = drive([
    { t: 1000, submit: true, data: "\r" }, // 开头孤立 → 挂起
    { t: 1001, submit: false, data: "x" }, // 快速到达 → 消费挂起转成换行
  ]);
  assert.deepEqual(newlines, ["\r"]);
  assert.deepEqual(pendings, ["\r"]); // 先挂起，后被消费转成换行（未提交）
  assert.equal(timedOut, null); // 窗口未超时 → 不提交
});

test("连续两个换行 a\\r\\rb：都转为换行", () => {
  const { newlines, pendings } = drive([
    { t: 1000, submit: false, data: "a" },
    { t: 1001, submit: true, data: "\r" },
    { t: 1002, submit: true, data: "\r" },
    { t: 1003, submit: false, data: "b" },
  ]);
  assert.deepEqual(newlines, ["\r", "\r"]);
  assert.deepEqual(pendings, []);
});

test("正常慢速打字后回车不会误判（间隔 50ms）", () => {
  const { newlines, pendings, timedOut } = drive([
    { t: 1000, submit: false, data: "a" },
    { t: 1050, submit: false, data: "b" },
    { t: 1100, submit: true, data: "\r" },
  ]);
  assert.deepEqual(newlines, []);
  assert.deepEqual(pendings, ["\r"]);
  assert.equal(timedOut, "\r");
});

test("自定义 rapidMs：粘贴字符间隔 20ms 时仍判为快速输入", () => {
  const { newlines, pendings } = drive(
    [
      { t: 1000, submit: false, data: "a" },
      { t: 1020, submit: true, data: "\r" }, // 间隔 20ms < rapidMs(30)
      { t: 1040, submit: false, data: "b" },
    ],
    { rapidMs: 30 },
  );
  assert.deepEqual(newlines, ["\r"]);
  assert.deepEqual(pendings, []);
});
