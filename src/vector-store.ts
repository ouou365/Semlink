// ========================================
// Semlink - Vector Store (async proxy + sync fallback)
// ========================================
// Public API mirror of the old synchronous VectorStore, but every method is
// now async. Behind the scenes it routes DB work to a worker_threads child so
// the heavy operations (db.export of a ~397MB DB, writeFileSync, brute-force
// cosine search) never touch Obsidian's main thread — which is what was
// causing typing lag.
//
// If worker_threads is unavailable in the host environment, it transparently
// falls back to running the same DbEngine synchronously on the main thread
// (the original behavior). So the plugin is never worse off than before.

import { join } from "path";
import type { NoteChunk, SearchResult, QueueAction, QueueItem } from "./types";
import { DbEngine } from "./db-engine";
import { chunkMarkdown, ChunkResult } from "./chunker";

// Lazy require so that environments without worker_threads don't crash at
// import time — we detect availability at runtime instead.
let WorkerCtor: any = null;
let workerAvailable = false;
try {
	// worker_threads is a Node built-in; Obsidian runs on Electron with full
	// Node integration (the plugin already uses `fs`, `http`, etc.).
	WorkerCtor = require("worker_threads").Worker;
	workerAvailable = !!WorkerCtor;
} catch {
	workerAvailable = false;
}

interface PendingRequest {
	resolve: (value: any) => void;
	reject: (err: any) => void;
}

export class VectorStore {
	private dataDir: string;
	private worker: any | null = null;
	private reqId = 0;
	private pending = new Map<number, PendingRequest>();
	private fallback = false;

	// Synchronous engine used only on the fallback path.
	private engine: DbEngine | null = null;

	/** Whether DB work is running in a worker thread (true) or on the main
	 *  thread (false, degraded). Exposed for diagnostics/logging. */
	get isWorkerMode(): boolean {
		return !this.fallback && this.worker != null;
	}

	constructor(dataDir: string) {
		this.dataDir = dataDir;
	}

	async init(): Promise<void> {
		if (workerAvailable) {
			try {
				await this.initWorker();
				return;
			} catch (e) {
				console.warn("[Semlink] Worker init failed, falling back to sync mode:", e);
			}
		}
		// Fallback: run the engine synchronously on the main thread.
		this.fallback = true;
		this.engine = new DbEngine(this.dataDir);
		await this.engine.init();
		console.log("[Semlink] VectorStore running in sync (fallback) mode");
	}

	private async initWorker(): Promise<void> {
		const workerPath = join(__dirname, "db-worker.js");
		this.worker = new WorkerCtor(workerPath);

		// Wire up the response channel once.
		this.worker.on("message", (msg: any) => {
			const { reqId, result, error } = msg;
			const pending = this.pending.get(reqId);
			if (!pending) return;
			this.pending.delete(reqId);
			if (error) pending.reject(new Error(error));
			else pending.resolve(result);
		});
		this.worker.on("error", (err: any) => {
			console.error("[Semlink] DB worker error:", err);
			// Reject every pending request — the worker is likely dead.
			for (const [, p] of this.pending) p.reject(err);
			this.pending.clear();
		});

		// Send init.
		await this.call("init", [this.dataDir]);
		console.log("[Semlink] VectorStore running in worker mode");
	}

	/** Send one op to the worker and await its reply. */
	private call(op: string, args: any[] = []): Promise<any> {
		const t0 = performance.now();
		if (this.fallback) {
			// Synchronous fallback — wrap the engine call directly. The
			// measure makes the main-thread cost of every engine op visible
			// in the guide's debug readout.
			return Promise.resolve(this.callEngineSync(op, args)).finally(() => {
				performance.measure("semlink:sync-engine", { start: t0 });
			});
		}
		return new Promise((resolve, reject) => {
			const reqId = ++this.reqId;
			this.pending.set(reqId, { resolve, reject });
			try {
				this.worker.postMessage({ reqId, op, args });
			} catch (e) {
				this.pending.delete(reqId);
				reject(e);
			}
		}).finally(() => {
			performance.measure("semlink:worker-call", { start: t0 });
		});
	}

	/** Whether heavy engine work is off the main thread (worker mode). */
	get runningInWorker(): boolean {
		return !this.fallback && this.worker != null;
	}

	/** Invoke the same op against the synchronous engine (fallback path). */
	private callEngineSync(op: string, args: any[]): any {
		const e = this.engine!;
		switch (op) {
			case "chunk": return chunkMarkdown(args[0], args[1], args[2], args[3]);
			case "save": return e.save();
			case "clearAll": return e.clearAll();
			case "compact": return e.compact();
			case "beginTransaction": return e.beginTransaction();
			case "commitTransaction": return e.commitTransaction();
			case "rollbackTransaction": return e.rollbackTransaction();
			case "insertChunk": return e.insertChunk(args[0]);
			case "getChunksByNotePath": return e.getChunksByNotePath(args[0]);
			case "getActiveChunks": return e.getActiveChunks();
			case "getChunkById": return e.getChunkById(args[0]);
			case "markChunksStale": return e.markChunksStale(args[0]);
			case "deleteChunksByNotePath": return e.deleteChunksByNotePath(args[0]);
			case "deleteStaleChunks": return e.deleteStaleChunks(args[0]);
			case "renameNotePath": return e.renameNotePath(args[0], args[1]);
			case "getNoteMtime": return e.getNoteMtime(args[0]);
			case "getAllIndexedPaths": return e.getAllIndexedPaths();
			case "pruneOrphanedPaths": return e.pruneOrphanedPaths(args[0]);
			case "getStats": return e.getStats();
			case "saveEmbeddings": return e.saveEmbeddings(args[0], args[1]);
			case "saveDocEmbedding": return e.saveDocEmbedding(args[0], args[1], args[2], args[3]);
			case "getDocVectorNotePaths": return e.getDocVectorNotePaths();
			case "prepareDocVectorBackfill": return e.prepareDocVectorBackfill(args[0]);
			case "loadVectorCache": return e.loadVectorCache();
			case "search": return e.search(args[0], args[1], args[2]);
			case "searchRelatedNotes": return e.searchRelatedNotes(args[0], args[1], args[2], args[3]);
			case "textSearch": return e.textSearch(args[0], args[1], args[2]);
			case "enqueue": return e.enqueue(args[0], args[1], args[2]);
			case "enqueueMany": return e.enqueueMany(args[0]);
			case "dequeue": return e.dequeue(args[0]);
			case "complete": return e.complete(args[0]);
			case "fail": return e.fail(args[0], args[1]);
			case "retryFailed": return e.retryFailed();
			case "getPendingCount": return e.getPendingCount();
			case "getCounts": return e.getCounts();
			case "cleanup": return e.cleanup(args[0]);
			case "cleanupQueue": return e.cleanupQueue();
			case "purgeGhostQueue": return e.purgeGhostQueue(args[0]);
			case "clearQueue": return e.clearQueue();
			case "getPendingPaths": return e.getPendingPaths();
			default: throw new Error(`Unknown op: ${op}`);
		}
	}

	// ──── Public API (all async now) ────

	async save(): Promise<void> { await this.call("save"); }
	async clearAll(): Promise<void> { await this.call("clearAll"); }
	async compact(): Promise<void> { await this.call("compact"); }

	/**
	 * Close + flush. In worker mode this sends a synchronous `close` op: the
	 * child performs save() then db.close() in its own thread and exits, so
	 * data lands on disk even though the host's onunload() is not awaited.
	 * Returns a promise that resolves when the close message has been posted
	 * (and, in fallback mode, after the sync close completes).
	 */
	async close(): Promise<void> {
		if (this.fallback) {
			this.engine?.close();
			return;
		}
		if (this.worker) {
			try {
				// Best-effort await; if the host tears down before the reply,
				// the worker still saved synchronously on receiving "close".
				await this.call("close", []);
			} catch {
				/* worker already gone */
			}
			try { this.worker.terminate(); } catch {}
			this.worker = null;
		}
	}

	async beginTransaction(): Promise<void> { await this.call("beginTransaction"); }
	async commitTransaction(): Promise<void> { await this.call("commitTransaction"); }
	async rollbackTransaction(): Promise<void> { await this.call("rollbackTransaction"); }

	async insertChunk(chunk: NoteChunk): Promise<void> { await this.call("insertChunk", [chunk]); }
	async getChunksByNotePath(notePath: string): Promise<NoteChunk[]> {
		return await this.call("getChunksByNotePath", [notePath]);
	}
	async getActiveChunks(): Promise<NoteChunk[]> { return await this.call("getActiveChunks"); }
	async getChunkById(id: string): Promise<NoteChunk | null> {
		return await this.call("getChunkById", [id]);
	}
	async markChunksStale(notePath: string): Promise<number> {
		return await this.call("markChunksStale", [notePath]);
	}
	async deleteChunksByNotePath(notePath: string): Promise<number> {
		return await this.call("deleteChunksByNotePath", [notePath]);
	}
	async deleteStaleChunks(notePath: string): Promise<number> {
		return await this.call("deleteStaleChunks", [notePath]);
	}
	async renameNotePath(oldPath: string, newPath: string): Promise<number> {
		return await this.call("renameNotePath", [oldPath, newPath]);
	}
	async getNoteMtime(notePath: string): Promise<number | null> {
		return await this.call("getNoteMtime", [notePath]);
	}
	async getAllIndexedPaths(): Promise<Set<string>> {
		return await this.call("getAllIndexedPaths");
	}
	async pruneOrphanedPaths(existingPaths: Set<string>): Promise<number> {
		return await this.call("pruneOrphanedPaths", [existingPaths]);
	}
	/** Delete completed/failed queue rows from previous runs. */
	async cleanupQueue(): Promise<number> {
		return await this.call("cleanupQueue");
	}
	/** Delete queue rows whose note_path no longer exists in the vault. */
	async purgeGhostQueue(existingPaths: Set<string>): Promise<number> {
		return await this.call("purgeGhostQueue", [existingPaths]);
	}
	async getStats(): Promise<{ totalChunks: number; activeChunks: number; indexedNotes: number; dbSizeMb: number }> {
		return await this.call("getStats");
	}

	async saveEmbeddings(chunkIds: string[], embeddings: number[][]): Promise<void> {
		await this.call("saveEmbeddings", [chunkIds, embeddings]);
	}
	/** Save a document-level vector (heading-tree embedding) for one note. */
	async saveDocEmbedding(notePath: string, embedding: number[], mtime: number, headingText: string): Promise<void> {
		await this.call("saveDocEmbedding", [notePath, embedding, mtime, headingText]);
	}
	/** Note paths that already have a document vector (for backfill skip). */
	async getDocVectorNotePaths(): Promise<Set<string>> {
		return await this.call("getDocVectorNotePaths");
	}
	/** Clear stale doc vectors when the algorithm version changes (migration). */
	async prepareDocVectorBackfill(version: number): Promise<boolean> {
		return await this.call("prepareDocVectorBackfill", [version]);
	}
	async loadVectorCache(): Promise<void> { await this.call("loadVectorCache"); }

	async search(queryEmbedding: number[], limit = 10, threshold = 0.3): Promise<SearchResult[]> {
		if (this.fallback) {
			// Sync mode: time-slice the scan so the main thread (and the UI's
			// elapsed counter / dots) keeps breathing between slices.
			return await this.searchSyncSliced(queryEmbedding, limit, threshold);
		}
		return await this.call("search", [queryEmbedding, limit, threshold]);
	}

	/** Note→note "related notes" via max-pooling over the source note's chunks
	 *  (see DbEngine.searchRelatedNotes). Runs in the worker; in sync-fallback
	 *  mode it runs synchronously without time-slicing (rare, degraded path). */
	async searchRelatedNotes(notePath: string, limit = 10, threshold = 0.2, maxProbes = 6): Promise<SearchResult[]> {
		return await this.call("searchRelatedNotes", [notePath, limit, threshold, maxProbes]);
	}

	/** Sync-fallback search: scan in slices, yielding between them. */
	private async searchSyncSliced(
		queryEmbedding: number[],
		limit: number,
		threshold: number,
	): Promise<SearchResult[]> {
		const engine = this.engine!;
		// ~4096 vectors × 300 dims ≈ 1.2M dot products per slice (~50-150ms).
		const SLICE = 4096;
		const hits: Array<{ chunkId: string; score: number }> = [];
		const count = engine.vectorCount();
		for (let start = 0; start < count; start += SLICE) {
			hits.push(...engine.searchSlice(queryEmbedding, start, Math.min(start + SLICE, count), threshold));
			// Yield to the main thread so timers/render stay responsive.
			await new Promise((r) => setTimeout(r, 0));
		}

		hits.sort((a, b) => b.score - a.score);
		const topK = hits.slice(0, limit);

		const results: SearchResult[] = [];
		for (const h of topK) {
			const chunk = engine.getChunkById(h.chunkId);
			if (chunk) {
				results.push({
					chunkId: chunk.id,
					notePath: chunk.notePath,
					heading: chunk.heading,
					contentPreview: chunk.contentPreview,
					score: Math.round(h.score * 10000) / 10000,
				});
			}
		}
		return results;
	}

	/** Fast substring search over indexed chunk content (for grep_notes). */
	async textSearch(pattern: string, limit = 200, pathFilter?: string): Promise<Array<{ path: string; matchCount: number; preview: string }>> {
		return await this.call("textSearch", [pattern, limit, pathFilter]);
	}

	/** Chunk a markdown document. Runs in the worker thread so large-file
	 *  string processing doesn't block the UI while typing. */
	async chunk(content: string, notePath: string, chunkSize: number, chunkOverlap: number): Promise<ChunkResult[]> {
		return await this.call("chunk", [content, notePath, chunkSize, chunkOverlap]);
	}

	// ──── Queue operations (proxy to worker; IndexQueue delegates here) ────

	async enqueue(notePath: string, action: QueueAction, priority = 2): Promise<void> {
		await this.call("enqueue", [notePath, action, priority]);
	}
	async enqueueMany(items: Array<{ notePath: string; action: QueueAction; priority?: number }>): Promise<void> {
		await this.call("enqueueMany", [items]);
	}
	async dequeue(limit = 64): Promise<QueueItem[]> {
		return await this.call("dequeue", [limit]);
	}
	async complete(id: number): Promise<void> { await this.call("complete", [id]); }
	async fail(id: number, error: string): Promise<void> { await this.call("fail", [id, error]); }
	async retryFailed(): Promise<number> { return await this.call("retryFailed"); }
	async getPendingCount(): Promise<number> { return await this.call("getPendingCount"); }
	async getCounts(): Promise<{ pending: number; processing: number; failed: number; completed: number }> {
		return await this.call("getCounts");
	}
	async cleanup(cutoffMs: number): Promise<void> { await this.call("cleanup", [cutoffMs]); }
	async clearQueue(): Promise<void> { await this.call("clearQueue"); }
	async getPendingPaths(): Promise<string[]> { return await this.call("getPendingPaths"); }
}
