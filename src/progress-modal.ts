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

	// Separate containers: info area refreshes freely, buttons persist
	private infoContainer!: HTMLElement;
	private btnContainer!: HTMLElement;
	private currentBtnState: "resume" | "pause" | "none" = "none";
	private buttonLoading = false;

	constructor(app: App, progress: ProgressTracker) {
		super(app);
		this.progress = progress;
		this.modalEl.addClass("smart-vault-progress-modal");
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: t("progressTitle") });

		this.infoContainer = contentEl.createDiv({ cls: "progress-info" });
		this.btnContainer = contentEl.createDiv({ cls: "btn-group" });

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
		this.infoContainer.empty();

		// Phase indicator
		const phaseNames: Record<string, string> = {
			idle: t("phaseIdle"),
			scanning: t("phaseScanning"),
			chunking: t("phaseChunking"),
			embedding: t("phaseEmbedding"),
			building_index: t("phaseBuilding"),
			completed: t("phaseCompleted"),
		};

		this.infoContainer.createEl("p", {
			text: `${t("phaseCurrent")}: ${phaseNames[p.phase] || p.phase}`,
			cls: "progress-phase",
		});

		// Stats line
		const pct = p.totalNotes > 0 ? (p.processedNotes / p.totalNotes) * 100 : 0;
		const statsLine = this.infoContainer.createDiv({ cls: "progress-stats" });
		statsLine.createSpan({
			text: `${p.processedNotes.toLocaleString()} / ${p.totalNotes.toLocaleString()} (${pct.toFixed(1)}%)`,
		});

		// Detail grid
		const details = this.infoContainer.createDiv({ cls: "detail-grid" });

		const addItem = (label: string, value: string) => {
			details.createSpan({ text: label, cls: "label" });
			details.createSpan({ text: value, cls: "value" });
		};

		addItem(t("embeddedChunks"), p.embeddedChunks.toLocaleString());
		addItem(t("failedChunks"), String(p.failedChunks));
		addItem(t("skippedChunks"), p.skippedChunks.toLocaleString());
		addItem(t("currentFile"), p.currentFile || "-");
		addItem(t("avgResponse"), `${p.avgResponseMs}ms`);

		// Network status
		const networkDiv = this.infoContainer.createDiv({ cls: "network-status" });
		const statusLabels: Record<string, string> = {
			healthy: t("networkHealthy"),
			degraded: t("networkDegraded"),
			paused: t("networkPaused"),
		};
		networkDiv.createSpan({ text: `${t("networkLabel")} ${statusLabels[p.networkStatus] || p.networkStatus}` });

		if (p.isPaused) {
			networkDiv.createSpan({
				text: p.isAutoPaused ? t("autoPaused") : t("manualPaused"),
			});
		}

		if (p.consecutiveFailures > 0) {
			networkDiv.createSpan({
				text: `${t("consecutiveFailures")} ${p.consecutiveFailures}`,
			});
		}

		if (p.backoffRemainingSec > 0) {
			networkDiv.createSpan({
				text: `${t("backoffRemaining")} ${p.backoffRemainingSec}s`,
			});
		}
	}

	private renderButtons(p: IndexProgress) {
		// Determine desired button state
		let desired: "resume" | "pause" | "none";
		if (p.isPaused || p.phase === "idle") {
			desired = "resume";
		} else if (p.phase !== "completed" && p.phase !== "idle" as string) {
			desired = "pause";
		} else {
			desired = "none";
		}

		// While button is in loading/transitioning state, skip all rebuilds
		// until the state actually changes (e.g. idle → scanning)
		if (this.buttonLoading) {
			if (desired === this.currentBtnState) return;
			// State changed → transition complete
			this.buttonLoading = false;
		}

		// Only rebuild buttons when the state actually changes
		if (desired === this.currentBtnState) return;
		this.currentBtnState = desired;

		this.btnContainer.empty();

		if (desired === "resume") {
			new Setting(this.btnContainer).addButton((btn) => {
				btn.setButtonText(t("btnResume")).setClass("mod-cta").onClick(() => {
					this.buttonLoading = true;
					btn.setButtonText(t("btnLoading")).setDisabled(true);
					this.app.workspace.trigger("smart-vault:resume");
				});
			});
		} else if (desired === "pause") {
			new Setting(this.btnContainer).addButton((btn) => {
				btn.setButtonText(t("btnPause")).onClick(() => {
					this.buttonLoading = true;
					btn.setButtonText(t("btnLoading")).setDisabled(true);
					this.app.workspace.trigger("smart-vault:pause");
				});
			});
		}
	}
}
