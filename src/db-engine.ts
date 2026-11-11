// ========================================
// Semlink - Core Synchronous DB Engine
// ========================================
// Pure synchronous SQLite (sql.js) engine that owns the real Database handle.
// Used by:
//   1. db-worker.ts  → runs in a worker_threads child (off the main thread)
//   2. VectorStore fallback path → runs synchronously on the main thread when
//      worker_threads is unavailable (degraded mode, never worse than before).
//
// All heavy work (db.export of a 397MB DB, brute-force cosine search, disk
// writes) lives here. Keeping it in one class lets us reuse the exact same code
// for both the worker and the fallback, so behavior is identical either way.

import initSqlJs, { Database as SqlJsDatabase } from "sql.js";
import { debugLog } from "./log";
import { isSparseContent } from "./chunker";
import wasmBase64 from "sql.js/dist/sql-wasm.wasm";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, unlinkSync, statSync } from "fs";
import { join } from "path";
import { SqliteWasmDb, SqlJsSemDb, SemDb, DbMode } from "./sqlite-wasm-driver";
import type { NoteChunk, SearchResult, QueueItem, QueueAction, QueueItemStatus } from "./types";

/** Minimal shape of sql.js exec() results — the package's own typings do not
 *  resolve under this tsconfig, so we declare the boundary ourselves. */
type QueryResult = { columns: string[]; values: unknown[][] };

const EMBEDDING_DIM = 1024;
const BYTES_PER_FLOAT = 4;
const DB_FILE = "vault.db";
const VECTORS_FILE_LEGACY = "vectors.bin";

/** 诊断：在当前上下文里用 sql.js 打开一段 DB 字节并数行——判断「字节
 *  里有数据但 engine 没读到」还是「字节本身是空库」。browser 用 atob
 *  解 wasm（无 Buffer），node 走 Buffer。 */
export async function probeSqliteBytes(buf: Uint8Array): Promise<{
	chunks: number;
	queue: number;
	distinctNotes: number;
	error?: string;
}> {
	try {
		const wasmBinary = typeof Buffer !== "undefined"
			? Buffer.from(wasmBase64 as string, "base64")
			: Uint8Array.from(atob(wasmBase64 as string), (c) => c.charCodeAt(0));
		const SQL = await initSqlJs({ wasmBinary } as Parameters<typeof initSqlJs>[0]);
		const db = new SQL.Database(buf);
		const q = (sql: string): number => {
			const r = db.exec(sql);
			return r.length > 0 && r[0].values.length > 0 ? Number(r[0].values[0][0]) : 0;
		};
		const out = {
			chunks: q("SELECT COUNT(*) FROM chunks"),
			queue: q("SELECT COUNT(*) FROM queue"),
			distinctNotes: q("SELECT COUNT(DISTINCT note_path) FROM chunks"),
		};
		db.close();
		return out;
	} catch (e) {
		return { chunks: -1, queue: -1, distinctNotes: -1, error: e instanceof Error ? `${e.message}`.slice(0, 200) : String(e) };
	}
}

export class DbEngine {
	/** 引擎无关的 DB 句柄：浏览器 Worker = sqlite3-wasm（opfs-sahpool，事务
	 *  即持久）；Node worker / sync fallback = sql.js（内存镜像 + 全量导出，
	 *  历史形态）。两种驱动都实现 SemDb 小接口，engine 其余代码引擎无关。 */
	private db: SemDb | null = null;
	private dbMode: DbMode = "sqljs";
	private dataDir: string;

	// In-memory vector cache for fast search
	private allVectors: Float32Array | null = null;
	private allVectorIds: string[] = [];
	/** 与 allVectorIds 平行的 note_path 数组（loadVectorCache 同步构建）。
	 *  语义检索的路径过滤在打分循环里下推到这个数组——一次扫描返回过滤
	 *  后的精确 topN，无需 over-fetch，元数据查询也只对最终命中做。 */
	private allVectorPaths: string[] = [];
	// Reverse lookup chunk-id → index into allVectors, so searchRelatedNotes
	// can fetch a stored vector by id without re-reading the DB.
	private vectorIdToIndex: Map<string, number> = new Map();
	private cacheLoaded = false;

	// In-memory cache for DOCUMENT-level vectors (one per note, from headings).
	// Separate from the chunk cache above so the two search paths never mix.
	private allDocVectors: Float32Array | null = null;
	private allDocNotePaths: string[] = [];
	private docPathToIndex: Map<string, number> = new Map();
	private docCacheLoaded = false;

	constructor(dataDir: string) {
		this.dataDir = dataDir;
		if (!existsSync(dataDir)) {
			mkdirSync(dataDir, { recursive: true });
		}
	}

	/** The raw driver handle — exposed so the fallback proxy can satisfy any
	 *  legacy direct-db callers during the transition. */
	get rawDb(): SemDb | null {
		return this.db;
	}

	/** mode = 运行形态：
	 *  - "wasm"  : 浏览器 Web Worker → @sqlite.org/sqlite-wasm + opfs-sahpool
	 *              （OPFS 页级持久化，事务即落盘，无全量导出）
	 *  - "sqljs" : Node worker / sync fallback → sql.js + 磁盘文件
	 *              （整库内存镜像，save 全量导出——历史形态，保留兼容） */
	async init(mode: DbMode = "sqljs"): Promise<void> {
		this.dbMode = mode;

		if (mode === "wasm") {
			this.db = await SqliteWasmDb.open();
			this.createTables();
			await this.migrateIfNeeded();
			return;
		}

		// Decode inline WASM base64
		const wasmBinary = Buffer.from(wasmBase64 as string, "base64");
		const SQL = await initSqlJs({ wasmBinary } as Parameters<typeof initSqlJs>[0]);

		const dbPath = join(this.dataDir, DB_FILE);
		// A leftover temp file means a previous write died before rename —
		// discard it (the real DB was untouched by the atomic write).
		const tmpPath = join(this.dataDir, `${DB_FILE}.tmp`);
		if (existsSync(tmpPath)) {
			try { unlinkSync(tmpPath); } catch { /* ignore */ }
		}

		let raw: SqlJsDatabase;
		if (existsSync(dbPath)) {
			try {
				const buf = readFileSync(dbPath);
				raw = new SQL.Database(buf);
			} catch (e) {
				// Corrupted/torn DB (e.g. from a pre-atomic-write crash). Don't
				// silently rebuild — back it up so the data is recoverable, then
				// start fresh. A silent rebuild would re-embed everything anyway.
				console.error("[Semlink] DB load failed, backing up and rebuilding:", e);
				try {
					renameSync(dbPath, `${dbPath}.corrupt-${Date.now()}`);
				} catch { /* ignore */ }
				raw = new SQL.Database();
			}
		} else {
			raw = new SQL.Database();
		}
		this.db = new SqlJsSemDb(raw);

		this.createTables();
		await this.migrateIfNeeded();
	}

	private createTables() {
		this.db!.run(`
			CREATE TABLE IF NOT EXISTS chunks (
				id TEXT PRIMARY KEY,
				note_path TEXT NOT NULL,
				heading TEXT DEFAULT '',
				content TEXT NOT NULL,
				content_preview TEXT DEFAULT '',
				mtime INTEGER NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending_embed',
				vector BLOB DEFAULT NULL,
				created_at INTEGER NOT NULL
			);
		`);

		this.db!.run(`
			CREATE TABLE IF NOT EXISTS queue (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				note_path TEXT NOT NULL,
				action TEXT NOT NULL,
				priority INTEGER DEFAULT 2,
				status TEXT NOT NULL DEFAULT 'pending',
				retries INTEGER DEFAULT 0,
				error TEXT,
				created_at INTEGER NOT NULL
			);
		`);

		this.db!.run(`
			CREATE TABLE IF NOT EXISTS meta (
				key TEXT PRIMARY KEY,
				value TEXT
			);
		`);

		// Document-level vectors: one per note, derived from its heading tree.
		// Kept in a SEPARATE table so it never pollutes the chunk search cache
		// (loadVectorCache reads chunks.vector) or the note-count stats
		// (getStats counts DISTINCT note_path in chunks).
		this.db!.run(`
			CREATE TABLE IF NOT EXISTS note_doc_vectors (
				note_path TEXT PRIMARY KEY,
				vector BLOB NOT NULL,
				mtime INTEGER NOT NULL,
				heading_text TEXT DEFAULT ''
			);
			CREATE TABLE IF NOT EXISTS embed_skips (
				note_path TEXT PRIMARY KEY
			);
		`);

		// Create indexes
		this.db!.run("CREATE INDEX IF NOT EXISTS idx_chunks_note_path ON chunks (note_path)");
		this.db!.run("CREATE INDEX IF NOT EXISTS idx_chunks_status ON chunks (status)");
		this.db!.run("CREATE INDEX IF NOT EXISTS idx_queue_status ON queue (status, priority)");
	}

	/** Migrate from old vector_offset + vectors.bin to BLOB storage */
	private async migrateIfNeeded(): Promise<void> {
		// Check if old vector_offset column exists
		const colCheck = this.db!.exec("PRAGMA table_info(chunks)") as unknown as QueryResult[];
		if (colCheck.length === 0) return;

		const columns = colCheck[0].values.map(row => row[1] as string);
		const hasVectorOffset = columns.includes("vector_offset");
		const hasVectorBlob = columns.includes("vector");

		if (!hasVectorOffset) return; // New schema, no migration needed

		debugLog("[Semlink] Migrating from vectors.bin to SQLite BLOB...");

		// Add vector BLOB column if not present
		if (!hasVectorBlob) {
			this.db!.run("ALTER TABLE chunks ADD COLUMN vector BLOB DEFAULT NULL");
		}

		// Migrate data from vectors.bin if it exists
		const vecPath = join(this.dataDir, VECTORS_FILE_LEGACY);
		if (existsSync(vecPath)) {
			const buf = readFileSync(vecPath);
			const allVecData = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / BYTES_PER_FLOAT);

			// Get all chunks with valid vector_offset
			const results = this.db!.exec(
				"SELECT id, vector_offset FROM chunks WHERE vector_offset >= 0"
			);

			if (results.length > 0) {
				for (const row of results[0].values) {
					const id = row[0] as string;
					const offset = row[1] as number;
					const start = offset * EMBEDDING_DIM;
					const end = start + EMBEDDING_DIM;
					if (end <= allVecData.length) {
						const vecBuf = Buffer.from(allVecData.buffer, start * BYTES_PER_FLOAT, EMBEDDING_DIM * BYTES_PER_FLOAT);
						this.db!.run(
							"UPDATE chunks SET vector = ? WHERE id = ?",
							[vecBuf, id]
						);
					}
				}
			}

			// Delete legacy vectors.bin
			unlinkSync(vecPath);
			debugLog("[Semlink] Migration complete, vectors.bin deleted");
		}

		// Drop old column by recreating table (SQLite doesn't support DROP COLUMN reliably)
		this.rebuildTableWithoutVectorOffset();
		this.save();
	}

	/** Recreate chunks table without vector_offset column */
	private rebuildTableWithoutVectorOffset(): void {
		this.db!.run("ALTER TABLE chunks RENAME TO chunks_old");

		this.db!.run(`
			CREATE TABLE chunks (
				id TEXT PRIMARY KEY,
				note_path TEXT NOT NULL,
				heading TEXT DEFAULT '',
				content TEXT NOT NULL,
				content_preview TEXT DEFAULT '',
				mtime INTEGER NOT NULL,
				status TEXT NOT NULL DEFAULT 'pending_embed',
				vector BLOB DEFAULT NULL,
				created_at INTEGER NOT NULL
			);
		`);

		this.db!.run(`
			INSERT INTO chunks (id, note_path, heading, content, content_preview, mtime, status, vector, created_at)
			SELECT id, note_path, heading, content, content_preview, mtime, status, vector, created_at
			FROM chunks_old
		`);

		this.db!.run("DROP TABLE chunks_old");
		this.db!.run("CREATE INDEX IF NOT EXISTS idx_chunks_note_path ON chunks (note_path)");
		this.db!.run("CREATE INDEX IF NOT EXISTS idx_chunks_status ON chunks (status)");
	}

	/** Persist the in-memory DB to disk. Runs entirely off the main thread in
	 *  worker mode (db.export + write of a ~400MB file).
	 *
	 *  ATOMIC WRITE: write to a temp file in the same directory, then rename
	 *  over the real DB. rename() is atomic on the same filesystem — if the
	 *  process dies mid-write (Obsidian reload, power loss), the old DB file
	 *  stays intact instead of being left truncated/corrupted. A torn DB was
	 *  the root cause of "all chunks re-indexed after every reload" (mtime
	 *  lookups returned nothing → everything treated as new). */
	save(): void {
		if (!this.db) return;
		if (this.dbMode === "wasm") {
			// sqlite3-wasm/opfs-sahpool：事务提交即页级落盘，无"保存"概念。
			// 委托驱动做周期维护（PRAGMA optimize）。
			this.db.save();
			return;
		}
		// sqljs 分支（sync fallback / Node worker）：空库保险丝 + 全量导出
		// + tmp+rename 原子写。rename 同目录原子——进程死于写中时旧库完好
		// （"重载后全部重索引"的历史根因防护，保留）。
		const dbPath = join(this.dataDir, DB_FILE);
		if (existsSync(dbPath)) {
			const diskSize = statSync(dbPath).size;
			let memoryChunks = 0;
			try {
				const r = this.db.exec("SELECT COUNT(*) FROM chunks");
				memoryChunks = r.length > 0 && r[0].values.length > 0 ? Number(r[0].values[0][0]) : 0;
			} catch { /* 表还没建：按 0 处理 */ }
			if (memoryChunks === 0 && diskSize > 100 * 1024 * 1024) {
				console.error(`[Semlink] save() REFUSED: in-memory DB has 0 chunks but ${dbPath} is ${(diskSize / 1048576).toFixed(0)}MB — refusing to overwrite a large index with an empty DB (load must have failed upstream).`);
				return;
			}
		}
		const data = this.db.export();
		const tmpPath = join(this.dataDir, `${DB_FILE}.tmp`);
		writeFileSync(tmpPath, data);
		renameSync(tmpPath, dbPath);
	}

	/** Clear all stored data (chunks, queue, vectors) for a full rebuild */
	clearAll(): void {
		if (!this.db) return;
		this.db.run("DELETE FROM chunks");
		this.db.run("DELETE FROM queue");
		this.db.run("DELETE FROM meta");
		this.db.run("DELETE FROM note_doc_vectors");
		this.db.run("DELETE FROM embed_skips");
		this.allVectors = null;
		this.allVectorIds = [];
		this.allVectorPaths = [];
		this.cacheLoaded = false;
		this.allDocVectors = null;
		this.allDocNotePaths = [];
		this.docPathToIndex.clear();
		this.docCacheLoaded = false;

		// Delete legacy vectors.bin if it still exists
		const vecPath = join(this.dataDir, VECTORS_FILE_LEGACY);
		if (existsSync(vecPath)) {
			unlinkSync(vecPath);
		}

		this.save();
	}

	/** 嵌入模型变更：只清向量与文档向量（保留 chunks），并把存储的 mtime
	 *  一并清空——扫描会将全部笔记视为新文件重走 add 流程，从而用新模型
	 *  完成全量重嵌（"保留块 + 标记待嵌入"的落地）。 */
	clearVectors(): void {
		if (!this.db) return;
		this.db.run("UPDATE chunks SET status = 'pending_embed', vector = NULL WHERE vector IS NOT NULL OR status = 'active'");
		this.db.run("DELETE FROM note_doc_vectors");
		this.db.run("DELETE FROM meta");
		this.allVectors = null;
		this.allVectorIds = [];
		this.allVectorPaths = [];
		this.cacheLoaded = false;
		this.allDocVectors = null;
		this.allDocNotePaths = [];
		this.docPathToIndex.clear();
		this.docCacheLoaded = false;
		this.save();
	}

	/** Compact database to reclaim disk space */
	compact(): void {
		if (!this.db) return;
		this.db.run("VACUUM");
		this.save();
	}

	close(): void {
		this.save();
		this.db?.close();
		this.db = null;
		this.allVectors = null;
		this.allVectorIds = [];
		this.allVectorPaths = [];
		this.cacheLoaded = false;
		this.allDocVectors = null;
		this.allDocNotePaths = [];
		this.docPathToIndex.clear();
		this.docCacheLoaded = false;
	}

	// ──── Chunk CRUD ────

	// Nested-safe transactions: concurrent note processing interleaves
	// begin/commit, so the outermost begin issues BEGIN, nested ones issue
	// SAVEPOINTs — each note commits/rolls back independently.
	private txDepth = 0;

	beginTransaction(): void {
		if (this.txDepth === 0) this.db!.run("BEGIN TRANSACTION");
		else this.db!.run(`SAVEPOINT tx_${this.txDepth}`);
		this.txDepth++;
	}

	commitTransaction(): void {
		if (this.txDepth === 0) return;
		this.txDepth--;
		if (this.txDepth === 0) this.db!.run("COMMIT");
		else this.db!.run(`RELEASE SAVEPOINT tx_${this.txDepth}`);
	}

	rollbackTransaction(): void {
		if (this.txDepth === 0) return;
		this.txDepth--;
		try {
			if (this.txDepth === 0) this.db!.run("ROLLBACK");
			else {
				this.db!.run(`ROLLBACK TO SAVEPOINT tx_${this.txDepth}`);
				this.db!.run(`RELEASE SAVEPOINT tx_${this.txDepth}`);
			}
		} catch (e) {
			// SQLite auto-rolls-back the WHOLE transaction on OOM/FULL-class
			// errors, and a savepoint can vanish after an interleaved release —
			// either way the state is no longer trackable. Reset the depth so
			// the next begin opens a fresh transaction instead of stacking
			// savepoints onto an unknown one. Swallowed: the ORIGINAL failure
			// (already en route to the caller) must not be masked by a
			// "cannot rollback - no transaction is active" from here.
			this.txDepth = 0;
			debugLog("[Semlink] rollbackTransaction fell back to fresh state:", e);
		}
	}

	insertChunk(chunk: NoteChunk): void {
		const preview = chunk.contentPreview || chunk.content.slice(0, 200);
		this.db!.run(
			`INSERT OR REPLACE INTO chunks (id, note_path, heading, content, content_preview, mtime, status, vector, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
			[chunk.id, chunk.notePath, chunk.heading, chunk.content, preview, chunk.mtime, chunk.status, chunk.createdAt]
		);
	}

	getChunksByNotePath(notePath: string): NoteChunk[] {
		const results = this.db!.exec(
			"SELECT id, note_path, heading, content, content_preview, mtime, status, created_at FROM chunks WHERE note_path = ?",
			[notePath]
		);
		return this.mapChunks(results);
	}

	getActiveChunks(): NoteChunk[] {
		const results = this.db!.exec(
			"SELECT id, note_path, heading, content, content_preview, mtime, status, created_at FROM chunks WHERE status = 'active' AND vector IS NOT NULL"
		);
		return this.mapChunks(results);
	}

	getChunkById(id: string): NoteChunk | null {
		const results = this.db!.exec(
			"SELECT id, note_path, heading, content, content_preview, mtime, status, created_at FROM chunks WHERE id = ?",
			[id]
		);
		const chunks = this.mapChunks(results);
		return chunks.length > 0 ? chunks[0] : null;
	}

	markChunksStale(notePath: string): number {
		const result = this.db!.run(
			"UPDATE chunks SET status = 'stale' WHERE note_path = ? AND status = 'active'",
			[notePath]
		);
		return result.changes;
	}

	deleteChunksByNotePath(notePath: string): number {
		const result = this.db!.run(
			"DELETE FROM chunks WHERE note_path = ?",
			[notePath]
		);
		this.db!.run("DELETE FROM note_doc_vectors WHERE note_path = ?", [notePath]);
		this.db!.run("DELETE FROM embed_skips WHERE note_path = ?", [notePath]);
		this.cacheLoaded = false;
		this.docCacheLoaded = false;
		return result.changes;
	}

	deleteStaleChunks(notePath: string): number {
		const result = this.db!.run(
			"DELETE FROM chunks WHERE note_path = ? AND status = 'stale'",
			[notePath]
		);
		this.cacheLoaded = false;
		return result.changes;
	}

	/** Rename all chunks from oldPath to newPath (no re-embedding needed) */
	renameNotePath(oldPath: string, newPath: string): number {
		const result = this.db!.run(
			"UPDATE chunks SET note_path = ? WHERE note_path = ?",
			[newPath, oldPath]
		);
		const docResult = this.db!.run(
			"UPDATE note_doc_vectors SET note_path = ? WHERE note_path = ?",
			[newPath, oldPath]
		);
		if (result.changes > 0 || docResult.changes > 0) {
			this.cacheLoaded = false;
			this.docCacheLoaded = false;
		}
		return result.changes;
	}

	getNoteMtime(notePath: string): number | null {
		const results = this.db!.exec(
			"SELECT MAX(mtime) as mtime FROM chunks WHERE note_path = ?",
			[notePath]
		);
		if (results.length > 0 && results[0].values.length > 0) {
			const val = results[0].values[0][0];
			return val ? (val as number) : null;
		}
		return null;
	}

	/** 只推 mtime 不动内容/向量：扫描按 file.mtime > MAX(chunk.mtime) 判
	 *  「已修改」，外部同步工具/系统常摸文件但不改内容——processNote 重
	 *  分块后逐块比对相同即走这里，避免无意义的全量重嵌（API 调用）。 */
	touchNoteMtime(notePath: string, mtime: number): void {
		this.db!.run("UPDATE chunks SET mtime = ? WHERE note_path = ?", [mtime, notePath]);
	}

	/** 有 active chunk 但全部无向量的笔记总数（诊断：「一直嵌入」是否
	 *  由「无向量笔记被反复补嵌」驱动——注意稀疏表格块本就该无向量，
	 *  只有整篇无向量才可疑）。 */
	countVectorlessNotes(): number {
		const r = this.db!.exec(
			`SELECT COUNT(DISTINCT note_path) FROM chunks c
			 WHERE c.status = 'active'
			   AND NOT EXISTS (SELECT 1 FROM chunks c2 WHERE c2.note_path = c.note_path AND c2.status = 'active' AND c2.vector IS NOT NULL)`,
		);
		return r.length > 0 && r[0].values.length > 0 ? Number(r[0].values[0][0]) : 0;
	}

	/** 队列诊断（debug 工具）：action×status 计数、同一笔记多条 pending
	 *  （反复入队的直接证据）、最老 pending 行年龄。定位「无新文档却
	 *  一直索引」：残留行跨重载存活、扫描只清 completed/failed。 */
	queueDiagnostics(): {
		byActionStatus: Array<{ action: string; status: string; count: number }>;
		duplicatePending: Array<{ notePath: string; rows: number }>;
		oldestPendingAgeSec: number | null;
	} {
		const byActionStatus: Array<{ action: string; status: string; count: number }> = [];
		const r1 = this.db!.exec("SELECT action, status, COUNT(*) FROM queue GROUP BY action, status ORDER BY COUNT(*) DESC");
		if (r1.length > 0) {
			for (const row of r1[0].values) {
				byActionStatus.push({ action: String(row[0]), status: String(row[1]), count: Number(row[2]) });
			}
		}
		const duplicatePending: Array<{ notePath: string; rows: number }> = [];
		const r2 = this.db!.exec(
			"SELECT note_path, COUNT(*) FROM queue WHERE status = 'pending' GROUP BY note_path HAVING COUNT(*) > 1 ORDER BY COUNT(*) DESC LIMIT 10",
		);
		if (r2.length > 0) {
			for (const row of r2[0].values) {
				duplicatePending.push({ notePath: String(row[0]), rows: Number(row[1]) });
			}
		}
		let oldestPendingAgeSec: number | null = null;
		const r3 = this.db!.exec("SELECT MIN(created_at) FROM queue WHERE status = 'pending'");
		if (r3.length > 0 && r3[0].values.length > 0 && r3[0].values[0][0]) {
			oldestPendingAgeSec = Math.max(0, Math.round((Date.now() - Number(r3[0].values[0][0])) / 1000));
		}
		return { byActionStatus, duplicatePending, oldestPendingAgeSec };
	}

	getAllIndexedPaths(): Set<string> {
		const results = this.db!.exec("SELECT DISTINCT note_path FROM chunks WHERE status = 'active'");
		const paths = new Set<string>();
		if (results.length > 0) {
			for (const row of results[0].values) {
				paths.add(row[0] as string);
			}
		}
		return paths;
	}

	/**
	 * Remove chunks for note paths that no longer exist in the vault.
	 * Called after a full scan with the set of currently-existing paths:
	 * any indexed path NOT in that set is a "ghost" left over from a file
	 * that was moved, renamed, or deleted without the watcher catching it
	 * (e.g. moves done while the plugin was disabled). Deleting them keeps
	 * the DB from ballooning (seen: 397MB→802MB after reorganizing files)
	 * and stops search from returning dead paths.
	 * Returns the number of removed paths.
	 */
	pruneOrphanedPaths(existingPaths: Set<string>): number {
		const indexed = this.getAllIndexedPaths();
		let removed = 0;
		for (const path of indexed) {
			if (!existingPaths.has(path)) {
				this.db!.run("DELETE FROM chunks WHERE note_path = ?", [path]);
				this.db!.run("DELETE FROM note_doc_vectors WHERE note_path = ?", [path]);
				removed++;
			}
		}
		if (removed > 0) {
			this.cacheLoaded = false;
			this.docCacheLoaded = false;
		}
		return removed;
	}

	/**
	 * Clean up queue rows that are no longer meaningful:
	 * - completed / failed rows from earlier runs (they only served their
	 *   purpose; leaving them makes the queue balloon and repeated scans
	 *   re-process stale entries).
	 * Returns the number of rows deleted.
	 */
	cleanupQueue(): number {
		const before = this.queueCount();
		this.db!.run("DELETE FROM queue WHERE status IN ('completed', 'failed')");
		const after = this.queueCount();
		return before - after;
	}

	/**
	 * Revive queue rows stuck at 'processing' — left behind when a run was
	 * interrupted by a reload/crash mid-index. They are unreachable in the
	 * normal flow: dequeue only takes 'pending' and enqueue dedupes against
	 * 'processing', so the affected notes would be re-scanned forever but
	 * never re-processed (progress frozen at e.g. 788/865). Returns the
	 * number of rows reset to 'pending'.
	 */
	reviveProcessing(): number {
		const r = this.db!.exec("SELECT COUNT(*) FROM queue WHERE status = 'processing'");
		const stuck = r.length > 0 ? (r[0].values[0][0] as number) : 0;
		if (stuck > 0) {
			this.db!.run("UPDATE queue SET status = 'pending' WHERE status = 'processing'");
		}
		return stuck;
	}

	/**
	 * Remove queue rows whose note_path no longer exists in the vault
	 * (files moved/renamed/deleted outside the watcher's view). These ghost
	 * entries otherwise keep re-enqueueing forever.
	 * Returns the number of rows deleted.
	 */
	purgeGhostQueue(existingPaths: Set<string>): number {
		const rows = this.db!.exec("SELECT id, note_path FROM queue") as unknown as QueryResult[];
		if (rows.length === 0) return 0;
		let removed = 0;
		for (const row of rows[0].values) {
			const path = row[1] as string;
			if (!existingPaths.has(path)) {
				this.db!.run("DELETE FROM queue WHERE id = ?", [row[0]]);
				removed++;
			}
		}
		return removed;
	}

	private queueCount(): number {
		const r = this.db!.exec("SELECT COUNT(*) FROM queue");
		return r.length > 0 ? (r[0].values[0][0] as number) : 0;
	}

	/** 已嵌入（至少一个 chunk 带向量）的笔记数 — 进度面板/引导页的「已嵌入」
	 *  口径。与文档向量表不同，chunk 向量不会被算法迁移或补算重置清空，
	 *  且与笔记嵌入同事务落库——进度只增不减，不出现迁移期归零。 */
	getEmbeddedNoteCount(): number {
		const r = this.db!.exec(
			"SELECT COUNT(DISTINCT note_path) FROM chunks WHERE status = 'active' AND vector IS NOT NULL",
		);
		return r.length > 0 ? (r[0].values[0][0] as number) : 0;
	}

	/** 「已跳过」标记（用户拍板"嵌入进度要包含已跳过"）：索引时判定该笔记
	 *  没有可嵌入内容（空文件 / 全稀疏分块——表格壳、纯分隔线、空白），
	 *  永远不会产生向量。这类笔记不算待嵌入也不拖累进度：嵌入进度 =
	 *  (已嵌入 + 已跳过) / 笔记总数。重索引同笔记时按新内容覆写/清除。 */
	markEmbedSkip(notePath: string, skipped: boolean): void {
		if (!this.db) return;
		this.skipCountCache = null;
		if (skipped) {
			this.db.run("INSERT OR REPLACE INTO embed_skips (note_path) VALUES (?)", [notePath]);
		} else {
			this.db.run("DELETE FROM embed_skips WHERE note_path = ?", [notePath]);
		}
	}

	/** 「已跳过」精确计数：标记表里"仍然成立"的行——笔记仍有 active chunk
	 *  且一个向量都没有。COUNT(*) 会把陈旧标记算进来（笔记重嵌拿到向量
	 *  后标记未清、已删笔记残留），出现 Embedded+Skipped > Indexed 对不上
	 *  账（用户截图红框）。
	 *  性能契约（2026-11-10 实测教训）：精确 SQL 是 chunks 全表一遍 GROUP
	 *  BY（59k+ 行、sql.js 无 JIT，数百 ms），而本计数被多个 UI 订阅随
	 *  进度事件高频触发——直接查询会把 worker 占满、嵌入 RPC 全部排队，
		设置卡/进度整屏冻住（用户报"卡住"）。所以带 30s TTL 缓存：worker
	 *  至多每 30s 算一次精确值，其余走缓存；markEmbedSkip/saveEmbeddings
	 *  即时失效，标记变化立刻反映。 */
	private skipCountCache: { value: number; at: number } | null = null;
	private static SKIP_COUNT_TTL_MS = 30_000;
	getEmbedSkippedNoteCount(): number {
		const now = Date.now();
		if (this.skipCountCache && now - this.skipCountCache.at < DbEngine.SKIP_COUNT_TTL_MS) {
			return this.skipCountCache.value;
		}
		const r = this.db!.exec(
			`SELECT COUNT(*) FROM (
			   SELECT c.note_path,
					  SUM(CASE WHEN c.vector IS NOT NULL THEN 1 ELSE 0 END) AS vec
			   FROM chunks c
			   WHERE c.status = 'active'
			   GROUP BY c.note_path
			 ) t
			 JOIN embed_skips s ON s.note_path = t.note_path
			 WHERE t.vec = 0`,
		);
		const value = r.length > 0 ? (r[0].values[0][0] as number) : 0;
		this.skipCountCache = { value, at: now };
		return value;
	}

	/** 诊断：有 active chunk 但一个向量都没有的笔记（缺向量清单，含每篇
	 *  chunk 数）——"卡在 99.8%" 时定位到底是哪几篇、chunk 多大。 */
	listVectorlessNotes(limit = 10): Array<{ notePath: string; chunks: number }> {
		const r = this.db!.exec(
			`SELECT c.note_path, COUNT(*) FROM chunks c
			 WHERE c.status = 'active'
			   AND NOT EXISTS (SELECT 1 FROM chunks c2 WHERE c2.note_path = c.note_path AND c2.status = 'active' AND c2.vector IS NOT NULL)
			 GROUP BY c.note_path LIMIT ${Math.max(1, Math.min(50, limit | 0))}`,
		);
		if (r.length === 0) return [];
		return r[0].values.map((row) => ({ notePath: String(row[0]), chunks: Number(row[1]) }));
	}

	/** 诊断：DB 里全部已索引笔记路径（active chunk 的 distinct note_path）
	 *  ——与 vault 活清单做差集，定位"总数 982 但永远 980"缺的是哪几篇。 */
	listIndexedNotePaths(): string[] {
		const r = this.db!.exec("SELECT DISTINCT note_path FROM chunks WHERE status = 'active'");
		if (r.length === 0) return [];
		return r[0].values.map((row) => String(row[0]));
	}

	/** 一次性回填 embed_skips：embed_skips 功能上线前就已索引完成的全稀疏
	 *  笔记（表格壳/纯分隔线/空白）——调度器只重跑有变动的笔记，这些旧笔记
	 *  既产生不了向量也等不到 skip 标记，嵌入进度永远停在
	 *  (已嵌入)/(总数)（真机实例：974/980=99.4%，已跳过恒 0）。启动时跑
	 *  一遍：候选 = 有 active chunk、零向量、未标记的笔记；逐篇核对内容
	 *  确实全稀疏才标记（有可嵌入内容的漏嵌笔记不碰，交给嵌入队列）。
	 *  幂等且开销极小——候选集在正常运行后趋近空集。返回新标记篇数。 */
	backfillEmbedSkips(): number {
		if (!this.db) return 0;
		const rows = this.db.exec(
			`SELECT note_path, content FROM chunks
			 WHERE status = 'active'
			   AND note_path NOT IN (SELECT note_path FROM embed_skips)
			   AND note_path NOT IN (
			     SELECT DISTINCT note_path FROM chunks
			     WHERE status = 'active' AND vector IS NOT NULL)`,
		);
		if (rows.length === 0 || rows[0].values.length === 0) return 0;
		const byPath = new Map<string, string[]>();
		for (const [path, content] of rows[0].values as Array<[string, string]>) {
			const list = byPath.get(path);
			if (list) list.push(content);
			else byPath.set(path, [content]);
		}
		let marked = 0;
		for (const [path, contents] of byPath) {
			if (!contents.every((c) => isSparseContent(c))) continue;
			this.db.run("INSERT OR REPLACE INTO embed_skips (note_path) VALUES (?)", [path]);
			marked++;
		}
		return marked;
	}

	getStats(): { totalChunks: number; activeChunks: number; embeddedChunks: number; indexedNotes: number; dbSizeMb: number } {
		let totalChunks = 0, activeChunks = 0, embeddedChunks = 0;
		const r1 = this.db!.exec("SELECT COUNT(*) FROM chunks");
		if (r1.length > 0) totalChunks = r1[0].values[0][0] as number;

		const r2 = this.db!.exec("SELECT COUNT(*) FROM chunks WHERE status = 'active'");
		if (r2.length > 0) activeChunks = r2[0].values[0][0] as number;

		const r2b = this.db!.exec("SELECT COUNT(*) FROM chunks WHERE status = 'active' AND vector IS NOT NULL");
		if (r2b.length > 0) embeddedChunks = r2b[0].values[0][0] as number;

		const r3 = this.db!.exec("SELECT COUNT(DISTINCT note_path) FROM chunks WHERE status = 'active'");
		const indexedNotes = r3.length > 0 ? (r3[0].values[0][0] as number) : 0;

		let dbSizeMb = 0;
		if (this.dbMode === "wasm") {
			// wasm 驱动：库驻留 OPFS（无磁盘路径）→ 用页数×页大小算体积
			dbSizeMb = Math.round(((this.db as SqliteWasmDb).bytesTotal / (1024 * 1024)) * 10) / 10;
		} else {
			try { dbSizeMb = statSync(join(this.dataDir, DB_FILE)).size / (1024 * 1024); } catch { /* file gone */ }
		}

		return { totalChunks, activeChunks, embeddedChunks, indexedNotes, dbSizeMb: Math.round(dbSizeMb * 10) / 10 };
	}

	// ──── Vector Storage (SQLite BLOB) ────

	/**
	 * Save embeddings directly to SQLite BLOB.
	 * Each embedding = EMBEDDING_DIM × Float32 = 4096 bytes.
	 */
	saveEmbeddings(chunkIds: string[], embeddings: number[][]): void {
		this.skipCountCache = null; // 向量落库改变"零向量笔记"集合 → 精确跳过计数失效重算
		for (let i = 0; i < chunkIds.length; i++) {
			const embedding = embeddings[i];
			if (!embedding) continue; // 无向量（纯文本索引）→ 保持 vector 为 NULL
			const vec = new Float32Array(EMBEDDING_DIM);
			for (let j = 0; j < Math.min(embedding.length, EMBEDDING_DIM); j++) {
				vec[j] = embeddings[i][j];
			}
			const blob = Buffer.from(vec.buffer);
			this.db!.run(
				"UPDATE chunks SET status = 'active', vector = ? WHERE id = ?",
				[blob, chunkIds[i]]
			);
		}
		this.cacheLoaded = false;
	}

	/** Save a document-level vector (derived from the note's heading tree).
	 *  One row per note, keyed by note_path. Mirrors saveEmbeddings'
	 *  Float32Array → Buffer → BLOB serialization. */
	saveDocEmbedding(notePath: string, embedding: number[], mtime: number, headingText: string): void {
		const vec = new Float32Array(EMBEDDING_DIM);
		for (let j = 0; j < Math.min(embedding.length, EMBEDDING_DIM); j++) {
			vec[j] = embedding[j];
		}
		const blob = Buffer.from(vec.buffer);
		this.db!.run(
			"INSERT OR REPLACE INTO note_doc_vectors (note_path, vector, mtime, heading_text) VALUES (?, ?, ?, ?)",
			[notePath, blob, mtime, headingText]
		);
		this.docCacheLoaded = false;
	}

	/**
	 * Load all vectors into a contiguous Float32Array for fast search.
	 */
	loadVectorCache(): void {
		if (this.cacheLoaded) return;

		const results = this.db!.exec(
			"SELECT id, note_path, vector FROM chunks WHERE status = 'active' AND vector IS NOT NULL"
		);

		if (results.length === 0 || results[0].values.length === 0) {
			this.allVectors = new Float32Array(0);
			this.allVectorIds = [];
			this.allVectorPaths = [];
			// Do NOT set cacheLoaded here. This path runs when no vectors exist
			// yet — often at startup, before indexing/embedding finishes. If we
			// cached the empty state, every later search would run against an
			// empty cache and silently return no results (even after vectors
			// are written to the DB). Leaving cacheLoaded false lets the next
			// search retry the load once vectors are available.
			return;
		}

		const rows = results[0].values;
		const numVectors = rows.length;
		const ids: string[] = [];
		const paths: string[] = [];
		const allVec = new Float32Array(numVectors * EMBEDDING_DIM);
		this.vectorIdToIndex.clear();

		for (let i = 0; i < numVectors; i++) {
			const id = rows[i][0] as string;
			const blob = rows[i][2] as Uint8Array;
			ids.push(id);
			paths.push((rows[i][1] as string) ?? "");
			this.vectorIdToIndex.set(id, i);

			// Copy blob bytes into the contiguous array
			const vecView = new Float32Array(blob.buffer, blob.byteOffset, EMBEDDING_DIM);
			allVec.set(vecView, i * EMBEDDING_DIM);
		}

		this.allVectors = allVec;
		this.allVectorIds = ids;
		this.allVectorPaths = paths;
		this.cacheLoaded = true;

		debugLog(`[Semlink] Loaded ${numVectors} vectors into cache (${(numVectors * EMBEDDING_DIM * BYTES_PER_FLOAT / 1024 / 1024).toFixed(1)}MB)`);
	}

	/** Load all DOCUMENT-level vectors into a contiguous Float32Array. Mirrors
	 *  loadVectorCache but for the note_doc_vectors table. Kept separate so
	 *  chunk search and document search never share state. */
	loadDocVectorCache(): void {
		if (this.docCacheLoaded) return;

		const results = this.db!.exec("SELECT note_path, vector FROM note_doc_vectors");

		if (results.length === 0 || results[0].values.length === 0) {
			this.allDocVectors = new Float32Array(0);
			this.allDocNotePaths = [];
			// Do NOT set docCacheLoaded here — same reason as loadVectorCache:
			// at startup the table may be empty before backfill runs, and
			// caching the empty state would make later searches return nothing.
			return;
		}

		const rows = results[0].values;
		const numDocs = rows.length;
		const paths: string[] = [];
		const allVec = new Float32Array(numDocs * EMBEDDING_DIM);
		this.docPathToIndex.clear();

		for (let i = 0; i < numDocs; i++) {
			const np = rows[i][0] as string;
			const blob = rows[i][1] as Uint8Array;
			paths.push(np);
			this.docPathToIndex.set(np, i);
			const vecView = new Float32Array(blob.buffer, blob.byteOffset, EMBEDDING_DIM);
			allVec.set(vecView, i * EMBEDDING_DIM);
		}

		this.allDocVectors = allVec;
		this.allDocNotePaths = paths;
		this.docCacheLoaded = true;
	}

	/** All note paths that already have a document vector (for backfill skip). */
	getDocVectorNotePaths(): Set<string> {
		const results = this.db!.exec("SELECT note_path FROM note_doc_vectors");
		const out = new Set<string>();
		if (results.length > 0) {
			for (const row of results[0].values) out.add(row[0] as string);
		}
		return out;
	}

	/** Migration hook: when the doc-vector algorithm changes (version bumped
	 *  by the scheduler), clear all stale doc vectors so backfill regenerates
	 *  them with the new logic. Version is stored in meta, so this only fires
	 *  once per change. Returns true if a reset happened. */
	prepareDocVectorBackfill(version: number): boolean {
		const r = this.db!.exec("SELECT value FROM meta WHERE key = 'doc_vector_algo_version'");
		const stored = (r.length > 0 && r[0].values.length > 0) ? String(r[0].values[0][0]) : null;
		if (stored === String(version)) return false;
		this.db!.run("DELETE FROM note_doc_vectors");
		this.db!.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('doc_vector_algo_version', ?)", [String(version)]);
		this.docCacheLoaded = false;
		return true;
	}

	/** Document→document similarity: take the source note's doc vector and scan
	 *  every other doc vector by cosine. O(numNotes) — typically sub-millisecond
	 *  for hundreds of notes. This is the symmetric, sampling-free path used
	 *  when the source note has a heading-derived doc vector. */
	searchByDocVector(srcIdx: number, srcNotePath: string, limit: number, threshold: number): SearchResult[] {
		this.loadDocVectorCache();
		if (!this.allDocVectors || this.allDocNotePaths.length === 0) return [];

		const dim = EMBEDDING_DIM;
		const numDocs = this.allDocNotePaths.length;

		// Normalize the source doc vector into a unit query.
		const srcOffset = srcIdx * dim;
		const query = new Float32Array(dim);
		let qNorm = 0;
		for (let j = 0; j < dim; j++) {
			query[j] = this.allDocVectors[srcOffset + j];
			qNorm += query[j] * query[j];
		}
		qNorm = Math.sqrt(qNorm);
		if (qNorm === 0) return [];
		for (let j = 0; j < dim; j++) query[j] /= qNorm;

		// Cosine scan over all other doc vectors (same math as searchSlice).
		const scores: Array<{ index: number; score: number }> = [];
		for (let i = 0; i < numDocs; i++) {
			if (i === srcIdx) continue; // skip self
			const offset = i * dim;
			let dot = 0;
			let normB = 0;
			for (let j = 0; j < dim; j++) {
				const v = this.allDocVectors[offset + j];
				dot += query[j] * v;
				normB += v * v;
			}
			const score = normB > 0 ? dot / Math.sqrt(normB) : 0;
			if (score >= threshold) scores.push({ index: i, score });
		}

		scores.sort((a, b) => b.score - a.score);
		return scores.slice(0, limit).map((s) => ({
			chunkId: "",
			notePath: this.allDocNotePaths[s.index],
			heading: "",
			contentPreview: "",
			score: Math.round(s.score * 10000) / 10000,
		}));
	}

	/**
	 * Semantic search: find top-K chunks most similar to the query vector.
	 * Uses brute-force cosine similarity. This is the other main-thread hot
	 * path — tens of thousands of 1024-dim dot products per query. Running it
	 * in the worker keeps it off the UI thread.
	 *
	 * pathFilter/excludePaths are evaluated INSIDE the scoring loop against
	 * the parallel allVectorPaths array — one scan yields the exact filtered
	 * top-K, with no over-fetch and metadata lookups only for final hits.
	 */
	search(queryEmbedding: number[] | Float32Array, limit = 10, threshold = 0.3, pathFilter?: string, excludePaths?: string[]): SearchResult[] {
		this.loadVectorCache();

		if (!this.allVectors || this.allVectorIds.length === 0) {
			return [];
		}

		const dim = EMBEDDING_DIM;
		const numVectors = this.allVectorIds.length;

		// Normalize query vector
		const query = this.normalizeQuery(queryEmbedding);

		// Path predicates precomputed once (startsWith || includes semantics,
		// matching the index-side isExcluded); lower-cased for matching.
		const lowerPrefix = pathFilter?.toLowerCase();
		const excl = excludePaths
			?.map((e) => e.trim().toLowerCase())
			.filter((e) => e.length > 0) ?? [];
		const hasFilter = !!lowerPrefix || excl.length > 0;

		// Compute cosine similarities in batches to avoid blocking too long
		const BATCH = 10000;
		const scores: { index: number; score: number }[] = [];

		for (let batchStart = 0; batchStart < numVectors; batchStart += BATCH) {
			const batchEnd = Math.min(batchStart + BATCH, numVectors);

			for (let i = batchStart; i < batchEnd; i++) {
				const offset = i * dim;
				let dot = 0;
				let normB = 0;

				for (let j = 0; j < dim; j++) {
					const v = this.allVectors[offset + j];
					dot += query[j] * v;
					normB += v * v;
				}

				const score = normB > 0 ? dot / Math.sqrt(normB) : 0;
				if (score >= threshold) {
					// Path predicates run only for threshold-passing chunks
					// (a small subset), so the per-hit toLowerCase cost is fine.
					if (hasFilter) {
						const p = this.allVectorPaths[i]?.toLowerCase() ?? "";
						if (lowerPrefix && !p.startsWith(lowerPrefix)) continue;
						if (excl.length > 0 && excl.some((e) => p.includes(e))) continue;
					}
					scores.push({ index: i, score });
				}
			}
		}

		// Sort by score descending, take top-K
		scores.sort((a, b) => b.score - a.score);
		const topK = scores.slice(0, limit);

		// Fetch metadata from DB
		const results: SearchResult[] = [];
		for (const item of topK) {
			const chunkId = this.allVectorIds[item.index];
			const chunk = this.getChunkById(chunkId);
			if (chunk) {
				results.push({
					chunkId: chunk.id,
					notePath: chunk.notePath,
					heading: chunk.heading,
					contentPreview: chunk.contentPreview,
					score: Math.round(item.score * 10000) / 10000,
				});
			}
		}

		return results;
	}

	/** Normalized query vector (unit length) for cosine similarity. */
	private normalizeQuery(queryEmbedding: number[] | Float32Array): Float32Array {
		const dim = EMBEDDING_DIM;
		const query = new Float32Array(dim);
		let queryNorm = 0;
		for (let i = 0; i < Math.min(queryEmbedding.length, dim); i++) {
			query[i] = queryEmbedding[i];
			queryNorm += query[i] * query[i];
		}
		queryNorm = Math.sqrt(queryNorm);
		if (queryNorm > 0) {
			for (let i = 0; i < dim; i++) query[i] /= queryNorm;
		}
		return query;
	}

	/** Total cached vector count (for the sync-fallback time-sliced scan). */
	vectorCount(): number {
		this.loadVectorCache();
		return this.allVectorIds?.length ?? 0;
	}

	/**
	 * Cosine scan over ONE index range. Used by the sync-fallback path to
	 * time-slice a full scan so the main thread can breathe between slices
	 * (the worker path uses the monolithic search() instead).
	 * Path predicates are evaluated in-loop, same as search().
	 */
	searchSlice(
		queryEmbedding: number[] | Float32Array,
		startIdx: number,
		endIdx: number,
		threshold = 0.3,
		pathFilter?: string,
		excludePaths?: string[],
	): Array<{ chunkId: string; score: number }> {
		this.loadVectorCache();
		if (!this.allVectors || !this.allVectorIds) return [];

		const dim = EMBEDDING_DIM;
		const query = this.normalizeQuery(queryEmbedding);
		const out: Array<{ chunkId: string; score: number }> = [];
		const lowerPrefix = pathFilter?.toLowerCase();
		const excl = excludePaths
			?.map((e) => e.trim().toLowerCase())
			.filter((e) => e.length > 0) ?? [];
		const hasFilter = !!lowerPrefix || excl.length > 0;

		for (let i = startIdx; i < Math.min(endIdx, this.allVectorIds.length); i++) {
			const offset = i * dim;
			let dot = 0;
			let normB = 0;
			for (let j = 0; j < dim; j++) {
				const v = this.allVectors[offset + j];
				dot += query[j] * v;
				normB += v * v;
			}
			const score = normB > 0 ? dot / Math.sqrt(normB) : 0;
			if (score >= threshold) {
				if (hasFilter) {
					const p = this.allVectorPaths[i]?.toLowerCase() ?? "";
					if (lowerPrefix && !p.startsWith(lowerPrefix)) continue;
					if (excl.length > 0 && excl.some((e) => p.includes(e))) continue;
				}
				out.push({ chunkId: this.allVectorIds[i], score });
			}
		}
		return out;
	}

	/**
	 * Find notes semantically similar to `notePath` via max-pooling over the
	 * source note's own chunks.
	 *
	 * Unlike search() (one query vector → chunk hits), this probes several of
	 * the source note's chunks — uniformly sampled across the WHOLE document,
	 * not just the opening — runs each as a query, and aggregates hits to the
	 * NOTE level by keeping each target note's best (max) score.
	 *
	 * Why: the old approach used only chunks[0] as the note's representative,
	 * which made "related notes" asymmetric. S-100's opening is a boilerplate
	 * copyright page, so its related list came back empty even though S-98
	 * listed S-100. Sampling across the document and taking the per-note max
	 * restores symmetry and lets large docs be represented by their real
	 * topical sections instead of their header.
	 *
	 * Runs entirely on already-stored vectors (no embedding API call); costs
	 * min(maxProbes, chunkCount) brute-force scans.
	 */
	searchRelatedNotes(
		notePath: string,
		limit = 10,
		threshold = 0.2,
		maxProbes = 6,
	): SearchResult[] {
		// Prefer the document-level vector (whole-note heading embedding) when
		// available: symmetric, sampling-free, O(numNotes). Falls back to chunk
		// max-pooling for notes that haven't been backfilled yet.
		this.loadDocVectorCache();
		const srcDocIdx = this.docPathToIndex.get(notePath);
		if (srcDocIdx !== undefined) {
			const docResults = this.searchByDocVector(srcDocIdx, notePath, limit, threshold);
			if (docResults.length > 0) return docResults;
			// Empty doc-vector result (e.g. threshold too high): fall through to
			// chunk max-pooling as a last resort.
		}

		this.loadVectorCache();
		if (!this.allVectors || this.allVectorIds.length === 0) return [];

		// Source note's active chunk ids, in document order (rowid = insertion
		// order; the same ordering the old chunks[0] approach relied on).
		const rows = this.db!.exec(
			"SELECT id FROM chunks WHERE note_path = ? AND status = 'active' AND vector IS NOT NULL ORDER BY rowid",
			[notePath],
		) as unknown as QueryResult[];
		if (rows.length === 0 || rows[0].values.length === 0) return [];
		const ids: string[] = rows[0].values.map((r: unknown[]) => r[0] as string);

		// Probe chunks spread across the whole document (midpoint sampling so
		// head, middle and tail are all represented).
		const probed = this.uniformSampleIds(ids, maxProbes);

		const dim = EMBEDDING_DIM;
		// Each probe contributes its own top-K chunk hits; widen a bit so the
		// note-level aggregation still has enough candidates after de-dup.
		const perQueryLimit = limit + 8;
		// best[targetNotePath] = highest-scoring SearchResult seen across probes.
		const best = new Map<string, SearchResult>();

		for (const cid of probed) {
			const qIdx = this.vectorIdToIndex.get(cid);
			if (qIdx === undefined) continue;

			// Build a query vector from this probe's stored embedding.
			const qOffset = qIdx * dim;
			const query = new Float32Array(dim);
			for (let j = 0; j < dim; j++) query[j] = this.allVectors[qOffset + j];

			// Use search() — it normalizes the query, ranks ALL chunks by cosine
			// score, and returns the top-perQueryLimit with metadata attached.
			// (searchSlice must NOT be used here: it returns hits UNORDERED, in
			// cache-index order, so slicing it would keep the first-N-by-position
			// instead of the top-N-by-score — which produced unrelated results.)
			const hits = this.search(query, perQueryLimit, threshold);

			// Aggregate to note level: keep each target note's best hit.
			for (const h of hits) {
				if (h.notePath === notePath) continue; // skip self
				const prev = best.get(h.notePath);
				if (!prev || h.score > prev.score) best.set(h.notePath, h);
			}
		}

		// Rank target notes by best score, take top `limit`.
		return Array.from(best.values())
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);
	}

	/** Pick up to `n` ids spread evenly across `ids` (midpoint of each stride),
	 *  so head, middle and tail are all represented. Returns all ids when the
	 *  note has fewer than `n` chunks. */
	private uniformSampleIds(ids: string[], n: number): string[] {
		const len = ids.length;
		if (len <= n) return ids.slice();
		const out: string[] = [];
		const step = len / n;
		for (let i = 0; i < n; i++) {
			out.push(ids[Math.floor((i + 0.5) * step)]);
		}
		return out;
	}

	/**
	 * Substring search over chunk content via SQL LIKE — far faster than
	 * scanning every vault file (used by the grep tool). Returns matching note
	 * paths with a count of matching chunks per note.
	 */
	textSearch(pattern: string, limit = 200, pathFilter?: string, excludePaths?: string[]): Array<{ path: string; matchCount: number; preview: string }> {
		const like = `%${pattern}%`;
		let sql = "SELECT note_path, COUNT(*) as cnt, MAX(content_preview) as prev FROM chunks WHERE content LIKE ?";
		const params: unknown[] = [like];
		if (pathFilter) {
			sql += " AND note_path LIKE ?";
			params.push(`%${pathFilter}%`);
		}
		// 排除前缀（NOT LIKE %p%）：startsWith 是 includes 的子集，一个条件
		// 即覆盖索引侧 isExcluded 的两种匹配；索引里可能仍有规则变更前的旧内容。
		for (const ex of excludePaths ?? []) {
			const t = ex.trim();
			if (!t) continue;
			sql += " AND note_path NOT LIKE ?";
			params.push(`%${t}%`);
		}
		sql += " GROUP BY note_path ORDER BY cnt DESC LIMIT ?";
		params.push(Math.max(1, limit));

		const rows = this.db!.exec(sql, params);
		if (rows.length === 0 || rows[0].values.length === 0) return [];

		return rows[0].values.map((row) => ({
			path: row[0] as string,
			matchCount: row[1] as number,
			preview: (row[2] as string) || "",
		}));
	}

	// ──── Queue operations (merged from IndexQueue) ────

	/** Enqueue a single item */
	enqueue(notePath: string, action: QueueAction, priority = 2): void {
		// Avoid duplicates for the same path+action that are pending OR already
		// processing — otherwise repeated scans pile up duplicate queue rows and
		// the same note gets embedded over and over (progress > 100%).
		const existing = this.db!.exec(
			"SELECT id FROM queue WHERE note_path = ? AND action = ? AND status IN ('pending','processing')",
			[notePath, action]
		);
		if (existing.length > 0 && existing[0].values.length > 0) return;

		this.db!.run(
			"INSERT INTO queue (note_path, action, priority, status, retries, error, created_at) VALUES (?, ?, ?, 'pending', 0, NULL, ?)",
			[notePath, action, priority, Date.now()]
		);
	}

	/** Enqueue multiple items */
	enqueueMany(items: Array<{ notePath: string; action: QueueAction; priority?: number }>): void {
		for (const item of items) {
			this.enqueue(item.notePath, item.action, item.priority ?? 2);
		}
	}

	/** Dequeue the next batch of pending items */
	dequeue(limit = 64): QueueItem[] {
		const results = this.db!.exec(
			"SELECT id, note_path, action, priority, status, retries, error, created_at FROM queue WHERE status = 'pending' ORDER BY priority ASC, created_at ASC LIMIT ?",
			[limit]
		);

		if (results.length === 0) return [];

		const items = this.mapItems(results);

		// Mark as processing
		for (const item of items) {
			if (item.id != null) {
				this.db!.run("UPDATE queue SET status = 'processing' WHERE id = ?", [item.id]);
			}
		}

		return items;
	}

	/** Mark an item as completed */
	complete(id: number): void {
		this.db!.run("UPDATE queue SET status = 'completed' WHERE id = ?", [id]);
	}

	/** Mark an item as failed and increment retries */
	fail(id: number, error: string): void {
		this.db!.run(
			"UPDATE queue SET status = 'failed', error = ?, retries = retries + 1 WHERE id = ?",
			[error, id]
		);
	}

	/** Re-queue failed items for retry */
	retryFailed(): number {
		const result = this.db!.run(
			"UPDATE queue SET status = 'pending', error = NULL WHERE status = 'failed' AND retries < 5"
		);
		return result.changes;
	}

	/** Count pending items */
	getPendingCount(): number {
		const results = this.db!.exec("SELECT COUNT(*) FROM queue WHERE status = 'pending'");
		if (results.length > 0 && results[0].values.length > 0) {
			return results[0].values[0][0] as number;
		}
		return 0;
	}

	/** Count items by status */
	getCounts(): { pending: number; processing: number; failed: number; completed: number } {
		const counts = { pending: 0, processing: 0, failed: 0, completed: 0 };
		const results = this.db!.exec("SELECT status, COUNT(*) FROM queue GROUP BY status");
		if (results.length > 0) {
			for (const row of results[0].values) {
				const status = row[0] as string;
				const count = row[1] as number;
				if (status in counts) (counts as Record<string, number>)[status] = count;
			}
		}
		return counts;
	}

	/** Clean up completed items older than cutoff */
	cleanup(cutoffMs: number): void {
		this.db!.run(
			"DELETE FROM queue WHERE status = 'completed' AND created_at < ?",
			[Date.now() - cutoffMs]
		);
	}

	/** Clear all queue items */
	clearQueue(): void {
		this.db!.run("DELETE FROM queue");
	}

	/** Get all pending paths */
	getPendingPaths(): string[] {
		const results = this.db!.exec(
			"SELECT note_path FROM queue WHERE status IN ('pending', 'processing', 'failed') ORDER BY priority ASC, created_at ASC"
		);
		if (results.length === 0) return [];
		return results[0].values.map((r) => r[0] as string);
	}

	// ──── Helpers ────

	private mapChunks(results: QueryResult[]): NoteChunk[] {
		if (results.length === 0) return [];
		const cols = results[0].columns ?? [];
		return results[0].values.map((row) => {
			const obj: Record<string, unknown> = {};
			cols.forEach((c: string, i: number) => (obj[c] = row[i]));
			return {
				id: obj.id,
				notePath: obj.note_path,
				heading: obj.heading || "",
				content: obj.content || "",
				contentPreview: obj.content_preview || "",
				mtime: obj.mtime || 0,
				status: obj.status || "pending_embed",
				embedding: null,
				createdAt: obj.created_at || 0,
			} as NoteChunk;
		});
	}

	private mapItems(results: QueryResult[]): QueueItem[] {
		if (results.length === 0) return [];
		const cols = results[0].columns ?? [];
		return results[0].values.map((row) => {
			const obj: Record<string, unknown> = {};
			cols.forEach((c: string, i: number) => (obj[c] = row[i]));
			return {
				id: obj.id,
				notePath: obj.note_path,
				action: obj.action as QueueAction,
				priority: obj.priority || 2,
				status: obj.status as QueueItemStatus,
				retries: obj.retries || 0,
				error: obj.error,
				createdAt: obj.created_at,
			} as QueueItem;
		});
	}
}
