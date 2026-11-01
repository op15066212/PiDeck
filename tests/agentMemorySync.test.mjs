/**
 * 记忆导出/导入与设备作用域的行为守卫。
 *
 * 关注点（多设备共用的全部承诺）：
 * 1. 导出包只含全局与项目作用域，**设备专属记忆永不进包**；
 * 2. 导入是并集：去重、按预算裁剪、坏条目计入 rejected 而不是中断整次导入；
 * 3. 删除靠墓碑传播：本机删掉的内容不会因为导入旧包而复活；
 * 4. 设备作用域真的落 `devices/<本机键>/`，检索能命中并标 scope=device。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildExportBundle, countBundleEntries, mergeBundle, readDeviceProfile, readTombstones, serializeBundle, validateBundle } from "../resources/agent-memory/sync.mjs";
import { addMemory, memoryStatus, removeMemory, searchMemory } from "../resources/agent-memory/tools.mjs";

function freshRoot() {
	return mkdtempSync(join(tmpdir(), "pideck-agent-memory-sync-"));
}

/** 伪造「另一台设备」打的包：不经过本机导出路径，直接构造形状。 */
function bundleOf(entries, overrides = {}) {
	return {
		format: "pideck-agent-memory",
		version: 1,
		exportedAt: "2026-01-01T00:00:00.000Z",
		device: { id: "otherdevice", name: "办公室台式" },
		entries,
		tombstones: [],
		...overrides,
	};
}

test("设备档案：首次生成后稳定，导出包带上它", () => {
	const root = freshRoot();
	const first = readDeviceProfile(root);
	assert.match(first.id, /^[a-f0-9]{16}$/);
	const second = readDeviceProfile(root);
	assert.equal(second.id, first.id, "重新读取必须拿到同一个 id，否则导出包无法标注来源");
	const bundle = buildExportBundle(root);
	assert.equal(bundle.device.id, first.id);
	assert.equal(bundle.format, "pideck-agent-memory");
	assert.equal(bundle.version, 1);
});

test("导出：含全局与项目作用域，不含设备专属记忆", () => {
	const root = freshRoot();
	addMemory(root, { target: "memory", content: "全局：回答用中文" });
	addMemory(root, { target: "user", content: "用户是后端工程师" });
	addMemory(root, { target: "failure", content: "不要用 rm -rf 清理构建目录", category: "correction" });
	addMemory(root, { target: "project", projectId: "proj-a", content: "项目 A 用 pnpm" });
	addMemory(root, { target: "device", content: "D 盘是数据盘" });

	const bundle = buildExportBundle(root);
	const contents = bundle.entries.map((entry) => entry.content);
	assert.ok(contents.includes("全局：回答用中文"));
	assert.ok(contents.includes("用户是后端工程师"));
	assert.ok(contents.includes("项目 A 用 pnpm"));
	assert.ok(!contents.includes("D 盘是数据盘"), "设备专属记忆描述本机路径，拿到别的机器上是错的");
	const failure = bundle.entries.find((entry) => entry.target === "failure");
	assert.equal(failure.category, "correction", "failure 的分类要随包走，否则导入后按类统计会漂移");
	assert.equal(failure.scope, "global");
	assert.equal(bundle.entries.find((entry) => entry.content === "项目 A 用 pnpm").scope, "project");

	// 序列化后必须是能直接给 JSON.parse 的文本（导入端就是这么读的）
	const roundTrip = JSON.parse(serializeBundle(bundle));
	assert.deepEqual(roundTrip, bundle);
	assert.equal(countBundleEntries(roundTrip).entries, 4);
});

test("导入：并集合并、按内容去重、不改动本地独有条目", () => {
	const root = freshRoot();
	addMemory(root, { target: "memory", content: "本机已有：偏好中文" });
	const result = mergeBundle(
		root,
		bundleOf([
			{ target: "memory", scope: "global", projectKey: "", content: "本机已有：偏好中文" },
			{ target: "memory", scope: "global", projectKey: "", content: "来自另一台：用 vim 编辑" },
			{ target: "project", scope: "project", projectKey: "proj-a", content: "项目 A 用 pnpm" },
		]),
	);
	assert.equal(result.added, 2);
	assert.equal(result.duplicate, 1);
	assert.equal(result.device, "办公室台式");
	const file = readFileSync(join(root, "MEMORY.md"), "utf8");
	assert.ok(file.includes("本机已有：偏好中文"));
	assert.ok(file.includes("来自另一台：用 vim 编辑"));
	assert.ok(readFileSync(join(root, "projects", "proj-a", "MEMORY.md"), "utf8").includes("项目 A 用 pnpm"));
	// 幂等：再导一次什么都不新增
	const again = mergeBundle(root, bundleOf([{ target: "memory", scope: "global", projectKey: "", content: "来自另一台：用 vim 编辑" }]));
	assert.equal(again.added, 0);
	assert.equal(again.duplicate, 1);
});

test("导入：坏条目计入 rejected，不中断整次导入也不落盘", () => {
	const root = freshRoot();
	const result = mergeBundle(
		root,
		bundleOf([
			{ target: "memory", scope: "global", projectKey: "", content: "正常条目" },
			// 不可见字符：跨设备输入同样是不可信输入
			{ target: "memory", scope: "global", projectKey: "", content: "注入\u200b字符" },
			// 未知 target
			{ target: "settings", scope: "global", projectKey: "", content: "越权目标" },
			// 项目作用域缺 projectKey
			{ target: "memory", scope: "project", projectKey: "", content: "没有项目键" },
			// 超长
			{ target: "memory", scope: "global", projectKey: "", content: "x".repeat(2100) },
			{ target: "memory", scope: "global", projectKey: "", content: "   " },
		]),
	);
	assert.equal(result.added, 1);
	assert.equal(result.rejected, 5);
	assert.equal(readFileSync(join(root, "MEMORY.md"), "utf8").trim(), "正常条目");
});

test("导入：设备专属条目一律拒收（别的机器的路径事实在本机是错的）", () => {
	const root = freshRoot();
	const result = mergeBundle(root, bundleOf([{ target: "memory", scope: "device", projectKey: "", content: "别的机器的 D 盘" }]));
	assert.equal(result.added, 0);
	assert.equal(result.rejected, 1);
	assert.equal(existsSync(join(root, "MEMORY.md")), false);
});

test("删除靠墓碑传播：本机删掉的条目导旧包不会复活，包内墓碑也会删本机", () => {
	const root = freshRoot();
	addMemory(root, { target: "memory", content: "这条要删掉" });
	addMemory(root, { target: "memory", content: "这条留着" });
	removeMemory(root, { target: "memory", content: "这条要删掉" });
	assert.equal(readTombstones(root).length, 1, "删除必须留墓碑，否则旧包导入会复活");

	// 另一台设备的旧包里还有那条已删内容
	const revived = mergeBundle(root, bundleOf([{ target: "memory", scope: "global", projectKey: "", content: "这条要删掉" }]));
	assert.equal(revived.added, 0);
	assert.equal(revived.tombstoned, 1);
	assert.ok(!readFileSync(join(root, "MEMORY.md"), "utf8").includes("这条要删掉"));

	// 反向：别的设备删掉了、本机还留着 → 导入时跟着删
	const key = "另一台删掉的那条";
	addMemory(root, { target: "memory", content: key });
	const removed = mergeBundle(root, bundleOf([], { tombstones: [{ key: key.toLowerCase(), target: "memory", scope: "global", projectKey: "", at: "2026-01-02T00:00:00.000Z" }] }));
	assert.equal(removed.removed, 1);
	assert.ok(!readFileSync(join(root, "MEMORY.md"), "utf8").includes(key));
	assert.ok(readTombstones(root).some((item) => item.key === key.toLowerCase()), "远端墓碑要记到本地，否则下次导入又回来");
});

test("导入：本地写入的墓碑不拦本进程的 memory_add（意图明确）", () => {
	const root = freshRoot();
	addMemory(root, { target: "memory", content: "会删掉" });
	removeMemory(root, { target: "memory", content: "会删掉" });
	const again = addMemory(root, { target: "memory", content: "会删掉" });
	assert.equal(again.duplicate, false);
	assert.ok(readFileSync(join(root, "MEMORY.md"), "utf8").includes("会删掉"));
});

test("包校验：格式与版本不对时明确报错，不半途导入", () => {
	const root = freshRoot();
	assert.throws(
		() => mergeBundle(root, { format: "something-else", version: 1, entries: [] }),
		/bundle-format-unsupported/,
	);
	assert.throws(() => mergeBundle(root, { format: "pideck-agent-memory", version: 99, entries: [] }), /bundle-version-unsupported/);
	assert.throws(() => mergeBundle(root, { format: "pideck-agent-memory", version: 1 }), /bundle-invalid/);
	assert.throws(() => validateBundle(null), /bundle-invalid/);
});

test("设备作用域：落 devices/<本机键>/，可检索、标 scope=device，且不进导出包", () => {
	const root = freshRoot();
	const device = readDeviceProfile(root);
	const added = addMemory(root, { target: "device", content: "本机 D 盘是数据盘" });
	assert.equal(added.scope, "device");
	assert.equal(added.projectId, `device:${device.id}`);
	assert.ok(existsSync(join(root, "devices", device.id, "MEMORY.md")), "设备作用域必须有独立目录，不能混进全局文件");
	assert.ok(!existsSync(join(root, "MEMORY.md")));

	const found = searchMemory(root, { query: "数据盘" });
	assert.equal(found.ok, true);
	const hit = found.hits.find((item) => item.content === "本机 D 盘是数据盘");
	assert.ok(hit, "设备记忆必须能被检索到（本机事实永远相关）");
	assert.equal(hit.scope, "device");

	const bundle = buildExportBundle(root);
	assert.equal(bundle.entries.length, 0);

	const status = memoryStatus(root);
	assert.equal(status.usage.device.entries, 1);
	assert.equal(status.usage.memory.entries, 0, "设备记忆不能同时算进全局条目");
	assert.deepEqual(readdirSync(join(root, "devices")), [device.id]);
});
