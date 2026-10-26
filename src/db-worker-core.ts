// ========================================
// Semlink - DB worker dispatch core
// ========================================
// The op → engine dispatch table shared by BOTH worker entries:
//   - db-worker.ts        : worker_threads child (desktop Electron default)
//   - db-worker.browser.ts: browser Web Worker (renderers where
//                           worker_threads is unavailable)
// The engine instance is private to each worker instance.

import { DbEngine } from "./db-engine";
import { chunkMarkdown } from "./chunker";
import type { NoteChunk, QueueAction } from "./types";

export type Dispatcher = (op: string, args: unknown[]) => Promise<unknown>;

/** Create a dispatcher closure owning one DbEngine instance. The dataDir
 *  arrives with the "init" op (each host passes its own). */
export function createDispatcher(): Dispatcher {
	let engine: DbEngine | null = null;

	return async (op: string, args: unknown[]): Promise<unknown> => {
		if (!engine) {
			// Only "init" is valid before the engine exists.
			if (op === "init") {
				engine = new DbEngine(args[0] as string);
				await engine.init();
				return null;
			}
			throw new Error(`Engine not initialized (op=${op})`);
		}

		switch (op) {
			case "chunk": return chunkMarkdown(args[0] as string, args[1] as string, args[2] as number, args[3] as number);
			case "save": return engine.save();
			case "clearAll": return engine.clearAll();
			case "clearVectors": return engine.clearVectors();
			case "compact": return engine.compact();
			case "close":
				// Flush to disk before closing (unload path may not await us).
				engine.save();
				return engine.close();
			case "beginTransaction": return engine.beginTransaction();
			case "commitTransaction": return engine.commitTransaction();
			case "rollbackTransaction": return engine.rollbackTransaction();
			case "insertChunk": return engine.insertChunk(args[0] as NoteChunk);
			case "getChunksByNotePath": return engine.getChunksByNotePath(args[0] as string);
			case "getActiveChunks": return engine.getActiveChunks();
			case "getChunkById": return engine.getChunkById(args[0] as string);
			case "markChunksStale": return engine.markChunksStale(args[0] as string);
			case "deleteChunksByNotePath": return engine.deleteChunksByNotePath(args[0] as string);
			case "deleteStaleChunks": return engine.deleteStaleChunks(args[0] as string);
			case "renameNotePath": return engine.renameNotePath(args[0] as string, args[1] as string);
			case "getNoteMtime": return engine.getNoteMtime(args[0] as string);
			case "getAllIndexedPaths": return engine.getAllIndexedPaths();
			case "pruneOrphanedPaths": return engine.pruneOrphanedPaths(args[0] as Set<string>);
			case "getStats": return engine.getStats();
			case "getEmbeddedNoteCount": return engine.getEmbeddedNoteCount();
			case "saveEmbeddings": return engine.saveEmbeddings(args[0] as string[], args[1] as number[][]);
			case "saveDocEmbedding": return engine.saveDocEmbedding(args[0] as string, args[1] as number[], args[2] as number, args[3] as string);
			case "getDocVectorNotePaths": return engine.getDocVectorNotePaths();
			case "prepareDocVectorBackfill": return engine.prepareDocVectorBackfill(args[0] as number);
			case "loadVectorCache": return engine.loadVectorCache();
			case "search": return engine.search(args[0] as number[] | Float32Array, args[1] as number, args[2] as number, args[3] as string | undefined, args[4] as string[] | undefined);
			case "searchRelatedNotes": return engine.searchRelatedNotes(args[0] as string, args[1] as number, args[2] as number, args[3] as number);
			case "textSearch": return engine.textSearch(args[0] as string, args[1] as number, args[2] as string | undefined, args[3] as string[] | undefined);
			// queue ops
			case "enqueue": return engine.enqueue(args[0] as string, args[1] as QueueAction, args[2] as number);
			case "enqueueMany": return engine.enqueueMany(args[0] as Array<{ notePath: string; action: QueueAction; priority?: number }>);
			case "dequeue": return engine.dequeue(args[0] as number);
			case "complete": return engine.complete(args[0] as number);
			case "fail": return engine.fail(args[0] as number, args[1] as string);
			case "retryFailed": return engine.retryFailed();
			case "getPendingCount": return engine.getPendingCount();
			case "getCounts": return engine.getCounts();
			case "cleanup": return engine.cleanup(args[0] as number);
			case "cleanupQueue": return engine.cleanupQueue();
			case "reviveProcessing": return engine.reviveProcessing();
			case "purgeGhostQueue": return engine.purgeGhostQueue(args[0] as Set<string>);
			case "clearQueue": return engine.clearQueue();
			case "getPendingPaths": return engine.getPendingPaths();
			default:
				throw new Error(`Unknown op: ${op}`);
		}
	};
}
