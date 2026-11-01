/**
 * 跳转事务（pendingJump）与贴底引擎之间的两处仲裁。
 *
 * 背景（用户三次反馈「输出时点刻度跳不回去、停止输出后又能跳」）：
 * 流式输出时贴底引擎每帧都在 resize，会上报 following=true。两个消费点各自会造成跳转失效：
 *
 * 1. 跟底上报会把 autoScroll 拉回 true，而 autoScroll=true 的 effect 会清空
 *    分批扩窗预算（pendingExpandTurnsRef）并 cancel 扩窗帧 —— 挂起中的跳转永远等不到
 *    目标轮挂载，表现就是「点了没反应」。
 * 2. 同一 effect 还会把浏览 pin 全部清掉，扩窗后补位移的依据没了，落位会偏移。
 *
 * 所以跳转期间不接受引擎的跟底上报。抽成纯函数是为了用测试钉住这两条判定，
 * 而不是靠「读源码里有没有那个 if」。
 */

/** 跳转事务进行中：忽略引擎的跟底上报（true = 忽略）。 */
export function shouldIgnoreFollowReport(following: boolean, hasPendingJump: boolean): boolean {
	return following && hasPendingJump;
}

/** 回底时是否应清空扩窗预算与浏览 pin（true = 清）。跳转期间不清。 */
export function shouldResetExpandBudget(autoScroll: boolean, hasPendingJump: boolean): boolean {
	return autoScroll && !hasPendingJump;
}
