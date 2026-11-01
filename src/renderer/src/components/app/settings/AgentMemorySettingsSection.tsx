import { useCallback, useEffect, useState } from "react";
import { Download, RefreshCw, Upload } from "lucide-react";
import type { AgentMemoryStatus } from "../../../../../shared/types/agentMemory";
import { t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { Button } from "../../ui-shadcn/button";
import { ConfirmDialog } from "../../ui-shadcn/ConfirmDialog";
import { SettingRow } from "./SettingRows";

/** 字节 → 人类可读（记忆量级在 KB~几十 KB，MB 只是兜底）。 */
function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${bytes} B`;
}

/**
 * 失败码 → 可读原因。
 *
 * 显式枚举而不是拼 key：`t()` 的 key 是字面量联合类型，拼出来的字符串拿不到类型检查，
 * 少写一条也只会在运行时悄悄显示 key 名。未知码原样显示，避免「静默失败」。
 */
function describeCode(code: string): string {
	switch (code) {
		case "bundle-invalid":
			return t("settings.agentMemoryErrorBundleInvalid");
		case "bundle-format-unsupported":
			return t("settings.agentMemoryErrorBundleFormat");
		case "bundle-version-unsupported":
			return t("settings.agentMemoryErrorBundleVersion");
		case "bundle-too-large":
			return t("settings.agentMemoryErrorBundleTooLarge");
		case "index-unavailable":
			return t("settings.agentMemoryErrorIndexUnavailable");
		case "operation-failed":
			return t("settings.agentMemoryErrorFailed");
		default:
			return code;
	}
}

/**
 * 常用设置 →「智能体记忆」的状态区。
 *
 * 只读展示 + 三个动作（导出/导入/清空索引）。这三个动作的共同点是**都不改记忆内容语义**：
 * 导出与导入是搬运，清空索引是可重建的缓存（Markdown 真值不动），所以它们都不进 draft/保存流程，
 * 不像开关那样要等「保存设置」。
 *
 * 挂载时读一次、动作后重读：没有订阅——记忆变化的来源是 Agent 会话，设置页开着时它也可能在写，
 * 但设置页不是仪表盘，用户对「刚才那一秒的条目数」没有需求，少一条长连订阅。
 */
export function AgentMemorySettingsSection(props: {
	/** 兄弟面板（条目列表）改过记忆后 +1，让体积/索引统计一起重读。 */
	reloadKey?: number;
	/** 本面板的动作改过记忆后通知兄弟面板刷新。 */
	onChanged?: () => void;
}) {
	const [status, setStatus] = useState<AgentMemoryStatus | null>(null);
	const [busy, setBusy] = useState<"none" | "export" | "import" | "clear">("none");
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [confirmClear, setConfirmClear] = useState(false);

	const refresh = useCallback(async () => {
		const result = await desktopApi.agentMemory.status();
		if (result.ok) setStatus(result.value);
		else setError(describeCode(result.code));
	}, []);
	// 依赖 props.reloadKey：条目列表删完一条后体积/条目数要跟着变。
	useEffect(() => {
		if (props.reloadKey === undefined) return;
		void refresh();
	}, [props.reloadKey, refresh]);

	useEffect(() => {
		void refresh().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
	}, [refresh]);

	const runExport = async () => {
		setBusy("export");
		setError(null);
		setMessage(null);
		try {
			const result = await desktopApi.agentMemory.exportBundle();
			if (!result.ok) setError(describeCode(result.code));
			else if (result.value.canceled) setMessage(null);
			else setMessage(t("settings.agentMemoryExportDone", { count: String(result.value.entries ?? 0) }));
		} finally {
			setBusy("none");
			void refresh();
			props.onChanged?.();
		}
	};

	const runImport = async () => {
		setBusy("import");
		setError(null);
		setMessage(null);
		try {
			const result = await desktopApi.agentMemory.importBundle();
			if (!result.ok) setError(describeCode(result.code));
			else if (result.value.canceled) setMessage(null);
			else
				setMessage(
					t("settings.agentMemoryImportDone", {
						added: String(result.value.added),
						duplicate: String(result.value.duplicate),
						tombstoned: String(result.value.tombstoned),
						device: result.value.device || t("settings.agentMemoryUnknownDevice"),
					}),
				);
		} finally {
			setBusy("none");
			void refresh();
			props.onChanged?.();
		}
	};

	const runClear = async () => {
		setConfirmClear(false);
		setBusy("clear");
		setError(null);
		setMessage(null);
		try {
			const result = await desktopApi.agentMemory.clearIndex();
			if (!result.ok) setError(describeCode(result.code));
			else setMessage(t("settings.agentMemoryClearDone", { count: String(result.value.removed) }));
		} finally {
			setBusy("none");
			void refresh();
			props.onChanged?.();
		}
	};

	const summary = status
		? [
				t("settings.agentMemorySummaryFiles", { size: formatBytes(status.totalBytes), count: String(status.files.reduce((sum, file) => sum + file.entries, 0)) }),
				status.index
					? t("settings.agentMemorySummaryIndex", { sessions: String(status.index.sessions), messages: String(status.index.messages) })
					: t("settings.agentMemoryIndexUnavailable"),
				t("settings.agentMemorySummaryDevice", { device: status.device.name }),
			].join(" · ")
		: t("common.loading");

	return (
		<>
			<SettingRow anchor="memory-usage" title={t("settings.agentMemoryUsage")} description={summary}>
				<span className="flex flex-wrap items-center gap-2">
					<Button type="button" variant="outline" size="sm" disabled={busy !== "none"} onClick={() => void runExport()}>
						<Download size={14} strokeWidth={2} aria-hidden="true" />
						{t("settings.agentMemoryExport")}
					</Button>
					<Button type="button" variant="outline" size="sm" disabled={busy !== "none"} onClick={() => void runImport()}>
						<Upload size={14} strokeWidth={2} aria-hidden="true" />
						{t("settings.agentMemoryImport")}
					</Button>
					<Button type="button" variant="outline" size="sm" disabled={busy !== "none" || !status?.index} onClick={() => setConfirmClear(true)}>
						<RefreshCw size={14} strokeWidth={2} aria-hidden="true" />
						{t("settings.agentMemoryClearIndex")}
					</Button>
				</span>
			</SettingRow>
			{status?.indexError ? (
				<p className="px-4 pb-2 text-xs text-muted-foreground">{t("settings.agentMemoryIndexDegraded", { reason: status.indexError })}</p>
			) : null}
			{error ? <p className="px-4 pb-2 text-xs text-destructive">{error}</p> : null}
			{message ? <p className="px-4 pb-2 text-xs text-muted-foreground">{message}</p> : null}
			{confirmClear ? (
				<ConfirmDialog
					title={t("settings.agentMemoryClearIndex")}
					message={t("settings.agentMemoryClearConfirm")}
					confirmLabel={t("settings.agentMemoryClearIndex")}
					danger
					onConfirm={() => void runClear()}
					onCancel={() => setConfirmClear(false)}
				/>
			) : null}
		</>
	);
}
