// ========================================
// Semlink - Reranker Client
// ========================================
// Wraps SiliconFlow's /v1/rerank endpoint to re-rank the candidates that
// embedding retrieval recalls. A cross-encoder reranker (bge-reranker-v2-m3)
// scores each (query, document) pair jointly, so it can tell apart "same
// vocabulary, different concept" pairs (e.g. S-98 data-product spec vs a
// BNWAS alert standard) that bge-m3 embedding wrongly groups together.
//
// Shares the same SiliconFlow account as the embedder (same apiKey / apiBase);
// no separate key is configured. When disabled / unconfigured / failing it
// returns null so callers silently fall back to the embedding ordering —
// reranking is an enhancement, never a blocker.

import { requestUrl } from "obsidian";
import type { SmartVaultSettings } from "./types";

export interface RerankResult {
	/** Index into the original documents array passed to rerank(). */
	index: number;
	/** Relevance score from the reranker (higher = more relevant). */
	score: number;
}

export class RerankerClient {
	private enabled = false;
	private apiKey = "";
	private apiBase = "https://api.siliconflow.cn";
	private model = "BAAI/bge-reranker-v2-m3";

	constructor(settings: SmartVaultSettings) {
		this.apply(settings);
	}

	updateSettings(settings: SmartVaultSettings): void {
		this.apply(settings);
	}

	private apply(s: SmartVaultSettings): void {
		this.enabled = !!s.rerankerEnabled;
		// Reuse the embedding account's SiliconFlow key + base URL.
		this.apiKey = s.siliconFlowApiKey;
		this.apiBase = s.apiBase;
		this.model = s.rerankerModel || "BAAI/bge-reranker-v2-m3";
	}

	/** Whether reranking is actually usable (enabled AND a key is present). */
	get isEnabled(): boolean {
		return this.enabled && !!this.apiKey;
	}

	/**
	 * Rerank `documents` by relevance to `query`.
	 * Returns results sorted by score desc, each carrying its original index.
	 * Returns null when disabled / no key / network or API error, so the caller
	 * can fall back to the embedding order without any special handling.
	 */
	async rerank(query: string, documents: string[]): Promise<RerankResult[] | null> {
		if (!this.isEnabled || documents.length === 0) return null;
		try {
			const resp = await requestUrl({
				url: `${this.apiBase}/v1/rerank`,
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: this.model,
					query,
					documents,
					top_n: documents.length,
					return_documents: false,
				}),
				throw: false,
			});

			if (resp.status !== 200) {
				console.warn("[Semlink] rerank request failed:", resp.status);
				return null;
			}

			const results = resp.json?.results ?? [];
			return results
				.map((r: any) => ({ index: r.index as number, score: r.relevance_score as number }))
				.sort((a: RerankResult, b: RerankResult) => b.score - a.score);
		} catch (e) {
			console.warn("[Semlink] rerank error:", e);
			return null;
		}
	}
}
