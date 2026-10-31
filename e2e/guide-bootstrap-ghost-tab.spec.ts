import { test, expect } from "./mock-pi-fixture";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 引导页首发不产生「未命名」幽灵 Tab（行为回归）。
 *
 * 项目空态挂的是只活在渲染层的虚拟会话 `renderer:guide-bootstrap`（无 catalog 记录）：
 * 统一发送入口在 send 之前先按「预览 Tab 晋升常驻」调 onPromoteSession，把这个虚拟 id
 * 尾插进 sessionTabIds —— Tab 栏于是多出一张取不到 record 的「未命名」标签（点击 no-op，
 * 且清理逻辑按「见过又消失」判定，虚拟 id 从未进过 sessionRecords，永远清不掉），
 * 真实会话的 Tab 排在它后面。
 *
 * 断言「恰好 1 个 Tab 且没有未命名 Tab」：修复前这里是 2 个（幽灵 + 真实会话）。
 */

// 目录前缀避开 isEphemeralProjectPath 过滤名单（否则启动时被当残留清掉，项目行缺失）
const projectDir = mkdtempSync(join(tmpdir(), "pideck-seed-guide-ghost-"));

const PROJECT_NAME = "GuideGhostE2E";

test.use({
	seedProjects: [{ id: "e2e-guide-ghost", name: PROJECT_NAME, path: projectDir }],
});

test("first send from the project empty state leaves exactly one named tab", async ({ window }) => {
	test.setTimeout(150_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	// 侧栏默认停在「聊天」分段，工作区项目行在「项目」分段下，先切换。
	// 行文案是项目显示名（不是磁盘目录名），且 56469f95 侧栏分段重构后行节点不再是 .conversation。
	await window.getByRole("tab", { name: "项目" }).click();
	// 点项目行只选中项目（不建会话）→ 会话区是引导页空态，下面的 composer 即虚拟会话输入框
	await window.getByText(PROJECT_NAME, { exact: true }).first().click();

	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	// 发送前：空态不占 Tab 栏（虚拟会话不登记）
	await expect(window.locator('.session-tabs-bar [role="tab"]')).toHaveCount(0, { timeout: 10_000 });

	await composer.click();
	await window.keyboard.type("引导页首发");
	await window.keyboard.press("Enter");
	await expect(window.locator(".message-timeline")).toContainText("Mock 回复：「引导页首发」", { timeout: 20_000 });

	// 恰好一个 Tab —— 修复前这里会是 2 个（幽灵 Tab + 真实会话 Tab）
	const tabs = window.locator('.session-tabs-bar [role="tab"]');
	await expect(tabs).toHaveCount(1, { timeout: 10_000 });
	// 幽灵 Tab 取不到 record，标题回落到「未命名」
	await expect(window.locator('.session-tabs-bar [role="tab"]', { hasText: "未命名" })).toHaveCount(0);
});
