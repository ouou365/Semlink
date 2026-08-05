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
import type { SemlinkTools } from "./chat-tools";
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

/** A step in the model's thinking process, in chronological order. */
export type ThinkingStep =
	| { type: "thought"; text: string }
	| { type: "tool"; name: string; args: any; result: string };

/** One request's prompt-cache usage sample. A turn averages these by TOKEN
 *  weight (Σhit / Σtotal), never by request count — small requests would
 *  otherwise drag the displayed hit rate down. */
export interface CacheSample {
	hit: number;
	total: number;
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

	constructor(settings: SmartVaultSettings, tools: SemlinkTools | null = null) {
		this.settings = settings;
		this.tools = tools;
	}

	updateSettings(settings: SmartVaultSettings) {
		this.settings = settings;
	}

	/**
	 * Return the first configured chat provider (non-empty apiKey and baseUrl),
	 * or null if none is usable.
	 */
	getActiveProvider(): ChatProvider | null {
		const providers = this.settings.chatProviders || [];
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
		const providers = this.settings.chatProviders || [];
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

	/** Switch the active chat model (must exist in the given provider). */
	setActiveModel(providerId: string, modelId: string): boolean {
		const providers = this.settings.chatProviders || [];
		const provider = providers.find((p) => p.id === providerId);
		if (!provider || !provider.models.some((m) => m.id === modelId)) {
			return false;
		}
		this.activeModelKey = `${providerId}/${modelId}`;
		return true;
	}

	/** Providers + their models for the model-switcher dropdown. */
	getModelOptions(): Array<{ providerId: string; providerName: string; models: ChatModel[] }> {
		return (this.settings.chatProviders || [])
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
		onToolCall?: (toolName: string, args: any) => void,
		depth: "standard" | "enhanced" = "standard",
		onStream?: (text: string) => void,
		onRoundStart?: () => void,
		onThinking?: (step: ThinkingStep) => void,
		onRetry?: (attempt: number, total: number) => void,
		signal?: AbortSignal,
	): Promise<ChatResult> {
		// Use the SELECTED model (and its owning provider) — the model switcher
		// may pick any model from any configured provider.
		const active = this.getActiveModel();
		if (!active) throw new Error("No chat provider configured");
		const { provider, model } = active;
		const contextWindow = model.contextWindow || 0;
		const depthHint = depth === "enhanced"
			? "读取笔记时可以适当使用 get_note 读取整篇笔记以获得完整信息，注意控制读取的笔记数量。"
			: "读取笔记时请优先使用 get_section 只读取相关章节，避免用 get_note 读取整篇长笔记，以控制上下文占用。";
		const systemPrompt =
			"你是 Semlink 的笔记问答助手。回答步骤：① 先思考用户的问题，用简短文字写出你的分析并形成初步结论（这段分析会展示给用户，请写清楚但不要太长）；② 只有发现信息不足时才调用工具补充（search_notes / get_note / get_section / grep_notes 等），不要一上来就盲目调用工具；③ 信息足够后立即给出最终回答，不要反复调用工具。" +
			"注意：初始检索提供的是笔记片段（截断预览），可能不完整。对于穷举性、准确性要求高的问题（如「包含哪些部分」「有哪些功能」），请调用 get_note 读取相关笔记的完整内容验证后再给出最终回答。" +
			"对于「列出/找到所有提到某关键词的笔记」这类问题，grep_notes 一次调用即可完成：totalFiles 是匹配总数，paths 字段就是完整文件清单（completeList 为 true 时），直接列出即可，不要再次调用工具、不要用更大 limit 或不同措辞重复检索。" +
			depthHint +
			"请勿编造笔记中不存在的信息。回答使用与问题相同的语言。" +
			"\n\n以下是初始检索到的相关笔记内容：\n" + context;

		// Per-depth cap on a single tool result (enhanced reads full notes).
		if (this.tools) {
			this.tools.maxResultChars = depth === "enhanced" ? 8000 : 4000;
		}

		const thinking: ThinkingStep[] = [];
		const usedNotes: string[] = [];

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
				? this.chatAnthropic(provider, model.id, contextWindow, systemPrompt, conversation, onToolCall, thinking, usedNotes, onStream, onRoundStart, onThinking, onRoundSuccess, signal)
				: this.chatOpenAI(provider, model.id, contextWindow, systemPrompt, conversation, onToolCall, thinking, usedNotes, onStream, onRoundStart, onThinking, onRoundSuccess, signal);

		for (;;) {
			totalAttempts++;
			try {
				return await dispatch();
			} catch (e) {
				// User aborted — never retry, propagate the AbortError as-is.
				if (signal?.aborted || (e as any)?.name === "AbortError") throw e;
				const retryDelayMs = CHAT_RETRY_DELAYS_MS[attempt - 1];
				if (retryDelayMs === undefined || totalAttempts > CHAT_RETRY_TOTAL + 5 || !this.isTransientChatError(e)) {
					throw e;
				}
				const msg = String((e as any)?.message || e || "");
				console.warn(`[Semlink] transient error (attempt ${attempt}), retrying in ${retryDelayMs}ms:`, msg);
				onRetry?.(attempt + 1, CHAT_RETRY_TOTAL);
				await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
				if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
				attempt++;
			}
		}
	}

	/** ZCode-style retryable check: only transient failures get retried. */
	private isTransientChatError(e: any): boolean {
		if (e instanceof TypeError) return true;
		const msg = String(e?.message || e || "");
		if (/NETWORK:|failed to fetch/i.test(msg)) return true;
		const status = e?.status;
		return status === 429 || status === 503 || /busy|rate ?limit/i.test(msg);
	}

	// ──── Conversation assembly (ZCode-style history) ────

	/**
	 * Build the conversation array: prior turns as native role messages
	 * (NOT text-glued into the question), then the current question. User
	 * messages with segments (dropped-note chips) are re-expanded to
	 * `[[path]]` links so the model still sees the attached files.
	 */
	private buildConversation(history: HistoryMessage[], question: string): any[] {
		const conv: any[] = [];
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
	private truncateConversation(conv: any[], systemPrompt: string, contextWindow: number): void {
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
			console.log(`[Semlink] 历史上下文截断：丢弃最早 ${drop} 条消息（约 ${total} tokens / 阈值 ${threshold}）`);
		}
	}

	/** Estimate one message's tokens (string content or content blocks). */
	private estimateMessageTokens(m: any): number {
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
	private primaryQueryArg(name: string, args: any): string {
		if (name === "search_notes" || name === "get_similar_notes") return String(args?.query ?? "");
		if (name === "grep_notes") return String(args?.pattern ?? "");
		return "";
	}

	/**
	 * Near-duplicate detection: the model rephrases the same query (e.g.
	 * "智能船载终端研发" → "船载终端研发") instead of finalizing. One query
	 * being a substring of a previous query (same tool) means it's repeating
	 * itself — force an answer instead of re-running the tool.
	 */
	private isNearDuplicateQuery(name: string, args: any, seenQueries: Map<string, string[]>): boolean {
		const q = this.primaryQueryArg(name, args).toLowerCase().replace(/\s+/g, " ").trim();
		if (q.length < 4) return false;
		const prev = seenQueries.get(name);
		if (!prev) return false;
		return prev.some((p) => q.includes(p) || p.includes(q));
	}

	/**
	 * Parse text-style tool calls some models emit as plain markup instead of
	 * using the structured function-calling protocol — e.g.
	 * `<invoke name="get_section"><parameter name="heading">X</parameter>
	 * </invoke>` or `<tool_call>{"name":"...","arguments":{...}}</tool_call>`.
	 * Returns the parsed calls and the text with all tool markup removed
	 * (non-parameter prose inside `<invoke>` blocks is preserved).
	 */
	private extractTextToolCalls(text: string): { calls: Array<{ name: string; args: Record<string, any> }>; cleanText: string } {
		const calls: Array<{ name: string; args: Record<string, any> }> = [];
		let clean = text;

		// Format 1: <invoke name="tool"><parameter name="k">v</parameter>...</invoke>
		clean = clean.replace(/<invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/invoke>/gi, (_whole, name: string, inner: string) => {
			const args: Record<string, any> = {};
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
				const parsed = JSON.parse(inner.trim());
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
		conversation: any[],
		onToolCall?: (toolName: string, args: any) => void,
		thinking: ThinkingStep[] = [],
		usedNotes: string[] = [],
		onStream?: (text: string) => void,
		onRoundStart?: () => void,
		onThinking?: (step: ThinkingStep) => void,
		onRoundSuccess?: () => void,
		signal?: AbortSignal,
	): Promise<ChatResult> {
		const baseUrl = provider.baseUrl.replace(/\/+$/, "");
		const tools = this.buildOpenAITools();

		const messages: any[] = [
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
		// Context tokens reported by the API for the latest request.
		let usageTokens = 0;
		// Per-request cache hit ratios (e.g. DeepSeek prompt caching).
		const cacheHits: CacheSample[] = [];

		const finalize = (answer: string): ChatResult => {
			const cacheHitRate = cacheHits.length
				? cacheHits.reduce((a, s) => a + s.hit, 0) / cacheHits.reduce((a, s) => a + s.total, 0)
				: null;
			// Breakdown is the single source of truth for the total: when the
			// API reports usage, `used` is real and `other` absorbs the gap;
			// otherwise `used` = sum of the categories (percentages = 100%).
			const breakdown = this.computeBreakdown(usageTokens, contextWindow, systemPrompt, tools, messages);
			return {
				answer,
				thinking,
				usedNotes,
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
			content: "（分析阶段）请先不要调用任何工具，直接用自然的几句话写出你的分析（不要使用编号或任何标签，直接叙述即可）：基于当前片段你能初步回答什么？片段是截断预览，是否可能不完整、遗漏关键内容？如果需要，准备调用哪个工具、读取哪篇笔记来验证？分析完成后，若需要补充信息，你可以在后续调用工具。",
		});
		let analysis: string | undefined;
		try {
			const analysisStream = await this.streamOpenAIChat(
				`${baseUrl}/v1/chat/completions`,
				provider,
				{ model, messages, stream: true, stream_options: { include_usage: true } },
				undefined,
				signal,
			);
			onRoundSuccess?.();
			if (analysisStream.usageTokens) usageTokens = analysisStream.usageTokens;
			cacheHits.push(...analysisStream.cacheHits);
			analysis = analysisStream.content?.trim();
			// Strip any echoed instruction labels (e.g. "（分析阶段）初步结论：").
			if (analysis) {
				analysis = analysis
					.replace(/^（分析阶段）\s*/i, "")
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

			const body: Record<string, any> = {
				model,
				messages,
				stream: true,
				stream_options: { include_usage: true },
			};
			if (tools.length > 0 && !forceAnswer && round < NUDGE_AFTER_ROUND) body.tools = tools;

			// Stream this round. streamOpenAIChat forwards content deltas live
			// via onStream, but ONLY once it's seen that the round has no tool
			// calls (i.e. this is the final answer). Tool rounds stay buffered.
			const stream = await this.streamOpenAIChat(
				`${baseUrl}/v1/chat/completions`,
				provider,
				body,
				onStream,
				signal,
			);
			onRoundSuccess?.();
			if (stream.usageTokens) usageTokens = stream.usageTokens;
			cacheHits.push(...stream.cacheHits);
			if (stream.content) lastText = stream.content;

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
				let args: any = {};
				try {
					args = JSON.parse(rawArgs);
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

	private buildOpenAITools(): any[] {
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

	/** Stream one OpenAI-compatible chat round. When `onStream` is provided,
	 * each content delta is forwarded live (true streaming, not buffered-then-
	 * replayed). Tool rounds pass no onStream so their content stays buffered. */
	private async streamOpenAIChat(
		url: string,
		provider: ChatProvider,
		body: any,
		onStream?: (text: string) => void,
		signal?: AbortSignal,
	): Promise<{ content: string; toolCalls: any[]; usageTokens: number; cacheHits: CacheSample[] }> {
		let resp: Response;
		try {
			resp = await fetch(url, {
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
			if (signal?.aborted || (e as any)?.name === "AbortError") {
				throw new DOMException("Aborted", "AbortError");
			}
			// Network-level failure (CORS / DNS / connection reset / offline).
			// Prefix marks it as retryable — chat() retries once.
			throw new Error(`NETWORK:无法连接 API 服务（${url}），请检查网络连接后重试`);
		}
		if (resp.status !== 200) {
			const text = await resp.text();
			let parsed: any = {};
			try { parsed = JSON.parse(text); } catch { /* not JSON */ }
			throw this.extractError(resp.status, parsed);
		}

		let content = "";
		let usageTokens = 0;
		const cacheHits: CacheSample[] = [];
		// Tool calls accumulate by their stream index.
		const toolCalls: Record<number, any> = {};
		// Track finish_reason to know if this round is the final answer
		// (finish_reason="stop") or a tool round (finish_reason="tool_calls").
		let finishReason = "";

		await this.readSSE(resp, (json) => {
			const delta = json?.choices?.[0]?.delta;
			if (typeof delta?.content === "string" && delta.content) {
				content += delta.content;
			}
			// Check finish_reason — appears in the last chunk of each round.
			const fr = json?.choices?.[0]?.finish_reason;
			if (fr) finishReason = fr;
			for (const tc of delta?.tool_calls || []) {
				const idx = tc.index ?? 0;
				toolCalls[idx] ??= { id: tc.id || "", type: "function", function: { name: "", arguments: "" } };
				if (tc.id) toolCalls[idx].id = tc.id;
				if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
				if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
			}
			// Usage arrives in the final chunk when stream_options.include_usage.
			const u = json?.usage;
			if (typeof u?.prompt_tokens === "number") usageTokens = u.prompt_tokens;
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

		// Only forward content to onStream if this was the FINAL answer round
		// (no tool calls). Tool rounds' interim content is never shown — this
		// avoids the "text flashes then vanishes" flicker that happened when
		// onStream fired before a tool_call arrived mid-stream.
		if (onStream && calls.length === 0 && content) {
			onStream(content);
		}

		return { content, toolCalls: calls, usageTokens, cacheHits };
	}

	// ──── Anthropic format (streaming) ────

	private async chatAnthropic(
		provider: ChatProvider,
		model: string,
		contextWindow: number,
		systemPrompt: string,
		conversation: any[],
		onToolCall?: (toolName: string, args: any) => void,
		thinking: ThinkingStep[] = [],
		usedNotes: string[] = [],
		onStream?: (text: string) => void,
		onRoundStart?: () => void,
		onThinking?: (step: ThinkingStep) => void,
		onRoundSuccess?: () => void,
		signal?: AbortSignal,
	): Promise<ChatResult> {
		const baseUrl = provider.baseUrl.replace(/\/+$/, "");
		const tools = this.buildAnthropicTools();

		const messages: any[] = [...conversation];

		// Latest assistant text (graceful fallback if the model never produces
		// a final answer), plus a guard against repeated identical tool calls.
		let lastText = "";
		const seenCalls = new Set<string>();
		// Normalized queries per tool, to catch near-duplicate rephrasing.
		const seenQueries = new Map<string, string[]>();
		// Set when the model repeats itself — tools are removed from the next
		// round so it must produce a real answer (not loop or echo a thought).
		let forceAnswer = false;
		// Context tokens reported by the API for the latest request.
		let usageTokens = 0;
		// Per-request cache hit ratios (Anthropic prompt caching).
		const cacheHits: CacheSample[] = [];

		const finalize = (answer: string): ChatResult => {
			const cacheHitRate = cacheHits.length
				? cacheHits.reduce((a, s) => a + s.hit, 0) / cacheHits.reduce((a, s) => a + s.total, 0)
				: null;
			// Breakdown is the single source of truth for the total: when the
			// API reports usage, `used` is real and `other` absorbs the gap;
			// otherwise `used` = sum of the categories (percentages = 100%).
			const breakdown = this.computeBreakdown(usageTokens, contextWindow, systemPrompt, tools, messages);
			return {
				answer,
				thinking,
				usedNotes,
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
			content: "（分析阶段）请先不要调用任何工具，直接用自然的几句话写出你的分析（不要使用编号或任何标签，直接叙述即可）：基于当前片段你能初步回答什么？片段是截断预览，是否可能不完整、遗漏关键内容？如果需要，准备调用哪个工具、读取哪篇笔记来验证？分析完成后，若需要补充信息，你可以在后续调用工具。",
		});
		let analysis: string | undefined;
		try {
			const analysisStream = await this.streamAnthropicChat(`${baseUrl}/v1/messages`, provider, {
				model,
				max_tokens: 1024,
				system: systemPrompt,
				messages,
				stream: true,
			}, signal);
			onRoundSuccess?.();
			if (analysisStream.usageTokens) usageTokens = analysisStream.usageTokens;
			cacheHits.push(...analysisStream.cacheHits);
			analysis = (analysisStream.contentBlocks || [])
				.filter((b: any) => b?.type === "text")
				.map((b: any) => b.text)
				.join("\n")
				.trim();
			// Strip any echoed instruction labels (e.g. "（分析阶段）初步结论：").
			if (analysis) {
				analysis = analysis
					.replace(/^（分析阶段）\s*/i, "")
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

		for (let round = 0; round < MAX_TOOL_ITERATIONS; round++) {
			// The model is generating this round (tool decision or final
			// answer) — let the UI show a generic "generating" state.
			onRoundStart?.();
			// Deep into tool rounds — or the model started repeating itself —
			// nudge it to wrap up AND remove the tools so it must answer.
			if (round === NUDGE_AFTER_ROUND || forceAnswer) {
				messages.push({ role: "user", content: t("searchAnswerNowHint") });
			}
			const body: Record<string, any> = {
				model,
				max_tokens: 4096,
				system: systemPrompt,
				messages,
				stream: true,
			};
			if (tools.length > 0 && !forceAnswer && round < NUDGE_AFTER_ROUND) body.tools = tools;

			const stream = await this.streamAnthropicChat(
				`${baseUrl}/v1/messages`,
				provider,
				body,
				signal,
			);
			onRoundSuccess?.();
			if (stream.usageTokens) usageTokens = stream.usageTokens;
			cacheHits.push(...stream.cacheHits);

			if (stream.stopReason !== "tool_use") {
				const answer = stream.contentBlocks
					.filter((b: any) => b?.type === "text")
					.map((b: any) => b.text)
					.join("\n")
					.trim();
				if (answer) lastText = answer;
				// Final round: stream the answer body to the UI.
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

			const toolResults: any[] = [];
			for (const tu of stream.toolUses) {
				const name = tu.name;
				const args = tu.input || {};

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

	private buildAnthropicTools(): any[] {
		if (!this.tools) return [];
		return this.tools.list().map((tool) => ({
			name: tool.name,
			description: tool.description,
			input_schema: tool.parameters,
		}));
	}

	/** Stream one Anthropic messages round (content buffered, no UI emit). */
	private async streamAnthropicChat(
		url: string,
		provider: ChatProvider,
		body: any,
		signal?: AbortSignal,
	): Promise<{
		contentBlocks: any[];
		toolUses: any[];
		stopReason: string;
		usageTokens: number;
		cacheHits: CacheSample[];
	}> {
		let resp: Response;
		try {
			resp = await fetch(url, {
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
			if (signal?.aborted || (e as any)?.name === "AbortError") {
				throw new DOMException("Aborted", "AbortError");
			}
			// Network-level failure — marked retryable; chat() retries once.
			throw new Error(`NETWORK:无法连接 API 服务（${url}），请检查网络连接后重试`);
		}
		if (resp.status !== 200) {
			const text = await resp.text();
			let parsed: any = {};
			try { parsed = JSON.parse(text); } catch { /* not JSON */ }
			throw this.extractError(resp.status, parsed);
		}

		let usageTokens = 0;
		let stopReason = "";
		let text = "";
		const cacheHits: CacheSample[] = [];
		// Content blocks accumulate by their stream index.
		const blocks: Record<number, any> = {};

		await this.readSSE(resp, (json) => {
			const type = json?.type;
			if (type === "message_start") {
				const u = json?.message?.usage;
				if (typeof u?.input_tokens === "number") usageTokens = u.input_tokens;
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
				}
			} else if (type === "content_block_delta") {
				const idx = json?.index ?? 0;
				const delta = json?.delta;
				if (delta?.type === "text_delta" && delta.text) {
					if (blocks[idx]) blocks[idx].text += delta.text;
					text += delta.text;
				} else if (delta?.type === "thinking_delta" && delta.thinking) {
					if (blocks[idx]) blocks[idx].thinking += delta.thinking;
				} else if (delta?.type === "input_json_delta") {
					if (blocks[idx]) blocks[idx].input += delta.partial_json || "";
				}
			} else if (type === "message_delta") {
				stopReason = json?.delta?.stop_reason || stopReason;
			}
		}, signal);

		// Reassemble blocks in order for the assistant echo.
		const contentBlocks = Object.entries(blocks)
			.sort(([a], [b]) => Number(a) - Number(b))
			.map(([, b]) => b);

		const toolUses = contentBlocks
			.filter((b: any) => b?.type === "tool_use")
			.map((b: any) => {
				let input: any = {};
				try { input = JSON.parse(b.input || "{}"); } catch { /* keep {} */ }
				return { id: b.id, name: b.name, input };
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

		return { contentBlocks, toolUses, stopReason, usageTokens, cacheHits };
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
	private async readSSE(resp: Response, onData: (json: any) => void, signal?: AbortSignal): Promise<void> {
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
						onData(JSON.parse(data));
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
		tools: any[],
		messages: any[],
	): ContextBreakdown {
		const sysTokens = this.estimateTextTokens(systemPrompt);
		const toolSchemaTokens = this.estimateTextTokens(JSON.stringify(tools));

		let messageTokens = 0;
		let toolResultTokens = 0;
		const contentOf = (c: any): string => {
			if (typeof c === "string") return c;
			if (c && typeof c === "object") return JSON.stringify(c);
			return String(c ?? "");
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
					messageTokens += this.estimateTextTokens(m.content || "");
				}
				for (const tc of m.tool_calls || []) {
					toolResultTokens += this.estimateTextTokens(tc?.function?.arguments || "");
				}
			} else if (m?.role === "user") {
				if (Array.isArray(content) && content.some((b: any) => b?.type === "tool_result")) {
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
	private collectUsedNotes(usedNotes: string[], name: string, args: any, result: string): void {
		let paths: string[] = [];
		if ((name === "get_note" || name === "get_section") && typeof args?.path === "string") {
			paths = [args.path];
		} else if (name === "search_notes" || name === "get_similar_notes") {
			try {
				const parsed = JSON.parse(result);
				if (Array.isArray(parsed?.results)) {
					paths = parsed.results
						.filter((r: any) => typeof r?.path === "string")
						.map((r: any) => r.path);
				}
			} catch {
				// Unparseable result — ignore.
			}
		}
		for (const p of paths) {
			if (!usedNotes.includes(p)) usedNotes.push(p);
		}
	}

	/** Build an Error from an HTTP failure, mirroring the embedding client. */
	private extractError(status: number, body: any): Error {
		let msg = "";
		if (typeof body === "object" && body) {
			msg = body?.error?.message || body?.message || body?.error || "";
		}
		const err: any = new Error(msg || `HTTP ${status}`);
		err.status = status;
		return err;
	}
}
