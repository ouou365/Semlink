// ========================================
// Semlink - Chat Completion Client
// ========================================
// Wraps chat-completion calls for the conversational search feature.
// Supports both OpenAI-compatible (…/v1/chat/completions) and Anthropic
// (…/v1/messages) API formats, including function/tool calling so the model
// can query Semlink's search/read tools when the retrieved context is not
// enough. Answers stream via SSE (fetch + ReadableStream), with incremental
// text delivered through an onStream callback.

import type { SmartVaultSettings, ChatProvider, ChatModel, ContextBreakdown, HistoryMessage } from "./types";
import { debugLog } from "./log";
import type { SemlinkTools } from "./chat-tools";
import { createCiteRegistry } from "./cite-cards";
import { t } from "./i18n";

/** Maximum tool-calling rounds before giving up on a final answer. */
const MAX_TOOL_ITERATIONS = 5;
/** After this many tool rounds, nudge the model to answer directly. */
const NUDGE_AFTER_ROUND = 3;
/**
 * ZCode-style retry: 10 attempts in total (like ZCode's "重新连接中... N/10").
 * The first dispatch has no wait; attempt N (N≥2) waits
 * CHAT_RETRY_DELAYS_MS[N-2]. When the delays run out, give up.
 */
const CHAT_RETRY_TOTAL = 10;
const CHAT_RETRY_DELAYS_MS = [1000, 1500, 2000, 3000, 5000, 8000, 10000, 10000, 10000];

/** Full chat endpoint for a provider base: an explicit wirePath override
 *  wins (endpoints whose real path carries no bare "/v1" segment — GLM
 *  coding plans "/chat/completions", Gemini's "…/v1beta/openai"), otherwise
 *  the default wire convention is appended by format. The "/" sentinel
 *  means the base IS the full endpoint — POSTs land on the bare URL with
 *  no suffix at all (Z.AI Coding CN's …/api/anthropic gateway). */
function chatEndpoint(
	baseUrl: string,
	wirePath: string | undefined,
	defaultSuffix: "/v1/chat/completions" | "/v1/messages",
): string {
	const path = wirePath?.trim();
	if (path === "/") return baseUrl.replace(/\/+$/, "");
	if (path) return `${baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
	return `${baseUrl}${defaultSuffix}`;
}

/** One user-facing request's token usage (summed across all rounds —
 *  pre-analysis, tool rounds, final answer) for the Pro usage dashboard. */
export interface UsageSample {
	model: string;
	promptTokens: number;
	completionTokens: number;
}

/** A step in the model's thinking process, in chronological order. */
export type ThinkingStep =
	| { type: "thought"; text: string }
	| { type: "tool"; name: string; args: unknown; result: string };

/** Agent style for the chat system prompt: "classic" answers from snippets
 *  with minimal tool use, "proactive" actively reads related notes. */
export type AgentMode = "classic" | "proactive";

/** Analysis/overview-heavy prompts get the "enhanced" depth: full-note reads
 *  allowed and a larger per-result cap, so the model can read related
 *  protocol/design docs before answering. Shared by the sidebar search and
 *  the Feishu bot (identical behavior on both surfaces). */
export function inferAgentDepth(query: string): "standard" | "enhanced" {
	return /介绍|概述|分析|总结|梳理|归纳|对比|设计需求|如何设计|怎么设计|评估|方案|深入|是什么/.test(query)
		? "enhanced"
		: "standard";
}

/** Basename without extension (e.g. "S-101电子海图安装_更新（MIBT）产品说明"). */
function noteBasename(path: string): string {
	const slash = path.lastIndexOf("/");
	const name = slash >= 0 ? path.slice(slash + 1) : path;
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(0, dot) : name;
}

/** Build the initial retrieval context fed into the system prompt — the
 *  exact format the sidebar search uses. Shared so the Feishu bot feeds the
 *  model the identical context shape. */
export function buildNoteContext(results: Array<{ heading: string; notePath: string; contentPreview: string }>): string {
	return results
		.map((r, i) => {
			const title = r.heading || noteBasename(r.notePath);
			return `[${i + 1}] ${title}（${r.notePath}）\n${r.contentPreview}`;
		})
		.join("\n\n");
}

/** One request's prompt-cache usage sample. A turn averages these by TOKEN
 *  weight (Σhit / Σtotal), never by request count — small requests would
 *  otherwise drag the displayed hit rate down. */
export interface CacheSample {
	hit: number;
	total: number;
}

// ──── API wire types ────
// Narrow structural views of the two chat wire formats — only the fields
// this file actually reads/writes. SSE events and JSON bodies are cast to
// these once at the parse boundary; type-only, no runtime effect.

/** Token usage of an OpenAI-compatible response (DeepSeek cache fields included). */
interface OpenAIUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	prompt_cache_hit_tokens?: number;
	prompt_cache_miss_tokens?: number;
}

/** Delta payload of an OpenAI-compatible stream chunk. */
interface OpenAIStreamDelta {
	content?: string;
	tool_calls?: Array<{
		index?: number;
		id?: string;
		function?: { name?: string; arguments?: string };
	}>;
}

/** One SSE event of an OpenAI-compatible chat stream. */
interface OpenAIStreamEvent {
	choices?: Array<{ delta?: OpenAIStreamDelta }>;
	usage?: OpenAIUsage;
}

/** An OpenAI tool_call, as echoed back into the conversation. */
interface OpenAIToolCall {
	id: string;
	type: string;
	function: { name: string; arguments: string };
}

/** Token usage of an Anthropic response (prompt-cache fields included). */
interface AnthropicUsage {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
}

/** One SSE event of an Anthropic messages stream. */
interface AnthropicStreamEvent {
	type?: string;
	index?: number;
	message?: { usage?: AnthropicUsage };
	usage?: AnthropicUsage;
	content_block?: { type?: string; id?: string; name?: string };
	delta?: {
		type?: string;
		text?: string;
		thinking?: string;
		stop_reason?: string;
		partial_json?: string;
	};
}

/** A content block in a message's content array (Anthropic text / thinking /
 *  tool_use / tool_result) — one loose shape covering all readers here. */
interface ContentBlock {
	type?: string;
	text?: string;
	thinking?: string;
	/** tool_use blocks. */
	id?: string;
	name?: string;
	/** tool_use input — accumulated as a JSON string while streaming. */
	input?: string;
	/** tool_result blocks. */
	tool_use_id?: string;
	content?: unknown;
}

/** A tool_use extracted from an Anthropic stream, with its input parsed. */
interface AnthropicToolUse {
	id: string;
	name: string;
	input: Record<string, unknown>;
}

/** One wire message of the conversation array (both API formats). */
interface ConversationMessage {
	role: string;
	content?: string | ContentBlock[];
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
}

/** One tool schema in an OpenAI request body's `tools` array. */
interface OpenAIToolSchema {
	type: "function";
	function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** Name of the forced submit tool: final-answer rounds make the model call
 *  it with the user-facing body as the `answer` argument, so thinking and
 *  answer are separated at the protocol level (no per-language text
 *  heuristics). */
const SUBMIT_TOOL_NAME = "submit_answer";

const SUBMIT_TOOL_DESCRIPTION =
	"Submit the final answer for the user. The `answer` argument must contain " +
	"the complete, user-facing response — the actual content only. Never put " +
	"process narration (reading notes, gathering information, announcing the " +
	"answer) inside `answer`; any commentary belongs in regular text before " +
	"the call. In `sources`, list the vault paths of the notes you cited " +
	"inline, ordered by their assigned [n] numbers (context blocks, search " +
	"results' `n` fields, and opened-note headers all share the same " +
	"numbering). Never repeat or append that list inside the answer text — " +
	"the interface renders it from this argument.";

/** Live-forward threshold for tool-attached rounds: content growing past
 *  this size with NO tool-call delta yet is overwhelmingly the final answer
 *  (interim pre-tool text is short), so streaming starts — including the
 *  already-buffered prefix. Below the threshold the round stays buffered and
 *  the caller's end-of-round forward covers it. */
const ANSWER_LIVE_THRESHOLD = 200;

function submitAnswerParameters(): Record<string, unknown> {
	return {
		type: "object",
		properties: {
			answer: {
				type: "string",
				description: "The complete final answer shown to the user. Markdown allowed. No process narration.",
			},
			sources: {
				type: "array",
				items: { type: "string" },
				description: "Vault paths of the notes the answer actually drew on. Omit when the answer is not based on notes.",
			},
		},
		required: ["answer"],
	};
}

/** Incrementally decode a top-level string field out of PARTIAL JSON — used
 *  to live-stream the `answer` argument while the submit_answer tool call is
 *  still streaming (arguments arrive as input_json_delta / tool_calls deltas
 *  fragments). Returns null when the key has not started yet; stops decoding
 *  at the closing quote or at a truncated escape, whichever comes first. */
export function extractPartialJsonString(json: string, field: string): string | null {
	const key = `"${field}"`;
	const keyIdx = json.indexOf(key);
	if (keyIdx === -1) return null;
	let i = json.indexOf(":", keyIdx + key.length);
	if (i === -1) return null;
	i++;
	while (i < json.length && /\s/.test(json[i])) i++;
	if (json[i] !== '"') return null;
	i++;
	let out = "";
	const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
	while (i < json.length) {
		const ch = json[i];
		if (ch === "\\") {
			const esc = json[i + 1];
			if (esc === undefined) break; // truncated escape — wait for more
			if (esc === "u") {
				const hex = json.slice(i + 2, i + 6);
				if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) break; // incomplete \uXXXX
				out += String.fromCharCode(parseInt(hex, 16));
				i += 6;
				continue;
			}
			const decoded = simple[esc];
			if (decoded === undefined) break; // invalid escape — stop decoding
			out += decoded;
			i += 2;
			continue;
		}
		if (ch === '"') break; // closing quote — field complete
		out += ch;
		i++;
	}
	return out;
}

/** Request body of one OpenAI-compatible chat round (only the fields set here). */
interface OpenAIChatBody {
	model: string;
	messages: ConversationMessage[];
	stream: boolean;
	stream_options: { include_usage: boolean };
	tools?: OpenAIToolSchema[];
	tool_choice?: { type: "function"; function: { name: string } };
}

/** One tool schema in an Anthropic request body's `tools` array. */
interface AnthropicToolSchema {
	name: string;
	description: string;
	input_schema: Record<string, unknown>;
}

/** Request body of one Anthropic messages round (only the fields set here). */
interface AnthropicChatBody {
	model: string;
	max_tokens: number;
	system: string;
	messages: ConversationMessage[];
	stream: boolean;
	tools?: AnthropicToolSchema[];
	tool_choice?: { type: "tool"; name: string };
}

// Context usage types now live in types.ts (search-view imports them from
// here for back-compat — re-export so both paths keep working).
export type { ContextCategory, ContextBreakdown } from "./types";

/** Result of a chat turn: the final answer, the ordered thinking process, and
 *  the note paths whose content the model actually saw (initial context + tools). */
export interface ChatResult {
	answer: string;
	thinking: ThinkingStep[];
	usedNotes: string[];
	/** Notes actually opened via get_note/get_section this turn — a stronger
	 *  "used" signal than search hits, for the source cards. */
	readNotes: string[];
	/** Note paths the model declared in submit_answer's `sources` argument —
	 *  raw and unvalidated; the caller matches them against known paths. */
	declaredSources: string[];
	/** Per-turn citation registry: index n-1 is the path the model saw as [n]
	 *  (context blocks first, then tool-result hits and opened notes). The
	 *  answer's inline [n] markers reference exactly these entries. */
	citeRegistry: string[];
	/** Context tokens used by this turn (usage from the API, or an estimate). */
	contextTokens: number;
	/** Per-category context breakdown for the usage tooltip. */
	contextBreakdown: ContextBreakdown;
	/** Average cache hit rate across the requests of this turn, or null if the
	 *  provider reported no cache usage. */
	cacheHitRate: number | null;
}

export class ChatClient {
	private settings: SmartVaultSettings;
	private tools: SemlinkTools | null;
	/** Currently selected model, keyed `${providerId}/${modelId}` (null = use
	 *  the first model of the active provider). */
	private activeModelKey: string | null = null;
	/** Called after the active model changes, so the caller can persist it. */
	private onModelChange: (() => void) | null = null;
	/** Fired once per successfully completed chat request with the summed
	 *  token usage (Pro usage dashboard). Wired by main.ts to UsageStore. */
	onUsage: ((u: UsageSample) => void) | null = null;

	constructor(settings: SmartVaultSettings, tools: SemlinkTools | null = null) {
		this.settings = settings;
		this.tools = tools;
		this.syncPersistedModel();
	}

	updateSettings(settings: SmartVaultSettings) {
		this.settings = settings;
		this.syncPersistedModel();
	}

	/** Restore the persisted active model (settings.activeChatModel) when it
	 *  still resolves; otherwise fall back to the first-model default. */
	private syncPersistedModel(): void {
		const key = this.settings.activeChatModel;
		if (!key) {
			this.activeModelKey = null;
			return;
		}
		const sep = key.indexOf("/");
		const pid = key.slice(0, sep);
		const mid = key.slice(sep + 1);
		const provider = this.allChatProviders().find((p) => p.id === pid);
		if (provider && provider.models.some((m) => m.id === mid)) {
			this.activeModelKey = key;
		} else {
			this.activeModelKey = null;
		}
	}

	/** Wire a callback that runs after the active model changes (used by the
	 *  plugin to persist settings.activeChatModel). */
	setModelChangeHandler(handler: () => void): void {
		this.onModelChange = handler;
	}

	/**
	 * Every source of chat models: the unified provider list, filtered to the
	 * models tagged "chat" (or untagged — old entries default to chat).
	 * Bridged to the ChatProvider shape (no writes back to the settings).
	 */
	private allChatProviders(): ChatProvider[] {
		return (this.settings.providers || [])
			.map((p) => ({
				id: p.id,
				name: p.name || p.id,
				baseUrl: p.apiBase,
				apiKey: p.apiKey,
				apiFormat: p.apiFormat ?? "openai",
				wirePath: p.wirePath,
				models: p.models.filter((m) => (m.kind ?? "chat") === "chat" && m.enabled === true),
			}))
			.filter((p) => p.apiKey && p.apiKey.trim() !== "" && p.baseUrl && p.baseUrl.trim() !== "")
			.filter((p) => p.models.length > 0);
	}

	/**
	 * Return the first configured chat provider (non-empty apiKey and baseUrl),
	 * or null if none is usable.
	 */
	getActiveProvider(): ChatProvider | null {
		const providers = this.allChatProviders();
		return providers.find(
			(p) => p.apiKey && p.apiKey.trim() !== "" && p.baseUrl && p.baseUrl.trim() !== "",
		) || null;
	}

	/** Whether a chat provider is available for answering. */
	isConfigured(): boolean {
		return this.getActiveProvider() !== null;
	}

	/** Resolve the active model (and its owning provider). Falls back to the
	 *  first model of the active provider when nothing is selected / the
	 *  selection became invalid (e.g. provider removed in settings). */
	getActiveModel(): { provider: ChatProvider; model: ChatModel } | null {
		const providers = this.allChatProviders();
		if (this.activeModelKey) {
			const sep = this.activeModelKey.indexOf("/");
			const pid = this.activeModelKey.slice(0, sep);
			const mid = this.activeModelKey.slice(sep + 1);
			const provider = providers.find(
				(p) => p.id === pid && p.apiKey && p.apiKey.trim() !== "" && p.baseUrl && p.baseUrl.trim() !== "",
			);
			const model = provider?.models.find((m) => m.id === mid);
			if (provider && model) return { provider, model };
		}
		const provider = this.getActiveProvider();
		if (!provider || !provider.models || provider.models.length === 0) {
			return null;
		}
		return { provider, model: provider.models[0] };
	}

	/** Switch the active chat model (must exist in the given provider). Also
	 *  records it in settings and notifies the persist callback. */
	setActiveModel(providerId: string, modelId: string): boolean {
		const providers = this.allChatProviders();
		const provider = providers.find((p) => p.id === providerId);
		if (!provider || !provider.models.some((m) => m.id === modelId)) {
			return false;
		}
		this.activeModelKey = `${providerId}/${modelId}`;
		this.settings.activeChatModel = this.activeModelKey;
		this.onModelChange?.();
		return true;
	}

	/** Providers + their models for the model-switcher dropdown. */
	getModelOptions(): Array<{ providerId: string; providerName: string; models: ChatModel[] }> {
		return this.allChatProviders()
			.filter((p) => p.models && p.models.length > 0)
			.map((p) => ({ providerId: p.id, providerName: p.name || p.id, models: p.models }));
	}

	/** Model label for the input indicator, e.g. "DeepSeek/deepseek-v4-flash". */
	getActiveModelLabel(): string | null {
		const active = this.getActiveModel();
		if (!active) return null;
		return `${active.provider.name || active.provider.id}/${active.model.id}`;
	}

	/** Context window (tokens) of the active chat model, or null if unknown. */
	getActiveContextWindow(): number | null {
		return this.getActiveModel()?.model.contextWindow ?? null;
	}

	/** Two agent styles — they share the tool guidance but differ in how
	 *  aggressively the model reads notes:
	 *  - "classic": conservative — answer from the snippets unless clearly
	 *    insufficient, minimal tool use.
	 *  - "proactive": verify-first — treat referenced docs as reading
	 *    signals, actively read related notes before answering (default). */
	private buildSystemPrompt(agentMode: AgentMode, depthHint: string, context: string): string {
		const shared =
			t("promptGrepGuide") +
			t("promptToolGuide") +
			depthHint +
			t("promptNoFabricate") +
			"\n" + t("promptGrounding") +
			"\n\n" + t("promptContextHead") + "\n" + context +
			"\n\n" + t("promptLangRule");
		
		if (agentMode === "classic") {
			return (
				t("promptRoleClassic") +
				t("promptRoleClassicNote") +
				shared
			);
		}
		return (
			t("promptRoleProactive") +
			t("promptRoleProactiveNote") +
			t("promptIntroPattern") +
			shared
		);
	}

	/**
	 * Ask the active chat model to answer `question` given the retrieved note
	 * context. The model may call Semlink tools to gather more information.
	 * `onToolCall` is invoked (with tool name and args) before each tool runs,
	 * so the UI can show progress. `depth` controls how aggressively the model
	 * reads notes: "standard" prefers get_section with a smaller result cap,
	 * "enhanced" allows full get_note reads with a larger cap. `onStream` is
	 * called with the growing answer text as the model streams it.
	 * `onRoundStart` fires whenever the model begins generating a round (a
	 * potential tool round or the final answer) — the UI can show a generic
	 * "generating" state instead of freezing on the previous tool's name.
	 * `onThinking` fires with each new thinking step (thought / tool call) as
	 * it is recorded, so the UI can preview the thinking process live while
	 * the answer is still being generated.
	 * `onRetry` fires before each retry of a transient failure (network /
	 * rate limit / provider busy), so the UI can show ZCode-style progress
	 * like "重新连接中... 2/10".
	 */
	async chat(
		context: string,
		question: string,
		/** Prior turns of the current session, sent as a native message array
		 *  (ZCode-style, NOT text-glued into the question): the prefix stays
		 *  stable across requests → prompt-cache hits stay high. Truncated by
		 *  a sliding window when the estimate exceeds the context threshold. */
		history: HistoryMessage[] = [],
		onToolCall?: (toolName: string, args: unknown) => void,
		depth: "standard" | "enhanced" = "standard",
		onStream?: (text: string) => void,
		onRoundStart?: () => void,
		onThinking?: (step: ThinkingStep) => void,
		onRetry?: (attempt: number, total: number) => void,
		signal?: AbortSignal,
		agentMode: AgentMode = "proactive",
		/** Initial retrieval results' paths in context-block order — seeds the
		 *  per-turn citation registry so context block [n] = registry [n] and
		 *  tool results continue from N+1. ONE numbering space for thinking,
		 *  the final answer, and the rendered source cards. */
		contextNotePaths: string[] = [],
	): Promise<ChatResult> {
		// Use the SELECTED model (and its owning provider) — the model switcher
		// may pick any model from any configured provider.
		const active = this.getActiveModel();
		if (!active) throw new Error("No chat provider configured");
		const { provider, model } = active;
		const contextWindow = model.contextWindow || 0;
		const depthHint = depth === "enhanced" ? t("promptDepthEnhanced") : t("promptDepthStandard");
		const systemPrompt = this.buildSystemPrompt(agentMode, depthHint, context);

		// Per-depth cap on a single tool result (enhanced reads full notes).
		// Plus: inject this turn's citation numberer — search results carry
		// their global [n], opened notes announce theirs.
		const citeReg = createCiteRegistry();
		const citeRegistry = citeReg.paths;
		for (const p of contextNotePaths) citeReg.register(p);
		if (this.tools) {
			this.tools.maxResultChars = depth === "enhanced" ? 8000 : 4000;
			this.tools.citeNumberer = citeReg.register;
		}

		const thinking: ThinkingStep[] = [];
		const usedNotes: string[] = [];
		// Notes actually OPENED via get_note/get_section — a stronger "used"
		// signal than search hits, exposed separately for source cards.
		const readNotes: string[] = [];

		// Native message array: system + history (verbatim) + the current
		// question. History is truncated early (sliding window) so the prompt
		// never crosses the context threshold — same management as ZCode.
		const conversation = this.buildConversation(history, question);
		this.truncateConversation(conversation, systemPrompt, contextWindow);

		// Retry design mirrors ZCode's model-call retry: up to
		// CHAT_RETRY_TOTAL attempts per connection-drop episode, attempt N
		// (N≥2) waiting CHAT_RETRY_DELAYS_MS[N-2]. The count RESETS whenever a
		// request succeeds (the connection recovered — a fresh failure is a
		// new episode, shown again as "2/10"), with a total-attempt backstop
		// so a flaky connection cannot retry forever.
		let attempt = 1;
		let totalAttempts = 0;
		const onRoundSuccess = (): void => {
			attempt = 1; // connection is back — recount from scratch
		};
		const dispatch = (): Promise<ChatResult> =>
			provider.apiFormat === "anthropic"
				? this.chatAnthropic(provider, model.id, contextWindow, systemPrompt, conversation, onToolCall, thinking, usedNotes, citeRegistry, onStream, onRoundStart, onThinking, onRoundSuccess, signal)
				: this.chatOpenAI(provider, model.id, contextWindow, systemPrompt, conversation, onToolCall, thinking, usedNotes, citeRegistry, onStream, onRoundStart, onThinking, onRoundSuccess, signal);

		for (;;) {
			totalAttempts++;
			try {
				return await dispatch();
			} catch (e) {
				// User aborted — never retry, propagate the AbortError as-is.
				if (signal?.aborted || (e as Error)?.name === "AbortError") throw e;
				const retryDelayMs = CHAT_RETRY_DELAYS_MS[attempt - 1];
				if (retryDelayMs === undefined || totalAttempts > CHAT_RETRY_TOTAL + 5 || !this.isTransientChatError(e)) {
					throw e;
				}
				const msg = String((e as Error)?.message || e || "");
				console.warn(`[Semlink] transient error (attempt ${attempt}), retrying in ${retryDelayMs}ms:`, msg);
				onRetry?.(attempt + 1, CHAT_RETRY_TOTAL);
				await new Promise((resolve) => window.setTimeout(resolve, retryDelayMs));
				if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
				attempt++;
			}
		}
	}

	/** ZCode-style retryable check: only transient failures get retried. */
	private isTransientChatError(e: unknown): boolean {
		if (e instanceof TypeError) return true;
		const msg = String((e as Error)?.message || (e as string) || "");
		if (/NETWORK:|failed to fetch/i.test(msg)) return true;
		const status = (e as { status?: number } | null)?.status;
		return status === 429 || status === 503 || /busy|rate ?limit/i.test(msg);
	}

	// ──── Conversation assembly (ZCode-style history) ────

	/**
	 * Build the conversation array: prior turns as native role messages
	 * (NOT text-glued into the question), then the current question. User
	 * messages with segments (dropped-note chips) are re-expanded to
	 * `[[path]]` links so the model still sees the attached files.
	 */
	private buildConversation(history: HistoryMessage[], question: string): ConversationMessage[] {
		const conv: ConversationMessage[] = [];
		for (const h of history) {
			if (h.role === "user" && h.segments && h.segments.length > 0) {
				const text = h.segments
					.map((s) => (s.type === "file" ? `[[${s.value}]]` : s.value))
					.join("");
				conv.push({ role: "user", content: text || h.content });
			} else {
				conv.push({ role: h.role, content: h.content || "" });
			}
		}
		conv.push({ role: "user", content: question });
		return conv;
	}

	/**
	 * ZCode-style context management: estimate the total token count and drop
	 * the OLDEST messages (sliding window) while it exceeds the threshold
	 * (effective window × 95%, with an output reserve like ZCode's). The
	 * latest question is never dropped. Runs before the first request, so the
	 * prompt prefix stays identical across a turn's tool rounds.
	 */
	private truncateConversation(conv: ConversationMessage[], systemPrompt: string, contextWindow: number): void {
		if (contextWindow <= 0) return;
		// Reserve headroom for the answer (≈ ZCode's output reserve; ~15% of
		// the window, clamped), then trigger at 95% of the effective window.
		const outputReserve = Math.min(32000, Math.max(8000, Math.round(contextWindow * 0.15)));
		const threshold = Math.round((contextWindow - outputReserve) * 0.95);
		const baseTokens = this.estimateTextTokens(systemPrompt) + 512; // tool schemas + overhead
		const per = conv.map((m) => this.estimateMessageTokens(m));
		let total = baseTokens + per.reduce((a, b) => a + b, 0);
		let drop = 0;
		// Keep at least the final question (conv.length - 1).
		while (drop < conv.length - 1 && total > threshold) {
			total -= per[drop];
			drop++;
		}
		if (drop > 0) {
			conv.splice(0, drop);
			debugLog(`[Semlink] 历史上下文截断：丢弃最早 ${drop} 条消息（约 ${total} tokens / 阈值 ${threshold}）`);
		}
	}

	/** Estimate one message's tokens (string content or content blocks). */
	private estimateMessageTokens(m: ConversationMessage): number {
		const c = m?.content;
		let n = 0;
		if (typeof c === "string") {
			n = this.estimateTextTokens(c);
		} else if (Array.isArray(c)) {
			for (const b of c) {
				if (!b) continue;
				if (b.type === "text") n += this.estimateTextTokens(b.text || "");
				else if (b.type === "thinking") n += this.estimateTextTokens(b.thinking || "");
				else if (b.type === "tool_use") n += this.estimateTextTokens(JSON.stringify(b.input || ""));
				else if (b.type === "tool_result") n += this.estimateTextTokens(typeof b.content === "string" ? b.content : JSON.stringify(b.content || ""));
			}
		}
		return n + 4; // role + per-message overhead
	}

	// ──── OpenAI format (streaming) ────

	/** Primary free-text argument of a query-bearing tool (for dedup). */
	private primaryQueryArg(name: string, args: Record<string, unknown>): string {
		if (name === "search_notes" || name === "get_similar_notes" || name === "search" || name === "search_bm25" || name === "search_vector" || name === "keyword" || name === "semantic") return String((args?.query as string) ?? "");
		if (name === "grep_notes" || name === "grep") return String((args?.pattern as string) ?? "");
		return "";
	}

	/**
	 * Near-duplicate detection: the model rephrases the same query (e.g.
	 * "智能船载终端研发" → "船载终端研发") instead of finalizing. One query
	 * being a substring of a previous query (same tool) means it's repeating
	 * itself — force an answer instead of re-running the tool.
	 */
	private isNearDuplicateQuery(name: string, args: Record<string, unknown>, seenQueries: Map<string, string[]>): boolean {
		const q = this.primaryQueryArg(name, args).toLowerCase().replace(/\s+/g, " ").trim();
		if (q.length < 4) return false;
		const prev = seenQueries.get(name);
		if (!prev) return false;
		return prev.some((p) => q.includes(p) || p.includes(q));
	}

	/**
	 * Drop thought steps that essentially duplicate the final answer. Models
	 * sometimes write the full answer as interim text in a tool round (and
	 * still attach a tool call), then repeat it as the real answer — or the
	 * loop ends with that interim text as `lastText`. Either way the whole
	 * answer would show twice: once under 💭 and once as the answer body.
	 * Comparison is whitespace-collapsed character-bigram Dice similarity,
	 * which is robust for CJK text; tool steps are never touched.
	 */
	private dedupeAnswerThoughts(thinking: ThinkingStep[], answer: string): ThinkingStep[] {
		const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, "");
		const target = norm(answer);
		// Short answers can't meaningfully duplicate a thought — and the UI
		// promotes a long thought INTO a short answer, so keep candidates.
		if (target.length < 80) return thinking;
		const bigrams = (s: string): Map<string, number> => {
			const m = new Map<string, number>();
			for (let i = 0; i < s.length - 1; i++) {
				const g = s.slice(i, i + 2);
				m.set(g, (m.get(g) || 0) + 1);
			}
			return m;
		};
		const targetGrams = bigrams(target);
		let targetTotal = 0;
		for (const n of targetGrams.values()) targetTotal += n;
		const dice = (s: string): number => {
			const grams = bigrams(s);
			let total = targetTotal;
			let inter = 0;
			for (const [g, n] of grams) {
				total += n;
				inter += Math.min(targetGrams.get(g) || 0, n);
			}
			return total === 0 ? 0 : (2 * inter) / total;
		};
		return thinking.filter((s, idx) => {
			if (s.type !== "thought") return true;
			// The FIRST thought is the pre-analysis — the model's reasoning
			// record, and the core of the transparent-thinking promise. It
			// often drafts the same facts as the answer (the snippets were
			// enough), but it must stay in the card even then. Only later
			// thoughts — mid-flow answer dumps written alongside a tool call
			// — are treated as duplication.
			if (idx === 0) return true;
			const t = norm(s.text);
			// Tiny stage-direction thoughts ("（读取笔记中）") always stay.
			if (t.length < 40) return true;
			return dice(t) < 0.5;
		});
	}

	/**
	 * Strip robotic process-narration lead-ins some models prepend to the
	 * final answer: self-referential openers ("我已经获取到足够的信息，现在
	 * 给出完整的介绍。") AND post-tool reflections ("这段笔记补充了预制表盘
	 * 和产品概述…。片段[4]也列出了多个表盘。我将结合这两处信息来给出完整
	 * 回答。") — models often narrate what the just-read note contributed
	 * before starting the actual answer. That narration belongs in the
	 * thinking card. Only whole LEADING sentences are removed (max 4); a
	 * sentence carrying real content is never eaten, and if stripping would
	 * leave almost nothing behind, the original text is returned untouched.
	 */
	private stripAnswerPreamble(answer: string): string {
		const original = answer.trim();
		let text = original;
		for (let i = 0; i < 4; i++) {
			// Sentence terminators include "：" — announcements like
			// "……表盘信息如下：" are their own lead-in sentence.
			const m = text.match(/^[^。！？!?.：:]*[。！？!?.：:]/);
			if (!m) break;
			if (!this.isProcessPreamble(m[0])) break;
			text = text.slice(m[0].length).trim();
		}
		// Ate too much? A real answer is more than a couple of fragments.
		if (text.length < 40 && original.length >= 40) return original;
		// May be "" when the WHOLE answer was a preamble shell — finalize
		// decides whether a thought can stand in (see hasPromotableThought).
		return text;
	}

	/** A thought substantial enough to stand in for a shell-only answer
	 * ("基于笔记内容，以下是……完整介绍。" with the real content written
	 * into the model's pre-analysis). */
	private hasPromotableThought(thinking: ThinkingStep[]): boolean {
		return thinking.some((s) => s.type === "thought" && s.text.trim().length >= 80);
	}

	/** Extract the user-facing answer and declared sources from a
	 * submit_answer call's arguments. Preferred: full JSON.parse. Fallbacks
	 * for the answer: the incremental extractor (tolerates broken JSON
	 * around the field), then the round's plain text content (model ignored
	 * the tool body entirely). Sources ride along only when the JSON parses. */
	private parseSubmittedAnswer(argsJson: string, fallbackContent: string): { answer: string; sources: string[] } {
		try {
			const parsed = JSON.parse(argsJson) as { answer?: unknown; sources?: unknown };
			const answer = typeof parsed.answer === "string" ? parsed.answer : "";
			const sources = Array.isArray(parsed.sources)
				? parsed.sources.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
				: [];
			if (parsed.answer !== undefined || sources.length > 0) return { answer, sources };
		} catch { /* fall through to partial extraction */ }
		const partial = extractPartialJsonString(argsJson, "answer");
		if (partial && partial.trim()) return { answer: partial, sources: [] };
		return { answer: fallbackContent.trim(), sources: [] };
	}

	/** A sentence counts as process narration when it is a post-tool
	 * reflection (sources named as the actor of an informational verb, or
	 * the writer announcing the answer), or when EVERY comma clause opens
	 * with a self-reference or discourse filler AND names the gather/answer
	 * act. Length caps keep dense real answers (markdown, long first
	 * sentences) out of the stripper. */
	private isProcessPreamble(sentence: string): boolean {
		const s = sentence.trim();
		if (!s || s.length > 80) return false;
		if (this.isToolReflection(s)) return true;
		const clauses = s.split(/[，,；;、]/).map((c) => c.trim()).filter(Boolean);
		if (clauses.length === 0 || clauses.length > 4) return false;
		const filler = /^(好的|当然|没问题|明白了|收到|嗯|那么|现在|接下来|下面|我|我们|已|已经|根据|基于|综合|sure|of course|certainly|okay|ok|alright|got it|now|so|well|i|we|based on|according to)/i;
		const act = /(获取|收集|检索|查阅|读取|掌握|整理|汇总|分析|给出|提供|介绍|回答|总结|呈现|梳理|gather|collect|retriev|found|read|review|analyz|present|provid|introduc|answer|summar)/i;
		const pureFiller = /^(好的|当然|没问题|明白了|收到|嗯|sure|of course|certainly|okay|ok|alright|got it)[。！？!?.：:]*$/i;
		return clauses.every((c) => filler.test(c) && (act.test(c) || pureFiller.test(c)));
	}

	/** Post-tool reflection: the just-read source talks about itself
	 * ("这段笔记补充了…", "片段[4]也列出了…"), the writer announces how they
	 * will answer ("我将结合这两处信息来给出完整回答"), or the answer is
	 * announced ("以下是完整的表盘清单："). The (?!的) lookahead excludes
	 * relative-clause usage ("片段[4]列出的水深仪表…" — content citing
	 * evidence), so only process narration matches. */
	private isToolReflection(s: string): boolean {
		// Chinese: source as actor of an informational verb.
		if (/(片段\[\d+\]|这段?笔记|该笔记|这份?笔记|这段?文档|笔记内容|初始片段|这些?信息|两处信息|以上信息|上述信息|该文档)/.test(s)
			&& /(补充|列出|提到|描述|给出|说明|提供|读取|查阅|结合|综合)(?!的)/.test(s)) return true;
		// Chinese: announcing the combined answer.
		if (/(我)?将?(结合|综合|根据|基于)[^。？！]{0,20}(片段|笔记|信息|资料|内容)[^。？！]{0,30}(给出|提供|回答|整理|总结|梳理)/.test(s)) return true;
		// Chinese: "综合初始片段和笔记内容，……如下" / "以下是完整的清单".
		if (/(综合|结合)[^。？！]{0,25}(片段|笔记|信息|资料|内容)[^。？！]{0,30}如下/.test(s)) return true;
		if (/(以下(是|为)|下面(是|为))[^。？！]{0,25}(回答|介绍|总结|清单|列表|说明)/.test(s)) return true;
		if (/(已经?|已)[^。？！]{0,4}(读取|获取|查阅|读完|看完)[^。？！]{0,20}(笔记|文档|信息|资料|内容)/.test(s)) return true;
		// English equivalents, anchored near the sentence start so content
		// that merely cites a snippet ("The gauge listed in snippet [4]…")
		// never matches.
		if (/^[^.?!]{0,20}\b(note|document|snippet|section)s?(\s*\[\d+\])?(\s+(also|just))?\s+(adds?|lists?|mentions?|describes?|provides?|confirms?|covers?)\b/i.test(s)) return true;
		if (/\b(i'll|i will|i've|i have)\s+(now\s+)?(combine|combined|based|using|drawn|draw)\b[^.?!]{0,40}\b(answer|respond|present|summariz|write|give)\b/i.test(s)) return true;
		if (/^here (is|'s) (the|my) (complete |full |detailed |short )?(answer|introduction|summary|list|overview)/i.test(s)) return true;
		if (/^(based on|according to) (the |my )?(initial |retrieved |above |collected )?(snippets?|notes?|sources?|results?|research)\b/i.test(s)) return true;
		return false;
	}

	/**
	 * Parse text-style tool calls some models emit as plain markup instead of
	 * using the structured function-calling protocol — e.g.
	 * `<invoke name="get_section"><parameter name="heading">X</parameter>
	 * </invoke>` or `<tool_call>{"name":"...","arguments":{...}}</tool_call>`.
	 * Returns the parsed calls and the text with all tool markup removed
	 * (non-parameter prose inside `<invoke>` blocks is preserved).
	 */
	private extractTextToolCalls(text: string): { calls: Array<{ name: string; args: Record<string, unknown> }>; cleanText: string } {
		const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
		let clean = text;

		// Format 1: <invoke name="tool"><parameter name="k">v</parameter>...</invoke>
		clean = clean.replace(/<invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/invoke>/gi, (_whole, name: string, inner: string) => {
			const args: Record<string, unknown> = {};
			let leftover = "";
			let idx = 0;
			let m: RegExpExecArray | null;
			const paramRe = /<parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/parameter>/gi;
			while ((m = paramRe.exec(inner)) !== null) {
				leftover += inner.slice(idx, m.index);
				idx = m.index + m[0].length;
				args[m[1].trim()] = m[2].trim();
			}
			leftover += inner.slice(idx);
			calls.push({ name: name.trim(), args });
			return leftover.trim();
		});

		// Format 2: <tool_call>{"name":"...","arguments":{...}}</tool_call>
		clean = clean.replace(/<tool_call[^>]*>([\s\S]*?)<\/tool_call>/gi, (_whole, inner: string) => {
			try {
				const parsed = JSON.parse(inner.trim()) as { name?: string; arguments?: Record<string, unknown>; input?: Record<string, unknown> };
				if (parsed?.name) {
					calls.push({ name: String(parsed.name), args: parsed.arguments || parsed.input || {} });
				}
			} catch {
				// unparseable — drop the markup
			}
			return "";
		});

		// Format 3: <tool_calls>...</tool_calls> wrapper around invoke blocks
		// (the invoke regex above already consumed the inner blocks).
		clean = clean.replace(/<tool_calls[^>]*>([\s\S]*?)<\/tool_calls>/gi, (_whole, inner: string) => inner.trim());

		return { calls, cleanText: clean.trim() };
	}

	private async chatOpenAI(
		provider: ChatProvider,
		model: string,
		contextWindow: number,
		systemPrompt: string,
		conversation: ConversationMessage[],
		onToolCall?: (toolName: string, args: unknown) => void,
		thinking: ThinkingStep[] = [],
		usedNotes: string[] = [],
		citeRegistry: string[] = [],
		onStream?: (text: string) => void,
		onRoundStart?: () => void,
		onThinking?: (step: ThinkingStep) => void,
		onRoundSuccess?: () => void,
		signal?: AbortSignal,
	): Promise<ChatResult> {
		const baseUrl = provider.baseUrl.replace(/\/+$/, "");
		const openaiUrl = chatEndpoint(baseUrl, provider.wirePath, "/v1/chat/completions");
		const tools = this.buildOpenAITools();

		const messages: ConversationMessage[] = [
			{ role: "system", content: systemPrompt },
			...conversation,
		];

		// Latest assistant text (used as a graceful fallback if the model keeps
		// calling tools without ever producing a final answer).
		let lastText = "";
		// Guard against the model repeating the exact same tool call in a loop.
		const seenCalls = new Set<string>();
		// Normalized queries per tool, to catch near-duplicate rephrasing.
		const seenQueries = new Map<string, string[]>();
		// Set when the model repeats itself — tools are removed from the next
		// round so it must produce a real answer (not loop or echo a thought).
		let forceAnswer = false;
		// Set when a provider rejects the forced submit_answer tool_choice —
		// remaining rounds degrade to the legacy plain-text answer path.
		let submitDisabled = false;
		// Notes actually OPENED via get_note/get_section this turn — a
		// stronger "used" signal than search hits, for the source cards.
		const readNotes: string[] = [];
		// Context tokens reported by the API for the latest request.
		let usageTokens = 0;
		// Token usage summed across ALL rounds (usage dashboard). usageTokens
		// above is a MAX for the context ring; these are true sums.
		let usageIn = 0;
		let usageOut = 0;
		// Per-request cache hit ratios (e.g. DeepSeek prompt caching).
		const cacheHits: CacheSample[] = [];

		const finalize = (rawAnswer: string, declaredSources?: string[]): ChatResult => {
			// Strip the robotic process lead-in BEFORE anything else — dedupe
			// compares against the cleaned text. A shell-only answer (nothing
			// but an intro line) strips to "": pass the emptiness through when
			// a substantial thought exists so the UI promotes that thought
			// (the model wrote the real content into its analysis); without
			// one, keep the shell — an empty answer helps nobody.
			const answer = this.stripAnswerPreamble(rawAnswer)
				|| (this.hasPromotableThought(thinking) ? "" : rawAnswer.trim());
			if (usageIn > 0 || usageOut > 0) {
				try { this.onUsage?.({ model, promptTokens: usageIn, completionTokens: usageOut }); } catch { /* never break chat */ }
			}
			const cacheHitRate = cacheHits.length
				? cacheHits.reduce((a, s) => a + s.hit, 0) / cacheHits.reduce((a, s) => a + s.total, 0)
				: null;
			// Breakdown is the single source of truth for the total: when the
			// API reports usage, `used` is real and `other` absorbs the gap;
			// otherwise `used` = sum of the categories (percentages = 100%).
			const breakdown = this.computeBreakdown(usageTokens, contextWindow, systemPrompt, tools, messages);
			return {
				answer,
				thinking: this.dedupeAnswerThoughts(thinking, answer),
				usedNotes,
				// Notes actually opened via get_note/get_section this turn.
				readNotes,
				// Sources the model declared in submit_answer — transported
				// raw; the caller validates them against known paths.
				declaredSources: declaredSources ?? [],
				citeRegistry,
				contextTokens: breakdown.used,
				contextBreakdown: breakdown,
				cacheHitRate,
			};
		};

		// Pre-analysis round: no tools available yet, so the model MUST write
		// its reasoning out — that text becomes the visible "初步结论" thinking
		// step BEFORE any tool call (many OpenAI-format models otherwise skip
		// visible reasoning and jump straight to tool_calls). The conclusion is
		// kept in the conversation so later tool decisions build on it.
		messages.push({
			role: "user",
			content: t("promptAnalysis"),
		});
		let analysis: string | undefined;
		try {
			const analysisStream = await this.streamOpenAIChat(
				openaiUrl,
				provider,
				{ model, messages, stream: true, stream_options: { include_usage: true } },
				undefined,
				signal,
			);
			onRoundSuccess?.();
			if (analysisStream.usageTokens) usageTokens = Math.max(usageTokens, analysisStream.usageTokens);
			usageIn += analysisStream.roundIn || 0;
			usageOut += analysisStream.roundOut || 0;
			cacheHits.push(...analysisStream.cacheHits);
			analysis = analysisStream.content?.trim();
			// Strip any echoed instruction labels (e.g. "（分析阶段）初步结论：").
			if (analysis) {
				analysis = analysis
					.replace(/^(（分析阶段）|\(Analysis phase\))\s*/i, "")
					.replace(/^初步结论[:：]\s*/i, "");
			}
		} catch (e) {
			// The analysis round must never kill the answer — drop it and run
			// the normal loop without a visible conclusion step.
			console.warn("[Semlink] pre-analysis failed, skipping:", e);
			messages.pop();
		}
		if (analysis) {
			const step: ThinkingStep = { type: "thought", text: analysis };
			thinking.push(step);
			onThinking?.(step);
			messages.push({ role: "assistant", content: analysis });
		}
		// Hand over to the answer phase: the analysis often ends with "I need
		// to read more notes" — without this nudge the model tends to answer
		// anyway (without the tools) instead of acting on its own plan.
		if (analysis) {
			messages.push({
				role: "user",
				content: t("promptAnswerPhase"),
			});
		}

		for (let round = 0; round < MAX_TOOL_ITERATIONS; round++) {
			// The model is generating this round (tool decision or final
			// answer) — let the UI show a generic "generating" state.
			onRoundStart?.();
			// If we're deep into tool rounds — or the model started repeating
			// itself — nudge it to wrap up AND remove the tools so it cannot
			// call more; it must answer with what it has.
			if (round === NUDGE_AFTER_ROUND || forceAnswer) {
				messages.push({ role: "user", content: t("searchAnswerNowHint") });
			}

			const body: OpenAIChatBody = {
				model,
				messages,
				stream: true,
				stream_options: { include_usage: true },
			};
			// Final rounds FORCE the submit_answer tool: thinking and answer
			// are separated at the protocol level, in every language — interim
			// text becomes a 💭 thought, and the user-facing body arrives as
			// the `answer` argument (streamed live out of the partial JSON).
			// If a provider rejects the forced tool_choice, the round degrades
			// to the legacy plain-text path for the rest of the turn.
			const submitRound = !submitDisabled && tools.length > 0 && (forceAnswer || round >= NUDGE_AFTER_ROUND);
			if (submitRound) {
				body.tools = [{
					type: "function",
					function: { name: SUBMIT_TOOL_NAME, description: SUBMIT_TOOL_DESCRIPTION, parameters: submitAnswerParameters() },
				}];
				body.tool_choice = { type: "function", function: { name: SUBMIT_TOOL_NAME } };
			} else if (tools.length > 0) {
				body.tools = tools;
			}

			// Stream this round. Regular tool rounds stay buffered — their
			// interim text becomes thinking steps (streaming it live would
			// flash text that then "vanishes" into 💭). Submit rounds and
			// plain no-tool rounds stream live: what arrives is answer body.
			let stream;
			try {
				// onStream is passed for EVERY round — streamOpenAIChat gates
				// forwarding internally (submit-arg partials, live threshold,
				// end-of-round one-shot).
				stream = await this.streamOpenAIChat(
					openaiUrl,
					provider,
					body,
					onStream,
					signal,
				);
			} catch (e) {
				if (!submitRound || signal?.aborted || (e as Error)?.name === "AbortError") throw e;
				// Provider rejected the forced submit tool — degrade this turn
				// to the legacy plain-text answer and retry the round once.
				submitDisabled = true;
				console.warn("[Semlink] submit_answer rejected, degrading to plain text:", e);
				stream = await this.streamOpenAIChat(
					openaiUrl,
					provider,
					{ ...body, tools: undefined, tool_choice: undefined },
					onStream,
					signal,
				);
			}
			onRoundSuccess?.();
			if (stream.usageTokens) usageTokens = Math.max(usageTokens, stream.usageTokens);
			usageIn += stream.roundIn || 0;
			usageOut += stream.roundOut || 0;
			cacheHits.push(...stream.cacheHits);
			if (stream.content) lastText = stream.content;

			// Forced submit call: the answer arrives as the tool call's
			// `answer` argument. Deltas were streamed live out of the partial
			// JSON; this final parse is authoritative.
			const submitCall = stream.toolCalls.find((tc) => tc?.function?.name === SUBMIT_TOOL_NAME);
			if (submitCall) {
				const submitted = this.parseSubmittedAnswer(submitCall.function.arguments || "", stream.content);
				onStream?.(submitted.answer);
				return finalize(submitted.answer, submitted.sources);
			}

			if (stream.toolCalls.length === 0) {
				// Final round — answer was already streamed live above.
				return finalize(stream.content.trim() || lastText.trim());
			}

			// Interim text the model produced while deciding to call tools.
			if (stream.content?.trim()) {
				const step: ThinkingStep = { type: "thought", text: stream.content.trim() };
				thinking.push(step);
				onThinking?.(step);
			}

			// Echo the assistant message (with its tool_calls) back verbatim.
			messages.push({ role: "assistant", content: stream.content || "", tool_calls: stream.toolCalls });

			for (const tc of stream.toolCalls) {
				const name = tc?.function?.name;
				const rawArgs = tc?.function?.arguments || "{}";

				// Model self-submitted the answer in a regular tool round —
				// accept it as final instead of executing a bogus tool.
				if (name === SUBMIT_TOOL_NAME) {
					const submitted = this.parseSubmittedAnswer(rawArgs, stream.content);
					onStream?.(submitted.answer);
					return finalize(submitted.answer, submitted.sources);
				}

				let args: Record<string, unknown> = {};
				try {
					args = JSON.parse(rawArgs) as Record<string, unknown>;
				} catch {
					args = { _error: `invalid JSON arguments: ${rawArgs}` };
				}

				// Repeated call (exact or rephrased query): don't re-execute and
				// don't echo a thought as the answer — flag a forced answer so
				// the next round has no tools and the model answers for real.
				const callKey = `${name}|${JSON.stringify(args)}`;
				if (seenCalls.has(callKey) || this.isNearDuplicateQuery(name, args, seenQueries)) {
					forceAnswer = true;
					messages.push({
						role: "tool",
						tool_call_id: tc.id || `call_${round}_${stream.toolCalls.indexOf(tc)}`,
						content: t("promptRepeatSkip"),
					});
					continue;
				}
				seenCalls.add(callKey);
				const normQ = this.primaryQueryArg(name, args).toLowerCase().replace(/\s+/g, " ").trim();
				if (normQ.length >= 4) {
					seenQueries.set(name, [...(seenQueries.get(name) || []), normQ]);
				}

				// User hit stop — bail out before running (possibly slow) tools.
				if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
				onToolCall?.(name, args);
				const result = this.tools
					? await this.tools.execute(name, args)
					: `Error: no tools available (unknown tool "${name}")`;
				if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
				const step: ThinkingStep = { type: "tool", name, args, result };
				thinking.push(step);
				onThinking?.(step);
				this.collectUsedNotes(usedNotes, name, args, result);
				if ((name === "get_note" || name === "get_section") && typeof (args as { path?: unknown }).path === "string") {
					const rp = (args as { path: string }).path;
					if (!readNotes.includes(rp)) readNotes.push(rp);
				}
				messages.push({ role: "tool", tool_call_id: tc.id || `call_${round}_${stream.toolCalls.indexOf(tc)}`, content: result });
			}
		}

		// Loop exhausted — return whatever the model has said so far, or a
		// graceful "no match" answer instead of failing the whole search.
		if (lastText.trim()) {
			return finalize(lastText.trim());
		}
		return finalize(t("searchNoMatchAnswer"));
	}

	private buildOpenAITools(): OpenAIToolSchema[] {
		if (!this.tools) return [];
		return this.tools.list().map((tool) => ({
			type: "function",
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			},
		}));
	}

	/** Stream one OpenAI-compatible chat round. `onStream` receives answer
	 *  body live: submit rounds stream the `answer` argument out of the
	 *  partial JSON; tool-attached rounds start live-forwarding content once
	 *  it passes ANSWER_LIVE_THRESHOLD with no tool_call delta (and one-shot
	 *  at round end otherwise); no-tool rounds stream every delta. */
	private async streamOpenAIChat(
		url: string,
		provider: ChatProvider,
		body: OpenAIChatBody,
		onStream?: (text: string) => void,
		signal?: AbortSignal,
	): Promise<{ content: string; toolCalls: OpenAIToolCall[]; usageTokens: number; cacheHits: CacheSample[]; roundIn: number; roundOut: number }> {
		let resp: Response;
		try {
			// SSE streaming: requestUrl buffers the whole body and cannot deliver
		// incremental chunks, so the bare fetch API is required here (window
		// member access — the global identifier itself is restricted).
		resp = await window.fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Authorization": `Bearer ${provider.apiKey}`,
			},
			body: JSON.stringify(body),
			signal,
		});
		} catch (e) {
			// User aborted — propagate as AbortError (NOT retryable).
			if (signal?.aborted || (e as Error)?.name === "AbortError") {
				throw new DOMException("Aborted", "AbortError");
			}
			// Network-level failure (CORS / DNS / connection reset / offline).
			// Prefix marks it as retryable — chat() retries once.
			throw new Error(`NETWORK:无法连接 API 服务（${url}），请检查网络连接后重试`);
		}
		if (resp.status !== 200) {
			const text = await resp.text();
			let parsed: unknown = {};
			try { parsed = JSON.parse(text); } catch { /* not JSON */ }
			throw this.extractError(resp.status, parsed);
		}
		// A 200 that isn't an SSE stream (gateway error envelopes, wrong
		// endpoint path) would otherwise parse as zero events and end as a
		// silent empty answer — fail loudly with the body's message instead.
		if (!/text\/event-stream/i.test(String(resp.headers?.get?.("content-type") || ""))) {
			const text = await resp.text();
			let parsed: unknown = {};
			try { parsed = JSON.parse(text); } catch { /* not JSON */ }
			throw this.extractError(resp.status, parsed);
		}

		let content = "";
		let usageTokens = 0;
		let roundIn = 0;
		let roundOut = 0;
		const cacheHits: CacheSample[] = [];
		// Tool calls accumulate by their stream index.
		const toolCalls: Record<number, OpenAIToolCall> = {};
		// Last submit_answer partial already forwarded — deltas recompute the
		// field from scratch, so skip no-change emissions.
		let lastSubmitPartial = "";
		// Live-forward gating for tool-attached rounds (see ANSWER_LIVE_THRESHOLD).
		const submitRound = !!body.tool_choice;
		const liveThreshold = body.tools ? ANSWER_LIVE_THRESHOLD : 0;
		let toolDeltaSeen = false;
		let liveForward = false;
		await this.readSSE<OpenAIStreamEvent>(resp, (json) => {
			const delta = json?.choices?.[0]?.delta;
			if (typeof delta?.content === "string" && delta.content) {
				content += delta.content;
				// Live forward: no-tool rounds stream every delta; tool-attached
				// rounds start once the text passes the threshold with no tool
				// call in sight. In submit rounds content is thinking — never
				// forwarded (only the answer argument below is).
				if (!submitRound && !toolDeltaSeen && (liveForward || content.length >= liveThreshold)) {
					liveForward = true;
					onStream?.(content);
				}
			}
			for (const tc of delta?.tool_calls || []) {
				const idx = tc.index ?? 0;
				toolCalls[idx] ??= { id: tc.id || "", type: "function", function: { name: "", arguments: "" } };
				if (tc.id) toolCalls[idx].id = tc.id;
				if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
				if (tc.function?.arguments) {
					toolCalls[idx].function.arguments += tc.function.arguments;
					// Submit rounds stream the answer live out of the partial
					// JSON `answer` field (escapes and truncation handled).
					if (toolCalls[idx].function.name === SUBMIT_TOOL_NAME) {
						const partial = extractPartialJsonString(toolCalls[idx].function.arguments, "answer");
						if (partial !== null && partial !== lastSubmitPartial) {
							lastSubmitPartial = partial;
							onStream?.(partial);
						}
					}
				}
				toolDeltaSeen = true;
			}
			// Usage arrives in the final chunk when stream_options.include_usage.
			const u = json?.usage;
			if (typeof u?.prompt_tokens === "number") usageTokens = u.prompt_tokens;
				if (typeof u?.prompt_tokens === "number") roundIn = u.prompt_tokens;
				if (typeof u?.completion_tokens === "number") roundOut = u.completion_tokens;
				if (typeof u?.prompt_cache_hit_tokens === "number" && typeof u?.prompt_cache_miss_tokens === "number") {
					const hit = u.prompt_cache_hit_tokens || 0;
					const miss = u.prompt_cache_miss_tokens || 0;
					if (hit + miss > 0) cacheHits.push({ hit, total: hit + miss });
				}
		}, signal);

		const calls = Object.entries(toolCalls)
			.sort(([a], [b]) => Number(a) - Number(b))
			.map(([, call]) => ({ id: call.id, type: "function", function: call.function }));

		// Some models (e.g. DeepSeek) emit tool calls as TEXT markup
		// (`<invoke name="...">...</invoke>` / `<tool_call>{...}</tool_call>`)
		// instead of using the structured protocol. Parse them into real calls
		// and strip the markup from the visible content.
		if (calls.length === 0 && content) {
			const parsed = this.extractTextToolCalls(content);
			if (parsed.calls.length > 0 || parsed.cleanText !== content.trim()) {
				content = parsed.cleanText;
				for (const c of parsed.calls) {
					calls.push({ id: "", type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } });
				}
			}
		}

		// Deltas were already forwarded live above; this final emit is an
		// idempotent normalization pass (content after text-markup stripping)
		// so the UI always ends on the exact text returned as the answer.
		if (onStream && calls.length === 0 && content) {
			onStream(content);
		}

		return { content, toolCalls: calls, usageTokens, cacheHits, roundIn, roundOut };
	}

	// ──── Anthropic format (streaming) ────

	private async chatAnthropic(
		provider: ChatProvider,
		model: string,
		contextWindow: number,
		systemPrompt: string,
		conversation: ConversationMessage[],
		onToolCall?: (toolName: string, args: unknown) => void,
		thinking: ThinkingStep[] = [],
		usedNotes: string[] = [],
		citeRegistry: string[] = [],
		onStream?: (text: string) => void,
		onRoundStart?: () => void,
		onThinking?: (step: ThinkingStep) => void,
		onRoundSuccess?: () => void,
		signal?: AbortSignal,
	): Promise<ChatResult> {
		const baseUrl = provider.baseUrl.replace(/\/+$/, "");
		const anthropicUrl = chatEndpoint(baseUrl, provider.wirePath, "/v1/messages");
		const tools = this.buildAnthropicTools();

		const messages: ConversationMessage[] = [...conversation];

		// Latest assistant text (graceful fallback if the model never produces
		// a final answer), plus a guard against repeated identical tool calls.
		let lastText = "";
		const seenCalls = new Set<string>();
		// Normalized queries per tool, to catch near-duplicate rephrasing.
		const seenQueries = new Map<string, string[]>();
		// Set when the model repeats itself — tools are removed from the next
		// round so it must produce a real answer (not loop or echo a thought).
		let forceAnswer = false;
		// Set when a provider rejects the forced submit_answer tool_choice —
		// remaining rounds degrade to the legacy plain-text answer path.
		let submitDisabled = false;
		// Notes actually OPENED via get_note/get_section this turn — a
		// stronger "used" signal than search hits, for the source cards.
		const readNotes: string[] = [];
		// Context tokens reported by the API for the latest request.
		let usageTokens = 0;
		// Token usage summed across ALL rounds (usage dashboard).
		let usageIn = 0;
		let usageOut = 0;
		// Per-request cache hit ratios (Anthropic prompt caching).
		const cacheHits: CacheSample[] = [];

		const finalize = (rawAnswer: string, declaredSources?: string[]): ChatResult => {
			// Strip the robotic process lead-in BEFORE anything else — dedupe
			// compares against the cleaned text. A shell-only answer (nothing
			// but an intro line) strips to "": pass the emptiness through when
			// a substantial thought exists so the UI promotes that thought
			// (the model wrote the real content into its analysis); without
			// one, keep the shell — an empty answer helps nobody.
			const answer = this.stripAnswerPreamble(rawAnswer)
				|| (this.hasPromotableThought(thinking) ? "" : rawAnswer.trim());
			if (usageIn > 0 || usageOut > 0) {
				try { this.onUsage?.({ model, promptTokens: usageIn, completionTokens: usageOut }); } catch { /* never break chat */ }
			}
			const cacheHitRate = cacheHits.length
				? cacheHits.reduce((a, s) => a + s.hit, 0) / cacheHits.reduce((a, s) => a + s.total, 0)
				: null;
			// Breakdown is the single source of truth for the total: when the
			// API reports usage, `used` is real and `other` absorbs the gap;
			// otherwise `used` = sum of the categories (percentages = 100%).
			const breakdown = this.computeBreakdown(usageTokens, contextWindow, systemPrompt, tools, messages);
			return {
				answer,
				thinking: this.dedupeAnswerThoughts(thinking, answer),
				usedNotes,
				// Notes actually opened via get_note/get_section this turn.
				readNotes,
				// Sources the model declared in submit_answer — transported
				// raw; the caller validates them against known paths.
				declaredSources: declaredSources ?? [],
				citeRegistry,
				contextTokens: breakdown.used,
				contextBreakdown: breakdown,
				cacheHitRate,
			};
		};

		// Pre-analysis round: no tools available yet, so the model MUST write
		// its reasoning out — that text becomes the visible "初步结论" thinking
		// step BEFORE any tool call. Kept in the conversation so later tool
		// decisions build on it.
		messages.push({
			role: "user",
			content: t("promptAnalysis"),
		});
		let analysis: string | undefined;
		try {
			const analysisStream = await this.streamAnthropicChat(anthropicUrl, provider, {
				model,
				max_tokens: 1024,
				system: systemPrompt,
				messages,
				stream: true,
			}, undefined, signal);
			onRoundSuccess?.();
			if (analysisStream.usageTokens) usageTokens = Math.max(usageTokens, analysisStream.usageTokens);
			usageIn += analysisStream.roundIn || 0;
			usageOut += analysisStream.roundOut || 0;
			cacheHits.push(...analysisStream.cacheHits);
			analysis = (analysisStream.contentBlocks || [])
				.filter((b) => b?.type === "text")
				.map((b) => String(b.text))
				.join("\n")
				.trim();
			// Strip any echoed instruction labels (e.g. "（分析阶段）初步结论：").
			if (analysis) {
				analysis = analysis
					.replace(/^(（分析阶段）|\(Analysis phase\))\s*/i, "")
					.replace(/^初步结论[:：]\s*/i, "");
			}
		} catch (e) {
			// The analysis round must never kill the answer — drop it and run
			// the normal loop without a visible conclusion step.
			console.warn("[Semlink] pre-analysis failed, skipping:", e);
			messages.pop();
		}
		if (analysis) {
			const step: ThinkingStep = { type: "thought", text: analysis };
			thinking.push(step);
			onThinking?.(step);
			messages.push({ role: "assistant", content: [{ type: "text", text: analysis }] });
		}
		// Hand over to the answer phase: the analysis often ends with "I need
		// to read more notes" — without this nudge the model tends to answer
		// anyway (without the tools) instead of acting on its own plan.
		if (analysis) {
			messages.push({
				role: "user",
				content: t("promptAnswerPhase"),
			});
		}

		for (let round = 0; round < MAX_TOOL_ITERATIONS; round++) {
			// The model is generating this round (tool decision or final
			// answer) — let the UI show a generic "generating" state.
			onRoundStart?.();
			// Deep into tool rounds — or the model started repeating itself —
			// nudge it to wrap up AND remove the tools so it must answer.
			if (round === NUDGE_AFTER_ROUND || forceAnswer) {
				messages.push({ role: "user", content: t("searchAnswerNowHint") });
			}
			const body: AnthropicChatBody = {
				model,
				max_tokens: 4096,
				system: systemPrompt,
				messages,
				stream: true,
			};
			// Final rounds FORCE the submit_answer tool — protocol-level
			// thinking/answer separation (see the OpenAI path for the full
			// rationale). Providers rejecting the forced tool_choice degrade
			// to the legacy plain-text path for the rest of the turn.
			const submitRound = !submitDisabled && tools.length > 0 && (forceAnswer || round >= NUDGE_AFTER_ROUND);
			if (submitRound) {
				body.tools = [{
					name: SUBMIT_TOOL_NAME,
					description: SUBMIT_TOOL_DESCRIPTION,
					input_schema: submitAnswerParameters(),
				}];
				body.tool_choice = { type: "tool", name: SUBMIT_TOOL_NAME };
			} else if (tools.length > 0) {
				body.tools = tools;
			}

			let stream;
			try {
				// onStream is passed for EVERY round — streamAnthropicChat gates
				// forwarding internally (submit-arg partials, live threshold,
				// end-of-round replay).
				stream = await this.streamAnthropicChat(
					anthropicUrl,
					provider,
					body,
					onStream,
					signal,
				);
			} catch (e) {
				if (!submitRound || signal?.aborted || (e as Error)?.name === "AbortError") throw e;
				// Provider rejected the forced submit tool — degrade this turn
				// to the legacy plain-text answer and retry the round once.
				submitDisabled = true;
				console.warn("[Semlink] submit_answer rejected, degrading to plain text:", e);
				stream = await this.streamAnthropicChat(
					anthropicUrl,
					provider,
					{ ...body, tools: undefined, tool_choice: undefined },
					onStream,
					signal,
				);
			}
			onRoundSuccess?.();
			if (stream.usageTokens) usageTokens = Math.max(usageTokens, stream.usageTokens);
			usageIn += stream.roundIn || 0;
			usageOut += stream.roundOut || 0;
			cacheHits.push(...stream.cacheHits);

			// Forced submit call: the answer arrives as the tool_use input.
			// Deltas were streamed live out of the partial JSON; the final
			// parse is authoritative, with plain text as the last fallback.
			const submitUse = stream.toolUses.find((tu) => tu.name === SUBMIT_TOOL_NAME);
			if (submitUse) {
				let submitted = "";
				const ans = (submitUse.input as { answer?: unknown } | undefined)?.answer;
				if (typeof ans === "string") submitted = ans;
				const rawSources = (submitUse.input as { sources?: unknown } | undefined)?.sources;
				const sources = Array.isArray(rawSources)
					? rawSources.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
					: [];
				if (!submitted.trim()) {
					const partial = extractPartialJsonString(stream.rawToolInputs[SUBMIT_TOOL_NAME] || "", "answer");
					if (partial && partial.trim()) submitted = partial;
				}
				if (!submitted.trim()) {
					submitted = stream.contentBlocks
						.filter((b) => b?.type === "text")
						.map((b) => String(b.text))
						.join("\n")
						.trim();
				}
				await this.replay(submitted, onStream);
				return finalize(submitted, sources);
			}

			if (stream.stopReason !== "tool_use") {
				const answer = stream.contentBlocks
					.filter((b) => b?.type === "text")
					.map((b) => String(b.text))
					.join("\n")
					.trim();
				if (answer) lastText = answer;
				// Final round: deltas were streamed live above; replay is the
				// idempotent normalization pass (stripped markup, joined blocks).
				await this.replay(answer || lastText, onStream);
				return finalize(answer || lastText);
			}

			// Record interim thoughts (visible text / extended thinking blocks)
			// the model produced before calling tools, in order.
			for (const b of stream.contentBlocks) {
				if (b?.type === "text" && b.text?.trim()) {
					const step: ThinkingStep = { type: "thought", text: b.text.trim() };
					thinking.push(step);
					onThinking?.(step);
					lastText = b.text.trim();
				} else if (b?.type === "thinking" && b.thinking?.trim()) {
					const step: ThinkingStep = { type: "thought", text: b.thinking.trim() };
					thinking.push(step);
					onThinking?.(step);
				}
			}

			// Echo the assistant content blocks (including tool_use) back.
			messages.push({ role: "assistant", content: stream.contentBlocks });

			const toolResults: ContentBlock[] = [];
			for (const tu of stream.toolUses) {
				const name = tu.name;
				const args = tu.input || {};

				// Model self-submitted the answer in a regular tool round —
				// accept it as final instead of executing a bogus tool.
				if (name === SUBMIT_TOOL_NAME) {
					const payload = args as { answer?: unknown; sources?: unknown };
					const submitted = typeof payload.answer === "string" ? payload.answer : "";
					const sources = Array.isArray(payload.sources)
						? payload.sources.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
						: [];
					await this.replay(submitted, onStream);
					return finalize(submitted, sources);
				}

				// Repeated call (exact or rephrased query): don't re-execute and
				// don't echo a thought as the answer — flag a forced answer so
				// the next round has no tools and the model answers for real.
				const callKey = `${name}|${JSON.stringify(args)}`;
				if (seenCalls.has(callKey) || this.isNearDuplicateQuery(name, args, seenQueries)) {
					forceAnswer = true;
					toolResults.push({
						type: "tool_result",
						tool_use_id: tu.id,
						content: "（已检测到重复调用，跳过执行。请基于已有信息直接给出最终回答。）",
					});
					continue;
				}
				seenCalls.add(callKey);
				const normQ = this.primaryQueryArg(name, args).toLowerCase().replace(/\s+/g, " ").trim();
				if (normQ.length >= 4) {
					seenQueries.set(name, [...(seenQueries.get(name) || []), normQ]);
				}

				// User hit stop — bail out before running (possibly slow) tools.
				if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
				onToolCall?.(name, args);
				const result = this.tools
					? await this.tools.execute(name, args)
					: `Error: no tools available (unknown tool "${name}")`;
				if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
				const step: ThinkingStep = { type: "tool", name, args, result };
				thinking.push(step);
				onThinking?.(step);
				this.collectUsedNotes(usedNotes, name, args, result);
				if ((name === "get_note" || name === "get_section") && typeof (args as { path?: unknown }).path === "string") {
					const rp = (args as { path: string }).path;
					if (!readNotes.includes(rp)) readNotes.push(rp);
				}
				toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: result });
			}
			if (toolResults.length === 0) {
				throw new Error("Chat model requested a tool but none was called");
			}
			messages.push({ role: "user", content: toolResults });
		}

		// Loop exhausted — return whatever the model has said so far, or a
		// graceful "no match" answer instead of failing the whole search.
		if (lastText) {
			return finalize(lastText);
		}
		return finalize(t("searchNoMatchAnswer"));
	}

	private buildAnthropicTools(): AnthropicToolSchema[] {
		if (!this.tools) return [];
		return this.tools.list().map((tool) => ({
			name: tool.name,
			description: tool.description,
			input_schema: tool.parameters,
		}));
	}

	/** Stream one Anthropic messages round. When `onStream` is provided, each
	 * text delta is forwarded live — the caller only passes it for rounds with
	 * no tools attached (guaranteed final answers). */
	private async streamAnthropicChat(
		url: string,
		provider: ChatProvider,
		body: AnthropicChatBody,
		onStream?: (text: string) => void,
		signal?: AbortSignal,
	): Promise<{
		contentBlocks: ContentBlock[];
		toolUses: AnthropicToolUse[];
		stopReason: string;
		usageTokens: number;
		cacheHits: CacheSample[];
		roundIn: number;
		roundOut: number;
		/** Raw accumulated tool-call input JSON by tool name (submit_answer
		 *  re-extraction fallback when the model's JSON fails to parse). */
		rawToolInputs: Record<string, string>;
	}> {
		let roundIn = 0;
		let roundOut = 0;
		let resp: Response;
		try {
			// SSE streaming: requestUrl buffers the whole body and cannot deliver
		// incremental chunks, so the bare fetch API is required here (window
		// member access — the global identifier itself is restricted).
		resp = await window.fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-api-key": provider.apiKey,
					"anthropic-version": "2023-06-01",
				},
				body: JSON.stringify(body),
				signal,
			});
		} catch (e) {
			// User aborted — propagate as AbortError (NOT retryable).
			if (signal?.aborted || (e as Error)?.name === "AbortError") {
				throw new DOMException("Aborted", "AbortError");
			}
			// Network-level failure — marked retryable; chat() retries once.
			throw new Error(`NETWORK:无法连接 API 服务（${url}），请检查网络连接后重试`);
		}
		if (resp.status !== 200) {
			const text = await resp.text();
			let parsed: unknown = {};
			try { parsed = JSON.parse(text); } catch { /* not JSON */ }
			throw this.extractError(resp.status, parsed);
		}
		// A 200 that isn't an SSE stream (gateway error envelopes, wrong
		// endpoint path) would otherwise parse as zero events and end as a
		// silent empty answer — fail loudly with the body's message instead.
		if (!/text\/event-stream/i.test(String(resp.headers?.get?.("content-type") || ""))) {
			const text = await resp.text();
			let parsed: unknown = {};
			try { parsed = JSON.parse(text); } catch { /* not JSON */ }
			throw this.extractError(resp.status, parsed);
		}

		let usageTokens = 0;
		let stopReason = "";
		let text = "";
		const cacheHits: CacheSample[] = [];
		// Content blocks accumulate by their stream index.
		const blocks: Record<number, ContentBlock> = {};
		// Raw tool-call input JSON by tool name — lets the caller re-extract
		// a submit_answer field even when the model's JSON fails to parse.
		const rawToolInputs: Record<string, string> = {};
		// Last submit_answer partial already forwarded (deltas recompute the
		// field from scratch — skip no-change emissions).
		let lastSubmitPartial = "";
		// Live-forward gating for tool-attached rounds (see ANSWER_LIVE_THRESHOLD).
		const submitRound = !!body.tool_choice;
		const liveThreshold = body.tools ? ANSWER_LIVE_THRESHOLD : 0;
		let toolBlockSeen = false;
		let liveForward = false;

		await this.readSSE<AnthropicStreamEvent>(resp, (json) => {
			const type = json?.type;
			if (type === "message_start") {
				const su = json?.message?.usage ?? json?.usage;
				if (typeof su?.input_tokens === "number") {
					roundIn = su.input_tokens + (su.cache_read_input_tokens || 0) + (su.cache_creation_input_tokens || 0);
				}
				const u = json?.message?.usage;
				if (typeof u?.input_tokens === "number") {
					// Anthropic's input_tokens EXCLUDES cached tokens — add
					// cache reads/creations back so the reported usage is the
					// true request size and never drops as the cache warms up.
					usageTokens = u.input_tokens + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
				}
				if (typeof u?.cache_read_input_tokens === "number") {
					const hit = u.cache_read_input_tokens || 0;
					const total = (u.input_tokens || 0) + hit + (u.cache_creation_input_tokens || 0);
					if (total > 0) cacheHits.push({ hit, total });
				}
			} else if (type === "content_block_start") {
				const block = json?.content_block;
				const idx = json?.index ?? 0;
				if (block?.type === "text") {
					blocks[idx] = { type: "text", text: "" };
				} else if (block?.type === "thinking") {
					blocks[idx] = { type: "thinking", thinking: "" };
				} else if (block?.type === "tool_use") {
					blocks[idx] = { type: "tool_use", id: block.id, name: block.name, input: "" };
					// A tool_use block means this round is a tool round — stop
					// live-forwarding text (see ANSWER_LIVE_THRESHOLD).
					toolBlockSeen = true;
				}
			} else if (type === "content_block_delta") {
				const idx = json?.index ?? 0;
				const delta = json?.delta;
				if (delta?.type === "text_delta" && delta.text) {
					if (blocks[idx]) blocks[idx].text! += delta.text;
					text += delta.text;
					// Live forward: no-tool rounds stream every delta;
					// tool-attached rounds start once the text passes the
					// threshold with no tool_use block in sight. In submit
					// rounds content is thinking — never forwarded.
					if (!submitRound && !toolBlockSeen && (liveForward || text.length >= liveThreshold)) {
						liveForward = true;
						onStream?.(text);
					}
				} else if (delta?.type === "thinking_delta" && delta.thinking) {
					if (blocks[idx]) blocks[idx].thinking! += delta.thinking;
				} else if (delta?.type === "input_json_delta") {
					const block = blocks[idx];
					if (block && block.type === "tool_use") {
						block.input! += delta.partial_json || "";
						rawToolInputs[block.name!] = (rawToolInputs[block.name!] || "") + (delta.partial_json || "");
						// Submit rounds stream the answer live out of the
						// partial JSON `answer` field.
						if (block.name === SUBMIT_TOOL_NAME) {
							const partial = extractPartialJsonString(rawToolInputs[block.name], "answer");
							if (partial !== null && partial !== lastSubmitPartial) {
								lastSubmitPartial = partial;
								onStream?.(partial);
							}
						}
					}
				}
			} else if (type === "message_delta") {
				stopReason = json?.delta?.stop_reason || stopReason;
				const du = json?.usage;
				if (typeof du?.output_tokens === "number") roundOut = du.output_tokens;
			}
		}, signal);

		// Reassemble blocks in order for the assistant echo.
		const contentBlocks = Object.entries(blocks)
			.sort(([a], [b]) => Number(a) - Number(b))
			.map(([, b]) => b);

		const toolUses = contentBlocks
			.filter((b) => b?.type === "tool_use")
			.map((b) => {
				let input: Record<string, unknown> = {};
				try { input = JSON.parse(b.input || "{}") as Record<string, unknown>; } catch { /* keep {} */ }
				return { id: b.id, name: b.name, input } as AnthropicToolUse;
			});

		// Models may emit tool calls as text markup inside text blocks — parse
		// them into real tool_use blocks and strip the markup from the text.
		if (toolUses.length === 0 && text) {
			const parsed = this.extractTextToolCalls(text);
			if (parsed.calls.length > 0 || parsed.cleanText !== text.trim()) {
				text = parsed.cleanText;
				// Put the cleaned text into the first text block; empty the rest.
				let firstText = true;
				for (const b of contentBlocks) {
					if (b?.type === "text") {
						b.text = firstText ? parsed.cleanText : "";
						firstText = false;
					}
				}
				for (const c of parsed.calls) {
					toolUses.push({ id: `text_${Date.now()}_${toolUses.length}`, name: c.name, input: c.args });
				}
			}
		}

		return { contentBlocks, toolUses, stopReason, usageTokens, cacheHits, roundIn, roundOut, rawToolInputs };
	}

	/**
	 * Replay the final answer text to the UI in small increments, so the body
	 * streams without ever exposing interim tool-round "thinking" text.
	 */
	private async replay(text: string, onStream?: (text: string) => void): Promise<void> {
		// Output the complete answer in one shot — no fake typewriter effect.
		// (Previously chunked at 12 chars/10ms to simulate streaming, but the
		// full text is already in hand by the time replay runs.)
		if (!onStream || !text) return;
		onStream(text);
	}

	// ──── Shared helpers ────

	/** Read an SSE response body, invoking onData for each parsed JSON event. */
	private async readSSE<T>(resp: Response, onData: (json: T) => void, signal?: AbortSignal): Promise<void> {
		const reader = resp.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		for (;;) {
			// User hit stop mid-stream — cancel the reader and abort.
			if (signal?.aborted) {
				try { await reader.cancel(); } catch { /* ignore */ }
				throw new DOMException("Aborted", "AbortError");
			}
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let nl: number;
			while ((nl = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, nl).replace(/\r$/, "");
				buffer = buffer.slice(nl + 1);
				const trimmed = line.trim();
				if (trimmed.startsWith("data:")) {
					const data = trimmed.slice(5).trim();
					if (!data || data === "[DONE]") continue;
					try {
						onData(JSON.parse(data) as T);
					} catch {
						// Skip malformed events.
					}
				}
			}
		}
	}

	/**
	 * Build the per-category context breakdown. Categories map to the tooltip:
	 * messages, MCP tools (schemas + results), system prompt, other.
	 *
	 * `total` is the API-reported usage (0 when unavailable). When 0, the
	 * reported total equals the accounted categories so percentages always sum
	 * to 100%. `other` absorbs the estimation gap when real usage is known.
	 */
	private computeBreakdown(
		total: number,
		capacity: number,
		systemPrompt: string,
		tools: unknown[],
		messages: ConversationMessage[],
	): ContextBreakdown {
		const sysTokens = this.estimateTextTokens(systemPrompt);
		const toolSchemaTokens = this.estimateTextTokens(JSON.stringify(tools));

		let messageTokens = 0;
		let toolResultTokens = 0;
		const contentOf = (c: unknown): string => {
			if (typeof c === "string") return c;
			if (c && typeof c === "object") return JSON.stringify(c);
			// Remaining JSON primitives stringify directly; null/undefined → "".
			if (typeof c === "number" || typeof c === "boolean" || typeof c === "bigint" || typeof c === "symbol") {
				return String(c);
			}
			// Only null / undefined remain — both rendered as "" by the previous
			// String(c ?? "") fallback; JSON cannot deliver any other shape here.
			return "";
		};

		for (const m of messages) {
			const content = m?.content;
			if (m?.role === "tool") {
				toolResultTokens += this.estimateTextTokens(contentOf(content));
			} else if (m?.role === "assistant") {
				if (Array.isArray(content)) {
					// Anthropic content blocks.
					for (const b of content) {
						if (b?.type === "text") messageTokens += this.estimateTextTokens(b.text || "");
						else if (b?.type === "thinking") messageTokens += this.estimateTextTokens(b.thinking || "");
						else if (b?.type === "tool_use") toolResultTokens += this.estimateTextTokens(contentOf(b.input));
					}
				} else {
					messageTokens += this.estimateTextTokens((m.content as string) || "");
				}
				for (const tc of m.tool_calls || []) {
					toolResultTokens += this.estimateTextTokens(tc?.function?.arguments || "");
				}
			} else if (m?.role === "user") {
				if (Array.isArray(content) && content.some((b) => b?.type === "tool_result")) {
					// Anthropic tool results belong to the MCP tools category.
					for (const b of content) {
						if (b?.type === "tool_result") toolResultTokens += this.estimateTextTokens(contentOf(b.content));
					}
				} else {
					messageTokens += this.estimateTextTokens(contentOf(content));
				}
			}
		}

		const mcpTokens = toolSchemaTokens + toolResultTokens;
		const accounted = sysTokens + mcpTokens + messageTokens;
		const used = total || accounted;
		const other = Math.max(0, used - accounted);

		return {
			capacity,
			used,
			categories: [
				{ key: "messages", tokens: messageTokens },
				{ key: "system_tools", tokens: 0 },
				{ key: "mcp_tools", tokens: mcpTokens },
				{ key: "skills", tokens: 0 },
				{ key: "system_prompt", tokens: sysTokens },
				{ key: "other", tokens: other },
			],
		};
	}

	/** CJK-aware token estimate: CJK ≈ 1 token/char, other ≈ 4 chars/token. */
	private estimateTextTokens(text: string): number {
		if (!text) return 0;
		let cjk = 0;
		let other = 0;
		for (const ch of text) {
			if (ch >= "\u4e00" && ch <= "\u9fff") cjk++;
			else other++;
		}
		return Math.ceil(cjk + other / 4);
	}

	/**
	 * Record note paths whose content actually entered the conversation:
	 * notes read via get_note/get_section (from args) and notes surfaced by
	 * search_notes/get_similar_notes (parsed from the result JSON).
	 */
	private collectUsedNotes(usedNotes: string[], name: string, args: Record<string, unknown>, result: string): void {
		let paths: string[] = [];
		if ((name === "get_note" || name === "get_section" || name === "read") && typeof args?.path === "string") {
			paths = [args.path];
		} else if (name === "search_notes" || name === "get_similar_notes" || name === "grep_notes" || name === "search" || name === "search_bm25" || name === "search_vector" || name === "keyword" || name === "semantic" || name === "grep" || name === "find") {
			try {
				const parsed = JSON.parse(result) as { results?: Array<{ path?: string }>; paths?: unknown };
				if (Array.isArray(parsed?.results)) {
					paths = parsed.results
						.filter((r) => typeof r?.path === "string")
						.map((r) => String(r.path));
				}
				// grep_notes also returns a bare `paths` list (files beyond the
				// detailed results) — those are conversation-visible too.
				if (Array.isArray(parsed?.paths)) {
					for (const p of parsed.paths as unknown[]) {
						if (typeof p === "string" && !paths.includes(p)) paths.push(p);
					}
				}
			} catch {
				// Long results are cut off by the size cap → the JSON no longer
				// parses. Salvage the path fields that survived the cut instead
				// of dropping ALL of them: declarations citing snippet-only
				// notes must still validate against the known-path set, or the
				// cards end short of the inline [n] citations.
				const re = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
				let m: RegExpExecArray | null;
				while ((m = re.exec(result)) !== null) {
					paths.push(m[1].replace(/\\(["\\/])/g, "$1"));
				}
			}
		}
		for (const p of paths) {
			if (!usedNotes.includes(p)) usedNotes.push(p);
		}
	}

	/** Build an Error from an HTTP failure, mirroring the embedding client. */
	private extractError(status: number, body: unknown): Error {
		let msg = "";
		if (typeof body === "object" && body) {
			const b = body as { error?: { message?: string }; message?: string; msg?: string };
			// `error` may also arrive as a raw string (or a message-less object
			// that lands in msg verbatim) — re-read it unshaped for that case.
			msg = b?.error?.message || b?.message || b?.msg || (body as { error?: string }).error || "";
		}
		const err = Object.assign(new Error(msg || `HTTP ${status}`), { status });
		return err;
	}
}
