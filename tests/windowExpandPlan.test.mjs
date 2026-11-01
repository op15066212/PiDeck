import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 分批扩窗的行为契约（2026-11 真机：点大纲最上面的刻度 → React #185 整窗崩溃）。
 *
 * 原来这两条只有「读源码 + 正则断言代码长什么样」的测试，对行为零验证，
 * 且仓库规范禁止该写法。逻辑抽到 windowExpandPlan 后改测输入输出。
 */
const { planWindowExpandBatch, capWindowTurns, TURN_WINDOW_EXPAND_MAX_CHAIN_TURNS } = loadTsCommonJs("src/renderer/src/components/session/timeline/windowExpandPlan.ts");

test("待扩量未超过链上限：按帧小口消费，每帧最多 2 轮", () => {
	assert.equal(planWindowExpandBatch(5), 2);
	assert.equal(planWindowExpandBatch(3), 2);
	assert.equal(planWindowExpandBatch(1), 1);
});

test("待扩量超过链上限：一次性推开，不再逐帧连发 setState", () => {
	assert.equal(planWindowExpandBatch(TURN_WINDOW_EXPAND_MAX_CHAIN_TURNS + 1), TURN_WINDOW_EXPAND_MAX_CHAIN_TURNS + 1);
	assert.equal(planWindowExpandBatch(120), 120);
});

test("链上限本身仍走逐帧路径（边界，不是一次推开）", () => {
	assert.equal(planWindowExpandBatch(TURN_WINDOW_EXPAND_MAX_CHAIN_TURNS), 2);
});

test("没有待扩量时不排批次", () => {
	assert.equal(planWindowExpandBatch(0), 0);
	assert.equal(planWindowExpandBatch(-3), 0);
});

test("窗口轮数涨到上限即停，不再随补页无限膨胀", () => {
	assert.equal(capWindowTurns(9, 2, 10), 10);
	assert.equal(capWindowTurns(3, 2, 10), 5);
});

test("已经超过上限的当前值不被缩回（缩回会引发贴底抖动）", () => {
	assert.equal(capWindowTurns(12, 2, 10), 12);
});
