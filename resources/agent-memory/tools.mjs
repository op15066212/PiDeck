/**
 * 记忆工具的真实实现（工具定义 + 调用入口）。
 *
 * 一条贯穿始终的规则：**先同步镜像，再读**。用户随时可以用编辑器改 Markdown，
 * 所以每次检索前把文件里的当前内容重灌进 SQLite（百量级条目，成本可忽略），
 * 这样「索引与文件不一致」这个失败模式在结构上就不存在，不需要一致性协议。
 *
 * 写路径的顺序固定为：内容扫描 → 变更 → 预算裁剪 → 落盘 → 回灌索引。
 * 任何一步失败都不留下「文件改了但索引没改」或反向的半状态。
 */

import { readAllEntries, mutateEntries, readEntries } from "./files.mjs";
import { formatFailureEntry, normalizeKey, parseFailureEntry } from "./format.mjs";
import { hasCjk, indexStats, searchEntries, searchMessages, syncEntries } from "./db.mjs";
import { entryCategory } from "./format.mjs";
import { FAILURE_CATEGORIES, FILE_BUDGETS, MAX_ENTRY_CHARS, MEMORY_TARGETS } from "./paths.mjs";
import { scanMemoryContent } from "./scan.mjs";
import { indexSources } from "./sessions.mjs";

/** 工具错误：`code` 是稳定标识（测试与前端都依赖它），`detail` 只放非敏感补充。 */
export class MemoryToolError extends Error {
	constructor(code, detail) {
		super(detail ? `${code}: ${detail}` : code);
		this.code = code;
		this.detail = detail;
	}
}

/** target → 文件作用域。`project`/带 projectId 的 `failure` 落到项目目录，其余落根目录。 */
function resolveScope(target, projectId) {
	if (target === "project") {
		if (!projectId) throw new MemoryToolError("project-id-required");
		return { target: "memory", projectId };
	}
	if (target === "failure" && projectId) return { target: "failure", projectId };
	return { target, projectId: "" };
}

/** 把某个 target 的 Markdown 当前内容回灌进索引。 */
function syncTarget(root, target, projectId) {
	const entries = readEntries(root, target, projectId);
	syncEntries(root, {
		target,
		scope: projectId ? "project" : "global",
		projectId,
		entries,
		categoryOf: (content) => (target === "failure" ? entryCategory(content) : ""),
	});
	return entries;
}

/** 检索前的整体同步（全局四份 + 可选项目两份）。 */
function syncAll(root, projectId) {
	syncTarget(root, "standing", "");
	syncTarget(root, "user", "");
	syncTarget(root, "memory", "");
	syncTarget(root, "failure", "");
	if (projectId) {
		syncTarget(root, "memory", projectId);
		syncTarget(root, "failure", projectId);
	}
}

/** 写入前的统一校验。 */
function assertWritable(content) {
	if (typeof content !== "string") throw new MemoryToolError("content-required");
	const trimmed = content.trim();
	if (trimmed.length === 0) throw new MemoryToolError("memory-content-empty");
	if (trimmed.length > MAX_ENTRY_CHARS) throw new MemoryToolError("content-too-long", `max ${MAX_ENTRY_CHARS}`);
	const rejected = scanMemoryContent(trimmed);
	if (rejected) throw new MemoryToolError(rejected.code, rejected.detail);
	return trimmed;
}

function assertCategory(category) {
	if (category === undefined || category === null) return undefined;
	if (typeof category !== "string" || !FAILURE_CATEGORIES.includes(category)) throw new MemoryToolError("category-invalid");
	return category;
}

/** 新增一条。重复内容视为成功（幂等），返回 `duplicate: true` 让调用方知道没写新行。 */
export function addMemory(root, { target = "memory", content, category, projectId = "" }) {
	if (!MEMORY_TARGETS.includes(target)) throw new MemoryToolError("target-invalid");
	const scope = resolveScope(target, projectId);
	const safeCategory = assertCategory(category);
	const trimmed = assertWritable(content);
	const block = scope.target === "failure" ? formatFailureEntry(safeCategory ?? "insight", trimmed) : trimmed;

	const outcome = mutateEntries(root, scope.target, scope.projectId, (entries) => {
		const duplicate = entries.some((entry) => normalizeKey(scope.target === "failure" ? parseFailureEntry(entry).content : entry) === normalizeKey(trimmed));
		if (duplicate) return { entries, result: { duplicate: true } };
		entries.push(block);
		return { entries, result: { duplicate: false } };
	});

	syncTarget(root, scope.target, scope.projectId);
	return {
		ok: true,
		target,
		scope: scope.projectId ? "project" : "global",
		projectId: scope.projectId,
		duplicate: outcome.result.duplicate,
		count: outcome.count,
		dropped: outcome.dropped,
		budget: FILE_BUDGETS[scope.target],
	};
}

/** 替换：按内容定位（规范化后完全相等，或作为子串唯一命中）。 */
export function replaceMemory(root, { target = "memory", oldContent, content, projectId = "" }) {
	if (!MEMORY_TARGETS.includes(target)) throw new MemoryToolError("target-invalid");
	if (typeof oldContent !== "string" || oldContent.trim().length === 0) throw new MemoryToolError("old-content-required");
	const scope = resolveScope(target, projectId);
	const trimmed = assertWritable(content);
	const wanted = normalizeKey(oldContent);
	const replacement = scope.target === "failure" ? formatFailureEntry(parseFailureEntry(trimmed).category, parseFailureEntry(trimmed).content) : trimmed;

	const outcome = mutateEntries(root, scope.target, scope.projectId, (entries) => {
		const exact = entries.findIndex((entry) => normalizeKey(scope.target === "failure" ? parseFailureEntry(entry).content : entry) === wanted);
		const matches = exact >= 0 ? [exact] : entries.map((entry, index) => (normalizeKey(entry).includes(wanted) ? index : -1)).filter((index) => index >= 0);
		if (matches.length === 0) throw new MemoryToolError("entry-not-found");
		// 子串命中多条时要求调用方给出更精确的旧内容：猜错就改错记忆，比失败更糟。
		if (matches.length > 1) throw new MemoryToolError("entry-ambiguous", `${matches.length} matches`);
		entries[matches[0]] = replacement;
		return { entries, result: { replaced: true } };
	});

	syncTarget(root, scope.target, scope.projectId);
	return { ok: true, target, scope: scope.projectId ? "project" : "global", projectId: scope.projectId, count: outcome.count, dropped: outcome.dropped };
}

/** 删除：定位规则与替换一致。 */
export function removeMemory(root, { target = "memory", content, projectId = "" }) {
	if (!MEMORY_TARGETS.includes(target)) throw new MemoryToolError("target-invalid");
	if (typeof content !== "string" || content.trim().length === 0) throw new MemoryToolError("old-content-required");
	const scope = resolveScope(target, projectId);
	const wanted = normalizeKey(content);

	const outcome = mutateEntries(root, scope.target, scope.projectId, (entries) => {
		const exact = entries.findIndex((entry) => normalizeKey(scope.target === "failure" ? parseFailureEntry(entry).content : entry) === wanted);
		const matches = exact >= 0 ? [exact] : entries.map((entry, index) => (normalizeKey(entry).includes(wanted) ? index : -1)).filter((index) => index >= 0);
		if (matches.length === 0) throw new MemoryToolError("entry-not-found");
		if (matches.length > 1) throw new MemoryToolError("entry-ambiguous", `${matches.length} matches`);
		entries.splice(matches[0], 1);
		return { entries, result: { removed: true } };
	});

	syncTarget(root, scope.target, scope.projectId);
	return { ok: true, target, scope: scope.projectId ? "project" : "global", projectId: scope.projectId, count: outcome.count };
}

/** 列出条目（按文件顺序，最老的在前）。 */
export function getMemories(root, { target = "memory", projectId = "", limit = 50, offset = 0 } = {}) {
	if (!MEMORY_TARGETS.includes(target)) throw new MemoryToolError("target-invalid");
	const scope = resolveScope(target, projectId);
	const entries = readEntries(root, scope.target, scope.projectId);
	const sliced = entries.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(1, Math.min(200, limit)));
	return {
		ok: true,
		target,
		scope: scope.projectId ? "project" : "global",
		projectId: scope.projectId,
		total: entries.length,
		offset,
		entries: sliced.map((entry) => (scope.target === "failure" ? parseFailureEntry(entry) : { content: entry })),
	};
}

/** 检索记忆。DB 不可用时退化为 Markdown 子串扫描（结果形态一致，只是没有排序分数）。 */
export function searchMemory(root, { query, target, projectId = "", limit = 10 }) {
	if (typeof query !== "string" || query.trim().length === 0) throw new MemoryToolError("query-required");
	const targets = target && target !== "project" ? [target] : ["memory", "user", "standing", "failure", "project"];
	syncAll(root, projectId);
	const found = searchEntries(root, query.trim(), { limit, targets, projectId });
	if (found.ok) return { ok: true, query: query.trim(), degraded: false, hits: found.hits };

	// 降级：没有索引时直接在文件内容里找子串。仍能命中，只是没有 bm25 排序。
	const wanted = query.trim().toLowerCase();
	const hits = [];
	for (const [key, entries] of Object.entries(readAllEntries(projectId, root))) {
		for (const entry of entries) {
			if (entry.toLowerCase().includes(wanted)) hits.push({ content: entry, target: key.startsWith("project") ? "project" : key, scope: key.startsWith("project") ? "project" : "global", projectId: key.startsWith("project") ? projectId : "", score: 1 });
		}
	}
	return { ok: true, query: query.trim(), degraded: true, reason: found.reason, hits: hits.slice(0, limit) };
}

/** 跨后端会话检索（采集 → 检索）。 */
export function searchSessions(root, { query, project = "", limit = 10, sources = [] }) {
	if (typeof query !== "string" || query.trim().length === 0) throw new MemoryToolError("query-required");
	if (sources.length === 0) throw new MemoryToolError("session-sources-empty");
	const indexing = indexSources(root, sources);
	const found = searchMessages(root, query.trim(), { limit, project: project || undefined });
	if (!found.ok) throw new MemoryToolError(found.reason);
	return { ok: true, query: query.trim(), indexing, hits: found.hits };
}

/** 自检：预算占用 + 索引规模。用于「记忆系统到底有没有在工作」的快速判定。 */
export function memoryStatus(root, { projectId = "", sources = [] }) {
	const global = readAllEntries(projectId, root);
	const usage = {};
	for (const [key, entries] of Object.entries(global)) {
		const target = key === "projectMemory" ? "memory" : key === "projectFailure" ? "failure" : key;
		const budget = FILE_BUDGETS[target];
		usage[key] = { entries: entries.length, chars: entries.join("\n§\n").length, maxEntries: budget.maxEntries, maxChars: budget.maxChars };
	}
	const stats = indexStats(root);
	return { ok: true, usage, index: stats, sessionSources: sources.length, cjkQueryUsesLike: hasCjk("记忆") };
}
