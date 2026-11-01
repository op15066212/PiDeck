/**
 * 记忆包的导出/导入：对话框与文件 IO 都在主进程，合并语义在
 * `resources/agent-memory/sync.mjs`（与 MCP 服务器共用一份实现，纯函数、可直接单测）。
 *
 * 两个约束：
 * 1. **导入前先完整校验**：格式不对就抛，绝不出现「导了一半」的中间态。
 * 2. **导出不打包设备专属记忆**：`devices/` 下的条目描述本机路径与盘符，
 *    拿到另一台机器上是错的（`sync.mjs` 的 `listSharedScopes` 已排除）。
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { dialog, type BrowserWindow } from "electron";

import { buildExportBundle, mergeBundle, readDeviceProfile, serializeBundle, validateBundle } from "../../../resources/agent-memory/sync.mjs";
import type { AgentMemoryExportOutcome, AgentMemoryImportResult } from "../../shared/types/agentMemory";

/** 文件名里不能出现的字符（Windows 比 POSIX 严），设备名来自 hostname，必须清洗。 */
function safeFilePart(value: string): string {
	return value.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "device";
}

function timestampForFileName(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

export async function exportAgentMemoryBundle(input: { root: string; getWindow: () => BrowserWindow | null; now?: Date }): Promise<AgentMemoryExportOutcome> {
	const now = input.now ?? new Date();
	const device = readDeviceProfile(input.root);
	const window = input.getWindow();
	const options = {
		title: "导出智能体记忆",
		defaultPath: join(process.env.USERPROFILE ?? process.cwd(), `pideck-memory-${safeFilePart(device.name)}-${timestampForFileName(now)}.json`),
		filters: [{ name: "PiDeck 记忆包", extensions: ["json"] }],
	};
	const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
	if (result.canceled || !result.filePath) return { canceled: true };
	const bundle = buildExportBundle(input.root, { exportedAt: now.toISOString() });
	await writeFile(result.filePath, serializeBundle(bundle), "utf8");
	return { canceled: false, path: result.filePath, entries: bundle.entries.length };
}

export async function importAgentMemoryBundle(input: { root: string; getWindow: () => BrowserWindow | null; filePath?: string }): Promise<AgentMemoryImportResult> {
	let filePath = input.filePath;
	if (!filePath) {
		const window = input.getWindow();
		const options = { title: "导入智能体记忆", properties: ["openFile" as const], filters: [{ name: "PiDeck 记忆包", extensions: ["json"] }] };
		const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
		if (result.canceled || result.filePaths.length === 0) return { canceled: true, added: 0, duplicate: 0, tombstoned: 0, rejected: 0, removed: 0, scopes: [], device: "" };
		filePath = result.filePaths[0];
	}
	const text = await readFile(filePath, "utf8");
	// 包体积上限：记忆是百量级条目，几十 MB 的「记忆包」一定是选错文件了。
	if (text.length > 16 * 1024 * 1024) throw new Error("bundle-too-large");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("bundle-invalid");
	}
	// 先校验再合并：格式不对时不留任何落盘痕迹。
	validateBundle(parsed);
	return mergeBundle(input.root, parsed);
}
