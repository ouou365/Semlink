// ========================================
// Semlink - Debug MCP Server (semlink-debug)
// ========================================
// 单工具 MCP：ask —— 把问题送进真实的聊天问答管线（与侧栏同一条
// ChatClient.chat 路径：检索 + agentic 工具循环 + 强制引用），返回最终
// 回答与完整思考过程（每条 thought、每次工具调用的参数与结果）。
// 用途：ZCode 等 agent 对问答功能做端到端回归测试。
// 仅监听 127.0.0.1——它能触发真实的 LLM API 调用，不暴露到局域网。

import { createServer, IncomingMessage, ServerResponse, Server } from "http";
import { debugLog } from "./log";

/** ask 工具执行器：由 main.ts 注入（复用侧栏同一条 chat 管线）。 */
export type DebugAskRunner = (question: string) => Promise<unknown>;

/** jump 工具执行器：由 main.ts 注入——调用侧栏 openNote 打开笔记并跳行，
 *  然后回报实际光标/滚动位置，用于自动验证引用跳行链路。 */
export type DebugJumpRunner = (path: string, line: number) => Promise<unknown>;

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: string | number | null;
	method: string;
	params?: { name?: string; arguments?: { question?: string; path?: string; line?: number } };
}

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number | null;
	result?: unknown;
	error?: { code: number; message: string };
}

const ASK_TOOL = {
	name: "ask",
	description:
		"Ask the Semlink knowledge base a question end-to-end: runs the REAL chat pipeline " +
		"(retrieval + agentic tool loop with search/grep/read, the same one the sidebar uses) " +
		"and returns the final answer plus the COMPLETE thinking process — every thought and " +
		"every tool call with its arguments and results — and the notes used. " +
		"Use it to test/verify Q&A behavior and diagnose answer instability.",
	// MCP 规范字段名是 inputSchema（驼峰，同 Anthropic API 的 input_schema 不同名）
	inputSchema: {
		type: "object",
		properties: {
			question: { type: "string", description: "The question to ask, in any language" },
		},
		required: ["question"],
	},
};

const JUMP_TOOL = {
	name: "jump",
	description:
		"Open a vault note in Obsidian and jump to a 1-based line (the same " +
		"openNote path citation clicks use), then report the resulting view " +
		"mode, cursor line and scroll position. Use it to verify line-anchored " +
		"citations end-to-end without touching the UI.",
	inputSchema: {
		type: "object",
		properties: {
			path: { type: "string", description: "Vault path of the note" },
			line: { type: "number", description: "1-based line to jump to" },
		},
		required: ["path", "line"],
	},
};

const RELOAD_TOOL = {
	name: "reload",
	description:
		"Reload the Obsidian app WITHOUT saving (same as the 'Reload app without saving' command). " +
		"Use it after the plugin source was rebuilt to load the new build. " +
		"IMPORTANT: the reload tears down this MCP server ~0.5s after the call — this response " +
		"usually arrives, but the CONNECTION will drop and later calls will fail until the app is " +
		"back. After calling reload, poll GET /health until it responds again, then re-initialize.",
	inputSchema: { type: "object", properties: {}, required: [] },
};

export class DebugMcpServer {
	private server: Server | null = null;
	private _port: number;
	private runAsk: DebugAskRunner;
	private runReload: () => void;
	/** 串行化：一次只跑一个 ask（聊天管线占上下文与 API 配额）。 */
	private busy = false;

	constructor(port: number, runAsk: DebugAskRunner, runReload: () => void, private runJump?: DebugJumpRunner) {
		this._port = port;
		this.runAsk = runAsk;
		this.runReload = runReload;
	}

	updatePort(port: number) {
		this._port = port;
	}

	get port(): number {
		return this._port;
	}

	start(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.server = createServer((req, res) => {
				void this.handleRequest(req, res);
			});
			this.server.on("error", (err: NodeJS.ErrnoException) => {
				if (err.code === "EADDRINUSE") {
					console.warn(`[Semlink] debug MCP port ${this._port} in use, trying ${this._port + 1}`);
					this._port++;
					this.server!.listen(this._port, "127.0.0.1");
				} else {
					reject(err instanceof Error ? err : new Error(String(err)));
				}
			});
			this.server.listen(this._port, "127.0.0.1", () => {
				debugLog(`[Semlink] debug MCP listening on http://127.0.0.1:${this._port}/mcp`);
				resolve();
			});
		});
	}

	stop(): Promise<void> {
		return new Promise((resolve) => {
			if (this.server) {
				this.server.close(() => {
					this.server = null;
					resolve();
				});
			} else {
				resolve();
			}
		});
	}

	private async handleRequest(req: IncomingMessage, res: ServerResponse) {
		if (req.method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}
		if (req.method === "GET" && req.url === "/health") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ status: "ok", server: "semlink-debug", port: this._port, busy: this.busy }));
			return;
		}
		if (req.method === "POST" && (req.url === "/mcp" || req.url === "/")) {
			try {
				const body = await this.readBody(req);
				const request = JSON.parse(body) as JsonRpcRequest;
				// 通知（无 id，如 notifications/initialized）：规范要求不回正文，202 即可
				if (request.id == null) { res.writeHead(202); res.end(); return; }
				const response = await this.route(request);
				this.send(res, response);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				this.send(res, { jsonrpc: "2.0", id: null, error: { code: -32700, message: `Parse error: ${msg}` } }, 400);
			}
			return;
		}
		res.writeHead(404);
		res.end("Not found");
	}

	private async route(request: JsonRpcRequest): Promise<JsonRpcResponse> {
		const { method, params, id } = request;
		try {
			let result: unknown;
			switch (method) {
				case "initialize":
					result = {
						protocolVersion: "2024-11-05",
						capabilities: { tools: { listChanged: false } },
						serverInfo: { name: "semlink-debug", version: "0.1.0" },
					};
					break;
				case "ping":
					result = {};
					break;
				case "tools/list":
					result = { tools: [ASK_TOOL, JUMP_TOOL, RELOAD_TOOL] };
					break;
				case "tools/call":
					if (params.name === "reload") {
						result = this.handleReload();
					} else if (params.name === "jump") {
						const jp = String(params.arguments?.path ?? "");
						const jl = Number(params.arguments?.line ?? 0);
						if (!jp || !(jl > 0)) throw new Error("jump needs path and a positive line");
						result = { content: [{ type: "text", text: JSON.stringify((await this.runJump?.(jp, jl)) ?? { error: "no jump runner" }, null, 2) }] };
					} else {
						result = await this.handleAsk(params || {});
					}
					break;
				default:
					if (id == null) return { jsonrpc: "2.0", id: null, result: {} };
					return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
			}
			return { jsonrpc: "2.0", id: id ?? null, result };
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return { jsonrpc: "2.0", id: id ?? null, error: { code: -32603, message: `Internal error: ${msg}` } };
		}
	}

	private async handleAsk(params: { name?: string; arguments?: { question?: string } }): Promise<unknown> {
		if (params.name !== "ask") throw new Error(`Unknown tool: ${params.name}`);
		const question = (params.arguments?.question ?? "").trim();
		if (!question) throw new Error("Missing question");
		if (this.busy) throw new Error("Another ask is still running — poll /health or retry later");
		this.busy = true;
		try {
			const result = await this.runAsk(question);
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
		} finally {
			this.busy = false;
		}
	}

	/** 先应答再延迟重载：给响应留出落网时间（reload 会连带杀掉本服务，
	 *  调用方按工具描述改为轮询 /health 等待应用恢复）。 */
	private handleReload(): unknown {
		window.setTimeout(() => {
			debugLog("[Semlink] debug MCP: reloading the app now");
			this.runReload();
		}, 500);
		return {
			content: [{
				type: "text",
				text: "Reload scheduled in ~0.5s (app:reload, without saving). This MCP connection will drop — " +
					"poll GET /health until it responds again, then re-initialize before the next call.",
			}],
		};
	}

	private readBody(req: IncomingMessage): Promise<string> {
		return new Promise((resolve, reject) => {
			let body = "";
			req.on("data", (c) => (body += c));
			req.on("end", () => resolve(body));
			req.on("error", reject);
		});
	}

	private send(res: ServerResponse, payload: JsonRpcResponse, status = 200) {
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(JSON.stringify(payload));
	}
}
