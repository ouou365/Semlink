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

import initSqlJs, { Database } from "sql.js";
import wasmBase64 from "sql.js/dist/sql-wasm.wasm";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, statSync } from "fs";
import { join } from "path";
import type { NoteChunk, SearchResult, QueueItem, QueueAction, QueueItemStatus } from "./types";

const EMBEDDING_DIM = 1024;
const BYTES_PER_FLOAT = 4;
const DB_FILE = "vault.db";
const VECTORS_FILE_LEGACY = "vectors.bin";

export class DbEngine {
	private db: Database | null = null;
	private dataDir: string;

	// In-memory vector cache for fast search
	private allVectors: Float32Array | null = null;
	private allVectorIds: string[] = [];
	private cacheLoaded = false;

	constructor(dataDir: string) {
		this.dataDir = dataDir;
		if (!existsSync(dataDir)) {
			mkdirSync(dataDir, { recursive: true });
		}
	}

	/** The raw sql.js handle — exposed so the fallback proxy can satisfy any
	 *  legacy direct-db callers during the transition. */
	get rawDb(): Database | null {
		return this.db;
	}

	async init(): Promise<void> {
		// Decode inline WASM base64
		const wasmBinary = Buffer.from(wasmBase64, "base64");
		const SQL = await initSqlJs({ wasmBinary });

		const dbPath = join(this.dataDir, DB_FILE);
		if (existsSync(dbPath)) {
			const buf = readFileSync(dbPath);
			this.db = new SQL.Database(buf);
		} else {
			this.db = new SQL.Database();
		}

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

		// Create indexes
		this.db!.run("CREATE INDEX IF NOT EXISTS idx_chunks_note_path ON chunks (note_path)");
		this.db!.run("CREATE INDEX IF NOT EXISTS idx_chunks_status ON chunks (status)");
		this.db!.run("CREATE INDEX IF NOT EXISTS idx_queue_status ON queue (status, priority)");
	}

	/** Migrate from old vector_offset + vectors.bin to BLOB storage */
	private async migrateIfNeeded(): Promise<void> {
		// Check if old vector_offset column exists
		const colCheck = this.db!.exec("PRAGMA table_info(chunks)");
		if (colCheck.length === 0) return;

		const columns = colCheck[0].values.map(row => row[1] as string);
		const hasVectorOffset = columns.includes("vector_offset");
		const hasVectorBlob = columns.includes("vector");

		if (!hasVectorOffset) return; // New schema, no migration needed

		console.log("[Semlink] Migrating from vectors.bin to SQLite BLOB...");

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
			console.log("[Semlink] Migration complete, vectors.bin deleted");
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
	 *  worker mode (db.export + writeFileSync of a 397MB file). */
	save(): void {
		if (!this.db) return;
		const data = this.db.export();
		const buf = Buffer.from(data);
		writeFileSync(join(this.dataDir, DB_FILE), buf);
	}

	/** Clear all stored data (chunks, queue, vectors) for a full rebuild */
	clearAll(): void {
		if (!this.db) return;
		this.db.run("DELETE FROM chunks");
		this.db.run("DELETE FROM queue");
		this.db.run("DELETE FROM meta");
		this.allVectors = null;
		this.allVectorIds = [];
		this.cacheLoaded = false;

		// Delete legacy vectors.bin if it still exists
		const vecPath = join(this.dataDir, VECTORS_FILE_LEGACY);
		if (existsSync(vecPath)) {
			unlinkSync(vecPath);
		}

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
		this.cacheLoaded = false;
	}

	// ──── Chunk CRUD ────

	beginTransaction(): void {
		this.db!.run("BEGIN TRANSACTION");
	}

	commitTransaction(): void {
		this.db!.run("COMMIT");
	}

	rollbackTransaction(): void {
		this.db!.run("ROLLBACK");
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
		this.cacheLoaded = false;
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
		if (result.changes > 0) {
			this.cacheLoaded = false;
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
				removed++;
			}
		}
		if (removed > 0) {
			this.cacheLoaded = false;
		}
		return removed;
	}

	getStats(): { totalChunks: number; activeChunks: number; indexedNotes: number; dbSizeMb: number } {
		let totalChunks = 0, activeChunks = 0;
		const r1 = this.db!.exec("SELECT COUNT(*) FROM chunks");
		if (r1.length > 0) totalChunks = r1[0].values[0][0] as number;

		const r2 = this.db!.exec("SELECT COUNT(*) FROM chunks WHERE status = 'active'");
		if (r2.length > 0) activeChunks = r2[0].values[0][0] as number;

		const r3 = this.db!.exec("SELECT COUNT(DISTINCT note_path) FROM chunks WHERE status = 'active'");
		const indexedNotes = r3.length > 0 ? (r3[0].values[0][0] as number) : 0;

		const dbPath = join(this.dataDir, DB_FILE);
		let dbSizeMb = 0;
		try { dbSizeMb = statSync(dbPath).size / (1024 * 1024); } catch {}

		return { totalChunks, activeChunks, indexedNotes, dbSizeMb: Math.round(dbSizeMb * 10) / 10 };
	}

	// ──── Vector Storage (SQLite BLOB) ────

	/**
	 * Save embeddings directly to SQLite BLOB.
	 * Each embedding = EMBEDDING_DIM × Float32 = 4096 bytes.
	 */
	saveEmbeddings(chunkIds: string[], embeddings: number[][]): void {
		for (let i = 0; i < chunkIds.length; i++) {
			const vec = new Float32Array(EMBEDDING_DIM);
			for (let j = 0; j < Math.min(embeddings[i].length, EMBEDDING_DIM); j++) {
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

	/**
	 * Load all vectors into a contiguous Float32Array for fast search.
	 */
	loadVectorCache(): void {
		if (this.cacheLoaded) return;

		const results = this.db!.exec(
			"SELECT id, vector FROM chunks WHERE status = 'active' AND vector IS NOT NULL"
		);

		if (results.length === 0 || results[0].values.length === 0) {
			this.allVectors = new Float32Array(0);
			this.allVectorIds = [];
			this.cacheLoaded = true;
			return;
		}

		const rows = results[0].values;
		const numVectors = rows.length;
		const ids: string[] = [];
		const allVec = new Float32Array(numVectors * EMBEDDING_DIM);

		for (let i = 0; i < numVectors; i++) {
			const id = rows[i][0] as string;
			const blob = rows[i][1] as Uint8Array;
			ids.push(id);

			// Copy blob bytes into the contiguous array
			const vecView = new Float32Array(blob.buffer, blob.byteOffset, EMBEDDING_DIM);
			allVec.set(vecView, i * EMBEDDING_DIM);
		}

		this.allVectors = allVec;
		this.allVectorIds = ids;
		this.cacheLoaded = true;

		console.log(`[Semlink] Loaded ${numVectors} vectors into cache (${(numVectors * EMBEDDING_DIM * BYTES_PER_FLOAT / 1024 / 1024).toFixed(1)}MB)`);
	}

	/**
	 * Semantic search: find top-K chunks most similar to the query vector.
	 * Uses brute-force cosine similarity. This is the other main-thread hot
	 * path — tens of thousands of 1024-dim dot products per query. Running it
	 * in the worker keeps it off the UI thread.
	 */
	search(queryEmbedding: number[], limit = 10, threshold = 0.3): SearchResult[] {
		this.loadVectorCache();

		if (!this.allVectors || this.allVectorIds.length === 0) {
			return [];
		}

		const dim = EMBEDDING_DIM;
		const numVectors = this.allVectorIds.length;

		// Normalize query vector
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
					const v = this.allVectors![offset + j];
					dot += query[j] * v;
					normB += v * v;
				}

				const score = normB > 0 ? dot / Math.sqrt(normB) : 0;
				if (score >= threshold) {
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

	// ──── Queue operations (merged from IndexQueue) ────

	/** Enqueue a single item */
	enqueue(notePath: string, action: QueueAction, priority = 2): void {
		// Avoid duplicates for the same path+action that are still pending
		const existing = this.db!.exec(
			"SELECT id FROM queue WHERE note_path = ? AND action = ? AND status = 'pending'",
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
				if (status in counts) (counts as any)[status] = count;
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
		return results[0].values.map((r: any[]) => r[0] as string);
	}

	// ──── Helpers ────

	private mapChunks(results: any[]): NoteChunk[] {
		if (results.length === 0) return [];
		const cols = results[0].columns;
		return results[0].values.map((row: any[]) => {
			const obj: Record<string, any> = {};
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

	private mapItems(results: any[]): QueueItem[] {
		if (results.length === 0) return [];
		const cols = results[0].columns;
		return results[0].values.map((row: any[]) => {
			const obj: Record<string, any> = {};
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
