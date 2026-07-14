// ========================================
// Semlink - Progress Modal
// ========================================

import { App, Modal, Setting } from "obsidian";
import type { IndexProgress } from "./types";
import { ProgressTracker } from "./progress";
import { t } from "./i18n";

export class ProgressModal extends Modal {
	private progress: ProgressTracker;
	private unsubscribe: (() => void) | null = null;

	// Buttons
	private btnContainer!: HTMLElement;
	private currentBtnState: "resume" | "pause" | "none" = "none";
	private buttonLoading = false;

	// Fixed layout elements (created once, text updated in place)
	private phaseEl!: HTMLElement;
	private statsEl!: HTMLElement;
	private embeddedChunksValue!: HTMLElement;
	private failedChunksValue!: HTMLElement;
	private skippedChunksValue!: HTMLElement;
	private currentFileValue!: HTMLElement;
	private avgResponseValue!: HTMLElement;
	private chunkProgressValue!: HTMLElement;
	private networkEl!: HTMLElement;
	private errorEl!: HTMLElement;

	constructor(app: App, progress: ProgressTracker) {
		super(app);
		this.progress = progress;
		this.modalEl.addClass("smart-vault-progress-modal");
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: t("progressTitle") });

		// Phase
		this.phaseEl = contentEl.createEl("p", { cls: "progress-phase" });

		// Stats
		this.statsEl = contentEl.createDiv({ cls: "progress-stats" });

		// Detail grid (fixed layout)
		const details = contentEl.createDiv({ cls: "detail-grid" });

		const makeRow = (labelKey: string): HTMLElement => {
			details.createSpan({ text: t(labelKey), cls: "label" });
			const value = details.createSpan({ cls: "value" });
			return value;
		};

		this.embeddedChunksValue = makeRow("embeddedChunks");
		this.failedChunksValue = makeRow("failedChunks");
		this.skippedChunksValue = makeRow("skippedChunks");
		this.currentFileValue = makeRow("currentFile");
		this.avgResponseValue = makeRow("avgResponse");
		this.chunkProgressValue = makeRow("chunkProgress");

		// Network status
		this.networkEl = contentEl.createDiv({ cls: "network-status" });

		// Error message
		this.errorEl = contentEl.createDiv({ cls: "progress-error" });

		// Button container
		this.btnContainer = contentEl.createDiv({ cls: "btn-group" });

		// Initial render
		this.renderInfo(this.progress.current);
		this.renderButtons(this.progress.current);

		// Subscribe to progress updates
		this.unsubscribe = this.progress.onProgress((event) => {
			if (event.type === "progress") {
				this.renderInfo(event.progress);
				this.renderButtons(event.progress);
			}
		});
	}

	onClose() {
		this.unsubscribe?.();
		this.contentEl.empty();
	}

	private renderInfo(p: IndexProgress) {
		// Phase
		const phaseNames: Record<string, string> = {
			idle: t("phaseIdle"),
			scanning: t("phaseScanning"),
			chunking: t("phaseChunking"),
			embedding: t("phaseEmbedding"),
			building_index: t("phaseBuilding"),
			completed: t("phaseCompleted"),
		};
		this.phaseEl.textContent = `${t("phaseCurrent")}: ${phaseNames[p.phase] || p.phase}`;

		// Stats
		const pct = p.totalNotes > 0 ? (p.processedNotes / p.totalNotes) * 100 : 0;
		this.statsEl.textContent = `${p.processedNotes.toLocaleString()} / ${p.totalNotes.toLocaleString()} (${pct.toFixed(1)}%)`;

		// Detail values
		this.embeddedChunksValue.textContent = p.embeddedChunks.toLocaleString();
		this.failedChunksValue.textContent = String(p.failedChunks);
		this.skippedChunksValue.textContent = p.skippedChunks.toLocaleString();
		this.currentFileValue.textContent = p.currentFile || "-";
		this.avgResponseValue.textContent = `${p.avgResponseMs}ms`;
		this.chunkProgressValue.textContent = p.fileChunkProgress || "-";

		// Network status
		const statusLabels: Record<string, string> = {
			healthy: t("networkHealthy"),
			degraded: t("networkDegraded"),
			paused: t("networkPaused"),
		};
		let networkText = `${t("networkLabel")} ${statusLabels[p.networkStatus] || p.networkStatus}`;
		if (p.isPaused) {
			networkText += ` ${p.isAutoPaused ? t("autoPaused") : t("manualPaused")}`;
		}
		if (p.consecutiveFailures > 0) {
			networkText += ` ${t("consecutiveFailures")} ${p.consecutiveFailures}`;
		}
		if (p.backoffRemainingSec > 0) {
			networkText += ` ${t("backoffRemaining")} ${p.backoffRemainingSec}s`;
		}
		this.networkEl.textContent = networkText;

		// Error message
		if (p.lastError) {
			this.errorEl.textContent = p.lastError;
			this.errorEl.addClass("is-visible");
		} else {
			this.errorEl.textContent = "";
			this.errorEl.removeClass("is-visible");
		}
	}

	private renderButtons(p: IndexProgress) {
		let desired: "resume" | "pause" | "none";
		if (p.isPaused || p.phase === "idle") {
			desired = "resume";
		} else if (p.phase !== "completed" && p.phase !== "idle" as string) {
			desired = "pause";
		} else {
			desired = "none";
		}

		if (this.buttonLoading) {
			if (desired === this.currentBtnState) return;
			this.buttonLoading = false;
		}

		if (desired === this.currentBtnState) return;
		this.currentBtnState = desired;

		this.btnContainer.empty();

		if (desired === "resume") {
			new Setting(this.btnContainer).addButton((btn) => {
				btn.setButtonText(t("btnResume")).setClass("mod-cta").onClick(() => {
					this.buttonLoading = true;
					btn.buttonEl.setCssStyles({ minWidth: btn.buttonEl.offsetWidth + "px" });
					btn.setButtonText(t("btnLoading")).setDisabled(true);
					window.setTimeout(() => {
						this.app.workspace.trigger("smart-vault:resume");
					}, 300);
				});
			});
		} else if (desired === "pause") {
			new Setting(this.btnContainer).addButton((btn) => {
				btn.setButtonText(t("btnPause")).onClick(() => {
					this.buttonLoading = true;
					btn.buttonEl.setCssStyles({ minWidth: btn.buttonEl.offsetWidth + "px" });
					btn.setButtonText(t("btnPausing")).setDisabled(true);
					window.setTimeout(() => {
						this.app.workspace.trigger("smart-vault:pause");
					}, 300);
				});
			});
		}
	}
}
