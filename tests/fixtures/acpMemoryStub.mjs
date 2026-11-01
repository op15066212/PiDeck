/**
 * 假的 ACP agent：只为验证「PiDeck 传给 session/new 的 mcpServers 真的能被拉起」。
 *
 * 真实 CLI（codex-acp/opencode）收到 mcpServers 后会用自己的 MCP 客户端按
 * `{command, args, env}` 起进程。这里做同一件事：spawn、MCP initialize、tools/list，
 * 把结果写到 ACP_STUB_OUT，再回一个合法的 session/new 响应。
 *
 * 这样 CI 里不需要模型凭据，也能证明 stdio 挂载在真实进程边界上可用（不是只有类型对）。
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";

const out = process.env.ACP_STUB_OUT;

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** 起一个 MCP 服务器并取它的工具清单（最小 MCP 客户端：initialize → tools/list）。 */
function listTools(server) {
	return new Promise((resolve) => {
		const proc = spawn(server.command, server.args ?? [], {
			env: { ...process.env, ...(server.env ?? {}) },
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		const result = { name: server.name, tools: [], envKeys: Object.keys(server.env ?? {}), error: "" };
		const pending = new Map();
		let nextId = 1;
		const call = (method, params) => {
			const id = nextId++;
			proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
			return new Promise((done) => pending.set(id, done));
		};
		createInterface({ input: proc.stdout }).on("line", (line) => {
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				return;
			}
			const done = pending.get(message.id);
			if (!done) return;
			pending.delete(message.id);
			done(message.result ?? { error: message.error });
		});
		proc.stderr.on("data", (chunk) => {
			result.error += chunk.toString("utf8").slice(0, 400);
		});
		proc.on("error", (error) => {
			result.error += String(error.message);
			resolve(result);
		});
		const timer = setTimeout(() => {
			proc.kill();
			resolve(result);
		}, 20_000);
		void (async () => {
			try {
				await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "acp-stub", version: "1" } });
				proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
				const listed = await call("tools/list", {});
				result.tools = (listed.tools ?? []).map((tool) => tool.name);
			} catch (error) {
				result.error += String(error);
			} finally {
				clearTimeout(timer);
				proc.kill();
				resolve(result);
			}
		})();
	});
}

const mcpSummary = [];

createInterface({ input: process.stdin }).on("line", (line) => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	if (message.method === "initialize") {
		send({
			jsonrpc: "2.0",
			id: message.id,
			result: { protocolVersion: 1, agentCapabilities: { loadSession: false }, agentInfo: { name: "acp-memory-stub" } },
		});
		return;
	}
	if (message.method === "session/new" || message.method === "session/load") {
		void (async () => {
			for (const server of message.params?.mcpServers ?? []) mcpSummary.push(await listTools(server));
			if (out) writeFileSync(out, JSON.stringify({ method: message.method, mcpServers: message.params?.mcpServers ?? [], summary: mcpSummary }, null, 2));
			send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "sess-memory-stub" } });
		})();
		return;
	}
	// 其它请求（含 session/prompt）回一个空结果，避免调用方超时
	if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: {} });
});
