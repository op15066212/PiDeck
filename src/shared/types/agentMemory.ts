/**
 * 智能体记忆（`pideck-agent-memory`）的设置页契约。
 *
 * 这些类型只描述**宿主进程给渲染层的只读视图**；真正的读写语义在
 * `resources/agent-memory/*.mjs`（MCP 服务器）里，两边共用同一份文件与索引。
 */

export interface AgentMemoryFileStat {
	/** 相对记忆根目录的位置；项目作用域形如 `projects/<key>/MEMORY.md`。 */
	name: string;
	bytes: number;
	entries: number;
	/** 注入预算；`null` 表示这份文件不参与预算（项目/设备作用域只在检索时出现）。 */
	budget: { maxChars: number; maxEntries: number } | null;
}

export interface AgentMemoryStatus {
	/** 记忆根目录（userData/memory）；显示给用户前渲染层负责省略号截断。 */
	root: string;
	/** Markdown 总字节数（不含索引库）。 */
	totalBytes: number;
	indexBytes: number;
	files: AgentMemoryFileStat[];
	index: { entries: number; sessions: number; messages: number } | null;
	/** 索引不可用时的原因码（`node:sqlite` 缺失、库损坏等）。 */
	indexError: string | null;
	/** 本机设备档案：导出包用它标注来源。 */
	device: { id: string; name: string };
}

export interface AgentMemoryExportOutcome {
	canceled: boolean;
	/** 用户取消时没有路径。 */
	path?: string;
	entries?: number;
}

export interface AgentMemoryImportResult {
	canceled?: boolean;
	added: number;
	duplicate: number;
	tombstoned: number;
	rejected: number;
	removed: number;
	scopes: string[];
	/** 包内标注的来源设备名（旧包可能为空）。 */
	device: string;
}

/** 统一结果信封：错误只以稳定码跨进程，不带本机路径。 */
export type AgentMemoryResult<T> = { ok: true; value: T } | { ok: false; code: string };
