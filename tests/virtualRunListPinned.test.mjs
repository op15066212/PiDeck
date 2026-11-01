import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const load = createTsSandbox();
const policy = load("src/renderer/src/components/session/timeline/virtualTimelinePolicy.ts");

// 沙箱里的数组来自另一个 VM 上下文，assert.deepEqual 会因原型不同判不等；
// 先展开成主上下文数组再比较。
function merged(base, pinned, limit) {
	return [...policy.mergePinnedRange(base, pinned, limit)];
}

test("没有钉行时原样返回同一引用（虚拟器不能因引用变化重算全部行起点）", () => {
	const base = [3, 4, 5];
	assert.equal(policy.mergePinnedRange(base, []), base);
});

test("钉行已在可见范围内时原样返回", () => {
	const base = [3, 4, 5];
	assert.equal(policy.mergePinnedRange(base, [4]), base);
});

test("钉行在范围外时并入，且保持升序", () => {
	assert.deepEqual(merged([3, 4, 5], [1]), [1, 3, 4, 5]);
	assert.deepEqual(merged([3, 4, 5], [9]), [3, 4, 5, 9]);
	assert.deepEqual(merged([3, 4, 5], [9, 1]), [1, 3, 4, 5, 9]);
});

test("重复的钉行不产生重复下标", () => {
	assert.deepEqual(merged([3, 4], [7, 7, 7]), [3, 4, 7]);
});

test("非法下标被忽略（负数 / 小数 / NaN）", () => {
	const base = [3, 4];
	assert.equal(policy.mergePinnedRange(base, [-1, 1.5, Number.NaN]), base);
});

test("结果永远是升序且无重复（库的硬要求）", () => {
	const out = merged([5, 6], [9, 2, 7, 2]);
	for (let i = 1; i < out.length; i += 1) assert.ok(out[i] > out[i - 1], "必须严格升序");
	assert.equal(new Set(out).size, out.length);
});

test("越界下标被跳过（limit = 行数）", () => {
	// 纯函数不该依赖调用方自律：越界下标一旦进 rangeExtractor，
	// tanstack 会按它取 virtualEntries[undefined] 渲染空行。
	assert.deepEqual(merged([1, 2], [5], 5), [1, 2]);
	assert.deepEqual(merged([1, 2], [4], 5), [1, 2, 4]);
	assert.deepEqual(merged([1, 2], [4, 9], 5), [1, 2, 4]);
	// 0 是合法下标（< limit），-1 才是非法
	assert.deepEqual(merged([1, 2], [-1, 0, 1], 5), [0, 1, 2]);
});

test("rangeExtractor 自证：越界 / 乱序 / 重复都会抛（不设开发期门控）", () => {
	// 这条不需要 e2e 基建：集成错了比事后看掉位好定位。
	// 原实现用「开发期环境常量」门控，那个写法在 vm 测试沙箱里是语法错误，
	// 整个 VirtualRunList 加载失败 —— 三条既有测试因此长期红。改成无条件自证：
	// 三项都是 tanstack 硬前提，违反会渲染空行/跳行，任何环境都该当场炸；
	// 成本只是 range 变化时 k 次比较（k = 视口行 + 钉行 ≈ 3）。
	const source = readFileSync("src/renderer/src/components/session/timeline/VirtualRunList.tsx", "utf8");
	assert.match(source, /mergePinnedRange\(defaultRangeExtractor\(range\), pinnedIndexesRef\.current, count\)/, "必须把 count 传给 mergePinnedRange");
	assert.doesNotMatch(source, /import\.meta\.env\.DEV/, "不许再用开发期环境常量门控（沙箱里是语法错误）");
	assert.match(source, /rangeExtractor 产出越界下标/, "越界要抛");
	assert.match(source, /rangeExtractor 产出未严格升序/, "乱序/重复要抛");
});
