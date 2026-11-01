import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 跳转事务与贴底引擎的仲裁契约（用户三次反馈「输出时点刻度跳不回去、停手后又能跳」）。
 *
 * 要挡的是这条链：流式输出 → 引擎每帧 resize 并上报 following=true → autoScroll 变 true
 * → 该 effect 清空 pendingExpandTurnsRef 并 cancel 扩窗帧 → 挂起中的跳转等不到目标轮挂载。
 * 表现就是「点了没反应」。所以下面两条判定各要覆盖「跳转期间」与「非跳转期间」两侧，
 * 只测跳转一侧等于没测：把条件写成恒 true 也能全绿。
 */

const { shouldIgnoreFollowReport, shouldResetExpandBudget } = loadTsCommonJs("src/renderer/src/hooks/timelineJumpGuard.ts");

test("跳转挂起时忽略引擎的跟底上报", () => {
	assert.equal(shouldIgnoreFollowReport(true, true), true, "跳转中 + 上报跟底 → 必须忽略");
});

test("没有跳转时跟底上报照常接（否则用户滚回底部不再跟随）", () => {
	assert.equal(shouldIgnoreFollowReport(true, false), false);
});

test("引擎上报「不跟底」时永远不忽略（与跳转无关）", () => {
	assert.equal(shouldIgnoreFollowReport(false, true), false);
	assert.equal(shouldIgnoreFollowReport(false, false), false);
});

test("跳转挂起时回底不清扩窗预算", () => {
	assert.equal(shouldResetExpandBudget(true, true), false, "跳转中回底 → 不能清，否则永远挂不出来");
});

test("没有跳转时回底照常清预算与浏览 pin", () => {
	assert.equal(shouldResetExpandBudget(true, false), true);
});

test("不在底部时不清预算（浏览历史期间）", () => {
	assert.equal(shouldResetExpandBudget(false, false), false);
	assert.equal(shouldResetExpandBudget(false, true), false);
});
