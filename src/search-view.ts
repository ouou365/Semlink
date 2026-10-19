// ========================================
// Semlink - Semantic Search View (Right Sidebar)
// ========================================
// A sidebar panel that lets the user type a natural-language query, runs it
// through the same embed → search pipeline the MCP server uses. Each turn = a
// user query bubble followed by the chat model's answer (grounded in the
// retrieved notes), with a collapsible list of source note cards. If no chat
// provider is configured, it falls back to showing the raw result list.

import { App, ItemView, MarkdownRenderer, MarkdownView, WorkspaceLeaf, TFile, Vault, Notice, Menu, Modal, setIcon } from "obsidian";
import type { VectorStore } from "./vector-store";
import type { EmbeddingClient } from "./embedding-client";
import type { ChatClient, ThinkingStep, ContextBreakdown } from "./chat-client";
import { inferAgentDepth, buildNoteContext } from "./chat-client";
import { buildCitedCards } from "./cite-cards";
import type { SearchResult, ChatSession, HistoryMessage, HistorySegment } from "./types";
import { ChatHistoryStore } from "./chat-history";
import { brandLogoOf, formatContextWindow } from "./settings-models";
import { LicenseModal } from "./license-modal";
import { UsageModal } from "./usage-modal";
import { guideInProgress, onboardingActive, renderOnboarding } from "./onboarding";
import type SmartVaultPlugin from "../main";
import { SaveNoteModal } from "./save-note-modal";
import { ConfirmModal } from "./confirm-modal";
import { getLang, t, LANGUAGES, type Lang } from "./i18n";
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
	return text.replace(/(?<=[\w\u4e00-\u9fff])-(?=[\w\u4e00-\u9fff])/g, "\u2011");
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
	/** Owning plugin — settings + guide state live here. */
	private plugin: SmartVaultPlugin;
	// DOM references
	private inputEl!: HTMLDivElement;
	private messagesEl!: HTMLElement; // scrollable conversation area
	private statusEl!: HTMLElement;   // transient status (no-api-key hint)
	private headerEl!: HTMLElement;   // top header (brand + icon sides)
	private menuBtnEl: HTMLElement | null = null; // history drawer toggle
	/** Upgrade ✨ entry in the header — visible only on the free tier. */
	private upgradeBtnEl: HTMLElement | null = null;
	private headerRightIconsEl!: HTMLElement; // right icon group (ring + settings)
	private settingsBtnEl!: HTMLElement;      // settings gear (ring sits left of it)
	private helpBtnEl: HTMLElement | null = null; // setup-guide entry (header right)
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
	private modelLabelEl: HTMLElement | null = null;
	private modelTriggerEl: HTMLElement | null = null;
	private modelPopupEl: HTMLElement | null = null;
	/** Time-slot key of the currently shown welcome greeting. */
	private currentWelcomeKey: string | null = null;
	/** Language the current welcome was rendered in (refreshLanguage gates
	 *  its rebuild on this). */
	private welcomeLang: string | null = null;
	/** True while the user re-opened the guide via the header help icon —
	 *  keeps the guide on screen even when first-run state says otherwise
	 *  (cleared when the guide hands the screen back). */
	private guideRequested = false;
	/** Set when the user skips the guide. With no API key configured the
	 *  guide is the default landing page on every fresh view open; skipping
	 *  only dismisses it for the current view session, not forever. */
	private guideDismissed = false;
	/** Home ("new session") button — hidden while the welcome screen is up. */
	private newChatPillEl: HTMLElement | null = null;

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
		plugin: SmartVaultPlugin,
	) {
		super(leaf);
		this.store = store;
		this.client = client;
		this.vault = vault;
		this.chatClient = chatClient;
		this.history = new ChatHistoryStore(dataDir);
		this.plugin = plugin;
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
			attr: { "aria-label": t("historyTitle") },
		});
		this.menuBtnEl = menuBtn;
		setIcon(menuBtn, "menu");
		menuBtn.addEventListener("click", () => void this.showHistoryDrawer());
		// Usage & cost dashboard (Pro view; recording itself runs for all).
		// Usage & Cost dashboard — entry hidden for now (feature stays wired:
		// flip this flag to bring the header button back).
		const usageDashboardEnabled = false;
		if (usageDashboardEnabled) {
			const usageBtn = leftIcons.createEl("button", {
				cls: "semlink-search-icon-btn clickable-icon",
				attr: { "aria-label": t("usageTitle") },
			});
			setIcon(usageBtn, "gauge");
			usageBtn.addEventListener("click", () => new UsageModal(this.app, this.plugin).open());
		}
		// Help icon: (re-)opens the setup guide on the welcome screen.
		const helpBtn = leftIcons.createEl("button", {
			cls: "semlink-search-icon-btn clickable-icon",
			attr: { "aria-label": t("guideTitle") },
		});
		this.helpBtnEl = helpBtn;
		// Lucide renamed help-circle → circle-help; work with either set.
		setIcon(helpBtn, "help-circle");
		if (!helpBtn.firstChild) setIcon(helpBtn, "circle-help");
		helpBtn.addEventListener("click", () => {
			this.openGuide();
		});
		// Centered brand (logo + "Semlink" — always stays).
		const brand = header.createDiv({ cls: "semlink-search-brand-group" });
		const logoEl = brand.createDiv({ cls: "semlink-search-logo" });
		setSvgIcon(logoEl, logoSvg);
		brand.createDiv({ cls: "semlink-search-brand", text: "Semlink" });
		// Right icon group: setup guide + settings.
		const rightIcons = header.createDiv({ cls: "semlink-search-header-side semlink-search-header-right" });
		this.headerRightIconsEl = rightIcons;
		// Upgrade entry (✨): one of the three standing Pro entry points
		// (header, settings, locked items). Hidden the moment a license
		// activates — refreshLicenseUI() runs on every settings save.
		const upgradeBtn = rightIcons.createEl("button", {
			cls: "semlink-search-icon-btn clickable-icon semlink-upgrade-btn",
			attr: { "aria-label": t("upgradeProBtn") },
		});
		this.upgradeBtnEl = upgradeBtn;
		setIcon(upgradeBtn, "sparkles");
		upgradeBtn.addEventListener("click", () => {
			new LicenseModal(this.app, this.plugin).open();
		});
		this.refreshLicenseUI();
		const settingsBtn = rightIcons.createEl("button", {
			cls: "semlink-search-icon-btn clickable-icon",
			attr: { "aria-label": t("settingsTitle") },
		});
		this.settingsBtnEl = settingsBtn;
		setIcon(settingsBtn, "settings");
		settingsBtn.addEventListener("click", () => {
			(this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting.open();
			(this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting.openTabById("semlink");
		});
		// Second header row: the first question in small text. It appears
		// only while the first question is scrolled under the header (see
		// updateCompactHeader) so the conversation topic stays visible.
		const firstQ = header.createDiv({ cls: "semlink-search-first-question" });
		this.firstQuestionEl = firstQ;

		// ── Conversation area (middle, scrollable) ──
		this.statusEl = contentEl.createDiv({ cls: "semlink-search-status" });
		this.messagesEl = contentEl.createDiv({ cls: "semlink-search-messages" });
		this.renderWelcome();

		// Show the subtitle row once the first question hides under the header.
		this.registerDomEvent(this.messagesEl, "scroll", () => this.updateCompactHeader());

		// The greeting is time-based — refresh it automatically when the time
		// slot changes (e.g. 11:59 → 12:00), no reload needed. Only re-renders
		// while the welcome is still visible (before the first message), and
		// never while the setup guide owns the screen (it would wipe the
		// user's in-progress form input).
		this.registerInterval(
			window.setInterval(() => {
				const key = this.welcomeKeyForHour();
				if (key === this.currentWelcomeKey) return;
				// Same predicate renderWelcome uses: never wipe the guide (and
				// its in-progress form input) while it owns the screen.
				if (this.guideModeActive()) return;
				const existing = this.messagesEl.querySelector(".semlink-search-welcome");
				if (!existing) return;
				this.messagesEl.empty();
				this.renderWelcome();
			}, 60_000),
		);

		// ── Input footer (bottom, fixed) ──
		const footer = contentEl.createDiv({ cls: "semlink-search-footer" });

		// Toolbar ABOVE the input box: model switcher (left) + new-chat pill
		// (right), ZCode-style. The send/expand row stays inside the box.
		const toolbarEl = footer.createDiv({ cls: "semlink-search-toolbar" });
		const toolbarLeft = toolbarEl.createDiv({ cls: "semlink-search-toolbar-left" });
		// Active chat model indicator: LLM icon + model name + "▾" — clicking
		// opens the model-switcher popup (same pattern as the depth popup).
		const modelTrigger = toolbarLeft.createSpan({ cls: "semlink-search-model-trigger" });
		this.modelNameEl = modelTrigger.createSpan({ cls: "semlink-search-model-name" });
		setSvgIcon(this.modelNameEl, llmIconSvg);
		this.modelLabelEl = modelTrigger.createSpan({ cls: "semlink-search-model-label" });
		this.updateModelLabel();
		// Visible dropdown affordance on the right — the whole trigger opens
		// the model-switcher popup.
		const modelCaret = modelTrigger.createSpan({ cls: "semlink-search-model-caret" });
		setIcon(modelCaret, "chevron-down");
		this.modelTriggerEl = modelTrigger;
		modelTrigger.addEventListener("click", (e) => {
			e.stopPropagation();
			this.toggleModelPopup();
		});
		this.registerDomEvent(document, "click", () => this.hideModelPopup());
		// New-chat pill (right): fresh conversation — same action as the
		// header house button, surfaced next to the input for reachability.
		const toolbarRight = toolbarEl.createDiv({ cls: "semlink-search-toolbar-right" });
		const newChatPill = toolbarRight.createEl("button", {
			cls: "semlink-search-newchat",
			attr: { "aria-label": t("searchNewChat") },
		});
		setIcon(newChatPill, "plus");
		newChatPill.createSpan({ cls: "semlink-search-newchat-label", text: t("searchNewChat") });
		// Default-hidden: on first load the welcome screen may render before
		// (or after) this toolbar — start hidden and let
		// updateHomeIconVisibility reveal it once a conversation exists.
		newChatPill.addClass("is-hidden");
		this.newChatPillEl = newChatPill;
		newChatPill.addEventListener("click", () => this.newChatFromUi());

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
		this.dragOverlayEl.createSpan({ cls: "semlink-drag-overlay-text", text: t("dragOverlayHint") });

		let panelDragDepth = 0;
		const isSessionDrag = (e: DragEvent): boolean => !!e.dataTransfer?.types.includes("text/semlink-session");
		contentEl.addEventListener("dragover", (e) => {
			if (isSessionDrag(e)) return;
			e.preventDefault();
			e.stopPropagation();
			if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
		});
		contentEl.addEventListener("dragenter", (e) => {
			if (isSessionDrag(e)) return;
			e.preventDefault();
			e.stopPropagation();
			panelDragDepth++;
			this.dragOverlayEl.removeClass("semlink-hidden");
		});
		contentEl.addEventListener("dragleave", (e) => {
			if (isSessionDrag(e)) return;
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
				// Internal history-session drags (folder filing in the drawer)
				// are handled by their own row-level drop targets — let them
				// pass through instead of treating them as file drops.
				if (e.dataTransfer?.types.includes("text/semlink-session")) return;
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
			if (e.key !== "Enter" || e.isComposing) return;
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

		// Expand/send row inside the input box (the model switcher moved to
		// the toolbar above the box).
		const modelEl = wrapper.createDiv({ cls: "semlink-search-model" });

		// Expand/collapse toggle left of the send button: grows the input to
		// half the screen for long prompts, collapses back on click (and after
		// every send). Custom icons (outward/inward corner arrows).
		const expandBtn = modelEl.createEl("button", {
			cls: "semlink-search-icon-btn semlink-search-expand-btn",
			attr: { "aria-label": t("searchExpandInput") },
		});
		this.expandBtnEl = expandBtn;
		setSvgIcon(expandBtn, expandIconSvg);
		expandBtn.addEventListener("click", () => {
			this.inputExpanded = !this.inputExpanded;
			this.applyInputExpanded();
		});

		// Context-usage ring lives in the model row, immediately LEFT of the
		// expand/collapse toggle. Hidden until the first message is sent (no
		// context usage to show on an empty conversation).
		const modelLabel = this.chatClient.getActiveModelLabel();
		// Context-usage ring entry hidden for now (rendering stays wired —
		// delete this flag condition to bring it back).
		const contextUsageEnabled = false;
		if (contextUsageEnabled && modelLabel && this.chatClient.getActiveContextWindow()) {
			const usageEl = modelEl.createDiv({ cls: "semlink-context-usage" });
			const ringEl = usageEl.createDiv({ cls: "semlink-context-ring" });
			const ringSvg = ringEl.createSvg("svg", { attr: { viewBox: "0 0 36 36" } });
			ringSvg.createSvg("circle", { cls: "ring-bg", attr: { cx: 18, cy: 18, r: 15.9 } });
			ringSvg.createSvg("circle", { cls: "ring-fg", attr: { cx: 18, cy: 18, r: 15.9 } });
			this.contextRingEl = ringEl;
			this.contextPctEl = null;
			this.contextUsageEl = usageEl;
			usageEl.addClass("semlink-hidden");
			modelEl.insertBefore(usageEl, expandBtn);

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

		// Send button lives on the model row (right side), not beside the input.
		// State machine: send → loading(spin) → stop(click aborts the run) → send.
		const searchBtn = modelEl.createEl("button", {
			cls: "semlink-search-btn",
			attr: { "aria-label": t("searchSend") },
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

		// The onboarding guide already tells unconfigured users what to do —
		// only show the bare status hint when the guide is not up.
		if (!this.hasApiKey() && !onboardingActive(this.plugin)) {
			this.statusEl.textContent = t("searchNeedChatProvider");
		}
	}

	protected async onClose(): Promise<void> {
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

	/** Chat-key check — the AGENT is the core surface and must work without
	 *  the embedding extension (retrieval degrades gracefully; grep/get-note
	 *  tools need no vectors). */
	private hasApiKey(): boolean {
		return this.chatClient.isConfigured();
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
			// No key → skip the hint entirely and bring the guide up right
			// away (covers the skipped-guide state too).
			this.openGuide();
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
		// Pin the view to the new exchange NOW that the placeholder is in the
		// DOM. The keydown/send-button handlers scroll right after
		// `void runSearch()` — which only covers the user bubble, because the
		// placeholder (and later the auto-expanded thinking preview) land in
		// async continuations and push content below the fold. Sending always
		// jumps to bottom, like every chat surface.
		this.scrollToBottom();

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
				// Retrieval is OPTIONAL — the embedding extension may be
				// unconfigured or its endpoint unreachable. The chat still
				// runs context-free, and grep_notes/get_note ground the agent
				// without needing any vectors.
				try {
					const embedResult = await this.client.embed([query]);
					results = await this.store.search(
						embedResult.embeddings[0],
						DEFAULT_LIMIT,
						DEFAULT_THRESHOLD,
					);
				} catch (e) {
					console.debug("[Semlink] retrieval skipped (embedding unavailable):", e);
					results = [];
				}
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
				// Live markdown preview container. Uses the SAME renderer as
				// the final answer so the stream shows styled markdown instead
				// of raw syntax. Character reveal is decoupled from rendering:
				// a ~30ms typewriter loop reveals the source text smoothly
				// (adaptive rate — the further behind, the faster it catches
				// up), while markdown re-renders stay paced at ~120ms so the
				// styled output keeps up without janking.
				const streamInner = streamEl.createDiv({ cls: "semlink-msg-answer markdown-rendered" });
				let streamText = "";
				let shownText = "";
				let typeTimer: number | null = null;
				let typeRendering = false;
				let typeTicks = 0;
				// Set when any streamed text reached the UI. A round's interim
				// flash (live-forwarded pre-tool text) collapses the thinking
				// preview — startDots restores it when the flag is still set
				// from a PREVIOUS round; the real answer leaves it collapsed.
				let streamShown = false;
				const stopTypewriter = (): void => {
					if (typeTimer !== null) {
						window.clearInterval(typeTimer);
						typeTimer = null;
					}
				};
				const renderShown = async (): Promise<void> => {
					if (typeRendering) return;
					typeRendering = true;
					try {
						if (streamEl.isConnected) {
							// Sticky scroll, sampled BEFORE the re-render: the render
							// itself grows the content, so a tall block landing on an
							// at-bottom viewport would otherwise read as "user
							// scrolled up" and permanently break following. 120px
							// matches the wasNearBottom sampling used on the final
							// swap (the auto-expanded thinking preview can jump
							// taller than 80px between two renders).
							const m = this.messagesEl;
							const nearBottom = m.scrollHeight - m.scrollTop - m.clientHeight < 120;
							streamInner.empty();
							await MarkdownRenderer.render(this.app, protectHyphens(shownText), streamInner, "", this);
							if (nearBottom) this.scrollToBottom();
						}
					} finally {
						typeRendering = false;
					}
				};
				const typeTick = (): void => {
					if (!streamEl.isConnected) {
						stopTypewriter();
						return;
					}
					const remaining = streamText.length - shownText.length;
					if (remaining <= 0) {
						// Caught up — idle until the next delta restarts us.
						stopTypewriter();
						return;
					}
					// Adaptive reveal: sweep big backlogs fast (a large chunk
					// arrives at once), keep a brisk baseline (≈130 字/秒 at
					// 30ms ticks) so the reveal stays neck-and-neck with the
					// model instead of trailing behind it.
					const step = Math.min(80, Math.max(4, Math.ceil(remaining / 6)));
					shownText = streamText.slice(0, shownText.length + step);
					typeTicks++;
					// Markdown re-render paced (~every 4th tick ≈ 120ms), and
					// always the moment we catch up so the tail never lags.
					if (typeTicks % 4 === 0 || shownText.length >= streamText.length) void renderShown();
				};
				const startTypewriter = (): void => {
					if (typeTimer === null) typeTimer = window.setInterval(typeTick, 30);
				};

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
					// Back to the live status line (shimmer resumes) — drop the
					// collapsed-thinking summary look if a flash set it.
					loadingTextEl.removeClass("is-thinking");
					streamEl.addClass("semlink-hidden");
					streamText = "";
					shownText = "";
					stopTypewriter();
					streamInner.empty();
					// The previous round's interim flash collapsed the thinking
					// preview — restore it; the real answer re-collapses when
					// its own text starts arriving.
					if (streamShown) {
						streamShown = false;
						liveBody.removeClass("semlink-hidden");
						refreshLiveBody();
						loadingTextEl.addClass("is-open");
					}
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

				// Live thinking preview while generating: auto-expanded so the
				// user watches progress instead of staring at a static status
				// line while retrieval is heavy. Clicking the loading line still
				// toggles it manually; it folds back up the moment answer text
				// starts streaming. Renders the same steps the finished
				// answer's thinking section will show.
				const liveSteps: ThinkingStep[] = [firstStep];
				const liveBody = loadingEl.createDiv({ cls: "semlink-thinking-live-body" });
				// Steps rendered so far. New steps are APPENDED (never a full
				// re-render) so an expanded tool call stays expanded while the
				// model keeps producing steps.
				let renderedSteps = 0;
				const refreshLiveBody = (): void => {
					if (liveBody.hasClass("semlink-hidden")) return;
					// Sticky scroll on BOTH scrollers: the outer conversation
					// (each new step pushes the loading line/answer further
					// down) and the live body itself. Sampled BEFORE appending,
					// and only while the user is already at the bottom —
					// scrolling up to read earlier content must not be fought.
					const m = this.messagesEl;
					const outerNearBottom = m.scrollHeight - m.scrollTop - m.clientHeight < 120;
					const nearBottom = liveBody.scrollHeight - liveBody.scrollTop - liveBody.clientHeight < 40;
					while (renderedSteps < liveSteps.length) {
						this.renderThinkingSteps(liveBody, [liveSteps[renderedSteps]]);
						renderedSteps++;
					}
					if (nearBottom) liveBody.scrollTop = liveBody.scrollHeight;
					if (outerNearBottom) this.scrollToBottom();
				};
				refreshLiveBody();
				loadingTextEl.addClass("is-open");
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
				// Current-note awareness: tell the model which note the user is
				// viewing AND how to use it — phrased as an explicit instruction,
				// because a bare name line reads like more retrieved content and
				// the model ends up feeding the question verbatim to search_notes.
				const activeFile = this.app.workspace.getActiveFile();
				const currentNoteLine = activeFile
					? `\n\n用户当前正在浏览的笔记：《${activeFile.basename}》（路径：${activeFile.path}）。当问题涉及"当前笔记""这篇笔记""正在看的笔记"等指代时，直接调用 get_note 读取上述路径来回答，不要把问题原文当作检索词去 search_notes。`
					: "";
				const fullContext = context + currentNoteLine;
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
							// Streamed text arrived — COLLAPSE the thinking process
							// (the header row stays visible as a "▸ 思考了 N 秒"
							// toggle the user can re-open mid-stream) and let the
							// answer body stream below it. Text renders as live
							// markdown (typewriter above); scroll following happens
							// after each render. NOTE: this also fires for an
							// interim flash (pre-tool text past the live threshold)
							// — startDots restores the expanded preview when the
							// next round proves it was thinking.
							streamShown = true;
							stopAnswerAnim();
							loadingTextSpan.textContent =
								t("searchThinkingDuration").replace("{seconds}", this.formatDuration(Math.max(1, Math.round((Date.now() - thinkStart) / 1000))));
							loadingDotsSpan.textContent = "";
							liveBody.addClass("semlink-hidden");
							loadingTextEl.removeClass("is-open");
							// Mirror the finished thinking panel's look so the
							// header is identical during and after streaming.
							loadingTextEl.addClass("is-thinking");
							streamEl.removeClass("semlink-hidden");
							streamText = text;
							startTypewriter();
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
							"proactive",
							// Seed the per-turn citation registry with the initial
							// context order — context block [n] = registry [n];
							// tool results and opened notes continue from there,
							// so thinking, answer, and source cards all share ONE
							// numbering space.
							results.map((r) => r.notePath),
						);
						const elapsedSec = Math.max(1, Math.round((Date.now() - thinkStart) / 1000));
						stopAnswerAnim();
						// Sticky scroll across the final swap: sample while the
						// streaming bubble is still the view (BEFORE thinking +
						// answer + sources + actions replace it) — the swapped block
						// is taller, so sampling after the swap would misread the
						// jump as a user scroll-up and leave the sources card and
						// the copy/save buttons below the fold.
						const wasNearBottom =
							this.messagesEl.scrollHeight - this.messagesEl.scrollTop - this.messagesEl.clientHeight < 120;
						loadingEl.empty();
					// The model sometimes writes the FULL answer inside a
					// thinking step (the pre-analysis, or a mid-turn thought)
					// and leaves the real answer as a shell — an intro line
					// like "基于笔记内容，以下是……完整介绍。", which the chat
					// client strips to "" when a substantial thought exists.
					// Promoting the LONGEST thought keeps the content in the
					// answer body instead of trapping it under 💭.
					let answer = result.answer;
					let thinking: ThinkingStep[] = result.thinking;
					if (answer.trim().length < 30 && thinking.length > 0) {
						let best = -1;
						let bestLen = 0;
						for (let i = 0; i < thinking.length; i++) {
							const s = thinking[i];
							const len = s.type === "thought" ? s.text.trim().length : 0;
							if (len >= 80 && len > bestLen) {
								best = i;
								bestLen = len;
							}
						}
						if (best >= 0) {
						answer = (thinking[best] as Extract<ThinkingStep, { type: "thought" }>).text;
							thinking = thinking.filter((_, j) => j !== best);
						}
					}
					// Sources are computed BEFORE the answer renders. ONE
					// numbering system: the model cites the per-turn registry
					// numbers it saw (context blocks, tool-result `n` fields,
					// opened-note headers). Cards carry those TRUE numbers —
					// sorted ascending, gaps allowed (uncited notes simply
					// don't get a card) — so card [4] IS the note the model
					// cited as [4]. Renumbering here would break the contract.
					const knownPaths = new Set<string>([
						...turnAttachments,
						...initialResults.map((r) => r.notePath),
						...result.usedNotes,
					]);
					const readNotes = result.readNotes || [];
					const citeRegistry = result.citeRegistry || [];
					const citeEntries = hasAttachments
						? []
						: buildCitedCards(answer, citeRegistry, readNotes);
					// Fallback (no registry — e.g. surfaces that don't seed it):
					// the legacy declared-sources pipeline.
					const declared = this.matchDeclaredSources(result.declaredSources || [], knownPaths);
					const usedNotes = [...result.usedNotes];
					for (const p of declared) {
						if (!usedNotes.includes(p)) usedNotes.push(p);
					}
					let sourceContext = initialResults;
					let sourcePaths: string[];
					let citeNumbers: number[] | undefined;
					if (citeEntries.length > 0) {
						sourcePaths = citeEntries.map((e) => e.path);
						citeNumbers = citeEntries.map((e) => e.n);
						const citedSet = new Set<string>(sourcePaths);
						sourceContext = initialResults.filter((r) => citedSet.has(r.notePath));
					} else if (!hasAttachments && (declared.length > 0 || readNotes.length > 0)) {
						const keep = new Set<string>(declared);
						for (const p of readNotes) keep.add(p);
						sourceContext = initialResults.filter((r) => keep.has(r.notePath));
						sourcePaths = [...keep];
					} else {
						sourcePaths = usedNotes;
					}
					const usedSources = hasAttachments
						? this.buildUsedSources(
							turnAttachments.map((p) => ({ chunkId: "", notePath: p, heading: "", contentPreview: "", score: -1 })),
							usedNotes,
						)
						: this.buildOrderedSources(sourceContext, sourcePaths);
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
					// Sources the model DECLARED in submit_answer are validated
					// against the known path set (initial retrieval + dropped
					// attachments + tool-read notes). Precision mode kicks in
					// when a declaration survives validation OR the model
					// actually opened notes (get_note/get_section): the card
					// lists declared + opened notes only — bare search hits
					// the model never used are dropped. Only a turn answered
					// purely from snippets (nothing declared, nothing opened)
					// keeps the full retrieval floor.
					this.renderSources(loadingEl, usedSources, false, citeNumbers);

					// Persist this turn into chat history (incl. context usage so
					// the ring + tooltip can be restored when re-opening). The
					// initial retrieval step is prepended here too — otherwise
					// re-opened history would lose the search_notes evidence.
					await this.recordAssistantMessage(
						answer,
						[firstStep, ...thinking],
						sourcePaths,
						elapsedSec,
						citeNumbers,
						result.contextTokens,
						result.contextBreakdown,
						result.cacheHitRate,
					);

						// Action buttons (icons) below the sources: copy / save.
						this.appendActions(loadingEl, answer, query);
						if (wasNearBottom) this.scrollToBottom();
				} catch (e) {
					// User aborted — keep whatever streamed so far and show a
					// "stopped" notice instead of an error.
					if (controller.signal.aborted || (e as { name?: string } | undefined)?.name === "AbortError") {
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
	/** Validate the note paths a model declared in submit_answer's `sources`
	 *  against the paths actually known to this turn. Models sometimes drop
	 *  the folder prefix or reword separators, so exact matches win and
	 *  whole-segment prefix/suffix matches remap to the known path; anything
	 *  else is a hallucination and gets dropped. */
	private matchDeclaredSources(declared: string[], known: Set<string>): string[] {
		const out: string[] = [];
		for (const d of declared) {
			const matched = this.matchDeclaredSource(d, known);
			if (matched && !out.includes(matched)) out.push(matched);
		}
		return out;
	}

	/** Match ONE declared path against the known set (same rules as
	 *  matchDeclaredSources) — returns the canonical known path or "". */
	private matchDeclaredSource(declared: string, known: Set<string>): string {
		const norm = (p: string): string => p.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase();
		const nd = norm(declared);
		if (!nd) return "";
		for (const k of known) {
			const nk = norm(k);
			if (nk === nd || nk.endsWith("/" + nd) || nd.endsWith("/" + nk)) return k;
		}
		return "";
	}


	/** Build the sources card ordered by `sourcePaths` (declaration order —
	 *  the model's inline [n] markers follow this same order, so card numbers
	 *  match the body citations). Metadata comes from `contextResults` when
	 *  available; paths without context data get placeholder entries. */
	private buildOrderedSources(contextResults: SearchResult[], sourcePaths: string[]): SearchResult[] {
		const byPath = new Map<string, SearchResult>();
		for (const r of contextResults) {
			byPath.set(r.notePath, r);
		}
		return sourcePaths.map((p) => byPath.get(p) ?? { chunkId: "", notePath: p, heading: "", contentPreview: "", score: -1 });
	}

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

	/** Render a collapsible "reference sources" section inside an assistant bubble.
	 *  `numbers` carries each row's TRUE citation number (the per-turn registry
	 *  number the model cited) — omitted rows fall back to position numbering
	 *  for the legacy/result-list paths. */
	private renderSources(container: HTMLElement, results: SearchResult[], open: boolean, numbers?: number[]): void {
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
		this.renderSourceRows(list, results, numbers);
	}

	/** One-line source rows (title + path), numbered like paper references.
	 *  With `numbers`, row [n] is the model's own citation number — gaps are
	 *  honest (uncited notes have no card). */
	private renderSourceRows(container: HTMLElement, results: SearchResult[], numbers?: number[]): void {
		for (const [i, r] of results.entries()) {
			const row = container.createDiv({ cls: "semlink-search-source-row" });
			row.createSpan({ cls: "semlink-search-source-index", text: `[${numbers ? numbers[i] : i + 1}]` });
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
			attr: { "aria-label": t("searchCopy") },
		});
		setIcon(copyBtn, "copy");
		copyBtn.addEventListener("click", () => void this.copyAnswer(content));
		const saveBtn = actionsEl.createEl("button", {
			cls: "semlink-msg-action",
			attr: { "aria-label": t("searchSave") },
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
		window.requestAnimationFrame(() => {
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
					if (i > 0) insert(createEl("br"));
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
			const base = (this.app.vault.adapter as unknown as { getBasePath?: () => string }).getBasePath?.();
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
		const br = createEl("br");
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

				// Response: nested <details>, collapsed by default — click
				// "返回 ›" to expand the (often large) JSON result.
				const responseDetails = callDetails.createEl("details", { cls: "semlink-tool-call-response" });
				responseDetails.createEl("summary", {
					cls: "semlink-tool-call-label semlink-tool-call-response-summary",
					text: t("searchToolResponse"),
				});
				responseDetails.createEl("pre", { cls: "semlink-tool-call-pre", text: this.prettyJson(step.result) });
			}
		}
	}

	/** Analysis-heavy prompts (设计需求/总结/对比 etc.) get the "enhanced"
	 *  depth: full-note reads allowed and a larger per-result cap, so the
	 *  model can read related protocol/design docs before answering. */
	/** Compact one-line preview of the request args, e.g. " — MIBT". */
	private summarizeArgs(args: unknown): string {
		if (args && typeof args === "object") {
			const first = Object.entries(args as Record<string, string>).find(([, v]) => typeof v === "string" && v.length > 0);
			if (first) return ` — ${first[1]}`;
		}
		return "";
	}

	/** JSON in tool-call pre blocks — hyphens protected from line breaks. */
	private prettyJson(value: unknown): string {
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

	/** Open the first-run guide (help icon, or asking without any API key).
	 *  A fresh run always starts from step ① — previous guide progress is
	 *  reset (configured providers are untouched). */
	private openGuide(): void {
		this.guideRequested = true;
		this.guideDismissed = false;
		this.plugin.settings.onboarding = { done: false };
		void this.plugin.saveSettings();
		this.startNewSession();
		this.messagesEl.empty();
		this.statusEl.textContent = "";
		this.renderWelcome();
		this.updateCompactHeader();
	}

	/** Whether the first-run guide currently owns the welcome screen. */
	private guideModeActive(): boolean {
		// No API key anywhere → the guide is the default landing page. A skip
		// only suppresses it for this view session (guideDismissed); a fresh
		// open without any key brings the guide back.
		const noKey = !this.plugin.settings.providers.some((p) => p.apiKey.trim());
		return this.guideRequested
			|| guideInProgress(this.plugin)
			|| onboardingActive(this.plugin)
			|| (noKey && !this.guideDismissed);
	}

	/**
	 * Render a time-aware welcome message in the center of the conversation
	 * area when it's empty. Removed as soon as the user sends their first
	 * message. Greeting adapts to morning/afternoon/evening/night.
	 *
	 * While the first-run guide is active it owns the whole screen: no
	 * greeting trio, no prompt cards, no index stats, and the composer is
	 * hidden (setGuideChrome).
	 */
	private renderWelcome(): void {
		// Track the greeting slot + language in every mode so the 60s timer
		// only reacts to real time-slot changes and refreshLanguage only
		// rebuilds the welcome when the language actually changed.
		this.currentWelcomeKey = this.welcomeKeyForHour();
		this.welcomeLang = getLang();
		// The guide shows for first-run users, on demand via the header help
		// icon (guideRequested), or while a run is mid-flight (the first
		// saved key would otherwise make onboardingActive() drop the guide).
		const guideMode = this.guideModeActive();
		this.setGuideChrome(guideMode);

		if (guideMode) {
			// Top strip mirroring the real header (which guide mode hides):
			// skip icon left, purple brand center, language + settings right.
			const corners = this.messagesEl.createDiv({ cls: "semlink-search-header semlink-guide-corners" });
			const leftSide = corners.createDiv({ cls: "semlink-search-header-side" });
			const skipBtn = leftSide.createEl("button", {
				cls: "semlink-search-icon-btn clickable-icon",
				attr: { "aria-label": t("guideSkip") },
			});
			setIcon(skipBtn, "x");
			skipBtn.addEventListener("click", () => {
				// End a help-icon-triggered run too, or guideMode below would
				// re-render the guide right after the skip.
				this.guideRequested = false;
				this.guideDismissed = true;
				this.plugin.settings.onboarding = { ...(this.plugin.settings.onboarding ?? {}), done: true };
				void this.plugin.saveSettings();
				this.messagesEl.empty();
				this.renderWelcome();
			});
			const brandGroup = corners.createDiv({ cls: "semlink-search-brand-group" });
			const brand = brandGroup.createDiv({ cls: "semlink-search-logo" });
			setIcon(brand, "semlink-logo");
			brandGroup.createSpan({ cls: "semlink-search-brand", text: "Semlink" });
			const rightSide = corners.createDiv({ cls: "semlink-search-header-side semlink-search-header-right" });
			const langBtn = rightSide.createEl("button", {
				cls: "semlink-search-icon-btn clickable-icon",
				attr: { "aria-label": t("language"), title: t("language") },
			});
			setIcon(langBtn, "languages");
			// Persisting via saveSettings drives the whole chain: it calls
			// setLang and refreshLanguage() on this view, which rebuilds the
			// welcome in the new language. Calling setLang alone (as an
			// earlier version did) changes nothing on screen.
			const switchLang = (lang: Lang): void => {
				this.plugin.settings.language = lang;
				void this.plugin.saveSettings();
			};
			langBtn.addEventListener("click", () => {
				// All UI languages from the registry (native labels), not just
				// zh/en — the guide must be reachable in every language. The
				// active one is marked with the accent color (no checkmark).
				const menu = new Menu();
				for (const l of LANGUAGES) {
					menu.addItem((item) => {
						item.setTitle(l.label).onClick(() => switchLang(l.value));
						if (l.value === getLang()) {
							// titleEl isn't in the pinned Obsidian typings yet —
							// it exists at runtime (menu item's label span).
							const titleEl = (item as unknown as { titleEl: HTMLElement }).titleEl;
							titleEl.addClass("semlink-lang-active");
						}
					});
				}
				// Anchor to the BUTTON, right-aligned: the menu's right edge
				// meets the button's right edge (top-left anchoring alone
				// would let the menu run past the panel edge). Clicking the
				// button anywhere opens the menu at this same spot.
				const rect = langBtn.getBoundingClientRect();
				menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
				const menuEl = (menu as unknown as { menuEl?: HTMLElement }).menuEl;
				if (menuEl) menuEl.style.left = `${rect.right - menuEl.offsetWidth}px`;
			});

			// Modifier class: the guide fills the block top-down so the
			// stepper can pin to the top while step content scrolls.
			const guide = this.messagesEl.createDiv({ cls: "semlink-search-welcome semlink-search-welcome-guide" });
			renderOnboarding(guide, this.plugin, () => {
				// Guide skipped/dismissed: end any help-triggered run and
				// swap it for the plain welcome. Empty the whole slot — the
				// corners strip lives outside the guide block and would
				// otherwise survive.
				this.guideRequested = false;
				this.messagesEl.empty();
				this.renderWelcome();
			});
			this.updateHomeIconVisibility();
			return;
		}

		const key = this.currentWelcomeKey;

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

	/** Guide-mode chrome: while the first-run guide owns the welcome screen
	 *  there is nothing to compose yet, so the input footer stays hidden.
	 *  Handing the screen back also ends a help-icon-triggered guide run. */
	private setGuideChrome(active: boolean): void {
		this.contentEl.toggleClass("semlink-guide-active", active);
		if (!active) this.guideRequested = false;
	}

	/** Rough full-index estimate for the guide's final step: markdown notes
	 *  (minus excludes) × an average ~2.4k chars per note, chunked and
	 *  batched with per-request latency + throttle delay. */
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

	/** The toolbar new-chat pill only makes sense once a conversation exists
	 *  — hide it while the welcome screen is up. */
	private updateHomeIconVisibility(): void {
		const onHome = !!this.messagesEl.querySelector(".semlink-search-welcome");
		this.newChatPillEl?.toggleClass("is-hidden", onHome);
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
		if (this.settingsBtnEl) {
			this.settingsBtnEl.setAttr("aria-label", t("settingsTitle"));
			this.settingsBtnEl.setAttr("title", t("settingsTitle"));
		}
		if (this.helpBtnEl) {
			this.helpBtnEl.setAttr("aria-label", t("guideTitle"));
			this.helpBtnEl.setAttr("title", t("guideTitle"));
		}
		if (this.upgradeBtnEl) {
			this.upgradeBtnEl.setAttr("aria-label", t("upgradeProBtn"));
			this.upgradeBtnEl.setAttr("title", t("upgradeProBtn"));
		}
		// New-chat pill: label + aria-label were set once at construction, so
		// they would keep the old language after a switch — refresh them here.
		if (this.newChatPillEl) {
			this.newChatPillEl.setAttr("aria-label", t("searchNewChat"));
			this.newChatPillEl.querySelector(".semlink-search-newchat-label")?.setText(t("searchNewChat"));
		}
		// Input hint (visible while expanded) + drag overlay hint: same
		// once-at-construction staleness as the pill — refresh here too.
		this.inputHintEl?.setText(t("searchInputHint"));
		this.dragOverlayEl?.querySelector(".semlink-drag-overlay-text")?.setText(t("dragOverlayHint"));
		// State-dependent tooltips (expand/collapse, send/stop).
		this.applyInputExpanded();
		this.setSendButtonState(this.isGenerating ? "stop" : "idle");
		// Re-render the welcome screen (greeting, suggestions, stats) only
		// when the LANGUAGE actually changed — refreshLanguage also runs on
		// every settings save, and rebuilding mid-guide would wipe the
		// user's in-progress form input.
		const welcome = this.messagesEl.querySelector(".semlink-search-welcome");
		if (welcome && getLang() !== this.welcomeLang) {
			this.messagesEl.empty();
			this.renderWelcome();
		}
	}

	/** Show/hide the header upgrade button with the license state. Called on
	 *  every settings save (activation/deactivation persist through it). */
	refreshLicenseUI(): void {
		this.upgradeBtnEl?.toggleClass("semlink-hidden", this.plugin.licenseManager.isPro());
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
	/** New-chat action shared by the header house button and the toolbar pill:
	 *  archive the current session, clear the transcript, show the welcome.
	 *  While a generation is running, ask first — new chat interrupts it, and
	 *  an accidental click would silently throw away the in-flight answer. */
	private newChatFromUi(): void {
		if (this.isGenerating) {
			new ConfirmModal(this.app, t("searchNewChatConfirmTitle"), t("searchNewChatConfirmBody"), () => {
				this.activeAskController?.abort();
				this.doNewChat();
			}).open();
			return;
		}
		this.doNewChat();
	}

	private doNewChat(): void {
		this.startNewSession();
		this.messagesEl.empty();
		this.statusEl.textContent = "";
		this.inputEl.empty();
		this.renderWelcome();
		// Empty area cannot hide a first question — drop the subtitle row.
		this.updateCompactHeader();
		this.inputEl.focus();
	}

	private startNewSession(): void {		this.currentSessionId = null;
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
		sourceNumbers?: number[],
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
			sourceNumbers,
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
						this.renderSources(bubble, usedSources as SearchResult[], false, msg.sourceNumbers);
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
		await this.history.load();
		const backdrop = this.contentEl.createDiv({ cls: "semlink-history-backdrop" });
		const drawer = this.contentEl.createDiv({ cls: "semlink-history-drawer" });
		const header = drawer.createDiv({ cls: "semlink-history-header" });
		const titleEl = header.createDiv({ cls: "semlink-history-title", text: t("historyTitle") });
		// Far right: archive entry → dedicated view of archived chats
		// (free tier: everything past the 5-active window; deletable there).
		const archiveBtn = header.createEl("button", {
			cls: "semlink-history-archive-btn clickable-icon",
			attr: { "aria-label": t("historyArchiveBtn") },
		});
		setIcon(archiveBtn, "archive");
		const closeBtn = header.createEl("button", { cls: "semlink-search-icon-btn clickable-icon" });
		setIcon(closeBtn, "x");

		const pro = this.plugin.licenseManager.isPro();
		const freeLimit = this.plugin.licenseManager.freeHistoryLimit();
		let view: "main" | "archive" = "main";
		let tab: "time" | "folder" = "time";

		// Tabs (Pro): 时间 | 文件夹. Free users get the plain time list.
		const tabsEl = drawer.createDiv({ cls: "semlink-history-tabs" });
		const tabBtn = (key: "time" | "folder", label: string) => {
			const b = tabsEl.createSpan({
				cls: "semlink-history-tab" + (tab === key && view === "main" ? " is-active" : ""),
				text: label,
			});
			b.addEventListener("click", () => {
				view = "main";
				tab = key;
				render();
			});
		};

		// The search input is created ONCE and only shown/hidden by render() —
		// re-creating it on each keystroke breaks CJK IME composition (the
		// element the IME is typing into gets replaced mid-composition).
		const tools = drawer.createDiv({ cls: "semlink-history-tools" });
		let query = "";
		let composing = false;
		const searchInput = tools.createEl("input", {
			cls: "semlink-history-search",
			attr: { type: "text", placeholder: t("historySearch"), "aria-label": t("historySearch") },
		});
		const applySearch = (): void => {
			query = searchInput.value.trim().toLowerCase();
			if (view !== "main") view = "main";
			render();
		};
		searchInput.addEventListener("compositionstart", () => { composing = true; });
		searchInput.addEventListener("compositionend", () => { composing = false; applySearch(); });
		searchInput.addEventListener("input", () => { if (!composing) applySearch(); });
		if (!this.plugin.licenseManager.isPro()) {
			// Freemium friction: the search box is VISIBLE for free users but
			// locked — clicking it opens the activation modal instead.
			searchInput.setAttribute("readonly", "");
			searchInput.addClass("semlink-history-search-locked");
			searchInput.addEventListener("click", () => {
				this.closeHistoryDrawer(backdrop, drawer);
				new LicenseModal(this.app, this.plugin, () => void this.showHistoryDrawer()).open();
			});
		}

		const list = drawer.createDiv({ cls: "semlink-history-list" });
		const collapsed = new Set<string>();
		// Folder path currently being renamed inline (null = none).
		let editingPath: string | null = null;

		const allSessions = this.history.list();
		// Paging counters live OUTSIDE render() so "Show more" survives
		// re-renders (they were per-render locals once — the button reset
		// itself on every click).
		let showMorePages = 0;
		let lockedPages = 0;
		const LOCKED_PAGE = 30;
		const now = Date.now();
		const MONTH_MS = 30 * 24 * 3600 * 1000;
		const PAGE = 100;

		const render = (): void => {
			// Recompute the active/archived split on EVERY render — the
			// archive action mutates sessions in place and the list must
			// reflect it immediately (a snapshot taken at drawer-open would
			// keep showing just-archived chats).
			const all = allSessions.filter((x) => !x.archived); // active, newest first
			const manuallyArchived = allSessions.filter((x) => x.archived);
			list.empty();
			tabsEl.empty();
			// NOTE: tools (the search input) is never emptied — it is created
			// once and only shown/hidden, or CJK IME composition breaks.
			// Header chrome per view.
			if (view === "archive") {
				titleEl.setText(t("historyArchiveTitle"));
				tabsEl.hide();
				tools.hide();
			} else {
				titleEl.setText(t("historyTitle"));
				// Tabs are visible to everyone; for free users the Folders tab
				// itself is the friction point (click → activation modal).
				tabsEl.show();
				tabBtn("time", t("historyTabTime"));
				if (pro) {
					tabBtn("folder", t("historyTabFolder"));
				} else {
					// Free users CAN enter the Folders tab — the content is a
					// masked preview whose "Unlock with Pro" overlay is the
					// activation trigger (not the tab itself).
					const locked = tabsEl.createSpan({
						cls: "semlink-history-tab" + (tab === "folder" ? " is-active" : "") + " semlink-history-tab-locked",
						text: t("historyTabFolder"),
					});
					locked.addEventListener("click", () => {
						tab = "folder";
						render();
					});
				}
				// The persistent search input (never re-created — see above);
				// visible for free users too (readonly, click → activate).
				tools.show();
			}

			// ── Archive view: every locked/archived chat, deletable. ──
			if (view === "archive") {
				const back = list.createDiv({ cls: "semlink-history-more", text: `← ${t("historyBack")}` });
				back.addEventListener("click", () => { view = "main"; render(); });
				// Manually archived chats (any tier): restore or delete.
				if (manuallyArchived.length > 0) {
					const head = list.createDiv({ cls: "semlink-history-archive-head" });
					head.createSpan({
						cls: "semlink-history-archive-title",
						text: t("historyArchivedManualHead").replace("{n}", String(manuallyArchived.length)),
					});
					const items = list.createDiv({ cls: "semlink-history-group-items semlink-history-archive-items" });
					for (const session of manuallyArchived) renderArchivedItem(items, session, true);
				}
				if (manuallyArchived.length === 0) {
					list.createDiv({ cls: "semlink-history-empty", text: t("historyArchiveEmptyPro") });
				}
				return;
			}

			// ── Main view ──
			let pool = all;
			if (pro && query) {
				pool = pool.filter((s) =>
					s.title.toLowerCase().includes(query) ||
					s.messages.some((m) => (m.content || "").toLowerCase().includes(query))
				);
			}
			if (pool.length === 0) {
				list.createDiv({ cls: "semlink-history-empty", text: query ? t("historyNoMatch") : t("historyEmpty") });
				return;
			}
			let visibleCount = freeLimit !== null
				? Math.min(freeLimit, pool.length)
				: pool.filter((s) => s.updatedAt >= now - MONTH_MS).length;
			if (freeLimit === null && pool.length > 0 && visibleCount === 0) {
				visibleCount = Math.min(PAGE, pool.length);
			}
			if (freeLimit === null) visibleCount = Math.min(pool.length, visibleCount + showMorePages * PAGE);

			const rest = pool;

			if (pro && tab === "folder" && !query) {
				// Folder tree (nested via "/" in folder names). Empty folders
				// come from the store's registry so they survive without any
				// session inside.
				interface FNode { name: string; path: string; children: Map<string, FNode>; sessions: ChatSession[]; }
				const root: FNode = { name: "", path: "", children: new Map(), sessions: [] };
				const addPath = (folder: string): void => {
					const parts = folder.split("/").map((x) => x.trim()).filter(Boolean);
					let node = root;
					let path = "";
					for (const part of parts) {
						path = path ? `${path}/${part}` : part;
						if (!node.children.has(part)) node.children.set(part, { name: part, path, children: new Map(), sessions: [] });
						node = node.children.get(part)!;
					}
				};
				for (const f of this.history.folders()) addPath(f);
				for (const session of rest) {
					if (!session.folder) continue;
					const parts = session.folder.split("/").map((x) => x.trim()).filter(Boolean);
					let node = root;
					for (const part of parts) node = node.children.get(part)!;
					node.sessions.push(session);
				}
				const countOf = (n: FNode): number =>
					n.sessions.length + [...n.children.values()].reduce((a, c) => a + countOf(c), 0);
				const renderNode = (n: FNode, depth: number, container: HTMLElement): void => {
					const isCollapsed = collapsed.has(n.path);
					// Direct children of the "Folders" root render with a folder
					// icon instead of a chevron, at the root's indent level.
					const childOfRoot = depth === 1;
					const visualDepth = childOfRoot ? 0 : depth;
					if (editingPath === n.path) {
						// Inline rename: [icon][input][✓][✕] — name, count and
						// the action buttons are all hidden while editing.
						const editRow = container.createDiv({ cls: "semlink-history-folder semlink-history-folder-edit" });
						editRow.style.paddingLeft = `${0.35 + visualDepth * 0.85}rem`;
						if (n.path !== "__folders_root__") {
							const icon = editRow.createSpan({ cls: "semlink-history-folder-chev" });
							setIcon(icon, isCollapsed ? "chevron-right" : "chevron-down");
							const folderIco = editRow.createSpan({ cls: "semlink-history-folder-chev" });
							setIcon(folderIco, "folder");
						}
						const input = editRow.createEl("input", {
							cls: "semlink-folder-input",
							attr: { type: "text", value: n.name },
						});
						const finish = (apply: boolean): void => {
							const name = input.value.trim().slice(0, 24);
							if (apply && name && name !== n.name) {
								const parentPrefix = n.path.includes("/") ? n.path.slice(0, n.path.lastIndexOf("/")) : "";
								this.history.renameFolder(n.path, parentPrefix ? `${parentPrefix}/${name}` : name);
								void this.history.save();
							}
							editingPath = null;
							render();
						};
						input.addEventListener("keydown", (e) => {
							if (e.key === "Enter") { e.preventDefault(); finish(true); }
							else if (e.key === "Escape") { e.preventDefault(); finish(false); }
							e.stopPropagation();
						});
						input.addEventListener("click", (e) => e.stopPropagation());
						const ok = editRow.createSpan({
							cls: "semlink-history-folder-act",
							attr: { "aria-label": t("historyFolderOk") },
						});
						setIcon(ok, "check");
						ok.addEventListener("click", (e) => { e.stopPropagation(); finish(true); });
						const cancel = editRow.createSpan({
							cls: "semlink-history-folder-act",
							attr: { "aria-label": t("historyCancel") },
						});
						setIcon(cancel, "x");
						cancel.addEventListener("click", (e) => { e.stopPropagation(); finish(false); });
						window.setTimeout(() => { input.focus(); input.select(); }, 0);
						// Keep the expanded subtree visible while renaming — only
						// the row itself switches to edit mode.
						if (!isCollapsed) {
							const body = container.createDiv({ cls: "semlink-history-folder-body" });
							for (const child of [...n.children.values()].sort((a, b) => a.name.localeCompare(b.name))) renderNode(child, depth + 1, body);
							for (const session of n.sessions) renderItem(body, session);
						}
						return;
					}
					const row = container.createDiv({
						cls: "semlink-history-folder" + (isCollapsed ? " is-collapsed" : "") + (n.path === "__folders_root__" ? " semlink-history-folder-root" : ""),
					});
					row.style.paddingLeft = `${0.35 + visualDepth * 0.85}rem`;
					if (n.path !== "__folders_root__") {
						// Root has no icon (bold name only); real folders carry a
						// state chevron + folder identity icon.
						const chev = row.createSpan({ cls: "semlink-history-folder-chev" });
						setIcon(chev, isCollapsed ? "chevron-right" : "chevron-down");
						const folderIco = row.createSpan({ cls: "semlink-history-folder-chev" });
						setIcon(folderIco, "folder");
					}
					row.createSpan({ cls: "semlink-history-folder-name", text: n.name });
					if (n.path !== "__folders_root__") {
						row.createSpan({ cls: "semlink-history-folder-count", text: String(countOf(n)) });
					}
					if (n.path === "__folders_root__") {
						// The Folders root carries the "new sub-folder" action.
						const add = row.createSpan({
							cls: "semlink-history-folder-add",
							attr: { "aria-label": t("historyNewFolder") },
						});
						setIcon(add, "folder-plus");
						add.addEventListener("click", (e) => {
							e.stopPropagation();
							new FolderNameModal(this.app, "", (name) => {
								this.history.createFolder(name);
								void this.history.save();
								render();
							}).open();
						});
					}
					if (n.path !== "__folders_root__") {
						// Hover actions on real folders: rename + delete.
						const acts = row.createSpan({ cls: "semlink-history-folder-acts" });
						const ren = acts.createSpan({
							cls: "semlink-history-folder-act",
							attr: { "aria-label": t("historyRenameFolder") },
						});
						setIcon(ren, "pencil");
						ren.addEventListener("click", (e) => {
							e.stopPropagation();
							editingPath = n.path;
							render();
						});
						const del = acts.createSpan({
							cls: "semlink-history-folder-act",
							attr: { "aria-label": t("historyDeleteFolder") },
						});
						setIcon(del, "trash-2");
						del.addEventListener("click", (e) => {
							e.stopPropagation();
							const doDelete = () => {
								this.history.deleteFolder(n.path);
								void this.history.save();
								render();
							};
							const n2 = countOf(n);
							if (n2 > 0) {
								new ConfirmModal(this.app, t("historyDeleteFolder"),
									t("historyDeleteFolderConfirm").replace("{n}", String(n2)), doDelete).open();
								return;
							}
							doDelete();
						});
					}
					row.addEventListener("click", () => {
						if (collapsed.has(n.path)) collapsed.delete(n.path);
						else collapsed.add(n.path);
						render();
					});
					if (n.path !== "__folders_root__") {
						row.addEventListener("dragover", (e) => {
							const dt = e.dataTransfer;
							if (dt?.types.includes("text/semlink-session")) {
								e.preventDefault();
								e.stopPropagation();
								// Must match the dragstart effectAllowed("move"),
								// or Chromium silently cancels the drop.
								dt.dropEffect = "move";
								row.addClass("is-drop");
							}
						});
						row.addEventListener("dragleave", () => row.removeClass("is-drop"));
						row.addEventListener("drop", (e) => {
							e.preventDefault();
							e.stopPropagation();
							row.removeClass("is-drop");
							const id = e.dataTransfer?.getData("text/semlink-session");
							if (!id) return;
							this.history.updateSession(id, { folder: n.path });
							void this.history.save();
							render();
						});
					}
					if (!isCollapsed) {
						const body = container.createDiv({ cls: "semlink-history-folder-body" });
						for (const child of [...n.children.values()].sort((a, b) => a.name.localeCompare(b.name))) {
							renderNode(child, depth + 1, body);
						}
						for (const session of n.sessions) renderItem(body, session);
					}
				};
				const folderRoots = [...root.children.values()].sort((a, b) => a.name.localeCompare(b.name));
				if (folderRoots.length > 0) {
					// A single "Folders" root holds every created folder as its
					// child (one consistent root instead of loose top-levels).
					const foldersRoot: FNode = {
						name: t("historyTabFolder"),
						path: "__folders_root__",
						children: new Map(folderRoots.map((f) => [f.name, f])),
						sessions: [],
					};
					renderNode(foldersRoot, 0, list);
				}
				// Folder tab groups by folder name only — no time buckets even
				// for un-filed sessions (they form one flat "unfiled" group).
				const unfiled = rest.filter((s) => !s.folder);
				if (unfiled.length > 0 && folderRoots.length > 0) {
					list.createDiv({ cls: 'semlink-history-unfiled-gap' });
				}
				if (unfiled.length > 0) {
					// No wrapper here: un-filed chats render flush (no left
					// border / indent) alongside the folder tree; no pin slot
					// either (pinning lives on the Time tab).
					for (const session of unfiled.slice(0, visibleCount)) renderItem(list, session, false, false);
				}
				if (visibleCount < unfiled.length) {
					const more = list.createDiv({ cls: "semlink-history-more", text: t("historyShowMore") });
					more.addEventListener("click", () => { showMorePages++; render(); });
				}
			} else if (!pro && tab === "folder") {
				// Free tier on the Folders tab: ghost tree under a veil;
				// clicking the veil's call-to-action opens the activation.
				const wrap = list.createDiv({ cls: "semlink-history-folder-veil" });
				const ghost = wrap.createDiv({ cls: "semlink-history-folder-ghost" });
				for (let i = 0; i < 7; i++) {
					ghost.createDiv({
						cls: "semlink-history-folder-ghost-line" + (i % 3 === 2 ? " is-child" : ""),
						attr: { style: `width:${46 + ((i * 37) % 42)}%` },
					});
				}
				const mask = wrap.createDiv({ cls: "semlink-history-folder-mask" });
				mask.createDiv({ cls: "semlink-history-folder-mask-title", text: `✨ ${t("historyTabFolder")}` });
				const cta = mask.createDiv({ cls: "semlink-history-folder-mask-cta", text: t("unlockPro") });
				cta.addEventListener("click", () => {
					this.closeHistoryDrawer(backdrop, drawer);
					new LicenseModal(this.app, this.plugin, () => void this.showHistoryDrawer()).open();
				});
			} else {
				// Time tab (and Pro search): pinned group first, then flat
				// time buckets. (While searching, everything flattens.)
				if (pro && tab === "time") {
					const pinned = pool.filter((x) => x.pinned);
					if (pinned.length > 0) {
						list.createDiv({ cls: "semlink-history-group", text: t("historyPinnedGroup") });
						const pinnedItems = list.createDiv({ cls: "semlink-history-group-items" });
						// compact: title-only rows in the pinned group
						for (const session of pinned) renderItem(pinnedItems, session, true);
					}
				}
				let lastKey = "";
				let groupEl: HTMLElement | null = null;
				const timePool = (pro && tab === "time") ? rest.filter((x) => !x.pinned) : rest;
				for (const session of timePool.slice(0, visibleCount)) {
					const key = historyBucket(session.updatedAt, now);
					if (key !== lastKey) {
						list.createDiv({ cls: "semlink-history-group", text: t(HISTORY_GROUP_KEYS[key]) });
						groupEl = list.createDiv({ cls: "semlink-history-group-items" });
						lastKey = key;
					}
					renderItem(groupEl!, session);
				}
				if (freeLimit === null && visibleCount < rest.length) {
					const more = list.createDiv({ cls: "semlink-history-more", text: t("historyShowMore") });
					more.addEventListener("click", () => { showMorePages++; render(); });
				}
				if (freeLimit !== null) {
					// Free tier: locked earlier chats live HERE (bottom of the
					// Time tab, where the user wanted to read them) — NOT in
					// the archive view; manual archiving is a different thing.
					const locked = all.slice(Math.min(freeLimit, all.length));
					const lockedVisible = Math.min(locked.length, LOCKED_PAGE + lockedPages * LOCKED_PAGE);
					if (locked.length > 0) {
						const head = list.createDiv({ cls: "semlink-history-archive-head" });
						head.createSpan({
							cls: "semlink-history-archive-title",
							text: t("historyArchivedHead").replace("{n}", String(locked.length)),
						});
						const unlock = head.createSpan({ cls: "semlink-history-archive-upgrade", text: t("unlockPro") });
						unlock.addEventListener("click", (e) => {
							e.stopPropagation();
							this.closeHistoryDrawer(backdrop, drawer);
							new LicenseModal(this.app, this.plugin, () => void this.showHistoryDrawer()).open();
						});
						const lockedItems = list.createDiv({ cls: "semlink-history-group-items semlink-history-archive-items" });
						for (const session of locked.slice(0, lockedVisible)) renderArchivedItem(lockedItems, session, false);
						if (lockedVisible < locked.length) {
							const more = lockedItems.createDiv({ cls: "semlink-history-more", text: t("historyShowMore") });
							more.addEventListener("click", () => { lockedPages++; render(); });
						}
					}
				}
			}
		};

		const renderArchivedItem = (container: HTMLElement, session: ChatSession, manual: boolean): void => {
			const item = container.createDiv({ cls: "semlink-history-item semlink-history-item-archived" });
			const info = item.createDiv({ cls: "semlink-history-item-info" });
			info.createDiv({ cls: "semlink-history-item-title", text: session.title });
			const date = new Date(session.updatedAt);
			const timeStr = `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
			info.createDiv({ cls: "semlink-history-item-meta", text: timeStr });
			if (manual) {
				const restoreBtn = item.createEl("button", {
					cls: "semlink-history-item-del clickable-icon",
					attr: { "aria-label": t("historyUnarchive") },
				});
				setIcon(restoreBtn, "archive-restore");
				restoreBtn.addEventListener("click", (e) => {
					e.stopPropagation();
					this.history.updateSession(session.id, { archived: false });
					void this.history.save();
					render();
				});
			} else {
				const lock = item.createEl("button", { cls: "semlink-history-item-lock clickable-icon", attr: { "aria-label": t("historyLockedHint") } });
				setIcon(lock, "lock");
			}
			const delBtn = item.createEl("button", { cls: "semlink-history-item-del clickable-icon" });
			setIcon(delBtn, "trash");
			delBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.history.deleteSession(session.id);
				void this.history.save();
				render();
			});
			item.addEventListener("click", () => {
				if (!manual) new Notice(t("historyLockedHint"));
			});
		};

		const renderItem = (container: HTMLElement, session: ChatSession, compact = false, showPin = true): HTMLElement => {
			const item = container.createDiv({ cls: "semlink-history-item" });
			// Drag a conversation onto a folder row (Folders tab) to file it.
			item.draggable = true;
			item.addEventListener("dragstart", (e) => {
				e.dataTransfer?.setData("text/semlink-session", session.id);
				e.dataTransfer!.effectAllowed = "move";
			});
			// showPin=false (Folders-tab un-filed rows): no pin at all —
			// pinning belongs to the Time tab, and no sibling row there
			// shows one, so there is no slot to keep aligned.
			if (showPin) {
				const pinBtn = item.createEl("button", {
					cls: "semlink-history-item-pin clickable-icon" + (session.pinned ? " is-pinned" : ""),
					attr: { "aria-label": t("historyPin") },
				});
				setIcon(pinBtn, session.pinned ? "pin-off" : "pin");
				if (pro) {
					pinBtn.addEventListener("click", (e) => {
						e.stopPropagation();
						this.history.updateSession(session.id, { pinned: !session.pinned });
						void this.history.save();
						render();
					});
				} else {
					pinBtn.addEventListener("click", (e) => {
						e.stopPropagation();
						this.closeHistoryDrawer(backdrop, drawer);
						new LicenseModal(this.app, this.plugin, () => void this.showHistoryDrawer()).open();
					});
				}
			}
			const info = item.createDiv({ cls: "semlink-history-item-info" });
			info.createDiv({ cls: "semlink-history-item-title", text: session.title });
			const date = new Date(session.updatedAt);
			const timeStr = `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
			if (!compact) {
				info.createDiv({ cls: "semlink-history-item-meta", text: timeStr });
			}
			// Pin icon: visible to everyone on hover; for free users clicking
			// it is a friction point (activation modal), like Folders/search.
			if (pro) {
				const folderBtn = item.createEl("button", {
					cls: "semlink-history-item-folder clickable-icon",
					attr: { "aria-label": t("historyFolder") },
				});
				setIcon(folderBtn, "folder-input");
				folderBtn.addEventListener("click", (e) => {
					e.stopPropagation();
					this.showFolderMenu(e, session, () => render());
				});
			}
			const archBtn = item.createEl("button", {
				cls: "semlink-history-item-del clickable-icon",
				attr: { "aria-label": t("historyArchiveAction") },
			});
			setIcon(archBtn, "archive");
			archBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.history.updateSession(session.id, { archived: true });
				void this.history.save();
				render();
			});
			if (compact) {
				// Pinned rows only: the time is the LAST flow child, pushed to
				// the right edge (aligned with where 📦 appears); hover swaps
				// it out for the button group. Row height stays constant (the
				// always-in-flow pin button anchors it).
				item.createSpan({ cls: "semlink-history-item-time", text: timeStr });
			}
			item.addEventListener("click", () => {
				this.closeHistoryDrawer(backdrop, drawer);
				void this.loadSession(session);
			});
			return item;
		};

		archiveBtn.addEventListener("click", () => {
			view = view === "archive" ? "main" : "archive";
			render();
		});
		render();

		window.requestAnimationFrame(() => {
			drawer.addClass("semlink-history-drawer-open");
			backdrop.addClass("semlink-history-backdrop-open");
		});
		closeBtn.addEventListener("click", () => this.closeHistoryDrawer(backdrop, drawer));
		backdrop.addEventListener("click", () => this.closeHistoryDrawer(backdrop, drawer));
	}

	/** Folder picker menu for a history session (Pro). */
	private showFolderMenu(evt: MouseEvent, session: ChatSession, onChange: () => void): void {
		const menu = new Menu();
		for (const f of this.history.folders()) {
			menu.addItem((item) => {
				item.setTitle(f)
					.setIcon(session.folder === f ? "check" : "folder")
					.onClick(() => {
						this.history.updateSession(session.id, { folder: f });
						void this.history.save();
						onChange();
					});
			});
		}
		if (session.folder) {
			menu.addItem((item) => {
				item.setTitle(t("historyRemoveFolder")).setIcon("folder-minus").onClick(() => {
					this.history.updateSession(session.id, { folder: "" });
					void this.history.save();
					onChange();
				});
			});
		}
		menu.addSeparator();
		menu.addItem((item) => {
			item.setTitle(t("historyNewFolder")).setIcon("folder-plus").onClick(() => {
				new FolderNameModal(this.app, session.folder || "", (name) => {
					this.history.updateSession(session.id, { folder: name });
					void this.history.save();
					onChange();
				}).open();
			});
		});
		menu.showAtMouseEvent(evt);
	}

	private closeHistoryDrawer(backdrop: HTMLElement, drawer: HTMLElement): void {
		drawer.removeClass("semlink-history-drawer-open");
		backdrop.removeClass("semlink-history-backdrop-open");
		window.setTimeout(() => { backdrop.remove(); drawer.remove(); }, 300);
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
		const fg = this.contextRingEl.querySelector(".ring-fg");
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

	/** 7528 → "2小时5分" / 65 → "1分5秒" / 30 → "30秒" (zh);
	 *  7528 → "2h 5m" / 65 → "1m 5s" / 30 → "30s" (en). */
	private formatDuration(totalSec: number): string {
		const s = Math.max(0, Math.round(totalSec));
		const h = Math.floor(s / 3600);
		const m = Math.floor((s % 3600) / 60);
		const sec = s % 60;
		const parts: string[] = [];
		if (getLang() === "zh") {
			if (h > 0) parts.push(`${h}小时`);
			if (m > 0) parts.push(`${m}分`);
			if (sec > 0 || parts.length === 0) parts.push(`${sec}秒`);
		} else {
			if (h > 0) parts.push(`${h}h`);
			if (m > 0) parts.push(`${m}m`);
			if (sec > 0 || parts.length === 0) parts.push(`${sec}s`);
		}
		return parts.join(" ");
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
		const shortName = (id: string): string => {
			const slash = id.lastIndexOf("/");
			return slash >= 0 ? id.slice(slash + 1) : id;
		};

		// Header card: the ACTIVE model — brand logo + "Provider: Model" +
		// context window on the right (reference: ZCode's model switcher).
		if (active) {
			const header = popup.createDiv({ cls: "semlink-search-model-popup-header" });
			const headerLogo = header.createSpan({ cls: "semlink-search-model-popup-logo" });
			setSvgIcon(headerLogo, brandLogoOf(active.provider.name || active.provider.id).svg || llmIconSvg);
			header.createSpan({
				cls: "semlink-search-model-popup-title",
				text: `${active.provider.name}: ${shortName(active.model.id)}`,
			});
			if (active.model.contextWindow > 0) {
				header.createSpan({ cls: "semlink-search-model-popup-ctx", text: formatContextWindow(active.model.contextWindow) });
			}
		}

		for (const group of this.chatClient.getModelOptions()) {
			popup.createDiv({ cls: "semlink-search-model-popup-group", text: group.providerName.toUpperCase() });
			for (const m of group.models) {
				const isActive = active !== null && active.provider.id === group.providerId && active.model.id === m.id;
				const row = popup.createDiv({
					cls: "semlink-search-model-popup-row" + (isActive ? " is-active" : ""),
				});
				const logoEl = row.createSpan({ cls: "semlink-search-model-popup-logo" });
				setSvgIcon(logoEl, brandLogoOf(group.providerName).svg || llmIconSvg);
				// Full model id in the list (org/model) — more complete than
				// the toolbar's short name, disambiguates same-name models
				// from different orgs on multi-provider hosts.
				row.createSpan({ cls: "semlink-search-model-popup-name", text: m.id });
				if (m.contextWindow > 0) {
					row.createSpan({ cls: "semlink-search-model-popup-ctx", text: formatContextWindow(m.contextWindow) });
				}
				row.addEventListener("click", () => {
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
		// The active provider's brand logo on the left (generic LLM mark when
		// the provider has no known logo); the model id on its right —
		// provider names are skipped to keep the row compact.
		if (this.modelNameEl) {
			const active = this.chatClient.getActiveModel();
			const brand = active ? brandLogoOf(active.provider.name || active.provider.id).svg : undefined;
			setSvgIcon(this.modelNameEl, brand || llmIconSvg);
		}
		if (this.modelLabelEl) {
			const active = this.chatClient.getActiveModel();
			// Display the bare model name — strip the "org/" prefix
			// ("deepseek-ai/DeepSeek-V4-Flash" → "DeepSeek-V4-Flash") to save
			// toolbar space. Display only: selection keeps the full id.
			const id = active ? active.model.id : "";
			const slash = id.lastIndexOf("/");
			this.modelLabelEl.setText(slash >= 0 ? id.slice(slash + 1) : id);
		}
		// The context window may differ across models — recompute the ring
		// against the last turn's usage.
		if (this.lastBreakdown) {
			this.updateContextRing(this.lastBreakdown.used);
		}
	}

	/** Copy the answer markdown to the clipboard. Obsidian's Electron host
	 *  is a secure context, so the async Clipboard API is always available. */
	private async copyAnswer(text: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
			new Notice(t("searchCopied"));
		} catch {
			new Notice(t("searchCopyFailed"));
		}
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


/** Tiny input modal used by the Pro history-management folder picker. */
class FolderNameModal extends Modal {
	private initial: string;
	private onDone: (name: string) => void;

	constructor(app: App, initial: string, onDone: (name: string) => void) {
		super(app);
		this.initial = initial;
		this.onDone = onDone;
		this.modalEl.addClass("semlink-folder-name-modal");
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: t("historyNewFolder") });
		const input = contentEl.createEl("input", {
			cls: "semlink-folder-input",
			attr: { type: "text", placeholder: t("historyFolderPlaceholder"), value: this.initial },
		});
		input.focus();
		const submit = () => {
			const name = input.value.trim().slice(0, 24);
			if (name) {
				this.onDone(name);
				this.close();
			}
		};
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") submit();
		});
		const row = contentEl.createDiv({ cls: "semlink-folder-input-row" });
		const ok = row.createEl("button", { cls: "mod-cta", text: t("historyFolderOk") });
		ok.addEventListener("click", submit);
		const cancel = row.createEl("button", { text: t("chatDone") });
		cancel.addEventListener("click", () => this.close());
	}

	onClose() {
		this.contentEl.empty();
	}
}
