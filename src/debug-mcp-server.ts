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

/** measure 工具执行器：由 main.ts 注入——回报输入区相关元素的实际布局。 */
export type DebugMeasureRunner = (opts?: { popout?: boolean }) => Promise<unknown>;

/** shot 工具执行器：由 main.ts 注入——Electron capturePage 截取窗口 PNG。 */
export type DebugShotRunner = (opts?: { target?: string | number; resize?: { index?: number; width: number; height: number } }) => Promise<unknown>;

/** stats 工具执行器：由 main.ts 注入——回报 RAG 卡四格（Indexed/Embedded/
 *  Skipped/Excluded）+ 块统计 + 运行状态。 */
export type DebugStatsRunner = () => Promise<unknown>;

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

const MEASURE_TOOL = {
	name: "measure",
	description:
		"Measure the chat input footer layout in the main window: bounding rects " +
		"and computed paddings/margins of .semlink-search-view, -footer, " +
		"-input-wrapper, -input-row, -input. For diagnosing spacing issues. " +
			"Also drives UI for walkthroughs: nav=\"settings\" opens the embedded " +
			"settings screen; nav=0..4 switches to Model/RAG/MCP/Share/Pro " +
			"detail (narrow container drills in, so detail pages become visible). " +
			"Always reports winState: every Semlink view instance with its window " +
			"kind (popout / sidebar-left / sidebar-right / main-area), viewport and " +
			"OS window size, and the settings container breakpoint (narrow ≤480 / " +
			"mid ≤720 / wide).",
	inputSchema: {
		type: "object",
		properties: {
			popout: { type: "boolean", description: "Move the search view into a popout window first, then measure the popout instance." },
			width: { type: "number", description: "Popout window width in CSS px (with popout:true; re-moves an already-popped-out leaf at the new size). Default 420 (popout:true) / 780 (popout:string)." },
			height: { type: "number", description: "Popout window height in CSS px (with popout:true). Default 800 (popout:true) / 720 (popout:string)." },
			dock: { type: "boolean", description: "Dock a popped-out instance back into the sidebar first (clicks the view's own dock-back button)." },
			repro: { type: "boolean", description: "Reproduce the guide-to-popout coffee-cup loss: open embed guide in sidebar, click the real popout button, probe the canvas over time." },
			nav: { description: "\"settings\" | number 0-5: open the settings screen / switch detail page before measuring.", type: ["string", "number"] },
			scrollPanel: { description: "Scroll the settings panel to this scrollTop before measuring (-1 = scroll to bottom). The license card occupies the first screen; toggles/buttons below the fold need this.", type: "number" },
			scrollConfig: { description: "Scroll the Model tab config pane (.semlink-mt-config) to this scrollTop before measuring (-1 = scroll to bottom). The collapsed Advanced options section lives below the fold.", type: "number" },
			advClick: { description: "Click the Advanced options header (expands the collapsed section) after nav, before scrolling.", type: "boolean" },
			keyEditClick: { description: "Click the pencil button in the read-only API Key pill row (switches to the edit input mode).", type: "boolean" },
			keyProbeFill: { description: "Fill the API Key input (input event; with keyProbeCommit also a change event which saves).", type: "boolean" },
			keyProbeValue: { description: "Custom value for keyProbeFill (default sk-test-verification; pass empty string plus keyProbeCommit to clear the saved key).", type: "string" },
			keyProbeCommit: { description: "Dispatch a change event after fill (commits the value like blur-save does).", type: "boolean" },
			keyKebabClick: { description: "Click the kebab button in the API Key row (opens the Test connection / Clear settings menu).", type: "boolean" },
			fmtClick: { description: "Click the API Type dropdown trigger (opens the Obsidian menu; use shot right after to capture it).", type: "boolean" },
			fmtPick: { description: "Menu item text to pick in the API Type dropdown (e.g. Anthropic) — verifies selection, label update and endpoint recompute.", type: "string" },
			pickProvider: { description: "Click the visible provider row whose name contains this text (switches the config pane to that provider).", type: "string" },
			keySaveClick: { description: "Click the Save button in the API Key row (saves the value and collapses back to the read-only pill).", type: "boolean" },
			keyModalProbe: { description: "Inside the open Key modal: fill an invalid key, click Test & Save, wait for the failure, and report input/status gap geometry (modal stays open).", type: "boolean" },
			keyModalClose: { description: "Click the visible Cancel/Close button of any open Key modal.", type: "boolean" },
			epClick: { description: "Click the visible Endpoint row in the config pane (opens the variant picker for series providers).", type: "boolean" },
			variantPick: { description: "Click the variant row whose name contains this text in the open variant picker modal.", type: "string" },
			epPick: { description: "Click the variant row whose name contains this text in the modal opened by epClick.", type: "string" },
			ragDomProbe: { description: "Dump the DOM class tree of the first Setting in the RAG advanced-options body.", type: "boolean" },
			guideBackProbe: { description: "Click the RAG Embedding Configure button, then the guide back arrow, and report the landing screen.", type: "boolean" },
			drillClick: { description: "Click the first visible provider row (drills into the config pane on narrow containers).", type: "boolean" },
			backClick: { description: "Click the Providers back link (returns to the provider list from the drilled config pane).", type: "boolean" },
		},
		required: [],
	},
};

const SHOT_TOOL = {
	name: "shot",
	description:
		"Capture PNG screenshot(s) of the Obsidian window(s) via Electron " +
		"capturePage (whole window, all leaves). Returns absolute file paths " +
		"plus each window's title/bounds. Pair with measure {nav} to visually " +
		"inspect specific screens. Files are overwritten per call (same names).",
	inputSchema: {
		type: "object",
		properties: {
			target: { description: "\"all\" (default) captures every window; a number captures that window index only.", type: ["string", "number"] },
			resize: {
				description: "Optional: resize a window before capturing (Electron setBounds — bypasses moveLeafToPopout's 600px min, for narrow-layout walkthroughs). index defaults to 0.",
				type: "object",
				properties: {
					index: { type: "number" },
					width: { type: "number" },
					height: { type: "number" },
				},
				required: ["width", "height"],
			},
		},
		required: [],
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

const STATS_TOOL = {
	name: "stats",
	description:
		"Report the RAG index stats shown on the settings card: the four stat " +
		"cells (Indexed / Embedded / Skipped / Excluded notes), chunk counts, " +
		"the indexable-note total (card denominator) and the live run state " +
		"(phase / processed). Use it to monitor indexing progress or verify " +
		"the numbers match the UI.",
	inputSchema: { type: "object", properties: {}, required: [] },
};

export class DebugMcpServer {
	private server: Server | null = null;
	private _port: number;
	private runAsk: DebugAskRunner;
	private runReload: () => void;
	/** 串行化：一次只跑一个 ask（聊天管线占上下文与 API 配额）。 */
	private busy = false;

	constructor(port: number, runAsk: DebugAskRunner, runReload: () => void, private runJump?: DebugJumpRunner, private runMeasure?: DebugMeasureRunner, private runShot?: DebugShotRunner, private runStats?: DebugStatsRunner) {
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
					result = { tools: [ASK_TOOL, JUMP_TOOL, MEASURE_TOOL, SHOT_TOOL, RELOAD_TOOL, STATS_TOOL] };
					break;
				case "tools/call": {
					if (!params) {
						result = { jsonrpc: "2.0", id: id ?? null, error: { code: -32602, message: "Missing params" } };
						break;
					}
					if (params.name === "reload") {
						result = this.handleReload();
					} else if (params.name === "jump") {
						const jp = String(params.arguments?.path ?? "");
						const jl = Number(params.arguments?.line ?? 0);
						if (!jp || !(jl > 0)) throw new Error("jump needs path and a positive line");
						result = { content: [{ type: "text", text: JSON.stringify((await this.runJump?.(jp, jl)) ?? { error: "no jump runner" }, null, 2) }] };
					} else if (params.name === "measure") {
							result = { content: [{ type: "text", text: JSON.stringify((await this.runMeasure?.(params.arguments as { popout?: boolean; repro?: boolean; sessionIdx?: number; nav?: number | string; width?: number; height?: number; dock?: boolean; scrollPanel?: number; scrollConfig?: number; advClick?: boolean; keyEditClick?: boolean; keyProbeFill?: boolean; keyProbeValue?: string; keyProbeCommit?: boolean; keyKebabClick?: boolean; keySaveClick?: boolean; fmtClick?: boolean; fmtPick?: string; pickProvider?: string; drillClick?: boolean; backClick?: boolean; keyModalProbe?: boolean; keyModalClose?: boolean; variantPick?: string; epClick?: boolean; epPick?: string; addProviderProbe?: boolean; scrollPerf?: boolean; countProbe?: boolean; forcePro?: boolean } | undefined)) ?? { error: "no measure runner" }, null, 2) }] };
						} else if (params.name === "stats") {
						result = { content: [{ type: "text", text: JSON.stringify((await this.runStats?.()) ?? { error: "no stats runner" }, null, 2) }] };
					} else if (params.name === "shot") {
							result = { content: [{ type: "text", text: JSON.stringify((await this.runShot?.(params.arguments as { target?: string | number; resize?: { index?: number; width: number; height: number } } | undefined)) ?? { error: "no shot runner" }, null, 2) }] };
						} else {
						result = await this.handleAsk(params);
					}
					break;
				}
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
