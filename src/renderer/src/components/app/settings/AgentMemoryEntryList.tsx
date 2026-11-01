/**
 * 「记忆」tab 的条目浏览器：把 Markdown 真值逐条列出来，可展开看全文、可删除单条。
 *
 * 只读 + 删除。为什么不做编辑：改写一条记忆的语义（去重键、预算裁剪、墓碑）
 * 全在工具层（`memory_add/replace/remove`），设置页做一份编辑器就等于把那些规则抄第二遍；
 * 想改内容就让 Agent 改，想改措辞就删掉再说一遍。
 *
 * 列表按「作用域 → 文件」分组：用户要判断一条记忆该不该在，首先得知道它落在哪个文件里
 * （全局四份 / 某个项目 / 本机设备），否则「为什么 DSH 会话看不到」这类问题无从解释。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import type { AgentMemoryEntry, AgentMemoryEntryGroup, AgentMemoryEntryList } from "../../../../../shared/types/agentMemory";
import { t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { ConfirmDialog } from "../../ui-shadcn/ConfirmDialog";

/** 列表为空时的提示：与设置页其它空状态同一套淡字排版。 */
function EmptyHint(props: { text: string }) {
	return <p className="px-4 pb-2 text-xs text-muted-foreground">{props.text}</p>;
}

/** 失败码 → 可读原因；未知码原样显示，避免静默失败。 */
function describeCode(code: string): string {
	switch (code) {
		case "invalid-input":
		case "operation-failed":
			return t("settings.agentMemoryErrorFailed");
		default:
			return code;
	}
}

function targetLabel(target: AgentMemoryEntry["target"]): string {
	switch (target) {
		case "memory":
			return t("settings.agentMemoryTargetMemory");
		case "user":
			return t("settings.agentMemoryTargetUser");
		case "failure":
			return t("settings.agentMemoryTargetFailure");
		default:
			return t("settings.agentMemoryTargetStanding");
	}
}

function scopeLabel(group: AgentMemoryEntryGroup): string {
	if (group.scope === "global") return t("settings.agentMemoryScopeGlobal");
	if (group.scope === "device") return t("settings.agentMemoryScopeDevice", { device: group.projectName });
	return group.projectName || group.projectId;
}

/** 条目身份：同一段内容可能同时存在于全局与项目作用域，所以键里必须带作用域。 */
function entryId(entry: AgentMemoryEntry): string {
	return `${entry.scope}|${entry.projectId}|${entry.target}|${entry.key}`;
}

export function AgentMemoryEntryList(props: {
	/** 兄弟面板（导出/导入/清空索引）改过记忆后 +1。 */
	reloadKey?: number;
	/** 本面板删过条目后通知兄弟面板刷新统计。 */
	onChanged?: () => void;
}) {
	const [data, setData] = useState<AgentMemoryEntryList | null>(null);
	const [query, setQuery] = useState("");
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});
	const [busyKey, setBusyKey] = useState<string | null>(null);
	const [pending, setPending] = useState<AgentMemoryEntry | null>(null);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		const result = await desktopApi.agentMemory.list();
		if (result.ok) {
			setData(result.value);
			setError(null);
		} else setError(describeCode(result.code));
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh, props.reloadKey]);

	const needle = query.trim().toLowerCase();
	// 过滤在渲染层做：记忆总量有预算封顶（几万字），一次全量拿到前端比每条搜索都往主进程跑一次稳。
	const groups = useMemo(() => {
		if (!data) return [];
		if (!needle) return data.groups;
		return data.groups
			.map((group) => ({
				...group,
				entries: group.entries.filter((entry) => `${entry.content}\n${targetLabel(entry.target)}\n${scopeLabel(group)}`.toLowerCase().includes(needle)),
			}))
			.filter((group) => group.entries.length > 0);
	}, [data, needle]);
	const shown = groups.reduce((sum, group) => sum + group.entries.length, 0);

	const runDelete = async () => {
		const entry = pending;
		setPending(null);
		if (!entry) return;
		setBusyKey(entryId(entry));
		setError(null);
		try {
			const result = await desktopApi.agentMemory.deleteEntry({ target: entry.target, projectId: entry.projectId, key: entry.key });
			if (!result.ok) setError(describeCode(result.code));
			else {
				await refresh();
				props.onChanged?.();
			}
		} finally {
			setBusyKey(null);
		}
	};

	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-2 px-4">
				<Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("settings.agentMemorySearchPlaceholder")} className="h-8 max-w-sm text-xs" />
				<span className="text-xs text-muted-foreground">{data ? t("settings.agentMemoryEntriesCount", { shown: String(shown), total: String(data.total) }) : t("common.loading")}</span>
			</div>
			{error ? <p className="px-4 text-xs text-destructive">{error}</p> : null}
			{data && data.total === 0 ? <EmptyHint text={t("settings.agentMemoryEmpty")} /> : null}
			{data && data.total > 0 && shown === 0 ? <EmptyHint text={t("settings.agentMemoryNoMatch")} /> : null}
			<div className="flex flex-col divide-y divide-border-subtle">
				{groups.map((group) => (
					<div key={`${group.scope}|${group.projectId}|${group.target}`} className="flex flex-col">
						<div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 pt-3 pb-1 text-xs text-muted-foreground">
							<span className="rounded-sm bg-muted px-1.5 py-0.5 text-foreground">{scopeLabel(group)}</span>
							<span>{targetLabel(group.target)}</span>
							<span className="font-mono opacity-70">{group.file}</span>
							<span className="tabular-nums">
								{group.budget
									? t("settings.agentMemoryGroupBudget", { count: String(group.entries.length), chars: String(group.chars), maxChars: String(group.budget.maxChars), maxEntries: String(group.budget.maxEntries) })
									: t("settings.agentMemoryGroupPlain", { count: String(group.entries.length), chars: String(group.chars) })}
							</span>
						</div>
						{group.entries.map((entry) => {
							const id = entryId(entry);
							const open = expanded[id] === true;
							return (
								<div key={id} className="px-4 py-2">
									<div className="flex items-start gap-2">
										<button type="button" className="min-w-0 flex-1 text-left text-sm text-foreground hover:text-primary" aria-expanded={open} onClick={() => setExpanded((current) => ({ ...current, [id]: !open }))}>
											<span className="mr-1 inline-flex align-text-bottom text-muted-foreground">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
											{/* 折叠态只显示首行：记忆条目是纯文本，首行通常就是结论 */}
											<span className={open ? "whitespace-pre-wrap break-words" : "line-clamp-2 break-words"}>{open ? entry.content : entry.content.split("\n")[0]}</span>
										</button>
										<span className="flex shrink-0 items-center gap-2">
											{entry.category ? <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{entry.category}</span> : null}
											<span className="text-[11px] tabular-nums text-muted-foreground">{t("settings.agentMemoryEntryChars", { chars: String(entry.chars) })}</span>
											<Button type="button" variant="ghost" size="icon-sm" aria-label={t("settings.agentMemoryDeleteEntry")} disabled={busyKey === id} onClick={() => setPending(entry)}>
												<Trash2 size={14} strokeWidth={2} aria-hidden="true" />
											</Button>
										</span>
									</div>
								</div>
							);
						})}
					</div>
				))}
			</div>
			{pending ? (
				<ConfirmDialog
					title={t("settings.agentMemoryDeleteEntry")}
					message={t("settings.agentMemoryDeleteEntryConfirm", { content: pending.content.length > 160 ? `${pending.content.slice(0, 160)}…` : pending.content })}
					confirmLabel={t("settings.agentMemoryDeleteEntry")}
					danger
					onConfirm={() => void runDelete()}
					onCancel={() => setPending(null)}
				/>
			) : null}
		</div>
	);
}
