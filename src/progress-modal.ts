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

	// 拖拽移动（用户拍板"这个窗口支持移动"）：按住卡片任意空白处拖动，
	// 交互元素（按钮/输入）不触发。偏移走 translate 叠加，关窗复位。
	private dragOffset = { x: 0, y: 0 };
	private detachDrag: (() => void) | null = null;

	/** 覆盖率口径提供方（DB 已索引 / vault 应索引总数），由宿主注入。
	 *  弹窗曾显示追踪器的「本轮队列」口径——增量扫描 801 个未变更文件
	 *  就 801/801(100%)，与 RAG 卡的库覆盖率 81.7% 对不上（用户反馈）。 */
	private coverage?: () => Promise<{ indexed: number; total: number }>;
	private lastCoverageAt = 0;
	private coverageIndexed = 0;
	private coverageTotal = 0;
	private coverageTimer: number | null = null;

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

	constructor(
		app: App,
		progress: ProgressTracker,
		coverage?: () => Promise<{ indexed: number; total: number }>,
		/** 覆盖率首帧播种：DB 首查（常败于 worker 繁忙）到达前先直出快照，
		 *  不再显示 0/0（用户拍板"这个数值能不能加实时缓存"）。 */
		seed?: { indexed: number; total: number },
	) {
		super(app);
		this.progress = progress;
		this.coverage = coverage;
		if (seed) {
			this.coverageIndexed = seed.indexed;
			this.coverageTotal = seed.total;
		}
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
		// 覆盖率首查（进度事件到来前就显示真实库覆盖进度）
		void this.refreshCoverage();
		// [分母活性] 覆盖率不能只挂进度事件——扫描/空闲阶段几乎没有事件，
		// 文件增删后分母会冻在开窗时的旧值（真机 2026-11-12：设置页总数
		// 983 vs 弹窗 984，两处同读 countIndexableNotes 只是读到不同时刻）。
		// 开窗期间 2s 一拉：分母走主线程文件遍历（零 DB 依赖），分子 COUNT
		// 在部分索引 idx_chunks_path_active_vec 下已不再全表扫；refreshCoverage
		// 自带 ≥1s 节流且置戳先于 await，与事件驱动路径天然去重不叠加。
		this.coverageTimer = window.setInterval(() => void this.refreshCoverage(), 2000);
		this.attachDrag();
	}

	/** 拖拽移动（用户拍板"这个窗口支持移动"）：pointerdown 落在卡片空白
	 *  处（非按钮/输入）即可拖，translate 叠加偏移；window 级 move/up
	 *  保证指针拖出卡外也不丢事件。关窗复位偏移并解绑。 */
	private attachDrag(): void {
		const modal = this.modalEl;
		modal.addClass("is-draggable");
		let dragging = false;
		let startX = 0;
		let startY = 0;
		let baseX = 0;
		let baseY = 0;
		const onDown = (e: PointerEvent): void => {
			if ((e.target as HTMLElement).closest("button, input, textarea, select, a, .btn-group")) return;
			dragging = true;
			startX = e.clientX;
			startY = e.clientY;
			baseX = this.dragOffset.x;
			baseY = this.dragOffset.y;
			modal.addClass("is-dragging");
			e.preventDefault();
		};
		const onMove = (e: PointerEvent): void => {
			if (!dragging) return;
			this.dragOffset.x = baseX + (e.clientX - startX);
			this.dragOffset.y = baseY + (e.clientY - startY);
			modal.style.transform = `translate(${this.dragOffset.x}px, ${this.dragOffset.y}px)`;
		};
		const onUp = (): void => {
			dragging = false;
			modal.removeClass("is-dragging");
		};
		modal.addEventListener("pointerdown", onDown);
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		this.detachDrag = (): void => {
			modal.removeEventListener("pointerdown", onDown);
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
	}

	/** 节流拉取覆盖率（≥1s 一次），成功后立即重绘统计行。失败静默——
	 *  下个进度事件会再试。 */
	private async refreshCoverage(): Promise<void> {
		if (!this.coverage) return;
		const now = Date.now();
		if (now - this.lastCoverageAt < 1000) return;
		this.lastCoverageAt = now;
		try {
			const cov = await this.coverage();
			this.coverageIndexed = cov.indexed;
			this.coverageTotal = cov.total;
			this.renderInfo(this.progress.current);
		} catch { /* worker 忙碌时下个事件再试 */ }
	}

	onClose() {
		if (this.coverageTimer !== null) {
			window.clearInterval(this.coverageTimer);
			this.coverageTimer = null;
		}
		this.detachDrag?.();
		this.dragOffset = { x: 0, y: 0 };
		this.modalEl.style.removeProperty("transform");
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

		// Stats：覆盖率口径（与 RAG 卡一致）——DB 已索引 / vault 应索引
		// 总数。注入了 coverage 提供方时每个进度事件节流重查（≥1s）；
		// 分子百分比仍钳制不越界。未注入时退回本轮队列口径（同样钳制）。
		if (this.coverage) {
			void this.refreshCoverage();
			const denom = Math.max(0, this.coverageTotal);
			const numer = denom > 0 ? Math.min(this.coverageIndexed, denom) : this.coverageIndexed;
			const pct = denom > 0 ? (numer / denom) * 100 : 0;
			this.statsEl.textContent = `${numer.toLocaleString()} / ${denom.toLocaleString()} (${pct.toFixed(1)}%)`;
		} else {
			const denom = Math.max(0, p.totalNotes);
			const numer = denom > 0 ? Math.min(p.processedNotes, denom) : p.processedNotes;
			const pct = denom > 0 ? (numer / denom) * 100 : 0;
			this.statsEl.textContent = `${numer.toLocaleString()} / ${denom.toLocaleString()} (${pct.toFixed(1)}%)`;
		}

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
			// 让路倒计时（用户拍板「等待操作的倒计时在这上面打出来」）：
			// ⏳Ns = 距离自动续跑还差几秒（期间再操作会重新计时）。
			if (p.isAutoPaused && p.waitMs > 0) {
				networkText += ` ⏳${Math.ceil(p.waitMs / 1000)}s`;
			}
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
