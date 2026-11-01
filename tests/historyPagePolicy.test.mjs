import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const load = createTsSandbox();
const policy = load("src/renderer/src/components/session/timeline/historyPagePolicy.ts");

const user = { role: "user" };
const assistant = { role: "assistant" };
/** 造 n 轮「user + assistant」，与主进程按 turn 起点计数的口径一致。 */
function turns(n) {
	const out = [];
	for (let i = 0; i < n; i += 1) out.push(user, assistant);
	return out;
}

test("按钮翻页取 host 上限 10 轮，不是旧的 3 轮", () => {
	// 回归靶子：改回 3 时这条必红（真机症状「点一次只多一屏不到」）。
	assert.equal(policy.HISTORY_TURN_PAGE_SIZE, 10);
	assert.equal(policy.resolveHistoryPageSize("button"), 10);
});

test("滚动仍走 3 轮小步，跳转补页取满 10", () => {
	// 滚动是连续事件：一次 10 轮会把视口顶出去，所以按钮的 10 不能顺手给滚动用。
	assert.equal(policy.resolveHistoryPageSize("scroll"), 3);
	assert.notEqual(policy.resolveHistoryPageSize("scroll"), policy.resolveHistoryPageSize("button"));
});

test("跳转补页（backfill）取 host 上限 10，不是旧的 3", () => {
	// 回归靶子：改回 3 时这条必红。
	// 真机症状：147 轮会话点最上面的刻度，一根刻度背后差几十轮，每次只补 3 轮，
	// 用户要点十几次才落地（2026-11 反馈「右边跳转根本没用 / 要点很多次」）。
	// backfill 只有跳转这一个用途 —— 两个调用方都是刻度/pendingJump 补页，
	// 没有「后台连续回填」那种调用方了。
	assert.equal(policy.HISTORY_BACKFILL_TURN_PAGE_SIZE, 10);
	assert.equal(policy.resolveHistoryPageSize("backfill"), 10);
});

test("窗口增长按页内实际轮数放，不再被钳到 3 轮", () => {
	// 页里带了 20 轮，窗口必须能开 10（不超过页大小），而不是旧的恒 ≤3。
	assert.equal(policy.resolvePageWindowGrowth(turns(20), 10), 10);
	assert.equal(policy.resolvePageWindowGrowth(turns(7), 10), 7);
});

test("窗口增长不超过页大小：数据只有 2 轮时不多开空窗口", () => {
	assert.equal(policy.resolvePageWindowGrowth(turns(2), 10), 2);
	assert.equal(policy.resolvePageWindowGrowth(turns(2), 3), 2);
});

test("空页不扩窗（0 轮）", () => {
	assert.equal(policy.resolvePageWindowGrowth([], 10), 0);
});

test("页非空但不由 user 开头时仍至少开 1 轮", () => {
	// disk 消息页可能在长回答中间切断：整页没有 user 消息，turn 计数为 0。
	// 若这里返回 0，新加载的轮会被尾部窗口裁掉——数据已加载但看不见。
	assert.equal(policy.resolvePageWindowGrowth([assistant, assistant], 10), 1);
});

test("growth 默认页大小与按钮一致（漏传参数时不会退回旧的 3）", () => {
	assert.equal(policy.resolvePageWindowGrowth(turns(20)), 10);
});
