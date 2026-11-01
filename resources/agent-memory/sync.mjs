/**
 * 记忆的导出/导入：让多台设备共用同一份长期记忆。
 *
 * ## 为什么是「一个 JSON 文件」而不是数据库文件
 *
 * 真值本来就是可手改的 Markdown，SQLite 只是索引。如果导出数据库，跨设备就得处理
 * 索引版本、rowid、FTS 重建；导出条目则是幂等的——导进去以后索引会按文件重建。
 * 用户还能用任何编辑器看这个包（它就是个带 meta 的条目清单）。
 *
 * ## 合并语义（唯一一套，不给多个模式）
 *
 * - **按内容去重**：`normalizeKey`（折叠空白 + 转小写）相等的条目视为同一条。
 *   记忆是「一句话事实」，不是可并发的文档，内容相同即视为同一条最省心；
 *   不引入条目 id 的好处是 Markdown 保持干净、手改不会打破身份。
 * - **并集**：本地独有与包内独有的都保留，不覆盖、不删本地。
 * - **删除靠墓碑传播**：A 机删掉的条目记一条墓碑（内容哈希），B 机导入时会跳过它
 *   并删掉自己那份。否则「删了又回来」是同步里最烦人的失败模式。
 * - **设备专属记忆不出设备**：`devices/` 下的条目不进包（它们描述本机路径/盘符，
 *   拿到别的机器上是错的），也不参与导入。
 *
 * 刻意**不**实现：双向自动同步、冲突标记、条目级时间戳合并。记忆的量级是几十到几百条，
 * 一次导入几百条是毫秒级；把一个分布式协议塞进来，收益远小于维护成本。
 */

import { randomBytes } from "node:crypto";
import { readdirSync, existsSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";

import { dedupeEntries, formatFailureEntry, normalizeKey, parseEntries, parseFailureEntry, renderEntries, trimEntries } from "./format.mjs";
import { readRaw, writeAtomic } from "./files.mjs";
import { DEVICE_SCOPE_PREFIX, FAILURE_CATEGORIES, FILE_BUDGETS, TARGET_FILES, deviceProfilePath, resolveProjectDir, targetFilePath, tombstonesPath } from "./paths.mjs";
import { scanMemoryContent } from "./scan.mjs";

export const BUNDLE_FORMAT = "pideck-agent-memory";
export const BUNDLE_VERSION = 1;

/** 墓碑只留最近这些条：它只为「不该复活」服务，不是审计日志。 */
const MAX_TOMBSTONES = 500;
/** 一个包最多带多少个项目作用域，防止导入一个巨大文件把磁盘写满。 */
const MAX_BUNDLE_PROJECTS = 200;
/** 单条内容上限与写入路径一致。 */
const MAX_BUNDLE_ENTRY_CHARS = 2000;

const SHARED_TARGETS = ["memory", "user", "standing", "failure"];

function readJsonFile(filePath, fallback) {
	try {
		return JSON.parse(readRaw(filePath));
	} catch {
		return fallback;
	}
}

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* ───────────────────────────── 设备档案 ───────────────────────────── */

/** 设备档案：首次调用时生成并落盘，之后稳定不变（导出包靠它标注来源）。 */
export function readDeviceProfile(root) {
	const existing = readJsonFile(deviceProfilePath(root), null);
	if (isPlainObject(existing) && typeof existing.id === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(existing.id)) {
		return { id: existing.id, name: typeof existing.name === "string" && existing.name.trim() ? existing.name.trim().slice(0, 60) : "unnamed-device" };
	}
	const profile = { id: randomBytes(8).toString("hex"), name: (hostname() || "unnamed-device").trim().slice(0, 60) };
	try {
		writeAtomic(deviceProfilePath(root), `${JSON.stringify(profile, null, 2)}\n`);
	} catch {
		// 只读目录（容器/受管环境）下不阻断记忆功能：id 本次进程内仍然可用
	}
	return profile;
}

/** 设备专属记忆的作用域 id（`device:<key>`），与项目作用域共用文件层。 */
export function deviceScopeId(root) {
	return `${DEVICE_SCOPE_PREFIX}${readDeviceProfile(root).id}`;
}

/* ───────────────────────────── 墓碑 ───────────────────────────── */

/** 读墓碑集合；形状不对就当没有，不让一个坏文件废掉整次导入。 */
export function readTombstones(root) {
	const value = readJsonFile(tombstonesPath(root), []);
	if (!Array.isArray(value)) return [];
	return value.filter((item) => isPlainObject(item) && typeof item.key === "string" && item.key.length > 0).slice(-MAX_TOMBSTONES);
}

/** 记一条墓碑（同 key 只留最新一条）。 */
export function addTombstone(root, { target, scope, projectKey = "", content, at = new Date().toISOString() }) {
	const key = normalizeKey(content);
	if (!key) return;
	const tombstones = readTombstones(root).filter((item) => !(item.key === key && item.target === target && item.scope === scope && item.projectKey === projectKey));
	tombstones.push({ key, target, scope, projectKey, at });
	writeAtomic(tombstonesPath(root), `${JSON.stringify(tombstones.slice(-MAX_TOMBSTONES), null, 2)}\n`);
}

function tombstoneIndex(tombstones) {
	const index = new Set();
	for (const item of tombstones) index.add(`${item.target}|${item.scope}|${item.projectKey}|${item.key}`);
	return index;
}

/* ───────────────────────────── 作用域 ───────────────────────────── */

/** 列的共享作用域：全局四份 + `projects/<key>/` 下真实存在的条目。 */
export function listSharedScopes(root) {
	const scopes = SHARED_TARGETS.map((target) => ({ target, scope: "global", projectId: "" }));
	const projectsDir = path.join(root, "projects");
	if (!existsSync(projectsDir)) return scopes;
	const keys = readdirSync(projectsDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.slice(0, MAX_BUNDLE_PROJECTS);
	for (const key of keys) {
		for (const target of SHARED_TARGETS) {
			// 只为「真的有内容」的作用域生成条目，避免导出包被空作用域撑大
			if (parseEntries(readRaw(targetFilePath(root, target, key))).length === 0) continue;
			scopes.push({ target, scope: "project", projectId: key });
		}
	}
	return scopes;
}

/** 把条目块拆成「语义内容 + 分类」：failure 条目的 `[category]` 前缀单独放。 */
function toBundleEntry(target, scope, projectKey, block) {
	if (target === "failure") {
		const parsed = parseFailureEntry(block);
		return { target, scope, projectKey, content: parsed.content, category: parsed.category };
	}
	return { target, scope, projectKey, content: block };
}

/** 反向：包内条目 → 落盘用的条目块。 */
function fromBundleEntry(entry) {
	if (entry.target !== "failure") return entry.content;
	const category = FAILURE_CATEGORIES.includes(entry.category) ? entry.category : "insight";
	return formatFailureEntry(category, entry.content);
}

/* ───────────────────────────── 导出 ───────────────────────────── */

/**
 * 生成导出包的数据（纯函数，不碰磁盘路径以外的状态）。
 * @returns {{ format: string, version: number, exportedAt: string, device: {id: string, name: string}, entries: object[], tombstones: object[] }}
 */
export function buildExportBundle(root, { exportedAt = new Date().toISOString() } = {}) {
	const device = readDeviceProfile(root);
	const entries = [];
	for (const { target, scope, projectId } of listSharedScopes(root)) {
		for (const block of parseEntries(readRaw(targetFilePath(root, target, projectId)))) {
			entries.push(toBundleEntry(target, scope, projectId, block));
		}
	}
	return { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, exportedAt, device, entries, tombstones: readTombstones(root) };
}

/** 导出包规范化成写盘文本：`2` 空格缩进 + 末尾换行，便于 diff 与手工检查。 */
export function serializeBundle(bundle) {
	return `${JSON.stringify(bundle, null, 2)}\n`;
}

/* ───────────────────────────── 导入 ───────────────────────────── */

/** 校验包结构；不合法直接抛（引导用户看格式而不是半途导入一半）。 */
export function validateBundle(value) {
	if (!isPlainObject(value)) throw new Error("bundle-invalid");
	if (value.format !== BUNDLE_FORMAT) throw new Error("bundle-format-unsupported");
	if (value.version !== BUNDLE_VERSION) throw new Error("bundle-version-unsupported");
	if (!Array.isArray(value.entries)) throw new Error("bundle-invalid");
	return value;
}

/**
 * 合并导入。
 *
 * 顺序：先按包内墓碑删掉本地对应条目，再逐条并入。这样「同一个包里既有删除又有新增」
 * 时语义明确：墓碑优先于新增（同一条内容同时被删和被加，说明对面也没想清楚，保守地删）。
 *
 * @returns {{ added: number, duplicate: number, tombstoned: number, rejected: number, removed: number, scopes: string[], device: string }}
 */
export function mergeBundle(root, value, { localDeviceKey = deviceScopeId(root) } = {}) {
	const bundle = validateBundle(value);
	const localTombstones = readTombstones(root);
	const blocked = tombstoneIndex([...localTombstones, ...(Array.isArray(bundle.tombstones) ? bundle.tombstones : [])]);

	// 1) 按目标分组，减少文件读写次数（一个作用域一次「读 → 改 → 写」）。
	const groups = new Map();
	const groupFor = (target, projectId) => {
		const key = `${target}|${projectId}`;
		if (!groups.has(key)) groups.set(key, { target, projectId, blocks: [], index: null });
		return groups.get(key);
	};
	const scopeNames = new Set();
	let rejected = 0;
	let tombstoned = 0;

	for (const raw of bundle.entries) {
		if (!isPlainObject(raw)) {
			rejected += 1;
			continue;
		}
		// 包里项目作用域记作 target=memory + scope=project；但工具面的说法是 target=project，
		// 手写/旧包两种写法都收（`project` 不是独立文件，只是 memory 的项目目录）。
		const declaredTarget = raw.target === "project" ? "memory" : raw.target;
		const target = SHARED_TARGETS.includes(declaredTarget) ? declaredTarget : "";
		const scope = raw.scope === "project" || raw.target === "project" ? "project" : "global";
		const projectKey = scope === "project" && typeof raw.projectKey === "string" ? raw.projectKey : "";
		// 设备专属条目永不出设备：别的机器的路径类事实在本机是错的，导入只会带来误导。
		// 判空再比：全局条目的 projectKey 也是空串，直接比会把所有全局记忆当设备记忆拒掉。
		if (raw.scope === "device" || (localDeviceKey && raw.projectKey === localDeviceKey)) {
			rejected += 1;
			continue;
		}
		if (!target || (scope === "project" && !projectKey)) {
			rejected += 1;
			continue;
		}
		const content = typeof raw.content === "string" ? raw.content.trim() : "";
		if (!content || content.length > MAX_BUNDLE_ENTRY_CHARS) {
			rejected += 1;
			continue;
		}
		// 从别的设备来的内容同样是不可信输入：不可见字符/注入模板/密钥一律不入库。
		if (scanMemoryContent(content)) {
			rejected += 1;
			continue;
		}
		const block = fromBundleEntry({ ...raw, target, scope, projectKey, content });
		const key = normalizeKey(target === "failure" ? parseFailureEntry(block).content : block);
		const tombKey = `${target}|${scope}|${projectKey}|${key}`;
		if (blocked.has(tombKey)) {
			tombstoned += 1;
			continue;
		}
		const group = groupFor(target, projectKey);
		if (!group.index) {
			const entries = dedupeEntries(parseEntries(readRaw(targetFilePath(root, target, projectKey))));
			group.index = new Set(entries.map((entry) => normalizeKey(target === "failure" ? parseFailureEntry(entry).content : entry)));
			group.blocks = entries;
		}
		if (group.index.has(key)) {
			group.duplicate = (group.duplicate ?? 0) + 1;
			continue;
		}
		group.index.add(key);
		group.blocks.push(block);
		scopeNames.add(scope === "project" ? `project:${projectKey}` : `${target}:global`);
	}

	// 2) 落盘（每份文件都过一遍预算裁剪；只有真的变了才写）。
	let added = 0;
	let duplicate = 0;
	for (const group of groups.values()) {
		duplicate += group.duplicate ?? 0;
		if (group.blocks.length === 0) continue;
		const before = parseEntries(readRaw(targetFilePath(root, group.target, group.projectId)));
		const trimmed = trimEntries(group.blocks, FILE_BUDGETS[group.target]);
		added += Math.max(0, trimmed.entries.length - before.length);
		writeAtomic(targetFilePath(root, group.target, group.projectId), renderEntries(trimmed.entries));
	}

	// 3) 墓碑落地：删掉本地还留着的同一条内容，并把墓碑记到本地（下次导入同样被挡住）。
	const removals = [];
	for (const item of Array.isArray(bundle.tombstones) ? bundle.tombstones : []) {
		if (!isPlainObject(item) || typeof item.key !== "string") continue;
		const target = SHARED_TARGETS.includes(item.target) ? item.target : "";
		if (!target) continue;
		const sourcePath = targetFilePath(root, target, typeof item.projectKey === "string" ? item.projectKey : "");
		const entries = parseEntries(readRaw(sourcePath));
		const kept = entries.filter((entry) => normalizeKey(target === "failure" ? parseFailureEntry(entry).content : entry) !== item.key);
		if (kept.length !== entries.length) {
			writeAtomic(sourcePath, renderEntries(kept));
			removals.push({ target, projectKey: item.projectKey ?? "" });
		}
		if (!localTombstones.some((local) => local.key === item.key && local.target === item.target)) {
			addTombstone(root, { target, scope: item.scope === "project" ? "project" : "global", projectKey: item.projectKey ?? "", content: item.key, at: item.at });
		}
	}

	return {
		added,
		duplicate,
		tombstoned,
		rejected,
		removed: removals.length,
		scopes: [...scopeNames].sort(),
		device: isPlainObject(bundle.device) && typeof bundle.device.name === "string" ? bundle.device.name : "",
	};
}

/** 统计包内条目数（设置页在确认导入前显示「这个包含 N 条」）。 */
export function countBundleEntries(value) {
	const bundle = validateBundle(value);
	return { entries: bundle.entries.length, device: isPlainObject(bundle.device) && typeof bundle.device.name === "string" ? bundle.device.name : "", exportedAt: typeof bundle.exportedAt === "string" ? bundle.exportedAt : "" };
}
