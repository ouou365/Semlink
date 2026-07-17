// ========================================
// Semlink - Semantic Search View (Right Sidebar)
// ========================================
// A sidebar panel that lets the user type a natural-language query, runs it
// through the same embed → search pipeline the MCP server uses, and shows the
// results in a conversational (chat-like) flow. Each turn = a user query
// bubble followed by a list of matching note cards.

import { ItemView, WorkspaceLeaf, TFile, Vault } from "obsidian";
import type { VectorStore } from "./vector-store";
import type { EmbeddingClient } from "./embedding-client";
import type { SearchResult } from "./types";
import { t } from "./i18n";
import logoSvg from "./semlink-logo.svg";

export const SEARCH_VIEW_TYPE = "semlink-semantic-search";

const DEFAULT_LIMIT = 10;
const DEFAULT_THRESHOLD = 0.3;

export class SemanticSearchView extends ItemView {
	private store: VectorStore;
	private client: EmbeddingClient;
	private vault: Vault;

	// DOM references
	private inputEl!: HTMLInputElement;
	private messagesEl!: HTMLElement; // scrollable conversation area
	private statusEl!: HTMLElement;   // transient status (no-api-key hint)

	constructor(
		leaf: WorkspaceLeaf,
		store: VectorStore,
		client: EmbeddingClient,
		vault: Vault,
	) {
		super(leaf);
		this.store = store;
		this.client = client;
		this.vault = vault;
	}

	getViewType(): string {
		return SEARCH_VIEW_TYPE;
	}

	getDisplayText(): string {
		return t("searchViewTitle");
	}

	getIcon(): string {
		return "search";
	}

	protected async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("semlink-search-view");

		// ── Header (top, fixed) — brand logo + title ──
		const header = contentEl.createDiv({ cls: "semlink-search-header" });
		const logoEl = header.createDiv({ cls: "semlink-search-logo" });
		logoEl.innerHTML = logoSvg;
		header.createDiv({ cls: "semlink-search-brand", text: "Semlink" });

		// ── Conversation area (middle, scrollable) ──
		this.statusEl = contentEl.createDiv({ cls: "semlink-search-status" });
		this.messagesEl = contentEl.createDiv({ cls: "semlink-search-messages" });

		// ── Input footer (bottom, fixed) ──
		const footer = contentEl.createDiv({ cls: "semlink-search-footer" });
		const wrapper = footer.createDiv({ cls: "semlink-search-input-wrapper" });
		this.inputEl = wrapper.createEl("input", {
			type: "text",
			cls: "semlink-search-input",
			attr: { placeholder: t("searchPlaceholder"), "aria-label": t("searchPlaceholder") },
		});
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				void this.runSearch();
			}
		});

		const searchBtn = wrapper.createEl("button", {
			cls: "semlink-search-btn",
			text: t("searchButton"),
		});
		searchBtn.addEventListener("click", () => {
			void this.runSearch();
		});

		if (!this.hasApiKey()) {
			this.statusEl.textContent = t("searchNeedApiKey");
		}
	}

	protected async onClose(): Promise<void> {
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

			// Replace the loading placeholder with actual results.
			loadingEl.empty();
			if (results.length === 0) {
				loadingEl.createDiv({ cls: "semlink-msg-empty", text: t("searchNoResults") });
			} else {
				this.renderResultsIn(loadingEl, results);
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			loadingEl.empty();
			loadingEl.createDiv({ cls: "semlink-msg-error", text: `${t("searchError")} ${msg}` });
		}

		this.scrollToBottom();
	}

	/** Append a right-aligned user query bubble to the conversation. */
	private appendUserMessage(text: string): void {
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
			const scorePct = Math.round(r.score * 100);
			meta.createSpan({
				cls: "semlink-search-score",
				text: `${t("searchScoreLabel")} ${scorePct}%`,
			});

			card.addEventListener("click", () => {
				void this.openNote(r.notePath);
			});
		}
	}

	private scrollToBottom(): void {
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	private async openNote(notePath: string): Promise<void> {
		const file = this.vault.getAbstractFileByPath(notePath);
		if (file instanceof TFile) {
			await this.app.workspace.getLeaf(false).openFile(file);
		}
	}

	private basename(path: string): string {
		const slash = path.lastIndexOf("/");
		const name = slash >= 0 ? path.slice(slash + 1) : path;
		const dot = name.lastIndexOf(".");
		return dot > 0 ? name.slice(0, dot) : name;
	}
}
