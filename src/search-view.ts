// ========================================
// Semlink - Semantic Search View (Right Sidebar)
// ========================================
// A sidebar panel that lets the user type a natural-language query, runs it
// through the same embed → search pipeline the MCP server uses. Each turn = a
// user query bubble followed by the chat model's answer (grounded in the
// retrieved notes), with a collapsible list of source note cards. If no chat
// provider is configured, it falls back to showing the raw result list.

import { ItemView, MarkdownRenderer, MarkdownView, WorkspaceLeaf, TFile, Vault, Notice, setIcon } from "obsidian";
import type { VectorStore } from "./vector-store";
import type { EmbeddingClient } from "./embedding-client";
import type { ChatClient, ThinkingStep, ContextBreakdown } from "./chat-client";
import type { SearchResult, ChatSession, HistoryMessage } from "./types";
import { ChatHistoryStore } from "./chat-history";
import { SaveNoteModal } from "./save-note-modal";
import { t } from "./i18n";
import logoSvg from "./semlink-logo.svg";

export const SEARCH_VIEW_TYPE = "semlink-semantic-search";

const DEFAULT_LIMIT = 10;
const DEFAULT_THRESHOLD = 0.3;
/** Number of top results fed into the chat model as context. */
const ANSWER_CONTEXT_SIZE = 5;

export class SemanticSearchView extends ItemView {
	private store: VectorStore;
	private client: EmbeddingClient;
	private chatClient: ChatClient;
	private vault: Vault;
	private history: ChatHistoryStore;

	// DOM references
	private inputEl!: HTMLTextAreaElement;
	private messagesEl!: HTMLElement; // scrollable conversation area
	private statusEl!: HTMLElement;   // transient status (no-api-key hint)
	private contextRingEl!: HTMLElement | null; // context-usage donut
	private contextPctEl!: HTMLElement | null;
	private tooltipEl!: HTMLElement | null; // context-usage tooltip
	private lastBreakdown: ContextBreakdown | null = null;
	private lastCacheHitRate: number | null = null;
	private searchDepth: "standard" | "enhanced" = "standard";
	private depthTriggerEl: HTMLElement | null = null;
	private depthPopupEl: HTMLElement | null = null;

	// Current conversation state
	private currentSessionId: string | null = null;
	private currentMessages: HistoryMessage[] = [];

	constructor(
		leaf: WorkspaceLeaf,
		store: VectorStore,
		client: EmbeddingClient,
		vault: Vault,
		chatClient: ChatClient,
		dataDir: string,
	) {
		super(leaf);
		this.store = store;
		this.client = client;
		this.vault = vault;
		this.chatClient = chatClient;
		this.history = new ChatHistoryStore(dataDir);
	}

	getViewType(): string {
		return SEARCH_VIEW_TYPE;
	}

	getDisplayText(): string {
		return t("searchViewTitle");
	}

	getIcon(): string {
		return "semlink-logo";
	}

	protected async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("semlink-search-view");

		// ── Header (top, fixed) — left icons | centered brand | right icons ──
		const header = contentEl.createDiv({ cls: "semlink-search-header" });
		// Left icon group: history menu + new-session (pencil).
		const leftIcons = header.createDiv({ cls: "semlink-search-header-side" });
		const menuBtn = leftIcons.createEl("button", {
			cls: "semlink-search-icon-btn clickable-icon",
			attr: { "aria-label": t("historyTitle"), title: t("historyTitle") },
		});
		setIcon(menuBtn, "menu");
		menuBtn.addEventListener("click", () => this.showHistoryDrawer());
		const newChatBtn = leftIcons.createEl("button", {
			cls: "semlink-search-icon-btn clickable-icon",
			attr: { "aria-label": t("searchNewChat"), title: t("searchNewChat") },
		});
		setIcon(newChatBtn, "pencil");
		newChatBtn.addEventListener("click", () => {
			this.startNewSession();
			this.messagesEl.empty();
			this.statusEl.textContent = "";
			this.inputEl.value = "";
			this.renderWelcome();
			this.inputEl.focus();
		});
		// Centered brand (logo + "Semlink").
		const brand = header.createDiv({ cls: "semlink-search-brand-group" });
		const logoEl = brand.createDiv({ cls: "semlink-search-logo" });
		logoEl.innerHTML = logoSvg;
		brand.createDiv({ cls: "semlink-search-brand", text: "Semlink" });
		// Right icon group: settings.
		const rightIcons = header.createDiv({ cls: "semlink-search-header-side semlink-search-header-right" });
		const settingsBtn = rightIcons.createEl("button", {
			cls: "semlink-search-icon-btn clickable-icon",
			attr: { "aria-label": t("settingsTitle"), title: t("settingsTitle") },
		});
		setIcon(settingsBtn, "settings");
		settingsBtn.addEventListener("click", () => {
			(this.app as any).setting.open();
			(this.app as any).setting.openTabById("semlink");
		});

		// ── Conversation area (middle, scrollable) ──
		this.statusEl = contentEl.createDiv({ cls: "semlink-search-status" });
		this.messagesEl = contentEl.createDiv({ cls: "semlink-search-messages" });
		this.renderWelcome();

		// ── Input footer (bottom, fixed) ──
		const footer = contentEl.createDiv({ cls: "semlink-search-footer" });

		const wrapper = footer.createDiv({ cls: "semlink-search-input-wrapper" });
		const inputRow = wrapper.createDiv({ cls: "semlink-search-input-row" });
		this.inputEl = inputRow.createEl("textarea", {
			cls: "semlink-search-input",
			rows: 5,
			attr: { placeholder: t("searchPlaceholder"), "aria-label": t("searchPlaceholder") },
		});
		this.inputEl.addEventListener("keydown", (e) => {
			// Enter sends; Shift+Enter inserts a newline.
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				void this.runSearch();
				// Scroll to the bottom right away so the new message and the
				// loading state are immediately visible.
				this.scrollToBottom();
			}
		});

		const searchBtn = inputRow.createEl("button", {
			cls: "semlink-search-btn",
			attr: { "aria-label": t("searchSend"), title: t("searchSend") },
		});
		setIcon(searchBtn, "send");
		searchBtn.addEventListener("click", () => {
			void this.runSearch();
			this.scrollToBottom();
		});

		// Active chat model indicator inside the input box, with a donut
		// showing how much of the context window the current turn uses.
		const modelEl = wrapper.createDiv({ cls: "semlink-search-model" });
		const modelLabel = this.chatClient.getActiveModelLabel();
		modelEl.createSpan({ cls: "semlink-search-model-name", text: modelLabel || t("searchNoChatModel") });
		if (modelLabel && this.chatClient.getActiveContextWindow()) {
			// Ring + percentage form the context-usage indicator; the tooltip
			// only triggers when hovering THIS part of the row (not the depth
			// selector next to it).
			const usageEl = modelEl.createDiv({ cls: "semlink-context-usage" });
			const ringEl = usageEl.createDiv({ cls: "semlink-context-ring" });
			ringEl.innerHTML =
				'<svg viewBox="0 0 36 36">' +
				'<circle class="ring-bg" cx="18" cy="18" r="15.9"></circle>' +
				'<circle class="ring-fg" cx="18" cy="18" r="15.9"></circle>' +
				"</svg>";
			this.contextRingEl = ringEl;
			this.contextPctEl = usageEl.createSpan({ cls: "semlink-context-pct", text: "0%" });

			// Tooltip with the context breakdown, shown on hover. Created
			// lazily on document.body so `position: fixed` is never thrown off
			// by transformed/clipping ancestors inside the Obsidian leaf.
			this.tooltipEl = null;
			usageEl.addEventListener("mouseenter", () => this.showContextTooltip());
			usageEl.addEventListener("mouseleave", () => this.hideContextTooltip());
		} else {
			this.contextRingEl = null;
			this.contextPctEl = null;
			this.tooltipEl = null;
		}

		// Search depth selector on the same row as the model indicator:
		// standard (get_section, small reads) vs enhanced (full get_note reads).
		// A custom trigger + popup (no native select) so the popup can open
		// ABOVE the trigger — the input sits at the bottom edge of the window.
		const depthEl = modelEl.createSpan({ cls: "semlink-search-depth" });
		depthEl.createSpan({ cls: "semlink-search-depth-label", text: t("searchDepthLabel") });
		const depthTrigger = depthEl.createSpan({ cls: "semlink-search-depth-trigger" });
		depthTrigger.createSpan({ cls: "semlink-search-depth-trigger-text", text: this.depthLabel() });
		depthTrigger.createSpan({ cls: "semlink-search-depth-trigger-chevron", text: "▾" });
		depthTrigger.addEventListener("click", (e) => {
			e.stopPropagation();
			this.toggleDepthPopup();
		});
		this.depthTriggerEl = depthTrigger;
		this.registerDomEvent(document, "click", () => this.hideDepthPopup());

		if (!this.hasApiKey()) {
			this.statusEl.textContent = t("searchNeedApiKey");
		}
	}

	protected async onClose(): Promise<void> {
		if (this.tooltipEl) {
			this.tooltipEl.remove();
			this.tooltipEl = null;
		}
		if (this.depthPopupEl) {
			this.depthPopupEl.remove();
			this.depthPopupEl = null;
		}
		this.contentEl.empty();
	}

	private hasApiKey(): boolean {
		const provider = (this.client as any).provider as string | undefined;
		if (provider === "huggingface") {
			return !!(this.client as any).huggingFaceApiKey;
		}
		return !!(this.client as any).apiKey;
	}

	private async runSearch(): Promise<void> {
		const query = this.inputEl.value.trim();
		if (!query) return;
		if (!this.hasApiKey()) {
			this.statusEl.textContent = t("searchNeedApiKey");
			return;
		}

		// Clear the transient status once the first query is submitted.
		this.statusEl.textContent = "";

		// Append the user's message bubble, then clear the input field.
		this.appendUserMessage(query);
		this.recordUserMessage(query);
		this.inputEl.value = "";

		// Append a loading placeholder for the assistant's reply.
		const loadingEl = this.appendAssistantMessage(t("searchSearching"));

		try {
			const embedResult = await this.client.embed([query]);
			const results = await this.store.search(
				embedResult.embeddings[0],
				DEFAULT_LIMIT,
				DEFAULT_THRESHOLD,
			);

			loadingEl.empty();

			if (results.length === 0) {
				loadingEl.createDiv({ cls: "semlink-msg-empty", text: t("searchNoResults") });
			} else if (this.chatClient.isConfigured()) {
				// Answer mode: feed the retrieved notes to the chat model and
				// show its answer, with the source cards folded underneath. The
				// model may call Semlink's search/read tools to dig deeper.
				const loadingTextEl = loadingEl.createDiv({ cls: "semlink-msg-loading", text: t("searchThinking") });
				const streamEl = loadingEl.createDiv({ cls: "semlink-msg-stream" });
				streamEl.style.display = "none";

				const context = this.buildContext(results.slice(0, ANSWER_CONTEXT_SIZE));
				// Fold conversation history into the query for multi-turn context.
				const histCtx = this.buildHistoryContext();
				const fullQuery = histCtx
					? `以下是之前的对话历史：\n${histCtx}\n\n用户最新问题：${query}`
					: query;
				try {
					const thinkStart = Date.now();
					const result = await this.chatClient.chat(
						context,
						fullQuery,
						(toolName) => {
							loadingTextEl.textContent = t("searchToolCalling").replace("{tool}", toolName);
							streamEl.style.display = "none";
							streamEl.textContent = "";
						},
						this.searchDepth,
						(text) => {
							loadingTextEl.style.display = "none";
							streamEl.style.display = "";
							streamEl.textContent = text;
						},
					);
					const elapsedSec = Math.max(1, Math.round((Date.now() - thinkStart) / 1000));
					loadingEl.empty();
					// The initial retrieval is itself a search step — prepend it
					// to the thinking process so the notes the model started
					// from are visible at the top.
					const initialResults = results.slice(0, ANSWER_CONTEXT_SIZE);
					const initialSearchStep: ThinkingStep = {
						type: "tool",
						name: "search_notes",
						args: { query, limit: ANSWER_CONTEXT_SIZE, threshold: DEFAULT_THRESHOLD },
						result: JSON.stringify(
							initialResults.map((r) => ({
								path: r.notePath,
								heading: r.heading,
								preview: r.contentPreview,
								score: r.score,
							})),
							null,
							2,
						),
					};
					const thinking: ThinkingStep[] = [initialSearchStep, ...result.thinking];
					this.renderThinking(loadingEl, thinking, elapsedSec);
					this.updateContextInfo(result.contextTokens, result.contextBreakdown, result.cacheHitRate);
					// Render the answer as markdown (Obsidian's renderer handles
					// headings, lists, code, links, etc.).
					const answerEl = loadingEl.createDiv({ cls: "semlink-msg-answer markdown-rendered" });
					await MarkdownRenderer.render(this.app, result.answer, answerEl, "", this);

					// Reference sources BELOW the answer, collapsed by default.
					const usedSources = this.buildUsedSources(initialResults, result.usedNotes);
					this.renderSources(loadingEl, usedSources, false);

					// Persist this turn into chat history.
					this.recordAssistantMessage(result.answer, thinking, result.usedNotes, elapsedSec);

					// Action buttons (icons) below the sources: copy / save.
					this.appendActions(loadingEl, result.answer, query);
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					loadingEl.empty();
					loadingEl.createDiv({ cls: "semlink-msg-error", text: `${t("searchError")} ${msg}` });
					// Fall back to the raw results (expanded) so the user still
					// gets something useful when the chat call fails.
					this.renderSources(loadingEl, results, true);
				}
			} else {
				// No chat provider configured → show the plain result list.
				this.statusEl.textContent = t("searchNoChatProvider");
				this.renderResultsIn(loadingEl, results);
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			loadingEl.empty();
			loadingEl.createDiv({ cls: "semlink-msg-error", text: `${t("searchError")} ${msg}` });
		}

		this.scrollToBottom();
	}

	/** Build the note-context prompt for the chat model from search results. */
	private buildContext(results: SearchResult[]): string {
		return results
			.map((r, i) => {
				const title = r.heading || this.basename(r.notePath);
				return `[${i + 1}] ${title}（${r.notePath}）\n${r.contentPreview}`;
			})
			.join("\n\n");
	}

	/**
	 * Build the "used" source list: the initial context notes plus any notes
	 * the model read/retrieved via tools, deduped by path (initial first).
	 * Tool-only notes have no preview/score — they render as path cards.
	 */
	private buildUsedSources(contextResults: SearchResult[], usedPaths: string[]): SearchResult[] {
		const byPath = new Map<string, SearchResult>();
		for (const r of contextResults) {
			byPath.set(r.notePath, r);
		}
		for (const p of usedPaths) {
			if (!byPath.has(p)) {
				byPath.set(p, { chunkId: "", notePath: p, heading: "", contentPreview: "", score: -1 });
			}
		}
		return Array.from(byPath.values());
	}

	/** Render a collapsible "reference sources" section inside an assistant bubble. */
	private renderSources(container: HTMLElement, results: SearchResult[], open: boolean): void {
		const details = container.createEl("details", { cls: "semlink-search-sources" });
		if (open) details.setAttr("open", "");

		details.createEl("summary", {
			cls: "semlink-search-sources-summary",
			text: `${t("searchSources")} (${results.length})`,
		});

		const list = details.createDiv({ cls: "semlink-search-sources-list" });
		this.renderSourceRows(list, results);
	}

	/** One-line source rows (title + path), no similarity badge. */
	private renderSourceRows(container: HTMLElement, results: SearchResult[]): void {
		for (const r of results) {
			const row = container.createDiv({ cls: "semlink-search-source-row" });
			const title = r.heading || this.basename(r.notePath);
			row.createSpan({ cls: "semlink-search-source-title", text: title });
			row.createSpan({ cls: "semlink-search-source-path", text: r.notePath });
			row.addEventListener("click", () => {
				void this.openNote(r.notePath, r.contentPreview);
			});
		}
	}

	/**
	 * Append copy / save action buttons to an assistant bubble.
	 * Used for both live answers and restored history messages.
	 */
	private appendActions(container: HTMLElement, content: string, questionForSave: string): void {
		const actionsEl = container.createDiv({ cls: "semlink-msg-actions" });
		const copyBtn = actionsEl.createEl("button", {
			cls: "semlink-msg-action",
			attr: { "aria-label": t("searchCopy"), title: t("searchCopy") },
		});
		setIcon(copyBtn, "copy");
		copyBtn.addEventListener("click", () => void this.copyAnswer(content));
		const saveBtn = actionsEl.createEl("button", {
			cls: "semlink-msg-action",
			attr: { "aria-label": t("searchSave"), title: t("searchSave") },
		});
		setIcon(saveBtn, "save");
		saveBtn.addEventListener("click", () => {
			new SaveNoteModal(this.app, questionForSave, content).open();
		});
	}

	/**
	 * Render the "thinking" collapsible (default closed) listing the model's
	 * thoughts and tool calls in chronological order, above the answer. The
	 * label shows how long the model spent, e.g. "思考了 30 秒".
	 */
	private renderThinking(container: HTMLElement, thinking: ThinkingStep[], elapsedSec: number): void {
		const details = container.createEl("details", { cls: "semlink-thinking" });
		details.createEl("summary", {
			cls: "semlink-thinking-summary",
			text: t("searchThinkingDuration").replace("{seconds}", String(elapsedSec)),
		});

		for (const step of thinking) {
			if (step.type === "thought") {
				details.createDiv({ cls: "semlink-thinking-thought", text: `💭 ${step.text}` });
			} else {
				// Each tool call is one line by default; click to expand and
				// see the full request args and response.
				const callDetails = details.createEl("details", { cls: "semlink-tool-call" });
				callDetails.createEl("summary", {
					cls: "semlink-tool-call-summary",
					text: `🔧 ${step.name}${this.summarizeArgs(step.args)}`,
				});

				callDetails.createDiv({ cls: "semlink-tool-call-label", text: t("searchToolRequest") });
				callDetails.createEl("pre", { cls: "semlink-tool-call-pre", text: this.prettyJson(step.args) });

			callDetails.createDiv({ cls: "semlink-tool-call-label", text: t("searchToolResponse") });
			callDetails.createEl("pre", { cls: "semlink-tool-call-pre", text: this.prettyJson(step.result) });
		}
	}

		// Copy-thinking button at the bottom of the expanded section.
		const copyBtn = details.createEl("button", {
			cls: "semlink-thinking-copy",
			text: t("searchCopyThinking"),
		});
		copyBtn.addEventListener("click", () => {
			const text = thinking.map((s) =>
				s.type === "thought" ? `💭 ${s.text}` : `🔧 ${s.name}${this.summarizeArgs(s.args)}`
			).join("\n");
			void navigator.clipboard.writeText(text).then(() => {
				new Notice(t("searchCopied"));
			}).catch(() => {
				new Notice(t("searchCopyFailed"));
			});
		});
	}

	/** Compact one-line preview of the request args, e.g. " — MIBT". */
	private summarizeArgs(args: any): string {
		if (args && typeof args === "object") {
			const first = Object.entries(args).find(([, v]) => typeof v === "string" && v.length > 0);
			if (first) return ` — ${first[1]}`;
		}
		return "";
	}

	private prettyJson(value: any): string {
		if (typeof value === "string") return value;
		try {
			return JSON.stringify(value, null, 2);
		} catch {
			return String(value);
		}
	}

	/**
	 * Render a time-aware welcome message in the center of the conversation
	 * area when it's empty. Removed as soon as the user sends their first
	 * message. Greeting adapts to morning/afternoon/evening/night.
	 */
	private renderWelcome(): void {
		const hour = new Date().getHours();
		let key: string;
		if (hour < 5) key = "welcomeMidnight";
		else if (hour < 7) key = "welcomeDawn";
		else if (hour < 9) key = "welcomeEarlyMorn";
		else if (hour < 12) key = "welcomeMorning";
		else if (hour < 13) key = "welcomeLunch";
		else if (hour < 14) key = "welcomeNap";
		else if (hour < 15) key = "welcomeAfternoon1";
		else if (hour < 16) key = "welcomeAfternoon2";
		else if (hour < 17) key = "welcomeAfternoon3";
		else if (hour < 18) key = "welcomeAfternoon4";
		else if (hour < 19) key = "welcomeAfternoon5";
		else if (hour < 21) key = "welcomeDusk";
		else if (hour < 22) key = "welcomeNight";
		else key = "welcomeLateNight";

		// i18n string: "emoji line1\nline2" — split into a primary greeting
		// (larger, bold) and a secondary care note (smaller, muted).
		const lines = t(key).split("\n");
		const welcome = this.messagesEl.createDiv({ cls: "semlink-search-welcome" });
		welcome.createDiv({ cls: "semlink-search-welcome-greeting", text: lines[0] || "" });
		if (lines[1]) {
			welcome.createDiv({ cls: "semlink-search-welcome-sub", text: lines[1] });
		}
	}

	// ── Chat history: session lifecycle ──

	/** Seal the current session (if any) and reset to a blank conversation. */
	private startNewSession(): void {
		this.currentSessionId = null;
		this.currentMessages = [];
	}

	/** Record a user question into the current session (creating one if needed). */
	private recordUserMessage(content: string): void {
		if (!this.currentSessionId) {
			this.currentSessionId = this.history.createSession(content);
		}
		const msg: HistoryMessage = { role: "user", content, timestamp: Date.now() };
		this.currentMessages.push(msg);
		this.history.addMessage(this.currentSessionId, msg);
		void this.history.save();
	}

	/** Record an assistant answer into the current session. */
	private recordAssistantMessage(content: string, thinking?: ThinkingStep[], sources?: string[], elapsedSec?: number): void {
		if (!this.currentSessionId) return;
		const msg: HistoryMessage = {
			role: "assistant",
			content,
			thinking: thinking?.map((s) => ({
				type: s.type,
				text: s.type === "thought" ? s.text : undefined,
				name: s.type === "tool" ? s.name : undefined,
				args: s.type === "tool" ? s.args : undefined,
				result: s.type === "tool" ? s.result : undefined,
			})),
			sources,
			elapsedSec,
			timestamp: Date.now(),
		};
		this.currentMessages.push(msg);
		this.history.addMessage(this.currentSessionId, msg);
		void this.history.save();
	}

	/** Build a context string from the current session's prior turns. */
	private buildHistoryContext(): string {
		if (this.currentMessages.length <= 1) return "";
		// All messages except the latest user turn (which is the current query).
		const prior = this.currentMessages.slice(0, -1);
		return prior.map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content}`).join("\n\n");
	}

	/** Render a previously-saved session into the conversation area. */
	private async loadSession(session: ChatSession): Promise<void> {
		this.currentSessionId = session.id;
		this.currentMessages = [...session.messages];
		this.messagesEl.empty();
		this.statusEl.textContent = "";
		let lastUserQuery = "";
		for (const msg of session.messages) {
			if (msg.role === "user") {
				lastUserQuery = msg.content;
				this.appendUserMessage(msg.content);
			} else {
				const bubble = this.appendAssistantMessage("");
				const thinking = (msg.thinking || []).map((s) => s as ThinkingStep);
				if (thinking.length > 0) this.renderThinking(bubble, thinking, msg.elapsedSec || 0);
				const answerEl = bubble.createDiv({ cls: "semlink-msg-answer markdown-rendered" });
				await MarkdownRenderer.render(this.app, msg.content, answerEl, "", this);
				if (msg.sources && msg.sources.length > 0) {
					const usedSources = msg.sources.map((p) => ({ notePath: p, heading: "", contentPreview: "" }));
					this.renderSources(bubble, usedSources as any, false);
				}
				// Copy / save actions for history answers too.
				this.appendActions(bubble, msg.content, lastUserQuery);
			}
		}
		this.scrollToBottom();
		this.inputEl.focus();
	}

	// ── Chat history: drawer UI ──

	/** Slide in a left-side drawer listing saved chat sessions. */
	private async showHistoryDrawer(): Promise<void> {
		const sessions = await this.history.load();
		// Attach to the view's contentEl (not document.body) so the drawer is
		// positioned relative to the search panel, not the whole Obsidian window.
		this.contentEl.style.position = "relative";
		// Backdrop
		const backdrop = this.contentEl.createDiv({ cls: "semlink-history-backdrop" });
		// Drawer panel
		const drawer = this.contentEl.createDiv({ cls: "semlink-history-drawer" });
		const header = drawer.createDiv({ cls: "semlink-history-header" });
		header.createDiv({ cls: "semlink-history-title", text: t("historyTitle") });
		const closeBtn = header.createEl("button", { cls: "semlink-search-icon-btn clickable-icon" });
		setIcon(closeBtn, "x");
		const list = drawer.createDiv({ cls: "semlink-history-list" });
		if (sessions.length === 0) {
			list.createDiv({ cls: "semlink-history-empty", text: t("historyEmpty") });
		}
		for (const session of this.history.list()) {
			const item = list.createDiv({ cls: "semlink-history-item" });
			const info = item.createDiv({ cls: "semlink-history-item-info" });
			info.createDiv({ cls: "semlink-history-item-title", text: session.title });
			const date = new Date(session.updatedAt);
			const timeStr = `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
			info.createDiv({ cls: "semlink-history-item-meta", text: `${timeStr} · ${session.messages.length} ${t("historyMessages")}` });
			// Delete button
			const delBtn = item.createEl("button", { cls: "semlink-history-item-del clickable-icon" });
			setIcon(delBtn, "trash");
			delBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.history.deleteSession(session.id);
				void this.history.save();
				item.remove();
			});
			item.addEventListener("click", () => {
				this.closeHistoryDrawer(backdrop, drawer);
				void this.loadSession(session);
			});
		}
		// Animate in
		requestAnimationFrame(() => {
			drawer.addClass("semlink-history-drawer-open");
			backdrop.addClass("semlink-history-backdrop-open");
		});
		closeBtn.addEventListener("click", () => this.closeHistoryDrawer(backdrop, drawer));
		backdrop.addEventListener("click", () => this.closeHistoryDrawer(backdrop, drawer));
	}

	private closeHistoryDrawer(backdrop: HTMLElement, drawer: HTMLElement): void {
		drawer.removeClass("semlink-history-drawer-open");
		backdrop.removeClass("semlink-history-backdrop-open");
		setTimeout(() => { backdrop.remove(); drawer.remove(); }, 300);
	}

	/** Append a right-aligned user query bubble to the conversation. */
	private appendUserMessage(text: string): void {
		// Remove the welcome placeholder once the first real message arrives.
		this.messagesEl.querySelector(".semlink-search-welcome")?.remove();
		const turn = this.messagesEl.createDiv({ cls: "semlink-msg-turn semlink-msg-user-turn" });
		turn.createDiv({ cls: "semlink-msg-bubble semlink-msg-user", text });
	}

	/** Append a left-aligned assistant container and return it for population. */
	private appendAssistantMessage(initialText: string): HTMLElement {
		const turn = this.messagesEl.createDiv({ cls: "semlink-msg-turn semlink-msg-assistant-turn" });
		const bubble = turn.createDiv({ cls: "semlink-msg-bubble semlink-msg-assistant" });
		if (initialText) {
			bubble.createDiv({ cls: "semlink-msg-loading", text: initialText });
		}
		return bubble;
	}

	/** Render result cards inside an assistant bubble. */
	private renderResultsIn(container: HTMLElement, results: SearchResult[]): void {
		for (const r of results) {
			const card = container.createDiv({ cls: "semlink-search-result" });

			const title = r.heading || this.basename(r.notePath);
			card.createDiv({ cls: "semlink-search-result-title", text: title });
			card.createDiv({ cls: "semlink-search-result-path", text: r.notePath });

			if (r.contentPreview) {
				card.createDiv({ cls: "semlink-search-result-preview", text: r.contentPreview });
			}

			const meta = card.createDiv({ cls: "semlink-search-result-meta" });
			// Only show a similarity badge when we actually have a score
			// (tool-only source cards carry score -1).
			if (r.score > 0) {
				const scorePct = Math.round(r.score * 100);
				meta.createSpan({
					cls: "semlink-search-score",
					text: `${t("searchScoreLabel")} ${scorePct}%`,
				});
			}

			card.addEventListener("click", () => {
				void this.openNote(r.notePath, r.contentPreview);
			});
		}
	}

	private scrollToBottom(): void {
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	/** Update the context-usage donut with the latest turn's token count. */
	private updateContextRing(tokens: number): void {
		if (!this.contextRingEl) return;
		const window = this.chatClient.getActiveContextWindow();
		if (!window) return;

		const pct = Math.min(100, Math.max(0, Math.round((tokens / window) * 100)));
		const fg = this.contextRingEl.querySelector(".ring-fg") as SVGCircleElement | null;
		const C = 2 * Math.PI * 15.9;
		if (fg) {
			fg.setAttribute("stroke-dasharray", String(C));
			fg.setAttribute("stroke-dashoffset", String(C * (1 - pct / 100)));
			fg.classList.toggle("is-high", pct >= 80);
			fg.classList.toggle("is-warn", pct >= 60 && pct < 80);
		}
		if (this.contextPctEl) this.contextPctEl.textContent = `${pct}%`;
	}

	/** Store the latest usage info (ring + tooltip data) after each turn. */
	private updateContextInfo(tokens: number, breakdown: ContextBreakdown, cacheHitRate: number | null): void {
		this.lastBreakdown = breakdown;
		this.lastCacheHitRate = cacheHitRate;
		this.updateContextRing(tokens);
	}

	/** Show the context-usage tooltip next to the donut. */
	private showContextTooltip(): void {
		if (!this.contextRingEl) return;
		// Lazily create the tooltip on document.body (see onOpen comment).
		if (!this.tooltipEl) {
			this.tooltipEl = document.body.createDiv({ cls: "semlink-context-tooltip" });
			this.tooltipEl.style.position = "fixed";
			this.tooltipEl.style.display = "none";
			this.tooltipEl.style.zIndex = "9999";
		}
		const el = this.tooltipEl;
		const bd = this.lastBreakdown;

		el.empty();
		el.createDiv({ cls: "ctx-capacity", text: `${t("ctxTotal")}: ${(bd ? bd.capacity : 0).toLocaleString()} tokens` });

		const categories = bd ? bd.categories : [];
		for (const cat of categories) {
			const pct = bd && bd.used > 0 ? Math.round((cat.tokens / bd.used) * 100) : 0;
			const row = el.createDiv({ cls: "ctx-row" });
			row.createSpan({ cls: "ctx-name", text: this.categoryLabel(cat.key) });
			const bar = row.createDiv({ cls: "ctx-bar" });
			bar.createDiv({ cls: "ctx-bar-fill", attr: { style: `width:${pct}%` } });
			row.createSpan({ cls: "ctx-tokens", text: `${cat.tokens.toLocaleString()} · ${pct}%` });
		}

		const cacheText = this.lastCacheHitRate === null ? "—" : `${Math.round(this.lastCacheHitRate * 100)}%`;
		el.createDiv({ cls: "ctx-cache", text: `${t("ctxCacheHit")}: ${cacheText}` });

		// Position the tooltip above the donut (viewport-fixed on document.body).
		const rect = this.contextRingEl.getBoundingClientRect();
		el.style.left = rect.left + "px";
		el.style.top = rect.top + "px";
		el.style.transform = "translateY(calc(-100% - 8px))";
		el.style.display = "block";

		// Keep it inside the viewport.
		const vw = window.innerWidth;
		if (rect.left + el.offsetWidth > vw - 8) {
			el.style.left = Math.max(8, vw - el.offsetWidth - 8) + "px";
		}
	}

	private hideContextTooltip(): void {
		if (this.tooltipEl) this.tooltipEl.style.display = "none";
	}

	private categoryLabel(key: string): string {
		switch (key) {
			case "messages": return t("ctxMessages");
			case "system_tools": return t("ctxSystemTools");
			case "mcp_tools": return t("ctxMcpTools");
			case "skills": return t("ctxSkills");
			case "system_prompt": return t("ctxSystemPrompt");
			default: return t("ctxOther");
		}
	}

	// ──── Search depth dropdown ────

	private depthLabel(): string {
		return this.searchDepth === "enhanced" ? t("searchDepthEnhanced") : t("searchDepthStandard");
	}

	private toggleDepthPopup(): void {
		if (this.depthPopupEl && this.depthPopupEl.style.display === "block") {
			this.hideDepthPopup();
		} else {
			this.showDepthPopup();
		}
	}

	private showDepthPopup(): void {
		if (!this.depthTriggerEl) return;
		// Lazily create the popup on document.body so fixed positioning is
		// not thrown off by transformed/clipping ancestors.
		if (!this.depthPopupEl) {
			this.depthPopupEl = document.body.createDiv({ cls: "semlink-search-depth-popup" });
			this.depthPopupEl.style.position = "fixed";
			this.depthPopupEl.style.display = "none";
			this.depthPopupEl.style.zIndex = "9999";
		}
		const popup = this.depthPopupEl;
		popup.empty();

		const addOption = (value: "standard" | "enhanced") => {
			const opt = popup.createDiv({
				cls: "semlink-search-depth-option" + (this.searchDepth === value ? " is-active" : ""),
				text: value === "enhanced" ? t("searchDepthEnhanced") : t("searchDepthStandard"),
			});
			opt.addEventListener("click", () => {
				this.searchDepth = value;
				const txt = this.depthTriggerEl?.querySelector(".semlink-search-depth-trigger-text");
				if (txt) txt.textContent = this.depthLabel();
				this.hideDepthPopup();
			});
		};
		addOption("standard");
		addOption("enhanced");

		// Position ABOVE the trigger (bottom edge of the window is tight).
		const rect = this.depthTriggerEl.getBoundingClientRect();
		popup.style.left = rect.left + "px";
		popup.style.bottom = (window.innerHeight - rect.top + 4) + "px";
		popup.style.display = "block";

		// Keep it inside the viewport.
		const vw = window.innerWidth;
		if (rect.left + popup.offsetWidth > vw - 8) {
			popup.style.left = Math.max(8, vw - popup.offsetWidth - 8) + "px";
		}
	}

	private hideDepthPopup(): void {
		if (this.depthPopupEl) this.depthPopupEl.style.display = "none";
	}

	/** Copy the answer markdown to the clipboard (with a legacy fallback). */
	private async copyAnswer(text: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			const ta = document.createElement("textarea");
			ta.value = text;
			ta.style.position = "fixed";
			ta.style.opacity = "0";
			document.body.appendChild(ta);
			ta.select();
			document.execCommand("copy");
			ta.remove();
		}
		new Notice(t("searchCopied"));
	}

	private async openNote(notePath: string, preview: string): Promise<void> {
		const file = this.vault.getAbstractFileByPath(notePath);
		if (!(file instanceof TFile)) return;

		// Open the file, then try to scroll to the line that best matches the
		// chunk's preview text.
		await this.app.workspace.getLeaf(false).openFile(file);
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const editor = view?.editor;
		if (!editor) return;

		const line = this.findMatchingLine(editor.getValue(), preview);
		if (line >= 0) {
			editor.setCursor({ line, ch: 0 });
			editor.scrollIntoView({
				from: { line, ch: 0 },
				to: { line: Math.min(line + 3, editor.lastLine()), ch: 0 },
			}, true);
		}
	}

	/**
	 * Find the line number in `content` whose text best matches `preview`.
	 * The preview is a flattened snippet (newlines collapsed to spaces by
	 * makePreview), so we match on its leading run of non-space characters
	 * and fall back to a token-based best match.
	 */
	private findMatchingLine(content: string, preview: string): number {
		if (!preview) return -1;
		const lines = content.split("\n");

		// Take the first chunk of the preview that looks like real text and
		// try an exact substring search against each line.
		const anchor = preview.replace(/\s+/g, " ").trim().slice(0, 40);
		if (anchor) {
			for (let i = 0; i < lines.length; i++) {
				if (lines[i].includes(anchor)) return i;
			}
			// The preview may start mid-line: try the tail of the anchor.
			const tail = anchor.slice(-20);
			if (tail.length >= 5) {
				for (let i = 0; i < lines.length; i++) {
					if (lines[i].includes(tail)) return i;
				}
			}
		}

		// Fall back to matching the longest preview token anywhere in a line.
		const tokens = preview.split(/\s+/).filter((w) => w.length >= 4);
		if (tokens.length === 0) return -1;
		let bestLine = -1;
		let bestHits = 0;
		for (let i = 0; i < lines.length; i++) {
			let hits = 0;
			for (const tok of tokens) {
				if (lines[i].includes(tok)) hits++;
			}
			if (hits > bestHits) {
				bestHits = hits;
				bestLine = i;
			}
		}
		return bestHits > 0 ? bestLine : -1;
	}

	private basename(path: string): string {
		const slash = path.lastIndexOf("/");
		const name = slash >= 0 ? path.slice(slash + 1) : path;
		const dot = name.lastIndexOf(".");
		return dot > 0 ? name.slice(0, dot) : name;
	}
}
