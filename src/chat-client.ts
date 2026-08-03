// ========================================
// Semlink - Chat Completion Client
// ========================================
// Wraps chat-completion calls for the conversational search feature.
// Supports both OpenAI-compatible (…/v1/chat/completions) and Anthropic
// (…/v1/messages) API formats, including function/tool calling so the model
// can query Semlink's search/read tools when the retrieved context is not
// enough. Answers stream via SSE (fetch + ReadableStream), with incremental
// text delivered through an onStream callback.

import type { SmartVaultSettings, ChatProvider } from "./types";
import type { SemlinkTools } from "./chat-tools";
import { t } from "./i18n";

/** Maximum tool-calling rounds before giving up on a final answer. */
const MAX_TOOL_ITERATIONS = 5;
/** After this many tool rounds, nudge the model to answer directly. */
const NUDGE_AFTER_ROUND = 3;

/** A step in the model's thinking process, in chronological order. */
export type ThinkingStep =
	| { type: "thought"; text: string }
	| { type: "tool"; name: string; args: any; result: string };

/** One slice of the context window, for the usage tooltip. */
export interface ContextCategory {
	key: string; // "messages" | "system_tools" | "mcp_tools" | "skills" | "system_prompt" | "other"
	tokens: number;
}

/** Context usage breakdown of a chat turn. */
export interface ContextBreakdown {
	capacity: number;
	used: number;
	categories: ContextCategory[];
}

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

	/** Model id of the active chat provider, e.g. "deepseek-v4-flash". */
	getActiveModelLabel(): string | null {
		const provider = this.getActiveProvider();
		if (!provider || !provider.models || provider.models.length === 0) {
			return null;
		}
		return provider.models[0].id;
	}

	/** Context window (tokens) of the active chat model, or null if unknown. */
	getActiveContextWindow(): number | null {
		const provider = this.getActiveProvider();
		if (!provider || !provider.models || provider.models.length === 0) {
			return null;
		}
		return provider.models[0].contextWindow || null;
	}

	/**
	 * Ask the active chat model to answer `question` given the retrieved note
	 * context. The model may call Semlink tools to gather more information.
	 * `onToolCall` is invoked (with tool name and args) before each tool runs,
	 * so the UI can show progress. `depth` controls how aggressively the model
	 * reads notes: "standard" prefers get_section with a smaller result cap,
	 * "enhanced" allows full get_note reads with a larger cap. `onStream` is
	 * called with the growing answer text as the model streams it.
	 */
	async chat(
		context: string,
		question: string,
		onToolCall?: (toolName: string, args: any) => void,
		depth: "standard" | "enhanced" = "standard",
		onStream?: (text: string) => void,
	): Promise<ChatResult> {
		const provider = this.getActiveProvider();
		if (!provider) throw new Error("No chat provider configured");
		if (!provider.models || provider.models.length === 0) {
			throw new Error(`Chat provider "${provider.name}" has no models`);
		}

		const model = provider.models[0];
		const contextWindow = provider.models[0].contextWindow || 0;
		const depthHint = depth === "enhanced"
			? "读取笔记时可以适当使用 get_note 读取整篇笔记以获得完整信息，注意控制读取的笔记数量。"
			: "读取笔记时请优先使用 get_section 只读取相关章节，避免用 get_note 读取整篇长笔记，以控制上下文占用。";
		const systemPrompt =
			"你是 Semlink 的笔记问答助手。请基于下方提供的笔记内容回答问题；" +
			"如果已有内容不足以回答，可以使用提供的工具（search_notes / get_note / get_section 等）" +
			"主动检索和读取笔记以补充信息，但一旦获得足够信息，请立即给出最终回答，不要反复调用工具。" +
			depthHint +
			"请勿编造笔记中不存在的信息。回答使用与问题相同的语言。" +
			"\n\n以下是初始检索到的相关笔记内容：\n" + context;

		// Per-depth cap on a single tool result (enhanced reads full notes).
		if (this.tools) {
			this.tools.maxResultChars = depth === "enhanced" ? 8000 : 4000;
		}

		const thinking: ThinkingStep[] = [];
		const usedNotes: string[] = [];

		if (provider.apiFormat === "anthropic") {
			return this.chatAnthropic(provider, model.id, contextWindow, systemPrompt, question, onToolCall, thinking, usedNotes, onStream);
		}
		return this.chatOpenAI(provider, model.id, contextWindow, systemPrompt, question, onToolCall, thinking, usedNotes, onStream);
	}

	// ──── OpenAI format (streaming) ────

	private async chatOpenAI(
		provider: ChatProvider,
		model: string,
		contextWindow: number,
		systemPrompt: string,
		question: string,
		onToolCall?: (toolName: string, args: any) => void,
		thinking: ThinkingStep[] = [],
		usedNotes: string[] = [],
		onStream?: (text: string) => void,
	): Promise<ChatResult> {
		const baseUrl = provider.baseUrl.replace(/\/+$/, "");
		const tools = this.buildOpenAITools();

		const messages: any[] = [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: question },
		];

		// Latest assistant text (used as a graceful fallback if the model keeps
		// calling tools without ever producing a final answer).
		let lastText = "";
		// Guard against the model repeating the exact same tool call in a loop.
		const seenCalls = new Set<string>();
		// Context tokens reported by the API for the latest request.
		let usageTokens = 0;
		// Per-request cache hit ratios (e.g. DeepSeek prompt caching).
		const cacheHits: number[] = [];

		const finalize = (answer: string): ChatResult => {
			const cacheHitRate = cacheHits.length
				? cacheHits.reduce((a, b) => a + b, 0) / cacheHits.length
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

		for (let round = 0; round < MAX_TOOL_ITERATIONS; round++) {
			// If we're deep into tool rounds, nudge the model to wrap up.
			if (round === NUDGE_AFTER_ROUND) {
				messages.push({ role: "user", content: t("searchAnswerNowHint") });
			}

			const body: Record<string, any> = {
				model,
				messages,
				stream: true,
				stream_options: { include_usage: true },
			};
			if (tools.length > 0) body.tools = tools;

			const stream = await this.streamOpenAIChat(
				`${baseUrl}/v1/chat/completions`,
				provider,
				body,
			);
			if (stream.usageTokens) usageTokens = stream.usageTokens;
			cacheHits.push(...stream.cacheHits);
			if (stream.content) lastText = stream.content;

			if (stream.toolCalls.length === 0) {
				// Final round: stream the answer body to the UI.
				await this.replay(stream.content, onStream);
				return finalize(stream.content.trim() || lastText.trim());
			}

			// Interim text the model produced while deciding to call tools.
			if (stream.content?.trim()) {
				thinking.push({ type: "thought", text: stream.content.trim() });
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

				// Stop if the model repeats the exact same call — it's looping.
				const callKey = `${name}|${JSON.stringify(args)}`;
				if (seenCalls.has(callKey)) {
					if (lastText.trim()) return finalize(lastText.trim());
					throw new Error(t("searchNoFinalAnswer"));
				}
				seenCalls.add(callKey);

				onToolCall?.(name, args);
				const result = this.tools
					? await this.tools.execute(name, args)
					: `Error: no tools available (unknown tool "${name}")`;
				thinking.push({ type: "tool", name, args, result });
				this.collectUsedNotes(usedNotes, name, args, result);
				messages.push({ role: "tool", tool_call_id: tc.id || `call_${round}_${stream.toolCalls.indexOf(tc)}`, content: result });
			}
		}

		// Loop exhausted — return whatever the model has said so far, or a clear
		// error instead of failing the whole search.
		if (lastText.trim()) {
			return finalize(lastText.trim());
		}
		throw new Error(t("searchNoFinalAnswer"));
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

	/** Stream one OpenAI-compatible chat round (content buffered, no UI emit). */
	private async streamOpenAIChat(
		url: string,
		provider: ChatProvider,
		body: any,
	): Promise<{ content: string; toolCalls: any[]; usageTokens: number; cacheHits: number[] }> {
		const resp = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${provider.apiKey}`,
			},
			body: JSON.stringify(body),
		});
		if (resp.status !== 200) {
			const text = await resp.text();
			let parsed: any = {};
			try { parsed = JSON.parse(text); } catch { /* not JSON */ }
			throw this.extractError(resp.status, parsed);
		}

		let content = "";
		let usageTokens = 0;
		const cacheHits: number[] = [];
		// Tool calls accumulate by their stream index.
		const toolCalls: Record<number, any> = {};

		await this.readSSE(resp, (json) => {
			const delta = json?.choices?.[0]?.delta;
			if (typeof delta?.content === "string" && delta.content) {
				content += delta.content;
			}
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
				if (hit + miss > 0) cacheHits.push(hit / (hit + miss));
			}
		});

		const calls = Object.entries(toolCalls)
			.sort(([a], [b]) => Number(a) - Number(b))
			.map(([, call]) => ({ id: call.id, type: "function", function: call.function }));

		return { content, toolCalls: calls, usageTokens, cacheHits };
	}

	// ──── Anthropic format (streaming) ────

	private async chatAnthropic(
		provider: ChatProvider,
		model: string,
		contextWindow: number,
		systemPrompt: string,
		question: string,
		onToolCall?: (toolName: string, args: any) => void,
		thinking: ThinkingStep[] = [],
		usedNotes: string[] = [],
		onStream?: (text: string) => void,
	): Promise<ChatResult> {
		const baseUrl = provider.baseUrl.replace(/\/+$/, "");
		const tools = this.buildAnthropicTools();

		const messages: any[] = [{ role: "user", content: question }];

		// Latest assistant text (graceful fallback if the model never produces
		// a final answer), plus a guard against repeated identical tool calls.
		let lastText = "";
		const seenCalls = new Set<string>();
		// Context tokens reported by the API for the latest request.
		let usageTokens = 0;
		// Per-request cache hit ratios (Anthropic prompt caching).
		const cacheHits: number[] = [];

		const finalize = (answer: string): ChatResult => {
			const cacheHitRate = cacheHits.length
				? cacheHits.reduce((a, b) => a + b, 0) / cacheHits.length
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

		for (let round = 0; round < MAX_TOOL_ITERATIONS; round++) {
			const body: Record<string, any> = {
				model,
				max_tokens: 4096,
				system: systemPrompt,
				messages,
				stream: true,
			};
			if (tools.length > 0) body.tools = tools;

			const stream = await this.streamAnthropicChat(
				`${baseUrl}/v1/messages`,
				provider,
				body,
			);
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
					thinking.push({ type: "thought", text: b.text.trim() });
					lastText = b.text.trim();
				} else if (b?.type === "thinking" && b.thinking?.trim()) {
					thinking.push({ type: "thought", text: b.thinking.trim() });
				}
			}

			// Echo the assistant content blocks (including tool_use) back.
			messages.push({ role: "assistant", content: stream.contentBlocks });

			const toolResults: any[] = [];
			for (const tu of stream.toolUses) {
				const name = tu.name;
				const args = tu.input || {};

				// Stop if the model repeats the exact same call — it's looping.
				const callKey = `${name}|${JSON.stringify(args)}`;
				if (seenCalls.has(callKey)) {
					if (lastText) return finalize(lastText);
					throw new Error(t("searchNoFinalAnswer"));
				}
				seenCalls.add(callKey);

				onToolCall?.(name, args);
				const result = this.tools
					? await this.tools.execute(name, args)
					: `Error: no tools available (unknown tool "${name}")`;
				thinking.push({ type: "tool", name, args, result });
				this.collectUsedNotes(usedNotes, name, args, result);
				toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: result });
			}
			if (toolResults.length === 0) {
				throw new Error("Chat model requested a tool but none was called");
			}
			messages.push({ role: "user", content: toolResults });
		}

		// Loop exhausted — return whatever the model has said so far, or a clear
		// error instead of failing the whole search.
		if (lastText) {
			return finalize(lastText);
		}
		throw new Error(t("searchNoFinalAnswer"));
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
	): Promise<{
		contentBlocks: any[];
		toolUses: any[];
		stopReason: string;
		usageTokens: number;
		cacheHits: number[];
	}> {
		const resp = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": provider.apiKey,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify(body),
		});
		if (resp.status !== 200) {
			const text = await resp.text();
			let parsed: any = {};
			try { parsed = JSON.parse(text); } catch { /* not JSON */ }
			throw this.extractError(resp.status, parsed);
		}

		let usageTokens = 0;
		let stopReason = "";
		let text = "";
		const cacheHits: number[] = [];
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
					if (total > 0) cacheHits.push(hit / total);
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
		});

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

		return { contentBlocks, toolUses, stopReason, usageTokens, cacheHits };
	}

	/**
	 * Replay the final answer text to the UI in small increments, so the body
	 * streams without ever exposing interim tool-round "thinking" text.
	 */
	private async replay(text: string, onStream?: (text: string) => void): Promise<void> {
		if (!onStream || !text) return;
		const CHUNK = 12;
		const DELAY = 10;
		for (let i = CHUNK; i < text.length; i += CHUNK) {
			onStream(text.slice(0, i));
			await new Promise((resolve) => window.setTimeout(resolve, DELAY));
		}
		onStream(text);
	}

	// ──── Shared helpers ────

	/** Read an SSE response body, invoking onData for each parsed JSON event. */
	private async readSSE(resp: Response, onData: (json: any) => void): Promise<void> {
		const reader = resp.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		for (;;) {
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
