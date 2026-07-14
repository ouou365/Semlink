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
		if (this.fallback) {
			// Synchronous fallback — wrap the engine call directly.
			return Promise.resolve(this.callEngineSync(op, args));
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
		});
	}

	/** Invoke the same op against the synchronous engine (fallback path). */
	private callEngineSync(op: string, args: any[]): any {
		const e = this.engine!;
		switch (op) {
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
			case "loadVectorCache": return e.loadVectorCache();
			case "search": return e.search(args[0], args[1], args[2]);
			case "enqueue": return e.enqueue(args[0], args[1], args[2]);
			case "enqueueMany": return e.enqueueMany(args[0]);
			case "dequeue": return e.dequeue(args[0]);
			case "complete": return e.complete(args[0]);
			case "fail": return e.fail(args[0], args[1]);
			case "retryFailed": return e.retryFailed();
			case "getPendingCount": return e.getPendingCount();
			case "getCounts": return e.getCounts();
			case "cleanup": return e.cleanup(args[0]);
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
	async getStats(): Promise<{ totalChunks: number; activeChunks: number; indexedNotes: number; dbSizeMb: number }> {
		return await this.call("getStats");
	}

	async saveEmbeddings(chunkIds: string[], embeddings: number[][]): Promise<void> {
		await this.call("saveEmbeddings", [chunkIds, embeddings]);
	}
	async loadVectorCache(): Promise<void> { await this.call("loadVectorCache"); }

	async search(queryEmbedding: number[], limit = 10, threshold = 0.3): Promise<SearchResult[]> {
		return await this.call("search", [queryEmbedding, limit, threshold]);
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
