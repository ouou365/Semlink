// ========================================
// Semlink - Feishu Bot Service
// ========================================
// Runs one Feishu bot over the official SDK's WebSocket long connection
// (no public URL / no NAT traversal needed). Text messages received in the
// Feishu app are answered through the Semlink pipeline (search + chat) and
// replied to as a CardKit streaming card (typewriter effect).

import * as lark from "@larksuiteoapi/node-sdk";
import type { FeishuBotConfig } from "./types";
import type { ThinkingStep } from "./chat-client";
import { makeFeishuHttp, verifyFeishuApp } from "./feishu-auth";
import { installFeishuWebSocket } from "./feishu-ws";

/** Result of the Semlink QA pipeline (shared with the search view). */
export interface FeishuAnswer {
	answer: string;
	thinking: ThinkingStep[];
	usedNotes: string[];
}

/** A single turn in a multi-turn conversation. */
export interface ChatTurn {
	role: "user" | "assistant";
	content: string;
}

/** A live thinking event — fired as each tool is called during the Q&A. */
export interface ThinkingEvent {
	type: "thought" | "tool";
	text?: string;        // for "thought": the model's interim reasoning
	name?: string;        // for "tool": tool name
	args?: any;           // for "tool": tool args
	result?: string;      // for "tool": tool result
}

/** Runs embed → search → chat; onToken receives the growing answer text.
 * `history` carries prior turns for multi-turn context; `signal` allows /stop
 * to abort an in-flight request. `onThinking` fires per tool-call so callers
 * can stream the thinking trace live (e.g. into a collapsible panel). */
export type FeishuAskHandler = (
	question: string,
	onToken: (text: string) => void,
	history?: ChatTurn[],
	signal?: AbortSignal,
	onThinking?: (event: ThinkingEvent) => void,
) => Promise<FeishuAnswer>;

/**
 * If no inbound traffic arrives within this window, assume the WS is silently
 * dead and force a reconnect. The SDK's `autoReconnect` only fires on a `close`
 * /`error` event, which Electron can swallow under some network conditions —
 * so we keep our own liveness timer reset on every event. Generous because the
 * server only pings every ~120s; with no chat messages the wire can be quiet.
 */
const LIVENESS_TIMEOUT_MS = 5 * 60 * 1000;

export class FeishuBot {
	private config: FeishuBotConfig;
	private ask: FeishuAskHandler;
	private onStateChange?: (config: FeishuBotConfig) => void;

	private client: lark.Client | null = null;
	private wsClient: lark.WSClient | null = null;
	/** Owns a LoggerLevel.debug so the SDK's connect/reconnect trail shows up
	 * in the Obsidian console (it logs at debug/info, hidden at warn). */
	private loggerLevel: number = lark.LoggerLevel.debug;
	private livenessTimer: number | null = null;
	/** Chat IDs with an in-flight answer. Prevents concurrent answers in the
	 * same chat from racing on the card's monotonic sequence (which truncates
	 * or drops content) and from spawning duplicate cards. */
	private busyChats: Set<string> = new Set();
	/** Recently seen message IDs, to dedupe the Lark SDK's redelivery of the
	 * same event (happens on reconnect / ack racing) — without this, one user
	 * message triggers two answers and two cards. */
	private seenMessageIds: Map<string, number> = new Map();
	private dedupeWindowMs = 5 * 60 * 1000;

	// ── Conversational state per chat ──
	/** Conversation history per chatId: alternating user/assistant turns,
	 * supporting multi-turn Q&A (/new clears it). */
	private conversations: Map<string, Array<{ role: "user" | "assistant"; content: string }>> = new Map();
	/** AbortControllers for in-flight asks, so /stop can cancel them. */
	private activeAsks: Map<string, AbortController> = new Map();
	/** Cap on how many turns we keep, to bound context size. */
	private readonly MAX_HISTORY_TURNS = 10;
	private started = false;

	constructor(config: FeishuBotConfig, ask: FeishuAskHandler, onStateChange?: (config: FeishuBotConfig) => void) {
		this.config = config;
		this.ask = ask;
		this.onStateChange = onStateChange;
	}

	get isConnected(): boolean {
		return !!this.wsClient && this.config.connected;
	}

	/** Start the long-connection service. */
	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		console.log(`[Semlink] Feishu bot starting (appId=${this.config.appId})`);

		// The SDK's WSClient expects a Node-style WebSocket (the `ws` package);
		// Obsidian's renderer provides the browser one. Install the shim first.
		installFeishuWebSocket();

		// Pre-flight: a bad/unpublished app surfaces as a tenant_access_token
		// failure (code 10014 "app unauthorized", etc.). Fail fast with a clear
		// lastError instead of letting the WS hang silently with no signal.
		console.log("[Semlink] Feishu pre-flight: verifying app credentials…");
		const ok = await verifyFeishuApp(this.config.appId, this.config.appSecret);
		if (!ok) {
			const msg = "凭据无效或应用未发布（tenant_access_token 获取失败）。请到飞书开放平台确认应用已发布生效。";
			console.error("[Semlink] Feishu pre-flight FAILED:", msg);
			this.config.connected = false;
			this.config.lastError = msg;
			this.onStateChange?.(this.config);
			this.started = false;
			return;
		}
		console.log("[Semlink] Feishu pre-flight OK, starting WS long connection…");

		// The SDK's internal axios instance is blocked by CORS inside
		// Obsidian's renderer — route all its HTTP through requestUrl.
		const http = makeFeishuHttp();

		this.client = new lark.Client({
			appId: this.config.appId,
			appSecret: this.config.appSecret,
			domain: lark.Domain.Feishu,
			loggerLevel: this.loggerLevel,
			httpInstance: http,
		});

		const dispatcher = new lark.EventDispatcher({}).register({
			"im.message.receive_v1": async (data: any) => {
				this.touchLiveness();
				await this.handleMessage(data);
			},
		});

		this.wsClient = new lark.WSClient({
			appId: this.config.appId,
			appSecret: this.config.appSecret,
			domain: lark.Domain.Feishu,
			autoReconnect: true,
			httpInstance: http,
			onReady: () => {
				console.log("[Semlink] Feishu WS connected (onReady)");
				this.config.connected = true;
				this.config.lastError = undefined;
				this.onStateChange?.(this.config);
				this.touchLiveness();
			},
			onError: (err) => {
				console.error("[Semlink] Feishu WS error:", err);
				this.config.connected = false;
				this.config.lastError = err?.message || String(err);
				this.onStateChange?.(this.config);
			},
		});

		await this.wsClient.start({ eventDispatcher: dispatcher });
	}

	/**
	 * Reset the liveness watchdog. Called on every inbound event and on a
	 * successful (re)connect. If it ever fires, the WS is presumed dead and we
	 * force a full reconnect — the SDK's own autoReconnect only triggers on a
	 * close/error event that may never come in some network conditions.
	 */
	private touchLiveness(): void {
		if (this.livenessTimer !== null) {
			window.clearTimeout(this.livenessTimer);
		}
		this.livenessTimer = window.setTimeout(() => this.onLivenessTimeout(), LIVENESS_TIMEOUT_MS);
	}

	private async onLivenessTimeout(): Promise<void> {
		console.warn(`[Semlink] Feishu WS silent for ${LIVENESS_TIMEOUT_MS / 1000}s — forcing reconnect`);
		this.config.connected = false;
		this.onStateChange?.(this.config);
		// Tear down + restart from scratch. WSClient has no public "reconnect
		// now", so recreate the whole connection on a fresh generation.
		try {
			this.wsClient?.close();
		} catch {
			// ignore
		}
		this.wsClient = null;
		this.started = false;
		try {
			await this.start();
		} catch (e) {
			console.error("[Semlink] Feishu forced reconnect failed:", e);
			this.config.lastError = `重连失败：${e instanceof Error ? e.message : String(e)}`;
			this.onStateChange?.(this.config);
		}
	}

	async stop(): Promise<void> {
		if (this.livenessTimer !== null) {
			window.clearTimeout(this.livenessTimer);
			this.livenessTimer = null;
		}
		try {
			this.wsClient?.close();
		} catch {
			// ignore
		}
		this.wsClient = null;
		this.client = null;
		this.config.connected = false;
		this.started = false;
		this.onStateChange?.(this.config);
	}

	// ──── Message handling ────

	private async handleMessage(data: any): Promise<void> {
		// The Lark SDK's EventDispatcher hands us the unwrapped `event` payload
		// (so `data.message` / `data.sender`), but some SDK builds forward the
		// full `{ schema, header, event }` envelope — in which case the message
		// lives under `data.event.message`. Accept either shape.
		const event = data?.event ?? data;
		const message = event?.message;
		const sender = event?.sender;
		if (!message) {
			console.warn("[Semlink] Feishu event without message:", JSON.stringify(data)?.slice(0, 500));
			return;
		}

		// Dedupe by message_id: the SDK can redeliver the same event on
		// reconnect/ack races, which would otherwise spawn duplicate cards.
		const msgId: string = message.message_id || "";
		if (msgId) {
			const now = Date.now();
			// Opportunistic GC: drop entries older than the window.
			for (const [id, ts] of this.seenMessageIds) {
				if (now - ts > this.dedupeWindowMs) this.seenMessageIds.delete(id);
			}
			if (this.seenMessageIds.has(msgId)) {
				console.log(`[Semlink] Feishu duplicate event ${msgId} — skipping`);
				return;
			}
			this.seenMessageIds.set(msgId, now);
		}
		console.log("[Semlink] Feishu event received:", data?.event_type || data?.header?.event_type || "im.message.receive_v1", msgId ? `msg=${msgId}` : "(no msg id)");

		const chatType: string = message.chat_type; // "p2p" | "group"
		const chatId: string = message.chat_id;
		const senderOpenId: string = sender?.sender_id?.open_id || sender?.open_id || "";

		let text = "";
		try {
			const content = JSON.parse(message.content || "{}");
			text = content.text || "";
		} catch {
			// not JSON content
		}
		// Strip the @-mention placeholder the group client prepends (e.g.
		// "@_user_1 /bind ABC") so the command regex can still anchor at ^.
		text = (text || "").replace(/@_user_\d+\s*/g, "").trim();

		// `/bind <code>` — the one-time binding confirmation (ZCode-style flow).
		// Intercepted before the generic command guard and the p2p/group
		// filters below, so the binding user can confirm from any chat and it
		// also doubles as an end-to-end check that events actually arrive.
		const bindMatch = text.match(/^\/bind[:\s]+([^\s]+)$/i);
		if (bindMatch) {
			console.log(`[Semlink] /bind matched, chatId=${chatId}, sender=${senderOpenId}`);
			await this.handleBind(chatId, bindMatch[1], senderOpenId);
			return;
		}

		// /stop works even while busy (it cancels the in-flight answer), so
		// handle it before the busy guard.
		if (/^\/stop$/i.test(text)) {
			await this.handleStop(chatId);
			return;
		}

		if (!text || text.startsWith("/")) {
			// Slash commands we DO handle below; anything else is ignored.
			if (!/^\/(new|status)$/i.test(text)) {
				console.log("[Semlink] Feishu message ignored (empty/command):", JSON.stringify(text).slice(0, 100));
				return;
			}
		}

		// Private chats: only respond to the binding user (if known).
		if (chatType === "p2p" && this.config.userOpenId && senderOpenId !== this.config.userOpenId) {
			console.log(`[Semlink] Ignoring p2p message from ${senderOpenId} (bot bound to ${this.config.userOpenId})`);
			return;
		}
		// Groups: only respond when the bot is @-mentioned.
		if (chatType === "group" && !this.isBotMentioned(event)) {
			console.log("[Semlink] Ignoring group message without @mention");
			return;
		}

		// /new and /status are handled here (after the auth/mention filters).
		if (/^\/new$/i.test(text)) {
			this.conversations.delete(chatId);
			await this.sendText(chatId, "✨ 已新建会话，历史已清空。").catch(() => {});
			return;
		}
		if (/^\/status$/i.test(text)) {
			await this.handleStatus(chatId);
			return;
		}

		// Guard: only one answer per chat at a time. A second message while the
		// first is still streaming would create a second card and the two would
		// race on their card sequences, truncating each other's content.
		if (this.busyChats.has(chatId)) {
			console.log(`[Semlink] ${chatId} busy, skipping duplicate message`);
			await this.sendText(chatId, "⏳ 上一条消息还在回复中，请稍候再发。").catch(() => {});
			return;
		}
		this.busyChats.add(chatId);
		// React immediately so the user sees the bot is working on it.
		const reactionId = msgId ? await this.reactToMessage(msgId, "Get") : "";
		try {
			console.log(`[Semlink] Answering "${text.slice(0, 50)}" in ${chatType} ${chatId}`);
			await this.answerWithCard(chatId, text);
		} finally {
			// Answer delivered — remove the reaction.
			if (reactionId && msgId) this.removeReaction(msgId, reactionId);
			this.busyChats.delete(chatId);
		}
	}

	private isBotMentioned(event: any): boolean {
		const mentions = event?.message?.mentions || [];
		if (Array.isArray(mentions)) {
			for (const m of mentions) {
				// The self-mention is flagged when the mentioned id matches the
				// bot's own open_id (sdk fills `id.open_id`), or via the
				// `is_self`/`mention_type:"self"` markers on some SDK builds.
				if (m?.is_self || m?.mention_type === "self" || m?.mentioned_type === "self") return true;
			}
		}
		return false;
	}

	/**
	 * Extract a readable message from a Lark SDK error. The SDK throws axios-
	 * like errors (built by makeFeishuHttp): the HTTP status is on `.message`
	 * but Feishu's own `{ code, msg }` lives in `error.response.data`. Without
	 * unwrapping it, a 400 shows only "status code 400" — useless for triage.
	 */
	private describeError(e: unknown): string {
		const err = e as any;
		const body = err?.response?.data;
		// Feishu API error body: { code, msg, data? }
		if (body && typeof body === "object" && (body.code != null || body.msg)) {
			return `飞书错误 code=${body.code}：${body.msg || err.message}`;
		}
		// Some failures surface a nested axios error string.
		if (err?.response?.status) {
			return `HTTP ${err.response.status}：${err.message}（${typeof body === "string" ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200)}）`;
		}
		return err instanceof Error ? err.message : String(e);
	}

	/**
	 * Send a message to a chat. Feishu's `im/v1/messages` expects
	 * `receive_id_type` as a query param but `receive_id` in the BODY — if it
	 * lands in the query string (where the SDK puts it via `params`) the API
	 * rejects it with `code=230001 invalid receive_id`. So we move receive_id
	 * into the data payload explicitly.
	 */
	private async sendMessage(chatId: string, msgType: string, content: string): Promise<void> {
		const client = this.client;
		if (!client) throw new Error("client not ready");
		await client.im.message.create({
			params: { receive_id_type: "chat_id" },
			data: { receive_id: chatId, msg_type: msgType, content },
		});
	}

	/** Convenience wrapper for plain-text replies. */
	private async sendText(chatId: string, text: string): Promise<void> {
		await this.sendMessage(chatId, "text", JSON.stringify({ text }));
	}

	/**
	 * /stop — cancel the in-flight answer for this chat. Aborts the active
	 * AbortController (which the ask pipeline checks) and frees the busy slot.
	 */
	private async handleStop(chatId: string): Promise<void> {
		const controller = this.activeAsks.get(chatId);
		if (controller) {
			controller.abort();
			this.activeAsks.delete(chatId);
			console.log(`[Semlink] /stop: aborted ask for ${chatId}`);
			await this.sendText(chatId, "⏹ 已停止当前回复。").catch(() => {});
		} else {
			await this.sendText(chatId, "（当前没有进行中的回复）").catch(() => {});
		}
	}

	/**
	 * /status — report the current conversation's context statistics: number
	 * of turns, approximate token usage, and history length.
	 */
	private async handleStatus(chatId: string): Promise<void> {
		const history = this.conversations.get(chatId);
		if (!history || history.length === 0) {
			await this.sendText(chatId, "📊 当前会话：尚无对话历史。\n\n发送 /new 可新建会话。").catch(() => {});
			return;
		}
		const turns = Math.ceil(history.length / 2);
		const totalChars = history.reduce((sum, m) => sum + m.content.length, 0);
		// Rough token estimate (~1.5 chars per token for CJK + markdown).
		const approxTokens = Math.round(totalChars / 1.5);
		const lines = [
			"📊 当前会话统计",
			`• 对话轮数：${turns}`,
			`• 历史消息：${history.length} 条`,
			`• 文本长度：${totalChars} 字符`,
			`• 预估 token：≈${approxTokens}`,
			"",
			"发送 /new 新建会话，/stop 停止当前回复。",
		];
		await this.sendText(chatId, lines.join("\n")).catch(() => {});
	}

	/** Append a turn to a chat's history, capping total turns to bound context. */
	private recordTurn(chatId: string, turn: ChatTurn): void {
		const hist = this.conversations.get(chatId) || [];
		hist.push(turn);
		// Keep the most recent MAX_HISTORY_TURNS turns (each turn = 2 messages).
		while (hist.length > this.MAX_HISTORY_TURNS * 2) hist.shift();
		this.conversations.set(chatId, hist);
	}

	/**
	 * Add an emoji reaction to a message and return its reaction_id (so the
	 * caller can later remove it). Resolves to "" on failure; never throws.
	 */
	private async reactToMessage(messageId: string, emojiType: string): Promise<string> {
		const client = this.client;
		if (!client) return "";
		try {
			const res: any = await client.im.messageReaction.create({
				path: { message_id: messageId },
				data: { reaction_type: { emoji_type: emojiType } },
			} as any);
			return res?.data?.reaction_id || "";
		} catch (e) {
			console.warn("[Semlink] add reaction failed:", this.describeError(e));
			return "";
		}
	}

	/** Remove a previously-added reaction by its reaction_id. Fire-and-forget. */
	private removeReaction(messageId: string, reactionId: string): void {
		const client = this.client;
		if (!client || !reactionId) return;
		client.im.messageReaction.delete({
			path: { message_id: messageId, reaction_id: reactionId },
		} as any).catch((e: any) => {
			console.warn("[Semlink] remove reaction failed:", this.describeError(e));
		});
	}

	/**
	 * Confirm the binding: the code must match this bot's one-time bind code.
	 * On success the sender becomes the bound user and the bot confirms with a
	 * plain text reply (a card would be overkill for a control message).
	 */
	private async handleBind(chatId: string, code: string, sender: string): Promise<void> {
		const client = this.client;
		if (!client) return;

		const ok = this.config.bindCode && code.trim().toUpperCase() === this.config.bindCode.toUpperCase();
		if (ok) {
			if (!this.config.userOpenId) this.config.userOpenId = sender;
			this.config.bound = true;
			this.onStateChange?.(this.config);
			console.log(`[Semlink] Feishu bot bound by ${sender}`);
		}
		const reply = ok ? "✅ 绑定成功！现在可以直接向我提问笔记内容啦。" : "❌ 绑定码不正确，请检查后重试。";

		try {
			await this.sendText(chatId, reply);
			console.log("[Semlink] Feishu bind reply sent");
		} catch (e) {
			// Reply failed but binding state already persisted above. Surface
			// the cause as lastError so the user sees WHY no reply came back
			// (often a missing `im:message:send_as_bot` scope) instead of a
			// silent dead end.
			const msg = this.describeError(e);
			console.error("[Semlink] Feishu bind reply failed:", msg, e);
			this.config.lastError = `绑定${ok ? "成功" : "失败"}，但回复消息发送失败：${msg}`;
			this.onStateChange?.(this.config);
		}
	}

	// ──── Reply flow: instant ack → full answer card ────
	// We do NOT stream over cardkit (each cardElement.content round-trip is
	// ~600ms, far slower than Semlink's instant DOM updates). Instead:
	//   1. Send an immediate plain-text "searching…" so the user isn't left
	//      waiting in silence (the Get emoji + this message = clear "working").
	//   2. Call ask WITHOUT onToken (chat-client skips the fake replay stream),
	//      wait for the complete answer.
	//   3. Send ONE card: full answer + collapsible thinking & sources.
	// Total latency ≈ LLM response time + one cardkit create.

	private async answerWithCard(chatId: string, question: string): Promise<void> {
		const client = this.client;
		if (!client) return;

		try {
			// AbortController lets /stop cancel this ask.
			const controller = new AbortController();
			this.activeAsks.set(chatId, controller);
			const history = this.conversations.get(chatId) || [];

			// ── "Skip-line" streaming thinking trace ──
			// Each tool call shows ONLY its latest line in the card (not the
			// accumulated history). Updates are strictly serialized: we await each
			// cardkit round-trip before sending the next, so requests never pile
			// up. The first event creates the streaming card; the complete trace
			// (all steps) is written into the collapsible panel at the end.
			let cardId: string | null = null;
			let sequence = 0;
			let inflight: Promise<void> = Promise.resolve();

			const sendCard = async (content: string): Promise<void> => {
				sequence++;
				await (client.cardkit.v1.cardElement as any).content({
					path: { card_id: cardId, element_id: "thinking" },
					data: { content, sequence, uuid: `t_${cardId}_${sequence}` },
				} as any).catch((e: any) => {
					console.warn("[Semlink] thinking update failed:", this.describeError(e));
				});
			};

			const ensureCard = async (): Promise<void> => {
				if (cardId) return;
				const cardJson = {
					schema: "2.0",
					config: { streaming_mode: true, update_multi: true },
					body: {
						elements: [
							{ tag: "markdown", element_id: "thinking", content: "根据笔记内容回答..." },
						],
					},
				};
				const created = await client.cardkit.v1.card.create({
					data: { type: "card_json", data: JSON.stringify(cardJson) },
				});
				const id = created?.data?.card_id;
				if (!id) throw new Error("create card entity failed");
				cardId = id;
				const cardContent = JSON.stringify({
					type: "card",
					data: { card_id: id },
					card_uri: `card://${id}`,
				});
				await this.sendMessage(chatId, "interactive", cardContent);
			};

			const onThinking = (event: ThinkingEvent): void => {
				// Render only the LATEST line (skip-line), not the full history.
				// Serialize on inflight so each cardkit round-trip completes before
				// the next update fires — no request pile-up.
				// Show only the tool NAME (no args) in the live stream — the full
				// call details live in the collapsible panel on the final card.
				if (event.type === "tool") {
					const line = `🔧 正在调用 ${event.name}`;
					inflight = inflight.then(() => ensureCard().then(() => sendCard(line)));
				} else if (event.type === "thought" && event.text) {
					inflight = inflight.then(() => ensureCard().then(() => sendCard(`💭 ${event.text}`)));
				}
			};

			// Once the LLM starts emitting the final answer (onToken fires), switch
			// the card to an animated "生成回答中." → ".." → "..." → "." loop. Each
			// step waits for the previous cardkit round-trip, so it never piles up.
			let answerStarted = false;
			const onToken = (_text: string): void => {
				if (answerStarted) return; // only trigger once
				answerStarted = true;
				const dots = [".", "..", "..."];
				let i = 0;
				const pump = (): void => {
					if (!answerStarted) return; // stopped (answer complete)
					inflight = inflight.then(() => ensureCard().then(() => sendCard(`✍️ 生成回答中${dots[i % 3]}`))).then(() => {
						if (answerStarted) { i++; pump(); }
					});
				};
				pump();
			};

			let result: FeishuAnswer;
			try {
				// onToken triggers the "generating answer" animation; onThinking
				// streams the latest tool-call line live (skip-line, serialized).
				result = await this.ask(question, onToken, history, controller.signal, onThinking);
			} catch (e) {
				this.activeAsks.delete(chatId);
				if (controller.signal.aborted) {
					// /stop — close the streaming card if one was created.
					await inflight;
					if (cardId) {
						sequence++;
						await (client.cardkit.v1.card as any).settings({
							path: { card_id: cardId },
							data: { settings: JSON.stringify({ config: { streaming_mode: false } }), sequence, uuid: `s_${cardId}_${sequence}` },
						} as any).catch(() => {});
					}
					return;
				}
				throw e;
			}
			// Stop the "generating answer" animation — the real answer is ready.
			answerStarted = false;
			// Wait for any in-flight card update before rewriting the card.
			await inflight;
			this.activeAsks.delete(chatId);

			// Record this turn for multi-turn context.
			this.recordTurn(chatId, { role: "user", content: question });
			this.recordTurn(chatId, { role: "assistant", content: result.answer });

			// ── Final card: full answer → collapsible thinking → sources ──
			const finalElements: any[] = [];
			finalElements.push({ tag: "markdown", content: result.answer });
			if (result.thinking.length > 0) {
				finalElements.push(this.buildThinkingPanel(result.thinking));
			}
			if (result.usedNotes.length > 0) {
				finalElements.push(this.buildSourcesPanel(result.usedNotes));
			}

			if (cardId) {
				// Rewrite the streaming card with the final layout.
				sequence++;
				await (client.cardkit.v1.card as any).update({
					path: { card_id: cardId },
					data: {
						card: {
							type: "card_json",
							data: JSON.stringify({
								schema: "2.0",
								config: { streaming_mode: false, update_multi: true },
								body: { elements: finalElements },
							}),
						},
						sequence,
						uuid: `u_${cardId}_${sequence}`,
					},
				} as any).catch((e: any) => {
					console.warn("[Semlink] card.update (finalize) failed:", this.describeError(e));
				});
			} else {
				// No thinking card was created (LLM answered without tools).
				const cardJson = {
					schema: "2.0",
					config: { update_multi: true },
					body: { elements: finalElements },
				};
				const created = await client.cardkit.v1.card.create({
					data: { type: "card_json", data: JSON.stringify(cardJson) },
				});
				const id = created?.data?.card_id;
				if (!id) throw new Error("create card entity failed");
				const cardContent = JSON.stringify({
					type: "card",
					data: { card_id: id },
					card_uri: `card://${id}`,
				});
				await this.sendMessage(chatId, "interactive", cardContent);
			}
		} catch (e) {
			const msg = this.describeError(e);
			console.error("[Semlink] Feishu reply failed:", msg);
			try {
				await this.sendText(chatId, `⚠️ 回复失败：${msg}`);
			} catch (e2) {
				console.error("[Semlink] Feishu fallback reply also failed:", this.describeError(e2));
			}
		}
	}

	/**
	 * Build a collapsible_panel element holding the thinking trace (tool calls
	 * + interim thoughts). Collapsed by default so the answer stays the focus.
	 */
	private buildThinkingPanel(thinking: ThinkingStep[]): any {
		const lines = thinking.map((s) =>
			s.type === "thought" ? `💭 ${s.text}` : `🔧 ${s.name}(${JSON.stringify(s.args || {})})`
		);
		return {
			tag: "collapsible_panel",
			expanded: false,
			header: {
				title: { tag: "plain_text", content: `🧠 思考过程（${thinking.length}）` },
				vertical_align: "center",
				icon: {
					tag: "standard_icon",
					token: "down-small-ccm_outlined",
					size: "16px 16px",
				},
				icon_position: "right",
				icon_expanded_angle: -180,
			},
			border: { color: "grey", corner_radius: "5px" },
			padding: "8px 8px 8px 8px",
			elements: [
				{ tag: "markdown", content: lines.join("\n\n") },
			],
		};
	}

	/**
	 * Build a collapsible_panel element holding the reference sources. Collapsed
	 * by default so the answer stays the visual focus; users tap to expand.
	 */
	private buildSourcesPanel(usedNotes: string[]): any {
		const list = usedNotes.map((p, i) => `${i + 1}. ${p}`).join("\n");
		return {
			tag: "collapsible_panel",
			expanded: false,
			header: {
				title: { tag: "plain_text", content: `📎 参考来源（${usedNotes.length}）` },
				vertical_align: "center",
				icon: {
					tag: "standard_icon",
					token: "down-small-ccm_outlined",
					size: "16px 16px",
				},
				icon_position: "right",
				icon_expanded_angle: -180,
			},
			border: { color: "grey", corner_radius: "5px" },
			padding: "8px 8px 8px 8px",
			elements: [
				{ tag: "markdown", content: list },
			],
		};
	}
}
