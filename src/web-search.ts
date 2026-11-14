// ========================================
// Semlink - DeepSeek Web Search service
// ========================================
// Wraps DeepSeek's hosted web-search API (POST /v1/tools/search) as the
// backend of the shared `web_search` tool (chat agent + MCP server — see
// tools-core). The API key comes from ANY configured chat provider whose
// baseUrl points at api.deepseek.com (no separate setting): resolved at
// call time via the injected settings getter, so adding/switching providers
// takes effect without a restart.
//
// Output is plain text formatted for the model: numbered cards with title,
// site/date/authority, URL and a clipped summary — one card per result,
// sized so the default count fits the chat side's 4K tool-result cap.

import { requestUrl } from "obsidian";
import type { SmartVaultSettings } from "./types";

/** requestUrl has no timeout of its own (same trap as embedding-client). */
const SEARCH_TIMEOUT_MS = 20_000;
/** Per-result summary clip — the API's long summary runs 600-800 chars;
 *  300 keeps the default 8-result page inside the chat tool-result cap. */
const SUMMARY_CLIP = 300;
/** Per-result body clip (need_content=true). Bodies can be huge. */
const CONTENT_CLIP = 900;

export interface WebSearchDeps {
	/** Live settings (called per request — provider edits apply instantly). */
	getSettings: () => SmartVaultSettings;
}

interface DeepSeekSearchResult {
	rerank_score?: number;
	title?: string;
	url?: string;
	snippet?: string;
	summary?: string;
	content?: string;
	site_name?: string | null;
	date?: string | null;
	authority?: number;
}

export class WebSearchService {
	constructor(private deps: WebSearchDeps) {}

	/** A DeepSeek chat provider with a key → web_search registers; otherwise
	 *  the tool stays hidden (chat side) / absent from tools/list (MCP side). */
	available(): boolean {
		return this.resolveProvider() !== null;
	}

	/** First configured chat provider that talks to api.deepseek.com AND
	 *  carries a non-empty key. baseUrl match tolerates trailing paths.
	 *  用统一 providers 列表（legacy chatProviders 已迁移合并至此）。 */
	private resolveProvider(): { baseUrl: string; apiKey: string } | null {
		const providers = this.deps.getSettings().providers ?? [];
		for (const p of providers) {
			// 不再读 disabled 标志（用户拍板撤头部总开关，启停改派生：
			// Key + 启用模型）——旧数据的残留标志不得卡死搜索
			if (!p.apiKey || !p.apiKey.trim()) continue;
			if (/api\.deepseek\.com/i.test(p.apiBase || "")) {
				return { baseUrl: p.apiBase.replace(/\/+$/, ""), apiKey: p.apiKey.trim() };
			}
		}
		return null;
	}

	/** Run one search and format results for the model. Always resolves with
	 *  text (errors included) — same contract as ToolCore.execute. */
	async search(query: string, count = 8, oriQuestion?: string | null, needContent = false): Promise<string> {
		const q = query.trim();
		if (!q) return "Error: missing query";
		// API rule: 1-128 Unicode chars — clip rather than fail, the model
		// tends to paste whole sentences as the query.
		const clippedQuery = q.length > 128 ? Array.from(q).slice(0, 128).join("") : q;
		const n = Math.min(10, Math.max(1, Math.floor(Number(count) || 8)));

		const provider = this.resolveProvider();
		if (!provider) return "Error: Web search needs a DeepSeek provider with an API key (Settings → Models)";

		const body: Record<string, unknown> = { query: clippedQuery, count: n, need_content: needContent };
		if (oriQuestion && oriQuestion.trim()) {
			const oq = oriQuestion.trim();
			body.ori_question = oq.length > 128 ? Array.from(oq).slice(0, 128).join("") : oq;
		}

		let status = 0;
		let text = "";
		try {
			const resp = requestUrl({
				url: `${provider.baseUrl}/v1/tools/search`,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${provider.apiKey}`,
				},
				body: JSON.stringify(body),
				throw: false,
			});
			// requestUrl cannot time out — race a watchdog so a hung
			// connection can't stall a chat round forever.
			const timer = new Promise<never>((_, reject) =>
				window.setTimeout(() => reject(new Error(`web search timed out after ${SEARCH_TIMEOUT_MS / 1000}s`)), SEARCH_TIMEOUT_MS),
			);
			const r = await Promise.race([resp, timer]);
			status = r.status;
			text = r.text;
		} catch (e) {
			return `Error: web search request failed — ${e instanceof Error ? e.message : String(e)}`;
		}
		if (status !== 200) {
			return `Error: web search API returned ${status}${text ? ` — ${text.slice(0, 300)}` : ""}`;
		}
		let parsed: { results?: DeepSeekSearchResult[] };
		try {
			parsed = JSON.parse(text) as { results?: DeepSeekSearchResult[] };
		} catch {
			return "Error: web search API returned invalid JSON";
		}
		const results = parsed.results ?? [];
		if (results.length === 0) return `Web search "${clippedQuery}" — no results.`;

		const clip = (s: string, max: number): string => {
			const chars = Array.from(s);
			return chars.length > max ? chars.slice(0, max).join("") + "…" : s;
		};
		const lines: string[] = [`Web search "${clippedQuery}" — ${results.length} results:`];
		results.forEach((r, i) => {
			const date = r.date ? ` · ${r.date.slice(0, 10)}` : "";
			const site = r.site_name ? ` · ${r.site_name}` : "";
			const auth = typeof r.authority === "number" && r.authority >= 0 ? ` · authority ${r.authority}/4` : "";
			lines.push(`[${i + 1}] ${clip(r.title || "(untitled)", 120)}${site}${date}${auth}`);
			if (r.url) lines.push(`    ${r.url}`);
			const bodyText = (needContent && r.content ? r.content : r.summary || r.snippet || "").trim();
			if (bodyText) lines.push(`    ${clip(bodyText, needContent && r.content ? CONTENT_CLIP : SUMMARY_CLIP)}`);
		});
		return lines.join("\n");
	}
}
