// ========================================
// Semlink - Semantic Search View (Right Sidebar)
// ========================================
// A sidebar panel that lets the user type a natural-language query, runs it
// through the same embed → search pipeline the MCP server uses, and lists the
// most relevant note chunks. Clicking a result opens the note.

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

	// DOM references (built once in onOpen, updated in place)
	private inputEl!: HTMLInputElement;
	private resultsEl!: HTMLElement;
	private statusEl!: HTMLElement;

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

		// ── Results area (middle, scrollable) ──
		this.statusEl = contentEl.createDiv({ cls: "semlink-search-status" });
		this.resultsEl = contentEl.createDiv({ cls: "semlink-search-results" });

		// ── Input footer (bottom, fixed) — like claudian's composer ──
		const footer = contentEl.createDiv({ cls: "semlink-search-footer" });
		const wrapper = footer.createDiv({ cls: "semlink-search-input-wrapper" });
		this.inputEl = wrapper.createEl("input", {
			type: "text",
			cls: "semlink-search-input",
			attr: { placeholder: t("searchPlaceholder"), "aria-label": t("searchPlaceholder") },
		});
		// Search only on explicit submit (Enter key or Search button) — no
		// live/autocomplete-style search while typing.
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

		// If no API key is configured, show a hint up front instead of failing
		// on the first query.
		if (!this.hasApiKey()) {
			this.statusEl.textContent = t("searchNeedApiKey");
		}
	}

	protected async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	private hasApiKey(): boolean {
		// EmbeddingClient throws if the active key is missing; we mirror that
		// check here so we can show a friendly hint.
		const provider = (this.client as any).provider as string | undefined;
		if (provider === "huggingface") {
			return !!(this.client as any).huggingFaceApiKey;
		}
		return !!(this.client as any).apiKey;
	}

	private async runSearch(): Promise<void> {
		const query = this.inputEl.value.trim();
		if (!query) {
			this.statusEl.textContent = t("searchNoQuery");
			this.resultsEl.empty();
			return;
		}
		if (!this.hasApiKey()) {
			this.statusEl.textContent = t("searchNeedApiKey");
			this.resultsEl.empty();
			return;
		}

		// Loading state
		this.statusEl.textContent = t("searchSearching");
		this.resultsEl.empty();

		try {
			// Same pipeline as mcp-server.toolSearchNotes: embed query → search.
			const embedResult = await this.client.embed([query]);
			const results = await this.store.search(
				embedResult.embeddings[0],
				DEFAULT_LIMIT,
				DEFAULT_THRESHOLD,
			);

			if (results.length === 0) {
				this.statusEl.textContent = t("searchNoResults");
				return;
			}

			this.statusEl.textContent = "";
			this.renderResults(results);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.statusEl.textContent = `${t("searchError")} ${msg}`;
		}
	}

	private renderResults(results: SearchResult[]): void {
		this.resultsEl.empty();
		for (const r of results) {
			const card = this.resultsEl.createDiv({ cls: "semlink-search-result" });

			// Title: prefer heading, fall back to file basename
			const title = r.heading || this.basename(r.notePath);
			card.createDiv({ cls: "semlink-search-result-title", text: title });

			// Path (muted)
			card.createDiv({ cls: "semlink-search-result-path", text: r.notePath });

			// Preview text
			if (r.contentPreview) {
				card.createDiv({ cls: "semlink-search-result-preview", text: r.contentPreview });
			}

			// Meta row: similarity badge
			const meta = card.createDiv({ cls: "semlink-search-result-meta" });
			const scorePct = Math.round(r.score * 100);
			meta.createSpan({
				cls: "semlink-search-score",
				text: `${t("searchScoreLabel")} ${scorePct}%`,
			});

			// Click anywhere on the card opens the note
			card.addEventListener("click", () => {
				void this.openNote(r.notePath);
			});
		}
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
