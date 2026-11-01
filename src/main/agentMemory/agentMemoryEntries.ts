/**
 * 设置页「记忆」tab 的条目视图：把 Markdown 真值读成可浏览的列表，并支持删除单条。
 *
 * 三件事必须与别处一致，所以直接复用 MCP 服务器的模块，不另写一套口径：
 * - 分节（`ENTRY_DELIMITER`）：`parseEntries`；
 * - 去重键（墓碑与 `memory_replace` 定位同一份）：`normalizeKey`；
 * - 文件布局（`projects/<key>/`、`devices/<key>/`）：`targetFilePath`。
 *
 * 这里**只做**列举与删除；新增/修改永远只由 Agent 在会话里经工具发生。删除写一条墓碑，
 * 让「删掉的条目被旧导出包导回来」不可能发生。
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { entryCategory, normalizeKey, parseEntries, renderEntries } from "../../../resources/agent-memory/format.mjs";
import { readRaw, writeAtomic } from "../../../resources/agent-memory/files.mjs";
import { FILE_BUDGETS, TARGET_FILES, projectKeyFromPath, resolveMemoryRoot, targetFilePath } from "../../../resources/agent-memory/paths.mjs";
import { addTombstone } from "../../../resources/agent-memory/sync.mjs";

export type AgentMemoryTarget = keyof typeof TARGET_FILES;
export type AgentMemoryScope = "global" | "project" | "device";

export interface AgentMemoryEntryView {
	/** 文件内序号（1 起）。删除按 `key` 定位，序号只用于展示顺序。 */
	index: number;
	target: AgentMemoryTarget;
	file: string;
	scope: AgentMemoryScope;
	projectId: string;
	/** 展示用名字：项目名（能匹配到 PiDeck 项目时）、设备短键，全局留空。 */
	projectName: string;
	/** 规范化内容键：与去重/墓碑同一个哈希口径，删除用它定位。 */
	key: string;
	content: string;
	chars: number;
	/** `failure` 的分类；其他目标为空串。 */
	category: string;
}

export interface AgentMemoryEntryGroup {
	target: AgentMemoryTarget;
	scope: AgentMemoryScope;
	projectId: string;
	projectName: string;
	/** 相对根目录的路径，作为「这条记忆存在哪个文件」给用户看的凭据。 */
	file: string;
	bytes: number;
	/** 全局四份文件有注入预算；项目/设备作用域只在检索时出现，没有预算。 */
	budget: { maxChars: number; maxEntries: number } | null;
	chars: number;
	entries: AgentMemoryEntryView[];
}

export interface AgentMemoryEntryList {
	root: string;
	total: number;
	groups: AgentMemoryEntryGroup[];
}

/** 作用域顺序：全局 → 项目 → 设备；同一作用域内按「记忆 / 用户 / 教训 / 常驻」排。 */
const TARGET_ORDER: readonly AgentMemoryTarget[] = ["memory", "user", "failure", "standing"];

function readDirKeys(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((item) => item.isDirectory())
			.map((item) => item.name)
			.sort();
	} catch {
		return [];
	}
}

function buildGroup(root: string, target: AgentMemoryTarget, scope: AgentMemoryScope, projectId: string, projectName: string): AgentMemoryEntryGroup | null {
	const absolute = targetFilePath(root, target, projectId);
	if (!existsSync(absolute)) return null;
	let bytes = 0;
	try {
		bytes = statSync(absolute).size;
	} catch {
		return null;
	}
	const entries = parseEntries(readRaw(absolute)).map((content, index) => ({
		index: index + 1,
		target,
		file: scope === "global" ? TARGET_FILES[target] : `${scope === "device" ? "devices" : "projects"}/${projectId}/${TARGET_FILES[target]}`,
		scope,
		projectId,
		projectName,
		key: normalizeKey(content),
		content,
		chars: content.length,
		category: target === "failure" ? entryCategory(content) : "",
	}));
	if (entries.length === 0) return null;
	return {
		target,
		scope,
		projectId,
		projectName,
		file: entries[0].file,
		bytes,
		budget: scope === "global" ? (FILE_BUDGETS[target] ?? null) : null,
		chars: entries.reduce((sum, entry) => sum + entry.chars, 0),
		entries,
	};
}

/**
 * 读全部记忆条目。
 *
 * `projects` 只用于把目录键翻译成用户认得的项目名（记忆键由会话 cwd 派生，
 * 与 PiDeck 项目 id 不是一回事，所以要按路径反查一次）；匹配不到就显示键本身。
 */
export function readAgentMemoryEntries(input: { root?: string; projects?: () => { name: string; path: string }[] }): AgentMemoryEntryList {
	const root = input.root ?? resolveMemoryRoot();
	const nameByKey = new Map<string, string>();
	// 惰性求值：设置页每次刷新都读一次项目表，但记忆 tab 打开时项目可能已经变了。
	for (const project of input.projects?.() ?? []) {
		const key = projectKeyFromPath(project.path);
		if (key && !nameByKey.has(key)) nameByKey.set(key, project.name);
	}
	const groups: AgentMemoryEntryGroup[] = [];
	const push = (target: AgentMemoryTarget, scope: AgentMemoryScope, projectId: string, projectName: string) => {
		const group = buildGroup(root, target, scope, projectId, projectName);
		if (group) groups.push(group);
	};

	for (const target of TARGET_ORDER) push(target, "global", "", "");
	for (const key of readDirKeys(join(root, "projects"))) {
		for (const target of TARGET_ORDER) push(target, "project", key, nameByKey.get(key) ?? key);
	}
	for (const key of readDirKeys(join(root, "devices"))) {
		for (const target of TARGET_ORDER) push(target, "device", key, key.slice(0, 8));
	}

	return { root, total: groups.reduce((sum, group) => sum + group.entries.length, 0), groups };
}

/**
 * 删除一条记忆。
 *
 * 全局/项目作用域写墓碑（导出包里的旧条目不会再导入回来）；设备作用域的条目本来就
 * 不参与导出导入，写墓碑只会让 tombstones.json 长出一条永不命中的记录，所以跳过。
 */
export function deleteAgentMemoryEntry(root: string | undefined, input: { target: string; projectId?: string; key?: string }): { removed: number } {
	const target = input.target as AgentMemoryTarget;
	if (!(target in TARGET_FILES)) throw new Error("target-invalid");
	const key = typeof input.key === "string" ? input.key.trim() : "";
	if (!key) throw new Error("entry-key-required");
	const projectId = typeof input.projectId === "string" ? input.projectId : "";
	const absolute = targetFilePath(root ?? resolveMemoryRoot(), target, projectId);
	const before = parseEntries(readRaw(absolute));
	const removed = before.filter((content) => normalizeKey(content) === key);
	if (removed.length === 0) return { removed: 0 };
	writeAtomic(absolute, renderEntries(before.filter((content) => normalizeKey(content) !== key)));
	if (!projectId.startsWith("device:")) {
		addTombstone(root ?? resolveMemoryRoot(), {
			target,
			scope: projectId ? "project" : "global",
			projectKey: projectId,
			content: removed[0],
		});
	}
	return { removed: removed.length };
}
