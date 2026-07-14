// ========================================
// Semlink - HTTP MCP Server
// ========================================

import { createServer, IncomingMessage, ServerResponse, Server } from "http";
import { VectorStore } from "./vector-store";
import { EmbeddingClient } from "./embedding-client";
import { ProgressTracker } from "./progress";
import { Scheduler } from "./scheduler";
import { makePreview } from "./chunker";
import { readFileSync } from "fs";
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

	constructor(
		store: VectorStore,
		client: EmbeddingClient,
		progress: ProgressTracker,
		scheduler: Scheduler,
		settings: SmartVaultSettings,
		vault: any,
	) {
		this.store = store;
		this.client = client;
		this.progress = progress;
		this.scheduler = scheduler;
		this.settings = settings;
		this.vault = vault;
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
					description: "列出已索引的笔记",
					inputSchema: {
						type: "object",
						properties: {
							prefix: {
								type: "string",
								description: "路径前缀过滤（可选）",
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
				return await this.toolListIndexed(args.prefix);
			case "index_status":
				return await this.toolIndexStatus();
			case "reindex":
				return await this.toolReindex(args.path, args.force);
			case "get_section":
				return await this.toolGetSection(args.path, args.heading, args.maxDepth);
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

	private async toolListIndexed(prefix?: string) {
		const paths = await this.store.getAllIndexedPaths();
		const filtered = prefix
			? Array.from(paths).filter((p) => p.startsWith(prefix))
			: Array.from(paths);

		const stats = await this.store.getStats();

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						totalNotes: stats.indexedNotes,
						totalChunks: stats.activeChunks,
						listed: filtered.length,
						paths: filtered.sort(),
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
        const section = this.extractSection(content, heading, maxDepth);
        if (!section) {
            const headings = this.extractHeadings(content);
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

    private extractSection(content: string, heading: string, maxDepth?: number): string | null {
        const lines = content.split("\n");
        const HEADING_RE = /^(#{1,6})\s+(.+)$/;
        let targetLevel = -1;
        let startIdx = -1;

        // Find the target heading
        for (let i = 0; i < lines.length; i++) {
            const match = lines[i].match(HEADING_RE);
            if (match && match[2].trim() === heading.trim()) {
                targetLevel = match[1].length;
                startIdx = i;
                break;
            }
        }

        if (startIdx === -1) return null;

        // Collect lines until the next heading of same or higher level
        const collected: string[] = [];
        for (let i = startIdx; i < lines.length; i++) {
            const match = lines[i].match(HEADING_RE);
            if (i > startIdx && match) {
                const level = match[1].length;
                // Stop at same or higher level heading
                if (level <= targetLevel) break;
            }
            // If maxDepth specified, skip headings and their content that are too deep
            if (maxDepth !== undefined && match && match[1].length > maxDepth) {
                continue;
            }
            collected.push(lines[i]);
        }

        return collected.join("\n");
    }

    private extractHeadings(content: string): string[] {
        const lines = content.split("\n");
        const HEADING_RE = /^(#{1,6})\s+(.+)$/;
        const headings: string[] = [];
        for (const line of lines) {
            const match = line.match(HEADING_RE);
            if (match) {
                headings.push("#".repeat(match[1].length) + " " + match[2].trim());
            }
        }
        return headings;
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
