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
			"Universal search entry point (use this first): runs BM25 keyword search and vector semantic search in parallel, fuses both ranked lists with Reciprocal Rank Fusion, and returns a single deduplicated ranking. When the vector path is unavailable (no embedding model configured / vector search disabled / nothing indexed yet) it automatically degrades to BM25-only results; meta.sources reports what was actually used. For exact terms prefer search_bm25.",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "Natural-language query or keyword combination" },
				limit: { type: "number", description: "Max results (default 10)" },
				path: { type: "string", description: "Path prefix filter (optional)" },
				alpha: { type: "number", description: "Fusion weight 0-1: 0 = BM25 only, 1 = vector only (default 0.5)" },
			},
			required: ["query"],
		},
	},
	{
		name: "search_bm25",
		description:
			"Keyword-only search scored with BM25. No embedding dependency — always available. Best for exact terms, IDs, dates, code identifiers that semantic retrieval can miss.",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "Keyword combination, space-separated terms (union scored)" },
				limit: { type: "number", description: "Max results (default 10)" },
				path: { type: "string", description: "Path prefix filter (optional)" },
				case_sensitive: { type: "boolean", description: "Case-sensitive matching (default false)" },
			},
			required: ["query"],
		},
	},
	{
		name: "search_vector",
		description:
			"Pure semantic vector search: natural-language query returns the most relevant note passages (path, heading, preview, score). Controlled by the vector-search toggle; returns an explicit 'unavailable' message instead of empty results when no embedding model is configured.",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "Natural-language search query" },
				limit: { type: "number", description: "Max results (default 10)" },
				threshold: { type: "number", description: "Similarity threshold 0-1 (default 0.3)" },
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
				path: { type: "string", description: "Path prefix filter (optional)" },
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
			"Read note content with line numbers (cat -n style) plus total_lines/total_chars metadata. offset supports negative values (-20 = last 20 lines, i.e. tail); heading jumps straight to a section. Compose with grep: grep emits line numbers → feed them into offset/limit here.",
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
			"Exact text or regex search across note contents, emitting 'file:line: content' — line numbers feed directly into read's offset. Best for exact keywords, IDs, dates, code identifiers. Supports limit/offset pagination over matching files.",
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "Text or regular expression" },
				regex: { type: "boolean", description: "Treat pattern as regex (default false: literal text)" },
				path: { type: "string", description: "Path prefix filter (optional)" },
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
				path: { type: "string", description: "Path prefix filter (optional)" },
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
}

interface SearchResultLike {
	n?: number | null;
	path: string;
	heading?: string | null;
	preview?: string | null;
	score: number;
}

/** 12 个工具的唯一实现。MCP server 与聊天 Agent 都委托到这里。 */
export class ToolCore {
	/** 单次输出的字符上限（聊天侧 4000，MCP 侧 12000）。 */
	maxChars = 8000;
	/** 引用编号钩子：聊天侧注入，让出现的路径带全局 [n]。 */
	cite: ((path: string) => number | null) | null = null;

	constructor(private deps: ToolCoreDeps) {}

	/** 按名称执行工具；永远返回文本（错误也文本化）。 */
	async execute(name: string, args: Record<string, unknown>): Promise<string> {
		const a = args;
		try {
			switch (name) {
				case "search":
					return await this.search(String(a.query ?? ""), Number(a.limit) || 10, a.path as string | undefined, Number(a.alpha) || 0.5);
				case "search_bm25":
					return await this.searchBm25(String(a.query ?? ""), Number(a.limit) || 10, a.path as string | undefined, Boolean(a.case_sensitive));
				case "search_vector":
					return await this.searchVector(String(a.query ?? ""), Number(a.limit) || 10, Number(a.threshold) || 0.3);
				case "ls":
					return await this.ls(a.path as string | undefined, (a.sort as string) ?? "modified", Number(a.limit) || 50, Number(a.offset) || 0, a.recursive !== false, a.since as string | undefined, a.until as string | undefined);
				case "read":
					return await this.read(String(a.path ?? ""), Number(a.offset) || 0, a.limit === undefined ? undefined : Number(a.limit), a.heading as string | undefined, a.max_depth === undefined ? undefined : Number(a.max_depth));
				case "grep":
					return await this.grep(String(a.pattern ?? ""), Boolean(a.regex), a.path as string | undefined, Boolean(a.case_sensitive), Number(a.context) === 0 ? 0 : Number(a.context) || 1, Number(a.limit) || 10, Number(a.offset) || 0);
				case "find":
					return await this.find(String(a.pattern ?? ""), a.path as string | undefined, Number(a.limit) || 20);
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

	/** 通用检索：BM25 + 向量并行，RRF 融合；向量路不可用时纯 BM25 兜底。 */
	async search(query: string, limit = 10, path?: string, alpha = 0.5): Promise<string> {
		if (!query.trim()) return "Error: missing query";
		const useVector = this.deps.store.searchGate();
		const [bm25, vector] = (await Promise.all([
			this.bm25Raw(query, limit * 2, path).catch(() => []),
			useVector
				? this.vectorRaw(query, limit * 2, 0.2, path).catch(() => [])
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
	async searchBm25(query: string, limit = 10, path?: string, caseSensitive = false): Promise<string> {
		if (!query.trim()) return "Error: missing query";
		const results = await this.bm25Raw(query, limit, path, caseSensitive);
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
	async searchVector(query: string, limit = 10, threshold = 0.3): Promise<string> {
		if (!query.trim()) return "Error: missing query";
		if (!this.deps.store.searchGate()) {
			return JSON.stringify({
				error: "Vector search is unavailable (disabled in RAG settings, or no embedding model configured). Use search_bm25 or grep instead.",
			});
		}
		const results = await this.vectorRaw(query, limit, threshold);
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

	/** BM25-lite 原始结果：分词 → 每个词 LIKE 取候选 → idf·饱和tf 累计打分。 */
	private async bm25Raw(query: string, limit: number, path?: string, caseSensitive = false): Promise<SearchResultLike[]> {
		const tokens = query
			.toLowerCase()
			.split(/[\s,，。；;]+/)
			.map((t) => t.trim())
			.filter((t) => t.length > 0)
			.slice(0, 8);
		if (tokens.length === 0) return [];
		const scores = new Map<string, { score: number; preview: string | null }>();
		for (const token of tokens) {
			let hits: Array<{ path: string; matchCount: number; preview: string | null }> = [];
			try {
				hits = await this.deps.store.textSearch(caseSensitive ? token : token, Math.min(limit * 3, 200), path);
			} catch {
				return [];
			}
			const df = Math.max(hits.length, 1);
			const idf = Math.log(1 + 200 / df);
			for (const h of hits) {
				const tf = h.matchCount > 0 ? h.matchCount / (h.matchCount + 1.2) : 0;
				const prev = scores.get(h.path);
				const add = idf * tf;
				scores.set(h.path, { score: (prev?.score ?? 0) + add, preview: prev?.preview ?? h.preview ?? null });
			}
		}
		return [...scores.entries()]
			.map(([p, v]) => ({ path: p, preview: v.preview, score: v.score }))
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);
	}

	/** 向量原始结果：embed → store.search。 */
	private async vectorRaw(query: string, limit: number, threshold: number, path?: string): Promise<SearchResultLike[]> {
		const embedResult = await this.deps.client.embed([query]);
		const hits = await this.deps.store.search(embedResult.embeddings[0], limit, threshold);
		return hits
			.filter((r) => !path || r.notePath.startsWith(path))
			.map((r) => ({ path: r.notePath, heading: r.heading, preview: r.contentPreview, score: r.score }));
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
	): Promise<string> {
		const paths = await this.deps.store.getAllIndexedPaths();
		const base = prefix ? prefix.replace(/\/+$/, "") : "";
		const notes: Array<{ path: string; created: string | null; modified: string | null }> = [];
		for (const p of paths) {
			if (base && !p.startsWith(base)) continue;
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
		const header = this.citeHeader(path);

		return this.truncate(
			JSON.stringify(
				{
					path,
					totalLines,
					totalChars: content.length,
					offset: start,
					returned: slice.length,
					...(heading ? { heading } : {}),
					content: numbered.join("\n"),
					...(header ? { cite: header.trim() } : {}),
				},
				null,
				2,
			),
		);
	}

	async grep(
		pattern: string,
		regex: boolean,
		path: string | undefined,
		caseSensitive: boolean,
		context: number,
		limit: number,
		offset: number,
	): Promise<string> {
		if (!pattern) return "Error: missing pattern";

		const re = new RegExp(regex ? pattern : this.escapeRegExp(pattern), caseSensitive ? "" : "i");
		const detailLimit = Math.min(Math.max(1, limit), 30);
		const MAX_PATHS = 200;
		const ctx = Math.min(Math.max(0, context), 3);
		const maxLinesPerFile = 12;

		const files = this.deps.vault.getFiles().filter((f) => {
			if (!/\.(md|txt|markdown)$/i.test(f.path)) return false;
			if (path && !f.path.toLowerCase().startsWith(path.toLowerCase())) return false;
			return true;
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
					totalFiles,
					completeList: totalFiles <= MAX_PATHS,
					offset,
					paths: allPaths,
					results: detailed.map((r) => ({ n: this.cite?.(r.path), ...r })),
				},
				null,
				2,
			),
			12000,
		);
	}

	async find(pattern: string, prefix: string | undefined, limit = 20): Promise<string> {
		if (!pattern) return "Error: missing pattern";
		// glob：* → 任意（不含 /），? → 单字符；其余按字面匹配（大小写不敏感）
		const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		const re = new RegExp(
			"^" + escaped.replace(/\*\*/g, "§").replace(/\*/g, "[^/]*").replace(/§/g, ".*").replace(/\?/g, ".") + "$",
			"i",
		);
		const base = prefix ? prefix.replace(/\/+$/, "") : "";
		const results: Array<{ path: string; modified: string | null }> = [];
		for (const file of this.deps.vault.getFiles()) {
			if (!/\.(md|txt|markdown)$/i.test(file.path)) continue;
			if (base && !file.path.startsWith(base)) continue;
			const name = file.path.slice(base ? base.length + 1 : 0);
			if (!re.test(name) && !re.test(file.path)) continue;
			results.push({ path: file.path, modified: new Date(file.stat.mtime).toISOString() });
		}
		results.sort((a, b) => (b.modified ?? "").localeCompare(a.modified ?? ""));
		const total = results.length;
		return this.truncate(
			JSON.stringify({ pattern, total, truncated: total > limit, results: results.slice(0, limit) }, null, 2),
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

	private citeHeader(path: string): string {
		const n = this.cite?.(path);
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
