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
			"通用检索入口（默认用这个）：并行执行 BM25 关键词检索与向量语义检索，RRF 融合去重后返回单一排名列表。向量路不可用（未配置嵌入模型 / 向量搜索关闭 / 尚未索引）时自动退化为纯 BM25 结果，meta.sources 如实标注。精确术语建议另用 search_bm25。",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "自然语言查询或关键词组合" },
				limit: { type: "number", description: "返回结果数量上限（默认 10）" },
				path: { type: "string", description: "路径前缀过滤（可选）" },
				alpha: { type: "number", description: "融合权重 0-1：0=纯 BM25，1=纯向量，默认 0.5" },
			},
			required: ["query"],
		},
	},
	{
		name: "search_bm25",
		description:
			"纯关键词检索（BM25 打分），零嵌入依赖、永远可用。精确术语、编号、日期、代码标识符等语义检索覆盖不到的内容首选。",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "关键词组合，空格分隔多个词（取并集打分）" },
				limit: { type: "number", description: "返回结果数量上限（默认 10）" },
				path: { type: "string", description: "路径前缀过滤（可选）" },
				case_sensitive: { type: "boolean", description: "是否区分大小写（默认 false）" },
			},
			required: ["query"],
		},
	},
	{
		name: "search_vector",
		description:
			"纯语义向量检索：自然语言查询返回最相关的笔记片段（路径、标题、预览、相似度）。受向量搜索开关控制；未配置嵌入模型时返回明确的不可用提示。",
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
		name: "ls",
		description:
			"列出已索引的笔记（含 created/modified ISO 时间），支持按修改/创建/名称排序、时间区间过滤与前缀过滤，limit/offset 分页。对应 shell 的 ls -la：适合「最近记了哪些笔记」「某目录下有什么」。",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "路径前缀过滤（可选）" },
				sort: { type: "string", description: "排序：modified（默认，最新在前）| created | name" },
				limit: { type: "number", description: "最多返回条数（默认 50）" },
				offset: { type: "number", description: "跳过前 N 条（默认 0，用于翻页）" },
				recursive: { type: "boolean", description: "是否包含子目录（默认 true）；false 时仅列出 path 的直接内容" },
				since: { type: "string", description: "仅返回 modified ≥ 此日期的笔记（YYYY-MM-DD，可选）" },
				until: { type: "string", description: "仅返回 modified ≤ 此日期的笔记（YYYY-MM-DD，可选）" },
			},
		},
	},
	{
		name: "read",
		description:
			"读取笔记内容，输出带行号（cat -n 风格）并附带 total_lines/total_chars。offset 支持负数（-20 表示从倒数第 20 行读到结尾，即 tail）；heading 可直接定位某章节。与 grep 组合：grep 返回行号 → read 用 offset/limit 读取。",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "笔记在 Vault 中的路径" },
				offset: { type: "number", description: "起始行号（1-based）；负数表示从末尾倒数（-20 = 倒数 20 行）" },
				limit: { type: "number", description: "读取的行数（不传读到结尾）" },
				heading: { type: "string", description: "按标题定位章节（不需要 # 符号），先取章节再应用 offset/limit" },
				max_depth: { type: "number", description: "heading 章节包含的子标题最大深度（可选）" },
			},
			required: ["path"],
		},
	},
	{
		name: "grep",
		description:
			"在笔记内容中按文本或正则精确搜索，输出「文件:行号:内容」——行号可直接喂给 read 的 offset。适合精确关键词、编号、日期、代码标识符。支持 limit/offset 翻页匹配结果。",
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "文本或正则表达式" },
				regex: { type: "boolean", description: "pattern 是否为正则（默认 false，按普通文本匹配）" },
				path: { type: "string", description: "路径前缀过滤（可选）" },
				case_sensitive: { type: "boolean", description: "是否区分大小写（默认 false）" },
				context: { type: "number", description: "每个匹配前后附带的上下文行数（默认 1，最大 3）" },
				limit: { type: "number", description: "附发明细的文件数上限（默认 10，最大 30）" },
				offset: { type: "number", description: "跳过前 N 个匹配文件（默认 0，用于翻页）" },
			},
			required: ["pattern"],
		},
	},
	{
		name: "find",
		description:
			"按文件名找笔记（对应 shell 的 find -iname）：支持 * 通配与子串匹配，如 \"*ECS*\"。只匹配文件名/路径，不搜索内容。",
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "文件名通配或子串，如 \"*周报*\"" },
				path: { type: "string", description: "路径前缀过滤（可选）" },
				limit: { type: "number", description: "最多返回条数（默认 20）" },
			},
			required: ["pattern"],
		},
	},
	{
		name: "headings",
		description:
			"返回笔记的标题大纲：[{level, text, line}]，按文档顺序。比 grep 正则可靠（不受代码块内 # 干扰），line 可直接作为 read 的 offset 锚点。",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "笔记在 Vault 中的路径" },
			},
			required: ["path"],
		},
	},
	{
		name: "links",
		description:
			"返回笔记的 wikilinks 双链关系：backlinks（哪些笔记链接到它，附匹配行）+ outlinks（它链接到哪些笔记）。与语义相似检索互补：精确引用关系。",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "笔记在 Vault 中的路径" },
			},
			required: ["path"],
		},
	},
	{
		name: "active",
		description:
			"获取当前正在 Obsidian 中打开的笔记的路径（仅路径）。适合「当前笔记是什么」「针对我正在看的这篇笔记」等问题；需要内容时再用 read。",
		parameters: { type: "object", properties: {} },
	},
	{
		name: "status",
		description: "获取当前索引状态与进度（阶段、笔记数、chunk 数、失败数）。",
		parameters: { type: "object", properties: {} },
	},
	{
		name: "reindex",
		description: "触发重新索引（可指定单个文件；force=true 时清空全量重建）。管理类工具。",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "仅重建该文件（可选）" },
				force: { type: "boolean", description: "清空已有数据后全量重建（默认 false）" },
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
				error: "向量搜索不可用：已在 RAG 设置中关闭，或未配置嵌入模型。请改用 search_bm25 / grep。",
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
		if (!path) return "Error: 当前没有打开的笔记。请让用户先打开一篇笔记，或改用 search / grep / find 检索知识库。";
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
