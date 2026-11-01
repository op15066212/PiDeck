/**
 * Agent 记忆的目录布局、文件名与预算常量。
 *
 * 设计要点（对齐 pi-hermes-memory 的经验，但落盘位置由 PiDeck 决定）：
 * - **Markdown 是唯一真值**：用户可以直接用编辑器改，SQLite 只是可随时重建的索引镜像。
 *   因此索引与文件不一致时以文件为准，写完文件后回灌索引即可「自愈」。
 * - 目录由 `PIDECK_AGENT_MEMORY_DIR` 显式传入（宿主进程解析 userData 后注入）。
 *   **没有默认值**：缺失时服务器直接拒绝启动，避免把记忆写进某个进程的 cwd。
 * - 全局作用域落在根目录；项目作用域落在 `projects/<projectId>/`，projectId 必须
 *   已在宿主侧校验过（这里再做一次路径逃逸检查，防止 `..` 拼出目录穿越）。
 */

import path from "node:path";

/** 条目分隔符：单条记忆内部可以有多行，条目之间用这个不可见的分节符隔开。 */
export const ENTRY_DELIMITER = "\n§\n";

/** 各 target 的文件名。`failure` 用独立文件，因为它和普通记忆是两条不同的注入路径。 */
export const TARGET_FILES = {
	memory: "MEMORY.md",
	user: "USER.md",
	standing: "STANDING.md",
	failure: "failures.md",
};

/** 允许写入的 target 集合；`STANDING` 只允许 `memory` target 里显式指定的 scope。 */
export const MEMORY_TARGETS = ["memory", "user", "project", "failure"];
export const FAILURE_CATEGORIES = ["failure", "correction", "insight", "preference", "convention", "tool-quirk"];

/**
 * 预算：超出后按「最老的先丢」裁剪。
 * 数字取「能放进系统提示且不挤掉其他指令」的量级；STANDING 每条会话都要注入，给得更紧。
 */
export const FILE_BUDGETS = {
	memory: { maxChars: 8000, maxEntries: 120 },
	user: { maxChars: 4000, maxEntries: 60 },
	standing: { maxChars: 4000, maxEntries: 40 },
	failure: { maxChars: 8000, maxEntries: 120 },
};

/** 单条内容上限：防止一次写入把整份文件挤空。 */
export const MAX_ENTRY_CHARS = 2000;

/** 会话索引：单条消息入库上限（工具结果动辄上万字符，只留可检索的开头）。 */
export const MAX_INDEXED_MESSAGE_CHARS = 4000;

/** 项目 id 只允许这些字符；宿主侧同样有校验，这里是第二道闸。 */
const PROJECT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * 会话工作目录 → 项目作用域的键。
 *
 * 项目记忆刻意用**路径派生的稳定键**而不是 PiDeck 的 projectId：
 * - 同一个项目在 pi / ACP / 终端里 cwd 相同，三种后端自然共享一份项目记忆；
 * - 项目从 PiDeck 移除再加回来（id 会变）时记忆不丢；
 * - Agent 本来就知道自己的 cwd，不需要额外告诉它宿主侧的内部 id。
 * 超长路径用短哈希收尾，保证目录名可读且不撞。
 */
export function projectKeyFromPath(cwd) {
	if (typeof cwd !== "string" || !cwd.trim()) return "";
	const normalized = path.resolve(cwd);
	const slug = normalized.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	if (slug.length === 0) return "";
	// 先截短再校验：超长路径的 slug 必定超出目录名长度上限，截断后才是最终键。
	// 前缀留 80 字符保证人工可读，后缀用路径哈希避免同前缀项目撞成一条记忆。
	if (slug.length <= 96) return PROJECT_ID_PATTERN.test(slug) ? slug : "";
	let hash = 0;
	for (let index = 0; index < normalized.length; index += 1) hash = (hash * 31 + normalized.charCodeAt(index)) >>> 0;
	const key = `${slug.slice(0, 80)}-${hash.toString(16)}`;
	return PROJECT_ID_PATTERN.test(key) ? key : "";
}

/** 省略 projectId 时的项目作用域键（由宿主注入的会话 cwd 推导）；没有 cwd 时返回空。 */
export function defaultProjectKey(env = process.env) {
	return projectKeyFromPath(env.PIDECK_AGENT_MEMORY_CWD);
}

/** 读取记忆根目录；缺失或非法直接抛错（调用方负责把错误转成工具错误）。 */
export function resolveMemoryRoot(env = process.env) {
	const root = env.PIDECK_AGENT_MEMORY_DIR;
	if (!root || typeof root !== "string") throw new Error("memory-dir-missing");
	if (!path.isAbsolute(root)) throw new Error("memory-dir-not-absolute");
	return path.resolve(root);
}

/** 项目子目录；projectId 非法时抛错而不是悄悄落到全局目录。 */
export function resolveProjectDir(root, projectId) {
	if (typeof projectId !== "string" || !PROJECT_ID_PATTERN.test(projectId)) throw new Error("project-id-invalid");
	const dir = path.join(root, "projects", projectId);
	// 双保险：join 之后再规范化比较一次前缀，任何诡异的 id 都不允许逃出去。
	const normalized = path.resolve(dir);
	if (normalized !== dir || !normalized.startsWith(path.resolve(root) + path.sep)) throw new Error("project-id-invalid");
	return normalized;
}

/** 索引库路径（固定落根目录，项目作用域共用同一个库，靠 project_id 列区分）。 */
export function databasePath(root) {
	return path.join(root, "agent-memory.db");
}

/** target + projectId → 具体的 Markdown 文件路径。 */
export function targetFilePath(root, target, projectId) {
	const fileName = TARGET_FILES[target];
	if (!fileName) throw new Error("target-invalid");
	const dir = projectId ? resolveProjectDir(root, projectId) : root;
	return path.join(dir, fileName);
}
