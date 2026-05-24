// ========================================
// Smart Vault MCP - Index Scheduler
// ========================================

import { App, Vault, TFile } from "obsidian";
import type { SmartVaultSettings, QueueAction } from "./types";
import { VectorStore } from "./vector-store";
import { IndexQueue } from "./index-queue";
import { EmbeddingClient } from "./embedding-client";
import { ProgressTracker } from "./progress";
import { chunkMarkdown, makePreview } from "./chunker";

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
	private saveInterval = 50; // 每处理 N 个笔记存盘一次
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

		this.progress.setTotalNotes(filteredFiles.length);

		const items: Array<{ notePath: string; action: QueueAction; priority: number }> = [];

		for (const file of filteredFiles) {
			const storedMtime = this.store.getNoteMtime(file.path);
			if (storedMtime === null) {
				// New file
				items.push({ notePath: file.path, action: "add", priority: 2 });
			} else if (file.stat.mtime > storedMtime) {
				// Modified file
				items.push({ notePath: file.path, action: "update", priority: 3 });
			} else {
				// Unchanged
				this.progress.incrementSkipped();
			}
		}

		this.queue.enqueueMany(items);
		this.progress.incrementProcessed(0); // trigger UI update
		console.log(`[SmartVault] Scan complete: ${items.length} files to index, ${this.progress.current.skippedChunks} unchanged`);
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

		try {
			// If queue is empty and scan requested, do a full scan first
			if (scan && this.queue.pendingCount === 0) {
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
					// No more items
					break;
				}

				// Group by note for efficient processing
				const byNote = this.groupByNote(batch);
				const noteEntries = Array.from(byNote.entries());

				// Process notes concurrently
				await this.processConcurrently(noteEntries);

				// Periodic save
				this.maybeSave();
			}

			if (!this.aborted) {
				this.progress.complete();
				this.store.save();
			}
		} finally {
			this.running = false;
		}
	}

	/** Process a single note's queue items */
	private async processNote(notePath: string, items: any[]): Promise<void> {
		const file = this.vault.getAbstractFileByPath(notePath);
		if (!file || !(file instanceof TFile)) {
			// File deleted
			this.store.deleteChunksByNotePath(notePath);
			return;
		}

		const action = items[0]?.action || "add";
		const content = await this.vault.read(file);
		const mtime = file.stat.mtime;

		// For updates: mark old chunks as stale
		if (action === "update") {
			this.store.markChunksStale(notePath);
		}

		// Chunk the note
		this.progress.setPhase("chunking");
		const chunks = chunkMarkdown(content, notePath, this.settings.chunkSize, this.settings.chunkOverlap);

		if (chunks.length === 0) return;

		// Embed the chunks
		this.progress.setPhase("embedding");
		this.progress.setNetworkStatus(this.client.networkStatus);

		const texts = chunks.map((c) => c.content);
		const embedResult = await this.client.embedAll(texts);
		// Flatten batched embeddings into a single array matching chunks order
		const allEmbeddings: number[][] = [];
		for (const batch of embedResult.embeddings) {
			allEmbeddings.push(...batch);
		}

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

		// Save embeddings (UPDATE chunks SET vector_offset = ... WHERE id = ?)
		this.store.saveEmbeddings(chunkIds, allEmbeddings);

		// Delete stale chunks for this note (if update)
		if (action === "update") {
			this.store.deleteStaleChunks(notePath);
		}

		this.progress.incrementEmbedded(chunks.length);
		this.progress.setAvgResponseMs(this.client.avgResponseMs);

		// Update stats
		const stats = this.store.getStats();
		this.progress.setDbSizeMb(stats.dbSizeMb);
	}

	/** Process multiple notes concurrently with limited parallelism */
	private async processConcurrently(noteEntries: [string, any[]][]): Promise<void> {
		const results = new Array(noteEntries.length);

		// Process in chunks of concurrency
		for (let i = 0; i < noteEntries.length; i += this.concurrency) {
			if (this.aborted) break;

			const chunk = noteEntries.slice(i, i + this.concurrency);
			const promises = chunk.map(([notePath, items]) =>
				this.processNoteSafe(notePath, items)
			);

			await Promise.all(promises);
		}
	}

	/** Process a single note with error handling (for concurrent use) */
	private async processNoteSafe(notePath: string, items: any[]): Promise<void> {
		this.progress.setCurrentFile(notePath);

		try {
			await this.processNote(notePath, items);
			// Mark queue items as completed
			for (const item of items) {
				if (item.id != null) this.queue.complete(item.id);
			}
			this.progress.incrementProcessed();
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			console.error(`[SmartVault] Error processing ${notePath}:`, msg);

			for (const item of items) {
				if (item.id != null) this.queue.fail(item.id, msg);
			}
			this.progress.incrementFailed(items.length);
			this.progress.setConsecutiveFailures(this.client.consecutiveFailures);
			this.progress.setNetworkStatus(this.client.networkStatus);
		}
	}

	/** Save only every N notes to reduce disk I/O */
	private maybeSave(): void {
		this.processedSinceSave++;
		if (this.processedSinceSave >= this.saveInterval) {
			this.store.save();
			this.processedSinceSave = 0;
		}
	}

	/** Enqueue a single file for indexing (from watcher) */
	enqueueFile(notePath: string, action: QueueAction): void {
		this.queue.enqueue(notePath, action, action === "update" ? 3 : 2);
	}

	/**
	 * Run incremental indexing: only process items already in the queue.
	 * Does NOT scan the vault. Used by the watcher for file change events.
	 */
	runIncremental(): void {
		this.run(false);
	}

	/** Pause indexing */
	pause(): void {
		this.progress.setPaused(true);
		this.aborted = true;
	}

	/** Resume indexing */
	resume(): void {
		this.client.forceResume();
		this.progress.setPaused(false);
		this.progress.setNetworkStatus("healthy");
		this.aborted = false;
		// Restart the run loop
		this.run();
	}

	/** Abort indexing completely */
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
}
