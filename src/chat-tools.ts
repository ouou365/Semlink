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
	/** Returns the vault path of the note currently open in Obsidian (or
	 *  null when none). Injected by the plugin so tools can answer
	 *  "当前笔记" questions without the user naming the file. */
	private getActiveNote: () => string | null;

	/** Upper bound on a single tool result; adjustable per search depth. */
	maxResultChars = 4000;

	constructor(store: VectorStore, client: EmbeddingClient, vault: Vault, getActiveNote: () => string | null = () => null) {
		this.store = store;
		this.client = client;
		this.vault = vault;
		this.getActiveNote = getActiveNote;
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
						threshold: { type: "number", description: "相似度阈值 0-1（默认 0.2）" },
					},
					required: ["path"],
				},
			},
			{
				name: "list_indexed",
				description: "列出已索引的笔记路径（分页：limit 默认 200，用 offset 翻页；total 为总匹配数，truncated 表示是否还有更多）。",
				parameters: {
					type: "object",
					properties: {
						prefix: { type: "string", description: "路径前缀过滤（可选）" },
						limit: { type: "number", description: "最多返回条数（默认 200）" },
						offset: { type: "number", description: "跳过前 N 条（默认 0，用于翻页）" },
					},
				},
			},
			{
				name: "list_indexed_detailed",
				description:
					"列出已索引的笔记，每条附带创建时间和修改时间（ISO 格式），按修改时间倒序排列（最新在前），分页：limit 默认 100，用 offset 翻页。适合回答「最近记了哪些笔记」「最近修改了哪些笔记」等时间判断问题：直接取前几条即可，不要再猜。",
				parameters: {
					type: "object",
					properties: {
						prefix: { type: "string", description: "路径前缀过滤（可选）" },
						limit: { type: "number", description: "最多返回条数（默认 100）" },
						offset: { type: "number", description: "跳过前 N 条（默认 0，用于翻页）" },
					},
				},
			},
			{
				name: "grep_notes",
				description:
					"在 Vault 笔记中按文本或正则表达式精确搜索内容，适合精确关键词、编号、日期、代码片段等语义检索覆盖不到的内容。totalFiles 为匹配笔记总数；paths 字段返回匹配文件清单（completeList=true 时即完整清单，最多 200 个），一次调用即可拿到完整清单，不要用不同措辞或更大 limit 反复搜索。limit 仅控制附带行内容的文件数。",
				parameters: {
					type: "object",
					properties: {
						pattern: { type: "string", description: "要搜索的文本或正则表达式" },
						regex: { type: "boolean", description: "pattern 是否为正则表达式（默认 false，按普通文本匹配）" },
						pathFilter: { type: "string", description: "仅搜索路径前缀匹配的笔记，如 'projects/xxx'（可选）" },
						caseSensitive: { type: "boolean", description: "是否区分大小写（默认 false）" },
						limit: { type: "number", description: "最多返回的匹配文件数（默认 10，最大 30）" },
						contextLines: { type: "number", description: "每个匹配前后附带的上下文行数（默认 1，最大 3）" },
					},
					required: ["pattern"],
				},
			},
			{
				name: "get_active_note",
				description:
					"获取当前正在 Obsidian 中打开的笔记的路径（仅路径，不含内容）。适合「当前笔记是什么」「针对我正在看的这篇笔记」等需要当前上下文的问题。需要内容时请再用 get_note 按返回的路径读取。没有打开的笔记时返回明确提示。",
				parameters: { type: "object", properties: {} },
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
					return await this.toolListIndexed(args.prefix, args.limit, args.offset);
				case "list_indexed_detailed":
					return await this.toolListIndexedDetailed(args.prefix, args.limit, args.offset);
				case "grep_notes":
					return await this.toolGrepNotes(args.pattern, args.regex, args.pathFilter, args.caseSensitive, args.limit, args.contextLines);
				case "get_active_note":
					return await this.toolGetActiveNote();
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

	/** The note currently open in Obsidian — path only (content via get_note). */
	private async toolGetActiveNote(): Promise<string> {
		const path = this.getActiveNote();
		if (!path) {
			return "Error: 当前没有打开的笔记。请让用户先打开一篇笔记，或改用 search_notes / grep_notes 检索知识库。";
		}
		return `当前打开的笔记：${path}`;
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

	private async toolGetSimilarNotes(path: string, limit = 10, threshold = 0.2): Promise<string> {
		// Max-pooling over the note's own chunks (see DbEngine.searchRelatedNotes):
		// symmetric note→note similarity; probes chunks across the whole doc
		// instead of only chunks[0] (which is boilerplate for some large docs).
		const results = await this.store.searchRelatedNotes(path, limit, threshold, 6);

		return this.truncate(
			JSON.stringify(
				{
					sourcePath: path,
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

	private async toolListIndexed(prefix?: string, limit = 200, offset = 0): Promise<string> {
		const paths = await this.store.getAllIndexedPaths();
		const filtered = prefix
			? Array.from(paths).filter((p) => p.startsWith(prefix))
			: Array.from(paths);
		const total = filtered.length;
		const page = filtered.sort().slice(offset, offset + limit);
		const stats = await this.store.getStats();

		return this.truncate(
			JSON.stringify(
				{
					totalNotes: stats.indexedNotes,
					totalChunks: stats.activeChunks,
					total,
					listed: page.length,
					truncated: total > offset + limit,
					paths: page,
				},
				null,
				2,
			),
		);
	}

	/** list_indexed_detailed: paths + created/modified times, newest first
	 *  (so "最近记了哪些笔记" is answerable from the head of the list).
	 *  Paginated so a large vault never produces an oversized response. */
	private async toolListIndexedDetailed(prefix?: string, limit = 100, offset = 0): Promise<string> {
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

		return this.truncate(
			JSON.stringify(
				{
					totalNotes: stats.indexedNotes,
					totalChunks: stats.activeChunks,
					total,
					listed: page.length,
					truncated: total > offset + limit,
					notes: page,
				},
				null,
				2,
			),
		);
	}

	/**
	 * Grep the vault notes for exact text or a regex. Reads note contents from
	 * disk (accurate, current) and returns matching files with line numbers
	 * plus a few context lines — unlike semantic search, this finds exact
	 * keywords / IDs / dates that embedding retrieval can miss.
	 */
	private async toolGrepNotes(
		pattern: string,
		regex = false,
		pathFilter?: string,
		caseSensitive = false,
		limit = 10,
		contextLines = 1,
	): Promise<string> {
		if (!pattern) return "Error: missing pattern";

		// FAST PATH: plain-text (non-regex) searches hit the indexed chunks via
		// SQL LIKE — milliseconds instead of scanning every vault file. Only
		// regex / case-sensitive queries (which SQLite LIKE can't express
		// exactly) fall back to the full file scan below.
		if (!regex && !caseSensitive) {
			try {
				const dbHits = await this.store.textSearch(pattern, 200, pathFilter);
				if (dbHits.length > 0) {
					return this.truncate(
						JSON.stringify(
							{
								pattern,
								regex,
								caseSensitive,
								source: "indexed-chunks",
								totalFiles: dbHits.length,
								completeList: dbHits.length <= 200,
								paths: dbHits.map((h) => h.path),
								results: dbHits.slice(0, Math.min(Math.max(1, limit), 30)).map((h) => ({
									path: h.path,
									matchCount: h.matchCount,
									lines: h.preview ? [`L? : ${h.preview.trim().slice(0, 150)}`] : [],
								})),
							},
							null,
							2,
						),
						12000,
					);
				}
			} catch {
				// fall through to the full scan on any DB error
			}
		}

		let re: RegExp;
		try {
			re = new RegExp(regex ? pattern : this.escapeRegExp(pattern), caseSensitive ? "" : "i");
		} catch (e) {
			return `Error: invalid regex: ${e instanceof Error ? e.message : String(e)}`;
		}

		// `limit` controls how many files carry detailed lines; the COMPLETE
		// matching path list is always returned (up to MAX_PATHS) so "list all
		// notes mentioning X" is answered in a single call.
		const detailLimit = Math.min(Math.max(1, limit), 30);
		const MAX_PATHS = 200;
		const ctx = Math.min(Math.max(0, contextLines), 3);
		const maxLinesPerFile = 12;

		const files = this.vault.getFiles().filter((f) => {
			if (!/\.(md|txt|markdown)$/i.test(f.path)) return false;
			if (pathFilter && !f.path.toLowerCase().startsWith(pathFilter.toLowerCase())) return false;
			return true;
		});

		// Scan ALL files so `totalFiles` is exact (and completeList reliable);
		// detailed lines are only kept for the first `detailLimit` matches.
		// Reads run with bounded concurrency — sequentially awaiting thousands
		// of vault files froze the tool for tens of seconds.
		const CONCURRENCY = 32;
		let totalFiles = 0;
		const allPaths: string[] = [];
		const detailed: Array<{ path: string; matchCount: number; lines: string[] }> = [];
		for (let i = 0; i < files.length; i += CONCURRENCY) {
			const chunk = files.slice(i, i + CONCURRENCY);
			const batch = await Promise.all(
				chunk.map(async (file) => {
					try {
						// Skip pathological files; cachedRead keeps repeat calls fast.
						if (file.stat.size > 5 * 1024 * 1024) return null;
						const content = await this.vault.cachedRead(file);
						const lines = content.split("\n");
						let fileMatches = 0;
						const hits: string[] = [];
						for (let j = 0; j < lines.length; j++) {
							if (!re.test(lines[j])) continue;
							fileMatches++;
							if (hits.length >= maxLinesPerFile) continue;
							// Dedupe line labels around the match (overlapping context).
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

		return this.truncate(
			JSON.stringify(
				{
					pattern,
					regex,
					caseSensitive,
					totalFiles,
					// true = totalFiles ≤ MAX_PATHS，paths 即完整文件清单。
					completeList: totalFiles <= MAX_PATHS,
					paths: allPaths,
					results: detailed,
				},
				null,
				2,
			),
			12000,
		);
	}

	/** Escape a plain-text search term so it is matched literally. */
	private escapeRegExp(text: string): string {
		return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}

	private truncate(text: string, maxLen = this.maxResultChars): string {
		if (text.length <= maxLen) return text;
		return text.slice(0, maxLen) + "\n…(truncated)";
	}
}
