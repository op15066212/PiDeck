/**
 * 分批扩窗的纯计算（从 useSessionTimelineController 提出来）。
 *
 * 为什么单独成模块：这段逻辑原先只有一份「正则扫源码」的测试守着——断言代码长什么样，
 * 对行为零验证（仓库规范禁止这种写法）。抽成纯函数后才能直接喂输入、断言输出。
 *
 * 为什么需要上限：补页一路补到很早的历史时，每页都会排一批扩窗，待扩量可累计上百轮；
 * 按帧小口消费等于在一条 rAF 链上连发上百次 setState，React 的嵌套更新上限是 50，
 * 超了直接抛 #185（2026-11 真机：点大纲最上面的刻度 → 「界面渲染异常」整窗打掉）。
 * 这种量级一次性推开：多挂几十轮的开销远小于崩溃。
 */

/** 每帧最多挂载的轮数：一个 3 轮 cohort 拆成 2+1 两帧，避免本地 DOM 扩展在同一帧集中渲染。 */
export const TURN_WINDOW_EXPAND_BATCH_TURNS = 2;

/** 一条 rAF 链上允许逐帧消费的轮数上限，超过就一次性推开。 */
export const TURN_WINDOW_EXPAND_MAX_CHAIN_TURNS = 24;

/** 这一帧该扩几轮：待扩量为 0 返回 0，未超链上限按帧小口消费，超过则全部推开。 */
export function planWindowExpandBatch(backlog: number): number {
	if (backlog <= 0) return 0;
	return backlog > TURN_WINDOW_EXPAND_MAX_CHAIN_TURNS ? backlog : Math.min(TURN_WINDOW_EXPAND_BATCH_TURNS, backlog);
}

/**
 * 扩窗后的轮数：不超过 `windowCap`，但也不把已经超出的当前值缩回去。
 *
 * 为什么要封顶：窗口一路涨到几百轮会让每次扩窗都重挂整表，是 2026-11 那次整窗崩溃的温床。
 * 为什么不缩回：已知超出上限时（例如已加载消息比上限少、随后又补进更多），缩回会造成一次
 * 大幅内容收缩，贴着底部时会连带触发回底/掉底那一串抖动。
 */
export function capWindowTurns(prev: number, batch: number, windowCap: number): number {
	return Math.min(prev + batch, Math.max(prev, windowCap));
}
