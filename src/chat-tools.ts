// ========================================
// Semlink - Chat Tool Registry
// ========================================
// Exposes Semlink's read/search capabilities as tools the chat model can call
// while answering (function calling). Reuses the same store/client/vault logic
// as the MCP server, minus write/admin tools (reindex, index_status).

import type { Vault } from "obsidian";
import type { VectorStore } from "./vector-store";
import type { EmbeddingClient } from "./embedding-client";
import { extractSection, extractHeadings } from "./section-utils";

/** Tool schema in a neutral form; ChatClient adapts it per API format. */
export interface ChatTool {
	name: string;
	description: string;
	parameters: Record<string, any>;
}

export class SemlinkTools {
	private store: VectorStore;
	private client: EmbeddingClient;
	private vault: Vault;

	/** Upper bound on a single tool result; adjustable per search depth. */
	maxResultChars = 4000;

	constructor(store: VectorStore, client: EmbeddingClient, vault: Vault) {
		this.store = store;
		this.client = client;
		this.vault = vault;
	}

	/** Read-only tools the chat model may call. */
	list(): ChatTool[] {
		return [
			{
				name: "search_notes",
				description:
					"语义检索 Vault 笔记。使用自然语言查询，返回最相关的笔记片段（路径、标题、预览、相似度）。",
				parameters: {
					type: "object",
					properties: {
						query: { type: "string", description: "自然语言搜索查询" },
						limit: { type: "number", description: "返回结果数量上限（默认 10）" },
						threshold: { type: "number", description: "相似度阈值 0-1（默认 0.3）" },
					},
					required: ["query"],
				},
			},
			{
				name: "get_note",
				description: "获取笔记的完整内容（可能被截断以节省上下文）。",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "笔记在 Vault 中的路径" },
					},
					required: ["path"],
				},
			},
			{
				name: "get_section",
				description:
					"获取笔记中指定标题下的章节内容。返回该标题到下一个同级或更高级标题之间的所有内容。适用于大文件时只读取特定章节。",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "笔记在 Vault 中的路径" },
						heading: { type: "string", description: "要读取的标题名称（不需要包含 # 符号）" },
						maxDepth: {
							type: "number",
							description:
								"包含的子标题最大深度，如目标标题是 ## 级(maxDepth=2)，则只包含 ## 及其内容，不包含 ### 及更深层。不传则包含所有子内容。",
						},
					},
					required: ["path", "heading"],
				},
			},
			{
				name: "get_similar_notes",
				description: "查找与指定笔记语义相似的其他笔记。",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "参考笔记路径" },
						limit: { type: "number", description: "返回结果数量上限（默认 10）" },
						threshold: { type: "number", description: "相似度阈值 0-1（默认 0.4）" },
					},
					required: ["path"],
				},
			},
			{
				name: "list_indexed",
				description: "列出已索引的笔记路径（可用前缀过滤）。",
				parameters: {
					type: "object",
					properties: {
						prefix: { type: "string", description: "路径前缀过滤（可选）" },
					},
				},
			},
		];
	}

	/** Execute a tool by name; always returns a text result (errors included). */
	async execute(name: string, args: Record<string, any>): Promise<string> {
		try {
			switch (name) {
				case "search_notes":
					return await this.toolSearchNotes(args.query, args.limit, args.threshold);
				case "get_note":
					return await this.toolGetNote(args.path);
				case "get_section":
					return await this.toolGetSection(args.path, args.heading, args.maxDepth);
				case "get_similar_notes":
					return await this.toolGetSimilarNotes(args.path, args.limit, args.threshold);
				case "list_indexed":
					return await this.toolListIndexed(args.prefix);
				default:
					return `Error: unknown tool "${name}"`;
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return `Error: ${msg}`;
		}
	}

	// ──── Tool implementations (mirror the MCP server) ────

	private async toolSearchNotes(query: string, limit = 10, threshold = 0.3): Promise<string> {
		if (!query) return "Error: missing query";
		const embedResult = await this.client.embed([query]);
		const results = await this.store.search(embedResult.embeddings[0], limit, threshold);

		return this.truncate(
			JSON.stringify(
				{
					query,
					totalResults: results.length,
					results: results.map((r) => ({
						path: r.notePath,
						heading: r.heading,
						preview: r.contentPreview,
						score: r.score,
					})),
				},
				null,
				2,
			),
		);
	}

	private async toolGetNote(path: string): Promise<string> {
		const file = this.vault.getAbstractFileByPath(path);
		if (!file) return `Error: file not found: ${path}`;
		const content = await this.vault.read(file);
		return this.truncate(content);
	}

	private async toolGetSection(path: string, heading: string, maxDepth?: number): Promise<string> {
		const file = this.vault.getAbstractFileByPath(path);
		if (!file) return `Error: file not found: ${path}`;
		const content = await this.vault.read(file);
		const section = extractSection(content, heading, maxDepth);
		if (!section) {
			return `Error: heading not found: ${heading}\n\nAvailable headings:\n${extractHeadings(content).join("\n")}`;
		}
		return this.truncate(section);
	}

	private async toolGetSimilarNotes(path: string, limit = 10, threshold = 0.4): Promise<string> {
		const chunks = await this.store.getChunksByNotePath(path);
		if (chunks.length === 0) return `Error: no indexed chunks found for: ${path}`;

		const embedResult = await this.client.embed([chunks[0].content]);
		const results = await this.store.search(embedResult.embeddings[0], limit + 5, threshold);
		const filtered = results.filter((r) => r.notePath !== path).slice(0, limit);

		return this.truncate(
			JSON.stringify(
				{
					sourcePath: path,
					totalResults: filtered.length,
					results: filtered.map((r) => ({
						path: r.notePath,
						heading: r.heading,
						preview: r.contentPreview,
						score: r.score,
					})),
				},
				null,
				2,
			),
		);
	}

	private async toolListIndexed(prefix?: string): Promise<string> {
		const paths = await this.store.getAllIndexedPaths();
		const filtered = prefix
			? Array.from(paths).filter((p) => p.startsWith(prefix))
			: Array.from(paths);
		const stats = await this.store.getStats();

		return this.truncate(
			JSON.stringify(
				{
					totalNotes: stats.indexedNotes,
					totalChunks: stats.activeChunks,
					listed: filtered.length,
					paths: filtered.sort(),
				},
				null,
				2,
			),
		);
	}

	private truncate(text: string, maxLen = this.maxResultChars): string {
		if (text.length <= maxLen) return text;
		return text.slice(0, maxLen) + "\n…(truncated)";
	}
}
