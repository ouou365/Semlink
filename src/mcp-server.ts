// ========================================
// Semlink - HTTP MCP Server
// ========================================

import { createServer, IncomingMessage, ServerResponse, Server } from "http";
import { VectorStore } from "./vector-store";
import { EmbeddingClient } from "./embedding-client";
import { ProgressTracker } from "./progress";
import { Scheduler } from "./scheduler";
import { readFileSync } from "fs";
import { extractSection, extractHeadings } from "./section-utils";
import type { SmartVaultSettings } from "./types";

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: string | number | null;
	method: string;
	params?: Record<string, any>;
}

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number | null;
	result?: any;
	error?: { code: number; message: string; data?: any };
}

export class McpServer {
	private server: Server | null = null;
	private store: VectorStore;
	private client: EmbeddingClient;
	private progress: ProgressTracker;
	private scheduler: Scheduler;
	private settings: SmartVaultSettings;
	private vault: any; // Obsidian Vault
	/** Vault path of the note currently open in Obsidian (or null). */
	private getActiveNote: () => string | null;

	constructor(
		store: VectorStore,
		client: EmbeddingClient,
		progress: ProgressTracker,
		scheduler: Scheduler,
		settings: SmartVaultSettings,
		vault: any,
		getActiveNote: () => string | null = () => null,
	) {
		this.store = store;
		this.client = client;
		this.progress = progress;
		this.scheduler = scheduler;
		this.settings = settings;
		this.vault = vault;
		this.getActiveNote = getActiveNote;
	}

	updateSettings(settings: SmartVaultSettings) {
		this.settings = settings;
	}

	start(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.server = createServer((req, res) => this.handleRequest(req, res));

			this.server.on("error", (err: any) => {
				if (err.code === "EADDRINUSE") {
					console.warn(`[Semlink] Port ${this.settings.mcpPort} in use, trying ${this.settings.mcpPort + 1}`);
					this.settings.mcpPort++;
					this.server!.listen(this.settings.mcpPort, "127.0.0.1");
				} else {
					reject(err);
				}
			});

			this.server.listen(this.settings.mcpPort, "127.0.0.1", () => {
				console.log(`[Semlink] Server listening on http://127.0.0.1:${this.settings.mcpPort}`);
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
				const request: JsonRpcRequest = JSON.parse(body);
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
			let result: any;

			switch (method) {
				case "initialize":
					result = this.handleInitialize();
					break;
				case "ping":
					result = {};
					break;
				case "tools/list":
					result = this.handleToolsList();
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

	private handleToolsList() {
		return {
			tools: [
				{
					name: "search_notes",
					description: "语义检索 Vault 笔记。使用自然语言查询，返回最相关的笔记片段。",
					inputSchema: {
						type: "object",
						properties: {
							query: {
								type: "string",
								description: "自然语言搜索查询",
							},
							limit: {
								type: "number",
								description: "返回结果数量上限（默认 10）",
								default: 10,
							},
							threshold: {
								type: "number",
								description: "相似度阈值 0-1（默认 0.3）",
								default: 0.3,
							},
						},
						required: ["query"],
					},
				},
				{
					name: "get_note",
					description: "获取笔记的完整内容",
					inputSchema: {
						type: "object",
						properties: {
							path: {
								type: "string",
								description: "笔记在 Vault 中的路径",
							},
						},
						required: ["path"],
					},
				},
				{
					name: "get_similar_notes",
					description: "查找与指定笔记语义相似的其他笔记",
					inputSchema: {
						type: "object",
						properties: {
							path: {
								type: "string",
								description: "参考笔记路径",
							},
							limit: {
								type: "number",
								description: "返回结果数量上限（默认 10）",
								default: 10,
							},
							threshold: {
								type: "number",
								description: "相似度阈值 0-1（默认 0.4）",
								default: 0.4,
							},
						},
						required: ["path"],
					},
				},
				{
					name: "list_indexed",
					description: "列出已索引的笔记路径（分页：limit 默认 200，用 offset 翻页；total 为总匹配数，truncated 表示是否还有更多）",
					inputSchema: {
						type: "object",
						properties: {
							prefix: {
								type: "string",
								description: "路径前缀过滤（可选）",
							},
							limit: {
								type: "number",
								description: "最多返回条数（默认 200）",
							},
							offset: {
								type: "number",
								description: "跳过前 N 条（默认 0，用于翻页）",
							},
						},
					},
				},
				{
					name: "list_indexed_detailed",
					description: "列出已索引的笔记，每条附带创建/修改时间（ISO 格式，按修改时间倒序），分页：limit 默认 100，用 offset 翻页；适合「最近/最新」类问题取前几条",
					inputSchema: {
						type: "object",
						properties: {
							prefix: {
								type: "string",
								description: "路径前缀过滤（可选）",
							},
							limit: {
								type: "number",
								description: "最多返回条数（默认 100）",
							},
							offset: {
								type: "number",
								description: "跳过前 N 条（默认 0，用于翻页）",
							},
						},
					},
				},
				{
					name: "index_status",
					description: "获取当前索引状态和进度",
					inputSchema: {
						type: "object",
						properties: {},
					},
				},
				{
					name: "reindex",
					description: "触发重新索引（可指定单个文件或全量）",
					inputSchema: {
						type: "object",
						properties: {
							path: {
								type: "string",
								description: "指定文件路径（留空则全量索引）",
							},
							force: {
								type: "boolean",
								description: "强制重建所有向量（默认 false）",
								default: false,
							},
						},
					},
				},
				{
					name: "get_section",
					description: "获取笔记中指定标题下的章节内容。支持按标题名称匹配，返回该标题到下一个同级或更高级标题之间的所有内容。适用于大文件时只读取特定章节。",
					inputSchema: {
						type: "object",
						properties: {
							path: {
								type: "string",
								description: "笔记在 Vault 中的路径",
							},
							heading: {
								type: "string",
								description: "要读取的标题名称（不需要包含 # 符号）",
							},
							maxDepth: {
								type: "number",
								description: "包含的子标题最大深度，如目标标题是 ## 级(maxDepth=2)，则只包含 ## 及其内容，不包含 ### 及更深层。不传则包含所有子内容。",
							},
						},
						required: ["path", "heading"],
					},
				},
				{
					name: "grep_notes",
					description: "在 Vault 笔记中按文本或正则表达式精确搜索内容，适合精确关键词、编号、日期、代码片段等语义检索覆盖不到的内容。totalFiles 为匹配笔记总数；paths 字段返回匹配文件清单（completeList=true 时即完整清单，最多 200 个），一次调用即可拿到完整清单。limit 仅控制附带行内容的文件数。",
					inputSchema: {
						type: "object",
						properties: {
							pattern: {
								type: "string",
								description: "要搜索的文本或正则表达式",
							},
							regex: {
								type: "boolean",
								description: "pattern 是否为正则表达式（默认 false，按普通文本匹配）",
								default: false,
							},
							pathFilter: {
								type: "string",
								description: "仅搜索路径前缀匹配的笔记，如 'projects/xxx'（可选）",
							},
							caseSensitive: {
								type: "boolean",
								description: "是否区分大小写（默认 false）",
								default: false,
							},
							limit: {
								type: "number",
								description: "附带行内容的文件数（默认 10，最大 30）",
								default: 10,
							},
							contextLines: {
								type: "number",
								description: "每个匹配前后附带的上下文行数（默认 1，最大 3）",
								default: 1,
							},
						},
						required: ["pattern"],
					},
				},
				{
					name: "get_active_note",
					description: "获取当前正在 Obsidian 中打开的笔记的路径（仅路径，不含内容）。需要内容时请再用 get_note 按返回的路径读取。没有打开的笔记时返回明确提示。",
					inputSchema: {
						type: "object",
						properties: {},
					},
				},
			],
		};
	}

	private async handleToolsCall(params: Record<string, any>): Promise<any> {
		const toolName = params.name;
		const args = params.arguments || {};

		switch (toolName) {
			case "search_notes":
				return await this.toolSearchNotes(args.query, args.limit, args.threshold);
			case "get_note":
				return await this.toolGetNote(args.path);
			case "get_similar_notes":
				return await this.toolGetSimilarNotes(args.path, args.limit, args.threshold);
			case "list_indexed":
				return await this.toolListIndexed(args.prefix, args.limit, args.offset);
			case "list_indexed_detailed":
				return await this.toolListIndexedDetailed(args.prefix, args.limit, args.offset);
			case "index_status":
				return await this.toolIndexStatus();
			case "reindex":
				return await this.toolReindex(args.path, args.force);
			case "get_section":
				return await this.toolGetSection(args.path, args.heading, args.maxDepth);
			case "grep_notes":
				return await this.toolGrepNotes(args.pattern, args.regex, args.pathFilter, args.caseSensitive, args.limit, args.contextLines);
			case "get_active_note":
				return await this.toolGetActiveNote();
			default:
				throw new Error(`Unknown tool: ${toolName}`);
		}
	}

	// ──── Tool Implementations ────

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
			const file = this.vault.getAbstractFileByPath(path);
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

	/** The note currently open in Obsidian — path only (content via get_note). */
	private async toolGetActiveNote() {
		const path = this.getActiveNote();
		if (!path) {
			return {
				content: [{ type: "text", text: "当前没有打开的笔记。请先打开一篇笔记，或改用 search_notes / grep_notes 检索知识库。" }],
				isError: true,
			};
		}
		return {
			content: [{ type: "text", text: `当前打开的笔记：${path}` }],
		};
	}

	private async toolGetSimilarNotes(path: string, limit = 10, threshold = 0.4) {
		// Get chunks for this note to use as reference
		const chunks = await this.store.getChunksByNotePath(path);
		if (chunks.length === 0) {
			return {
				content: [{ type: "text", text: `No indexed chunks found for: ${path}` }],
				isError: true,
			};
		}

		// Use the first chunk's embedding area for search
		// Re-embed the first chunk's content
		const embedResult = await this.client.embed([chunks[0].content]);
		const queryVec = embedResult.embeddings[0];

		const results = await this.store.search(queryVec, limit + 5, threshold);

		// Filter out the original note
		const filtered = results.filter((r) => r.notePath !== path).slice(0, limit);

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						sourcePath: path,
						totalResults: filtered.length,
						results: filtered.map((r) => ({
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

	/** list_indexed_detailed: paths + created/modified times, newest
	 *  modification first. Paginated (limit/offset) so a large vault never
	 *  produces an oversized response. */
	private async toolListIndexedDetailed(prefix?: string, limit = 100, offset = 0) {
		const paths = await this.store.getAllIndexedPaths();
		const filtered = prefix
			? Array.from(paths).filter((p) => p.startsWith(prefix))
			: Array.from(paths);

		const notes = filtered.map((p) => {
			const file = this.vault.getAbstractFileByPath(p);
			const stat = (file as any)?.stat;
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
				this.scheduler.run();
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

	private async toolGetSection(path: string, heading: string, maxDepth?: number) {
	    try {
	        const file = this.vault.getAbstractFileByPath(path);
	        if (!file) {
	            return {
	                content: [{ type: "text", text: "File not found: " + path }],
	                isError: true,
	            };
	        }
	        const content = await this.vault.read(file);
	        const section = extractSection(content, heading, maxDepth);
	        if (!section) {
	            const headings = extractHeadings(content);
	            return {
	                content: [{ type: "text", text: "Heading not found: " + heading + "\n\nAvailable headings:\n" + headings.join("\n") }],
	                isError: true,
	            };
	        }
	        return {
	            content: [{ type: "text", text: section }],
	        };
	    } catch (e) {
	        return {
	            content: [{ type: "text", text: "Error reading section: " + e }],
	            isError: true,
	        };
	    }
	}

	// ──── Helpers ────

	private readBody(req: IncomingMessage): Promise<string> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk) => chunks.push(chunk));
			req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
			req.on("error", reject);
		});
	}

	private sendJsonRpc(res: ServerResponse, response: JsonRpcResponse, status = 200) {
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(JSON.stringify(response));
	}
}
