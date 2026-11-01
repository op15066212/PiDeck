/**
 * 智能体记忆的设置页 IPC：只读状态快照 + 清空索引 + 导出/导入。
 *
 * 这里刻意只给主框架放行（`sender !== 主 frame` 一律拒绝）：宿主插件、内置浏览器 guest
 * 与局域网 Web 客户端都够不到记忆文件——记忆里可能含账号路径、私有约定，属于本机数据。
 */

import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";

import { ipcChannels } from "../../shared/ipc";
import type { AgentMemoryExportOutcome, AgentMemoryImportResult, AgentMemoryResult, AgentMemoryStatus } from "../../shared/types/agentMemory";

export interface AgentMemoryIpcDeps {
	getWindow: () => BrowserWindow | null;
	readStatus: () => AgentMemoryStatus;
	clearIndex: () => { removed: number };
	/** 弹保存对话框并写文件；用户取消时返回 `{ canceled: true }`。 */
	exportBundle: () => Promise<AgentMemoryExportOutcome>;
	/** 弹打开对话框并合并；格式非法时抛错（不落盘）。 */
	importBundle: (options: { filePath?: string }) => Promise<AgentMemoryImportResult>;
	warn: (code: string) => void;
}

export function registerAgentMemoryIpc(deps: AgentMemoryIpcDeps): () => void {
	const channels = [ipcChannels.agentMemoryStatus, ipcChannels.agentMemoryClearIndex, ipcChannels.agentMemoryExport, ipcChannels.agentMemoryImport];

	/** 统一包成 `{ok,value}` / `{ok:false,code}`：渲染层不需要猜错误形态，异常码也不会带出本机路径。 */
	async function result<T>(event: IpcMainInvokeEvent, run: () => Promise<T> | T): Promise<AgentMemoryResult<T>> {
		try {
			const window = deps.getWindow();
			if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error("sender-not-authorized");
			return { ok: true, value: await run() };
		} catch (error) {
			const code = error instanceof Error && /^[a-z-]{1,80}$/.test(error.message) ? error.message : "operation-failed";
			deps.warn(code);
			return { ok: false, code };
		}
	}

	ipcMain.handle(ipcChannels.agentMemoryStatus, (event) => result(event, () => deps.readStatus()));
	ipcMain.handle(ipcChannels.agentMemoryClearIndex, (event) => result(event, () => deps.clearIndex()));
	// 导出没有可选参数：`devices/` 下的设备专属记忆按定义不出设备，不给渲染层留「带上它」的开关。
	ipcMain.handle(ipcChannels.agentMemoryExport, (event) => result(event, () => deps.exportBundle()));
	ipcMain.handle(ipcChannels.agentMemoryImport, (event, input: unknown) =>
		result(event, () => {
			const filePath = typeof input === "object" && input !== null ? (input as { filePath?: unknown }).filePath : undefined;
			return deps.importBundle({ filePath: typeof filePath === "string" && filePath.length > 0 ? filePath : undefined });
		}),
	);

	return () => {
		for (const channel of channels) ipcMain.removeHandler(channel);
	};
}
