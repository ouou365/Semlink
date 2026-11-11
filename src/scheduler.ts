// ========================================
// Semlink - Index Scheduler
// ========================================

import { App, Vault, TFile, Notice } from "obsidian";
import { debugLog } from "./log";
import type { SmartVaultSettings, QueueAction, QueueItem } from "./types";
import { activeEmbeddingProvider } from "./types";
import { VectorStore } from "./vector-store";
import { IndexQueue } from "./index-queue";
import { EmbeddingClient } from "./embedding-client";
import { ProgressTracker } from "./progress";
import { ActivityGate } from "./activity-gate";
import { makePreview, isSparseContent } from "./chunker";
import { extractHeadings } from "./section-utils";
import { t } from "./i18n";

export class Scheduler {
	private app: App;
	private vault: Vault;
	private store: VectorStore;
	private queue: IndexQueue;
	private client: EmbeddingClient;
	private progress: ProgressTracker;
	private settings: SmartVaultSettings;
	/** When set, indexing yields to the user: batches pause while they're
	 *  actively working and resume after a quiet period. */
	private gate: ActivityGate | null;

	private running = false;
	private aborted = false;
	/** 并发嵌入请求数 — 设置页"嵌入参数"可调（默认 2）。串行(1) 对免费档
	 *  API 最稳；并发过高会触发 429 限流。 */
	private get concurrency(): number {
		return Math.max(1, this.settings.embedConcurrency ?? 2);
	}
	private saveInterval = 40; // 每处理 N 个笔记存盘一次（sync 模式下 save 是全量导出，代价很高）
	private lastSaveAt = 0; // 上次存盘时刻 — sync 模式下两次全量导出之间至少隔 20s
	private saveGapMs = 20000; // 当前两次存盘的最小间隔（慢导出自适应退避，见 maybeSaveAsync）
	private processedSinceSave = 0;
	/** Guards backfillDocVectors against concurrent runs (onload + manual index). */
	private backfilling = false;
	/** Serializes the per-note DB transaction section. Concurrent notes interleave
	 *  their BEGIN/COMMIT messages on the shared engine otherwise — the savepoint
	 *  depth counter then releases the WRONG note's savepoint, a failure rollback
	 *  wipes OTHER notes' writes, and a full rollback by one note leaves the rest
	 *  committing into autocommit mode ("cannot commit - no transaction is active").
	 *  Only the fast DB writes are serialized; the network embedding calls stay
	 *  parallel (they run before the transaction opens). */
	private txLock: Promise<void> = Promise.resolve();
	/** Note-count baseline for the current run. 0 = full scan (increment each
	 *  note); >0 = incremental run (only "add" actions raise the real total,
	 *  "update"/"delete" keep the status-bar count steady to avoid flicker). */
	private incrementalBase = 0;

	constructor(
		app: App,
		store: VectorStore,
		queue: IndexQueue,
		client: EmbeddingClient,
		progress: ProgressTracker,
		settings: SmartVaultSettings,
		gate: ActivityGate | null = null,
	) {
		this.app = app;
		this.vault = app.vault;
		this.store = store;
		this.queue = queue;
		this.client = client;
		this.progress = progress;
		this.settings = settings;
		this.gate = gate;
	}

	updateSettings(settings: SmartVaultSettings) {
		this.settings = settings;
		this.client.updateSettings(settings);
	}

	get isRunning(): boolean {
		return this.running;
	}

	/** 本次是否执行嵌入：嵌入模型已配置 且 自动嵌入开关打开。实时读取——
	 *  设置页翻转嵌入开关后，后续笔记立即按新状态处理，无需重启索引。 */
	private get embedActive(): boolean {
		return (this.settings.autoEmbed ?? true)
			&& activeEmbeddingProvider(this.settings).apiKey.trim() !== "";
	}

	/** Full vault scan: enqueue all markdown files for indexing */
	async scanVault(): Promise<void> {
		this.progress.setPhase("scanning");

		const files = this.vault.getMarkdownFiles();
		const excludePatterns = this.settings.excludePaths
			.split("\n")
			.map((p) => p.trim())
			.filter((p) => p.length > 0);
		// The Obsidian config folder is always skipped, even when renamed
		// away from the default ".obsidian" (the setting covers only the
		// default name).
		excludePatterns.push(this.vault.configDir);

		const filteredFiles = files.filter((f) => !this.isExcluded(f.path, excludePatterns));

		const items: Array<{ notePath: string; action: QueueAction; priority: number }> = [];
		let alreadyIndexed = 0;
		const existingPaths = new Set<string>();

		for (let fi = 0; fi < filteredFiles.length; fi++) {
			const file = filteredFiles[fi];
			// Skip empty files — they produce no chunks and would never be counted
			if (file.stat.size === 0) continue;

			existingPaths.add(file.path);

			const storedMtime = await this.store.getNoteMtime(file.path);
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
			// Yield every 200 files to keep UI responsive; also hold off the
			// scan itself while the user is actively working.
			if (fi > 0 && fi % 200 === 0) {
				await this.yieldControl();
				if (this.gate && !this.gate.isIdle()) {
					await this.waitForIdle();
				}
			}
		}

		// Prune "ghost" paths: chunks left over from files that were moved,
		// renamed, or deleted while the plugin (or its watcher) wasn't active.
		// Without this the DB grows unbounded (seen: 397MB→802MB after
		// reorganizing the vault) and search returns dead paths.
		const pruned = await this.store.pruneOrphanedPaths(existingPaths);
		if (pruned > 0) {
			debugLog(`[Semlink] Pruned ${pruned} orphaned note paths from index`);
		}

		// Queue hygiene: drop stale completed/failed rows from earlier runs and
		// ghost rows whose files no longer exist. Without this, repeated scans
		// re-process old entries and progress can exceed 100%.
		const cleaned = await this.store.cleanupQueue();
		const purged = await this.store.purgeGhostQueue(existingPaths);
		// 冗余 pending（迁移过渡把全量笔记当新增重入队、而库内 mtime 完好）
		// ——逐条比对 MAX(chunk.mtime) ≥ file.mtime 即删，否则 paused 里的
		// 索引器稍后处理它们会二次嵌入（embeddedChunks 曾涨到 73,030 >
		// 总块数 65,237）。每 200 条让出 UI。
		const pendingPaths = await this.queue.getPendingPaths();
		const redundant: Array<{ path: string; mtime: number }> = [];
		let pendingChecked = 0;
		for (const pendingPath of pendingPaths) {
			const file = this.vault.getAbstractFileByPath(pendingPath) as TFile | null;
			if (!file || !("stat" in file)) continue;
			const stored = await this.store.getNoteMtime(pendingPath);
			if (stored !== null && file.stat.mtime <= stored) {
				redundant.push({ path: pendingPath, mtime: file.stat.mtime });
			}
			if (++pendingChecked % 200 === 0) await this.yieldControl();
		}
		const redundantRemoved = redundant.length > 0
			? await this.store.purgeRedundantQueue(redundant)
			: 0;
		if (cleaned > 0 || purged > 0 || redundantRemoved > 0) {
			debugLog(`[Semlink] Queue cleanup: ${cleaned} stale + ${purged} ghost + ${redundantRemoved} redundant rows removed`);
		}

		// totalNotes = already indexed + to be indexed (excluding empty files)
		this.progress.setTotalNotes(alreadyIndexed + items.length);

		// Restore processed count from already-indexed notes
		this.progress.current.processedNotes = alreadyIndexed;
		this.progress.current.skippedChunks = alreadyIndexed;

		await this.queue.enqueueMany(items);
		this.progress.incrementProcessed(0); // trigger UI update
		debugLog(`[Semlink] Scan complete: ${items.length} files to index, ${alreadyIndexed} unchanged`);
	}

	/** In-scope note count without touching the DB or queue — a startup seed
	 *  so the RAG panel's 笔记总数/待索引 read correctly before the first scan
	 *  of the session. scanVault later overwrites with authoritative numbers. */
	countIndexableNotes(): number {
		const excludePatterns = this.settings.excludePaths
			.split("\n")
			.map((p) => p.trim())
			.filter((p) => p.length > 0);
		// The Obsidian config folder is always skipped (same rule as scanVault).
		excludePatterns.push(this.vault.configDir);
		return this.vault.getMarkdownFiles()
			.filter((f) => f.stat.size > 0 && !this.isExcluded(f.path, excludePatterns))
			.length;
	}

	/** 队列四计数（debug 工具读数用）：pending 持续增长 = 有东西在反复
	 *  入队，是「无新文档却一直索引」类问题的第一诊断信号。 */
	async queueCounts(): Promise<{ pending: number; processing: number; failed: number; completed: number }> {
		return this.queue.getCounts();
	}

	/** pending 队列 mtime 取样（debug 工具诊断用）：vault 文件 mtime vs
	 *  库内 chunk mtime 的差值——delta 以分钟计且巨大 = 外部工具批量摸
	 *  文件（mtime 被顶新）或库内 mtime 陈旧；delta≈0 = 刚被 watcher
	 *  入队的真实修改。前 2 条另做现算分块 vs 库存分块的逐块比对
	 *  （contentMatch），定位 update 短路为何未命中。 */
	async debugPendingMtimeSample(limit = 5): Promise<Array<{ path: string; vaultMtime: number | null; storedMtime: number | null; deltaMin: number | null; contentMatch?: { freshChunks: number; storedChunks: number; firstDiffIdx: number; freshLen: number; storedLen: number } }>> {
		const paths = await this.queue.getPendingPaths();
		const out: Array<{ path: string; vaultMtime: number | null; storedMtime: number | null; deltaMin: number | null; contentMatch?: { freshChunks: number; storedChunks: number; firstDiffIdx: number; freshLen: number; storedLen: number } }> = [];
		for (let i = 0; i < paths.length && i < limit; i++) {
			const p = paths[i];
			const f = this.vault.getAbstractFileByPath(p);
			const vaultMtime = f instanceof TFile ? f.stat.mtime : null;
			const storedMtime = await this.store.getNoteMtime(p);
			const row: out[number] = {
				path: p,
				vaultMtime,
				storedMtime,
				deltaMin: vaultMtime != null && storedMtime != null ? Math.round((vaultMtime - storedMtime) / 60000) : null,
			};
			// 前 2 条：重读文件现算分块，与库存块逐条比内容（只报首个差异
			// 索引与两侧长度——足以区分「参数变了」「分块算法变了」「内容变了」）
			if (i < 2 && f instanceof TFile) {
				try {
					const content = await this.vault.read(f);
					const fresh = await this.store.chunk(content, p, this.settings.chunkSize, this.settings.chunkOverlap);
					const stored = await this.store.getChunksByNotePath(p);
					let firstDiffIdx = -1;
					for (let k = 0; k < Math.min(fresh.length, stored.length); k++) {
						if (fresh[k].content !== stored[k].content) { firstDiffIdx = k; break; }
					}
					if (firstDiffIdx < 0 && fresh.length !== stored.length) firstDiffIdx = Math.min(fresh.length, stored.length);
					row.contentMatch = {
						freshChunks: fresh.length,
						storedChunks: stored.length,
						firstDiffIdx,
						freshLen: firstDiffIdx >= 0 && firstDiffIdx < fresh.length ? fresh[firstDiffIdx].content.length : -1,
						storedLen: firstDiffIdx >= 0 && firstDiffIdx < stored.length ? stored[firstDiffIdx].content.length : -1,
					};
				} catch { /* 诊断取样失败不阻塞主流程 */ }
			}
			out.push(row);
		}
		return out;
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

		// Revive rows stuck at 'processing' by an interrupted earlier run
		// (reload/crash mid-index): dequeue only takes 'pending' and enqueue
		// dedupes against 'processing', so without this the affected notes
		// would be re-scanned forever but never re-processed, freezing
		// progress at e.g. 788/865 with no errors logged.
		try {
			const revived = await this.store.reviveProcessing();
			if (revived > 0) {
				debugLog(`[Semlink] Revived ${revived} stuck 'processing' queue rows for re-processing`);
			}
		} catch (e) {
			console.warn("[Semlink] reviveProcessing failed:", e);
		}

		// In incremental mode (watcher-triggered), processedNotes carries the
		// stale total from the last full run. Processing a single "update"
		// would increment it (6016→6017) even though the note count didn't
		// change, causing the status bar to flicker. Snapshot the real DB
		// count up front so we can hold processedNotes steady for updates and
		// only bump it for genuine "add"s.
		// 嵌入与索引解耦：embedActive 是实时 getter（嵌入模型已配置且自动嵌入
		// 开关打开），每次取值都反映最新设置——运行中翻转开关也立即生效。
		this.incrementalBase = 0;
		if (!scan) {
			const stats = await this.store.getStats();
			this.incrementalBase = stats.indexedNotes;
			this.progress.initFromStats(stats.indexedNotes, stats.activeChunks, stats.indexedNotes);
		}

		try {
			// Always scan to set totalNotes count, even if queue has items
			if (scan) {
				await this.scanVault();
				// Backfill document-level vectors for notes indexed before this
				// feature existed. Only embeds heading text (1 call/note in a
				// single batch), so it's far cheaper than re-embedding chunks.
				// Runs once per full scan; a fast no-op when every note already
				// has a doc vector.
				if (this.embedActive) await this.backfillDocVectors();
			}

			this.progress.setPhase(this.embedActive ? "embedding" : "chunking");

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

				// Yield to the user: while they're actively working (clicking,
				// typing or scrolling within the last few seconds), hold off
				// indexing so the UI stays smooth; resume once they idle.
				if (this.gate && !this.gate.isIdle()) {
					this.progress.setPaused(true, true);
					await this.waitForIdle();
					if (this.aborted) break;
					this.progress.setPaused(false);
				}

				// Dequeue next batch
				const batch = await this.queue.dequeue(this.settings.batchSize);
				if (batch.length === 0) {
					// Queue empty — flush any remaining unsaved notes (tail < saveInterval)
					await this.flushSave();
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
				// For incremental runs (no scan), processedNotes was incremented per
				// file on top of a stale baseline — it no longer reflects the real
				// note count. Re-sync from the DB so the status bar shows the true
				// number instead of flickering (e.g. 6016 → 6017 → back).
				if (!scan) {
					const stats = await this.store.getStats();
					this.progress.initFromStats(stats.indexedNotes, stats.activeChunks, stats.indexedNotes);
				}
				this.progress.complete();
			}
		} finally {
			// Always save on loop exit (normal completion, pause, or abort)
			await this.store.save();
			this.running = false;
		}
	}

	/** Run `fn` while holding the transaction lock. Chains onto the previous
	 *  holder, so exactly one note's BEGIN..COMMIT is ever open at a time. */
	private async withTxLock<T>(fn: () => Promise<T>): Promise<T> {
		const prev = this.txLock;
		let release!: () => void;
		this.txLock = new Promise<void>((resolve) => (release = resolve));
		await prev;
		try {
			return await fn();
		} finally {
			release();
		}
	}

	/** Process a single note's queue items. Returns true if chunks were actually indexed. */
	private async processNote(notePath: string, items: QueueItem[]): Promise<boolean> {
		const file = this.vault.getAbstractFileByPath(notePath);
		if (!file || !(file instanceof TFile)) {
			// File deleted
			await this.store.deleteChunksByNotePath(notePath);
			return false;
		}

		const action = items[0]?.action || "add";
		const content = await this.vault.read(file);
		const mtime = file.stat.mtime;

		// Chunk the note — runs in the worker thread so large-file string
		// processing doesn't block the UI while typing.
		this.progress.setPhase("chunking");
		const chunks = await this.store.chunk(content, notePath, this.settings.chunkSize, this.settings.chunkOverlap);

		// 内容未变短路（先比对再标记 stale）：扫描只看 mtime——外部同步
		// 工具/系统批量摸文件（真机实测单次启动 902/1142 篇被判「已修改」）
		// 会把全部笔记送进重嵌管线。重分块后与库存块逐块比对，完全相同
		// 则只推 mtime 让扫描恢复 unchanged 判定，零 API 调用。
		if (action === "update" && chunks.length > 0) {
			const existing = await this.store.getChunksByNotePath(notePath);
			const identical = existing.length === chunks.length &&
				existing.every((c, i) => c.content === chunks[i].content);
			if (identical) {
				await this.store.touchNoteMtime(notePath, mtime);
				return false;
			}
		}

		// For updates: mark old chunks as stale
		if (action === "update") {
			await this.store.markChunksStale(notePath);
		}

		if (chunks.length === 0) {
			// 空文件（用户拍板"嵌入进度要包含已跳过"）：无分块、永远不会产生
			// 向量——记入已跳过，嵌入进度按 (已嵌入+已跳过)/总数 计算
			await this.store.markEmbedSkip(notePath, true);
			return false;
		}

		// Embed the chunks (async network call — yields naturally)。嵌入与索引解耦：
		// 未配置嵌入模型或关闭自动嵌入时，仅插入文本 chunk（无向量；可被关键词
		// 检索命中，向量检索由 vector IS NOT NULL 自动排除）。
		if (this.embedActive) this.progress.setPhase("embedding");
		this.progress.setNetworkStatus(this.client.networkStatus);

		// Sparse chunks (table separators | | |, dashes ---, whitespace-only)
		// collapse to the same embedding vector → false-positive ~1.0 similarity
		// between unrelated docs. Skip embedding them; they're still inserted
		// below as active/NULL, which loadVectorCache excludes via
		// `vector IS NOT NULL`, so they never pollute the vector space.
		const embeddableChunks = chunks.filter((c) => !isSparseContent(c.content));
		// 全稀疏笔记（用户拍板"嵌入进度要包含已跳过"）：没有任何可嵌入分块、
		// 永远不会产生向量——记入已跳过；此前是稀疏内容的笔记如今可嵌入
		// （内容已更新），标记随之清除。empty-file 分支同理。
		await this.store.markEmbedSkip(notePath, embeddableChunks.length === 0);

		const texts = embeddableChunks.map((c) => c.content);
		const allEmbeddings: number[][] = [];
		if (this.embedActive) {
			const embedResult = await this.client.embedAll(texts, (batchIdx, totalBatches) => {
				this.progress.setFileChunkProgress(`${batchIdx + 1}/${totalBatches}`, notePath);
			});
			// Flatten batched embeddings into a single array matching chunks order
			for (const batch of embedResult.embeddings) {
				allEmbeddings.push(...batch);
			}
		}

		// Build the document-level vector from the note's heading tree. Done
		// OUTSIDE the transaction because embed() yields (network), and the
		// transaction below must not span a yield (close() could fire mid-yield
		// and lose the in-memory DB). Only the DB write goes inside the tx.
		const docHeadingText = this.embedActive ? this.buildDocVectorText(content) : null;
		let docEmbedding: number[] | null = null;
		if (docHeadingText) {
			try {
				const docResult = await this.client.embed([docHeadingText]);
				docEmbedding = docResult.embeddings[0];
			} catch (e) {
				console.warn(`[Semlink] doc-vector embed failed for ${notePath}:`, e);
			}
		}

		// Wrap all DB writes for this note in a single transaction, serialized
		// across concurrent notes (see txLock). IMPORTANT: do NOT yield before
		// DB writes — if close() fires during yield, the in-memory DB won't
		// contain this note's data and it will be lost.
		await this.withTxLock(async () => {
			await this.store.beginTransaction();
			try {
				// Insert chunk metadata first (so UPDATE in saveEmbeddings can find them)
				const now = Date.now();
				for (let i = 0; i < chunks.length; i++) {
					await this.store.insertChunk({
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

				// Save embeddings (UPDATE chunks SET vector = ... WHERE id = ?).
				// Only embeddable chunks get a vector; sparse chunks stay active/NULL
				// (excluded from search by the `vector IS NOT NULL` filter).
				if (allEmbeddings.length > 0) {
					await this.store.saveEmbeddings(embeddableChunks.map((c) => c.id), allEmbeddings);
				}

				// Save the document-level (heading) vector in the same transaction.
				if (docEmbedding && docHeadingText) {
					await this.store.saveDocEmbedding(notePath, docEmbedding, mtime, docHeadingText);
				}

				// Delete stale chunks for this note (if update)
				if (action === "update") {
					await this.store.deleteStaleChunks(notePath);
				}

				await this.store.commitTransaction();
			} catch (e) {
				await this.store.rollbackTransaction();
				throw e;
			}
		});

		// Yield AFTER DB writes — data is now in the in-memory DB,
		// so close()/save() will capture it even if Obsidian exits during yield
		await this.yieldControl();

		this.progress.incrementEmbedded(chunks.length);
		this.progress.setAvgResponseMs(this.client.avgResponseMs);
		this.progress.setFileChunkProgress("");
		return true;
	}

	/** Build the text used to embed a note's document-level vector: the full
	 *  heading tree, de-prefixed (no leading #), de-duplicated while preserving
	 *  order, truncated to stay well under the model's token limit. Returns ""
	 *  for notes with no headings. */
	private buildDocVectorText(content: string): string {
		const headings = extractHeadings(content);
		const seen = new Set<string>();
		const titles: string[] = [];
		for (const h of headings) {
			const title = h.replace(/^#+\s+/, "").trim();
			if (title && !seen.has(title)) {
				seen.add(title);
				titles.push(title);
			}
		}
		// Heading skeleton (de-duplicated) + the document's opening content.
		// Headings alone are too generic — Introduction/References/前言/目录
		// appear in almost every doc, so heading-only vectors produced high-
		// similarity false positives between unrelated notes. The opening
		// content (≈ chunk[0]) anchors the vector in what the doc actually
		// says, which is far more discriminative.
		let text = titles.join(" / ");
		const opening = content.slice(0, 1500).trim();
		if (opening) {
			text = text ? text + "\n\n" + opening : opening;
		}
		if (!text) return "";
		// ~6000 chars ≈ 1500 tokens, safely below bge-m3's 8192 limit.
		if (text.length > 6000) text = text.slice(0, 6000);
		return text;
	}

	/** Generate document-level vectors for indexed notes that lack one. Only
	 *  embeds heading text (one batched call), never re-embeds chunks. Called
	 *  after a full scan so related-notes works immediately without waiting
	 *  for every note to be modified. */
	async backfillDocVectors(): Promise<number> {
		// Guard against concurrent runs: onload and a manual full index could
		// both trigger this — the second caller is a no-op.
		if (this.backfilling) return 0;
		this.backfilling = true;
		try {
			// Bump DOC_VECTOR_ALGO_VERSION whenever buildDocVectorText changes —
			// or when the storage format itself was broken. V3: saveDocEmbedding
			// used to bind (note_path, vector) in swapped order, so every row had
			// the embedding BLOB as its primary key and the path string as its
			// "vector" — counts inflated (rows accumulated per re-backfill) and
			// doc-vector search silently never matched. prepareDocVectorBackfill
			// wipes the table once so the fixed writer regenerates everything.
			const DOC_VECTOR_ALGO_VERSION = 3;
			await this.store.prepareDocVectorBackfill(DOC_VECTOR_ALGO_VERSION);

			const indexed = await this.store.getAllIndexedPaths();
			if (indexed.size === 0) return 0;
			const existing = await this.store.getDocVectorNotePaths();
			const missing = Array.from(indexed).filter((p) => !existing.has(p));
			if (missing.length === 0) return 0;

			debugLog(`[Semlink] Backfilling document vectors for ${missing.length} notes…`);
			const tasks: Array<{ notePath: string; mtime: number; headingText: string }> = [];
			for (const notePath of missing) {
				if (this.aborted) break;
				const file = this.vault.getAbstractFileByPath(notePath);
				if (!file || !(file instanceof TFile)) continue;
				try {
					const content = await this.vault.read(file);
					const headingText = this.buildDocVectorText(content);
					if (headingText) tasks.push({ notePath, mtime: file.stat.mtime, headingText });
				} catch {
					// unreadable file — skip
				}
			}
			if (tasks.length === 0 || this.aborted) return 0;

			try {
				const texts = tasks.map((t) => t.headingText);
				const embedResult = await this.client.embedAll(texts);
				const allVecs: number[][] = [];
				for (const batch of embedResult.embeddings) allVecs.push(...batch);
				for (let i = 0; i < tasks.length; i++) {
					await this.store.saveDocEmbedding(tasks[i].notePath, allVecs[i], tasks[i].mtime, tasks[i].headingText);
				}
				debugLog(`[Semlink] Document vectors backfilled: ${tasks.length}`);
				return tasks.length;
			} catch (e) {
				console.warn("[Semlink] doc-vector backfill embed failed:", e);
				return 0;
			}
		} finally {
			this.backfilling = false;
		}
	}

	/** Process multiple notes concurrently with limited parallelism */
	private async processConcurrently(noteEntries: [string, QueueItem[]][]): Promise<void> {
		// Process in chunks of concurrency
		for (let i = 0; i < noteEntries.length; i += this.concurrency) {
			if (this.aborted) break;

			// Re-check between concurrency groups — a single batch can embed
			// for a while, so don't wait until the whole batch finishes before
			// noticing the user is back.
			if (this.gate && !this.gate.isIdle()) {
				await this.waitForIdle();
				if (this.aborted) break;
			}

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
	private async processNoteSafe(notePath: string, items: QueueItem[]): Promise<void> {
		this.progress.setCurrentFile(notePath);

		try {
			const indexed = await this.processNote(notePath, items);
			// Mark queue items as completed
			for (const item of items) {
				if (item.id != null) await this.queue.complete(item.id);
			}
			// Only count notes that actually produced chunks.
			// In incremental mode the base already counts existing notes, so
			// an "update" must NOT increment (it would flicker the count);
			// only a genuine "add" raises the real total.
			if (indexed) {
				const action = items[0]?.action;
				if (action === "add" || this.incrementalBase === 0) {
					this.progress.incrementProcessed();
				}
				// Periodic async save — counted per note, not per batch
				await this.maybeSaveAsync();
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			const status = (error as { status?: number } | undefined)?.status;
			console.error(`[Semlink] Error processing ${notePath}:`, msg);

			for (const item of items) {
				if (item.id != null) await this.queue.fail(item.id, msg);
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
		} finally {
			// Done (indexed or failed) — drop it from the concurrent set.
			this.progress.removeActiveFile(notePath);
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
		// A full-DB export blocks the main thread for seconds in sync mode —
		// space saves out in time as well as note count.
		if (Date.now() - this.lastSaveAt < this.saveGapMs) return;
		if (this.processedSinceSave >= this.saveInterval) {
			await this.yieldControl();
			const t0 = Date.now();
			await this.store.save();
			const durMs = Date.now() - t0;
			this.lastSaveAt = Date.now();
			// 慢导出自适应退避：sql.js save = 全库导出，库到几百 MB 后一次
			// 导出可达分钟级（真机实测：vault.db 自 10/17 起从未写成、worker
			// 3.5 核持续空转、索引器整体楔死）。导出越慢下次间隔越长，
			// 20s → 80s → 320s → 封顶 30min；导出恢复快则回到 20s。
			if (durMs > 15000) {
				this.saveGapMs = Math.min(this.saveGapMs * 4, 30 * 60000);
				debugLog(`[Semlink] save took ${(durMs / 1000).toFixed(1)}s — backing off to ${(this.saveGapMs / 1000).toFixed(0)}s gap`);
			} else {
				this.saveGapMs = 20000;
			}
			const stats = await this.store.getStats();
			this.progress.setDbSizeMb(stats.dbSizeMb);
			this.processedSinceSave = 0;
		}
	}

	/** Flush any remaining unsaved notes to disk (called when queue is empty) */
	private async flushSave(): Promise<void> {
		if (this.processedSinceSave > 0) {
			await this.store.save();
			this.processedSinceSave = 0;
		}
	}

	/** Enqueue a single file for indexing (from watcher) */
	async enqueueFile(notePath: string, action: QueueAction): Promise<void> {
		await this.queue.enqueue(notePath, action, action === "update" ? 3 : 2);
	}

	/** Rename a note's path in the index without re-embedding (from watcher) */
	async renamePath(oldPath: string, newPath: string): Promise<void> {
		await this.store.renameNotePath(oldPath, newPath);
	}

	/** Whether a note path has index entries (chunks). The watcher uses this
	 *  to tell a real rename (old path was indexed → update path in place)
	 *  from a file arriving into scope from a never-indexed location, e.g.
	 *  moved out of an excluded folder (→ index it fresh as an add). */
	async hasIndexEntries(notePath: string): Promise<boolean> {
		return (await this.store.getNoteMtime(notePath)) !== null;
	}

	/**
	 * Run incremental indexing: only process items already in the queue.
	 * Does NOT scan the vault. Used by the watcher for file change events.
	 */
	runIncremental(): void {
		void this.run(false);
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
		void this.run(true);
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
				window.setTimeout(check, 1000);
			};
			check();
		});
	}

	/** Wait until the user has been idle for IDLE_MS (checked every 500ms).
	 *  Resolves immediately when the gate is absent. */
	private waitForIdle(): Promise<void> {
		return new Promise((resolve) => {
			const check = () => {
				if (this.aborted || !this.gate || this.gate.isIdle()) {
					resolve();
					return;
				}
				window.setTimeout(check, 500);
			};
			check();
		});
	}

	private groupByNote(items: QueueItem[]): Map<string, QueueItem[]> {
		const map = new Map<string, QueueItem[]>();
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
		return new Promise(resolve => window.setTimeout(resolve, 0));
	}
}
