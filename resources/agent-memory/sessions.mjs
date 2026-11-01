/**
 * 会话采集：把「已经落盘的会话」解析成统一的 `{ session, messages }` 再喂给索引。
 *
 * M2 覆盖范围与理由：
 * - **pi**：`sessions/<编码目录>/<时间戳>_<id>.jsonl`，一行一个事件，`type:"message"` 里带
 *   `message.role/content`。system 消息带整份系统提示（含工具表），必须跳过——它既不是对话，
 *   也不会有人去检索，入库只会把索引撑爆。
 * - **ACP**：`<userData>/acp-sessions/<sha1>.json` 的归档信封，`messages[].text` 是纯文本。
 * - **DSH 不在这里采集**：它的会话是带格式代（v0→v4 相邻迁移）的事件日志，且 DSH 自带
 *   `session_query` 系列工具能查自己的历史。在这里另写一套解析器等于复刻格式目录 + 迁移链，
 *   是纯粹的重复实现；DSH 侧的会话回忆交给它自己的工具。
 *
 * 增量：以 (size, mtime) 为指纹，没变就跳过整份文件——会话是 append-only 的，
 * 变了就整段重灌（单会话几百条，成本远小于做增量 diff）。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { replaceSession, sessionFileMeta } from "./db.mjs";
import { MAX_INDEXED_MESSAGE_CHARS, projectKeyFromPath } from "./paths.mjs";

/** 单份会话文件的读取上限：超大文件直接跳过，宁可漏索引也不让 MCP 进程吃满内存。 */
const MAX_SESSION_FILE_BYTES = 64 * 1024 * 1024;
/** 单会话入库消息上限（保留最近的 N 条）。 */
const MAX_MESSAGES_PER_SESSION = 2000;
/** JSONL 单行上限：坏行直接丢弃，不尝试修复。 */
const MAX_LINE_CHARS = 512 * 1024;

/** 从 content 数组里抽纯文本；工具调用/结果/思考块只留可检索的痕迹。 */
function extractText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	const tools = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		// 工具名入库（便于「上次那个 grep 是怎么用的」这类检索），工具结果不入库（体量不可控）。
		else if ((block.type === "tool_use" || block.type === "toolCall") && typeof block.name === "string") tools.push(block.name);
	}
	return { text: parts.join("\n").trim(), tools };
}

function clip(text) {
	const value = String(text ?? "");
	return value.length > MAX_INDEXED_MESSAGE_CHARS ? `${value.slice(0, MAX_INDEXED_MESSAGE_CHARS)}…` : value;
}

/**
 * 解析一份 pi 会话 JSONL。
 * @returns {{ session: object, messages: object[] }}
 */
export function parsePiSession(filePath, text, { project = "" } = {}) {
	let id = "";
	let cwd = "";
	let startedAt = "";
	let endedAt = "";
	const messages = [];
	for (const rawLine of text.split("\n")) {
		if (!rawLine || rawLine.length > MAX_LINE_CHARS) continue;
		let entry;
		try {
			entry = JSON.parse(rawLine);
		} catch {
			continue; // 半截行（正在写）/损坏行：跳过即可，下次指纹变化时会重灌。
		}
		if (!entry || typeof entry !== "object") continue;
		if (entry.type === "session") {
			id = typeof entry.id === "string" ? entry.id : id;
			cwd = typeof entry.cwd === "string" ? entry.cwd : cwd;
			startedAt = typeof entry.timestamp === "string" ? entry.timestamp : startedAt;
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (!message || typeof message !== "object") continue;
		const role = message.role;
		// system：整份系统提示，跳过（见文件头）。tool：工具结果回填，体量不可控且不值得检索。
		if (role !== "user" && role !== "assistant") continue;
		const extracted = extractText(message.content);
		const text2 = typeof extracted === "string" ? extracted : extracted.text;
		const tools = typeof extracted === "string" ? [] : extracted.tools;
		if (!text2 && tools.length === 0) continue;
		const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : typeof message.timestamp === "number" ? new Date(message.timestamp).toISOString() : "";
		if (timestamp) endedAt = timestamp;
		messages.push({
			id: typeof entry.id === "string" && entry.id ? entry.id : `${filePath}#${messages.length}`,
			role,
			content: clip(tools.length > 0 ? `${text2}\n[tools] ${tools.join(" ")}` : text2),
			timestamp,
			toolCalls: tools,
		});
	}
	if (!id) id = path.basename(filePath).replace(/\.jsonl$/i, "");
	// 项目归属优先用采集源显式指定的值；否则由会话自己的 cwd 派生。
	// 宿主只给一个 sessions 根目录（所有项目混在一起），cwd 才是唯一可用的项目线索。
	const derivedProject = project || (cwd ? projectKeyFromPath(cwd) : "");
	return {
		session: { id, backend: "pi", project: derivedProject, cwd, startedAt, endedAt, filePath },
		messages: messages.slice(-MAX_MESSAGES_PER_SESSION),
	};
}

/** 解析 ACP 归档信封（`AcpSessionArchive` 落的 JSON）。 */
export function parseAcpArchive(filePath, text, { project = "" } = {}) {
	let payload;
	try {
		payload = JSON.parse(text);
	} catch {
		return undefined; // 半截 JSON / 非归档文件：当作没有，不阻断整批采集。
	}
	if (!payload || typeof payload !== "object" || !Array.isArray(payload.messages)) return undefined;
	const messages = [];
	for (const message of payload.messages) {
		if (!message || typeof message !== "object") continue;
		const role = message.role;
		if (role !== "user" && role !== "assistant") continue;
		const content = clip(message.text);
		if (!content) continue;
		const timestamp = typeof message.timestamp === "number" ? new Date(message.timestamp).toISOString() : "";
		messages.push({ id: typeof message.id === "string" && message.id ? message.id : `${filePath}#${messages.length}`, role, content, timestamp, toolCalls: [] });
	}
	const acpSessionId = typeof payload.acpSessionId === "string" && payload.acpSessionId ? payload.acpSessionId : path.basename(filePath).replace(/\.json$/i, "");
	const endedAt = typeof payload.updatedAt === "number" ? new Date(payload.updatedAt).toISOString() : "";
	return {
		session: { id: `acp:${acpSessionId}`, backend: "acp", project, cwd: "", startedAt: messages[0]?.timestamp ?? "", endedAt, filePath },
		messages: messages.slice(-MAX_MESSAGES_PER_SESSION),
	};
}

/** 递归列出目录下的会话文件（pi 的 sessions 是「编码目录/文件」两层）。 */
export function listSessionFiles(dir, pattern) {
	const found = [];
	const walk = (current, depth) => {
		if (depth > 3) return;
		let entries;
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			return; // 目录不存在/无权限：没有会话，不是错误。
		}
		for (const entry of entries) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) walk(full, depth + 1);
			else if (entry.isFile() && pattern.test(entry.name)) found.push(full);
		}
	};
	walk(dir, 0);
	return found;
}

/**
 * 采集一批来源目录。
 * @param {string} root 记忆根目录
 * @param {Array<{ backend: "pi"|"acp", dir: string, project?: string }>} sources
 * @returns {{ indexed: number, skipped: number, failed: number, sessions: number }}
 */
export function indexSources(root, sources) {
	const result = { indexed: 0, skipped: 0, failed: 0, sessions: 0 };
	for (const source of sources) {
		const isAcp = source.backend === "acp";
		const files = listSessionFiles(source.dir, isAcp ? /\.json$/i : /\.jsonl$/i);
		for (const filePath of files) {
			let stat;
			try {
				stat = statSync(filePath);
			} catch {
				result.failed += 1;
				continue;
			}
			if (!stat.isFile() || stat.size === 0 || stat.size > MAX_SESSION_FILE_BYTES) {
				result.skipped += 1;
				continue;
			}
			const previous = sessionFileMeta(root, filePath);
			if (previous && previous.size === stat.size && previous.mtimeMs === Math.round(stat.mtimeMs)) {
				result.skipped += 1;
				continue;
			}
			let text;
			try {
				text = readFileSync(filePath, "utf8");
			} catch {
				result.failed += 1;
				continue;
			}
			const parsed = isAcp ? parseAcpArchive(filePath, text, { project: source.project ?? "" }) : parsePiSession(filePath, text, { project: source.project ?? "" });
			if (!parsed) {
				result.failed += 1;
				continue;
			}
			parsed.session.size = stat.size;
			parsed.session.mtimeMs = Math.round(stat.mtimeMs);
			if (replaceSession(root, parsed.session, parsed.messages)) {
				result.indexed += 1;
				result.sessions += 1;
			} else {
				result.failed += 1;
			}
		}
	}
	return result;
}
