// ========================================
// Semlink - Settings: Models tab (provider list)
// ========================================
// DSH-style provider management: a vertical list of provider rows (fixed
// embedding providers + user-managed chat providers), one editor card open at
// a time, plus "Add provider" (catalog) and "Add a custom provider" flows.
// Chat providers support fetching the model list from their own endpoint.

import { App, Modal, Setting, requestUrl, setIcon } from "obsidian";
import type SmartVaultPlugin from "../main";
import type { ChatApiFormat, ChatModel, ChatModelKind, ChatProvider, EmbeddingProvider, EmbeddingProviderConfig } from "./types";
import { t } from "./i18n";

// ──── Tab state (owned by SmartVaultSettingTab, survives re-renders) ────

export interface ModelsTabState {
	/** Which provider's editor card is expanded, if any. */
	editing: { kind: "embedding" | "chat"; id: string } | null;
}

export const EMPTY_MODELS_TAB_STATE: ModelsTabState = {
	editing: null,
};

// ──── Provider catalog (chat) ────

/** Embedding model choices for a provider family (used by the embedding
 *  provider editors and the General tab's combined service/model dropdown). */
export function embeddingModelChoices(kind: EmbeddingProvider): Record<string, string> {
	if (kind === "huggingface") {
		return {
			"BAAI/bge-m3": `BAAI/bge-m3 (${t("modelRecommended")})`,
			"BAAI/bge-large-zh-v1.5": `BAAI/bge-large-zh-v1.5 (${t("modelZhOptimized")})`,
			"BAAI/bge-large-en-v1.5": `BAAI/bge-large-en-v1.5 (${t("modelEnOptimized")})`,
			"intfloat/multilingual-e5-large": `intfloat/multilingual-e5-large (${t("modelZhOptimized")})`,
		};
	}
	return {
		"BAAI/bge-m3": `BAAI/bge-m3 (${t("modelRecommended")})`,
		"Pro/BAAI/bge-m3": `Pro/BAAI/bge-m3 (${t("modelEnhanced")})`,
		"BAAI/bge-large-zh-v1.5": `BAAI/bge-large-zh-v1.5 (${t("modelZhOptimized")})`,
		"BAAI/bge-large-en-v1.5": `BAAI/bge-large-en-v1.5 (${t("modelEnOptimized")})`,
	};
}

interface CatalogEntry {
	name: string;
	baseUrl: string;
	apiFormat: ChatApiFormat;
	models: ChatModel[];
}

/**
 * Built-in chat provider directory, statically embedded from the pi-ai
 * provider catalog (`@earendil-works/pi-ai` — the same catalog the
 * deepseek-harness ships). baseUrl follows Semlink's wire convention:
 * OpenAI-compatible endpoints hit `${baseUrl}/v1/chat/completions` and
 * Anthropic-compatible ones `${baseUrl}/v1/messages`, so trailing "/v1" on
 * the upstream base URL is dropped. Entries that need account-specific paths
 * carry "{placeholder}" segments the user fills in on creation.
 */
const CHAT_CATALOG: CatalogEntry[] = [
	{
		name: "Amazon Bedrock",
		baseUrl: "https://bedrock-runtime.{region}.amazonaws.com",
		apiFormat: "openai",
		models: [
			{ id: "amazon.nova-pro-v1:0", contextWindow: 300000 },
			{ id: "anthropic.claude-fable-5", contextWindow: 1000000 },
			{ id: "anthropic.claude-haiku-4-5-20251001-v1:0", contextWindow: 200000 },
		],
	},
	{
		name: "Ant Ling",
		baseUrl: "https://api.ant-ling.com",
		apiFormat: "openai",
		models: [
			{ id: "Ling-2.6-1T", contextWindow: 262144 },
			{ id: "Ling-2.6-flash", contextWindow: 262144 },
			{ id: "Ring-2.6-1T", contextWindow: 262144 },
		],
	},
	{
		name: "Anthropic",
		baseUrl: "https://api.anthropic.com",
		apiFormat: "anthropic",
		models: [
			{ id: "claude-opus-4-6", contextWindow: 1000000 },
			{ id: "claude-sonnet-4-5", contextWindow: 200000 },
			{ id: "claude-haiku-4-5", contextWindow: 200000 },
		],
	},
	{
		name: "Azure OpenAI",
		baseUrl: "https://{resource}.openai.azure.com/openai",
		apiFormat: "openai",
		models: [
			{ id: "gpt-4o", contextWindow: 128000 },
			{ id: "gpt-4.1", contextWindow: 1047576 },
			{ id: "gpt-4o-mini", contextWindow: 128000 },
		],
	},
	{
		name: "Baseten",
		baseUrl: "https://inference.baseten.co",
		apiFormat: "openai",
		models: [
			{ id: "deepseek-ai/DeepSeek-V4-Pro", contextWindow: 262144 },
			{ id: "deepseek-ai/DeepSeek-V4-Flash-0731", contextWindow: 1048576 },
			{ id: "moonshotai/Kimi-K2.5", contextWindow: 262000 },
		],
	},
	{
		name: "Cerebras",
		baseUrl: "https://api.cerebras.ai",
		apiFormat: "openai",
		models: [
			{ id: "gpt-oss-120b", contextWindow: 131072 },
			{ id: "gemma-4-31b", contextWindow: 131072 },
		],
	},
	{
		name: "Cloudflare AI Gateway",
		baseUrl: "https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_slug}",
		apiFormat: "openai",
		models: [
			{ id: "claude-sonnet-4-5", contextWindow: 200000 },
			{ id: "claude-haiku-4-5", contextWindow: 200000 },
			{ id: "gpt-4o", contextWindow: 128000 },
		],
	},
	{
		name: "Cloudflare Workers AI",
		baseUrl: "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai",
		apiFormat: "openai",
		models: [
			{ id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", contextWindow: 24000 },
			{ id: "@cf/meta/llama-4-scout-17b-16e-instruct", contextWindow: 131000 },
			{ id: "@cf/moonshotai/kimi-k2.6", contextWindow: 262144 },
		],
	},
	{
		name: "DeepSeek",
		baseUrl: "https://api.deepseek.com",
		apiFormat: "openai",
		models: [
			{ id: "deepseek-v4-flash", contextWindow: 1000000 },
			{ id: "deepseek-v4-pro", contextWindow: 1000000 },
		],
	},
	// SiliconFlow doubles as a chat provider (DeepSeek/Qwen/GLM etc.), so its
	// two regions also appear in the Add-provider dropdown — same display name
	// as the fixed embedding entries in the list above.
	{
		name: "SiliconFlow CN",
		baseUrl: "https://api.siliconflow.cn",
		apiFormat: "openai",
		models: [
			{ id: "deepseek-ai/DeepSeek-V3.2", contextWindow: 163840 },
			{ id: "Qwen/Qwen3-235B-A22B", contextWindow: 262144 },
			{ id: "THUDM/GLM-4-Plus", contextWindow: 131072 },
		],
	},
	{
		name: "SiliconFlow",
		baseUrl: "https://api.siliconflow.com",
		apiFormat: "openai",
		models: [
			{ id: "deepseek-ai/DeepSeek-V3.2", contextWindow: 163840 },
			{ id: "Qwen/Qwen3-235B-A22B", contextWindow: 262144 },
			{ id: "THUDM/GLM-4-Plus", contextWindow: 131072 },
		],
	},
	{
		name: "Fireworks",
		baseUrl: "https://api.fireworks.ai/inference",
		apiFormat: "openai",
		models: [
			{ id: "accounts/fireworks/models/deepseek-v4-flash", contextWindow: 1000000 },
			{ id: "accounts/fireworks/models/deepseek-v4-pro", contextWindow: 1000000 },
			{ id: "accounts/fireworks/models/gpt-oss-120b", contextWindow: 131072 },
		],
	},
	{
		name: "GitHub Copilot",
		baseUrl: "https://api.individual.githubcopilot.com",
		apiFormat: "openai",
		models: [
			{ id: "claude-opus-4-6", contextWindow: 1000000 },
			{ id: "claude-sonnet-4-5", contextWindow: 200000 },
			{ id: "gpt-4o", contextWindow: 128000 },
		],
	},
	{
		name: "Google",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		apiFormat: "openai",
		models: [
			{ id: "gemini-2.5-pro", contextWindow: 1048576 },
			{ id: "gemini-2.5-flash", contextWindow: 1048576 },
			{ id: "gemini-2.5-flash-lite", contextWindow: 1048576 },
		],
	},
	{
		name: "Google Vertex",
		baseUrl: "https://{region}-aiplatform.googleapis.com/v1beta",
		apiFormat: "openai",
		models: [
			{ id: "gemini-2.5-pro", contextWindow: 1048576 },
			{ id: "gemini-2.5-flash", contextWindow: 1048576 },
		],
	},
	{
		name: "Groq",
		baseUrl: "https://api.groq.com/openai",
		apiFormat: "openai",
		models: [
			{ id: "llama-3.3-70b-versatile", contextWindow: 131072 },
			{ id: "llama-3.1-8b-instant", contextWindow: 131072 },
			{ id: "openai/gpt-oss-120b", contextWindow: 131072 },
		],
	},
	{
		name: "Hugging Face",
		baseUrl: "https://router.huggingface.co",
		apiFormat: "openai",
		models: [
			{ id: "deepseek-ai/DeepSeek-V3.2", contextWindow: 163840 },
			{ id: "deepseek-ai/DeepSeek-R1", contextWindow: 64000 },
			{ id: "meta-llama/Llama-3.3-70B-Instruct", contextWindow: 131072 },
		],
	},
	{
		name: "Kimi For Coding",
		baseUrl: "https://api.kimi.com/coding",
		apiFormat: "anthropic",
		models: [
			{ id: "kimi-for-coding", contextWindow: 262144 },
			{ id: "kimi-for-coding-highspeed", contextWindow: 262144 },
			{ id: "k3", contextWindow: 1048576 },
		],
	},
	{
		name: "MiniMax",
		baseUrl: "https://api.minimax.io/anthropic",
		apiFormat: "anthropic",
		models: [
			{ id: "MiniMax-M3", contextWindow: 1000000 },
			{ id: "MiniMax-M2.7", contextWindow: 204800 },
		],
	},
	{
		name: "MiniMax CN",
		baseUrl: "https://api.minimaxi.com/anthropic",
		apiFormat: "anthropic",
		models: [
			{ id: "MiniMax-M3", contextWindow: 1000000 },
			{ id: "MiniMax-M2.7", contextWindow: 204800 },
		],
	},
	{
		name: "Mistral",
		baseUrl: "https://api.mistral.ai",
		apiFormat: "openai",
		models: [
			{ id: "mistral-large-latest", contextWindow: 131072 },
			{ id: "codestral-latest", contextWindow: 256000 },
			{ id: "devstral-latest", contextWindow: 262144 },
		],
	},
	{
		name: "Moonshot AI",
		baseUrl: "https://api.moonshot.ai",
		apiFormat: "openai",
		models: [
			{ id: "kimi-k2.5", contextWindow: 262144 },
			{ id: "kimi-k2-thinking", contextWindow: 262144 },
			{ id: "kimi-k2-0905-preview", contextWindow: 262144 },
		],
	},
	{
		name: "Moonshot AI CN",
		baseUrl: "https://api.moonshot.cn",
		apiFormat: "openai",
		models: [
			{ id: "kimi-k2.5", contextWindow: 262144 },
			{ id: "kimi-k2-thinking", contextWindow: 262144 },
			{ id: "kimi-k2-0905-preview", contextWindow: 262144 },
		],
	},
	{
		name: "NVIDIA",
		baseUrl: "https://integrate.api.nvidia.com",
		apiFormat: "openai",
		models: [
			{ id: "meta/llama-3.1-70b-instruct", contextWindow: 128000 },
			{ id: "meta/llama-3.1-8b-instruct", contextWindow: 16000 },
			{ id: "google/gemma-3-12b-it", contextWindow: 131072 },
		],
	},
	{
		name: "OpenAI",
		baseUrl: "https://api.openai.com",
		apiFormat: "openai",
		models: [
			{ id: "gpt-4o", contextWindow: 128000 },
			{ id: "gpt-4.1", contextWindow: 1047576 },
			{ id: "gpt-4o-mini", contextWindow: 128000 },
		],
	},
	{
		name: "OpenAI Codex",
		baseUrl: "https://chatgpt.com/backend-api",
		apiFormat: "openai",
		models: [
			{ id: "gpt-5.4", contextWindow: 272000 },
			{ id: "gpt-5.4-mini", contextWindow: 272000 },
			{ id: "gpt-5.3-codex-spark", contextWindow: 128000 },
		],
	},
	{
		name: "OpenRouter",
		baseUrl: "https://openrouter.ai/api",
		apiFormat: "openai",
		models: [
			{ id: "anthropic/claude-sonnet-4-5", contextWindow: 200000 },
			{ id: "anthropic/claude-haiku-4-5", contextWindow: 200000 },
			{ id: "meta-llama/llama-3.3-70b-instruct", contextWindow: 131072 },
		],
	},
	{
		name: "Qwen Token Plan",
		baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode",
		apiFormat: "openai",
		models: [
			{ id: "deepseek-v4-flash", contextWindow: 1000000 },
			{ id: "deepseek-v4-pro", contextWindow: 1000000 },
			{ id: "glm-5", contextWindow: 202752 },
		],
	},
	{
		name: "Qwen Token Plan CN",
		baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode",
		apiFormat: "openai",
		models: [
			{ id: "deepseek-v4-flash", contextWindow: 1000000 },
			{ id: "deepseek-v4-pro", contextWindow: 1000000 },
			{ id: "glm-5", contextWindow: 202752 },
		],
	},
	{
		name: "Qwen Token Plan Individual",
		baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode",
		apiFormat: "openai",
		models: [
			{ id: "qwen3.6-flash", contextWindow: 1000000 },
			{ id: "qwen3.7-max", contextWindow: 1000000 },
			{ id: "deepseek-v4-pro", contextWindow: 1000000 },
		],
	},
	{
		name: "Together",
		baseUrl: "https://api.together.ai",
		apiFormat: "openai",
		models: [
			{ id: "deepseek-ai/DeepSeek-V4-Pro", contextWindow: 512000 },
			{ id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", contextWindow: 131072 },
			{ id: "google/gemma-4-31B-it", contextWindow: 262144 },
		],
	},
	{
		name: "Vercel AI Gateway",
		baseUrl: "https://ai-gateway.vercel.sh",
		apiFormat: "anthropic",
		models: [
			{ id: "alibaba/qwen-3-235b", contextWindow: 262144 },
			{ id: "alibaba/qwen-3.6-max-preview", contextWindow: 240000 },
			{ id: "anthropic/claude-sonnet-4-5", contextWindow: 200000 },
		],
	},
	{
		name: "xAI",
		baseUrl: "https://api.x.ai",
		apiFormat: "openai",
		models: [
			{ id: "grok-4.6", contextWindow: 500000 },
			{ id: "grok-4.5", contextWindow: 500000 },
			{ id: "grok-4.3", contextWindow: 1000000 },
		],
	},
	{
		name: "Xiaomi",
		baseUrl: "https://api.xiaomimimo.com",
		apiFormat: "openai",
		models: [
			{ id: "mimo-v2-pro", contextWindow: 1048576 },
			{ id: "mimo-v2-flash", contextWindow: 262144 },
			{ id: "mimo-v2.5", contextWindow: 1048576 },
		],
	},
	{
		name: "Xiaomi Token Plan AMS",
		baseUrl: "https://token-plan-ams.xiaomimimo.com",
		apiFormat: "openai",
		models: [
			{ id: "mimo-v2-pro", contextWindow: 1048576 },
			{ id: "mimo-v2.5", contextWindow: 1048576 },
		],
	},
	{
		name: "Xiaomi Token Plan CN",
		baseUrl: "https://token-plan-cn.xiaomimimo.com",
		apiFormat: "openai",
		models: [
			{ id: "mimo-v2-pro", contextWindow: 1048576 },
			{ id: "mimo-v2.5", contextWindow: 1048576 },
		],
	},
	{
		name: "Xiaomi Token Plan SGP",
		baseUrl: "https://token-plan-sgp.xiaomimimo.com",
		apiFormat: "openai",
		models: [
			{ id: "mimo-v2-pro", contextWindow: 1048576 },
			{ id: "mimo-v2.5", contextWindow: 1048576 },
		],
	},
	{
		name: "Z.AI",
		baseUrl: "https://api.z.ai/api/coding/paas/v4",
		apiFormat: "openai",
		models: [
			{ id: "glm-5.2", contextWindow: 1000000 },
			{ id: "glm-5-turbo", contextWindow: 200000 },
			{ id: "glm-4.7", contextWindow: 204800 },
		],
	},
	{
		name: "Z.AI Coding CN",
		baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
		apiFormat: "openai",
		models: [
			{ id: "glm-5.2", contextWindow: 1000000 },
			{ id: "glm-5-turbo", contextWindow: 200000 },
			{ id: "glm-4.7", contextWindow: 204800 },
		],
	},
];

// ──── Fetch available models ────

/** Model kinds. Cost-conscious classification: rerank (and known embedding
 *  ids) come from keywords with zero requests; everything else is probed
 *  against the embedding endpoint only — a model that fails it is "unknown".
 *  Chat/speech/image/video/translation models are deliberately NOT probed or
 *  tagged, since a per-model chat probe is the expensive part. */
export type ModelKind = "embedding" | "chat" | "rerank" | "tts" | "asr" | "image" | "video" | "translate" | "unknown";

export interface FetchedModel {
	id: string;
	kind: ModelKind;
	/** Context window reported by the endpoint itself, when it carries one
	 *  (non-standard but common, e.g. OpenRouter's `context_length`). */
	contextWindow?: number;
}

/**
 * Keyword classification — zero network requests. Only rerank (and known
 * embedding ids) is unambiguous enough to tag from the id alone; speech,
 * image, video and translation models are deliberately left "unknown" (they
 * are not worth a per-model probe).
 */
function classifyById(modelId: string): ModelKind | null {
	const id = modelId.toLowerCase();
	if (/rerank/.test(id)) return "rerank";
	if (/(^|[^a-z])(bge|e5|gte)([^a-z]|$)|embedding|text-embedding/.test(id)) return "embedding";
	return null;
}

/** Response fields providers use to report a model's context window. The
 *  OpenAI-compatible `GET /models` spec only guarantees `id`, so these are
 *  best-effort grabs of the common spellings. */
const CONTEXT_FIELDS = [
	"context_length",
	"contextWindow",
	"context_window",
	"max_context_length",
	"max_input_tokens",
] as const;

/** Read a model entry's context window from the response, if present. */
function contextOf(entry: unknown): number | undefined {
	if (typeof entry !== "object" || entry === null) return undefined;
	const obj = entry as Record<string, unknown>;
	for (const field of CONTEXT_FIELDS) {
		const v = obj[field];
		if (typeof v === "number" && v > 0) return Math.floor(v);
		if (typeof v === "string") {
			const n = parseInt(v, 10);
			if (!isNaN(n) && n > 0) return n;
		}
	}
	return undefined;
}

/** Probe order: chat first (most models are chat, early exit), then
 *  embedding. Rerank is matched by keyword and never probed. */
const PROBE_ORDER: Array<"chat" | "embedding"> = ["chat", "embedding"];

/** Session cache of per-endpoint classification results (keyed by base URL)
 *  so re-opening the picker does not re-probe everything. Persisted across
 *  restarts through settings.modelKindCache. */
const classifyCache = new Map<string, Map<string, ModelKind>>();

/** `v1`-anchored base URL: keeps an existing `/v1` suffix instead of
 *  doubling it ("https://api.openai.com/v1" → same; "https://api.deepseek.com"
 *  → "https://api.deepseek.com/v1"). */
function v1Base(base: string): string {
	return base.endsWith("/v1") ? base : `${base}/v1`;
}

/** Query an OpenAI/Anthropic-compatible endpoint for its model ids, keeping
 *  any context window the response reports per model. */
async function fetchModelIds(
	base: string,
	apiKey: string,
	apiFormat: ChatApiFormat,
): Promise<Array<{ id: string; contextWindow?: number }>> {
	const url = `${v1Base(base)}/models`;
	const headers: Record<string, string> = apiFormat === "anthropic"
		? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
		: { Authorization: `Bearer ${apiKey}` };
	const resp = await requestUrl({ url, method: "GET", headers, throw: false });
	if (resp.status !== 200) {
		throw new Error(`${t("fetchFailed")} (HTTP ${resp.status})`);
	}
	const data = (resp.json as { data?: unknown })?.data;
	if (!Array.isArray(data)) return [];
	const out: Array<{ id: string; contextWindow?: number }> = [];
	for (const entry of data) {
		if (typeof entry !== "object" || entry === null) continue;
		const id = (entry as { id?: unknown }).id;
		if (typeof id !== "string" || id.length === 0) continue;
		const ctx = contextOf(entry);
		out.push(ctx === undefined ? { id } : { id, contextWindow: ctx });
	}
	return out;
}

/** Probe one endpoint family with a minimal request; 200 means the model is
 *  served there. A transport failure is treated as "no", never a throw. */
async function probeKind(
	base: string,
	apiKey: string,
	model: string,
	kind: "chat" | "embedding",
): Promise<boolean> {
	const v1 = v1Base(base);
	const url = kind === "chat" ? `${v1}/chat/completions` : `${v1}/embeddings`;
	const body: unknown = kind === "chat"
		? { model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }
		: { model, input: "hi", encoding_format: "float" };
	try {
		const resp = await requestUrl({
			url,
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
			throw: false,
		});
		return resp.status === 200;
	} catch {
		return false;
	}
}

/** Classify one model: keyword hint first (zero requests), then probe the
 *  chat and embedding endpoints with early exit on the first 200. */
async function classifyModel(
	base: string,
	apiKey: string,
	model: string,
): Promise<ModelKind> {
	const hinted = classifyById(model);
	if (hinted !== null) return hinted;
	for (const kind of PROBE_ORDER) {
		if (await probeKind(base, apiKey, model, kind)) return kind;
	}
	return "unknown";
}

/** Run `fn` over items with at most `limit` concurrent executions. */
async function runPool<T>(
	items: readonly T[],
	limit: number,
	fn: (item: T) => Promise<void>,
): Promise<void> {
	let i = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		while (i < items.length) {
			const item = items[i++];
			await fn(item);
		}
	});
	await Promise.all(workers);
}

/**
 * Fetch the endpoint's models and classify each: rerank/embedding ids come
 * from keywords (zero requests); everything else is probed against the chat
 * and embedding endpoints (chat first, early exit) and tagged "unknown" when
 * neither answers. Results are session-cached AND persisted to
 * settings.modelKindCache (keyed by base URL — no credentials) so a restart
 * does not re-probe the same endpoint.
 * @param plugin - used for the persisted cache.
 * @param onProgress - called as classification advances (done/total).
 */
async function fetchAvailableModels(
	plugin: SmartVaultPlugin,
	baseUrl: string,
	apiKey: string,
	apiFormat: ChatApiFormat,
	useCatalog = true,
	onProgress?: (done: number, total: number) => void,
): Promise<FetchedModel[]> {
	const base = (baseUrl || "").trim().replace(/\/+$/, "");
	if (!base) throw new Error(t("fetchNeedsBaseUrl"));
	// Catalog shortcut: a built-in entry answers locally — no network, no key.
	if (useCatalog) {
		const local = catalogModelsFor(base);
		if (local) return local;
	}
	const entries = await fetchModelIds(base, apiKey, apiFormat);
	if (entries.length === 0) return [];
	// Anthropic-format providers serve chat models only — skip the probes.
	if (apiFormat === "anthropic") {
		return entries.map((e) => ({ id: e.id, kind: "chat" as const, ...(e.contextWindow === undefined ? {} : { contextWindow: e.contextWindow }) }));
	}
	// Cache keyed by base URL only (the model directory of an endpoint does
	// not depend on the key, and keys must never be persisted).
	const cacheKey = base;
	let cache = classifyCache.get(cacheKey);
	if (!cache) {
		cache = new Map();
		classifyCache.set(cacheKey, cache);
		const saved = plugin.settings.modelKindCache?.[cacheKey];
		if (saved) {
			for (const [modelId, kind] of Object.entries(saved)) {
				cache.set(modelId, kind as ModelKind);
			}
		}
	}
	const results: FetchedModel[] = [];
	let done = 0;
	await runPool(entries, 4, async (e) => {
		let kind = cache!.get(e.id);
		if (!kind) {
			kind = await classifyModel(base, apiKey, e.id);
			cache!.set(e.id, kind);
		}
		results.push({ id: e.id, kind, ...(e.contextWindow === undefined ? {} : { contextWindow: e.contextWindow }) });
		done++;
		onProgress?.(done, entries.length);
	});
	// Persist the updated classification for this endpoint.
	const savedObj: Record<string, string> = {};
	for (const [modelId, kind] of cache) savedObj[modelId] = kind;
	plugin.settings.modelKindCache = { ...(plugin.settings.modelKindCache ?? {}), [cacheKey]: savedObj };
	void plugin.saveSettings();
	return results;
}

/** Look up a model's context window in the built-in catalog by id — the
 *  fetch API only returns model ids, so catalog-known models (e.g.
 *  deepseek-v4-flash → 1M) keep their real capacity instead of the generic
 *  128k fallback. */
function catalogContextWindow(modelId: string): number | undefined {
	for (const entry of CHAT_CATALOG) {
		for (const m of entry.models) {
			if (m.id === modelId) return m.contextWindow;
		}
	}
	return undefined;
}

/** Default context window for models the catalog does not describe. */
const DEFAULT_CONTEXT_WINDOW = 128000;

/** Default per-category capacity: chat models get the generic 128k context
 *  window, embedding models a 8k max-input (bge-m3's standard limit). */
function defaultContextFor(kind: ChatModelKind): number {
	return kind === "embedding" ? 8192 : DEFAULT_CONTEXT_WINDOW;
}

/**
 * Catalog shortcut — DSH-style: when the endpoint matches a built-in catalog
 * entry, the models come straight from the local directory (with their real
 * context windows), no network request and no API key needed. Returns null
 * for endpoints the catalog does not describe.
 */
function catalogModelsFor(base: string): FetchedModel[] | null {
	const norm = base.toLowerCase();
	for (const entry of CHAT_CATALOG) {
		const entryBase = entry.baseUrl.replace(/\/+$/, "").toLowerCase();
		if (entryBase === norm) {
			return entry.models.map((m) => ({ id: m.id, kind: "chat" as const, contextWindow: m.contextWindow }));
		}
	}
	return null;
}

/** Compact token-count spelling: 1000000 → "1M", 262144 → "256K". */
export function formatContext(tokens: number): string {
	if (tokens >= 1000000) {
		const m = tokens / 1000000;
		return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
	}
	if (tokens >= 1000) {
		const k = tokens / 1000;
		return `${Number.isInteger(k) ? k : k.toFixed(1)}K`;
	}
	return String(tokens);
}

/** Candidate-picker modal (checkbox list); adopts the checked ids. */
class FetchModelsModal extends Modal {
	private picked = new Set<string>();

	constructor(
		app: App,
		private models: FetchedModel[],
		private existing: ReadonlySet<string>,
		private onAdopt: (ids: string[]) => void,
	) {
		super(app);
		this.modalEl.addClass("semlink-fetch-modal");
	}

	onOpen() {
		this.titleEl.setText(t("fetchTitle"));
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createDiv({ cls: "semlink-fetch-desc", text: t("fetchDescription") });

		const listEl = contentEl.createDiv({ cls: "semlink-fetch-list" });
		for (const model of this.models) {
			const label = listEl.createEl("label", { cls: "semlink-fetch-item" });
			const cb = label.createEl("input", { attr: { type: "checkbox" } });
			// Everything already configured starts unchecked, so adopting a
			// selection never silently rewrites a tuned context window. Among
			// new models only chat-kind ones are pre-checked — this picker
			// feeds the chat model list, and embedding/rerank models are shown
			// for reference but usually not what the user wants here.
			if (!this.existing.has(model.id)) {
				if (model.kind === "chat") {
					cb.checked = true;
					this.picked.add(model.id);
				}
			}
			cb.addEventListener("change", () => {
				if (cb.checked) this.picked.add(model.id);
				else this.picked.delete(model.id);
			});
			label.createSpan({ text: model.id });
			// Kind tag: the three probed categories get accent colors, the
			// id-hinted ones (speech/image/video/translation) a neutral pill.
			const kindCls = model.kind === "embedding"
				? "is-embedding"
				: model.kind === "chat"
					? "is-chat"
					: model.kind === "rerank"
						? "is-rerank"
						: null;
			if (model.kind !== "unknown") {
				label.createSpan({
					cls: `semlink-fetch-kind${kindCls ? ` ${kindCls}` : ""}`,
					// The kind key must go through t() — showing the raw key
					// would print "modelTagChat" etc.
					text: t(modelKindKey(model.kind)),
				});
			}
			// Show the context window when the endpoint or the catalog
			// reported one (e.g. "1M"), right-aligned, so adopting is an
			// informed choice.
			const ctx = model.contextWindow ?? catalogContextWindow(model.id);
			if (ctx !== undefined) {
				label.createSpan({ cls: "semlink-fetch-ctx", text: formatContext(ctx) });
			}
			if (this.existing.has(model.id)) {
				label.createSpan({ cls: "semlink-fetch-existing", text: "✓" });
			}
		}

		new Setting(contentEl)
			.addButton((btn) => btn.setButtonText(t("cancel")).onClick(() => this.close()))
			.addButton((btn) =>
				btn
					.setButtonText(t("fetchAdopt"))
					.setClass("mod-cta")
					.onClick(() => {
						this.onAdopt([...this.picked]);
						this.close();
					})
			);
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** Modal hosting the "Add provider" (catalog) or "Add a custom provider"
 *  create card. Closes on cancel or after a provider is created. */
class AddProviderModal extends Modal {
	constructor(
		app: App,
		private plugin: SmartVaultPlugin,
		private kind: "catalog" | "custom",
		private onCreated: (provider: ChatProvider) => void,
	) {
		super(app);
		this.modalEl.addClass("semlink-add-provider-modal");
		// The modal lives outside the settings pane, but its inner forms
		// reuse the `.smart-vault-settings .semlink-*` styles — scoping the
		// modal itself with the same class makes those selectors match.
		this.modalEl.addClass("smart-vault-settings");
	}

	onOpen() {
		this.titleEl.setText(this.kind === "catalog" ? t("addProvider") : t("customTitle"));
		const { contentEl } = this;
		contentEl.empty();
		const opts = {
			onCancel: () => this.close(),
			onCreated: (provider: ChatProvider) => {
				this.close();
				this.onCreated(provider);
			},
		};
		if (this.kind === "catalog") {
			renderAddCatalogCard(contentEl, this.plugin, opts);
		} else {
			renderCustomCard(contentEl, this.plugin, opts);
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** Delete-confirmation modal for a chat provider. */
class DeleteProviderModal extends Modal {
	constructor(
		app: App,
		private displayName: string,
		private onConfirm: () => void,
	) {
		super(app);
		this.modalEl.addClass("semlink-delete-modal");
	}

	onOpen() {
		this.titleEl.setText(t("deleteTitle").replace("{provider}", this.displayName));
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createDiv({ cls: "semlink-delete-desc", text: t("deleteDescription") });
		new Setting(contentEl)
			.addButton((btn) => btn.setButtonText(t("cancel")).onClick(() => this.close()))
			.addButton((btn) =>
				btn
					.setButtonText(t("deleteConfirm"))
					.setWarning()
					.onClick(() => {
						this.close();
						this.onConfirm();
					})
			);
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ──── Model list editor (shared by chat editors and create cards) ────

/** The model-category choices offered per model row. */
const MODEL_KINDS: readonly ChatModelKind[] = [
	"chat",
	"embedding",
	"rerank",
	"tts",
	"asr",
	"image",
	"video",
	"translate",
];

/** i18n key for a model-category label. */
function modelKindKey(kind: ChatModelKind): string {
	switch (kind) {
		case "embedding": return "modelTagEmbedding";
		case "rerank": return "modelTagRerank";
		case "tts": return "modelTagTts";
		case "asr": return "modelTagAsr";
		case "image": return "modelTagImage";
		case "video": return "modelTagVideo";
		case "translate": return "modelTagTranslate";
		default: return "modelTagChat";
	}
}

export interface ModelProbe {
	baseUrl: string;
	apiKey: string;
	apiFormat: ChatApiFormat;
}

interface ModelListOptions {
	app: App;
	/** Plugin for the persisted model-kind cache. */
	plugin: SmartVaultPlugin;
	/** Read the current model rows (may be replaced after each change). */
	getModels: () => ChatModel[];
	/** Persist a (possibly new) model list. */
	onChange: (models: ChatModel[]) => void;
	/** Current endpoint facts for the fetch action. */
	probe: () => ModelProbe;
	/** Allow the local-catalog shortcut (no key needed) when the endpoint
	 *  matches a built-in entry. Defaults to true; embedding-provider editors
	 *  disable it because they want the live endpoint's full model list. */
	catalogShortcut?: boolean;
	/** Called after a structural change (add/remove a row, adopt fetched
	 *  models) so the surrounding page can re-render — e.g. the General tab's
	 *  model dropdowns derive their options from these lists. */
	onStructuralChange?: () => void;
}

interface ModelListHandle {
	/** Re-evaluate the fetch button's disabled state (call after the probe
	 *  fields — baseUrl / apiKey — change in the surrounding editor). */
	updateProbeState: () => void;
}

/** Render the model rows of one chat provider with add/fetch/remove actions. */
function renderModelList(containerEl: HTMLElement, opts: ModelListOptions): ModelListHandle {
	const section = containerEl.createDiv({ cls: "semlink-model-list" });
	const headEl = section.createDiv({ cls: "semlink-model-list-head" });
	headEl.createSpan({ cls: "semlink-model-list-title", text: t("chatModels") });
	const countEl = headEl.createSpan({ cls: "semlink-model-list-count" });
	const fetchBtn = headEl.createEl("button", { cls: "semlink-link-btn", text: t("fetchModels") });
	const rowsEl = section.createDiv({ cls: "semlink-model-rows" });
	const errorEl = section.createDiv({ cls: "semlink-model-error" });
	errorEl.style.display = "none";
	const addBtn = section.createEl("button", { cls: "semlink-add-model-btn", text: `＋ ${t("chatAddModel")}` });

	let fetching = false;

	const updateProbeState = () => {
		const { baseUrl, apiKey } = opts.probe();
		const base = baseUrl.trim();
		// A built-in catalog match needs no key at all (DSH-style shortcut);
		// anything else needs both base URL and key to interrogate.
		const catalogHit = opts.catalogShortcut !== false
			&& base.length > 0
			&& catalogModelsFor(base) !== null;
		const ok = catalogHit || (base.length > 0 && apiKey.trim().length > 0);
		(fetchBtn as HTMLButtonElement).disabled = !ok || fetching;
		fetchBtn.setAttr("title", ok ? "" : t("fetchNeedsBaseUrl"));
	};

	const rerender = () => {
		const models = opts.getModels();
		countEl.setText(`(${String(models.length)})`);
		rowsEl.empty();
		models.forEach((model, mi) => {
			const rowEl = rowsEl.createDiv({ cls: "semlink-model-row" });
			// Model-category selector sits before the model id (嵌入/对话/重排序).
			const kindSel = rowEl.createEl("select", { cls: "semlink-input semlink-model-kind" });
			for (const kind of MODEL_KINDS) {
				kindSel.createEl("option", { value: kind, text: t(modelKindKey(kind)) });
			}
			kindSel.value = model.kind ?? "chat";
			kindSel.addEventListener("change", () => {
				model.kind = kindSel.value as ChatModelKind;
				// Embedding models have a max-input limit, not a chat context
				// window — the placeholder follows the row's category.
				ctxInput.setAttr("placeholder", model.kind === "embedding"
					? t("embedMaxInput")
					: t("chatContextWindow"));
				opts.onChange(models);
			});
			const idInput = rowEl.createEl("input", {
				cls: "semlink-input",
				attr: { placeholder: t("chatModelId") },
			});
			idInput.value = model.id;
			idInput.addEventListener("input", () => {
				model.id = idInput.value;
				opts.onChange(models);
			});
			const ctxInput = rowEl.createEl("input", {
				cls: "semlink-input semlink-input-ctx",
				attr: {
					placeholder: (model.kind ?? "chat") === "embedding"
						? t("embedMaxInput")
						: t("chatContextWindow"),
					type: "number",
					min: "1",
				},
			});
			ctxInput.value = String(model.contextWindow);
			ctxInput.addEventListener("input", () => {
				const n = parseInt(ctxInput.value, 10);
				if (!isNaN(n) && n > 0) {
					model.contextWindow = n;
					opts.onChange(models);
				}
			});
			const rmBtn = rowEl.createEl("button", {
				cls: "semlink-icon-btn semlink-icon-btn-danger",
				attr: { "aria-label": `${t("chatDeleteModel")} ${mi + 1}` },
			});
			setIcon(rmBtn, "trash");
			rmBtn.addEventListener("click", () => {
				models.splice(mi, 1);
				opts.onChange(models);
				opts.onStructuralChange?.();
				rerender();
			});
		});
		updateProbeState();
	};

	addBtn.addEventListener("click", () => {
		opts.getModels().push({ id: "", contextWindow: defaultContextFor("chat") });
		opts.onChange(opts.getModels());
		opts.onStructuralChange?.();
		rerender();
	});

	fetchBtn.addEventListener("click", async () => {
		const { baseUrl, apiKey, apiFormat } = opts.probe();
		fetching = true;
		fetchBtn.setText(t("fetching"));
		updateProbeState();
		errorEl.style.display = "none";
		try {
			const models = await fetchAvailableModels(
				opts.plugin,
				baseUrl,
				apiKey,
				apiFormat,
				opts.catalogShortcut !== false,
				(done, total) => {
					fetchBtn.setText(t("classifying").replace("{done}", String(done)).replace("{total}", String(total)));
				},
			);
			if (models.length === 0) {
				errorEl.setText(t("fetchEmpty"));
				errorEl.style.display = "block";
				return;
			}
			const current = opts.getModels();
			const known = new Set(current.map((m) => m.id).filter((id) => id.length > 0));
			new FetchModelsModal(opts.app, models, known, (picked) => {
				const byId = new Map(opts.getModels().map((m) => [m.id, m]));
				for (const id of picked) {
					const found = models.find((fm) => fm.id === id);
					if (!found) continue;
					const existing = byId.get(id);
					// Refresh the kind + context window of models already in
					// the list too: the endpoint classification and the
					// catalog are more accurate than the generic defaults.
					// Unknown classification keeps the current kind; when the
					// response and catalog both lack a context window, the
					// existing value is kept rather than reset to the fallback.
					const kind: ChatModelKind = found.kind !== "unknown"
						? found.kind
						: existing?.kind ?? "chat";
					const ctx = found.contextWindow
						?? catalogContextWindow(id)
						?? existing?.contextWindow
						?? defaultContextFor(kind);
					byId.set(id, existing
						? { ...existing, id, contextWindow: ctx, kind }
						: { id, contextWindow: ctx, kind });
				}
				opts.onChange([...byId.values()]);
				opts.onStructuralChange?.();
				rerender();
			}).open();
		} catch (e) {
			errorEl.setText(e instanceof Error ? e.message : String(e));
			errorEl.style.display = "block";
		} finally {
			fetching = false;
			fetchBtn.setText(t("fetchModels"));
			updateProbeState();
		}
	});

	rerender();
	return { updateProbeState };
}

// ──── Provider rows ────

interface RowOptions {
	name: string;
	/** Optional kind marker — providers themselves are NOT distinguished as
	 *  embedding/chat; the distinction lives on the models inside each editor. */
	tag?: string;
	dot?: "configured" | "missing";
	badge?: string;
	editing: boolean;
	onEdit: () => void;
	onDelete?: () => void;
}

/** Create one provider row; returns the editor slot below the row head.
 *  Clicking the row head toggles the editor (like the collapsible sections) —
 *  there is no separate Edit button; only Remove stays as a button. */
function createProviderRow(listEl: HTMLElement, opts: RowOptions): HTMLElement {
	const row = listEl.createDiv({ cls: `semlink-provider-row${opts.editing ? " is-open" : ""}` });
	const head = row.createDiv({ cls: "semlink-provider-row-head" });
	head.addEventListener("click", opts.onEdit);
	head.createSpan({ cls: "semlink-row-chevron", text: "▶" });
	const identity = head.createDiv({ cls: "semlink-provider-identity" });
	identity.createSpan({ cls: "semlink-provider-name", text: opts.name });
	if (opts.tag) identity.createSpan({ cls: "semlink-provider-tag", text: opts.tag });
	if (opts.dot) {
		identity.createSpan({
			cls: `semlink-provider-dot ${opts.dot === "configured" ? "is-configured" : "is-missing"}`,
			attr: {
				title: opts.dot === "configured" ? t("credentialConfigured") : t("credentialMissing"),
				"aria-label": opts.dot === "configured" ? t("credentialConfigured") : t("credentialMissing"),
			},
		});
	}
	if (opts.badge) identity.createSpan({ cls: "semlink-provider-badge", text: opts.badge });
	const actions = head.createDiv({ cls: "semlink-provider-actions" });
	if (opts.onDelete) {
		const delBtn = actions.createEl("button", { cls: "semlink-btn semlink-btn-danger", text: t("remove") });
		// The head toggles the editor — stop the click from also toggling.
		delBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			opts.onDelete!();
		});
	}
	return row.createDiv({ cls: "semlink-provider-editor" });
}

// ──── Editors ────

/** Editor for one embedding provider, using the same display logic as the
 *  chat providers: 显示名称 → Base URL → API 协议 → API 密钥 → 模型列表.
 *  The model list is kind-tagged; the first "embedding" entry stays in sync
 *  with `p.model` (the embedding model the runtime actually uses). */
function renderEmbeddingProviderEditor(
	slot: HTMLElement,
	plugin: SmartVaultPlugin,
	p: EmbeddingProviderConfig,
	refresh: () => void,
): void {
	// Display name — saved on every change; the row header (and any other
	// name-derived label) is refreshed on blur so it follows without needing
	// a tab switch, without stealing focus mid-typing.
	new Setting(slot)
		.setName(t("chatProviderName"))
		.addText((text) => {
			text
				.setValue(p.name)
				.onChange(async (value) => {
					p.name = value;
					await plugin.saveSettings();
				});
			text.inputEl.addEventListener("blur", refresh);
		});

	// Base URL
	new Setting(slot)
		.setName(p.kind === "huggingface" ? t("chatBaseUrl") : t("apiBase"))
		.addText((text) =>
			text
				.setPlaceholder("https://api.siliconflow.cn")
				.setValue(p.apiBase)
				.onChange(async (value) => {
					p.apiBase = value;
					await plugin.saveSettings();
				})
		);

	// API protocol (drives the model-list fetch; embedding requests use the
	// provider family regardless)
	new Setting(slot)
		.setName(t("chatApiFormat"))
		.addDropdown((dropdown) =>
			dropdown
				.addOptions({
					"openai": t("chatFormatOpenAI"),
					"anthropic": t("chatFormatAnthropic"),
				})
				.setValue(p.apiFormat ?? "openai")
				.onChange(async (value) => {
					p.apiFormat = value as ChatApiFormat;
					await plugin.saveSettings();
				})
		);

	// API key
	new Setting(slot)
		.setName(t("apiKey"))
		.setDesc(p.kind === "huggingface"
			? t("huggingFaceApiKeyDesc")
			: t("apiKeyDesc").replace("{site}", p.apiBase.includes("siliconflow.com") ? "siliconflow.com" : "siliconflow.cn"))
		.addText((text) =>
			text
				.setPlaceholder("sk-...")
				.setValue(p.apiKey)
				.onChange(async (value) => {
					p.apiKey = value;
					await plugin.saveSettings();
				})
		)
		.then((setting) => {
			const input = setting.controlEl.querySelector("input") as HTMLInputElement | null;
			if (input) input.type = "password";
		});

	// Model list — same editor as chat providers (kind selector + fetch + add/
	// remove). The persisted list is `p.models`; the current embedding model
	// is always shown as the first (embedding) row and kept in sync.
	renderModelList(slot, {
		app: plugin.app,
		plugin,
		// Embedding editors need the live endpoint's full list (incl. bge
		// etc.), not the chat-only catalog shortcut.
		catalogShortcut: false,
		// Adding/removing models feeds the General tab's embedding/chat model
		// dropdowns — re-render the page (scroll preserved) so they update.
		onStructuralChange: refresh,
		getModels: () => {
			const base = p.models && p.models.length > 0 ? [...p.models] : [];
			if (!base.some((m) => m.id === p.model)) {
				base.unshift({ id: p.model, contextWindow: defaultContextFor("embedding"), kind: "embedding" });
			}
			return base;
		},
		onChange: (models) => {
			p.models = models;
			const emb = models.find((m) => (m.kind ?? "chat") === "embedding");
			if (emb && emb.id) p.model = emb.id;
			void plugin.saveSettings();
		},
		probe: () => ({ baseUrl: p.apiBase, apiKey: p.apiKey, apiFormat: p.apiFormat ?? "openai" }),
	});
}

/** Editor for one existing chat provider (saves on change). Fields appear in
 *  order: name → base URL → protocol → API key → model list. */
function renderChatProviderEditor(
	slot: HTMLElement,
	plugin: SmartVaultPlugin,
	provider: ChatProvider,
	refresh: () => void,
): void {
	// The model list is rendered last; the probe-state refresh below needs a
	// handle, so it is assigned at the end and dereferenced lazily.
	let modelHandle: ModelListHandle | null = null;

	// Display name — saved on every change; refresh the row header on blur so
	// the rename shows without a tab switch (and without losing focus).
	new Setting(slot)
		.setName(t("chatProviderName"))
		.addText((text) => {
			text
				.setPlaceholder("DeepSeek")
				.setValue(provider.name)
				.onChange(async (value) => {
					provider.name = value;
					await plugin.saveSettings();
				});
			text.inputEl.addEventListener("blur", refresh);
		});

	new Setting(slot)
		.setName(t("chatBaseUrl"))
		.addText((text) =>
			text
				.setPlaceholder("https://api.example.com")
				.setValue(provider.baseUrl)
				.onChange(async (value) => {
					provider.baseUrl = value;
					await plugin.saveSettings();
					modelHandle?.updateProbeState();
				})
		);

	new Setting(slot)
		.setName(t("chatApiFormat"))
		.addDropdown((dropdown) =>
			dropdown
				.addOptions({
					"openai": t("chatFormatOpenAI"),
					"anthropic": t("chatFormatAnthropic"),
				})
				.setValue(provider.apiFormat)
				.onChange(async (value) => {
					provider.apiFormat = value as ChatApiFormat;
					await plugin.saveSettings();
					modelHandle?.updateProbeState();
				})
		);

	new Setting(slot)
		.setName(t("chatApiKey"))
		.addText((text) =>
			text
				.setPlaceholder("sk-...")
				.setValue(provider.apiKey)
				.onChange(async (value) => {
					provider.apiKey = value;
					await plugin.saveSettings();
					modelHandle?.updateProbeState();
				})
		)
		.then((setting) => {
			const input = setting.controlEl.querySelector("input") as HTMLInputElement | null;
			if (input) input.type = "password";
		});

	modelHandle = renderModelList(slot, {
		app: plugin.app,
		plugin,
		onStructuralChange: refresh,
		getModels: () => provider.models,
		onChange: (models) => {
			provider.models = models;
			void plugin.saveSettings();
		},
		probe: () => ({ baseUrl: provider.baseUrl, apiKey: provider.apiKey, apiFormat: provider.apiFormat }),
	});
}

// ──── Create cards (add provider / add custom provider) ────

interface ChatProviderDraft {
	name: string;
	baseUrl: string;
	apiKey: string;
	apiFormat: ChatApiFormat;
	models: ChatModel[];
}

const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

interface DraftEditorOptions {
	submitLabel: string;
	submitBusyLabel: string;
	/** Present on the custom-provider card: the route-id field. */
	route?: {
		/** Live route-id value (read at submit time). */
		getValue: () => string;
		onChange: (v: string) => void;
	};
	onCancel: () => void;
	onCreated: (provider: ChatProvider) => void;
}

/** Field set shared by the catalog-add and custom-provider create cards. */
function renderDraftEditor(
	slot: HTMLElement,
	plugin: SmartVaultPlugin,
	draft: ChatProviderDraft,
	opts: DraftEditorOptions,
): void {
	const errorEl = slot.createDiv({ cls: "semlink-draft-error" });
	errorEl.style.display = "none";
	let busy = false;
	// The model list is rendered last (after protocol + key); the probe-state
	// refresh above needs a handle, so it is assigned lazily.
	let modelHandle: ModelListHandle | null = null;

	if (opts.route) {
		new Setting(slot)
			.setName(t("customRoute"))
			.setDesc(t("customRouteHint"))
			.addText((text) =>
				text
					.setPlaceholder("acme-gateway")
					.setValue(opts.route!.getValue())
					.onChange((value) => opts.route!.onChange(value))
			)
			.then((setting) => {
				const input = setting.controlEl.querySelector("input") as HTMLInputElement | null;
				const updateHint = () => {
					const v = (input?.value ?? "").trim();
					if (v.length > 0 && !ROUTE_PATTERN.test(v)) {
						setting.descEl.setText(t("customRouteInvalid"));
						setting.descEl.addClass("is-error");
					} else if (plugin.settings.chatProviders.some((p) => p.id === v)) {
						setting.descEl.setText(t("customRouteTaken"));
						setting.descEl.addClass("is-error");
					} else {
						setting.descEl.setText(t("customRouteHint"));
						setting.descEl.removeClass("is-error");
					}
				};
				input?.addEventListener("input", updateHint);
				updateHint();
			});
	}

	new Setting(slot)
		.setName(t("chatProviderName"))
		.addText((text) =>
			text
				.setPlaceholder("My Gateway")
				.setValue(draft.name)
				.onChange((value) => {
					draft.name = value;
				})
		);

	new Setting(slot)
		.setName(t("chatBaseUrl"))
		.addText((text) =>
			text
				.setPlaceholder("https://api.example.com")
				.setValue(draft.baseUrl)
				.onChange((value) => {
					draft.baseUrl = value;
					modelHandle?.updateProbeState();
				})
		);

	new Setting(slot)
		.setName(t("chatApiFormat"))
		.addDropdown((dropdown) =>
			dropdown
				.addOptions({
					"openai": t("chatFormatOpenAI"),
					"anthropic": t("chatFormatAnthropic"),
				})
				.setValue(draft.apiFormat)
				.onChange((value) => {
					draft.apiFormat = value as ChatApiFormat;
					modelHandle?.updateProbeState();
				})
		);

	new Setting(slot)
		.setName(t("chatApiKey"))
		.addText((text) =>
			text
				.setPlaceholder("sk-...")
				.setValue(draft.apiKey)
				.onChange((value) => {
					draft.apiKey = value;
					modelHandle?.updateProbeState();
				})
		)
		.then((setting) => {
			const input = setting.controlEl.querySelector("input") as HTMLInputElement | null;
			if (input) input.type = "password";
		});

	modelHandle = renderModelList(slot, {
		app: plugin.app,
		plugin,
		getModels: () => draft.models,
		onChange: (models) => {
			draft.models = models;
		},
		probe: () => ({ baseUrl: draft.baseUrl, apiKey: draft.apiKey, apiFormat: draft.apiFormat }),
	});

	new Setting(slot)
		.addButton((btn) => btn.setButtonText(t("cancel")).onClick(() => opts.onCancel()))
		.addButton((btn) => {
			btn.setButtonText(opts.submitLabel).setClass("mod-cta").onClick(async () => {
				if (busy) return;
				errorEl.style.display = "none";
				const routeValue = opts.route ? opts.route.getValue().trim() : "";
				const routeInvalid = routeValue.length > 0 && !ROUTE_PATTERN.test(routeValue);
				const routeTaken = routeValue.length > 0
					&& plugin.settings.chatProviders.some((p) => p.id === routeValue);
				if (opts.route && (routeInvalid || routeTaken)) {
					errorEl.setText(routeInvalid ? t("customRouteInvalid") : t("customRouteTaken"));
					errorEl.style.display = "block";
					return;
				}
				if (!draft.baseUrl.trim()) {
					errorEl.setText(t("customNeedsBaseUrl"));
					errorEl.style.display = "block";
					return;
				}
				if (draft.models.length === 0 || draft.models.some((m) => !m.id.trim())) {
					errorEl.setText(t("customNeedsModels"));
					errorEl.style.display = "block";
					return;
				}
				busy = true;
				btn.setButtonText(opts.submitBusyLabel).setDisabled(true);
				const provider: ChatProvider = {
					id: opts.route ? routeValue : `provider-${Date.now()}`,
					name: draft.name.trim() || draft.baseUrl.trim(),
					baseUrl: draft.baseUrl.trim(),
					apiKey: draft.apiKey,
					apiFormat: draft.apiFormat,
					models: draft.models.map((m) => ({ ...m })),
				};
				plugin.settings.chatProviders.push(provider);
				await plugin.saveSettings();
				opts.onCreated(provider);
			});
		});
}

/** "Add provider" card: pick a catalog entry, then fill in the details.
 *  Rendered inside the AddProviderModal. */
function renderAddCatalogCard(
	containerEl: HTMLElement,
	plugin: SmartVaultPlugin,
	opts: { onCancel: () => void; onCreated: (provider: ChatProvider) => void },
): void {
	const card = containerEl.createDiv({ cls: "semlink-add-card" });
	card.createDiv({ cls: "semlink-add-card-title", text: t("addProvider") });

	let draft: ChatProviderDraft = draftFromCatalog(CHAT_CATALOG[0]);

	// The catalog dropdown sits ABOVE the provider fields (display name first).
	new Setting(card)
		.setName(t("catalogLabel"))
		.addDropdown((dropdown) =>
			dropdown
				.addOptions(Object.fromEntries(CHAT_CATALOG.map((c, i) => [String(i), c.name])))
				.setValue("0")
				.onChange((value) => {
					draft = draftFromCatalog(CHAT_CATALOG[parseInt(value, 10)]);
					rerenderDraft();
				})
		);

	const bodyEl = card.createDiv({ cls: "semlink-add-card-body" });

	const rerenderDraft = () => {
		bodyEl.empty();
		renderDraftEditor(bodyEl, plugin, draft, {
			submitLabel: t("create"),
			submitBusyLabel: t("creating"),
			onCancel: opts.onCancel,
			onCreated: opts.onCreated,
		});
	};

	rerenderDraft();
}

function draftFromCatalog(entry: CatalogEntry): ChatProviderDraft {
	return {
		name: entry.name,
		baseUrl: entry.baseUrl,
		apiKey: "",
		apiFormat: entry.apiFormat,
		models: entry.models.map((m) => ({ ...m })),
	};
}

/** "Add a custom provider" card: route id + full details. Rendered inside
 *  the AddProviderModal. */
function renderCustomCard(
	containerEl: HTMLElement,
	plugin: SmartVaultPlugin,
	opts: { onCancel: () => void; onCreated: (provider: ChatProvider) => void },
): void {
	const card = containerEl.createDiv({ cls: "semlink-add-card" });
	card.createDiv({ cls: "semlink-add-card-title", text: t("customTitle") });

	const routeState = { value: "" };
	const draft: ChatProviderDraft = {
		name: "",
		baseUrl: "",
		apiKey: "",
		apiFormat: "openai",
		models: [],
	};

	const bodyEl = card.createDiv({ cls: "semlink-add-card-body" });
	renderDraftEditor(bodyEl, plugin, draft, {
		submitLabel: t("create"),
		submitBusyLabel: t("creating"),
		route: {
			getValue: () => routeState.value,
			onChange: (v) => {
				routeState.value = v;
			},
		},
		onCancel: opts.onCancel,
		onCreated: opts.onCreated,
	});
}

// ──── Main render ────

export function renderModelsTab(
	plugin: SmartVaultPlugin,
	containerEl: HTMLElement,
	state: ModelsTabState,
	refresh: () => void,
): void {
	new Setting(containerEl).setName(t("sectionModel")).setHeading();

	// One unified provider list: fixed embedding providers (SiliconFlow
	// CN/Global, Hugging Face) first, then the user-managed chat providers.
	// The per-row tag (嵌入 / 对话) tells the kinds apart — no group headers.
	const listEl = containerEl.createDiv({ cls: "semlink-provider-rows" });

	for (const p of plugin.settings.embeddingProviders) {
		const editing = state.editing?.kind === "embedding" && state.editing.id === p.id;
		const active = p.id === plugin.settings.embeddingProviderId;
		const slot = createProviderRow(listEl, {
			name: p.name,
			// No embedding/chat tag on the provider — the distinction lives on
			// the models inside each editor. The badge just marks the provider
			// currently used as the embedding service.
			dot: p.apiKey ? "configured" : "missing",
			badge: active ? t("embedInUse") : undefined,
			editing,
			onEdit: () => {
				state.editing = editing ? null : { kind: "embedding", id: p.id };
				refresh();
			},
			onDelete: () => {
				new DeleteProviderModal(plugin.app, p.name, () => {
					plugin.settings.embeddingProviders = plugin.settings.embeddingProviders.filter(
						(x) => x.id !== p.id,
					);
					// If the removed provider was the active embedding service,
					// fall back to the first remaining one (or none — the
					// runtime then falls back to its built-in default).
					if (plugin.settings.embeddingProviderId === p.id) {
						plugin.settings.embeddingProviderId = plugin.settings.embeddingProviders[0]?.id ?? "";
					}
					if (state.editing?.kind === "embedding" && state.editing.id === p.id) {
						state.editing = null;
					}
					void plugin.saveSettings().then(() => refresh());
				}).open();
			},
		});
		if (editing) renderEmbeddingProviderEditor(slot, plugin, p, refresh);
	}

	for (const provider of plugin.settings.chatProviders) {
		const editing = state.editing?.kind === "chat" && state.editing.id === provider.id;
		const slot = createProviderRow(listEl, {
			name: provider.name || provider.id,
			dot: provider.apiKey ? "configured" : "missing",
			editing,
			onEdit: () => {
				state.editing = editing ? null : { kind: "chat", id: provider.id };
				refresh();
			},
			onDelete: () => {
				new DeleteProviderModal(plugin.app, provider.name || provider.id, () => {
					plugin.settings.chatProviders = plugin.settings.chatProviders.filter(
						(p) => p.id !== provider.id,
					);
					if (state.editing?.kind === "chat" && state.editing.id === provider.id) {
						state.editing = null;
					}
					void plugin.saveSettings().then(() => refresh());
				}).open();
			},
		});
		if (editing) renderChatProviderEditor(slot, plugin, provider, refresh);
	}

	// ── Add actions (open the create modal) ──
	const addBlock = containerEl.createDiv({ cls: "semlink-provider-add" });
	const actions = addBlock.createDiv({ cls: "semlink-provider-add-actions" });
	actions.createEl("button", { cls: "semlink-btn semlink-btn-cta", text: `＋ ${t("addProvider")}` })
		.addEventListener("click", () => {
			new AddProviderModal(plugin.app, plugin, "catalog", (provider) => {
				state.editing = { kind: "chat", id: provider.id };
				refresh();
			}).open();
		});
	actions.createEl("button", { cls: "semlink-btn", text: `＋ ${t("addCustomProvider")}` })
		.addEventListener("click", () => {
			new AddProviderModal(plugin.app, plugin, "custom", (provider) => {
				state.editing = { kind: "chat", id: provider.id };
				refresh();
			}).open();
		});
}
