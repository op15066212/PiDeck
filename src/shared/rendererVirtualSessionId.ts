/**
 * 渲染层虚拟会话 id 的识别（单一来源）。
 *
 * 引导页这类界面没有 Catalog 会话，用的是只活在渲染层 atoms 里的虚拟 id
 * （`renderer:guide-bootstrap`）：它不落 Catalog、主进程查不到、也没有会话文件。
 * 这类 id 一旦被当成真实会话登记进会话 Tab 列表 / 持久化引用，就会渲染成一张
 * 「未命名」幽灵标签——点击因为取不到 record 直接 no-op，且清理逻辑按「见过又消失」
 * 判定（虚拟 id 从未进过 sessionRecords，永远不算 seen），清不掉。
 *
 * 判据只认前缀，不做白名单：新增虚拟会话只需沿用前缀即可自动获得保护。
 */

/** 渲染层虚拟会话 id 前缀（含冒号，避免与真实 uuid 前缀相撞）。 */
export const RENDERER_VIRTUAL_SESSION_ID_PREFIX = "renderer:";

/**
 * 是否渲染层虚拟会话 id。
 *
 * 只用于「登记/持久化引用」前的闸门；**不能反过来当成「会话不存在」**——
 * 真实会话在项目未加载时 record 也会暂时缺失（#354 的 seen 规则就是为这个场景存在的）。
 */
export function isRendererVirtualSessionId(sessionId: string | undefined | null): boolean {
	return typeof sessionId === "string" && sessionId.startsWith(RENDERER_VIRTUAL_SESSION_ID_PREFIX);
}
