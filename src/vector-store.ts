// ========================================
// Semlink - Vector Store (SQLite + Binary Vectors)
// ========================================

import initSqlJs, { Database } from "sql.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, statSync } from "fs";
import { join } from "path";
import type { NoteChunk, SearchResult } from "./types";

const EMBEDDING_DIM = 1024;
const BYTES_PER_FLOAT = 4;
const VECTORS_FILE = "vectors.bin";
const DB_FILE = "vault.db";

export class VectorStore {
	private db: Database | null = null;
	private dataDir: string;
	private wasmPath: string;

	// In-memory vector cache: notePath -> { chunkId -> Float32Array }
	private vectorCache: Map<string, Map<string, Float32Array>> = new Map();
	private allVectors: Float32Array | null = null;
	private allVectorIds: string[] = [];
	private allVectorOffsets: number[] = [];
	private cacheLoaded = false;

	constructor(dataDir: string, wasmPath: string) {
		this.dataDir = dataDir;
		this.wasmPath = wasmPath;
		if (!existsSync(dataDir)) {
			mkdirSync(dataDir, { recursive: true });
		}
	}

	async init(): Promise<void> {
		// Read WASM binary via Node.js fs (Electron renderer blocks file:// URLs)
		const wasmBinary = readFileSync(this.wasmPath);
		const SQL = await initSqlJs({ wasmBinary });

		const dbPath = join(this.dataDir, DB_FILE);
		if (existsSync(dbPath)) {
			const buf = readFileSync(dbPath);
			this.db = new SQL.Database(buf);
		} else {
			this.db = new SQL.Database();
		}

		this.createTables();
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
				vector_offset INTEGER DEFAULT -1,
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

		// Create indexes separately (SQLite does not support inline INDEX in CREATE TABLE)
		this.db!.run("CREATE INDEX IF NOT EXISTS idx_chunks_note_path ON chunks (note_path)");
		this.db!.run("CREATE INDEX IF NOT EXISTS idx_chunks_status ON chunks (status)");
		this.db!.run("CREATE INDEX IF NOT EXISTS idx_queue_status ON queue (status, priority)");
	}

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
		this.vectorCache.clear();
		this.allVectors = null;
		this.allVectorIds = [];
		this.allVectorOffsets = [];
		this.cacheLoaded = false;

		// Delete vectors binary file
		const vecPath = join(this.dataDir, VECTORS_FILE);
		if (existsSync(vecPath)) {
			unlinkSync(vecPath);
		}

		this.save();
	}

	close(): void {
		this.save();
		this.db?.close();
		this.db = null;
		this.vectorCache.clear();
		this.allVectors = null;
		this.cacheLoaded = false;
	}

	// ──── Chunk CRUD ────

	insertChunk(chunk: NoteChunk): void {
		const preview = chunk.contentPreview || chunk.content.slice(0, 200);
		this.db!.run(
			`INSERT OR REPLACE INTO chunks (id, note_path, heading, content, content_preview, mtime, status, vector_offset, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, -1, ?)`,
			[chunk.id, chunk.notePath, chunk.heading, chunk.content, preview, chunk.mtime, chunk.status, chunk.createdAt]
		);
	}

	getChunksByNotePath(notePath: string): NoteChunk[] {
		const results = this.db!.exec(
			"SELECT id, note_path, heading, content, content_preview, mtime, status, vector_offset, created_at FROM chunks WHERE note_path = ?",
			[notePath]
		);
		return this.mapChunks(results);
	}

	getActiveChunks(): NoteChunk[] {
		const results = this.db!.exec(
			"SELECT id, note_path, heading, content, content_preview, mtime, status, vector_offset, created_at FROM chunks WHERE status = 'active' AND vector_offset >= 0"
		);
		return this.mapChunks(results);
	}

	getChunkById(id: string): NoteChunk | null {
		const results = this.db!.exec(
			"SELECT id, note_path, heading, content, content_preview, mtime, status, vector_offset, created_at FROM chunks WHERE id = ?",
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
		// Get vector offsets to free
		const offsets = this.db!.exec(
			"SELECT id, vector_offset FROM chunks WHERE note_path = ? AND vector_offset >= 0",
			[notePath]
		);

		// Delete from DB
		const result = this.db!.run(
			"DELETE FROM chunks WHERE note_path = ?",
			[notePath]
		);

		// Invalidate vector cache for this note
		this.vectorCache.delete(notePath);
		this.cacheLoaded = false;

		return result.changes;
	}

	deleteStaleChunks(notePath: string): number {
		const result = this.db!.run(
			"DELETE FROM chunks WHERE note_path = ? AND status = 'stale'",
			[notePath]
		);
		this.vectorCache.delete(notePath);
		this.cacheLoaded = false;
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

	// ──── Vector Storage (Binary File) ────

	/**
	 * Save embeddings to binary file and update chunk records.
	 * Each embedding = EMBEDDING_DIM × Float32 = 4096 bytes.
	 */
	saveEmbeddings(chunkIds: string[], embeddings: number[][]): void {
		const vecPath = join(this.dataDir, VECTORS_FILE);
		let existingData: Float32Array;

		if (existsSync(vecPath)) {
			const buf = readFileSync(vecPath);
			existingData = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / BYTES_PER_FLOAT);
		} else {
			existingData = new Float32Array(0);
		}

		const startOffset = existingData.length / EMBEDDING_DIM;
		const newVectors = new Float32Array(embeddings.length * EMBEDDING_DIM);

		for (let i = 0; i < embeddings.length; i++) {
			const vec = embeddings[i];
			if (vec.length !== EMBEDDING_DIM) {
				console.warn(`[Semlink] Embedding dimension mismatch: ${vec.length} vs ${EMBEDDING_DIM}`);
			}
			for (let j = 0; j < Math.min(vec.length, EMBEDDING_DIM); j++) {
				newVectors[i * EMBEDDING_DIM + j] = vec[j];
			}
		}

		// Append new vectors
		const combined = new Float32Array(existingData.length + newVectors.length);
		combined.set(existingData);
		combined.set(newVectors, existingData.length);

		const buf = Buffer.from(combined.buffer);
		writeFileSync(vecPath, buf);

		// Update chunk records with vector offsets
		for (let i = 0; i < chunkIds.length; i++) {
			const offset = startOffset + i;
			this.db!.run(
				"UPDATE chunks SET status = 'active', vector_offset = ? WHERE id = ?",
				[offset, chunkIds[i]]
			);
		}

		// Invalidate cache
		this.cacheLoaded = false;
	}

	/**
	 * Load all vectors into memory for fast search.
	 * For 100K × 1024-dim Float32 = ~400MB.
	 */
	loadVectorCache(): void {
		if (this.cacheLoaded) return;

		const vecPath = join(this.dataDir, VECTORS_FILE);
		if (!existsSync(vecPath)) {
			this.allVectors = new Float32Array(0);
			this.allVectorIds = [];
			this.allVectorOffsets = [];
			this.cacheLoaded = true;
			return;
		}

		const buf = readFileSync(vecPath);
		this.allVectors = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / BYTES_PER_FLOAT);

		// Build ordered ID list from DB (include vector_offset for correct lookup)
		const results = this.db!.exec(
			"SELECT id, note_path, vector_offset FROM chunks WHERE status = 'active' AND vector_offset >= 0 ORDER BY vector_offset"
		);

		this.vectorCache.clear();
		const ids: string[] = [];
		const offsets: number[] = [];

		if (results.length > 0) {
			for (const row of results[0].values) {
				const id = row[0] as string;
				const notePath = row[1] as string;
				const offset = row[2] as number;
				ids.push(id);
				offsets.push(offset);

				if (!this.vectorCache.has(notePath)) {
					this.vectorCache.set(notePath, new Map());
				}
			}
		}

		this.allVectorIds = ids;
		this.allVectorOffsets = offsets;
		this.cacheLoaded = true;

		console.log(`[Semlink] Loaded ${ids.length} vectors into cache (${(buf.length / 1024 / 1024).toFixed(1)}MB)`);
	}

	/**
	 * Semantic search: find top-K chunks most similar to the query vector.
	 * Uses brute-force cosine similarity (optimized with pre-normalized vectors).
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
				const vecOffset = this.allVectorOffsets[i];
				const offset = vecOffset * dim;
				let dot = 0;
				let normB = 0;

				for (let j = 0; j < dim; j++) {
					const v = this.allVectors[offset + j];
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
}
