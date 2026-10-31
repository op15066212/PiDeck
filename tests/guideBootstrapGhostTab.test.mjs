import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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

/**
 * 行为守卫：直接跑 hook 的写入口，确认虚拟 id 不进入 Tab 列表 / 置顶集合，真实会话照旧登记。
 * 上面几条源码契约只能证明「代码里有一道闸门」，这里证明它真的拦住了写入
 * （反向也重要：闸门不能退化成「有 record 才登记」，否则未加载项目的真实会话会丢 Tab）。
 * atom 用哨兵对象按身份分派，不依赖 hook 内部的取值顺序；state 桩只模拟 Tab 列表与记录表。
 */
function createChromeHarness(options = {}) {
	const atoms = {
		currentSessionIdAtom: { name: "currentSessionIdAtom" },
		projectInventoryByIdAtom: { name: "projectInventoryByIdAtom" },
		sessionRecordByIdAtomFamily: (sessionId) => ({ name: "sessionRecordByIdAtomFamily", sessionId }),
		sessionRecordsAtom: { name: "sessionRecordsAtom" },
		sessionTabIdsAtom: { name: "sessionTabIdsAtom" },
	};
	const state = { tabs: [], records: {} };
	const hook = loadTsCommonJs("src/renderer/src/hooks/useSessionWorkspaceChrome.ts", {
		// pinnedRaw 模拟 localStorage 里残留的旧置顶（含被固定过的幽灵 Tab）
		globals: { localStorage: { getItem: () => options.pinnedRaw ?? null, setItem: () => undefined } },
		stubs: {
			react: { useCallback: (callback) => callback, useEffect: () => undefined, useRef: (value) => ({ current: value }), useState: (value) => [typeof value === "function" ? value() : value, () => undefined] },
			jotai: {
				useAtomValue: (atom) => (atom === atoms.sessionTabIdsAtom ? state.tabs : atom === atoms.sessionRecordsAtom ? state.records : undefined),
				useSetAtom: (atom) => (next) => {
					if (atom !== atoms.sessionTabIdsAtom) return;
					state.tabs = typeof next === "function" ? next(state.tabs) : next;
				},
				useStore: () => ({ get: (atom) => (atom === atoms.sessionRecordsAtom ? state.records : undefined) }),
			},
			"../atoms": atoms,
			"../desktopApi": { desktopApi: {} },
		},
	});
	return { state, chrome: hook.useSessionWorkspaceChrome({ currentSessionId: undefined, activeProjectId: "project-1" }) };
}

test("行为：虚拟 id 的晋升/登记/置顶都不写 Tab 列表，真实会话照旧登记", () => {
	// 引导页首发链路：promoteAndSend → onPromoteSession → promotePreview → registerOpenSession。
	// 四次调用都不应该发生写入，所以同一份初始快照下断言「始终为空」；需要串联多次登记
	// （依赖上一次的 tabs）的用例各用新实例——真实 React 靠重渲染同步快照，harness 不重渲染。
	const guide = createChromeHarness();
	guide.chrome.promotePreview(GUIDE_BOOTSTRAP_SESSION_ID);
	guide.chrome.registerOpenSession(GUIDE_BOOTSTRAP_SESSION_ID, "permanent");
	guide.chrome.registerOpenSession(GUIDE_BOOTSTRAP_SESSION_ID, "preview");
	guide.chrome.togglePin(GUIDE_BOOTSTRAP_SESSION_ID);
	assert.deepEqual([...guide.state.tabs], [], "虚拟 id 写进 Tab 列表就是点不动、按 seen 规则永远清不掉的幽灵标签");

	// 闸门只认前缀：项目未加载、record 暂时缺失的真实会话必须照旧登记（preview 路径也不能误伤）。
	const real = "2b8e6326-6985-4dbf-9703-0adfa3439f70";
	const notLoadedYet = "b7c1f0de-0000-4000-8000-000000000001";
	const permanent = createChromeHarness();
	permanent.chrome.registerOpenSession(real, "permanent");
	assert.deepEqual([...permanent.state.tabs], [real], "真实会话的常驻登记不得被闸门误伤");
	const preview = createChromeHarness();
	preview.chrome.registerOpenSession(notLoadedYet, "preview");
	assert.deepEqual([...preview.state.tabs], [notLoadedYet], "闸门不得退化成「record 存在才登记」");
});

test("无变化时返回原引用（去抖不回归）", () => {
	const tabs = ["a", "b"];
	const records = { a: { id: "a" }, b: { id: "b" } };
	const next = migrateAndPruneSessionTabIds(tabs, new Map(), records, new Set(["a", "b"]));
	assert.equal(next, tabs);
});

// —— 以下为源码契约守卫 ——
// 纯函数层（migrateAndPrune）只能事后清理；登记/置顶/读入的行为由上面的 harness 覆盖，
// 统一发送入口（promoteAndSend）没有可用的纯函数出入口，按本仓库既有做法用源码切片钉住形态。
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

test("行为：置顶入口同样拦虚拟 id，真实会话可以钉住", () => {
	// 置顶会把 id 同时写进 Tab 列表与置顶集合：虚拟 id 被钉住时两个集合一起脏，还要等下次记录
	// 变化/下次启动才可能被清掉，所以闸门必须与登记同源（今天只有 Tab 栏能触发）。
	const virtual = createChromeHarness();
	virtual.chrome.togglePin(GUIDE_BOOTSTRAP_SESSION_ID);
	assert.deepEqual([...virtual.state.tabs], [], "虚拟 id 写进置顶就是跨重启留存的幽灵标签");

	const real = "2b8e6326-6985-4dbf-9703-0adfa3439f70";
	const pinned = createChromeHarness();
	pinned.chrome.togglePin(real);
	assert.deepEqual([...pinned.state.tabs], [real], "真实会话的置顶不得被闸门误伤");
});

test("行为：localStorage 里残留的虚拟 id 置顶读入即丢弃", () => {
	// 旧版本能把幽灵 Tab 固定下来并跨重启留存；读入时必须丢掉，否则每次启动都复活一张「未命名」。
	const real = "2b8e6326-6985-4dbf-9703-0adfa3439f70";
	const harness = createChromeHarness({ pinnedRaw: JSON.stringify([GUIDE_BOOTSTRAP_SESSION_ID, real]) });
	assert.deepEqual([...harness.chrome.pinnedSessionTabIds], [real]);
});

/**
 * 漂移守卫：源码里出现的每个 `renderer:` 字面量都必须落在这个已知集合里。
 *
 * 两处判据不对称是这里存在的理由——登记闸门（isRendererVirtualSessionId）按**前缀**拦住所有
 * 虚拟 id，而「把虚拟 id 变成真实会话」的落地钩子在 App.ensureSessionForSend 里按
 * GUIDE_BOOTSTRAP_SESSION_ID **字面量**判定。新增一个虚拟 id 却不动落地钩子 = 发送时被闸门
 * 拦住、又没有任何路径把它建成真实会话，直接报「会话不存在」。这里逼迫新增者显式登记用途。
 */
const KNOWN_RENDERER_LITERALS = new Set([
	"renderer:", // 前缀定义本体（shared/rendererVirtualSessionId.ts）
	"renderer:guide-bootstrap", // 引导页虚拟会话：App.ensureSessionForSend 有落地钩子
	"renderer:mini-new-session", // 迷你浮层模型目录的缓存键，不是会话 id、不参与发送
	"renderer:log", // IPC 通道名（shared/ipc.ts），与会话 id 无关
]);

test("虚拟 id 字面量清单：新增必须显式登记（落地钩子按字面量判定）", () => {
	const files = readdirSync("src", { recursive: true, encoding: "utf8" }).filter((entry) => /\.tsx?$/.test(entry));
	const found = new Map();
	for (const relative of files) {
		const source = readFileSync(join("src", relative), "utf8");
		for (const match of source.matchAll(/["'`](renderer:[A-Za-z0-9_-]*)["'`]/g)) {
			if (!found.has(match[1])) found.set(match[1], join("src", relative));
		}
	}
	assert.ok(found.size > 0, "扫描不到任何 renderer: 字面量——扫描表达式或目录结构已失效，守卫形同虚设");
	for (const [literal, file] of found) {
		assert.ok(KNOWN_RENDERER_LITERALS.has(literal), `新的 renderer: 字面量 ${literal}（${file}）：登记闸门按前缀拦，但落地钩子按字面量判定——新增虚拟会话必须同步 App.ensureSessionForSend，否则发送直接报「会话不存在」`);
	}
});
