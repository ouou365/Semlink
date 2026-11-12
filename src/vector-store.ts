// ========================================
// Semlink - Vector Store (async OPFS proxy)
// ========================================
// Public API mirror of the old synchronous VectorStore, but every method is
// now async. All DB work routes to ONE channel: a browser Web Worker running
// sqlite-wasm over OPFS (opfs-sahpool) — transactions persist page-level as
// they commit, and the heavy operations never touch Obsidian's main thread.
//
// 历史通道已全部移除（用户拍板「去掉 sqljs，只用 OPFS」）：node
// worker_threads 在 Electron 渲染进程从来建不成（V8 平台无 worker 支持），
// sqljs 主线程回退则把真故障掩盖成慢——现在 browser worker 起不来就大声
// 失败，绝不静默降级。

import { join } from "path";
import { debugLog } from "./log";
import type { NoteChunk, SearchResult, QueueAction, QueueItem } from "./types";
import type { ChunkResult } from "./chunker";

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
	private reqId = 0;
	private pending = new Map<number, PendingRequest>();
	private browserWorker: Worker | null = null;
	/** 历史 node worker 通道已移除：永远 null（保留字段维持 stats 契约）。 */
	lastNodeWorkerError: string | null = null;
	/** browser worker 初始化失败原因（含栈头）——init 失败时随异常大声
	 *  抛出，这里留档供 stats 调试响应透出。 */
	lastBrowserWorkerError: string | null = null;

	/** Whether DB work is running off the main thread (browser worker up). */
	get isWorkerMode(): boolean {
		return this.browserWorker != null;
	}

	/** Where the DB engine runs: browser worker (OPFS) once initialized. */
	get storageMode(): "worker" | "browser-worker" | "sync" {
		return this.browserWorker ? "browser-worker" : "sync";
	}

	constructor(dataDir: string, private browserWorkerUrl?: string) {
		this.dataDir = dataDir;
	}

	async init(): Promise<void> {
		if (!this.browserWorkerUrl || typeof Worker === "undefined") {
			throw new Error(
				"[Semlink] browser worker unavailable (no db-worker.browser.js blob URL / no Worker) — OPFS-only build cannot start",
			);
		}
		try {
			await this.initBrowserWorker(this.browserWorkerUrl);
		} catch (e) {
			// 大声失败，绝不静默降级（用户拍板「去掉 sqljs」）：失败原因落
			// lastBrowserWorkerError 供 stats 透出，异常继续抛——插件加载
			// 失败比一个静默坏掉的存储层诚实得多。
			const msg = e instanceof Error ? e.message : String(e);
			const stack = e instanceof Error ? (e.stack ?? "").slice(0, 600) : "";
			this.lastBrowserWorkerError = msg + (stack ? " | " + stack.split("\n").slice(1, 4).join(" | ") : "");
			console.error("[Semlink] OPFS browser worker init failed:", e);
			throw e;
		}
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
		// own copy already exists (never overwrite a newer OPFS index) —
		// unless a `reseed.requested` marker file sits in the data dir
		// (recovery flow: overwrite OPFS with the disk DB once, marker
		// self-deletes after).
		try {
			const fsMod = (window as unknown as { require?: (id: string) => typeof import("fs") }).require?.("fs");
			const dbPath = join(this.dataDir, "vault.db");
			const markerPath = join(this.dataDir, "reseed.requested");
			const forceSeed = fsMod?.existsSync(markerPath) ?? false;
			if (fsMod?.existsSync(dbPath)) {
				const res = await this.call<{ seeded: boolean; force: boolean; existingBytes: number; seedBytes: number }>(
					"seedDb",
					[new Uint8Array(fsMod.readFileSync(dbPath)), forceSeed],
				);
				debugLog(`[Semlink] OPFS seed: ${JSON.stringify(res)}`);
			}
			if (forceSeed) fsMod?.unlinkSync(markerPath);
		} catch (seedErr) {
			console.warn("[Semlink] OPFS seed skipped:", seedErr);
		}
		// The browser entry ignores the passed dataDir and uses the OPFS
		// namespace root as its virtual root. mode="wasm"：sqlite3-wasm +
		// opfs-sahpool（事务即落盘；旧 sql.js 库由驱动自动迁移进 sahpool）。
		await this.call("init", ["", "wasm"]);
		debugLog("[Semlink] VectorStore running in browser worker mode — DB engine is off the main thread");

		// 迁移收尾（用户拍板「迁移完成自动删除 data/vault.db 与 vault.db.bak-*」）：
		// init 成功 = 驱动首开守卫已确认活槽；再验 indexedNotes>0——OPFS 真有
		// 索引才删（防「0 行空壳槽」时误删唯一好副本，历史真实出现过）。磁盘
		// 旧库/手工兜底副本（vault.db.bak-YYYYMMDD）自此退役：它们只被 seedDb
		// 当迁移源，之后每次启动白读 335MB 还会被 worker 拒收。删除失败只
		// warn 不影响启动；守卫不满足时保留并留告警，下次 init 再试。
		try {
			const fsMod = (window as unknown as { require?: (id: string) => typeof import("fs") }).require?.("fs");
			const dbPath = join(this.dataDir, "vault.db");
			if (fsMod && fsMod.existsSync(dbPath)) {
				const stats = await this.getStats();
				if (stats.indexedNotes > 0) {
					fsMod.unlinkSync(dbPath);
					console.error(
						`[Semlink][migdbg] legacy disk vault.db deleted (OPFS holds ${stats.indexedNotes} indexed notes — disk copy retired)`,
					);
					const names = fsMod.readdirSync(this.dataDir) as string[];
					for (const n of names) {
						if (/^vault\.db\.bak-/.test(n)) {
							fsMod.unlinkSync(join(this.dataDir, n));
							console.error(`[Semlink][migdbg] legacy disk backup deleted: ${n}`);
						}
					}
				} else {
					console.warn(
						"[Semlink][migdbg] legacy disk vault.db kept — OPFS slot has no indexed notes yet; will retry next init",
					);
				}
			}
		} catch (e) {
			console.warn("[Semlink] legacy disk cleanup skipped:", e);
		}
	}

	/** Send one op to the worker and await its reply. */
	private call<T = unknown>(op: string, args: unknown[] = []): Promise<T> {
		if (!this.browserWorker) {
			return Promise.reject(new Error(`[Semlink] VectorStore not initialized (op=${op})`));
		}
		return new Promise((resolve, reject) => {
			const reqId = ++this.reqId;
			this.pending.set(reqId, { resolve, reject });
			this.browserWorker!.postMessage({ reqId, op, args });
		});
	}

	// ──── Public API (all async now) ────

	async save(): Promise<void> { await this.call("save"); }
	async clearAll(): Promise<void> { await this.call("clearAll"); }
	/** 嵌入模型变更：清向量保留块，并重置 mtime 让全量笔记重走嵌入。 */
	async clearVectors(): Promise<void> { await this.call("clearVectors"); }
	async compact(): Promise<void> { await this.call("compact"); }
	/** 持久化诊断（丢数据取证）：journal/synchronous/flushed 槽字节数 vs
	 *  引擎整库字节数——差值 = 未落盘窗口（仅 wasm 模式）。 */
	async durability(): Promise<unknown> { return await this.call("durability"); }
	/** 立即写一次耐久快照（绕过 ≥10min 节流），带回错误详情。 */
	async snapshotNow(): Promise<unknown> { return await this.call("snapshotNow"); }

	/**
	 * Close + flush + terminate. Sends a `close` op (worker performs save()
	 * then db.close(), so data lands in OPFS even though the host's
	 * onunload() is not awaited), then ALWAYS terminates the worker: its
	 * death is what releases the OPFS sync access handles. 真机 2026-11-12：
	 * 只发 close 不 terminate，禁用/重载插件后旧 worker 活着拖住全部句柄，
	 * 下次 init 的 createSyncAccessHandle 直接 NoModificationAllowedError
	 * ——插件加载失败。给落盘至多 3s，超时也照样 terminate。
	 */
	async close(): Promise<void> {
		const w = this.browserWorker;
		if (!w) return;
		try {
			await Promise.race([
				this.call("close", []),
				new Promise((r) => setTimeout(r, 3000)),
			]);
		} catch {
			/* worker already gone */
		}
		this.browserWorker = null;
		try {
			w.terminate();
		} catch {
			/* already gone */
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
	/** 内容未变只推 mtime（update 短路用），避免无意义重嵌。 */
	async touchNoteMtime(notePath: string, mtime: number): Promise<void> {
		return await this.call<void>("touchNoteMtime", [notePath, mtime]);
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
	async purgeRedundantQueue(entries: Array<{ path: string; mtime: number }>): Promise<number> {
		return await this.call<number>("purgeRedundantQueue", [entries]);
	}

	/** 整库字节导出（Data folder「Open」用；~400MB 跨 worker 拷贝） */
	async exportDb(): Promise<Uint8Array> {
		return await this.call<Uint8Array>("exportDb");
	}

	/** 最近一次索引写入时间（RAG 统计第 4 格「更新时间」） */
	async lastIndexTime(): Promise<number | null> {
		return await this.call<number | null>("lastIndexTime");
	}

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

	/** 「已跳过」标记/计数（见 db-engine.markEmbedSkip 注释）。 */
	async markEmbedSkip(notePath: string, skipped: boolean): Promise<void> {
		await this.call<void>("markEmbedSkip", [notePath, skipped]);
	}

	async getEmbedSkippedNoteCount(): Promise<number> {
		return await this.call<number>("getEmbedSkippedNoteCount");
	}

	/** 诊断：缺向量笔记清单（见 db-engine.listVectorlessNotes）。 */
	async listVectorlessNotes(limit = 10): Promise<Array<{ notePath: string; chunks: number }>> {
		return await this.call<Array<{ notePath: string; chunks: number }>>("listVectorlessNotes", [limit]);
	}
	/** 诊断：缺向量笔记总数（整篇无向量才可疑；稀疏块无向量是设计行为）。 */
	async countVectorlessNotes(): Promise<number> {
		return await this.call<number>("countVectorlessNotes");
	}
	/** 诊断：队列 action×status 计数 + 重复 pending + 最老 pending 年龄。 */
	async queueDiagnostics(): Promise<{
		byActionStatus: Array<{ action: string; status: string; count: number }>;
		duplicatePending: Array<{ notePath: string; rows: number }>;
		oldestPendingAgeSec: number | null;
	}> {
		return await this.call("queueDiagnostics");
	}

	/** 诊断：OPFS 命名空间文件清单（仅 browser-worker 通道实现；sync 模式
	 *  无 OPFS，直接报不可用）。排查「索引清零」时确认原库还在命名空间里。 */
	async fsList(): Promise<Array<{ name: string; size: number }> | { error: string }> {
		if (this.storageMode !== "browser-worker") {
			return { error: `fsList is only available in browser-worker mode (current: ${this.storageMode})` };
		}
		return await this.call<Array<{ name: string; size: number }>>("fsList");
	}

	/** 诊断：解析 OPFS vault.db 的 SQLite 头（页数/空闲页）。 */
	async fsProbe(): Promise<unknown> {
		if (this.storageMode !== "browser-worker") {
			return { error: `fsProbe is only available in browser-worker mode (current: ${this.storageMode})` };
		}
		return await this.call("fsProbe");
	}

	/** 补救：删除 OPFS 空壳 vault.db（0 行数据），让下次 init 的 seedDb
	 *  重新从磁盘库播种。仅 browser-worker 模式可用。 */
	async resetOpfsDb(): Promise<{ removed: boolean }> {
		if (this.storageMode !== "browser-worker") {
			throw new Error(`resetOpfsDb is only available in browser-worker mode (current: ${this.storageMode})`);
		}
		return await this.call<{ removed: boolean }>("fsResetDb");
	}

	/** 修复通道（真机 2026-11-11 槽名错位事故）：把 shim 命名空间里的
	 *  pre-wasm.bak（迁移前完整旧索引）原地导入 canonical 槽。worker 内
	 *  读写 bak 字节，不经过主线程。force=true 时活库非空也覆盖。 */
	async repairFromBak(force = false): Promise<{ chunks: number; replaced: boolean; error?: string }> {
		return await this.call<{ chunks: number; replaced: boolean; error?: string }>("repairFromBak", [force]);
	}

	/** 恢复通道：主线程读到的盘库字节（如 data/vault.db 化石）强制播种
	 *  进 shim 命名空间，重载后迁移通道自动导入。 */
	async seedFromBytes(bytes: Uint8Array): Promise<{ seeded: boolean; force: boolean; migrated: boolean; existingBytes: number; seedBytes: number }> {
		return await this.call("seedDb", [bytes, true]);
	}

	/** [审计] 黑匣子回读：最近的 chunks 删除现场（时间 + 剩余行数）。 */
	async auditLog(): Promise<unknown> {
		return await this.call("auditlog");
	}

	async listIndexedNotePaths(): Promise<string[]> {
		return await this.call<string[]>("listIndexedNotePaths");
	}

	/** 一次性回填历史全稀疏笔记的跳过标记（见 db-engine.backfillEmbedSkips）。
	 *  返回本次新标记的篇数。 */
	async backfillEmbedSkips(): Promise<number> {
		return await this.call<number>("backfillEmbedSkips");
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

	async search(queryEmbedding: number[], limit = 10, threshold = 0.3, pathFilter?: string, excludePaths?: string[]): Promise<SearchResult[]> {
		if (!this.searchGate()) return [];
		return await this.call<SearchResult[]>("search", [queryEmbedding, limit, threshold, pathFilter, excludePaths]);
	}

	/** Note→note "related notes" via max-pooling over the source note's chunks
	 *  (see DbEngine.searchRelatedNotes). Runs in the worker. */
	async searchRelatedNotes(notePath: string, limit = 10, threshold = 0.2, maxProbes = 6): Promise<SearchResult[]> {
		if (!this.searchGate()) return [];
		return await this.call<SearchResult[]>("searchRelatedNotes", [notePath, limit, threshold, maxProbes]);
	}

	/** Fast substring search over indexed chunk content (for the grep tool). */
	async textSearch(pattern: string, limit = 200, pathFilter?: string, excludePaths?: string[]): Promise<Array<{ path: string; matchCount: number; preview: string }>> {
		return await this.call<Array<{ path: string; matchCount: number; preview: string }>>("textSearch", [pattern, limit, pathFilter, excludePaths]);
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
