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
import type { SearchResult, ChatSession, HistoryMessage, HistorySegment } from "./types";
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
	private inputEl!: HTMLDivElement;
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

	// Dropped note attachments (vault-relative paths) rendered as inline chips
	// mixed with the input text.
	private attachments: string[] = [];
	/** basename → vault path cache for drop resolution (vault.getFiles() is
	 * expensive on large vaults; build it once and reuse). */
	private basenameCache: Map<string, string> | null = null;

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
			this.inputEl.empty();
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
		// Drag & drop is handled on the WHOLE input wrapper. preventDefault +
		// stopPropagation keeps Obsidian from treating the drop as a link
		// insert / file open. Dropped notes become inline chips inside the
		// contenteditable input, mixed with the typed text.
		let dragDepth = 0;
		wrapper.addEventListener("dragover", (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
			wrapper.addClass("semlink-attach-bar-drag");
		});
		wrapper.addEventListener("dragenter", (e) => {
			e.preventDefault();
			e.stopPropagation();
			dragDepth++;
			wrapper.addClass("semlink-attach-bar-drag");
		});
		wrapper.addEventListener("dragleave", () => {
			dragDepth = Math.max(0, dragDepth - 1);
			if (dragDepth === 0) wrapper.removeClass("semlink-attach-bar-drag");
		});
		// Obsidian installs document-level drop handlers (open file / insert
		// link) that can swallow the drop before it ever bubbles up to our
		// wrapper. Grab the drop in the CAPTURE phase, scoped to the input
		// wrapper, so vault-file drops always reach us first.
		this.registerDomEvent(
			document,
			"drop",
			(e) => {
				const target = e.target;
				if (!(target instanceof Element) || !target.closest(".semlink-search-input-wrapper")) return;
				e.preventDefault();
				e.stopPropagation();
				dragDepth = 0;
				wrapper.removeClass("semlink-attach-bar-drag");
				void this.handleFileDrop(e);
			},
			true,
		);
		const inputRow = wrapper.createDiv({ cls: "semlink-search-input-row" });
		// Contenteditable input so dropped-note chips can mix INLINE with the
		// typed text (a plain textarea can only hold text).
		this.inputEl = inputRow.createDiv({
			cls: "semlink-search-input",
			attr: {
				contenteditable: "true",
				role: "textbox",
				"aria-multiline": "true",
				"data-placeholder": t("searchPlaceholder"),
				"aria-label": t("searchPlaceholder"),
			},
		});
		this.inputEl.addEventListener("keydown", (e) => {
			// Enter sends; Shift+Enter inserts a newline. Skip while an IME
			// composition is in progress (pinyin candidates are still open).
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
				e.preventDefault();
				void this.runSearch();
				// Scroll to the bottom right away so the new message and the
				// loading state are immediately visible.
				this.scrollToBottom();
			}
		});
		// Paste: keep rich HTML out of the chip DOM. [[...]] tokens are
		// resolved back into styled wiki links (highlight + click-to-open +
		// attachment tracking); everything else inserts as plain text.
		this.inputEl.addEventListener("paste", (e) => {
			e.preventDefault();
			const text = e.clipboardData?.getData("text/plain") || "";
			this.insertTextWithWikilinks(text);
		});
		// Browsers insert a <br> when text next to an atomic chip is deleted
		// (to keep the caret on a visible line) — that forced line break would
		// push the chip onto a second line. Clean those artifacts up, and keep
		// the attachment list in sync with the wiki links actually in the input
		// (a link may be removed via backspace or cut).
		this.inputEl.addEventListener("input", () => {
			this.syncAttachmentsFromInput();
			this.sanitizeInputLayout();
		});
		// Cut: the browser will not delete contenteditable=false wiki links on
		// its own — copy the selection and remove it via the Range API.
		this.inputEl.addEventListener("cut", (e) => {
			e.preventDefault();
			const sel = window.getSelection();
			if (!sel || sel.rangeCount === 0 || !this.inputEl.contains(sel.getRangeAt(0).commonAncestorContainer)) {
				return;
			}
			const text = sel.toString();
			if (!text) return;
			void navigator.clipboard.writeText(text);
			sel.getRangeAt(0).deleteContents();
			this.syncAttachmentsFromInput();
			this.sanitizeInputLayout();
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

		// Send button lives on the model row (right side), not beside the input.
		const searchBtn = modelEl.createEl("button", {
			cls: "semlink-search-btn",
			attr: { "aria-label": t("searchSend"), title: t("searchSend") },
		});
		setIcon(searchBtn, "send");
		searchBtn.addEventListener("click", () => {
			void this.runSearch();
			this.scrollToBottom();
		});

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
		const query = this.extractInputText().trim();
		if (!query) return;
		if (!this.hasApiKey()) {
			this.statusEl.textContent = t("searchNeedApiKey");
			return;
		}

		// Clear the transient status once the first query is submitted.
		this.statusEl.textContent = "";

		// Append the user's message bubble — preserving the text+chip mix the
		// user composed — then clear the input. The snapshot is taken BEFORE
		// clearing so the interleaved chips survive into the rendered bubble
		// and into the persisted chat history (as ordered segments).
		const userContent = this.inputEl.cloneNode(true) as HTMLElement;
		const segments = this.snapshotSegments(userContent);
		this.appendUserMessage(query, userContent);
		await this.recordUserMessage(query, segments);
		this.clearInputText();

		// Snapshot the dropped notes for THIS turn — the attachments array is
		// reset when the turn finishes, so the chips act as part of the message
		// rather than persisting across turns.
		const turnAttachments = this.attachments;

		// Append a loading placeholder for the assistant's reply.
		const loadingEl = this.appendAssistantMessage(t("searchSearching"));

		try {
			// If the user dropped notes into the input, read THEM as the source
			// of truth instead of running a vector search — the LLM should read
			// the attached documents first, not trigger retrieval.
			const hasAttachments = turnAttachments.length > 0;
			const attachCtx = hasAttachments ? await this.buildAttachmentContext(turnAttachments) : "";
			let results: SearchResult[] = [];
			if (!hasAttachments) {
				const embedResult = await this.client.embed([query]);
				results = await this.store.search(
					embedResult.embeddings[0],
					DEFAULT_LIMIT,
					DEFAULT_THRESHOLD,
				);
			}

			loadingEl.empty();

			if (!hasAttachments && results.length === 0) {
				loadingEl.createDiv({ cls: "semlink-msg-empty", text: t("searchNoResults") });
			} else if (this.chatClient.isConfigured()) {
				// Answer mode: feed the retrieved notes to the chat model and
				// show its answer, with the source cards folded underneath. The
				// model may call Semlink's search/read tools to dig deeper.
				const loadingTextEl = loadingEl.createDiv({ cls: "semlink-msg-loading", text: t("searchThinking") });
				const streamEl = loadingEl.createDiv({ cls: "semlink-msg-stream" });
				streamEl.style.display = "none";

				// Animated "生成回答中" indicator: cycles the trailing dots so
				// the UI never looks stuck while the model is composing —
				// especially in the gap after the last tool call and before the
				// first stream token.
				let answerAnim: number | null = null;
				let answerDots = 0;
				const stopAnswerAnim = (): void => {
					if (answerAnim !== null) {
						window.clearInterval(answerAnim);
						answerAnim = null;
					}
				};
				const showAnswerLoading = (): void => {
					loadingTextEl.style.display = "";
					streamEl.style.display = "none";
					streamEl.textContent = "";
					answerDots = 0;
					loadingTextEl.textContent = t("searchGeneratingAnswer");
					stopAnswerAnim();
					answerAnim = window.setInterval(() => {
						answerDots = (answerDots % 3) + 1; // 1 → 2 → 3 → 1 …
						loadingTextEl.textContent = t("searchGeneratingAnswer") + ".".repeat(answerDots);
					}, 350);
				};

				const context = hasAttachments
					? attachCtx
					: this.buildContext(results.slice(0, ANSWER_CONTEXT_SIZE)) + attachCtx;
				const fullContext = context;
				// Fold conversation history into the query for multi-turn context.
				const histCtx = this.buildHistoryContext();
				const fullQuery = histCtx
					? `以下是之前的对话历史：\n${histCtx}\n\n用户最新问题：${query}`
					: query;
				try {
					const thinkStart = Date.now();
					const result = await this.chatClient.chat(
						fullContext,
						fullQuery,
						(toolName) => {
							// A tool is about to run — its name is accurate here.
							stopAnswerAnim();
							loadingTextEl.textContent = t("searchToolCalling").replace("{tool}", toolName);
							streamEl.style.display = "none";
							streamEl.textContent = "";
						},
						this.searchDepth,
						(text) => {
							// Answer streaming started.
							stopAnswerAnim();
							loadingTextEl.style.display = "none";
							streamEl.style.display = "";
							streamEl.textContent = text;
						},
						() => {
							// The model is generating this round (deciding tools
							// or composing the answer) — show the animated
							// indicator instead of freezing on a tool's name.
							showAnswerLoading();
						},
					);
					const elapsedSec = Math.max(1, Math.round((Date.now() - thinkStart) / 1000));
					stopAnswerAnim();
					loadingEl.empty();
					// Make the initial evidence visible in the thinking process:
					// a search_notes step for vector retrieval, or a
					// read_attachments step when the user dropped notes in.
					const initialResults = hasAttachments ? [] : results.slice(0, ANSWER_CONTEXT_SIZE);
					const firstStep: ThinkingStep = hasAttachments
						? {
							type: "tool",
							name: "read_attachments",
							args: { files: [...turnAttachments] },
							result: `已读取 ${turnAttachments.length} 个拖入的笔记内容，作为本次回答的主要依据。`,
						}
						: {
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
					const thinking: ThinkingStep[] = [firstStep, ...result.thinking];
					this.renderThinking(loadingEl, thinking, elapsedSec);
					this.updateContextInfo(result.contextTokens, result.contextBreakdown, result.cacheHitRate);
					// Render the answer as markdown (Obsidian's renderer handles
					// headings, lists, code, links, etc.).
					const answerEl = loadingEl.createDiv({ cls: "semlink-msg-answer markdown-rendered" });
					await MarkdownRenderer.render(this.app, result.answer, answerEl, "", this);

					// Reference sources BELOW the answer, collapsed by default.
					// With attachments the sources ARE the dropped notes.
					const usedSources = hasAttachments
						? turnAttachments.map((p) => ({ chunkId: "", notePath: p, heading: "", contentPreview: "", score: -1 }))
						: this.buildUsedSources(initialResults, result.usedNotes);
					this.renderSources(loadingEl, usedSources, false);

					// Persist this turn into chat history.
					await this.recordAssistantMessage(result.answer, thinking, result.usedNotes, elapsedSec);

					// Action buttons (icons) below the sources: copy / save.
					this.appendActions(loadingEl, result.answer, query);
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					stopAnswerAnim();
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
		} finally {
			// The dropped notes were consumed by this turn.
			this.attachments = [];
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

	// ── Dropped-note attachments (tag chips above the input) ──

	/** Handle a drop of vault files onto the attachment bar. */
	private async handleFileDrop(e: DragEvent): Promise<void> {
		const dt = e.dataTransfer;
		if (!dt) return;
		const candidates: string[] = [];

		// 1. Read EVERY type the drop carries. Obsidian's file explorer hands
		//    vault files as text/uri-list / text/plain (`obsidian://open?file=`),
		//    but it may add custom types too — parse them all instead of hoping
		//    for one specific format.
		for (const type of Array.from(dt.types || [])) {
			let data = "";
			try {
				data = dt.getData(type);
			} catch {
				continue;
			}
			if (!data) continue;
			// obsidian://open?vault=..&file=..  — the `file` param is the
			// vault-relative path (URL-encoded).
			const uri = data.match(/obsidian:\/\/open\?[^#]*file=([^&#]+)/);
			if (uri) {
				try {
					candidates.push(decodeURIComponent(uri[1]));
				} catch {
					// ignore malformed encoding
				}
			} else if (data.startsWith("file://")) {
				// OS-level file URI (e.g. dragged from a file manager).
				try {
					candidates.push(decodeURIComponent(data.slice(7)));
				} catch {
					// ignore
				}
			}
		}

		// 2. OS-level File objects (drag from outside Obsidian). Electron's
		//    File exposes a `path`; plain browser File objects only have `name`.
		const osFiles = Array.from(dt.files || []) as Array<{ path?: string; name?: string }>;
		for (const f of osFiles) {
			if (f.path) candidates.push(f.path);
		}

		// 3. Normalize & resolve to vault-relative paths. Only cheap index
		//    lookups here — heavy DOM work is deferred to the next frame below.
		const added: string[] = [];
		for (const rawPath of candidates) {
			const resolved = this.resolveNotePath(rawPath);
			if (!resolved) continue;
			if (!this.attachments.includes(resolved)) {
				this.attachments.push(resolved);
				added.push(resolved);
			}
		}

		if (added.length === 0) return;
		// Defer DOM mutation (chips + notice) off the drop event so the UI
		// doesn't jank; a single frame later is imperceptible.
		requestAnimationFrame(() => {
			this.insertAttachmentChips(added);
			new Notice(t("attachAdded").replace("{n}", String(added.length)));
		});
	}

	/** Resolve an absolute/bare path to a vault note by basename (cached). */
	private matchNoteByBasename(p: string): string | undefined {
		if (!this.basenameCache) {
			this.basenameCache = new Map();
			for (const f of this.vault.getFiles()) {
				this.basenameCache.set(f.basename.toLowerCase(), f.path);
			}
		}
		const baseName = p.split("/").pop()?.toLowerCase().replace(/\.(md|txt|markdown)$/i, "");
		return baseName ? this.basenameCache.get(baseName) : undefined;
	}

	/**
	 * Insert note chips at the current caret position inside the
	 * contenteditable input (appended at the end if there's no selection).
	 * All chips share one range operation, then the caret is placed once.
	 */
	private insertAttachmentChips(paths: string[]): void {
		if (paths.length === 0) return;
		const sel = window.getSelection();
		let range: Range | null = null;
		let inInput = false;
		if (sel && sel.rangeCount > 0) {
			const r = sel.getRangeAt(0);
			if (this.inputEl.contains(r.commonAncestorContainer)) {
				range = r;
				inInput = true;
			}
		}
		if (inInput && range) {
			range.deleteContents();
			for (const path of paths) {
				range.insertNode(this.createWikilink(path));
				// A space after each link keeps surrounding words separated.
				const space = document.createTextNode(" ");
				range.insertNode(space);
				range.setStartAfter(space);
				range.collapse(true);
			}
			sel?.removeAllRanges();
			sel?.addRange(range);
		} else {
			for (const path of paths) {
				this.inputEl.appendChild(this.createWikilink(path));
				this.inputEl.appendChild(document.createTextNode(" "));
			}
		}
		this.inputEl.focus();
	}

	/**
	 * Build the inline wiki-link element rendered as `[[filename]]`. It is
	 * atomic (contenteditable="false") so backspace removes it as a unit, and
	 * clickable to open the note directly.
	 */
	private createWikilink(path: string): HTMLElement {
		const link = createSpan({
			cls: "semlink-wikilink",
			attr: { contenteditable: "false", "data-path": path, title: path },
		});
		const base = path.split("/").pop() || path;
		const name = base.replace(/\.(md|txt|markdown)$/i, "");
		link.setText(`[[${name}]]`);
		link.addEventListener("click", (e) => {
			e.stopPropagation();
			void this.app.workspace.openLinkText(path, "", false);
		});
		return link;
	}

	/** Plain text of the input with wiki links (and their labels) excluded. */
	private extractInputText(): string {
		const clone = this.inputEl.cloneNode(true) as HTMLElement;
		clone.querySelectorAll(".semlink-wikilink").forEach((c) => c.remove());
		let out = "";
		const walk = (node: Node): void => {
			if (node.nodeType === Node.TEXT_NODE) {
				out += node.textContent || "";
				return;
			}
			if (node.nodeType !== Node.ELEMENT_NODE) return;
			const el = node as HTMLElement;
			if (el.tagName === "BR") {
				out += "\n";
				return;
			}
			if (el.tagName === "DIV" || el.tagName === "P") {
				out += "\n";
				el.childNodes.forEach(walk);
				out += "\n";
				return;
			}
			el.childNodes.forEach(walk);
		};
		walk(clone);
		// Squash the line breaks introduced around block elements.
		return out.replace(/\u200B/g, "").replace(/\n{3,}/g, "\n\n").trim();
	}

	/** Clear the input content (text + chips) after sending. */
	private clearInputText(): void {
		this.inputEl.empty();
	}

	/**
	 * Insert pasted text at the caret. [[...]] tokens are resolved to vault
	 * notes and inserted as styled wiki links (highlight + click-to-open +
	 * attachment tracking); the rest becomes plain text (newlines as <br>).
	 */
	private insertTextWithWikilinks(text: string): void {
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) return;
		const range = sel.getRangeAt(0);
		range.deleteContents();
		const insert = (node: Node): void => {
			range.insertNode(node);
			range.setStartAfter(node);
			range.collapse(true);
		};

		const added: string[] = [];
		for (const part of text.split(/(\[\[[^\]]*\]\])/g).filter((s) => s.length > 0)) {
			const m = part.match(/^\[\[(.+?)\]\]$/);
			if (m) {
				// [[target]] or [[target|alias]] — resolve to an existing note.
				const target = m[1].split("|")[0].trim();
				const resolved = this.resolveNotePath(target);
				if (resolved) {
					insert(this.createWikilink(resolved));
					added.push(resolved);
				} else {
					insert(document.createTextNode(part));
				}
			} else {
				part.split(/\r?\n/).forEach((line, i) => {
					if (i > 0) insert(document.createElement("br"));
					insert(document.createTextNode(line));
				});
			}
		}
		for (const p of added) {
			if (!this.attachments.includes(p)) this.attachments.push(p);
		}
		sel.removeAllRanges();
		sel.addRange(range);
		this.inputEl.focus();
	}

	/** Resolve a bare/absolute path to an existing vault note, or null. */
	private resolveNotePath(rawPath: string): string | null {
		let p = rawPath.replace(/\\/g, "/");
		// Strip the vault base dir if the drop carried an absolute OS path.
		try {
			const base = (this.app.vault.adapter as any).getBasePath?.();
			if (base && p.startsWith(base.replace(/\\/g, "/") + "/")) {
				p = p.slice(base.length + 1);
			}
		} catch {
			// ignore
		}
		if (!p || p.startsWith("obsidian://")) return null;

		// Try as-is, then with note extensions appended.
		let resolved = p;
		if (!this.vault.getAbstractFileByPath(resolved)) {
			for (const ext of [".md", ".txt", ".markdown"]) {
				if (this.vault.getAbstractFileByPath(resolved + ext)) {
					resolved += ext;
					break;
				}
			}
		}
		// Last resort: match by basename (cached lookup).
		if (!this.vault.getAbstractFileByPath(resolved)) {
			const hit = this.matchNoteByBasename(p);
			if (hit) resolved = hit;
		}
		return this.vault.getAbstractFileByPath(resolved) ? resolved : null;
	}

	/**
	 * Rebuild the attachment list from the wiki links currently in the input.
	 * Links can be removed while editing (backspace, cut), and the list must
	 * reflect what the user actually kept.
	 */
	private syncAttachmentsFromInput(): void {
		this.attachments = Array.from(
			this.inputEl.querySelectorAll<HTMLElement>(".semlink-wikilink[data-path]"),
		).map((el) => el.getAttribute("data-path") as string);
	}

	/**
	 * Remove layout artifacts left by editing next to inline chips. When the
	 * user deletes the text in front of a chip, the browser keeps the caret
	 * line alive by inserting a <br> — a forced line break that visually moves
	 * the chip to the next line. A <br> that only has line breaks / whitespace
	 * before it (or sits at the very start) is such an artifact; drop it.
	 */
	private sanitizeInputLayout(): void {
		for (const br of Array.from(this.inputEl.querySelectorAll("br"))) {
			let prev: Node | null = br.previousSibling;
			let onlyBreaksBefore = true;
			while (prev) {
				if (prev.nodeType === Node.ELEMENT_NODE) {
					if ((prev as HTMLElement).tagName === "BR") {
						prev = prev.previousSibling;
						continue;
					}
					onlyBreaksBefore = false;
					break;
				}
				if (prev.nodeType === Node.TEXT_NODE && (prev.textContent || "").trim().length > 0) {
					onlyBreaksBefore = false;
					break;
				}
				prev = prev.previousSibling;
			}
			if (onlyBreaksBefore) br.remove();
		}
	}

	/** Read dropped notes' content (capped) to fold into the query context. */
	private async buildAttachmentContext(paths: string[]): Promise<string> {
		if (paths.length === 0) return "";
		const parts: string[] = [];
		for (const path of paths) {
			try {
				const file = this.vault.getAbstractFileByPath(path);
				if (file instanceof TFile) {
					const content = await this.vault.cachedRead(file);
					parts.push(`【笔记 ${paths.indexOf(path) + 1}/${paths.length}：${path}】\n${content.slice(0, 3000)}`);
				}
			} catch {
				// skip unreadable attachments
			}
		}
		return parts.length
			? `\n\n用户拖入了 ${parts.length} 个笔记，以下内容必须仔细阅读，并直接基于这些内容回答用户的问题：\n${parts.join("\n\n")}`
			: "";
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
		this.attachments = [];
	}

	/** Record a user question into the current session (creating one if needed). */
	private async recordUserMessage(content: string, segments?: HistorySegment[]): Promise<void> {
		// CRITICAL: load() first — otherwise a fresh store (after a plugin
		// reload) starts with an empty array and save() would overwrite all
		// previously persisted sessions with just this one.
		await this.history.load();
		if (!this.currentSessionId) {
			this.currentSessionId = this.history.createSession(content);
		}
		const msg: HistoryMessage = { role: "user", content, segments, timestamp: Date.now() };
		this.currentMessages.push(msg);
		this.history.addMessage(this.currentSessionId, msg);
		void this.history.save();
	}

	/** Record an assistant answer into the current session. */
	private async recordAssistantMessage(content: string, thinking?: ThinkingStep[], sources?: string[], elapsedSec?: number): Promise<void> {
		if (!this.currentSessionId) return;
		await this.history.load();
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
				if (msg.segments && msg.segments.length > 0) {
					this.appendUserMessageFromSegments(msg.segments);
				} else {
					this.appendUserMessage(msg.content);
				}
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

	/**
	 * Serialize the input's DOM (text + chips, in order) into segments for
	 * chat-history persistence. Text runs are merged; chips become file
	 * segments carrying their vault path.
	 */
	private snapshotSegments(root: HTMLElement): HistorySegment[] {
		const segs: HistorySegment[] = [];
		const pushText = (t: string): void => {
			if (!t) return;
			const last = segs[segs.length - 1];
			if (last && last.type === "text") last.value += t;
			else segs.push({ type: "text", value: t });
		};
		const walk = (node: Node): void => {
			if (node.nodeType === Node.TEXT_NODE) {
				pushText(node.textContent || "");
				return;
			}
			if (node.nodeType !== Node.ELEMENT_NODE) return;
			const el = node as HTMLElement;
			if (el.tagName === "BR") {
				pushText("\n");
				return;
			}
			if (el.classList.contains("semlink-wikilink")) {
				const path = el.getAttribute("data-path");
				if (path) segs.push({ type: "file", value: path });
				return; // don't descend into the wiki-link internals
			}
			if (el.tagName === "DIV" || el.tagName === "P") {
				pushText("\n");
				el.childNodes.forEach(walk);
				pushText("\n");
				return;
			}
			el.childNodes.forEach(walk);
		};
		walk(root);
		// Trim leading/trailing whitespace from the first/last text segments.
		if (segs.length > 0) {
			const first = segs[0];
			if (first.type === "text") first.value = first.value.replace(/^[\s\n]+/, "");
			const last = segs[segs.length - 1];
			if (last.type === "text") last.value = last.value.replace(/[\s\n]+$/, "");
		}
		return segs.filter((s) => !(s.type === "text" && s.value.length === 0));
	}

	/**
	 * Append a right-aligned user bubble rebuilt from persisted segments
	 * (used when loading a chat session from history).
	 */
	private appendUserMessageFromSegments(segments: HistorySegment[]): void {
		this.messagesEl.querySelector(".semlink-search-welcome")?.remove();
		const turn = this.messagesEl.createDiv({ cls: "semlink-msg-turn semlink-msg-user-turn" });
		const bubble = turn.createDiv({ cls: "semlink-msg-bubble semlink-msg-user" });
		for (const seg of segments) {
			if (seg.type === "text") {
				bubble.append(seg.value);
			} else {
				bubble.appendChild(this.createWikilink(seg.value));
			}
		}
	}

	/**
	 * Append a right-aligned user query bubble. When `content` (a DOM snapshot
	 * of the input) is provided, the bubble reproduces the text + inline
	 * wiki-link mix the user composed; otherwise it renders plain `text`.
	 */
	private appendUserMessage(text: string, content?: HTMLElement): void {
		// Remove the welcome placeholder once the first real message arrives.
		this.messagesEl.querySelector(".semlink-search-welcome")?.remove();
		const turn = this.messagesEl.createDiv({ cls: "semlink-msg-turn semlink-msg-user-turn" });
		const bubble = turn.createDiv({ cls: "semlink-msg-bubble semlink-msg-user" });
		if (content) {
			this.sanitizeBubbleContent(content);
			bubble.appendChild(content);
		} else {
			bubble.textContent = text;
		}
	}

	/**
	 * Prepare an input snapshot for rendering in a sent bubble:
	 * - drop `contenteditable` from the root AND the wiki links (the message
	 *   must not remain editable),
	 * - keep wiki links clickable to open their note,
	 * - strip the trailing blank line(s) browsers leave in contenteditable
	 *   (a trailing `<div><br></div>` would render as empty lines).
	 */
	private sanitizeBubbleContent(content: HTMLElement): void {
		content.removeAttribute("contenteditable");
		// Drop the input class so the bubble's own color (white) applies —
		// otherwise `.semlink-search-input`'s `color: var(--text-normal)`
		// overrides the inherited bubble color.
		content.removeClass("semlink-search-input");
		content.querySelectorAll(".semlink-wikilink").forEach((link) => {
			link.removeAttribute("contenteditable");
			const path = link.getAttribute("data-path");
			if (path) {
				link.addEventListener("click", (e) => {
					e.stopPropagation();
					void this.app.workspace.openLinkText(path, "", false);
				});
			}
		});
		// Trim trailing whitespace / <br> / empty block elements.
		for (;;) {
			const last = content.lastChild;
			if (!last) break;
			if (last.nodeType === Node.TEXT_NODE && (last.textContent || "").trim() === "") {
				content.removeChild(last);
				continue;
			}
			if (last.nodeType === Node.ELEMENT_NODE) {
				const el = last as HTMLElement;
				if (el.tagName === "BR") {
					content.removeChild(el);
					continue;
				}
				if ((el.tagName === "DIV" || el.tagName === "P") && (el.textContent || "").trim() === "") {
					content.removeChild(el);
					continue;
				}
			}
			break;
		}
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
