// ========================================
// Semlink - Shared tool core (MCP server + chat agent)
// ========================================
// Single source of truth for the read/search toolset: TOOL_SPECS feeds both
// the MCP `tools/list` and the chat agent's function-calling definitions, and
// ToolCore implements every tool once so the two surfaces cannot drift.
//
// Naming follows git/linux muscle memory (ls/read/grep/find/status), and the
// tools are composable: every tool accepts and returns the same form of
// vault-relative path, grep emits line numbers that `read` consumes via
// offset/limit, and pagination is always limit/offset.

import type { Vault, TFile } from "obsidian";
import type { VectorStore } from "./vector-store";
import type { EmbeddingClient } from "./embedding-client";
import type { IndexProgress } from "./types";
import { extractSection } from "./section-utils";

export interface ToolSpec {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

const FALLBACK_CONTEXT = 128000;
const RRF_K = 60;

/** 12 个工具的统一声明：MCP tools/list 与聊天 Agent 共用。 */
export const TOOL_SPECS: ToolSpec[] = [
	{
		name: "search",
		description:
			"Universal search entry point (use this first): runs BM25 keyword search and vector semantic search in parallel, fuses both ranked lists with Reciprocal Rank Fusion, and returns a single deduplicated ranking. When the vector path is unavailable (no embedding model configured / vector search disabled / nothing indexed yet) it automatically degrades to BM25-only results; meta.sources reports what was actually used. For exact terms prefer keyword.",
			parameters: {
				type: "object",
				properties: {
					query: { type: "string", description: "Natural-language query or keyword combination" },
					limit: { type: "number", description: "Max results (default 10)" },
					path: { type: "string", description: "Vault-relative path prefix filter, e.g. 'projects/' (optional; disk paths are auto-normalized)" },
					exclude: { type: "array", items: { type: "string" }, description: "Path prefixes to drop from results (optional, e.g. ['templates/','attachments/'])" },
					alpha: { type: "number", description: "Fusion weight 0-1: 0 = BM25 only, 1 = vector only (default 0.5)" },
				},
				required: ["query"],
			},
		},
		{
			name: "keyword",
			description:
				"Keyword-only search scored with BM25. No embedding dependency — always available. Best for exact terms, IDs, dates, code identifiers that semantic retrieval can miss.",
			parameters: {
				type: "object",
				properties: {
					query: { type: "string", description: "Keyword combination, space-separated terms (union scored)" },
					limit: { type: "number", description: "Max results (default 10)" },
					path: { type: "string", description: "Vault-relative path prefix filter, e.g. 'projects/' (optional; disk paths are auto-normalized)" },
					exclude: { type: "array", items: { type: "string" }, description: "Path prefixes to drop from results (optional)" },
					case_sensitive: { type: "boolean", description: "Case-sensitive matching (default false)" },
				},
				required: ["query"],
			},
		},
		{
			name: "semantic",
			description:
				"Pure semantic vector search: natural-language query returns the most relevant note passages (path, heading, preview, score). Controlled by the vector-search toggle; returns an explicit 'unavailable' message instead of empty results when no embedding model is configured.",
			parameters: {
				type: "object",
				properties: {
					query: { type: "string", description: "Natural-language search query" },
					limit: { type: "number", description: "Max results (default 10)" },
					threshold: { type: "number", description: "Similarity threshold 0-1 (default 0.3)" },
					exclude: { type: "array", items: { type: "string" }, description: "Path prefixes to drop from results (optional)" },
				},
				required: ["query"],
			},
		},
	{
		name: "ls",
		description:
			"List indexed notes with created/modified ISO timestamps. Supports sorting, date-range filters, path prefix and limit/offset pagination — like ls -la. Best for 'what did I note recently' / 'what's in this folder'.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "Vault-relative path prefix filter, e.g. 'projects/' (optional; disk paths are auto-normalized)" },
					exclude: { type: "array", items: { type: "string" }, description: "Path prefixes to drop from results (optional)" },
					sort: { type: "string", description: "modified (default, newest first) | created | name" },
				limit: { type: "number", description: "Max entries (default 50)" },
				offset: { type: "number", description: "Skip first N entries (default 0, for pagination)" },
				recursive: { type: "boolean", description: "Include subfolders (default true); false lists only direct children of path" },
				since: { type: "string", description: "Only notes modified on/after this date (YYYY-MM-DD, optional)" },
				until: { type: "string", description: "Only notes modified on/before this date (YYYY-MM-DD, optional)" },
			},
		},
	},
	{
		name: "read",
		description:
			"Read note content with line numbers (cat -n style); metadata includes total_lines, offset and end_line - use them to bookkeep coverage. offset supports negative values (-20 = last 20 lines, i.e. tail); heading jumps straight to a section. For long tables/matrices read in segments of <=40 lines (grep's line map → offset/limit here) and enumerate every row per segment before answering.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Note path in the vault" },
				offset: { type: "number", description: "Start line (1-based); negative counts from the end (-20 = last 20 lines)" },
				limit: { type: "number", description: "Number of lines to return (default: to the end)" },
				heading: { type: "string", description: "Locate a section by heading text (without the # marks); offset/limit apply within the section" },
				max_depth: { type: "number", description: "Max sub-heading depth to include for heading (optional)" },
			},
			required: ["path"],
		},
	},
	{
		name: "grep",
		description:
			"Exact text or regex search across note contents, emitting 'file:line: content' — line numbers form a row map that feeds directly into read's offset/limit. Per file reports matchCount and linesOmitted: if linesOmitted > 0 keep paging (offset/limit) or read the file segments until coverage is complete. Best for exact keywords, IDs, dates, code identifiers.",
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "Text or regular expression" },
				regex: { type: "boolean", description: "Treat pattern as regex (default false: literal text)" },
				path: { type: "string", description: "Vault-relative path prefix filter, e.g. 'projects/' (optional; disk paths are auto-normalized)" },
				exclude: { type: "array", items: { type: "string" }, description: "Path prefixes to skip entirely (optional)" },
				case_sensitive: { type: "boolean", description: "Case-sensitive matching (default false)" },
				context: { type: "number", description: "Context lines around each match (default 1, max 3)" },
				limit: { type: "number", description: "Max files with detailed lines (default 10, max 30)" },
				offset: { type: "number", description: "Skip first N matching files (default 0, for pagination)" },
			},
			required: ["pattern"],
		},
	},
	{
		name: "find",
		description:
			"Find notes by filename (like find -iname): supports * wildcards and substrings, e.g. '*ECS*'. Matches names/paths only — not content.",
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "Filename glob or substring, e.g. '*weekly*'" },
				path: { type: "string", description: "Vault-relative path prefix filter, e.g. 'projects/' (optional; disk paths are auto-normalized)" },
				exclude: { type: "array", items: { type: "string" }, description: "Path prefixes to drop from results (optional)" },
				limit: { type: "number", description: "Max entries (default 20)" },
			},
			required: ["pattern"],
		},
	},
	{
		name: "headings",
		description:
			"Return the note's outline as [{level, text, line}] in document order. More reliable than grepping for '#' (ignores code blocks); line doubles as a precise offset for read.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Note path in the vault" },
			},
			required: ["path"],
		},
	},
	{
		name: "links",
		description:
			"Return the note's wikilink graph: backlinks (notes linking to it, with the matching line) and outlinks (notes it links to). Complements semantic similarity with exact reference relations.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Note path in the vault" },
			},
			required: ["path"],
		},
	},
	{
		name: "active",
		description:
			"Get the path of the note currently open in Obsidian (path only). For 'what am I looking at' / 'about my current note' questions; use read for content.",
		parameters: { type: "object", properties: {} },
	},
	{
		name: "status",
		description: "Get current index status and progress (phase, notes, chunks, failures).",
		parameters: { type: "object", properties: {} },
	},
	{
		name: "reindex",
		description: "Trigger reindexing (single file, or full rebuild with force=true). Admin tool.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Rebuild this file only (optional)" },
				force: { type: "boolean", description: "Clear existing data and rebuild fully (default false)" },
			},
		},
	},
];

export interface ToolCoreDeps {
	store: VectorStore;
	client: EmbeddingClient;
	vault: Vault;
	getActiveNote: () => string | null;
	/** 进度快照（status 用）。 */
	progress: () => IndexProgress;
	/** 重建索引（reindex 用）：由宿主注入（MCP 走 scheduler，聊天侧走插件）。 */
	reindex: (path?: string, force?: boolean) => Promise<unknown>;
	/** 全局排除前缀（设置 excludePaths 的运行时兜底——已索引的旧内容也挡在结果外）。
	 *  语义与索引侧（scheduler/watcher）一致：startsWith || includes。 */
	excludedPaths?: () => string[];
}

/** 解析设置里的 excludePaths（每行一个前缀）。与索引侧同源同语义。 */
export function parseExcludePaths(raw: string): string[] {
	return raw
		.split("\n")
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
}

interface SearchResultLike {
	n?: number | null;
	path: string;
	heading?: string | null;
	preview?: string | null;
	score: number;
}

/** First "L<line>:" number in a grep result's line list — the citation's
 *  jump-to anchor. Context lines may precede the match, so this lands at
 *  most `context` lines above the hit; close enough for a jump target. */
function firstHitLine(lines: string[]): number | undefined {
	for (const l of lines) {
		const m = /^L(\d+):/.exec(l);
		if (m) return Number(m[1]);
	}
	return undefined;
}

/** 12 个工具的唯一实现。MCP server 与聊天 Agent 都委托到这里。 */
export class ToolCore {
	/** 单次输出的字符上限（聊天侧 4000，MCP 侧 12000）。 */
	maxChars = 8000;
	/** 引用编号钩子：聊天侧注入，让出现的路径带全局 [n]。 */
	cite: ((path: string, line?: number, kind?: "read" | "hit") => number | null) | null = null;

	constructor(private deps: ToolCoreDeps) {}

	/** 按名称执行工具；永远返回文本（错误也文本化）。 */
	async execute(name: string, args: Record<string, unknown>): Promise<string> {
		// 旧会话兼容：历史上下文里模型可能仍按旧名调用，映射到新工具（不对外声明）
		const legacy: Record<string, string> = {
			search_notes: "search",
			get_note: "read",
			get_section: "read",
			grep_notes: "grep",
			search_bm25: "keyword",
			search_vector: "semantic",
			list_indexed: "ls",
			list_indexed_detailed: "ls",
			get_active_note: "active",
		};
		if (legacy[name]) name = legacy[name]!;
		const a = args as Record<string, string | number | boolean | string[] | undefined>;
		// 工具参数 exclude（string[]）——与全局设置排除合并，见 excludedMatch()
		const exclude = (a.exclude as string[] | undefined) ?? undefined;
		try {
			switch (name) {
				case "search":
					return await this.search(String(a.query ?? ""), Number(a.limit) || 10, a.path as string | undefined, Number(a.alpha) || 0.5, exclude);
				case "keyword":
					return await this.searchBm25(String(a.query ?? ""), Number(a.limit) || 10, a.path as string | undefined, Boolean(a.case_sensitive), exclude);
				case "semantic":
					return await this.searchVector(String(a.query ?? ""), Number(a.limit) || 10, Number(a.threshold) || 0.3, exclude);
				case "ls":
					return await this.ls(a.path as string | undefined, (a.sort as string) ?? "modified", Number(a.limit) || 50, Number(a.offset) || 0, a.recursive !== false, a.since as string | undefined, a.until as string | undefined, exclude);
				case "read":
					return await this.read(String(a.path ?? ""), Number(a.offset) || 0, a.limit === undefined ? undefined : Number(a.limit), a.heading as string | undefined, a.max_depth === undefined ? undefined : Number(a.max_depth));
				case "grep":
					return await this.grep(String(a.pattern ?? ""), Boolean(a.regex), a.path as string | undefined, Boolean(a.case_sensitive), Number(a.context) === 0 ? 0 : Number(a.context) || 1, Number(a.limit) || 10, Number(a.offset) || 0, exclude);
				case "find":
					return await this.find(String(a.pattern ?? ""), a.path as string | undefined, Number(a.limit) || 20, exclude);
				case "headings":
					return await this.headings(String(a.path ?? ""));
				case "links":
					return await this.links(String(a.path ?? ""));
				case "active":
					return await this.active();
				case "status":
					return await this.status();
				case "reindex":
					return await this.reindex(a.path as string | undefined, Boolean(a.force));
				default:
					return `Error: unknown tool "${name}"`;
			}
		} catch (e) {
			return `Error: ${e instanceof Error ? e.message : String(e)}`;
		}
	}

	// ──── 检索 ────

	/** 运行时排除判定：全局设置排除 ∪ 本次调用参数 exclude。
	 *  语义与索引侧（scheduler/watcher 的 isExcluded）一致：前缀或包含即排除。
	 *  过滤一律发生在 IO/打分之前——被排除的文件不进入读取队列。 */
	private excludedMatch(path: string, extra?: string[]): boolean {
		for (const g of this.deps.excludedPaths?.() ?? []) {
			if (g.length > 0 && (path.startsWith(g) || path.includes(g))) return true;
		}
		for (const e of extra ?? []) {
			const p = e.trim();
			if (p.length > 0 && (path.startsWith(p) || path.includes(p))) return true;
		}
		return false;
	}

	/** 把调用方传入的 path 前缀规范化为 vault 相对路径。MCP/聊天侧的
	 *  调用方常给磁盘绝对路径（D:\…\vault\ECS/）或反斜杠分隔——不处理
	 *  的话 startsWith 永远不成立，前缀过滤会吃掉全部结果。
	 *  规范化：反斜杠→/；剥离 vault 根的磁盘前缀（desktop 的
	 *  FileSystemAdapter.getBasePath）；去首尾 /。仍是盘符形态（拿不到
	 *  basePath 的环境）时丢弃前缀并标记 dropped，宁可多回结果也不空手。 */
	private resolvePrefix(raw?: string): { prefix: string; dropped: boolean } {
		if (!raw || !raw.trim()) return { prefix: "", dropped: false };
		let p = raw.trim().replace(/\\/g, "/");
		try {
			const base = (this.deps.vault.adapter as { getBasePath?: () => string }).getBasePath?.();
			if (base) {
				const normBase = base.replace(/\\/g, "/").replace(/\/+$/, "");
				if (p.toLowerCase().startsWith(normBase.toLowerCase())) {
					p = p.slice(normBase.length);
				}
			}
		} catch {
			// adapter 不支持 → 走通用规范化
		}
		p = p.replace(/^\/+/, "").replace(/\/+$/, "");
		if (/^[a-zA-Z]:/.test(p)) return { prefix: "", dropped: true };
		return { prefix: p, dropped: false };
	}

	/** 通用检索：BM25 + 向量并行，RRF 融合；向量路不可用时纯 BM25 兜底。 */
	async search(query: string, limit = 10, path?: string, alpha = 0.5, exclude?: string[]): Promise<string> {
		if (!query.trim()) return "Error: missing query";
		const { prefix } = this.resolvePrefix(path);
		const useVector = this.deps.store.searchGate();
		const [bm25, vector] = (await Promise.all([
			this.bm25Raw(query, limit * 2, prefix || undefined, false, exclude).catch(() => []),
			useVector
				? this.vectorRaw(query, limit * 2, 0.2, prefix || undefined, exclude).catch(() => [])
				: Promise.resolve([] as SearchResultLike[]),
		])) as [SearchResultLike[], SearchResultLike[]];
		const sources: string[] = [];
		if (bm25.length > 0) sources.push("bm25");
		if (vector.length > 0) sources.push("vector");

		// RRF 融合：score = alpha/(k+rankVector) + (1-alpha)/(k+rankBm25)
		const fused = new Map<string, SearchResultLike>();
		bm25.forEach((r, i) => {
			const prev = fused.get(r.path);
			const add = ((1 - alpha) * 1) / (RRF_K + i + 1);
			fused.set(r.path, prev ? { ...prev, score: prev.score + add } : { ...r, score: add });
		});
		vector.forEach((r, i) => {
			const prev = fused.get(r.path);
			const add = (alpha * 1) / (RRF_K + i + 1);
			fused.set(r.path, prev ? { ...prev, score: prev.score + add, heading: r.heading ?? prev.heading, preview: r.preview ?? prev.preview } : { ...r, score: add });
		});

		const results = [...fused.values()]
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map((r) => ({ n: this.cite?.(r.path), path: r.path, heading: r.heading, preview: r.preview, score: Math.round(r.score * 1000) / 1000 }));

		return this.truncate(
			JSON.stringify({ query, sources, total: results.length, results }, null, 2),
		);
	}

	/** 纯 BM25-lite：分词 → LIKE 候选 → idf/tf 打分。 */
	async searchBm25(query: string, limit = 10, path?: string, caseSensitive = false, exclude?: string[]): Promise<string> {
		if (!query.trim()) return "Error: missing query";
		const { prefix } = this.resolvePrefix(path);
		const results = await this.bm25Raw(query, limit, prefix || undefined, caseSensitive, exclude);
		return this.truncate(
			JSON.stringify(
				{
					query,
					sources: ["bm25"],
					total: results.length,
					results: results.map((r) => ({ n: this.cite?.(r.path), path: r.path, preview: r.preview, score: Math.round(r.score * 1000) / 1000 })),
				},
				null,
				2,
			),
		);
	}

	/** 纯向量检索；不可用时返回明确的提示而不是空结果。 */
	async searchVector(query: string, limit = 10, threshold = 0.3, exclude?: string[]): Promise<string> {
		if (!query.trim()) return "Error: missing query";
		if (!this.deps.store.searchGate()) {
			return JSON.stringify({
				error: "Vector search is unavailable: no embedding model is configured. Set one up in the RAG settings, or use keyword / grep instead.",
			});
		}
		const results = await this.vectorRaw(query, limit, threshold, undefined, exclude);
		return this.truncate(
			JSON.stringify(
				{
					query,
					sources: ["vector"],
					total: results.length,
					results: results.map((r) => ({ n: this.cite?.(r.path), path: r.path, heading: r.heading, preview: r.preview, score: r.score })),
				},
				null,
				2,
			),
		);
	}

	/** BM25 检索：先查索引 chunk（毫秒级），未命中则兜底扫描 Vault 文件——
	 *  BM25 兜底必须兜得住：内容还没索引时也能按文件词频返回结果。 */
	private async bm25Raw(query: string, limit: number, path?: string, caseSensitive = false, exclude?: string[]): Promise<SearchResultLike[]> {
		const indexed = await this.bm25Indexed(query, limit, path, caseSensitive, exclude);
		if (indexed.length > 0) return indexed.slice(0, limit);
		return await this.bm25FileScan(query, limit, path, caseSensitive, exclude);
	}

	/** 索引快路径：分词 → 每个词 LIKE 取候选 → idf·饱和tf 累计打分。 */
	private async bm25Indexed(query: string, limit: number, path?: string, caseSensitive = false, exclude?: string[]): Promise<SearchResultLike[]> {
		const tokens = this.tokenize(query);
		if (tokens.length === 0) return [];
		// 排除在 SQL（NOT LIKE）与结果层各挡一道：索引里可能仍有规则变更前的旧内容
		const globalExcludes = [...(this.deps.excludedPaths?.() ?? []), ...(exclude ?? [])];
		const scores = new Map<string, { score: number; preview: string | null }>();
		for (const token of tokens) {
			let hits: Array<{ path: string; matchCount: number; preview: string }> = [];
			try {
				hits = await this.deps.store.textSearch(token, Math.min(limit * 3, 200), path, globalExcludes.length > 0 ? globalExcludes : undefined);
			} catch {
				return []; // 索引不可用 → 交给文件扫描兜底
			}
			const df = Math.max(hits.length, 1);
			const idf = Math.log(1 + 200 / df);
			for (const h of hits) {
				if (this.excludedMatch(h.path, exclude)) continue;
				const tf = h.matchCount > 0 ? h.matchCount / (h.matchCount + 1.2) : 0;
				const prev = scores.get(h.path);
				scores.set(h.path, { score: (prev?.score ?? 0) + idf * tf, preview: prev?.preview ?? h.preview });
			}
		}
		return [...scores.entries()]
			.map(([p, v]) => ({ path: p, preview: v.preview, score: v.score }))
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);
	}

	/** 文件扫描兜底：并发读取笔记内容，按命中词数与词覆盖打分。 */
	private async bm25FileScan(query: string, limit: number, path?: string, caseSensitive = false, exclude?: string[]): Promise<SearchResultLike[]> {
		const tokens = this.tokenize(query);
		if (tokens.length === 0) return [];
		const res = new RegExp(tokens.map((t) => this.escapeRegExp(t)).join("|"), caseSensitive ? "g" : "gi");
		const base = path ? path.replace(/\/+$/, "") : "";
		const files = this.deps.vault.getFiles().filter((f) => {
			if (!/\.(md|txt|markdown)$/i.test(f.path)) return false;
			if (base && !f.path.startsWith(base)) return false;
			return !this.excludedMatch(f.path, exclude);
		});
		const scored: SearchResultLike[] = [];
		const CONCURRENCY = 32;
		for (let i = 0; i < files.length; i += CONCURRENCY) {
			const batch = await Promise.all(
				files.slice(i, i + CONCURRENCY).map(async (file) => {
					try {
						if (file.stat.size > 5 * 1024 * 1024) return null;
						const content = await this.deps.vault.cachedRead(file);
						const matches = content.match(res);
						if (!matches || matches.length === 0) return null;
						const distinct = new Set(matches.map((m) => m.toLowerCase())).size;
						const tf = matches.length / (matches.length + 1.2);
						const firstLine = content.split("\n").find((l) => res.test(l)) ?? "";
						return { path: file.path, preview: firstLine.trim().slice(0, 150), score: distinct + tf };
					} catch {
						return null;
					}
				}),
			);
			for (const r of batch) if (r) scored.push(r);
		}
		return scored.sort((a, b) => b.score - a.score).slice(0, limit);
	}

	/** 查询分词：空白与中英文标点切分，最多 8 个词。 */
	private tokenize(query: string): string[] {
		const raw = query
			.toLowerCase()
			.split(/[s,，。；;-‑–—]+/u)
			.map((t) => t.trim())
			.filter((t) => t.length > 0)
			.slice(0, 8);
		// CJK 长词拆 2-gram（无空格语言的实用检索方案）；ASCII 词整词保留
		const out: string[] = [];
		for (const t of raw) {
			// 纯 ASCII（0x00-0x7F）整词保留。不用正则字符类：字面控制字节会把源文件
			// 变成二进制，转义写法又触发 no-control-regex 门禁，改用码点循环判定。
			const isAscii = [...t].every((ch) => ch.charCodeAt(0) <= 0x7f);
			if (isAscii || t.length <= 3) {
				out.push(t);
				continue;
			}
			for (let i = 0; i + 2 <= t.length; i++) out.push(t.slice(i, i + 2));
		}
		return [...new Set(out)].slice(0, 16);
	}


	/** 向量原始结果：embed → store.search。路径前缀与排除谓词下推到
	 *  向量扫描内部（打分循环按 note_path 跳过）——一次扫描返回过滤后的
	 *  精确 topN：无 over-fetch、无多余元数据查询，候选被排除占据时也
	 *  不会凑不满 limit。 */
	private async vectorRaw(query: string, limit: number, threshold: number, path?: string, exclude?: string[]): Promise<SearchResultLike[]> {
		const embedResult = await this.deps.client.embed([query]);
		const excludes = [...(this.deps.excludedPaths?.() ?? []), ...(exclude ?? [])]
			.map((p) => p.trim())
			.filter((p) => p.length > 0);
		const hits = await this.deps.store.search(
			embedResult.embeddings[0],
			limit,
			threshold,
			path,
			excludes.length > 0 ? excludes : undefined,
		);
		return hits.map((r) => ({ path: r.notePath, heading: r.heading, preview: r.contentPreview, score: r.score }));
	}

	// ──── 导航与读取 ────

	async ls(
		prefix: string | undefined,
		sort: string,
		limit: number,
		offset: number,
		recursive: boolean,
		since?: string,
		until?: string,
		exclude?: string[],
	): Promise<string> {
		const paths = await this.deps.store.getAllIndexedPaths();
		const { prefix: base } = this.resolvePrefix(prefix);
		const notes: Array<{ path: string; created: string | null; modified: string | null }> = [];
		for (const p of paths) {
			if (base && !p.startsWith(base)) continue;
			if (this.excludedMatch(p, exclude)) continue;
			if (!recursive) {
				const rel = base ? p.slice(base.length).replace(/^\/+/, "") : p;
				if (rel.includes("/")) continue;
			}
			const file = this.deps.vault.getAbstractFileByPath(p) as TFile | null;
			const stat = file?.stat;
			const created = stat ? new Date(stat.ctime).toISOString() : null;
			const modified = stat ? new Date(stat.mtime).toISOString() : null;
			if (since && (!modified || modified.slice(0, 10) < since)) continue;
			if (until && (!modified || modified.slice(0, 10) > until)) continue;
			notes.push({ path: p, created, modified });
		}
		if (sort === "name") notes.sort((a, b) => a.path.localeCompare(b.path));
		else if (sort === "created") notes.sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""));
		else notes.sort((a, b) => (b.modified ?? "").localeCompare(a.modified ?? ""));
		const total = notes.length;
		const page = notes.slice(offset, offset + limit);
		const stats = await this.deps.store.getStats();
		return this.truncate(
			JSON.stringify(
				{
					sort,
					total,
					listed: page.length,
					truncated: total > offset + limit,
					vault: { indexedNotes: stats.indexedNotes, activeChunks: stats.activeChunks },
					notes: page,
				},
				null,
				2,
			),
		);
	}

	async read(
		path: string,
		offset = 0,
		limit?: number,
		heading?: string,
		maxDepth?: number,
	): Promise<string> {
		if (!path) return "Error: missing path";
		const file = this.deps.vault.getAbstractFileByPath(path);
		if (!file) return `Error: file not found: ${path}`;
		const content = await this.deps.vault.read(file as TFile);
		const lines = content.split("\n");
		const totalLines = lines.length;

		let body = content;
		let bodyOffsetLines = 0;
		if (heading) {
			const section = extractSection(content, heading, maxDepth);
			if (!section) {
				return `Error: heading not found: ${heading}\n\nAvailable headings:\n${lines
					.map((l, i) => ({ l, i }))
					.filter(({ l }) => /^#{1,6}\s/.test(l))
					.map(({ l, i }) => `L${i + 1}: ${l.trim()}`)
					.join("\n")}`;
			}
			body = section;
			bodyOffsetLines = content.slice(0, content.indexOf(section)).split("\n").length - 1;
		}
		const sectionLines = body.split("\n");
		const sectionTotal = sectionLines.length;

		// offset：1-based；负数 = 从末尾倒数
		let start = offset === 0 ? 1 : offset > 0 ? offset : Math.max(1, sectionTotal + offset + 1);
		let count = limit ?? sectionTotal - start + 1;
		if (start > sectionTotal) {
			start = sectionTotal;
			count = 0;
		}
		const slice = sectionLines.slice(start - 1, start - 1 + Math.max(0, count));
		const numbered = slice.map((text, i) => `L${bodyOffsetLines + start + i}: ${text}`);
		// Register the read with its first content line so clicking [n] jumps there.
		// A no-offset full read of a LONG file anchors at L1 (the TOC) — useless
		// as a jump target, so skip it and let a grep hit or a later segmented
		// read anchor the note instead. Short files: L1 is fine.
		const anchorLine = bodyOffsetLines + start;
		const header = this.citeHeader(path, anchorLine > 1 || totalLines <= 400 ? anchorLine : undefined, "read");
		// 超过单次上限时按行收缩 content，JSON 永远有效，并显式标注
		// truncated + next_offset——模型据此继续读，不会忽视截断。
		const remaining = sectionTotal - (start - 1) - slice.length;
		const build = (keep: number): string =>
			JSON.stringify(
				{
					path,
					totalLines,
					totalChars: content.length,
					offset: start,
					endLine: bodyOffsetLines + start + keep - 1,
					returned: keep,
					...(keep < slice.length || remaining > 0
						? { truncated: true, next_offset: bodyOffsetLines + start + keep }
						: {}),
					...(heading ? { heading } : {}),
					content: numbered.slice(0, keep).join("\n"),
					...(header ? { cite: header.trim() } : {}),
				},
				null,
				2,
			);
		let out = build(slice.length);
		if (out.length > this.maxChars) {
			let keep = slice.length;
			while (keep > 1 && build(keep).length > this.maxChars) keep = Math.floor(keep * 0.8);
			out = build(Math.max(1, keep));
		}
		return out;
	}

	async grep(
		pattern: string,
		regex: boolean,
		path: string | undefined,
		caseSensitive: boolean,
		context: number,
		limit: number,
		offset: number,
		exclude?: string[],
	): Promise<string> {
		if (!pattern) return "Error: missing pattern";

		const re = new RegExp(regex ? pattern : this.escapeRegExp(pattern), caseSensitive ? "" : "i");
		const detailLimit = Math.min(Math.max(1, limit), 30);
		const MAX_PATHS = 200;
		const ctx = Math.min(Math.max(0, context), 3);
		const maxLinesPerFile = 60;
		const { prefix: pathBase } = this.resolvePrefix(path);

		const files = this.deps.vault.getFiles().filter((f) => {
			if (!/\.(md|txt|markdown)$/i.test(f.path)) return false;
			if (pathBase && !f.path.toLowerCase().startsWith(pathBase.toLowerCase())) return false;
			return !this.excludedMatch(f.path, exclude);
		});

		const CONCURRENCY = 32;
		let totalFiles = 0;
		let skipped = 0;
		const allPaths: string[] = [];
		const detailed: Array<{ path: string; matchCount: number; lines: string[] }> = [];
		for (let i = 0; i < files.length; i += CONCURRENCY) {
			const chunk = files.slice(i, i + CONCURRENCY);
			const batch = await Promise.all(
				chunk.map(async (file) => {
					try {
						if (file.stat.size > 5 * 1024 * 1024) return null;
						const content = await this.deps.vault.cachedRead(file);
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
						return null;
					}
				}),
			);
			for (const r of batch) {
				if (!r) continue;
				totalFiles++;
				if (skipped < offset) {
					skipped++;
					continue;
				}
				if (allPaths.length < MAX_PATHS) allPaths.push(r.path);
				if (detailed.length < detailLimit) detailed.push(r);
			}
		}

		for (const p of allPaths) this.cite?.(p);

		return this.truncate(
			JSON.stringify(
				{
				pattern,
				regex,
				caseSensitive,
				path: pathBase,
					totalFiles,
					completeList: totalFiles <= MAX_PATHS,
					offset,
					// Zero matches is a FORMATTING problem far more often than a
					// content problem — say so, or the model concludes "absent
					// from the vault" off one spacing variant and answers wrong.
					...(totalFiles === 0
						? {
							hint:
								"0 matches does NOT prove the content is absent. OCR/plain-text documents often insert spaces or line breaks inside a phrase " +
								"(e.g. a source may store '附录12' as '附录 12', or split it across lines). " +
								"Retry with: a SHORTER keyword (drop the number or suffix); a regex tolerating spaces (regex=true, pattern like '附录\\s*12'); " +
								"no path filter (search the whole vault); or inspect the file directly — read(path, offset, limit) or headings(path).",
						}
						: {}),
					paths: allPaths,
					results: detailed.map((r) => ({
						n: this.cite?.(r.path, firstHitLine(r.lines)),
						...r,
						linesOmitted: Math.max(0, r.matchCount - r.lines.length),
					})),
				},
				null,
				2,
			),
			12000,
		);
	}

	async find(pattern: string, prefix: string | undefined, limit = 20, exclude?: string[]): Promise<string> {
		if (!pattern) return "Error: missing pattern";
		// glob：* → 任意字符（含路径分隔符——"*关键词*" 即按包含匹配，
		// 否则子目录里的文件永远匹配不上），? → 单字符；其余按字面匹配
		//（大小写不敏感）。
		const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		const re = new RegExp(
			"^" + escaped.replace(/\*\*/g, "§").replace(/\*/g, "[\\s\\S]*").replace(/§/g, "[\\s\\S]*").replace(/\?/g, ".") + "$",
			"i",
		);
		const { prefix: base, dropped } = this.resolvePrefix(prefix);
		const results: Array<{ path: string; modified: string | null }> = [];
		for (const file of this.deps.vault.getFiles()) {
			if (!/\.(md|txt|markdown)$/i.test(file.path)) continue;
			if (base && !file.path.startsWith(base)) continue;
			if (this.excludedMatch(file.path, exclude)) continue;
			const name = file.path.slice(base ? base.length + 1 : 0);
			if (!re.test(name) && !re.test(file.path)) continue;
			results.push({ path: file.path, modified: new Date(file.stat.mtime).toISOString() });
		}
		results.sort((a, b) => (b.modified ?? "").localeCompare(a.modified ?? ""));
		const total = results.length;
		return this.truncate(
			JSON.stringify(
				{
					pattern,
					path: base,
					total,
					truncated: total > limit,
					// 调用方常把 path 传成磁盘绝对路径（vault 相对前缀才有效）；
					// 规范化拿不掉时宁可丢弃前缀多回结果，也要把原因说清楚。
					...(dropped ? { hint: `path "${prefix}" looks like a disk path and was IGNORED — path must be vault-relative (e.g. 'projects/'). Results below are unfiltered.` } : {}),
					...(total === 0 && !dropped
						? {
							hint:
								"0 matches. The path filter is a VAULT-RELATIVE prefix (e.g. 'projects/'), not a disk path. " +
								"Retry without path, or use ls to see real folder prefixes first.",
						}
						: {}),
					results: results.slice(0, limit),
				},
				null,
				2,
			),
		);
	}

	async headings(path: string): Promise<string> {
		if (!path) return "Error: missing path";
		const file = this.deps.vault.getAbstractFileByPath(path);
		if (!file) return `Error: file not found: ${path}`;
		const content = await this.deps.vault.cachedRead(file as TFile);
		const out: Array<{ level: number; text: string; line: number }> = [];
		content.split("\n").forEach((line, i) => {
			const m = line.match(/^(#{1,6})\s+(.*)$/);
			if (m) out.push({ level: m[1].length, text: m[2].trim(), line: i + 1 });
		});
		return this.truncate(
			JSON.stringify({ path, total: out.length, headings: out }, null, 2),
		);
	}

	async links(path: string): Promise<string> {
		if (!path) return "Error: missing path";
		const file = this.deps.vault.getAbstractFileByPath(path);
		if (!file) return `Error: file not found: ${path}`;

		// basename → path 索引（一次构建，解析 [[...]] 与 markdown 链接）
		const byName = new Map<string, string>();
		for (const f of this.deps.vault.getFiles()) {
			if (!/\.(md|txt|markdown)$/i.test(f.path)) continue;
			const base = f.path.split("/").pop()!.replace(/\.(md|txt|markdown)$/i, "");
			if (!byName.has(base)) byName.set(base, f.path);
			if (!byName.has(f.path)) byName.set(f.path, f.path);
		}
		const resolve = (raw: string): string | null => {
			const name = raw.trim().split("#")[0].split("|")[0];
			if (!name) return null;
			if (byName.has(name)) return byName.get(name)!;
			const withMd = name.endsWith(".md") ? name : `${name}.md`;
			return byName.get(withMd) ?? byName.get(name.split("/").pop() ?? "") ?? null;
		};
		const extract = (content: string): string[] => {
			const out: string[] = [];
			for (const m of content.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
				const r = resolve(m[1]);
				if (r) out.push(r);
			}
			return out;
		};

		const ownContent = await this.deps.vault.cachedRead(file as TFile);
		const outlinks = [...new Set(extract(ownContent))].filter((p) => p !== path);

		// 反链：扫描全部 md（有界并发），收集链接到 path 的文件
		const backlinks = new Map<string, string>();
		const others = this.deps.vault.getFiles().filter((f) => /\.(md|txt|markdown)$/i.test(f.path) && f.path !== path);
		const CONCURRENCY = 32;
		for (let i = 0; i < others.length; i += CONCURRENCY) {
			const batch = await Promise.all(
				others.slice(i, i + CONCURRENCY).map(async (f) => {
					try {
						if (f.stat.size > 5 * 1024 * 1024) return null;
						const content = await this.deps.vault.cachedRead(f);
						const targets = extract(content);
						return targets.includes(path) ? { path: f.path, content } : null;
					} catch {
						return null;
					}
				}),
			);
			for (const r of batch) {
				if (!r) continue;
				if (!backlinks.has(r.path)) {
					const line = r.content.split("\n").find((l) => l.includes("[[")) ?? "";
					backlinks.set(r.path, line.trim().slice(0, 150));
				}
			}
		}

		for (const p of [...backlinks.keys(), ...outlinks]) this.cite?.(p);

		return this.truncate(
			JSON.stringify(
				{
					path,
					backlinks: [...backlinks.entries()].map(([p, snippet]) => ({ path: p, snippet })),
					outlinks: outlinks.map((p) => ({ path: p })),
				},
				null,
				2,
			),
		);
	}

	// ──── 状态与管理 ────

	async active(): Promise<string> {
		const path = this.deps.getActiveNote();
		if (!path) return "Error: No note is currently open in Obsidian. Ask the user to open one, or use search / grep / find instead.";
		const n = this.cite?.(path);
		return JSON.stringify({ path, ...(n ? { n } : {}) });
	}

	async status(): Promise<string> {
		const p = this.deps.progress();
		return JSON.stringify(
			{
				phase: p.phase,
				notes: { processed: p.processedNotes, total: p.totalNotes },
				chunks: { embedded: p.embeddedChunks, total: p.totalChunks, failed: p.failedChunks },
				activeFiles: p.activeFiles,
			},
			null,
			2,
		);
	}

	async reindex(path?: string, force = false): Promise<string> {
		await this.deps.reindex(path, force);
		return JSON.stringify({ ok: true, path: path ?? "(all)", force });
	}

	// ──── 内部 ────

	private citeHeader(path: string, line?: number, kind?: "read" | "hit"): string {
		const n = this.cite?.(path, line, kind);
		return n ? `[${n}] ${path}\n\n` : "";
	}

	private escapeRegExp(text: string): string {
		return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}

	private truncate(text: string, maxLen = this.maxChars): string {
		if (text.length <= maxLen) return text;
		return text.slice(0, maxLen) + "\n…(truncated)";
	}
}
