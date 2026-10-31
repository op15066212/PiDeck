import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 引导页虚拟会话 id 不得进入会话 Tab 列表（回归守卫）。
 *
 * 真实病例：引导页（`renderer:guide-bootstrap`）首次发送时，统一发送入口先按「预览 Tab 晋升常驻」
 * 调 onPromoteSession(sessionId)——此时 sessionId 还是虚拟 id，被尾插进 sessionTabIds，
 * 于是 Tab 栏多出一张取不到 record 的「未命名」幽灵标签（点击 no-op、清理按 seen 判定永远清不掉）。
 */

const { migrateAndPruneSessionTabIds } = loadTsCommonJs("src/renderer/src/hooks/useSessionWorkspaceChrome.ts", {
	stubs: {
		react: { useCallback: (callback) => callback, useEffect: () => undefined, useRef: (value) => ({ current: value }), useState: (value) => [typeof value === "function" ? value() : value, () => undefined] },
		jotai: { useAtomValue: () => undefined, useSetAtom: () => () => undefined, useStore: () => ({}) },
		"../atoms": {},
		"../desktopApi": { desktopApi: {} },
	},
});
const { isRendererVirtualSessionId, RENDERER_VIRTUAL_SESSION_ID_PREFIX } = loadTsCommonJs("src/shared/rendererVirtualSessionId.ts");
const { GUIDE_BOOTSTRAP_SESSION_ID } = loadTsCommonJs("src/renderer/src/utils/chatSessionBootstrap.ts");

test("虚拟 id 前缀：引导页 id 命中，真实会话 id 不命中", () => {
	assert.equal(RENDERER_VIRTUAL_SESSION_ID_PREFIX, "renderer:");
	assert.equal(GUIDE_BOOTSTRAP_SESSION_ID, "renderer:guide-bootstrap");
	assert.equal(isRendererVirtualSessionId(GUIDE_BOOTSTRAP_SESSION_ID), true);
	assert.equal(isRendererVirtualSessionId("renderer:whatever"), true);
	// 真实会话（uuid / 会话路径派生 id）必须与虚拟前缀区分开
	assert.equal(isRendererVirtualSessionId("2b8e6326-6985-4dbf-9703-0adfa3439f70"), false);
	assert.equal(isRendererVirtualSessionId(undefined), false);
	assert.equal(isRendererVirtualSessionId(null), false);
});

test("Tab 清理：虚拟 id 无条件丢弃，未加载项目的真实 id 保留", () => {
	const records = { live: { id: "live" } };
	const seen = new Set(["live", "deleted"]);
	// 三个并存：存活、已删除（seen 且无记录）、虚拟 id（从未 seen、也永远不会有记录）
	const next = migrateAndPruneSessionTabIds(["live", "deleted", GUIDE_BOOTSTRAP_SESSION_ID], new Map(), records, seen);
	assert.deepEqual([...next], ["live"], "虚拟 id 必须丢弃，已删除的真实会话按 seen 规则丢弃");

	// 项目尚未加载（record 暂时缺失）不能被当删除：这是 #354 的老不变量，虚拟 id 过滤不能顺手吃掉它
	assert.deepEqual([...migrateAndPruneSessionTabIds(["not-loaded-yet"], new Map(), {}, new Set())], ["not-loaded-yet"]);
	// 置顶被误写成虚拟 id 时同样清掉（localStorage 里的旧污染）
	assert.deepEqual([...migrateAndPruneSessionTabIds([GUIDE_BOOTSTRAP_SESSION_ID], new Map(), {}, new Set())], []);
});

test("无变化时返回原引用（去抖不回归）", () => {
	const tabs = ["a", "b"];
	const records = { a: { id: "a" }, b: { id: "b" } };
	const next = migrateAndPruneSessionTabIds(tabs, new Map(), records, new Set(["a", "b"]));
	assert.equal(next, tabs);
});

// —— 以下为源码契约守卫：闸门必须在「写 Tab 列表」之前生效 ——
// 纯函数层（migrateAndPrune）只能事后清理，真正阻止幽灵标签产生的是下面两个闸门；
// 它们没有可用的纯函数出入口，按本仓库既有做法用源码切片钉住位置与形态。
const between = (source, startMarker, endMarker) => {
	const start = source.indexOf(startMarker);
	assert.ok(start >= 0, `找不到切片起点：${startMarker}`);
	const end = source.indexOf(endMarker, start);
	assert.ok(end > start, `找不到切片终点：${endMarker}`);
	return source.slice(start, end);
};

test("统一发送入口：虚拟 id 不调 onPromoteSession", () => {
	const controller = readFileSync("src/renderer/src/hooks/useSessionComposerController.ts", "utf8");
	const promoteAndSend = between(controller, "const promoteAndSend = useCallback(", "const selectSuggestion = useCallback(");
	assert.match(promoteAndSend, /if\s*\(\s*!isRendererVirtualSessionId\(sessionId\)\s*\)\s*options\.onPromoteSession\?\.\(sessionId\);/, "引导页首发会把这个虚拟 id 尾插成幽灵标签，必须先过滤");
	assert.doesNotMatch(promoteAndSend, /^\s*options\.onPromoteSession\?\.\(sessionId\);$/m, "不得再有无条件晋升（漏一处就复活幽灵标签）");
});

test("Tab 登记闸门：registerOpenSession 只拦虚拟 id", () => {
	const chrome = readFileSync("src/renderer/src/hooks/useSessionWorkspaceChrome.ts", "utf8");
	const register = between(chrome, "const registerOpenSession = useCallback(", "const promotePreview = useCallback(");
	const gateAt = register.indexOf("if (isRendererVirtualSessionId(sessionId)) return;");
	const appendAt = register.indexOf("openPermanentSessionTab(");
	const previewAt = register.indexOf("openPreviewSessionTab(");
	assert.ok(gateAt >= 0, "registerOpenSession 必须有虚拟 id 闸门");
	assert.ok(appendAt > gateAt && previewAt > gateAt, "闸门必须在写入 Tab 列表之前（preview/permanent 两条路径都要拦住）");
	// 判据只认前缀：真实会话在项目未加载时 record 也会暂时缺失，不能用「有 record」当闸门。
	assert.doesNotMatch(register, /sessionRecords\[|Boolean\(record\)/, "闸门不得退化成「record 存在才登记」");
	// 目标条（SessionGoalStrip）等旁路都经 promotePreview → registerOpenSession 汇聚，一处拦截即可。
	assert.match(chrome, /const promotePreview = useCallback\(\s*\(sessionId: string\) => \{\s*registerOpenSession\(sessionId, "permanent"\);/, "promotePreview 必须复用 registerOpenSession");
});

test("置顶持久化：读入时丢掉历史遗留的虚拟 id", () => {
	const chrome = readFileSync("src/renderer/src/hooks/useSessionWorkspaceChrome.ts", "utf8");
	const initializer = between(chrome, "const [pinnedSessionTabIds, setPinnedSessionTabIds] = useState", "const [previewSessionTabId");
	assert.match(initializer, /localStorage\.getItem\(PINNED_TABS_STORAGE_KEY\)/);
	assert.match(initializer, /!isRendererVirtualSessionId\(id\)/, "localStorage 里的旧污染（幽灵 Tab 被固定过）要在读入时清掉");
});
