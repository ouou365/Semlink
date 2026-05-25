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
	private container: HTMLElement;

	constructor(app: App, progress: ProgressTracker) {
		super(app);
		this.progress = progress;
		this.modalEl.addClass("smart-vault-progress-modal");
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: t("progressTitle") });

		this.container = contentEl.createDiv();
		this.render(this.progress.current);

		// Subscribe to progress updates
		this.unsubscribe = this.progress.onProgress((event) => {
			if (event.type === "progress") {
				this.render(event.progress);
			}
		});
	}

	onClose() {
		this.unsubscribe?.();
		this.contentEl.empty();
	}

	private render(p: IndexProgress) {
		this.container.empty();

		// Phase indicator
		const phaseNames: Record<string, string> = {
			idle: t("phaseIdle"),
			scanning: t("phaseScanning"),
			chunking: t("phaseChunking"),
			embedding: t("phaseEmbedding"),
			building_index: t("phaseBuilding"),
			completed: t("phaseCompleted"),
		};

		this.container.createEl("p", {
			text: `${t("phaseCurrent")}: ${phaseNames[p.phase] || p.phase}`,
			cls: "progress-phase",
		});

		// Progress bar
		const pct = p.totalNotes > 0 ? (p.processedNotes / p.totalNotes) * 100 : 0;
		const barContainer = this.container.createDiv({ cls: "progress-bar-container" });
		const barFill = barContainer.createDiv({ cls: "progress-bar-fill" });
		barFill.style.width = `${Math.min(100, pct)}%`;

		const statsLine = this.container.createDiv({ cls: "progress-stats" });
		statsLine.createSpan({
			text: `${p.processedNotes.toLocaleString()} / ${p.totalNotes.toLocaleString()} (${pct.toFixed(1)}%)`,
		});
		statsLine.createSpan({
			text: `${t("etaRemaining")}: ${ProgressTracker.formatEta(p.estimatedRemainingSec)}`,
		});

		// Detail grid
		const details = this.container.createDiv({ cls: "detail-grid" });

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
		const networkDiv = this.container.createDiv({ cls: "network-status" });
		const statusColors: Record<string, string> = {
			healthy: t("networkHealthy"),
			degraded: t("networkDegraded"),
			paused: t("networkPaused"),
		};
		networkDiv.createSpan({ text: `${t("networkLabel")} ${statusColors[p.networkStatus] || p.networkStatus}` });

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

		// Buttons
		const btnGroup = this.container.createDiv({ cls: "btn-group" });

		if (p.isPaused || p.phase === "idle") {
			new Setting(btnGroup).addButton((btn) =>
				btn.setButtonText(t("btnResume")).onClick(() => {
					this.app.workspace.trigger("smart-vault:resume");
				})
			);
		} else if (p.phase !== "completed" && p.phase !== "idle" as string) {
			new Setting(btnGroup).addButton((btn) =>
				btn.setButtonText(t("btnPause")).onClick(() => {
					this.app.workspace.trigger("smart-vault:pause");
				})
			);
		}
	}
}
