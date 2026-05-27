// ========================================
// Semlink - Index Scheduler
// ========================================

import { App, Vault, TFile, Notice } from "obsidian";
import type { SmartVaultSettings, QueueAction } from "./types";
import { VectorStore } from "./vector-store";
import { IndexQueue } from "./index-queue";
import { EmbeddingClient } from "./embedding-client";
import { ProgressTracker } from "./progress";
import { chunkMarkdown, makePreview } from "./chunker";
import { t } from "./i18n";

export class Scheduler {
	private app: App;
	private vault: Vault;
	private store: VectorStore;
	private queue: IndexQueue;
	private client: EmbeddingClient;
	private progress: ProgressTracker;
	private settings: SmartVaultSettings;

	private running = false;
	private aborted = false;
	private concurrency = 5; // 并发 embedding 请求数
	private saveInterval = 10; // 每处理 N 个笔记存盘一次
	private processedSinceSave = 0;

	constructor(
		app: App,
		store: VectorStore,
		queue: IndexQueue,
		client: EmbeddingClient,
		progress: ProgressTracker,
		settings: SmartVaultSettings,
	) {
		this.app = app;
		this.vault = app.vault;
		this.store = store;
		this.queue = queue;
		this.client = client;
		this.progress = progress;
		this.settings = settings;
	}

	updateSettings(settings: SmartVaultSettings) {
		this.settings = settings;
		this.client.updateSettings(settings);
	}

	get isRunning(): boolean {
		return this.running;
	}

	/** Full vault scan: enqueue all markdown files for indexing */
	async scanVault(): Promise<void> {
		this.progress.setPhase("scanning");

		const files = this.vault.getMarkdownFiles();
		const excludePatterns = this.settings.excludePaths
			.split("\n")
			.map((p) => p.trim())
			.filter((p) => p.length > 0);

		const filteredFiles = files.filter((f) => !this.isExcluded(f.path, excludePatterns));

		const items: Array<{ notePath: string; action: QueueAction; priority: number }> = [];
		let alreadyIndexed = 0;

		for (let fi = 0; fi < filteredFiles.length; fi++) {
			const file = filteredFiles[fi];
			// Skip empty files — they produce no chunks and would never be counted
			if (file.stat.size === 0) continue;

			const storedMtime = this.store.getNoteMtime(file.path);
			if (storedMtime === null) {
				// New file
				items.push({ notePath: file.path, action: "add", priority: 2 });
			} else if (file.stat.mtime > storedMtime) {
				// Modified file
				items.push({ notePath: file.path, action: "update", priority: 3 });
			} else {
				// Unchanged - already indexed
				alreadyIndexed++;
			}
			// Yield every 200 files to keep UI responsive
			if (fi > 0 && fi % 200 === 0) {
				await this.yieldControl();
			}
		}

		// totalNotes = already indexed + to be indexed (excluding empty files)
		this.progress.setTotalNotes(alreadyIndexed + items.length);

		// Restore processed count from already-indexed notes
		this.progress.current.processedNotes = alreadyIndexed;
		this.progress.current.skippedChunks = alreadyIndexed;

		this.queue.enqueueMany(items);
		this.progress.incrementProcessed(0); // trigger UI update
		console.log(`[Semlink] Scan complete: ${items.length} files to index, ${alreadyIndexed} unchanged`);
	}

	/**
	 * Run the main indexing loop.
	 * If scan=true, performs a full vault scan first to find new/modified files.
	 * If scan=false (incremental), only processes items already in the queue.
	 */
	async run(scan = true): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.aborted = false;
		this.authErrorShown = false;

		try {
			// Always scan to set totalNotes count, even if queue has items
			if (scan) {
				await this.scanVault();
			}

			this.progress.setPhase("embedding");

			while (!this.aborted) {
				// Check pause state
				if (this.client.isAutoPaused) {
					this.progress.setPaused(true, true);
					this.progress.setNetworkStatus("paused");
					this.progress.setBackoffRemaining(this.client.backoffRemainingSec);

					// Wait for backoff to expire or manual resume
					await this.waitForBackoff();
					if (this.aborted) break;

					this.progress.setPaused(false);
					this.progress.setNetworkStatus("healthy");
				}

				// Dequeue next batch
				const batch = this.queue.dequeue(this.settings.batchSize);
				if (batch.length === 0) {
					// Queue empty — flush any remaining unsaved notes (tail < saveInterval)
					this.flushSave();
					break;
				}

				// Yield after synchronous dequeue to keep UI responsive
				await this.yieldControl();

				// Group by note for efficient processing
				const byNote = this.groupByNote(batch);
				const noteEntries = Array.from(byNote.entries());

				// Process notes concurrently
				await this.processConcurrently(noteEntries);
			}

			if (!this.aborted) {
				this.progress.complete();
			}
		} finally {
			// Always save on loop exit (normal completion, pause, or abort)
			this.store.save();
			this.running = false;
		}
	}

	/** Process a single note's queue items. Returns true if chunks were actually indexed. */
	private async processNote(notePath: string, items: any[]): Promise<boolean> {
		const file = this.vault.getAbstractFileByPath(notePath);
		if (!file || !(file instanceof TFile)) {
			// File deleted
			this.store.deleteChunksByNotePath(notePath);
			return false;
		}

		const action = items[0]?.action || "add";
		const content = await this.vault.read(file);
		const mtime = file.stat.mtime;

		// For updates: mark old chunks as stale
		if (action === "update") {
			this.store.markChunksStale(notePath);
		}

		// Chunk the note (sync but usually fast)
		this.progress.setPhase("chunking");
		const chunks = chunkMarkdown(content, notePath, this.settings.chunkSize, this.settings.chunkOverlap);

		if (chunks.length === 0) return false;

		// Embed the chunks (async network call — yields naturally)
		this.progress.setPhase("embedding");
		this.progress.setNetworkStatus(this.client.networkStatus);

		const texts = chunks.map((c) => c.content);
		const embedResult = await this.client.embedAll(texts, (batchIdx, totalBatches) => {
			this.progress.setFileChunkProgress(`${batchIdx + 1}/${totalBatches}`);
		});
		// Flatten batched embeddings into a single array matching chunks order
		const allEmbeddings: number[][] = [];
		for (const batch of embedResult.embeddings) {
			allEmbeddings.push(...batch);
		}

		// Wrap all DB writes for this note in a single transaction
		// IMPORTANT: do NOT yield before DB writes — if close() fires during yield,
		// the in-memory DB won't contain this note's data and it will be lost.
		this.store.beginTransaction();
		try {
			// Insert chunk metadata first (so UPDATE in saveEmbeddings can find them)
			const chunkIds = chunks.map((c) => c.id);
			const now = Date.now();
			for (let i = 0; i < chunks.length; i++) {
				this.store.insertChunk({
					id: chunks[i].id,
					notePath,
					heading: chunks[i].heading,
					content: chunks[i].content,
					contentPreview: makePreview(chunks[i].content),
					mtime,
					status: "active",
					embedding: null, // stored in binary file
					createdAt: now,
				});
			}

			// Save embeddings (UPDATE chunks SET vector = ... WHERE id = ?)
			this.store.saveEmbeddings(chunkIds, allEmbeddings);

			// Delete stale chunks for this note (if update)
			if (action === "update") {
				this.store.deleteStaleChunks(notePath);
			}

			this.store.commitTransaction();
		} catch (e) {
			this.store.rollbackTransaction();
			throw e;
		}

		// Yield AFTER DB writes — data is now in the in-memory DB,
		// so close()/save() will capture it even if Obsidian exits during yield
		await this.yieldControl();

		this.progress.incrementEmbedded(chunks.length);
		this.progress.setAvgResponseMs(this.client.avgResponseMs);
		this.progress.setFileChunkProgress("");
		return true;
	}

	/** Process multiple notes concurrently with limited parallelism */
	private async processConcurrently(noteEntries: [string, any[]][]): Promise<void> {
		// Process in chunks of concurrency
		for (let i = 0; i < noteEntries.length; i += this.concurrency) {
			if (this.aborted) break;

			const chunk = noteEntries.slice(i, i + this.concurrency);
			const promises = chunk.map(([notePath, items]) =>
				this.processNoteSafe(notePath, items)
			);

			await Promise.all(promises);
			// Yield to the browser so scrolling/rendering can happen between batches
			await this.yieldControl();
		}
	}

	/** Process a single note with error handling (for concurrent use) */
	private async processNoteSafe(notePath: string, items: any[]): Promise<void> {
		this.progress.setCurrentFile(notePath);

		try {
			const indexed = await this.processNote(notePath, items);
			// Mark queue items as completed
			for (const item of items) {
				if (item.id != null) this.queue.complete(item.id);
			}
			// Only count notes that actually produced chunks
			if (indexed) {
				this.progress.incrementProcessed();
				// Periodic async save — counted per note, not per batch
				await this.maybeSaveAsync();
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			const status = (error as any)?.status;
			console.error(`[Semlink] Error processing ${notePath}:`, msg);

			for (const item of items) {
				if (item.id != null) this.queue.fail(item.id, msg);
			}
			this.progress.incrementFailed(items.length);
			this.progress.setConsecutiveFailures(this.client.consecutiveFailures);
			this.progress.setNetworkStatus(this.client.networkStatus);

			// Detect authentication errors (missing key, 401, 403)
			if (
				msg.includes("API key not configured") ||
				status === 401 ||
				status === 403 ||
				(typeof msg === "string" && msg.toLowerCase().includes("unauthorized"))
			) {
				this.handleAuthError();
			}
		}
	}

	/** Handle API key authentication errors: show Notice, set error, and abort */
	private authErrorShown = false;
	private handleAuthError() {
		this.progress.setLastError(t("errorAuthFailed"));
		if (!this.authErrorShown) {
			this.authErrorShown = true;
			new Notice(`Semlink: ${t("noticeAuthFailed")}`, 8000);
		}
		// Abort the indexing loop — no point retrying without a valid key
		this.aborted = true;
		this.progress.setPaused(true);
		this.progress.setNetworkStatus("paused");
	}

	/** Periodic save with yield: yields before the sync save to let the browser breathe */
	private async maybeSaveAsync(): Promise<void> {
		this.processedSinceSave++;
		if (this.processedSinceSave >= this.saveInterval) {
			await this.yieldControl();
			this.store.save();
			const stats = this.store.getStats();
			this.progress.setDbSizeMb(stats.dbSizeMb);
			this.processedSinceSave = 0;
		}
	}

	/** Flush any remaining unsaved notes to disk (called when queue is empty) */
	private flushSave(): void {
		if (this.processedSinceSave > 0) {
			this.store.save();
			this.processedSinceSave = 0;
		}
	}

	/** Enqueue a single file for indexing (from watcher) */
	enqueueFile(notePath: string, action: QueueAction): void {
		this.queue.enqueue(notePath, action, action === "update" ? 3 : 2);
	}

	/** Rename a note's path in the index without re-embedding (from watcher) */
	renamePath(oldPath: string, newPath: string): void {
		this.store.renameNotePath(oldPath, newPath);
	}

	/**
	 * Run incremental indexing: only process items already in the queue.
	 * Does NOT scan the vault. Used by the watcher for file change events.
	 */
	runIncremental(): void {
		this.run(false);
	}

	/** Pause indexing (synchronous — run() finally block handles save) */
	pause(): void {
		this.progress.setPaused(true);
		this.aborted = true;
	}

	/** Resume indexing from where it was paused */
	resume(): void {
		this.client.forceResume();
		this.progress.setPaused(false);
		this.progress.setNetworkStatus("healthy");
		this.aborted = false;
		// Re-scan to restore totalNotes and already-indexed count, then continue
		this.run(true);
	}

	/** Abort indexing — synchronous, caller must call store.save()/close() to persist */
	abort(): void {
		this.aborted = true;
		this.progress.setPhase("idle");
		this.progress.setPaused(false);
	}

	/** Wait for auto-pause backoff to expire */
	private waitForBackoff(): Promise<void> {
		return new Promise((resolve) => {
			const check = () => {
				if (this.aborted) {
					resolve();
					return;
				}
				if (!this.client.isAutoPaused || Date.now() >= this.client.backoffUntil) {
					resolve();
					return;
				}
				this.progress.setBackoffRemaining(this.client.backoffRemainingSec);
				setTimeout(check, 1000);
			};
			check();
		});
	}

	private groupByNote(items: any[]): Map<string, any[]> {
		const map = new Map<string, any[]>();
		for (const item of items) {
			if (!map.has(item.notePath)) {
				map.set(item.notePath, []);
			}
			map.get(item.notePath)!.push(item);
		}
		return map;
	}

	private isExcluded(path: string, patterns: string[]): boolean {
		for (const pattern of patterns) {
			if (path.startsWith(pattern) || path.includes(pattern)) {
				return true;
			}
		}
		return false;
	}

	/** Yield control to the browser so UI events (scroll, render) can be handled */
	private yieldControl(): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, 0));
	}
}
