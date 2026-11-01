/**
 * 历史翻页的每页轮数口径。
 *
 * 抽成独立模块的原因：这两个数字一行写错就是「点一次只多一屏不到」的用户可见缺陷，
 * 但它埋在 controller 三千行里，无法被纯函数测试覆盖。放在这里后，页大小与窗口增长
 * 都能直接喂输入断言输出。
 *
 * host 侧的上限是 10，不是我们可以随便调的：
 * - pi：SessionHistoryReader.MAX_TURN_PAGE_SIZE = 10，MAX_TURN_PAGE_SIZE 之外的请求值
 *   在 boundedTurnCount 里被静默夹到 10（SessionHistoryReader.ts:749 / :1066）
 * - DSH：DSH_HISTORY_TURN_PAGE_LIMIT = 10，normalizeDshTurnPageSize 同样夹到 10
 * 所以渲染层传 20 不会报错，只会拿到 10 —— 传大了没有收益，传小了才是缺陷。
 */

import { countUserTurns } from "./turnRenderWindow";

/** 显式点「加载更多对话」时的单页轮数：取 host 上限，一次点击给足 10 轮。
 *  过去传 3：用户点一次只多一屏不到，观感等于「按钮没反应」（2026-11 真机反馈）。 */
export const HISTORY_TURN_PAGE_SIZE = 10;

/** 滚动到顶自动翻页的单页轮数：仍取 3。
 *  滚动触发是连续事件，一次多要 10 轮会让视口被顶出很远，反而像「跳了一下」。
 *  按钮是单次明确意图，只有它用 10。 */
export const HISTORY_SCROLL_TURN_PAGE_SIZE = 3;

/** 跳转补页（backfill）的单页轮数：取 host 上限，一次给足 10 轮。
 *
 *  这个 source 只有一个用途 —— 用户点右缘刻度跳还没加载的历史。两个调用方
 *  （SessionSurfaceStage 的刻度 pending 链、controller 的 pendingJump effect）都是它。
 *  曾经写成 3，理由是「回填在后台连续补页，一次 10 轮会让单批负载翻三倍」——
 *  那个调用方已经不存在了（grep "backfill" 只有这两处跳转），注释是过期的。
 *  页面高度除以 12 决定刻度数（约 90 根），147 轮的会话一根刻度背后可能差几十轮，
 *  每次只补 3 轮 = 用户要点十几次才落地。取 10 是 host 上限，不能再大。 */
export const HISTORY_BACKFILL_TURN_PAGE_SIZE = 10;

export type HistoryLoadSource = "scroll" | "button" | "backfill";

/** 按来源取页大小。写成函数而不是三处三元表达式：页大小是唯一真值，
 *  调用点只声明「这是哪条路径」，避免以后改常量时漏改某一条链。 */
export function resolveHistoryPageSize(source: HistoryLoadSource): number {
	if (source === "button") return HISTORY_TURN_PAGE_SIZE;
	if (source === "scroll") return HISTORY_SCROLL_TURN_PAGE_SIZE;
	return HISTORY_BACKFILL_TURN_PAGE_SIZE;
}

/** 翻页成功后开放的 DOM 窗口轮数。
 *
 *  必须按「页内实际轮数」放，不能让窗口比数据小：窗口小于返回的轮数时，新加载的
 *  轮会被尾部窗口裁掉 —— 数据已加载但看不见，表现为「点了没反应」。
 *  也不能超过页大小：窗口比数据大没有内容可填，只是多一次 turn 窗口重算。
 *
 *  disk 消息页不一定以 user 消息开头（可能在长回答中间切断），所以只要页非空就至少
 *  开放 1 轮，否则这一页会整页落在窗口外。
 */
export function resolvePageWindowGrowth(messages: readonly { role?: string }[], pageSize: number = HISTORY_TURN_PAGE_SIZE): number {
	if (messages.length === 0) return 0;
	const turns = countUserTurns(messages);
	return Math.min(pageSize, Math.max(1, turns));
}
