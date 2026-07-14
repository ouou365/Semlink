// ========================================
// Semlink - SiliconFlow Embedding Client
// ========================================

import { requestUrl, RequestUrlParam } from "obsidian";
import type { SmartVaultSettings, EmbeddingProvider, EmbeddingResponse, NetworkStatus } from "./types";

export interface EmbedResult {
	embeddings: number[][];
	totalTokens: number;
	responseMs: number;
}

export class EmbeddingClient {
	private provider: EmbeddingProvider;
	private apiKey: string;
	private huggingFaceApiKey: string;
	private apiBase: string;
	private model: string;
	private batchSize: number;
	private requestDelayMs: number;
	private maxRetries: number;

	// Network health
	consecutiveFailures = 0;
	isAutoPaused = false;
	backoffUntil = 0;
	private lastResponseTimes: number[] = [];

	constructor(settings: SmartVaultSettings) {
		this.provider = settings.provider || "siliconflow";
		this.apiKey = settings.siliconFlowApiKey;
		this.huggingFaceApiKey = settings.huggingFaceApiKey;
		this.apiBase = settings.apiBase;
		this.model = settings.embeddingModel;
		this.batchSize = settings.batchSize;
		this.requestDelayMs = settings.requestDelayMs;
		this.maxRetries = settings.maxRetries;
	}

	updateSettings(settings: SmartVaultSettings) {
		this.provider = settings.provider || "siliconflow";
		this.apiKey = settings.siliconFlowApiKey;
		this.huggingFaceApiKey = settings.huggingFaceApiKey;
		this.apiBase = settings.apiBase;
		this.model = settings.embeddingModel;
		this.batchSize = settings.batchSize;
		this.requestDelayMs = settings.requestDelayMs;
		this.maxRetries = settings.maxRetries;
	}

	/** Get the active API key based on current provider */
	private get activeApiKey(): string {
		return this.provider === "huggingface" ? this.huggingFaceApiKey : this.apiKey;
	}

	get networkStatus(): NetworkStatus {
		if (this.isAutoPaused) return "paused";
		if (this.consecutiveFailures > 0) return "degraded";
		return "healthy";
	}

	get avgResponseMs(): number {
		if (this.lastResponseTimes.length === 0) return 0;
		return Math.round(
			this.lastResponseTimes.reduce((a, b) => a + b, 0) / this.lastResponseTimes.length
		);
	}

	get backoffRemainingSec(): number {
		if (!this.isAutoPaused) return 0;
		const remaining = Math.max(0, this.backoffUntil - Date.now());
		return Math.ceil(remaining / 1000);
	}

	/**
	 * Embed a batch of texts. Returns embeddings in the same order.
	 * Handles retries and rate-limiting internally.
	 */
	async embed(texts: string[]): Promise<EmbedResult> {
		if (!this.activeApiKey) {
			const providerName = this.provider === "huggingface" ? "Hugging Face" : "SiliconFlow";
			throw new Error(`${providerName} API key not configured`);
		}

		// Check auto-pause
		if (this.isAutoPaused && Date.now() < this.backoffUntil) {
			throw new Error(
				`Network paused, retry after ${this.backoffRemainingSec}s`
			);
		}

		// If backoff expired, auto-resume
		if (this.isAutoPaused && Date.now() >= this.backoffUntil) {
			this.isAutoPaused = false;
			this.consecutiveFailures = 0;
		}

		let lastError: Error | null = null;

		for (let attempt = 0; attempt < this.maxRetries; attempt++) {
			try {
				// Rate limit delay between requests
				if (this.requestDelayMs > 0) {
					await this.sleep(this.requestDelayMs);
				}

				const start = Date.now();
				const response = await this.callApi(texts);
				const elapsed = Date.now() - start;

				// Track response time (keep last 100 samples)
				this.lastResponseTimes.push(elapsed);
				if (this.lastResponseTimes.length > 100) {
					this.lastResponseTimes.shift();
				}

				// Success → reset failures
				this.onSuccess();

				return {
					embeddings: response.data.map((d) => d.embedding),
					totalTokens: response.usage.total_tokens,
					responseMs: elapsed,
				};
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				const status = this.extractStatus(error);

				if (status === 429) {
					// Rate limited → longer backoff
					this.onFailure(true);
					const waitMs = Math.min(60000, 5000 * Math.pow(2, this.consecutiveFailures));
					console.warn(`[Semlink] Rate limited (429), waiting ${waitMs}ms`);
					await this.sleep(waitMs);
				} else if (status && status >= 500) {
					// Server error → retry with backoff
					this.onFailure(false);
					const waitMs = 1000 * Math.pow(2, attempt);
					console.warn(`[Semlink] Server error ${status}, retry ${attempt + 1}/${this.maxRetries}`);
					await this.sleep(waitMs);
				} else if (!status) {
					// Network error (DNS, timeout, etc.)
					this.onFailure(false);
					const waitMs = 2000 * Math.pow(2, attempt);
					console.warn(`[Semlink] Network error, retry ${attempt + 1}/${this.maxRetries}: ${lastError.message}`);
					await this.sleep(waitMs);
				} else {
					// Client error (4xx not 429) → don't retry
					throw lastError;
				}
			}
		}

		// All retries exhausted
		this.onFailure(false);
		throw lastError || new Error("Embedding failed after retries");
	}

	/**
	 * Embed a large list by splitting into batches.
	 * Calls `onBatchComplete` after each batch for progress tracking.
	 */
	async embedAll(
		texts: string[],
		onBatchComplete?: (batchIndex: number, totalBatches: number, tokens: number) => void,
	): Promise<{ embeddings: number[][][]; totalTokens: number }> {
		const batches = this.splitBatches(texts, this.batchSize);
		const allEmbeddings: number[][][] = [];
		let totalTokens = 0;

		for (let i = 0; i < batches.length; i++) {
			// Check auto-pause between batches
			if (this.isAutoPaused && Date.now() < this.backoffUntil) {
				throw new Error(
					`Network paused after batch ${i}/${batches.length}`
				);
			}

			const result = await this.embed(batches[i]);
			allEmbeddings.push(result.embeddings);
			totalTokens += result.totalTokens;

			onBatchComplete?.(i, batches.length, result.totalTokens);
		}

		return { embeddings: allEmbeddings, totalTokens };
	}

	private async callApi(input: string[]): Promise<EmbeddingResponse> {
		if (this.provider === "huggingface") {
			return this.callHuggingFaceApi(input);
		}
		return this.callSiliconFlowApi(input);
	}

	private async callSiliconFlowApi(input: string[]): Promise<EmbeddingResponse> {
		const params: RequestUrlParam = {
			url: `${this.apiBase}/v1/embeddings`,
			method: "POST",
			headers: {
				"Authorization": `Bearer ${this.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: this.model,
				input,
				encoding_format: "float",
			}),
			throw: false,
		};

		const resp = await requestUrl(params);

		if (resp.status !== 200) {
			const errBody = typeof resp.json === "object" ? resp.json : {};
			const errMsg = errBody?.error?.message || errBody?.message || `HTTP ${resp.status}`;
			const err: any = new Error(errMsg);
			err.status = resp.status;
			throw err;
		}

		return resp.json as EmbeddingResponse;
	}

	private async callHuggingFaceApi(input: string[]): Promise<EmbeddingResponse> {
		const params: RequestUrlParam = {
			url: `https://api-inference.huggingface.co/models/${this.model}`,
			method: "POST",
			headers: {
				"Authorization": `Bearer ${this.huggingFaceApiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				inputs: input,
			}),
			throw: false,
		};

		const resp = await requestUrl(params);

		if (resp.status !== 200) {
			const errBody = typeof resp.json === "object" ? resp.json : {};
			const errMsg = errBody?.error || errBody?.error?.message || errBody?.message || `HTTP ${resp.status}`;
			const err: any = new Error(errMsg);
			err.status = resp.status;
			throw err;
		}

		// HF returns [[emb1], [emb2], ...] — convert to OpenAI-compatible format
		const raw = resp.json as number[][][];
		// Handle single input case: HF may return [emb] instead of [[emb]]
		const embeddings: number[][] = Array.isArray(raw[0]?.[0]) ? raw as unknown as number[][] : raw;

		return {
			object: "list",
			model: this.model,
			data: embeddings.map((embedding, index) => ({
				object: "embedding",
				embedding,
				index,
			})),
			usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
		};
	}

	private onSuccess() {
		this.consecutiveFailures = 0;
		this.isAutoPaused = false;
		this.backoffUntil = 0;
	}

	private onFailure(isRateLimit: boolean) {
		this.consecutiveFailures++;

		if (isRateLimit) {
			// Rate limit → pause 30-60s
			this.backoffUntil = Date.now() + 30000 + this.consecutiveFailures * 5000;
		} else if (this.consecutiveFailures >= 3) {
			// 3+ consecutive failures → auto-pause with exponential backoff
			this.isAutoPaused = true;
			const backoffSec = Math.min(300, 10 * Math.pow(2, this.consecutiveFailures - 3));
			this.backoffUntil = Date.now() + backoffSec * 1000;
			console.warn(
				`[Semlink] Auto-paused after ${this.consecutiveFailures} failures, backoff ${backoffSec}s`
			);
		}
	}

	/** Force resume from auto-pause */
	forceResume() {
		this.isAutoPaused = false;
		this.consecutiveFailures = 0;
		this.backoffUntil = 0;
	}

	private splitBatches(items: string[], size: number): string[][] {
		const batches: string[][] = [];
		for (let i = 0; i < items.length; i += size) {
			batches.push(items.slice(i, i + size));
		}
		return batches;
	}

	private extractStatus(error: any): number | null {
		if (error?.status) return error.status;
		return null;
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => window.setTimeout(resolve, ms));
	}
}
