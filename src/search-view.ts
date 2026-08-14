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
import { inferAgentDepth, buildNoteContext } from "./chat-client";
import type { SearchResult, ChatSession, HistoryMessage, HistorySegment } from "./types";
import { ChatHistoryStore } from "./chat-history";
import { MapArchiveStore } from "./map-archive-store";
import { SemanticMapController } from "./semantic-map";
import { SaveNoteModal } from "./save-note-modal";
import { t } from "./i18n";
import logoSvg from "./semlink-logo.svg";
import llmIconSvg from "./network-icon.svg";
import expandIconSvg from "./expand-icon.svg";
import collapseIconSvg from "./collapse-icon.svg";

export const SEARCH_VIEW_TYPE = "semlink-semantic-search";

const DEFAULT_LIMIT = 10;
const DEFAULT_THRESHOLD = 0.3;

/** Replace an element's contents with the given SVG markup. Uses the DOM
 *  parser instead of innerHTML (keeps the Obsidian lint rules clean) and
 *  yields the exact same element tree for the imported .svg assets. */
function setSvgIcon(el: HTMLElement, svg: string): void {
	el.empty();
	const root = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
	if (root && root.tagName !== "parsererror") el.appendChild(root);
}

/** Static prompt pool shown on the welcome screen — three are picked at
 *  random each render (icon + i18n key). */
const HOME_SUGGESTION_POOL: Array<{ key: string; icon: string }> = [
	// ── Topic examples / current-note ──
	{ key: "searchSugReading", icon: "📖" },
	{ key: "searchSugCurrentSummary", icon: "📝" },
	// ── Knowledge-base retrieval / aggregation ──
	{ key: "searchSugRecent", icon: "📆" },
	{ key: "searchSugReview", icon: "🧭" },
	{ key: "searchSugDuplicates", icon: "🔍" },
	// ── Knowledge-base organization / management ──
	{ key: "searchSugMonthlyTpl", icon: "📅" },
];

/** Replace hyphens between word chars with non-breaking hyphens (U+2011)
 *  so paths like "S-104_...md" never break right after the dash — they
 *  wrap at "/" instead. Visually identical; safe for markdown syntax
 *  (list dashes and "---" rules don't match the surrounding-word rule). */
function protectHyphens(text: string): string {
	return text.replace(/(?<=[\w\u4e00-\u9fff])\-(?=[\w\u4e00-\u9fff])/g, "\u2011");
}

/** Recency bucket for a session timestamp: today / yesterday / 3天前 /
 *  lastWeek / lastMonth / earlier. */
function historyBucket(ts: number, now: number): string {
	const DAY = 86400000;
	const startOfToday = new Date(now).setHours(0, 0, 0, 0);
	if (ts >= startOfToday) return "today";
	if (ts >= startOfToday - DAY) return "yesterday";
	if (ts >= now - 3 * DAY) return "daysAgo";
	if (ts >= now - 7 * DAY) return "lastWeek";
	if (ts >= now - 30 * DAY) return "lastMonth";
	return "earlier";
}

/** i18n keys for the history group headers. */
const HISTORY_GROUP_KEYS: Record<string, string> = {
	today: "historyGroupToday",
	yesterday: "historyGroupYesterday",
	daysAgo: "historyGroupDaysAgo",
	lastWeek: "historyGroupLastWeek",
	lastMonth: "historyGroupLastMonth",
	earlier: "historyGroupEarlier",
};

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
	private headerEl!: HTMLElement;   // top header (brand + icon sides)
	private menuBtnEl: HTMLElement | null = null; // history drawer toggle
	private headerRightIconsEl!: HTMLElement; // right icon group (ring + settings)
	private settingsBtnEl!: HTMLElement;      // settings gear (ring sits left of it)
	private firstQuestionEl!: HTMLElement; // second row: first question in small text
	private firstQuestion = "";       // first user question (header subtitle)
	private headerCompact = false;    // whether the subtitle row is visible
	private contextRingEl!: HTMLElement | null; // context-usage donut
	private contextUsageEl!: HTMLElement | null; // wrapper (hidden until first msg)
	private contextPctEl!: HTMLElement | null;
	private tooltipEl!: HTMLElement | null; // context-usage tooltip
	private tooltipHideTimer: number | null = null; // delayed-hide timer
	// Send-button state machine: idle(send) → loading(spin) → stop(abort).
	private searchBtnEl!: HTMLButtonElement;
	private isGenerating = false;
	/** Input tall mode (half-screen editor for long prompts). */
	private inputExpanded = false;
	private expandBtnEl: HTMLElement | null = null;
	private inputHintEl: HTMLElement | null = null;
	private activeAskController: AbortController | null = null;
	private lastBreakdown: ContextBreakdown | null = null;
	private lastCacheHitRate: number | null = null;
	private modelNameEl: HTMLElement | null = null;
	private modelTriggerEl: HTMLElement | null = null;
	private modelPopupEl: HTMLElement | null = null;
	/** Time-slot key of the currently shown welcome greeting. */
	private currentWelcomeKey: string | null = null;
	/** Home ("new session") button — hidden while the welcome screen is up. */
	private newChatBtnEl: HTMLElement | null = null;
	/** Auto-link "related notes" card state: debounce timer, last-seen path
	 *  guard (skip redundant fetches), and an async token (stale guards). */
	private relatedLastPath: string | null = null;
	private relatedToken = 0;
	private relatedDebounce = 0;
	// Semantic map state: current view mode, the force-graph controller, the
	// graph container, the brand title line, the archive store, save debounce,
	// and a ResizeObserver to keep the canvas sized to its container.
	private currentMode: "chat" | "map" | "related" = "chat";
	private mapController: SemanticMapController | null = null;
	private mapGraphEl!: HTMLElement;
	private mapTitleEl!: HTMLElement;
	private mapArchive: MapArchiveStore;
	private mapSaveDebounce = 0;
	private mapResizeObserver: ResizeObserver | null = null;
	// Toolbar button refs (for is-active toggling) + related-notes view.
	private relatedBtnEl!: HTMLButtonElement;
	private mapBtnEl!: HTMLButtonElement;
	private mapClearBtnEl!: HTMLButtonElement;
	private relatedViewEl!: HTMLElement;
	/** Last markdown file the user viewed — fallback when this sidebar panel
	 *  is the focused (active) leaf, where getActiveFile() returns null. */
	private lastActiveNotePath: string | null = null;

	// Current conversation state
	private currentSessionId: string | null = null;
	private currentMessages: HistoryMessage[] = [];

	// Dropped note attachments (vault-relative paths) rendered as inline chips
	// mixed with the input text.
	private attachments: string[] = [];
	/** Full-panel drag guidance overlay (shown while dragging over the view). */
	private dragOverlayEl!: HTMLElement;
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
		this.mapArchive = new MapArchiveStore(dataDir);
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
		this.headerEl = header;
		// Left icon group: history menu + new-session (pencil).
		const leftIcons = header.createDiv({ cls: "semlink-search-header-side" });
		const menuBtn = leftIcons.createEl("button", {
			cls: "semlink-search-icon-btn clickable-icon",
			attr: { "aria-label": t("historyTitle"), title: t("historyTitle") },
		});
		this.menuBtnEl = menuBtn;
		setIcon(menuBtn, "menu");
		menuBtn.addEventListener("click", () => this.showHistoryDrawer());
		const newChatBtn = leftIcons.createEl("button", {
			cls: "semlink-search-icon-btn clickable-icon",
			attr: { "aria-label": t("searchNewChat"), title: t("searchNewChat") },
		});
		this.newChatBtnEl = newChatBtn;
		// Home icon: Obsidian's icon set has no house icon, so inline the
		// classic lucide home (house + door) — same stroke style as built-in
		// icons, 24px to match Obsidian's default icon size.
		const homeSvg = newChatBtn.createSvg("svg", {
			cls: "svg-icon",
			attr: {
				viewBox: "0 0 24 24",
				width: "24",
				height: "24",
				fill: "none",
				stroke: "currentColor",
				"stroke-width": "2",
				"stroke-linecap": "round",
				"stroke-linejoin": "round",
				"aria-hidden": "true",
			},
		});
		homeSvg.createSvg("path", { attr: { d: "m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" } });
		homeSvg.createSvg("polyline", { attr: { points: "9 22 9 12 15 12 15 22" } });
		newChatBtn.addEventListener("click", () => {
			this.startNewSession();
			this.messagesEl.empty();
			this.statusEl.textContent = "";
			this.inputEl.empty();
			this.renderWelcome();
			// Empty area cannot hide a first question — drop the subtitle row.
			this.updateCompactHeader();
			this.inputEl.focus();
		});
		// Centered brand (logo + "Semlink" — always stays).
		const brand = header.createDiv({ cls: "semlink-search-brand-group" });
		const logoEl = brand.createDiv({ cls: "semlink-search-logo" });
		setSvgIcon(logoEl, logoSvg);
		brand.createDiv({ cls: "semlink-search-brand", text: "Semlink" });
		// Right icon group: context-usage ring + settings.
		const rightIcons = header.createDiv({ cls: "semlink-search-header-side semlink-search-header-right" });
		this.headerRightIconsEl = rightIcons;
		const settingsBtn = rightIcons.createEl("button", {
			cls: "semlink-search-icon-btn clickable-icon",
			attr: { "aria-label": t("settingsTitle"), title: t("settingsTitle") },
		});
		this.settingsBtnEl = settingsBtn;
		setIcon(settingsBtn, "settings");
		settingsBtn.addEventListener("click", () => {
			(this.app as any).setting.open();
			(this.app as any).setting.openTabById("semlink");
		});
		// Second header row: the first question in small text. It appears
		// only while the first question is scrolled under the header (see
		// updateCompactHeader) so the conversation topic stays visible.
		const firstQ = header.createDiv({ cls: "semlink-search-first-question" });
		this.firstQuestionEl = firstQ;
		// Second header row (the same slot as the chat subtitle): the current
		// view name, shown only in map mode. Empty → collapsed via CSS :empty.
		this.mapTitleEl = header.createDiv({ cls: "semlink-search-view-title" });

		// ── Conversation area (middle, scrollable) ──
		this.statusEl = contentEl.createDiv({ cls: "semlink-search-status" });
		this.messagesEl = contentEl.createDiv({ cls: "semlink-search-messages" });
		this.renderWelcome();

		// Show the subtitle row once the first question hides under the header.
		this.registerDomEvent(this.messagesEl, "scroll", () => this.updateCompactHeader());

		// The greeting is time-based — refresh it automatically when the time
		// slot changes (e.g. 11:59 → 12:00), no reload needed. Only re-renders
		// while the welcome is still visible (before the first message).
		this.registerInterval(
			window.setInterval(() => {
				const key = this.welcomeKeyForHour();
				if (key === this.currentWelcomeKey) return;
				const existing = this.messagesEl.querySelector(".semlink-search-welcome");
				if (!existing) return;
				existing.remove();
				this.renderWelcome();
			}, 60_000),
		);

		// When the user switches notes, refresh the "related notes" card on
		// the welcome screen so it always reflects the currently open note.
		this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
			// Track the last markdown note so map mode can seed from it even
			// when this sidebar panel is the focused (active) leaf.
			if (leaf?.view instanceof MarkdownView && leaf.view.file) {
				this.lastActiveNotePath = leaf.view.file.path;
			}
			this.maybeRefreshRelated();
		}));

		// ── Semantic map container (fills the middle area in map mode) ──
		this.mapGraphEl = contentEl.createDiv({ cls: "semlink-search-graph" });
		// ── Related-notes list container (fills the middle in related mode) ──
		this.relatedViewEl = contentEl.createDiv({ cls: "semlink-search-related-view" });

		// ── Input footer (bottom, fixed) ──
		const footer = contentEl.createDiv({ cls: "semlink-search-footer" });

		// Function-button toolbar (sits above the input), like a mobile app's
		// action row. First button toggles the semantic map; "trash" clears it.
		const toolbar = footer.createDiv({ cls: "semlink-search-toolbar" });
		// Each tool = icon + label text. Selecting one switches the view mode.
		this.relatedBtnEl = this.makeToolbarBtn(toolbar, "list", "relatedButtonTitle", () => this.setMode(this.currentMode === "related" ? "chat" : "related"));
		this.mapBtnEl = this.makeToolbarBtn(toolbar, "workflow", "mapButtonTitle", () => this.toggleMapMode());
		// Clear (map only) — pushed to the far right.
		this.mapClearBtnEl = this.makeToolbarBtn(toolbar, "trash-2", "mapClear", () => this.clearMap(), "semlink-search-toolbar-btn-right");

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
		// WHOLE-PANEL drag & drop: dropping notes anywhere in the view (not
		// just the input) attaches them, with a guidance overlay shown while
		// dragging. The overlay guides the user; the drop reuses the same
		// handleFileDrop path (dedup makes double-handling safe).
		this.dragOverlayEl = contentEl.createDiv({ cls: "semlink-drag-overlay semlink-hidden" });
		this.dragOverlayEl.createSpan({ text: t("dragOverlayHint") });

		let panelDragDepth = 0;
		contentEl.addEventListener("dragover", (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
		});
		contentEl.addEventListener("dragenter", (e) => {
			e.preventDefault();
			e.stopPropagation();
			panelDragDepth++;
			this.dragOverlayEl.removeClass("semlink-hidden");
		});
		contentEl.addEventListener("dragleave", (e) => {
			e.preventDefault();
			e.stopPropagation();
			panelDragDepth = Math.max(0, panelDragDepth - 1);
			if (panelDragDepth === 0) this.dragOverlayEl.addClass("semlink-hidden");
		});
		// Capture-phase drop on document (Obsidian's own handlers would
		// otherwise swallow it), scoped to this panel. The input-wrapper
		// handler above still runs first for its own zone; handleFileDrop is
		// idempotent, so double delivery is harmless.
		this.registerDomEvent(
			document,
			"drop",
			(e) => {
				const target = e.target;
				if (!(target instanceof Element) || !target.closest(".semlink-search-view")) return;
				e.preventDefault();
				e.stopPropagation();
				panelDragDepth = 0;
				this.dragOverlayEl.addClass("semlink-hidden");
				void this.handleFileDrop(e);
				this.inputEl.focus();
			},
			true,
		);
		const inputRow = wrapper.createDiv({ cls: "semlink-search-input-row" });
		// Keyboard hint (Ctrl+Enter newline / Enter send) — visible only while
		// the input is expanded to the tall editor.
		this.inputHintEl = wrapper.createDiv({
			cls: "semlink-search-input-hint",
			text: t("searchInputHint"),
		});
		this.inputHintEl.addClass("semlink-hidden");
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
			if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return;
			if (e.ctrlKey || e.metaKey) {
				// Ctrl+Enter: insert a newline via the Range API — browsers'
				// execCommand("insertLineBreak") is unreliable in some hosts,
				// and the default action may be swallowed elsewhere.
				e.preventDefault();
				this.insertLineBreakAtCaret();
				return;
			}
			if (e.shiftKey) return; // Shift+Enter: default contenteditable newline.
			// Plain Enter sends.
			e.preventDefault();
			// While generating, Enter must not spawn a second run.
			if (this.isGenerating) return;
			void this.runSearch();
			// Scroll to the bottom right away so the new message and the
			// loading state are immediately visible.
			this.scrollToBottom();
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
		// Clicking the model name (with its "▾" arrow) opens the
		// model-switcher popup (same pattern as the search-depth popup).
		const modelEl = wrapper.createDiv({ cls: "semlink-search-model" });
		const modelLabel = this.chatClient.getActiveModelLabel();
		// Context-usage ring lives in the HEADER's right icon group (next to the
		// settings gear), not in the input row — it stays visible while typing.
		if (modelLabel && this.chatClient.getActiveContextWindow()) {
			// Ring-only indicator (no percentage text), inserted BEFORE the
			// settings button so it sits to its left. The tooltip only triggers
			// when hovering the ring.
			const usageEl = this.headerRightIconsEl.createDiv({ cls: "semlink-context-usage" });
			const ringEl = usageEl.createDiv({ cls: "semlink-context-ring" });
			const ringSvg = ringEl.createSvg("svg", { attr: { viewBox: "0 0 36 36" } });
			ringSvg.createSvg("circle", { cls: "ring-bg", attr: { cx: 18, cy: 18, r: 15.9 } });
			ringSvg.createSvg("circle", { cls: "ring-fg", attr: { cx: 18, cy: 18, r: 15.9 } });
			this.contextRingEl = ringEl;
			this.contextPctEl = null;
			this.contextUsageEl = usageEl;
			// Hidden until the first message is sent (no context usage to show
			// on an empty conversation).
			usageEl.addClass("semlink-hidden");
			// Move the ring to the LEFT of the settings button.
			if (this.settingsBtnEl) {
				this.headerRightIconsEl.insertBefore(usageEl, this.settingsBtnEl);
			}

			// Tooltip with the context breakdown, shown on hover. Created
			// lazily on document.body so `position: fixed` is never thrown off
			// by transformed/clipping ancestors inside the Obsidian leaf.
			this.tooltipEl = null;
			usageEl.addEventListener("mouseenter", () => this.showContextTooltip());
			usageEl.addEventListener("mouseleave", () => {
				// Delayed hide: the tooltip floats a few px away, so moving the
				// mouse across the gap must not dismiss it instantly. The tooltip's
				// own mouseenter cancels the timer.
				if (this.tooltipHideTimer) window.clearTimeout(this.tooltipHideTimer);
				this.tooltipHideTimer = window.setTimeout(() => this.hideContextTooltip(), 200);
			});
		} else {
			this.contextRingEl = null;
			this.contextPctEl = null;
			this.contextUsageEl = null;
			this.tooltipEl = null;
		}
		const modelTrigger = modelEl.createSpan({ cls: "semlink-search-model-trigger" });
		// LLM icon instead of the verbose "provider/model" text label.
		this.modelNameEl = modelTrigger.createSpan({ cls: "semlink-search-model-name" });
		setSvgIcon(this.modelNameEl, llmIconSvg);
		this.modelTriggerEl = modelTrigger;
		modelTrigger.addEventListener("click", (e) => {
			e.stopPropagation();
			this.toggleModelPopup();
		});
		this.registerDomEvent(document, "click", () => this.hideModelPopup());

		// Expand/collapse toggle left of the send button: grows the input to
		// half the screen for long prompts, collapses back on click (and after
		// every send). Custom icons (outward/inward corner arrows).
		const expandBtn = modelEl.createEl("button", {
			cls: "semlink-search-icon-btn semlink-search-expand-btn",
			attr: { "aria-label": t("searchExpandInput"), title: t("searchExpandInput") },
		});
		this.expandBtnEl = expandBtn;
		setSvgIcon(expandBtn, expandIconSvg);
		expandBtn.addEventListener("click", () => {
			this.inputExpanded = !this.inputExpanded;
			this.applyInputExpanded();
		});

		// Send button lives on the model row (right side), not beside the input.
		// State machine: send → loading(spin) → stop(click aborts the run) → send.
		const searchBtn = modelEl.createEl("button", {
			cls: "semlink-search-btn",
			attr: { "aria-label": t("searchSend"), title: t("searchSend") },
		});
		this.searchBtnEl = searchBtn;
		setIcon(searchBtn, "arrow-up");
		searchBtn.addEventListener("click", () => {
			if (this.isGenerating) {
				// Stop button: abort the in-flight generation.
				this.activeAskController?.abort();
				this.setSendButtonState("idle");
				return;
			}
			void this.runSearch();
			this.scrollToBottom();
		});

		if (!this.hasApiKey()) {
			this.statusEl.textContent = t("searchNeedApiKey");
		}
	}

	protected async onClose(): Promise<void> {
		this.disposeMap();
		if (this.tooltipEl) {
			this.tooltipEl.remove();
			this.tooltipEl = null;
		}
		if (this.modelPopupEl) {
			this.modelPopupEl.remove();
			this.modelPopupEl = null;
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

	/** Send-button state machine: "idle"(arrow-up) | "stop"(solid square, aborts the run). */
	private setSendButtonState(state: "idle" | "stop"): void {
		const btn = this.searchBtnEl;
		if (!btn) return;
		btn.empty();
		if (state === "idle") {
			setIcon(btn, "arrow-up");
			btn.setAttr("aria-label", t("searchSend"));
			btn.setAttr("title", t("searchSend"));
		} else {
			// Custom solid stop icon (ring + filled square): Obsidian's icon
			// set has no filled stop variant, so inline the SVG directly.
			// Both paths use fill="currentColor" to follow the button color.
			const svg = btn.createSvg("svg", {
				attr: { viewBox: "0 0 1040 1024", "aria-hidden": "true" },
			});
			svg.createSvg("path", { attr: { fill: "currentColor", d: "M512 64c60.5 0 119.2 11.8 174.4 35.2 53.3 22.6 101.3 54.9 142.4 96 41.2 41.2 73.5 89.1 96 142.4C948.2 392.8 960 451.5 960 512s-11.8 119.2-35.2 174.4c-22.6 53.3-54.9 101.3-96 142.4-41.2 41.2-89.1 73.5-142.4 96C631.2 948.2 572.5 960 512 960s-119.2-11.8-174.4-35.2c-53.3-22.6-101.3-54.9-142.4-96-41.2-41.2-73.5-89.1-96-142.4C75.8 631.2 64 572.5 64 512s11.8-119.2 35.2-174.4c22.6-53.3 54.9-101.3 96-142.4 41.2-41.2 89.1-73.5 142.4-96C392.8 75.8 451.5 64 512 64m0-64C229.2 0 0 229.2 0 512s229.2 512 512 512 512-229.2 512-512S794.8 0 512 0z" } });
			svg.createSvg("path", { attr: { fill: "currentColor", d: "M716 304H308c-2.2 0-4 1.8-4 4v408c0 2.2 1.8 4 4 4h408c2.2 0 4-1.8 4-4V308c0-2.2-1.8-4-4-4z" } });
			btn.setAttr("aria-label", t("searchStop"));
			btn.setAttr("title", t("searchStop"));
		}
	}

	/** Sync the input height + toggle icon with this.inputExpanded. */
	private applyInputExpanded(): void {
		this.inputEl.toggleClass("is-expanded", this.inputExpanded);
		// The keyboard hint appears only in the tall editor.
		if (this.inputHintEl) this.inputHintEl.toggleClass("semlink-hidden", !this.inputExpanded);
		const btn = this.expandBtnEl;
		if (!btn) return;
		setSvgIcon(btn, this.inputExpanded ? collapseIconSvg : expandIconSvg);
		const label = t(this.inputExpanded ? "searchCollapseInput" : "searchExpandInput");
		btn.setAttr("aria-label", label);
		btn.setAttr("title", label);
	}

	private async runSearch(): Promise<void> {
		const query = this.extractInputText().trim();
		if (!query) return;
		if (!this.hasApiKey()) {
			this.statusEl.textContent = t("searchNeedApiKey");
			return;
		}

		// Enter generating mode: abort controller for /stop-style cancellation;
		// the send button immediately becomes the clickable stop button.
		this.isGenerating = true;
		const controller = new AbortController();
		this.activeAskController = controller;
		this.setSendButtonState("stop");

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
		// First message sent → the context-usage ring becomes relevant.
		if (this.contextUsageEl) this.contextUsageEl.removeClass("semlink-hidden");
		this.clearInputText();
		// Sending restores the input to its compact height (expand icon back).
		if (this.inputExpanded) {
			this.inputExpanded = false;
			this.applyInputExpanded();
		}

		// Snapshot the dropped notes for THIS turn — the attachments array is
		// reset when the turn finishes, so the chips act as part of the message
		// rather than persisting across turns.
		const turnAttachments = this.attachments;

		// Append a loading placeholder for the assistant's reply.
		const loadingEl = this.appendAssistantMessage(t("searchSearching"));

		// "思考了 X 秒（搜索中）" ticking during the search phase (embed +
		// vector search). The timer self-cleans once the placeholder line is
		// emptied/removed by whichever branch takes over. thinkStart covers
		// the WHOLE turn (search + chat), so the counter never resets.
		const thinkStart = Date.now();
		const initialLoading = loadingEl.querySelector(".semlink-msg-loading");
		const searchTick = (): void => {
			if (!initialLoading?.isConnected) {
				window.clearInterval(searchAnim);
				return;
			}
			const secs = Math.max(1, Math.round((Date.now() - thinkStart) / 1000));
			initialLoading.textContent = t("searchSearchingElapsed").replace("{seconds}", String(secs));
		};
		const searchAnim = window.setInterval(searchTick, 350);
		searchTick();

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
				// Loading line: animated status text + a "▸" marker on the LEFT
				// (via ::before, same as the thinking summary). Clicking the
				// whole line toggles the live thinking preview below. The
				// animated dots live in a FIXED-WIDTH slot so nothing jitters.
				const loadingTextEl = loadingEl.createDiv({ cls: "semlink-msg-loading" });
				const loadingTextSpan = loadingTextEl.createSpan({ cls: "semlink-msg-loading-text", text: t("searchThinking") });
				const loadingDotsSpan = loadingTextEl.createSpan({ cls: "semlink-msg-loading-dots" });
				const streamEl = loadingEl.createDiv({ cls: "semlink-msg-stream semlink-hidden" });

				// Status indicator: the elapsed-seconds counter ticks along once
				// per second (the phase label itself stays static — no dots).
				let answerAnim: number | null = null;
				const stopAnswerAnim = (): void => {
					if (answerAnim !== null) {
						window.clearInterval(answerAnim);
						answerAnim = null;
					}
				};
				const startDots = (label: string): void => {
					loadingTextEl.removeClass("semlink-hidden");
					streamEl.addClass("semlink-hidden");
					streamEl.textContent = "";
					stopAnswerAnim();
					// Static status text — NO animated dots ("思考了 14 秒（生成
					// 回答中）"). Only the elapsed seconds tick along once per
					// second.
					const render = (): void => {
						const secs = Math.max(1, Math.round((Date.now() - thinkStart) / 1000));
						// Plain number ("1 秒", "10 秒") — no zero padding.
						loadingTextSpan.textContent =
							t("searchThinkingElapsed")
								.replace("{seconds}", String(secs))
								.replace("{status}", label) + "）";
						loadingDotsSpan.textContent = "";
					};
					answerAnim = window.setInterval(render, 1000);
					render();
				};
				// Keep the "思考了 X 秒（搜索中）" counter running through the
				// first model round-trip; the round-start / tool / stream
				// callbacks swap in their own status labels.
				startDots(t("searchSearchingStatus"));
				// Whether any tool has been called yet — decides whether the
				// next round is "thinking" (模型思考中) or the final answer
				// generation (生成回答中).
				let hasCalledTool = false;

				// The initial evidence step (search_notes / read_attachments) is
				// known up front — seed the LIVE thinking preview with it.
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

				// Live thinking preview while generating: hidden by default;
				// clicking the loading line toggles it. Renders the same steps
				// the finished answer's thinking section will show.
				const liveSteps: ThinkingStep[] = [firstStep];
				const liveBody = loadingEl.createDiv({ cls: "semlink-thinking-live-body" });
				liveBody.addClass("semlink-hidden");
				// Steps rendered so far. New steps are APPENDED (never a full
				// re-render) so an expanded tool call stays expanded while the
				// model keeps producing steps.
				let renderedSteps = 0;
				const refreshLiveBody = (): void => {
					if (liveBody.hasClass("semlink-hidden")) return;
					while (renderedSteps < liveSteps.length) {
						this.renderThinkingSteps(liveBody, [liveSteps[renderedSteps]]);
						renderedSteps++;
					}
				};
				loadingTextEl.addEventListener("click", () => {
					if (liveBody.hasClass("semlink-hidden")) {
						liveBody.removeClass("semlink-hidden");
						refreshLiveBody();
						loadingTextEl.addClass("is-open");
					} else {
						liveBody.addClass("semlink-hidden");
						loadingTextEl.removeClass("is-open");
					}
				});

				const context = hasAttachments
					? attachCtx
					: this.buildContext(results.slice(0, ANSWER_CONTEXT_SIZE)) + attachCtx;
					const fullContext = context;
					try {
					// Prior turns go as a native message array (ZCode-style —
					// chat-client expands them into the messages list and
					// truncates with a sliding window when needed). The latest
					// user message is THIS turn, so it's excluded here.
					const result = await this.chatClient.chat(
						fullContext,
						query,
						this.currentMessages.slice(0, -1),
						(toolName) => {
							// A tool is running — animate its label so a slow
							// tool (e.g. a full-vault grep) doesn't look frozen.
						hasCalledTool = true;
						startDots(t("searchToolCalling").replace("{tool}", toolName).replace(/…$/, ""));
					},
					// Analysis/overview-heavy prompts get deeper reading.
					inferAgentDepth(query),
					(text) => {
							// Answer streaming started.
							stopAnswerAnim();
							loadingTextEl.addClass("semlink-hidden");
							streamEl.removeClass("semlink-hidden");
							streamEl.textContent = text;
						},						() => {
							// Round start: before any tool was called it's the
							// thinking phase (模型思考中); after tools it's the
							// final answer generation (生成回答中).
							startDots(hasCalledTool ? t("searchGeneratingAnswer") : t("searchModelThinking"));
						},
						(step) => {
							// A new thinking step arrived — refresh the live
							// thinking preview. No auto-scroll: the user reads
							// from top to bottom during generation.
							liveSteps.push(step);
							refreshLiveBody();
						},
						(attempt, total) => {
							// Transient failure — show ZCode-style retry
							// progress instead of a frozen status.
							stopAnswerAnim();
							loadingTextEl.removeClass("semlink-hidden");
							streamEl.addClass("semlink-hidden");
							loadingTextSpan.textContent = t("searchReconnecting")
								.replace("{n}", String(attempt))
								.replace("{total}", String(total));
							loadingDotsSpan.textContent = "";
						},
							controller.signal,
						);
						const elapsedSec = Math.max(1, Math.round((Date.now() - thinkStart) / 1000));
					stopAnswerAnim();
					loadingEl.empty();
					// The model sometimes writes the FULL answer inside the
					// pre-analysis thinking step (common when the retrieved
					// snippets were already enough) and then leaves the real
					// answer as a one-liner — promoting that thought keeps the
					// content in the answer body instead of trapping it under 💭.
					let answer = result.answer;
					let thinking: ThinkingStep[] = result.thinking;
					if (answer.trim().length < 30 && thinking.length > 0) {
						for (let i = thinking.length - 1; i >= 0; i--) {
							const s = thinking[i];
							if (s.type === "thought" && s.text.trim().length >= 80) {
								answer = s.text;
								thinking = thinking.filter((_, j) => j !== i);
								break;
							}
						}
					}
					this.renderThinking(loadingEl, [firstStep, ...thinking], elapsedSec);
					this.updateContextInfo(result.contextTokens, result.contextBreakdown, result.cacheHitRate);
					// Render the answer as markdown (Obsidian's renderer handles
					// headings, lists, code, links, etc.).
					const answerEl = loadingEl.createDiv({ cls: "semlink-msg-answer markdown-rendered" });
					await MarkdownRenderer.render(this.app, protectHyphens(answer), answerEl, "", this);

					// Reference sources BELOW the answer, collapsed by default.
					// With attachments the sources ARE the dropped notes — plus
					// any notes the model read via tools afterwards (otherwise
					// protocol/design docs vanish from the sources card).
					const usedSources = hasAttachments
						? this.buildUsedSources(
							turnAttachments.map((p) => ({ chunkId: "", notePath: p, heading: "", contentPreview: "", score: -1 })),
							result.usedNotes,
						)
						: this.buildUsedSources(initialResults, result.usedNotes);
					this.renderSources(loadingEl, usedSources, false);

					// Persist this turn into chat history (incl. context usage so
					// the ring + tooltip can be restored when re-opening). The
					// initial retrieval step is prepended here too — otherwise
					// re-opened history would lose the search_notes evidence.
					await this.recordAssistantMessage(
						answer,
						[firstStep, ...thinking],
						result.usedNotes,
						elapsedSec,
						result.contextTokens,
						result.contextBreakdown,
						result.cacheHitRate,
					);

					// Action buttons (icons) below the sources: copy / save.
					this.appendActions(loadingEl, answer, query);
				} catch (e) {
					// User aborted — keep whatever streamed so far and show a
					// "stopped" notice instead of an error.
					if (controller.signal.aborted || (e as any)?.name === "AbortError") {
						stopAnswerAnim();
						loadingEl.empty();
						if (liveSteps.length > 0) {
							const elapsedSec = Math.max(1, Math.round((Date.now() - thinkStart) / 1000));
							this.renderThinking(loadingEl, liveSteps, elapsedSec);
						}
						loadingEl.createDiv({ cls: "semlink-msg-stopped", text: t("searchStopped") });
					} else {
						const msg = e instanceof Error ? e.message : String(e);
						stopAnswerAnim();
						loadingEl.empty();
						loadingEl.createDiv({ cls: "semlink-msg-error", text: `${t("searchError")} ${msg}` });
						// Keep the thinking process visible even when the answer
						// failed — show what the model did before the error.
						if (liveSteps.length > 0) {
							const elapsedSec = Math.max(1, Math.round((Date.now() - thinkStart) / 1000));
							this.renderThinking(loadingEl, liveSteps, elapsedSec);
						}
						// Fall back to the raw results (expanded) so the user still
						// gets something useful when the chat call fails.
						this.renderSources(loadingEl, results, true);
					}
				}
			} else {
				// No chat provider configured → show the plain result list.
				// Empty the bubble first so the search-phase loading line (and
				// its ticking counter) is removed.
				this.statusEl.textContent = t("searchNoChatProvider");
				loadingEl.empty();
				this.renderResultsIn(loadingEl, results);
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			loadingEl.empty();
			loadingEl.createDiv({ cls: "semlink-msg-error", text: `${t("searchError")} ${msg}` });
		} finally {
			// The dropped notes were consumed by this turn.
			this.attachments = [];
			// Leave generating mode: button back to send, controller released.
			this.isGenerating = false;
			this.activeAskController = null;
			this.setSendButtonState("idle");
		}
	}

	/** Build the note-context prompt for the chat model from search results.
	 *  Shared with the Feishu bot so both surfaces feed identical context. */
	private buildContext(results: SearchResult[]): string {
		return buildNoteContext(results);
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
		// No sources → no card (e.g. the chat failed before any retrieval).
		if (results.length === 0) return;
		// The sources card is its own card OUTSIDE the assistant bubble (the
		// bubble is the merged thinking+answer card) — append to the turn
		// container so it sits below the bubble as an independent card.
		const turn = container.closest(".semlink-msg-turn") || container;
		const details = turn.createEl("details", { cls: "semlink-search-sources" });
		if (open) details.setAttr("open", "");

		details.createEl("summary", {
			cls: "semlink-search-sources-summary",
			text: `${t("searchSources")} (${results.length})`,
		});

		const list = details.createDiv({ cls: "semlink-search-sources-list" });
		this.renderSourceRows(list, results);
	}

	/** One-line source rows (title + path), numbered like paper references. */
	private renderSourceRows(container: HTMLElement, results: SearchResult[]): void {
		for (const [i, r] of results.entries()) {
			const row = container.createDiv({ cls: "semlink-search-source-row" });
			row.createSpan({ cls: "semlink-search-source-index", text: `[${i + 1}]` });
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
		// Actions sit BELOW the reference sources card, outside the merged
		// thinking+answer bubble — append to the turn container (same as
		// renderSources).
		const turn = container.closest(".semlink-msg-turn") || container;
		const actionsEl = turn.createDiv({ cls: "semlink-msg-actions" });
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

	/** Fill the input with text, converting [[...]] tokens into clickable
	 *  wikilink chips (used by the suggestion cards) — same path as typed
	 *  or pasted wiki links, so they stay clickable in the sent bubble. */
	private setInputWithWikilinks(text: string): void {
		this.inputEl.empty();
		this.inputEl.focus();
		// Place the caret at the start so insertTextWithWikilinks has a range.
		const sel = window.getSelection();
		const range = document.createRange();
		range.selectNodeContents(this.inputEl);
		range.collapse(true);
		sel?.removeAllRanges();
		sel?.addRange(range);
		this.insertTextWithWikilinks(text);
		this.syncAttachmentsFromInput();
		this.sanitizeInputLayout();
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

	/** Insert a <br> at the caret (Ctrl+Enter). Works without execCommand. */
	private insertLineBreakAtCaret(): void {
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) return;
		const range = sel.getRangeAt(0);
		// Only act when the caret is inside our input.
		if (!this.inputEl.contains(range.commonAncestorContainer)) return;
		range.deleteContents();
		const br = document.createElement("br");
		range.insertNode(br);
		// Move the caret after the new break.
		range.setStartAfter(br);
		range.collapse(true);
		sel.removeAllRanges();
		sel.addRange(range);
		// Run the same bookkeeping as a native edit (attachments sync +
		// layout sanitize).
		this.inputEl.dispatchEvent(new InputEvent("input", { bubbles: true }));
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
			text: t("searchThinkingDuration").replace("{seconds}", this.formatDuration(elapsedSec)),
		});

		this.renderThinkingSteps(details, thinking);
	}

	/**
	 * Render the thinking steps (thoughts + tool calls) into a container.
	 * Shared by the finished answer's collapsible section and the LIVE
	 * preview shown while the answer is still being generated.
	 */
	private renderThinkingSteps(container: HTMLElement, steps: ThinkingStep[]): void {
		for (const step of steps) {
			if (!step) continue; // defensive: never crash on a malformed step
			if (step.type === "thought") {
				container.createDiv({ cls: "semlink-thinking-thought", text: `💭 ${step.text}` });
			} else {
				// Each tool call is one line by default; click to expand and
				// see the full request args and response.
				const callDetails = container.createEl("details", { cls: "semlink-tool-call" });
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
	}

	/** Analysis-heavy prompts (设计需求/总结/对比 etc.) get the "enhanced"
	 *  depth: full-note reads allowed and a larger per-result cap, so the
	 *  model can read related protocol/design docs before answering. */
	/** Compact one-line preview of the request args, e.g. " — MIBT". */
	private summarizeArgs(args: any): string {
		if (args && typeof args === "object") {
			const first = Object.entries(args).find(([, v]) => typeof v === "string" && v.length > 0);
			if (first) return ` — ${first[1]}`;
		}
		return "";
	}

	/** JSON in tool-call pre blocks — hyphens protected from line breaks. */
	private prettyJson(value: any): string {
		let out: string;
		if (typeof value === "string") out = value;
		else {
			try {
				out = JSON.stringify(value, null, 2);
			} catch {
				out = String(value);
			}
		}
		return protectHyphens(out);
	}

	/**
	 * Render a time-aware welcome message in the center of the conversation
	 * area when it's empty. Removed as soon as the user sends their first
	 * message. Greeting adapts to morning/afternoon/evening/night.
	 */
	private renderWelcome(): void {
		const key = this.welcomeKeyForHour();
		this.currentWelcomeKey = key;

		// i18n string: "emoji line1\nline2" — the leading emoji becomes a
		// floating badge, the rest the primary greeting, then the care note.
		const lines = t(key).split("\n");
		const welcome = this.messagesEl.createDiv({ cls: "semlink-search-welcome" });

		const firstLine = lines[0] || "";
		const emojiMatch = firstLine.match(/^(\p{Extended_Pictographic})\s*(.*)$/u);
		const emoji = emojiMatch ? emojiMatch[1] : "";
		const greetingText = emojiMatch ? emojiMatch[2] : firstLine;
		if (emoji) {
			welcome.createDiv({ cls: "semlink-search-welcome-emoji", text: emoji });
		}
		welcome.createDiv({ cls: "semlink-search-welcome-greeting", text: greetingText });
		if (lines[1]) {
			welcome.createDiv({ cls: "semlink-search-welcome-sub", text: lines[1] });
		}

		// Clickable prompt cards: FIXED questions (no LLM). Follow the active
		// document when one is open, otherwise pick three random examples from
		// the static pool.
		const sugRow = welcome.createDiv({ cls: "semlink-search-welcome-sugs" });
		this.renderFallbackCards(sugRow);

		// Index stats cards (best-effort; never fails the welcome screen).
		void this.renderWelcomeStats(welcome);

		this.updateHomeIconVisibility();
	}

	/** Fixed question cards: follow the active document when one is open,
	 *  otherwise three random examples from the static pool. */
	private renderFallbackCards(sugRow: HTMLElement): void {
		// Shuffle the pool and take three — every visit feels fresh.
		const cards = HOME_SUGGESTION_POOL
			.map((p) => ({ text: t(p.key), icon: p.icon }))
			.sort(() => Math.random() - 0.5)
			.slice(0, 3);
		for (const card of cards) {
			const el = sugRow.createDiv({ cls: "semlink-search-welcome-sug" });
			el.createSpan({ cls: "semlink-search-welcome-sug-icon", text: card.icon });
			el.createSpan({ cls: "semlink-search-welcome-sug-text", text: card.text });
			el.addEventListener("click", () => {
				// A run is already in flight — don't start a second one.
				if (this.isGenerating) return;
				this.setInputWithWikilinks(card.text);
				void this.runSearch();
			});
		}
	}

	/** Best-effort welcome extras: index stats as a small muted line.
	 *  Never fails the welcome. */
	private async renderWelcomeStats(welcome: HTMLElement): Promise<void> {
		let indexedNotes = 0;
		let activeChunks = 0;
		try {
			const s = await this.store.getStats();
			indexedNotes = s.indexedNotes;
			activeChunks = s.activeChunks;
		} catch {
			// Index stats are cosmetic — ignore any failure.
		}

		// Small line: "已索引 N 篇笔记 · X 个片段".
		welcome.createDiv({
			cls: "semlink-search-welcome-stats",
			text: t("searchWelcomeStats")
				.replace("{notes}", indexedNotes.toLocaleString())
				.replace("{chunks}", activeChunks.toLocaleString()),
		});
	}

	/** Build a toolbar button = icon + label text. Returns it so the caller can
	 *  toggle is-active. */
	private makeToolbarBtn(parent: HTMLElement, icon: string, labelKey: string, onClick: () => void, extraCls = ""): HTMLButtonElement {
		const btn = parent.createEl("button", {
			cls: `semlink-search-toolbar-btn ${extraCls}`,
			attr: { "aria-label": t(labelKey), title: t(labelKey) },
		});
		const iconEl = btn.createSpan({ cls: "semlink-search-toolbar-btn-icon" });
		setIcon(iconEl, icon);
		btn.createSpan({ cls: "semlink-search-toolbar-btn-text", text: t(labelKey) });
		btn.addEventListener("click", onClick);
		return btn;
	}

	/** Populate the related-notes view: a scrollable card list of notes
	 *  semantically similar to the current note. Token-guarded so a stale
	 *  fetch (user switched note/mode) never overwrites a newer render. */
	private async populateRelatedView(): Promise<void> {
		const container = this.relatedViewEl;
		container.empty();
		const path = this.getActiveNotePath();
		if (!path || !/\.(md|txt|markdown)$/i.test(path)) {
			container.createDiv({ cls: "semlink-search-related-empty", text: t("mapNoActiveNote") });
			return;
		}
		if (!this.hasApiKey()) {
			container.createDiv({ cls: "semlink-search-related-empty", text: t("mapNoApiKey") });
			return;
		}
		// Header: title + "based on <name>".
		const head = container.createDiv({ cls: "semlink-search-related-head" });
		head.createDiv({ cls: "semlink-search-related-title", text: t("searchRelatedTitle") });
		head.createDiv({ cls: "semlink-search-related-sub", text: t("searchRelatedSub").replace("{name}", this.basename(path)) });
		const list = container.createDiv({ cls: "semlink-search-related-list" });
		list.createDiv({ cls: "semlink-search-related-loading", text: t("searchRelatedLoading") });

		this.relatedToken++;
		const token = this.relatedToken;
		this.relatedLastPath = path;
		const stale = () => token !== this.relatedToken || this.currentMode !== "related";
		try {
			const chunks = await this.store.getChunksByNotePath(path);
			if (stale()) return;
			if (chunks.length === 0) {
				list.empty();
				list.createDiv({ cls: "semlink-search-related-empty", text: t("searchRelatedNotIndexed") });
				return;
			}
			const top = await this.getRelatedNotes(path, 10);
			if (stale()) return;
			list.empty();
			if (top.length === 0) {
				// Distinguish "no matches above threshold" from "vector index
				// not ready" (e.g. still indexing, or cache not loaded).
				let activeChunks = -1;
				try {
					activeChunks = (await this.store.getStats()).activeChunks;
				} catch {
					// stats are best-effort
				}
				if (stale()) return;
				const msg = activeChunks >= 0 && activeChunks < 5 ? t("mapNoVectors") : t("searchRelatedEmpty");
				list.createDiv({ cls: "semlink-search-related-empty", text: msg });
				return;
			}
			for (const r of top) {
				const item = list.createDiv({ cls: "semlink-search-related-item" });
				item.createDiv({ cls: "semlink-search-related-item-title", text: this.basename(r.notePath) });
				item.createDiv({ cls: "semlink-search-related-item-score", text: Math.round(r.score * 100) + "%" });
				item.title = r.notePath; // hover for full path
				item.addEventListener("click", () => { void this.openNote(r.notePath, r.preview); });
			}
		} catch {
			if (stale()) return;
			list.empty();
			list.createDiv({ cls: "semlink-search-related-empty", text: t("searchRelatedEmpty") });
		}
	}

	/** Refresh the related-notes view when the active note changes — but only
	 *  while in related mode. Debounced + same-path guard avoid redundant
	 *  embedding requests on rapid note switching. */
	private maybeRefreshRelated(): void {
		if (this.currentMode !== "related") return;
		window.clearTimeout(this.relatedDebounce);
		this.relatedDebounce = window.setTimeout(() => {
			const path = this.getActiveNotePath();
			if (path === this.relatedLastPath) return;
			void this.populateRelatedView();
		}, 300);
	}

	// ─────────────────────────────────────────────────────────────────
	// Semantic Map mode
	// ─────────────────────────────────────────────────────────────────

	/** Toggle between chat and map modes. */
	private toggleMapMode(): void {
		this.setMode(this.currentMode === "map" ? "chat" : "map");
	}

	/** Switch the panel between "chat", "map", and "related" modes. */
	private setMode(mode: "chat" | "map" | "related"): void {
		if (this.currentMode === mode) return;
		const prev = this.currentMode;
		this.currentMode = mode;
		// Root mode classes drive CSS show/hide of the three surfaces.
		this.contentEl.toggleClass("is-map-mode", mode === "map");
		this.contentEl.toggleClass("is-related-mode", mode === "related");
		// Brand title line reflects the current mode.
		this.mapTitleEl.setText(mode === "map" ? t("mapViewTitle") : mode === "related" ? t("relatedButtonTitle") : "");
		// Toolbar active state + clear-button visibility (clear = map only).
		this.relatedBtnEl.toggleClass("is-active", mode === "related");
		this.mapBtnEl.toggleClass("is-active", mode === "map");
		this.mapClearBtnEl.toggleClass("is-hidden", mode !== "map");
		if (prev === "map") {
			// Leaving map mode: stop observing. The archive was auto-saved.
			this.mapResizeObserver?.disconnect();
			this.mapResizeObserver = null;
		}
		if (mode === "map") {
			this.enterMapMode();
		} else if (mode === "related") {
			void this.populateRelatedView();
		}
	}

	/** Initialize (once) and populate the map, restoring the archive if any. */
	private enterMapMode(): void {
		if (!this.mapController) {
			this.mapController = new SemanticMapController(
				this.mapGraphEl,
				(p) => this.handleMapNodeClick(p),
				(p) => this.handleMapNodeDblClick(p),
			);
			try {
				this.mapController.init();
			} catch (e) {
				console.error("[Semlink] Failed to init semantic map:", e);
				this.showMapMessage("mapEmpty");
				return;
			}
			// Keep the canvas matched to its container as the panel resizes.
			this.mapResizeObserver = new ResizeObserver(() => this.mapController?.resize());
			this.mapResizeObserver.observe(this.mapGraphEl);
		}
		// Defer population to the next frame so the container has settled into
		// its map-mode layout (correct width/height) before force-graph draws.
		requestAnimationFrame(() => this.populateMap());
	}

	/** Populate the map: restore the archive if any, else seed from the note. */
	private populateMap(): void {
		if (this.currentMode !== "map" || !this.mapController) return;
		this.mapController.resize();

		const path = this.getActiveNotePath();
		const pathOk = !!path && /\.(md|txt|markdown)$/i.test(path);

		const archive = this.mapArchive.load();
		if (archive && archive.nodes.length > 0) {
			// Resume the previous exploration (positions + expanded flags).
			this.mapController.loadArchive(archive);
			// The archive is a single global snapshot, so after switching notes
			// it often doesn't contain the currently open note — the map would
			// show stale nodes and look "empty" relative to the Related list.
			// If the current note isn't in the restored graph, expand it so its
			// neighbours appear too.
			if (pathOk && this.hasApiKey() && !this.mapController.hasNode(path!)) {
				void this.expandMapNode(path!, true);
			}
			return;
		}

		// No archive yet: seed the map from the currently open note.
		if (!pathOk) {
			this.showMapMessage("mapNoActiveNote");
			return;
		}
		if (!this.hasApiKey()) {
			this.showMapMessage("mapNoApiKey");
			return;
		}
		// Seed: zoom-to-fit on the first expansion so the initial graph is framed.
		// Subsequent clicks pass doZoomToFit=false to preserve the user's view.
		void this.expandMapNode(path, true, true);
	}

	/** Resolve the "current note": prefer the truly active leaf, fall back to
	 *  the last markdown note we saw (the panel is the active leaf on click). */
	private getActiveNotePath(): string | null {
		const direct = this.app.workspace.getActiveFile();
		if (direct && /\.(md|txt|markdown)$/i.test(direct.path)) return direct.path;
		return this.lastActiveNotePath;
	}

	/** Retrieval core shared by the welcome card and the map: embed the note's
	 *  first chunk, search, dedup by note (highest score wins). Mirrors
	 *  toolGetSimilarNotes. Returns up to `limit` related notes (empty if the
	 *  note isn't indexed yet). */
	private async getRelatedNotes(notePath: string, limit = 6): Promise<{ notePath: string; heading: string; preview: string; score: number }[]> {
		// Max-pooling over the note's own chunks (computed in the DB engine):
		// probes several chunks spread across the whole document and keeps
		// each target note's best score. Symmetric, and lets large docs be
		// represented by their real topical sections instead of only chunks[0]
		// — which was a boilerplate header for some docs, yielding empty lists.
		const results = await this.store.searchRelatedNotes(notePath, limit, 0.2, 6);
		if (results.length === 0) {
			console.warn("[Semlink] related-notes search returned 0 results for", notePath, "— is the vector index loaded?");
		} else {
			console.log("[Semlink] related-notes:", results.length, "hits, top score", results[0].score.toFixed(3));
		}
		return results.map((r) => ({
			notePath: r.notePath,
			heading: r.heading,
			preview: r.contentPreview,
			score: r.score,
		}));
	}

	/** Grow the map around `path`: open the note and add its neighbours. Existing
	 *  nodes/links are kept, so the map expands progressively. `isCenter` marks
	 *  the seed node. A no-op refetch guard skips already-expanded nodes. */
	private async expandMapNode(path: string, isCenter: boolean, doZoomToFit = false): Promise<void> {
		if (!this.mapController) return;
		const name = this.basename(path);
		this.mapController.addNode(path, name, { isCenter });
		if (isCenter) this.mapController.setCenter(path);

		if (this.mapController.isExpanded(path)) {
			// Already expanded: single click is a no-op (double click opens the
			// note). Previously this called openNote, which made a single click
			// on an already-expanded node open the document — unwanted now that
			// click = expand, dblclick = open.
			return;
		}

		try {
			const related = await this.getRelatedNotes(path);
			if (this.currentMode !== "map") return; // user left map mode mid-fetch
			this.clearMapMessage();
			// Ensure the seed node exists even if it had no neighbours.
			this.mapController.addNode(path, name, { isCenter });
			for (const r of related) {
				this.mapController.addNode(r.notePath, this.basename(r.notePath));
				this.mapController.addLink(path, r.notePath);
			}
			this.mapController.markExpanded(path);
			this.mapController.render();
			this.mapController.reheat();
			if (doZoomToFit) this.mapController.zoomToFit();
			this.scheduleMapSave();
		} catch {
			this.showMapMessage("mapEmpty");
		}
	}

	/** Node click handler: open the note and grow the map around it. */
	private handleMapNodeClick(path: string): void {
		// Single click: make this node the center and expand its related notes.
		// (Ctrl/Cmd+click opens the note — see handleMapNodeDblClick.)
		void this.expandMapNode(path, true);
	}

	private handleMapNodeDblClick(path: string): void {
		// Double click: open the note.
		void this.openNote(path, "");
	}

	/** Debounced auto-save of the current map (layout + structure). */
	private scheduleMapSave(): void {
		window.clearTimeout(this.mapSaveDebounce);
		this.mapSaveDebounce = window.setTimeout(() => {
			if (this.mapController) this.mapArchive.save(this.mapController.exportArchive());
		}, 400);
	}

	/** Empty the map and persist an empty archive. */
	private clearMap(): void {
		this.mapController?.clear();
		this.mapArchive.clear();
		this.clearMapMessage();
	}

	/** Show a centered placeholder message in the graph container. */
	private showMapMessage(key: string): void {
		this.clearMapMessage();
		this.mapGraphEl.createDiv({ cls: "semlink-search-graph-empty", text: t(key) });
	}

	private clearMapMessage(): void {
		this.mapGraphEl.querySelector(".semlink-search-graph-empty")?.remove();
	}

	/** Tear down the map (called from onClose). */
	private disposeMap(): void {
		window.clearTimeout(this.mapSaveDebounce);
		this.mapResizeObserver?.disconnect();
		this.mapResizeObserver = null;
		this.mapController?.dispose();
		this.mapController = null;
	}

	/** Home icon is the "back to start" button — it only makes sense once a
	 *  conversation exists, so hide it while the welcome screen is up. */
	private updateHomeIconVisibility(): void {
		const onHome = !!this.messagesEl.querySelector(".semlink-search-welcome");
		this.newChatBtnEl?.toggleClass("is-hidden", onHome);
	}

	/** Re-render language-dependent UI after a language switch (settings). */
	refreshLanguage(): void {
		// Input placeholder.
		this.inputEl.setAttr("data-placeholder", t("searchPlaceholder"));
		this.inputEl.setAttr("aria-label", t("searchPlaceholder"));
		// Header icon tooltips.
		if (this.menuBtnEl) {
			this.menuBtnEl.setAttr("aria-label", t("historyTitle"));
			this.menuBtnEl.setAttr("title", t("historyTitle"));
		}
		if (this.newChatBtnEl) {
			this.newChatBtnEl.setAttr("aria-label", t("searchNewChat"));
			this.newChatBtnEl.setAttr("title", t("searchNewChat"));
		}
		if (this.settingsBtnEl) {
			this.settingsBtnEl.setAttr("aria-label", t("settingsTitle"));
			this.settingsBtnEl.setAttr("title", t("settingsTitle"));
		}
		// State-dependent tooltips (expand/collapse, send/stop).
		this.applyInputExpanded();
		this.setSendButtonState(this.isGenerating ? "stop" : "idle");
		// Re-render the welcome screen (greeting, suggestions, stats) in the
		// new language when it's currently shown.
		if (this.messagesEl.querySelector(".semlink-search-welcome")) {
			this.messagesEl.querySelector(".semlink-search-welcome")?.remove();
			this.renderWelcome();
		}
	}

	/** Time-slot key of the greeting for the current hour. */
	private welcomeKeyForHour(): string {
		const hour = new Date().getHours();
		if (hour < 5) return "welcomeMidnight";
		if (hour < 7) return "welcomeDawn";
		if (hour < 9) return "welcomeEarlyMorn";
		if (hour < 12) return "welcomeMorning";
		if (hour < 13) return "welcomeLunch";
		if (hour < 14) return "welcomeNap";
		if (hour < 15) return "welcomeAfternoon1";
		if (hour < 16) return "welcomeAfternoon2";
		if (hour < 17) return "welcomeAfternoon3";
		if (hour < 18) return "welcomeAfternoon4";
		if (hour < 19) return "welcomeAfternoon5";
		if (hour < 21) return "welcomeDusk";
		if (hour < 22) return "welcomeNight";
		return "welcomeLateNight";
	}

	// ── Chat history: session lifecycle ──

	/** Seal the current session (if any) and reset to a blank conversation. */
	private startNewSession(): void {
		this.currentSessionId = null;
		this.currentMessages = [];
		this.attachments = [];
		// Clear the subtitle until a question is asked.
		this.firstQuestion = "";
		// No conversation → hide the context-usage ring again.
		if (this.contextUsageEl) this.contextUsageEl.addClass("semlink-hidden");
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
		// The FIRST question becomes the header's subtitle row.
		if (!this.firstQuestion) {
			this.firstQuestion = (
				segments && segments.length > 0
					? segments.map((s) => (s.type === "file" ? `[[${s.value}]]` : s.value)).join("")
					: content
			)
				.replace(/\s+/g, " ")
				.trim();
		}
		const msg: HistoryMessage = { role: "user", content, segments, timestamp: Date.now() };
		this.currentMessages.push(msg);
		this.history.addMessage(this.currentSessionId, msg);
		void this.history.save();
	}

	/** Record an assistant answer into the current session. */
	private async recordAssistantMessage(
		content: string,
		thinking?: ThinkingStep[],
		sources?: string[],
		elapsedSec?: number,
		contextTokens?: number,
		contextBreakdown?: ContextBreakdown,
		cacheHitRate?: number | null,
	): Promise<void> {
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
			contextTokens,
			contextBreakdown,
			cacheHitRate,
			timestamp: Date.now(),
		};
		this.currentMessages.push(msg);
		this.history.addMessage(this.currentSessionId, msg);
		void this.history.save();
	}

	/** Render a previously-saved session into the conversation area. */
	private async loadSession(session: ChatSession): Promise<void> {
		this.currentSessionId = session.id;
		this.currentMessages = [...session.messages];
		// Header subtitle = the session's first question (same as live chats).
		const firstUser = session.messages.find((m) => m.role === "user");
		if (firstUser) {
			this.firstQuestion = (
				firstUser.segments && firstUser.segments.length > 0
					? firstUser.segments.map((s) => (s.type === "file" ? `[[${s.value}]]` : s.value)).join("")
					: firstUser.content
			)
				.replace(/\s+/g, " ")
				.trim();
		} else {
			this.firstQuestion = "";
		}
		this.messagesEl.empty();
		this.statusEl.textContent = "";
		// A restored conversation is never the welcome screen → show the home button.
		this.updateHomeIconVisibility();
		// Restoring a conversation with content → show the context-usage ring.
		if (this.contextUsageEl && session.messages.length > 0) {
			this.contextUsageEl.removeClass("semlink-hidden");
		}
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
					await MarkdownRenderer.render(this.app, protectHyphens(msg.content), answerEl, "", this);
					if (msg.sources && msg.sources.length > 0) {
						const usedSources = msg.sources.map((p) => ({ notePath: p, heading: "", contentPreview: "" }));
						this.renderSources(bubble, usedSources as any, false);
					}
					// Copy / save actions for history answers too.
					this.appendActions(bubble, msg.content, lastUserQuery);
					// Restore this turn's context usage (ring + tooltip). Old
					// sessions saved before these fields existed simply skip.
					if (msg.contextTokens !== undefined || msg.contextBreakdown !== undefined || msg.cacheHitRate !== undefined) {
						this.updateContextInfo(msg.contextTokens, msg.contextBreakdown, msg.cacheHitRate);
					}
				}
		}
		this.scrollToBottom();
		// scrollToBottom may not fire a scroll event when the session is
		// shorter than the viewport — re-check the subtitle row manually.
		this.updateCompactHeader();
		this.inputEl.focus();
	}

	// ── Chat history: drawer UI ──

	/** Slide in a left-side drawer listing saved chat sessions. */
	private async showHistoryDrawer(): Promise<void> {
		const sessions = await this.history.load();
		// Attach to the view's contentEl (not document.body) so the drawer is
		// positioned relative to the search panel, not the whole Obsidian window.
		// The view root's CSS already sets position: relative (anchors the
		// full-panel drag overlay), nothing needed here.
		// Backdrop
		const backdrop = this.contentEl.createDiv({ cls: "semlink-history-backdrop" });
		// Drawer panel
		const drawer = this.contentEl.createDiv({ cls: "semlink-history-drawer" });
		const header = drawer.createDiv({ cls: "semlink-history-header" });
		header.createDiv({ cls: "semlink-history-title", text: t("historyTitle") });
		const closeBtn = header.createEl("button", { cls: "semlink-search-icon-btn clickable-icon" });
		setIcon(closeBtn, "x");
		const list = drawer.createDiv({ cls: "semlink-history-list" });

		// Paged, time-grouped list: by default only the last month of sessions
		// is shown; "展示更多" reveals another PAGE at a time.
		const all = this.history.list(); // newest first
		const now = Date.now();
		const MONTH_MS = 30 * 24 * 3600 * 1000;
		const PAGE = 100;
		let visibleCount = all.filter((s) => s.updatedAt >= now - MONTH_MS).length;
		// No sessions in the month window but older ones exist → show one page
		// so the list isn't empty (the "show more" button remains).
		if (all.length > 0 && visibleCount === 0) visibleCount = Math.min(PAGE, all.length);

		const renderList = (): void => {
			list.empty();
			if (all.length === 0) {
				list.createDiv({ cls: "semlink-history-empty", text: t("historyEmpty") });
				return;
			}
			// Group the visible window by recency bucket (today → earlier).
			// Each group gets ONE container holding the items, so the left
			// rule is a single continuous line per group (like tool-call).
			let lastKey = "";
			let groupEl: HTMLElement | null = null;
			for (const session of all.slice(0, visibleCount)) {
				const key = historyBucket(session.updatedAt, now);
				if (key !== lastKey) {
					list.createDiv({ cls: "semlink-history-group", text: t(HISTORY_GROUP_KEYS[key]) });
					groupEl = list.createDiv({ cls: "semlink-history-group-items" });
					lastKey = key;
				}
				const item = groupEl!.createDiv({ cls: "semlink-history-item" });
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
			// "展示更多" — another PAGE of older sessions.
			if (visibleCount < all.length) {
				const more = list.createDiv({ cls: "semlink-history-more", text: t("historyShowMore") });
				more.addEventListener("click", () => {
					visibleCount += PAGE;
					renderList();
				});
			}
		};
		renderList();

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
		this.updateHomeIconVisibility();
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
		this.updateHomeIconVisibility();
		const turn = this.messagesEl.createDiv({ cls: "semlink-msg-turn semlink-msg-user-turn" });
		const bubble = turn.createDiv({ cls: "semlink-msg-bubble semlink-msg-user" });
		if (content) {
			this.sanitizeBubbleContent(content);
			bubble.appendChild(content);
		} else {
			// Resolve [[...]] tokens into clickable wiki links at render time
			// (plain-text queries / history without segments).
			this.appendTextWithWikilinks(bubble, text);
		}
	}

	/** Append text, resolving [[...]] tokens into clickable wikilink chips
	 *  (unresolvable tokens stay as plain text). */
	private appendTextWithWikilinks(container: HTMLElement, text: string): void {
		for (const part of text.split(/(\[\[[^\]]*\]\])/g).filter((s) => s.length > 0)) {
			const m = part.match(/^\[\[(.+?)\]\]$/);
			if (m) {
				const target = m[1].split("|")[0].trim();
				const resolved = this.resolveNotePath(target);
				if (resolved) container.appendChild(this.createWikilink(resolved));
				else container.append(part);
			} else {
				container.append(part);
			}
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

	/** Subtitle row visibility: while the first user message is scrolled under
	 *  the header, show the first question as a second, small-text row (the
	 *  brand row above stays untouched). Re-checked on scroll and after any
	 *  state change (new session / session load). */
	private updateCompactHeader(): void {
		const first = this.messagesEl.querySelector<HTMLElement>(".semlink-msg-user-turn .semlink-msg-user");
		const compact =
			!!first && first.getBoundingClientRect().top < this.headerEl.getBoundingClientRect().bottom;
		if (compact !== this.headerCompact) {
			this.headerCompact = compact;
			this.headerEl.toggleClass("semlink-search-header--compact", compact);
		}
		if (compact) {
			// Keep the subtitle in sync even when the compact state itself
			// didn't flip (e.g. another session was loaded while scrolled
			// down — the question text must follow the new session).
			const text = this.truncateSubtitle(this.firstQuestion);
			if (this.firstQuestionEl.textContent !== text) {
				this.firstQuestionEl.textContent = text;
			}
		}
	}

	/** Keep the subtitle to at most 20 characters, appending "..." when cut.
	 *  Unicode-safe (emoji etc. are never split in half). */
	private truncateSubtitle(text: string): string {
		const chars = Array.from(text);
		if (chars.length <= 20) return text;
		return chars.slice(0, 20).join("") + "...";
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
	private updateContextInfo(tokens?: number, breakdown?: ContextBreakdown, cacheHitRate?: number | null): void {
		if (breakdown !== undefined) this.lastBreakdown = breakdown;
		if (cacheHitRate !== undefined) this.lastCacheHitRate = cacheHitRate;
		if (tokens !== undefined) this.updateContextRing(tokens);
	}

	/** Show the context-usage tooltip next to the donut. */
	private showContextTooltip(): void {
		if (!this.contextRingEl) return;
		// Lazily create the tooltip on document.body (see onOpen comment).
		if (!this.tooltipEl) {
			this.tooltipEl = document.body.createDiv({ cls: "semlink-context-tooltip semlink-hidden" });
			// Hovering the tooltip itself keeps it open (otherwise moving the
			// mouse from the ring onto the tooltip hides it immediately).
			this.tooltipEl.addEventListener("mouseenter", () => {
				// Pointer arrived — cancel any pending hide (gap crossing).
				if (this.tooltipHideTimer) window.clearTimeout(this.tooltipHideTimer);
				this.tooltipHideTimer = null;
				if (this.tooltipEl) this.tooltipEl.removeClass("semlink-hidden");
			});
			this.tooltipEl.addEventListener("mouseleave", () => this.hideContextTooltip());
		}
		const el = this.tooltipEl;
		const bd = this.lastBreakdown;
		const used = bd?.used ?? 0;
		// The capacity ceiling is FIXED by the active model — before any turn
		// it must show the model's window (e.g. 0/100万), never 0/0.
		const capacity = bd?.capacity ?? this.chatClient.getActiveContextWindow() ?? 0;

		el.empty();
		// Header: 上下文容量 (left) + 55.1万/100万（55.1%）(right-aligned)
		const totalPct = capacity > 0 ? (used / capacity) * 100 : 0;
		const headerRow = el.createDiv({ cls: "ctx-row ctx-capacity" });
		headerRow.createSpan({ cls: "ctx-name", text: t("ctxCapacity") });
		headerRow.createSpan({
			cls: "ctx-tokens",
			text: `${this.formatWan(used)}/${this.formatWan(capacity)}（${this.formatPct(totalPct)}%）`,
		});

		// One overall progress bar for the whole context usage.
		const bar = el.createDiv({ cls: "ctx-total-bar" });
		bar.createDiv({ cls: "ctx-total-bar-fill", attr: { style: `width:${Math.min(100, totalPct)}%` } });

		// Category rows in a stable display order: name + share % only.
		// 系统工具 / 技能 are noise for the user — they are not shown.
		// Before the first turn the breakdown is null — synthesize the rows at
		// 0% so the structure is always visible, not an empty list.
		const order = ["messages", "system_tools", "skills", "mcp_tools", "system_prompt", "other"];
		const source = bd ? bd.categories : order.map((key) => ({ key, tokens: 0 }));
		const cats = source
			.filter((c) => c.key !== "system_tools" && c.key !== "skills")
			.sort((a, b) => {
				const ia = order.indexOf(a.key);
				const ib = order.indexOf(b.key);
				return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
			});
		for (const cat of cats) {
			const pct = used > 0 ? (cat.tokens / used) * 100 : 0;
			const row = el.createDiv({ cls: "ctx-row" });
			row.createSpan({ cls: "ctx-name", text: this.categoryLabel(cat.key) });
			row.createSpan({ cls: "ctx-tokens", text: `${this.formatPct(pct)}%` });
		}

		// Before the first turn there is no cache statistic — show 0% as a
		// placeholder rather than a dash. Same left/right layout as the
		// category rows so the percentage aligns with them.
		const cacheText = this.lastCacheHitRate === null ? "0%" : `${this.formatPct(this.lastCacheHitRate * 100)}%`;
		const cacheRow = el.createDiv({ cls: "ctx-row ctx-cache" });
		cacheRow.createSpan({ cls: "ctx-name", text: t("ctxCacheHit") });
		cacheRow.createSpan({ cls: "ctx-tokens", text: cacheText });

		// Position the tooltip BELOW-LEFT of the donut (viewport-fixed on
		// document.body). The ring now sits in the top header, so it must open
		// downward — upward would clip off the top of the viewport.
		const rect = this.contextRingEl.getBoundingClientRect();
		el.style.left = Math.max(8, rect.left - el.offsetWidth + rect.width + 8) + "px";
		el.style.top = rect.bottom + 8 + "px";
		el.removeClass("semlink-hidden");

		// Keep it inside the viewport.
		const vw = window.innerWidth;
		if (el.offsetLeft + el.offsetWidth > vw - 8) {
			el.style.left = Math.max(8, vw - el.offsetWidth - 8) + "px";
		}
	}

	/** 551000 → "55.1万"; 1000000 → "100万"; values < 10000 stay raw. */
	private formatWan(n: number): string {
		// Always express in 万 so the two sides of "x万/y万" stay consistent,
		// even for small values (8171 → "0.8万", not the raw "8171").
		const w = n / 10000;
		return (Number.isInteger(w) ? String(w) : w.toFixed(1).replace(/\.0$/, "")) + "万";
	}

	/** 7528 → "2小时5分" / 65 → "1分5秒" / 30 → "30秒". */
	private formatDuration(totalSec: number): string {
		const s = Math.max(0, Math.round(totalSec));
		const h = Math.floor(s / 3600);
		const m = Math.floor((s % 3600) / 60);
		const sec = s % 60;
		const parts: string[] = [];
		if (h > 0) parts.push(`${h}小时`);
		if (m > 0) parts.push(`${m}分`);
		if (sec > 0 || parts.length === 0) parts.push(`${sec}秒`);
		return parts.join("");
	}

	/** 0.551 → "55.1" (one decimal, trailing .0 stripped). */
	private formatPct(p: number): string {
		return (Math.round(p * 10) / 10).toFixed(1).replace(/\.0$/, "");
	}

	private hideContextTooltip(): void {
		if (this.tooltipEl) this.tooltipEl.addClass("semlink-hidden");
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

	// ──── Model switcher popup ────

	private toggleModelPopup(): void {
		if (this.modelPopupEl && !this.modelPopupEl.hasClass("semlink-hidden")) {
			this.hideModelPopup();
		} else {
			this.showModelPopup();
		}
	}

	private showModelPopup(): void {
		if (!this.modelTriggerEl) return;
		// Lazily create the popup on document.body so fixed positioning is
		// not thrown off by transformed/clipping ancestors.
		if (!this.modelPopupEl) {
			this.modelPopupEl = document.body.createDiv({ cls: "semlink-search-depth-popup semlink-search-model-popup semlink-hidden" });
		}
		const popup = this.modelPopupEl;
		popup.empty();

		const active = this.chatClient.getActiveModel();
		for (const group of this.chatClient.getModelOptions()) {
			popup.createDiv({ cls: "semlink-search-model-popup-group", text: group.providerName });
			for (const m of group.models) {
				const isActive = active !== null && active.provider.id === group.providerId && active.model.id === m.id;
				const opt = popup.createDiv({
					cls: "semlink-search-depth-option" + (isActive ? " is-active" : ""),
					text: m.id,
				});
				opt.addEventListener("click", () => {
					if (this.chatClient.setActiveModel(group.providerId, m.id)) {
						this.updateModelLabel();
						this.hideModelPopup();
					}
				});
			}
		}

		// Position ABOVE the trigger (bottom edge of the window is tight).
		const rect = this.modelTriggerEl.getBoundingClientRect();
		popup.style.left = rect.left + "px";
		popup.style.bottom = (window.innerHeight - rect.top + 4) + "px";
		popup.removeClass("semlink-hidden");

		// Keep it inside the viewport.
		const vw = window.innerWidth;
		if (rect.left + popup.offsetWidth > vw - 8) {
			popup.style.left = Math.max(8, vw - popup.offsetWidth - 8) + "px";
		}
	}

	private hideModelPopup(): void {
		if (this.modelPopupEl) this.modelPopupEl.addClass("semlink-hidden");
	}

	/** Refresh the model label and the context ring after switching. */
	private updateModelLabel(): void {
		// The indicator is a static LLM icon — nothing to relabel, but keep
		// the icon in sync in case the element was rebuilt.
		if (this.modelNameEl) {
			setSvgIcon(this.modelNameEl, llmIconSvg);
		}
		// The context window may differ across models — recompute the ring
		// against the last turn's usage.
		if (this.lastBreakdown) {
			this.updateContextRing(this.lastBreakdown.used);
		}
	}

	/** Copy the answer markdown to the clipboard (with a legacy fallback). */
	private async copyAnswer(text: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			const ta = document.createElement("textarea");
			ta.value = text;
			ta.className = "semlink-copy-layer";
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
