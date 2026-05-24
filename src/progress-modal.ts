// ========================================
// Semlink - Progress Modal
// ========================================

import { App, Modal, Setting } from "obsidian";
import type { IndexProgress } from "./types";
import { ProgressTracker } from "./progress";

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
		contentEl.createEl("h2", { text: "Semlink 索引进度" });

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
			idle: "空闲",
			scanning: "扫描文件",
			chunking: "文本分块",
			embedding: "嵌入向量",
			building_index: "构建索引",
			completed: "完成",
		};

		this.container.createEl("p", {
			text: `当前阶段: ${phaseNames[p.phase] || p.phase}`,
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
			text: `预计剩余: ${ProgressTracker.formatEta(p.estimatedRemainingSec)}`,
		});

		// Detail grid
		const details = this.container.createDiv({ cls: "detail-grid" });

		const addItem = (label: string, value: string) => {
			details.createSpan({ text: label, cls: "label" });
			details.createSpan({ text: value, cls: "value" });
		};

		addItem("已嵌入 chunks:", p.embeddedChunks.toLocaleString());
		addItem("失败:", String(p.failedChunks));
		addItem("跳过(未变更):", p.skippedChunks.toLocaleString());
		addItem("当前文件:", p.currentFile || "-");
		addItem("平均响应:", `${p.avgResponseMs}ms`);

		// Network status
		const networkDiv = this.container.createDiv({ cls: "network-status" });
		const statusColors: Record<string, string> = {
			healthy: "🟢 正常",
			degraded: "🟡 降速",
			paused: "🔴 已暂停",
		};
		networkDiv.createSpan({ text: `网络: ${statusColors[p.networkStatus] || p.networkStatus}` });

		if (p.isPaused) {
			networkDiv.createSpan({
				text: p.isAutoPaused ? "(自动暂停)" : "(手动暂停)",
			});
		}

		if (p.consecutiveFailures > 0) {
			networkDiv.createSpan({
				text: `连续失败: ${p.consecutiveFailures}`,
			});
		}

		if (p.backoffRemainingSec > 0) {
			networkDiv.createSpan({
				text: `退避剩余: ${p.backoffRemainingSec}s`,
			});
		}

		// Buttons
		const btnGroup = this.container.createDiv({ cls: "btn-group" });

		if (p.isPaused || p.phase === "idle") {
			new Setting(btnGroup).addButton((btn) =>
				btn.setButtonText("▶ 恢复索引").onClick(() => {
					// Trigger resume through the plugin
					this.app.workspace.trigger("smart-vault:resume");
				})
			);
		} else if (p.phase !== "completed" && p.phase !== "idle" as string) {
			new Setting(btnGroup).addButton((btn) =>
				btn.setButtonText("⏸ 暂停索引").onClick(() => {
					this.app.workspace.trigger("smart-vault:pause");
				})
			);
		}
	}
}
