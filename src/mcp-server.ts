// ========================================
// Semlink - HTTP MCP Server
// ========================================

import type { TFile, Vault } from "obsidian";
import { debugLog } from "./log";
import { createServer, IncomingMessage, ServerResponse, Server } from "http";
import { VectorStore } from "./vector-store";
import { EmbeddingClient } from "./embedding-client";
import { ProgressTracker } from "./progress";
import { Scheduler } from "./scheduler";
import { TOOL_SPECS, ToolCore } from "./tools-core";
import type { SmartVaultSettings } from "./types";

/** Tool arguments read from tools/call params — only fields this server uses. */
interface ToolCallArgs {
	query?: string;
	limit?: number;
	threshold?: number;
	path?: string;
	prefix?: string;
	offset?: number;
	force?: boolean;
	heading?: string;
	maxDepth?: number;
	pattern?: string;
	regex?: boolean;
	pathFilter?: string;
	caseSensitive?: boolean;
	contextLines?: number;
}

interface ToolCallParams {
	name?: string;
	arguments?: ToolCallArgs;
}

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: string | number | null;
	method: string;
	params?: ToolCallParams;
}

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number | null;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export class McpServer {
	private server: Server | null = null;
	private store: VectorStore;
	private client: EmbeddingClient;
	private progress: ProgressTracker;
	private scheduler: Scheduler;
	private settings: SmartVaultSettings;
	private vault: Vault; // Obsidian Vault
	/** Vault path of the note currently open in Obsidian (or null). */
	private getActiveNote: () => string | null;
	private core: ToolCore;

	constructor(
		store: VectorStore,
		client: EmbeddingClient,
		progress: ProgressTracker,
		scheduler: Scheduler,
		settings: SmartVaultSettings,
		vault: Vault,
		getActiveNote: () => string | null = () => null,
	) {
		this.store = store;
		this.client = client;
		this.progress = progress;
		this.scheduler = scheduler;
		this.settings = settings;
		this.vault = vault;
		this.getActiveNote = getActiveNote;
		this.core = new ToolCore({
			store,
			client,
			vault,
			getActiveNote,
			progress: () => this.progress.current,
			reindex: async (path, force) => {
				await this.toolReindex(path, force);
			},
		});
	}

	updateSettings(settings: SmartVaultSettings) {
		this.settings = settings;
	}

	start(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.server = createServer((req, res) => { void this.handleRequest(req, res); });

			this.server.on("error", (err: NodeJS.ErrnoException) => {
				if (err.code === "EADDRINUSE") {
					console.warn(`[Semlink] Port ${this.settings.mcpPort} in use, trying ${this.settings.mcpPort + 1}`);
					this.settings.mcpPort++;
					this.server!.listen(this.settings.mcpPort, "127.0.0.1");
				} else {
					reject(err instanceof Error ? err : new Error(String(err)));
				}
			});

			this.server.listen(this.settings.mcpPort, "127.0.0.1", () => {
				debugLog(`[Semlink] Server listening on http://127.0.0.1:${this.settings.mcpPort}`);
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

	get port(): number {
		return this.settings.mcpPort;
	}

	private async handleRequest(req: IncomingMessage, res: ServerResponse) {
		// CORS
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

		if (req.method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}

		// Health check
		if (req.method === "GET" && req.url === "/health") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ status: "ok", port: this.settings.mcpPort }));
			return;
		}

		// MCP endpoint
		if (req.method === "POST" && (req.url === "/mcp" || req.url === "/")) {
			// Auth check
			if (this.settings.mcpApiKey) {
				const authHeader = req.headers["authorization"];
				if (authHeader !== `Bearer ${this.settings.mcpApiKey}`) {
					this.sendJsonRpc(res, {
						jsonrpc: "2.0",
						id: null,
						error: { code: -32001, message: "Unauthorized" },
					}, 401);
					return;
				}
			}

			try {
				const body = await this.readBody(req);
				const request = JSON.parse(body) as JsonRpcRequest;
				const response = await this.route(request);
				this.sendJsonRpc(res, response);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				this.sendJsonRpc(res, {
					jsonrpc: "2.0",
					id: null,
					error: { code: -32700, message: `Parse error: ${msg}` },
				}, 400);
			}
			return;
		}

		// SSE endpoint for server-initiated messages (optional)
		if (req.method === "GET" && req.url === "/sse") {
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				"Connection": "keep-alive",
			});
			res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
			// Keep alive
				const interval = window.setInterval(() => {
					res.write(`data: ${JSON.stringify({ type: "ping" })}\n\n`);
				}, 30000);
				req.on("close", () => window.clearInterval(interval));
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
					result = this.handleInitialize();
					break;
				case "ping":
					result = {};
					break;
				case "tools/list":
					result = McpServer.handleToolsList();
					break;
				case "tools/call":
					result = await this.handleToolsCall(params || {});
					break;
				case "resources/list":
					result = { resources: [] };
					break;
				case "prompts/list":
					result = { prompts: [] };
					break;
				default:
					// Ignore notifications (no id)
					if (id == null) {
						return { jsonrpc: "2.0", id: null, result: {} };
					}
					return {
						jsonrpc: "2.0",
						id,
						error: { code: -32601, message: `Method not found: ${method}` },
					};
			}

			return { jsonrpc: "2.0", id: id ?? null, result };
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				jsonrpc: "2.0",
				id: id ?? null,
				error: { code: -32603, message: `Internal error: ${msg}` },
			};
		}
	}

	// ──── MCP Handlers ────

	private handleInitialize() {
		return {
			protocolVersion: "2024-11-05",
			capabilities: {
				tools: { listChanged: false },
			},
			serverInfo: {
				name: "semlink",
				version: "0.1.0",
			},
		};
	}

	private static handleToolsList() {
		return { tools: TOOL_SPECS };
	}
	/** 设置页展示用：本服务声明的 tools / resources / prompts（纯静态定义）。 */
	static listCapabilities(): { tools: Array<{ name: string; description: string }>; resources: unknown[]; prompts: unknown[] } {
		const list = McpServer.handleToolsList();
		return { tools: list.tools.map((t) => ({ name: t.name, description: t.description ?? "" })), resources: [], prompts: [] };
	}

	private async handleToolsCall(params: ToolCallParams): Promise<unknown> {
		const toolName = params.name;
		if (!toolName) throw new Error("Missing tool name");
		const args: ToolCallArgs = params.arguments || {};
		this.core.maxChars = 12000;
		const text = await this.core.execute(toolName, args as Record<string, unknown>);
		return {
			content: [{ type: "text", text }],
			...(text.startsWith("Error:") ? { isError: true } : {}),
		};
	}

	private async toolSearchNotes(query: string, limit = 10, threshold = 0.3) {
		// Embed the query
		const embedResult = await this.client.embed([query]);
		const queryVec = embedResult.embeddings[0];

		// Search
		const results = await this.store.search(queryVec, limit, threshold);

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						query,
						totalResults: results.length,
						results: results.map((r) => ({
							path: r.notePath,
							heading: r.heading,
							preview: r.contentPreview,
							score: r.score,
						})),
					}, null, 2),
				},
			],
		};
	}

	private async toolGetNote(path: string) {
		try {
			const file = this.vault.getAbstractFileByPath(path) as TFile | null;
			if (!file) {
				return {
					content: [{ type: "text", text: `File not found: ${path}` }],
					isError: true,
				};
			}
			const content = await this.vault.read(file);
			return {
				content: [{ type: "text", text: content }],
			};
		} catch (e) {
			return {
				content: [{ type: "text", text: `Error reading file: ${e}` }],
				isError: true,
			};
		}
	}

	/** The note currently open in Obsidian — path only (content via read). */
	private async toolGetActiveNote() {
		const path = this.getActiveNote();
		if (!path) {
			return {
				content: [{ type: "text", text: "No note is currently open in Obsidian. Open a note first, or use search / grep / ls to query the knowledge base." }],
				isError: true,
			};
		}
		return {
			content: [{ type: "text", text: `当前打开的笔记：${path}` }],
		};
	}

	private async toolGetSimilarNotes(path: string, limit = 10, threshold = 0.2) {
		// Max-pooling over the note's own chunks (see DbEngine.searchRelatedNotes):
		// symmetric note→note similarity, works for large docs whose opening is
		// boilerplate. Default threshold 0.2 — bge-m3 cosine scores for related
		// notes often land in 0.25–0.5.
		const results = await this.store.searchRelatedNotes(path, limit, threshold, 6);

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						sourcePath: path,
						totalResults: results.length,
						results: results.map((r) => ({
							path: r.notePath,
							heading: r.heading,
							preview: r.contentPreview,
							score: r.score,
						})),
					}, null, 2),
				},
			],
		};
	}

	private async toolListIndexed(prefix?: string, limit = 200, offset = 0) {
		const paths = await this.store.getAllIndexedPaths();
		const filtered = prefix
			? Array.from(paths).filter((p) => p.startsWith(prefix))
			: Array.from(paths);
		const total = filtered.length;
		const page = filtered.sort().slice(offset, offset + limit);

		const stats = await this.store.getStats();

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						totalNotes: stats.indexedNotes,
						totalChunks: stats.activeChunks,
						total,
						listed: page.length,
						truncated: total > offset + limit,
						paths: page,
					}, null, 2),
				},
			],
		};
	}

	/** ls (detailed): paths + created/modified times, newest
	 *  modification first. Paginated (limit/offset) so a large vault never
	 *  produces an oversized response. */
	private async toolListIndexedDetailed(prefix?: string, limit = 100, offset = 0) {
		const paths = await this.store.getAllIndexedPaths();
		const filtered = prefix
			? Array.from(paths).filter((p) => p.startsWith(prefix))
			: Array.from(paths);

		const notes = filtered.map((p) => {
			const file = this.vault.getAbstractFileByPath(p) as TFile | null;
			const stat = file?.stat;
			return {
				path: p,
				created: stat ? new Date(stat.ctime).toISOString() : null,
				modified: stat ? new Date(stat.mtime).toISOString() : null,
			};
		});
		// Newest modification first; notes without a stat go last.
		notes.sort((a, b) => {
			if (!a.modified) return 1;
			if (!b.modified) return -1;
			return b.modified.localeCompare(a.modified);
		});
		const total = notes.length;
		const page = notes.slice(offset, offset + limit);

		const stats = await this.store.getStats();

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						totalNotes: stats.indexedNotes,
						totalChunks: stats.activeChunks,
						total,
						listed: page.length,
						truncated: total > offset + limit,
						notes: page,
					}, null, 2),
				},
			],
		};
	}

	private async toolGrepNotes(pattern: string, regex = false, pathFilter?: string, caseSensitive = false, limit = 10, contextLines = 1) {
		if (!pattern) {
			return { content: [{ type: "text", text: "Error: missing pattern" }] };
		}
		let re: RegExp;
		try {
			const escaped = regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			re = new RegExp(escaped, caseSensitive ? "" : "i");
		} catch (e) {
			return { content: [{ type: "text", text: `Error: invalid regex: ${e instanceof Error ? e.message : String(e)}` }] };
		}

		// `limit` controls how many files carry detailed lines; the COMPLETE
		// matching path list is always returned (up to MAX_PATHS).
		const detailLimit = Math.min(Math.max(1, limit), 30);
		const MAX_PATHS = 200;
		const ctx = Math.min(Math.max(0, contextLines), 3);
		const maxLinesPerFile = 12;
		const files = this.vault.getFiles().filter((f) => {
			if (!/\.(md|txt|markdown)$/i.test(f.path)) return false;
			if (pathFilter && !f.path.toLowerCase().startsWith(pathFilter.toLowerCase())) return false;
			return true;
		});

		// Scan ALL files with bounded concurrency — sequential reads of
		// thousands of vault files would freeze the tool.
		const CONCURRENCY = 32;
		let totalFiles = 0;
		const allPaths: string[] = [];
		const detailed: Array<{ path: string; matchCount: number; lines: string[] }> = [];
		for (let i = 0; i < files.length; i += CONCURRENCY) {
			const chunk = files.slice(i, i + CONCURRENCY);
			const batch = await Promise.all(
				chunk.map(async (file) => {
					try {
						if (file.stat.size > 5 * 1024 * 1024) return null; // skip huge files
						const content = await this.vault.cachedRead(file);
						const lines = content.split("\n");
						let fileMatches = 0;
						const hits: string[] = [];
						for (let j = 0; j < lines.length; j++) {
							if (!re.test(lines[j])) continue;
							fileMatches++;
							if (hits.length >= maxLinesPerFile) continue;
							const from = Math.max(0, j - ctx);
							const to = Math.min(lines.length - 1, j + ctx);
							for (let k = from; k <= to; k++) {
								const label = `L${k + 1}: ${lines[k].trim().slice(0, 150)}`;
								if (!hits.includes(label)) hits.push(label);
							}
						}
						if (fileMatches === 0) return null;
						return { path: file.path, matchCount: fileMatches, lines: hits };
					} catch {
						return null; // skip unreadable files
					}
				}),
			);
			for (const r of batch) {
				if (!r) continue;
				totalFiles++;
				if (totalFiles <= MAX_PATHS) allPaths.push(r.path);
				if (detailed.length < detailLimit) detailed.push(r);
			}
		}

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						pattern,
						regex,
						caseSensitive,
						totalFiles,
						completeList: totalFiles <= MAX_PATHS,
						paths: allPaths,
						results: detailed,
					}, null, 2),
				},
			],
		};
	}

	private async toolIndexStatus() {
		const progress = this.progress.current;
		const stats = await this.store.getStats();

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						phase: progress.phase,
						indexed: {
							notes: stats.indexedNotes,
							chunks: stats.activeChunks,
							dbSizeMb: stats.dbSizeMb,
						},
						progress: {
							totalNotes: progress.totalNotes,
							processed: progress.processedNotes,
							embedded: progress.embeddedChunks,
							failed: progress.failedChunks,
							skipped: progress.skippedChunks,
							eta: ProgressTracker.formatEta(progress.estimatedRemainingSec),
						},
						network: {
							status: progress.networkStatus,
							avgResponseMs: progress.avgResponseMs,
							consecutiveFailures: progress.consecutiveFailures,
							isPaused: progress.isPaused,
							isAutoPaused: progress.isAutoPaused,
						},
					}, null, 2),
				},
			],
		};
	}

	private async toolReindex(path?: string, force = false) {
		if (path) {
			await this.scheduler.enqueueFile(path, "update");
		} else {
			// Full reindex
			if (force) {
				// Clear all data before rebuilding
				await this.store.clearAll();
				this.progress.reset();
			}
			if (!this.scheduler.isRunning) {
				void this.scheduler.run();
			}
		}

		return {
			content: [
				{
					type: "text",
					text: path
						? `Queued for reindex: ${path}`
						: force
							? "Force full reindex triggered (data cleared)"
							: "Full reindex triggered",
				},
			],
		};
	}

	// ──── Helpers ────

	private readBody(req: IncomingMessage): Promise<string> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk: Buffer) => chunks.push(chunk));
			req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
			req.on("error", reject);
		});
	}

	private sendJsonRpc(res: ServerResponse, response: JsonRpcResponse, status = 200) {
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(JSON.stringify(response));
	}
}
