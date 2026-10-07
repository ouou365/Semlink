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
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, unlinkSync, statSync } from "fs";
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
		// A leftover temp file means a previous write died before rename —
		// discard it (the real DB was untouched by the atomic write).
		const tmpPath = join(this.dataDir, `${DB_FILE}.tmp`);
		if (existsSync(tmpPath)) {
			try { unlinkSync(tmpPath); } catch { /* ignore */ }
		}

		if (existsSync(dbPath)) {
			try {
				const buf = readFileSync(dbPath);
				this.db = new SQL.Database(buf);
			} catch (e) {
				// Corrupted/torn DB (e.g. from a pre-atomic-write crash). Don't
				// silently rebuild — back it up so the data is recoverable, then
				// start fresh. A silent rebuild would re-embed everything anyway.
				console.error("[Semlink] DB load failed, backing up and rebuilding:", e);
				try {
					renameSync(dbPath, `${dbPath}.corrupt-${Date.now()}`);
				} catch { /* ignore */ }
				this.db = new SQL.Database();
			}
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
		// export() already returns a fresh Uint8Array — passing it straight
		// to writeFileSync skips a full-DB Buffer copy (hundreds of MB).
		const data = this.db.export();
		const finalPath = join(this.dataDir, DB_FILE);
		const tmpPath = join(this.dataDir, `${DB_FILE}.tmp`);
		writeFileSync(tmpPath, data);
		// fsync isn't available on every platform via this import; rename alone
		// still protects against torn writes from a killed process.
		renameSync(tmpPath, finalPath);
	}

	/** Clear all stored data (chunks, queue, vectors) for a full rebuild */
	clearAll(): void {
		if (!this.db) return;
		this.db.run("DELETE FROM chunks");
		this.db.run("DELETE FROM queue");
		this.db.run("DELETE FROM meta");
		this.db.run("DELETE FROM note_doc_vectors");
		this.allVectors = null;
		this.allVectorIds = [];
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
		if (this.txDepth === 0) this.db!.run("ROLLBACK");
		else {
			this.db!.run(`ROLLBACK TO SAVEPOINT tx_${this.txDepth}`);
			this.db!.run(`RELEASE SAVEPOINT tx_${this.txDepth}`);
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
		const rows = this.db!.exec("SELECT id, note_path FROM queue");
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
			[blob, notePath, mtime, headingText]
		);
		this.docCacheLoaded = false;
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
		const allVec = new Float32Array(numVectors * EMBEDDING_DIM);
		this.vectorIdToIndex.clear();

		for (let i = 0; i < numVectors; i++) {
			const id = rows[i][0] as string;
			const blob = rows[i][1] as Uint8Array;
			ids.push(id);
			this.vectorIdToIndex.set(id, i);

			// Copy blob bytes into the contiguous array
			const vecView = new Float32Array(blob.buffer, blob.byteOffset, EMBEDDING_DIM);
			allVec.set(vecView, i * EMBEDDING_DIM);
		}

		this.allVectors = allVec;
		this.allVectorIds = ids;
		this.cacheLoaded = true;

		console.log(`[Semlink] Loaded ${numVectors} vectors into cache (${(numVectors * EMBEDDING_DIM * BYTES_PER_FLOAT / 1024 / 1024).toFixed(1)}MB)`);
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
			for (const row of results[0].values as any[]) out.add(row[0] as string);
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
			query[j] = this.allDocVectors![srcOffset + j];
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
				const v = this.allDocVectors![offset + j];
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
	 */
	search(queryEmbedding: number[] | Float32Array, limit = 10, threshold = 0.3): SearchResult[] {
		this.loadVectorCache();

		if (!this.allVectors || this.allVectorIds.length === 0) {
			return [];
		}

		const dim = EMBEDDING_DIM;
		const numVectors = this.allVectorIds.length;

		// Normalize query vector
		const query = this.normalizeQuery(queryEmbedding);

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
	 */
	searchSlice(
		queryEmbedding: number[] | Float32Array,
		startIdx: number,
		endIdx: number,
		threshold = 0.3,
	): Array<{ chunkId: string; score: number }> {
		this.loadVectorCache();
		if (!this.allVectors || !this.allVectorIds) return [];

		const dim = EMBEDDING_DIM;
		const query = this.normalizeQuery(queryEmbedding);
		const out: Array<{ chunkId: string; score: number }> = [];

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
		);
		if (rows.length === 0 || rows[0].values.length === 0) return [];
		const ids: string[] = rows[0].values.map((r: any[]) => r[0] as string);

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
			for (let j = 0; j < dim; j++) query[j] = this.allVectors![qOffset + j];

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
	 * scanning every vault file (used by grep_notes). Returns matching note
	 * paths with a count of matching chunks per note.
	 */
	textSearch(pattern: string, limit = 200, pathFilter?: string): Array<{ path: string; matchCount: number; preview: string }> {
		const like = `%${pattern}%`;
		let sql = "SELECT note_path, COUNT(*) as cnt, MAX(content_preview) as prev FROM chunks WHERE content LIKE ?";
		const params: any[] = [like];
		if (pathFilter) {
			sql += " AND note_path LIKE ?";
			params.push(`%${pathFilter}%`);
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
