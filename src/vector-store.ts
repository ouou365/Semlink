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
import { debugLog } from "./log";
import type { Worker as NodeWorker } from "worker_threads";
import type { NoteChunk, SearchResult, QueueAction, QueueItem } from "./types";
import { DbEngine } from "./db-engine";
import { chunkMarkdown, ChunkResult } from "./chunker";

// Lazy require so that environments without worker_threads don't crash at
// import time — we detect availability at runtime instead.
let WorkerCtor: (new (path: string) => NodeWorker) | null = null;
let workerAvailable = false;
try {
	// worker_threads is a Node built-in; Obsidian runs on Electron with full
	// Node integration (the plugin already uses `fs`, `http`, etc.).
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberately lazy: must not throw at import time in hosts without it
	WorkerCtor = (require("worker_threads") as { Worker: typeof WorkerCtor }).Worker;
	workerAvailable = !!WorkerCtor;
} catch {
	workerAvailable = false;
}

/** Worker → main reply: { reqId, result } on success, { reqId, error } on failure. */
interface WorkerResponse {
	reqId: number;
	result?: unknown;
	error?: string;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (err: unknown) => void;
}

export class VectorStore {
	private dataDir: string;
	private worker: NodeWorker | null = null;
	private reqId = 0;
	private pending = new Map<number, PendingRequest>();
	private fallback = false;
	private browserWorker: Worker | null = null;

	// Synchronous engine used only on the fallback path.
	private engine: DbEngine | null = null;

	/** Whether DB work is running in a worker thread (true) or on the main
	 *  thread (false, degraded). Exposed for diagnostics/logging. */
	get isWorkerMode(): boolean {
		return !this.fallback && this.worker != null;
	}

	/** Where the DB engine runs: node worker, browser worker, or main. */
	get storageMode(): "worker" | "browser-worker" | "sync" {
		if (this.fallback) return "sync";
		return this.browserWorker ? "browser-worker" : this.worker ? "worker" : "sync";
	}

	constructor(dataDir: string, private browserWorkerUrl?: string) {
		this.dataDir = dataDir;
	}

	async init(): Promise<void> {
		if (workerAvailable) {
			try {
				await this.initWorker();
				return;
			} catch {
				debugLog("node worker_threads unavailable in the renderer — using the browser worker instead");
			}
		}
		if (this.browserWorkerUrl && typeof Worker !== "undefined") {
			try {
				await this.initBrowserWorker(this.browserWorkerUrl);
				return;
			} catch (e) {
				console.error("[Semlink] browser worker init failed — using sync fallback. Reason:", e);
			}
		}
		// Fallback: run the engine synchronously on the main thread.
		this.fallback = true;
		this.engine = new DbEngine(this.dataDir);
		await this.engine.init();
		console.warn("[Semlink] VectorStore running in sync (fallback) mode — animations may stutter during indexing");
	}

	private async initWorker(): Promise<void> {
		const workerPath = join(__dirname, "db-worker.js");
		this.worker = new (WorkerCtor as new (path: string) => NodeWorker)(workerPath);

		// Wire up the response channel once.
		this.worker.on("message", (msg: WorkerResponse) => {
			const { reqId, result, error } = msg;
			const pending = this.pending.get(reqId);
			if (!pending) return;
			this.pending.delete(reqId);
			if (error) pending.reject(new Error(error));
			else pending.resolve(result);
		});
		this.worker.on("error", (err: Error) => {
			console.error("[Semlink] DB worker error:", err);
			// Reject every pending request — the worker is likely dead.
			for (const [, p] of this.pending) p.reject(err);
			this.pending.clear();
		});

		// Send init.
		await this.call("init", [this.dataDir]);
		debugLog("[Semlink] VectorStore running in worker mode");
	}

	/** Browser Web Worker channel (used when worker_threads is missing). */
	private async initBrowserWorker(url: string): Promise<void> {
		// `url` is a ready-to-use Blob URL: main.ts reads the worker script
		// through the vault adapter (plain file text) and wraps it in a Blob.
		// The previous requestUrl(resourcePath) approach failed on desktop —
		// resource URLs are app://, and Electron's net module only speaks
		// http/https — which forced every desktop user onto the sync
		// fallback. Chromium also refuses a Worker from an app:// URL
		// directly, hence the Blob detour.
		const w = new Worker(url);
		w.onmessage = (e: MessageEvent) => {
			const { reqId, result, error } = (e.data ?? {}) as WorkerResponse;
			const pending = this.pending.get(reqId);
			if (!pending) return;
			this.pending.delete(reqId);
			if (error) pending.reject(new Error(error));
			else pending.resolve(result);
		};
		w.onerror = (e: ErrorEvent) => {
			const err = new Error("browser worker error: " + (e.message || "unknown"));
			for (const [, p] of this.pending) p.reject(err);
			this.pending.clear();
		};
		this.browserWorker = w;
		// One-time seed: copy the legacy disk DB into the worker OPFS so the
		// existing index survives the switch. The worker skips this if its
		// own copy already exists (never overwrite a newer OPFS index).
		try {
			const fsMod = (window as unknown as { require?: (id: string) => typeof import("fs") }).require?.("fs");
			const dbPath = join(this.dataDir, "vault.db");
			if (fsMod?.existsSync(dbPath)) {
				await this.call("seedDb", [new Uint8Array(fsMod.readFileSync(dbPath))]);
			}
		} catch (seedErr) {
			console.warn("[Semlink] OPFS seed skipped:", seedErr);
		}
		// The browser entry ignores the passed dataDir and uses the OPFS
		// namespace root as its virtual root.
		await this.call("init", [""]);
		debugLog("[Semlink] VectorStore running in browser worker mode — DB engine is off the main thread");
	}

	/** Send one op to the worker and await its reply. */
	private call<T = unknown>(op: string, args: unknown[] = []): Promise<T> {
		const t0 = performance.now();
		if (this.fallback) {
			// Synchronous fallback — wrap the engine call directly. The
			// measure makes the main-thread cost of every engine op visible
			// in the guide's debug readout.
			return Promise.resolve(this.callEngineSync(op, args) as T).finally(() => {
				performance.measure("semlink:sync-engine", { start: t0 });
			});
		}
		if (this.browserWorker) {
			return new Promise((resolve, reject) => {
				const reqId = ++this.reqId;
				this.pending.set(reqId, { resolve, reject });
				this.browserWorker!.postMessage({ reqId, op, args });
			});
		}
		return new Promise<T>((resolve, reject) => {
			const reqId = ++this.reqId;
			this.pending.set(reqId, { resolve, reject });
			try {
				this.worker!.postMessage({ reqId, op, args });
			} catch (e) {
				this.pending.delete(reqId);
				reject(e instanceof Error ? e : new Error(String(e)));
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
	private callEngineSync(op: string, args: unknown[]): unknown {
		const e = this.engine!;
		switch (op) {
			case "chunk": return chunkMarkdown(args[0] as string, args[1] as string, args[2] as number, args[3] as number);
			case "save": return e.save();
			case "clearAll": return e.clearAll();
			case "compact": return e.compact();
			case "beginTransaction": return e.beginTransaction();
			case "commitTransaction": return e.commitTransaction();
			case "rollbackTransaction": return e.rollbackTransaction();
			case "insertChunk": return e.insertChunk(args[0] as NoteChunk);
			case "getChunksByNotePath": return e.getChunksByNotePath(args[0] as string);
			case "getActiveChunks": return e.getActiveChunks();
			case "getChunkById": return e.getChunkById(args[0] as string);
			case "markChunksStale": return e.markChunksStale(args[0] as string);
			case "deleteChunksByNotePath": return e.deleteChunksByNotePath(args[0] as string);
			case "deleteStaleChunks": return e.deleteStaleChunks(args[0] as string);
			case "renameNotePath": return e.renameNotePath(args[0] as string, args[1] as string);
			case "getNoteMtime": return e.getNoteMtime(args[0] as string);
			case "getAllIndexedPaths": return e.getAllIndexedPaths();
			case "pruneOrphanedPaths": return e.pruneOrphanedPaths(args[0] as Set<string>);
			case "getStats": return e.getStats();
			case "getEmbeddedNoteCount": return e.getEmbeddedNoteCount();
			case "saveEmbeddings": return e.saveEmbeddings(args[0] as string[], args[1] as number[][]);
			case "saveDocEmbedding": return e.saveDocEmbedding(args[0] as string, args[1] as number[], args[2] as number, args[3] as string);
			case "getDocVectorNotePaths": return e.getDocVectorNotePaths();
			case "prepareDocVectorBackfill": return e.prepareDocVectorBackfill(args[0] as number);
			case "loadVectorCache": return e.loadVectorCache();
			case "search": return e.search(args[0] as number[] | Float32Array, args[1] as number, args[2] as number);
			case "searchRelatedNotes": return e.searchRelatedNotes(args[0] as string, args[1] as number, args[2] as number, args[3] as number);
			case "textSearch": return e.textSearch(args[0] as string, args[1] as number, args[2] as string | undefined);
			case "enqueue": return e.enqueue(args[0] as string, args[1] as QueueAction, args[2] as number);
			case "enqueueMany": return e.enqueueMany(args[0] as Array<{ notePath: string; action: QueueAction; priority?: number }>);
			case "dequeue": return e.dequeue(args[0] as number);
			case "complete": return e.complete(args[0] as number);
			case "fail": return e.fail(args[0] as number, args[1] as string);
			case "retryFailed": return e.retryFailed();
			case "getPendingCount": return e.getPendingCount();
			case "getCounts": return e.getCounts();
			case "cleanup": return e.cleanup(args[0] as number);
			case "cleanupQueue": return e.cleanupQueue();
			case "reviveProcessing": return e.reviveProcessing();
			case "purgeGhostQueue": return e.purgeGhostQueue(args[0] as Set<string>);
			case "clearQueue": return e.clearQueue();
			case "getPendingPaths": return e.getPendingPaths();
			default: throw new Error(`Unknown op: ${op}`);
		}
	}

	// ──── Public API (all async now) ────

	async save(): Promise<void> { await this.call("save"); }
	async clearAll(): Promise<void> { await this.call("clearAll"); }
	/** 嵌入模型变更：清向量保留块，并重置 mtime 让全量笔记重走嵌入。 */
	async clearVectors(): Promise<void> { await this.call("clearVectors"); }
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
			try { void this.worker.terminate(); } catch { /* already gone */ }
			this.worker = null;
		}
	}

	async beginTransaction(): Promise<void> { await this.call("beginTransaction"); }
	async commitTransaction(): Promise<void> { await this.call("commitTransaction"); }
	async rollbackTransaction(): Promise<void> { await this.call("rollbackTransaction"); }

	async insertChunk(chunk: NoteChunk): Promise<void> { await this.call("insertChunk", [chunk]); }
	async getChunksByNotePath(notePath: string): Promise<NoteChunk[]> {
		return await this.call<NoteChunk[]>("getChunksByNotePath", [notePath]);
	}
	async getActiveChunks(): Promise<NoteChunk[]> { return await this.call<NoteChunk[]>("getActiveChunks"); }
	async getChunkById(id: string): Promise<NoteChunk | null> {
		return await this.call<NoteChunk | null>("getChunkById", [id]);
	}
	async markChunksStale(notePath: string): Promise<number> {
		return await this.call<number>("markChunksStale", [notePath]);
	}
	async deleteChunksByNotePath(notePath: string): Promise<number> {
		return await this.call<number>("deleteChunksByNotePath", [notePath]);
	}
	async deleteStaleChunks(notePath: string): Promise<number> {
		return await this.call<number>("deleteStaleChunks", [notePath]);
	}
	async renameNotePath(oldPath: string, newPath: string): Promise<number> {
		return await this.call<number>("renameNotePath", [oldPath, newPath]);
	}
	async getNoteMtime(notePath: string): Promise<number | null> {
		return await this.call<number | null>("getNoteMtime", [notePath]);
	}
	async getAllIndexedPaths(): Promise<Set<string>> {
		return await this.call<Set<string>>("getAllIndexedPaths");
	}
	async pruneOrphanedPaths(existingPaths: Set<string>): Promise<number> {
		return await this.call<number>("pruneOrphanedPaths", [existingPaths]);
	}
	/** Delete completed/failed queue rows from previous runs. */
	async cleanupQueue(): Promise<number> {
		return await this.call<number>("cleanupQueue");
	}
	/** Reset rows stuck at 'processing' (interrupted runs) back to 'pending'. */
	async reviveProcessing(): Promise<number> {
		return await this.call<number>("reviveProcessing");
	}
	/** Delete queue rows whose note_path no longer exists in the vault. */
	async purgeGhostQueue(existingPaths: Set<string>): Promise<number> {
		return await this.call<number>("purgeGhostQueue", [existingPaths]);
	}
	async getStats(): Promise<{ totalChunks: number; activeChunks: number; embeddedChunks: number; indexedNotes: number; dbSizeMb: number }> {
		return await this.call<{ totalChunks: number; activeChunks: number; embeddedChunks: number; indexedNotes: number; dbSizeMb: number }>("getStats");
	}

	/** 已嵌入（至少一个 chunk 带向量）的笔记数 — 进度面板/引导页「已嵌入」口径。 */
	async getEmbeddedNoteCount(): Promise<number> {
		return await this.call<number>("getEmbeddedNoteCount");
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
		return await this.call<Set<string>>("getDocVectorNotePaths");
	}
	/** Clear stale doc vectors when the algorithm version changes (migration). */
	async prepareDocVectorBackfill(version: number): Promise<boolean> {
		return await this.call<boolean>("prepareDocVectorBackfill", [version]);
	}
	async loadVectorCache(): Promise<void> { await this.call("loadVectorCache"); }

	/** 向量搜索总开关（设置页 RAG 标签注入）：关闭时所有语义检索直接返回空。 */
	searchGate: () => boolean = () => true;

	async search(queryEmbedding: number[], limit = 10, threshold = 0.3): Promise<SearchResult[]> {
		if (!this.searchGate()) return [];
		if (this.fallback) {
			// Sync mode: time-slice the scan so the main thread (and the UI's
			// elapsed counter / dots) keeps breathing between slices.
			return await this.searchSyncSliced(queryEmbedding, limit, threshold);
		}
		return await this.call<SearchResult[]>("search", [queryEmbedding, limit, threshold]);
	}

	/** Note→note "related notes" via max-pooling over the source note's chunks
	 *  (see DbEngine.searchRelatedNotes). Runs in the worker; in sync-fallback
	 *  mode it runs synchronously without time-slicing (rare, degraded path). */
	async searchRelatedNotes(notePath: string, limit = 10, threshold = 0.2, maxProbes = 6): Promise<SearchResult[]> {
		if (!this.searchGate()) return [];
		return await this.call<SearchResult[]>("searchRelatedNotes", [notePath, limit, threshold, maxProbes]);
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
			await new Promise((r) => window.setTimeout(r, 0));
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

	/** Fast substring search over indexed chunk content (for the grep tool). */
	async textSearch(pattern: string, limit = 200, pathFilter?: string): Promise<Array<{ path: string; matchCount: number; preview: string }>> {
		return await this.call<Array<{ path: string; matchCount: number; preview: string }>>("textSearch", [pattern, limit, pathFilter]);
	}

	/** Chunk a markdown document. Runs in the worker thread so large-file
	 *  string processing doesn't block the UI while typing. */
	async chunk(content: string, notePath: string, chunkSize: number, chunkOverlap: number): Promise<ChunkResult[]> {
		return await this.call<ChunkResult[]>("chunk", [content, notePath, chunkSize, chunkOverlap]);
	}

	// ──── Queue operations (proxy to worker; IndexQueue delegates here) ────

	async enqueue(notePath: string, action: QueueAction, priority = 2): Promise<void> {
		await this.call("enqueue", [notePath, action, priority]);
	}
	async enqueueMany(items: Array<{ notePath: string; action: QueueAction; priority?: number }>): Promise<void> {
		await this.call("enqueueMany", [items]);
	}
	async dequeue(limit = 64): Promise<QueueItem[]> {
		return await this.call<QueueItem[]>("dequeue", [limit]);
	}
	async complete(id: number): Promise<void> { await this.call("complete", [id]); }
	async fail(id: number, error: string): Promise<void> { await this.call("fail", [id, error]); }
	async retryFailed(): Promise<number> { return await this.call<number>("retryFailed"); }
	async getPendingCount(): Promise<number> { return await this.call<number>("getPendingCount"); }
	async getCounts(): Promise<{ pending: number; processing: number; failed: number; completed: number }> {
		return await this.call<{ pending: number; processing: number; failed: number; completed: number }>("getCounts");
	}
	async cleanup(cutoffMs: number): Promise<void> { await this.call("cleanup", [cutoffMs]); }
	async clearQueue(): Promise<void> { await this.call("clearQueue"); }
	async getPendingPaths(): Promise<string[]> { return await this.call<string[]>("getPendingPaths"); }
}
