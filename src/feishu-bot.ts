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
import { makeFeishuHttp } from "./feishu-auth";
import { installFeishuWebSocket } from "./feishu-ws";

/** Result of the Semlink QA pipeline (shared with the search view). */
export interface FeishuAnswer {
	answer: string;
	thinking: ThinkingStep[];
	usedNotes: string[];
}

/** Runs embed → search → chat; onToken receives the growing answer text. */
export type FeishuAskHandler = (
	question: string,
	onToken: (text: string) => void,
) => Promise<FeishuAnswer>;

/** Card updates are throttled to this interval to respect Feishu limits. */
const CARD_FLUSH_MS = 400;

export class FeishuBot {
	private config: FeishuBotConfig;
	private ask: FeishuAskHandler;
	private onStateChange?: (config: FeishuBotConfig) => void;

	private client: lark.Client | null = null;
	private wsClient: lark.WSClient | null = null;

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
		// The SDK's WSClient expects a Node-style WebSocket (the `ws` package);
		// Obsidian's renderer provides the browser one. Install the shim first.
		installFeishuWebSocket();

		// The SDK's internal axios instance is blocked by CORS inside
		// Obsidian's renderer — route all its HTTP through requestUrl.
		const http = makeFeishuHttp();

		this.client = new lark.Client({
			appId: this.config.appId,
			appSecret: this.config.appSecret,
			domain: lark.Domain.Feishu,
			loggerLevel: lark.LoggerLevel.warn,
			httpInstance: http,
		});

		const dispatcher = new lark.EventDispatcher({}).register({
			"im.message.receive_v1": async (data: any) => {
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
				this.config.connected = true;
				this.config.lastError = undefined;
				this.onStateChange?.(this.config);
			},
			onError: (err) => {
				this.config.connected = false;
				this.config.lastError = err?.message || String(err);
				this.onStateChange?.(this.config);
			},
		});

		await this.wsClient.start({ eventDispatcher: dispatcher });
	}

	async stop(): Promise<void> {
		try {
			this.wsClient?.close();
		} catch {
			// ignore
		}
		this.wsClient = null;
		this.client = null;
		this.config.connected = false;
		this.onStateChange?.(this.config);
	}

	// ──── Message handling ────

	private async handleMessage(data: any): Promise<void> {
		console.log("[Semlink] Feishu event received:", data?.event_type || "im.message.receive_v1");
		const message = data?.message;
		if (!message) {
			console.warn("[Semlink] Feishu event without message:", JSON.stringify(data)?.slice(0, 300));
			return;
		}

		const chatType: string = message.chat_type; // "p2p" | "group"
		const chatId: string = message.chat_id;
		const sender: string = data?.sender?.sender_id?.open_id || data?.sender?.open_id || "";

		let text = "";
		try {
			const content = JSON.parse(message.content || "{}");
			text = content.text || "";
		} catch {
			// not JSON content
		}
		text = (text || "").trim();

		// `/bind <code>` — the one-time binding confirmation (ZCode-style flow).
		// Intercepted before the generic command guard and the p2p/group
		// filters below, so the binding user can confirm from any chat and it
		// also doubles as an end-to-end check that events actually arrive.
		const bindMatch = text.match(/^\/bind[:\s]+([^\s]+)$/i);
		if (bindMatch) {
			await this.handleBind(chatId, bindMatch[1], sender);
			return;
		}

		if (!text || text.startsWith("/")) {
			console.log("[Semlink] Feishu message ignored (empty/command):", JSON.stringify(text).slice(0, 100));
			return;
		}

		// Private chats: only respond to the binding user (if known).
		if (chatType === "p2p" && this.config.userOpenId && sender !== this.config.userOpenId) {
			console.log(`[Semlink] Ignoring p2p message from ${sender} (bot bound to ${this.config.userOpenId})`);
			return;
		}
		// Groups: only respond when the bot is @-mentioned.
		if (chatType === "group" && !this.isBotMentioned(data)) {
			console.log("[Semlink] Ignoring group message without @mention");
			return;
		}

		console.log(`[Semlink] Answering "${text.slice(0, 50)}" in ${chatType} ${chatId}`);
		await this.answerWithCard(chatId, text);
	}

	private isBotMentioned(data: any): boolean {
		const mentions = data?.message?.mentions || data?.mentions || [];
		if (Array.isArray(mentions)) {
			for (const m of mentions) {
				if (m?.is_self || m?.mention_type === "self" || m?.mentioned_type === "self") return true;
			}
		}
		return false;
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
			await client.im.message.create({
				params: { receive_id_type: "chat_id", receive_id: chatId },
				data: { msg_type: "text", content: JSON.stringify({ text: reply }) },
			});
		} catch (e) {
			console.error("[Semlink] Feishu bind reply failed:", e);
		}
	}

	// ──── Streaming card reply ────

	private async answerWithCard(chatId: string, question: string): Promise<void> {
		const client = this.client;
		if (!client) return;

		try {
			const cardJson = {
				config: { streaming_mode: true },
				header: { title: { tag: "plain_text", content: `Semlink · ${question.slice(0, 20)}` } },
				body: {
					elements: [
						{ tag: "markdown", element_id: "thinking", content: "**思考中…**" },
						{ tag: "markdown", element_id: "answer", content: "" },
						{ tag: "markdown", element_id: "sources", content: "" },
					],
				},
			};

			const created = await client.cardkit.v1.card.create({
				data: { type: "card_json", data: JSON.stringify(cardJson) },
			});
			const cardId = created?.data?.card_id;
			if (!cardId) throw new Error("create card entity failed");

			await client.im.message.create({
				params: { receive_id_type: "chat_id", receive_id: chatId },
				data: { msg_type: "interactive", content: JSON.stringify({ card_id: cardId }) },
			});

			let sequence = 0;
			const streamElement = async (elementId: string, content: string): Promise<void> => {
				sequence++;
				await client.cardkit.v1.cardElement.content.update({
					path: { card_id: cardId, element_id: elementId },
					data: { sequence, content },
				}).catch(() => {});
			};

			// Throttle answer streaming (chat emits tokens faster than Feishu
			// should be called); always flush the final text.
			let latest = "";
			let timer: number | null = null;
			const flush = () => {
				if (timer !== null) {
					window.clearTimeout(timer);
					timer = null;
				}
				void streamElement("answer", latest);
			};

			try {
				const result = await this.ask(question, (text) => {
					latest = text;
					if (timer === null) {
						timer = window.setTimeout(flush, CARD_FLUSH_MS);
					}
				});

				if (timer !== null) {
					window.clearTimeout(timer);
					timer = null;
				}
				await streamElement("thinking", this.renderThinking(result.thinking));
				await streamElement("answer", result.answer);
				await streamElement("sources", this.renderSources(result.usedNotes));
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				await streamElement("answer", `⚠️ ${msg}`);
			}

			// Close streaming mode so the card is final.
			sequence++;
			await client.cardkit.v1.card.settings.update({
				path: { card_id: cardId },
				data: { settings: JSON.stringify({ config: { streaming_mode: false } }), sequence },
			}).catch(() => {});
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error("[Semlink] Feishu reply failed:", msg);
			// Fall back to a plain-text reply so failures are visible in Feishu.
			try {
				await client.im.message.create({
					params: { receive_id_type: "chat_id", receive_id: chatId },
					data: { msg_type: "text", content: JSON.stringify({ text: `⚠️ ${msg}` }) },
				});
			} catch {
				// give up
			}
		}
	}

	private renderThinking(thinking: ThinkingStep[]): string {
		if (thinking.length === 0) return "**思考过程**\n（无）";
		const lines = thinking.map((s) =>
			s.type === "thought" ? `> 💭 ${s.text}` : `> 🔧 ${s.name}`
		);
		return `**思考过程**\n${lines.join("\n\n")}`;
	}

	private renderSources(usedNotes: string[]): string {
		if (usedNotes.length === 0) return "";
		return `**参考来源**\n${usedNotes.map((p, i) => `${i + 1}. ${p}`).join("\n")}`;
	}
}
