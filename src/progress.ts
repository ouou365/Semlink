// ========================================
// Semlink - Progress Tracker
// ========================================

import type { IndexProgress, ProgressEvent, ProgressCallback, IndexPhase, NetworkStatus } from "./types";
import { EMPTY_PROGRESS } from "./types";

export class ProgressTracker {
	private progress: IndexProgress;
	private listeners: Set<ProgressCallback> = new Set();
	private speedSamples: number[] = [];
	private rafId: number | null = null;

	constructor() {
		this.progress = { ...EMPTY_PROGRESS };
	}

	get current(): Readonly<IndexProgress> {
		return this.progress;
	}

	onProgress(cb: ProgressCallback): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	private emit(event: ProgressEvent) {
		for (const cb of this.listeners) {
			try { cb(event); } catch (e) { /* ignore */ }
		}
	}

	/** Force immediate synchronous emit of current progress (used for critical state changes) */
	flush() {
		if (this.rafId != null) {
			cancelAnimationFrame(this.rafId);
			this.rafId = null;
		}
		this.emit({ type: "progress", progress: { ...this.progress } });
	}

	// ──── Phase management ────

	setPhase(phase: IndexPhase) {
		const prev = this.progress.phase;
		this.progress.phase = phase;
		if (phase !== "idle" && phase !== "completed" && this.progress.startedAt === 0) {
			this.progress.startedAt = Date.now();
		}
		this.emit({ type: "phase_change", phase });
		this.emitProgress();
	}

	reset() {
		this.progress = { ...EMPTY_PROGRESS };
		this.speedSamples = [];
		this.flush(); // ensure reset state is rendered immediately
	}

	// ──── Counters ────

	/** Sync existing store stats so progress modal shows current data when idle */
	initFromStats(indexedNotes: number, activeChunks: number, totalNotes: number) {
		this.progress.processedNotes = indexedNotes;
		this.progress.embeddedChunks = activeChunks;
		this.progress.totalNotes = totalNotes;
		this.emitProgress();
	}

	setTotalNotes(n: number) {
		this.progress.totalNotes = n;
		this.emitProgress();
	}

	incrementProcessed(n = 1) {
		this.progress.processedNotes += n;
		this.emitProgress();
	}

	setTotalChunks(n: number) {
		this.progress.totalChunks = n;
		this.emitProgress();
	}

	incrementEmbedded(n = 1) {
		this.progress.embeddedChunks += n;
		this.updateEta();
		this.emitProgress();
	}

	incrementFailed(n = 1) {
		this.progress.failedChunks += n;
		this.emitProgress();
	}

	incrementSkipped(n = 1) {
		this.progress.skippedChunks += n;
		this.emitProgress();
	}

	setCurrentFile(file: string) {
		this.progress.currentFile = file;
		this.emitProgress();
	}

	setHnswNodeCount(n: number) {
		this.progress.hnswNodeCount = n;
		this.emitProgress();
	}

	setDbSizeMb(mb: number) {
		this.progress.dbSizeMb = mb;
		this.emitProgress();
	}

	// ──── Network health ────

	setNetworkStatus(status: NetworkStatus) {
		this.progress.networkStatus = status;
		this.emit({ type: "network_change", status });
		this.emitProgress();
	}

	setConsecutiveFailures(n: number) {
		this.progress.consecutiveFailures = n;
		this.emitProgress();
	}

	setBackoffRemaining(sec: number) {
		this.progress.backoffRemainingSec = sec;
		this.emitProgress();
	}

	setAvgResponseMs(ms: number) {
		this.progress.avgResponseMs = ms;
		// Track speed sample for ETA
		this.speedSamples.push(ms);
		if (this.speedSamples.length > 100) this.speedSamples.shift();
		this.emitProgress();
	}

	setLastError(msg: string) {
		this.progress.lastError = msg;
		this.emitProgress();
	}

	setFileChunkProgress(progress: string) {
		this.progress.fileChunkProgress = progress;
		this.emitProgress();
	}

	// ──── Pause/Resume ────

	setPaused(isPaused: boolean, isAuto = false) {
		this.progress.isPaused = isPaused;
		this.progress.isAutoPaused = isAuto;
		this.emit(isPaused ? { type: "pause" } : { type: "resume" });
		this.emitProgress();
	}

	// ──── ETA calculation ────

	private updateEta() {
		if (this.speedSamples.length < 3) return;

		const remaining = this.progress.totalChunks - this.progress.embeddedChunks;
		if (remaining <= 0) {
			this.progress.estimatedRemainingSec = 0;
			return;
		}

		// Weighted average speed (recent samples weighted more)
		const weights = this.speedSamples.map((_, i) => i + 1);
		const totalWeight = weights.reduce((a, b) => a + b, 0);
		const avgMs = this.speedSamples.reduce((s, ms, i) => s + ms * weights[i], 0) / totalWeight;

		// Assume avg batch size
		const avgBatchSize = 64;
		const batchesRemaining = Math.ceil(remaining / avgBatchSize);
		const etaMs = batchesRemaining * (avgMs + 200); // 200ms delay between batches
		this.progress.estimatedRemainingSec = Math.round(etaMs / 1000);
	}

	// ──── Completion ────

	complete() {
		this.progress.phase = "completed";
		this.progress.currentFile = "";
		// Sync totalNotes to match processedNotes — files may have been enqueued
		// by the watcher after scanVault set totalNotes, causing a mismatch.
		this.progress.totalNotes = this.progress.processedNotes;
		this.emit({ type: "complete" });
		this.flush(); // ensure final state is rendered immediately
	}

	error(msg: string) {
		this.emit({ type: "error", error: msg });
	}

	private emitProgress() {
		// Throttle via requestAnimationFrame — batch all mid-frame state changes
		// into a single UI update per frame (~60fps max).
		if (this.rafId == null) {
			this.rafId = requestAnimationFrame(() => {
				this.rafId = null;
				this.emit({ type: "progress", progress: { ...this.progress } });
			});
		}
	}

	// ──── Formatting helpers ────

	static formatEta(seconds: number): string {
		if (seconds <= 0) return "-";
		if (seconds < 60) return `${seconds}秒`;
		if (seconds < 3600) return `${Math.ceil(seconds / 60)}分钟`;
		return `${(seconds / 3600).toFixed(1)}小时`;
	}

	static formatPercent(current: number, total: number): string {
		if (total === 0) return "0%";
		return `${Math.round((current / total) * 100)}%`;
	}
}
