import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const load = createTsSandbox();
const browsePin = load("src/renderer/src/hooks/timeline/browsePin.ts");
const controllerSource = readFileSync("src/renderer/src/hooks/useSessionTimelineController.ts", "utf8");

test("不在扩窗在途时不做高度差兜底", () => {
	assert.equal(browsePin.resolvePinnedRowFallback({ expanding: false, previousHeight: 100, nextHeight: 300, viewportHeight: 800 }), null);
});

test("没有高度基准时不补（首帧 previousHeight=0）", () => {
	assert.equal(browsePin.resolvePinnedRowFallback({ expanding: true, previousHeight: 0, nextHeight: 300, viewportHeight: 800 }), null);
});

test("高度变矮不补（负增量补了反而跳）", () => {
	assert.equal(browsePin.resolvePinnedRowFallback({ expanding: true, previousHeight: 300, nextHeight: 100, viewportHeight: 800 }), null);
});

test("增量超过半屏不补：那是内容自己长高，不是顶部插入", () => {
	assert.equal(browsePin.resolvePinnedRowFallback({ expanding: true, previousHeight: 100, nextHeight: 900, viewportHeight: 800 }), null);
	assert.equal(browsePin.resolvePinnedRowFallback({ expanding: true, previousHeight: 100, nextHeight: 501, viewportHeight: 800 }), null);
});

test("扩窗在途且增量在合理范围内才补，补的量就是增量", () => {
	assert.equal(browsePin.resolvePinnedRowFallback({ expanding: true, previousHeight: 100, nextHeight: 350, viewportHeight: 800 }), 250);
	assert.equal(browsePin.resolvePinnedRowFallback({ expanding: true, previousHeight: 100, nextHeight: 500, viewportHeight: 800 }), 400);
});

test("兜底分支必须在 shouldCompensateBrowsePin 之前，否则是不可达的死代码", () => {
	// shouldCompensateBrowsePin 在 currentViewportTop === null 时返回 false
	//（browsePin.ts 里明写），所以任何放在它后面的 null 分支都执行不到。
	// 这条判据用源码位置比对，抓的正是「分支写了但从没执行」。
	const body = controllerSource.slice(controllerSource.indexOf("const pinBrowseRow = useCallback("));
	const nullBranch = body.indexOf("if (currentTop === null) {");
	const gate = body.indexOf("shouldCompensateBrowsePin({");
	assert.ok(nullBranch > 0, "找不到 null 兜底分支");
	assert.ok(gate > 0, "找不到 shouldCompensateBrowsePin 调用");
	assert.ok(nullBranch < gate, "null 兜底分支排在 shouldCompensate 之后，永远执行不到");
});

test("高度基准的更新点必须覆盖所有出口", () => {
	const body = controllerSource.slice(controllerSource.indexOf("const pinBrowseRow = useCallback("));
	const updates = body.match(/pinFallbackHeightRef\.current = nextHeight;/g) ?? [];
	assert.ok(updates.length >= 2, "至少要在 null 分支和正常路径各更新一次，否则基准会停在很早的值");
});
