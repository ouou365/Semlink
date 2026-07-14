// ========================================
// Semlink - DB Worker (worker_threads child)
// ========================================
// This module runs in a Node worker_threads child, NOT on Obsidian's main
// thread. It owns the real sql.js Database and performs ALL heavy work:
//   - db.export() of the (up to 397MB) in-memory DB
//   - writeFileSync of that DB to disk
//   - brute-force cosine similarity search (tens of thousands of 1024-dim
//     dot products)
// Keeping these off the main thread is what eliminates typing lag.
//
// Communication protocol (JSON-RPC-ish over worker_threads messaging):
//   parent → child : { reqId, op, args }
//   child  → parent: { reqId, result } | { reqId, error }
//
// Special ops (no reqId needed):
//   { op: "close" } → synchronous save() + db.close(), then exits the worker.
//                     Used by the main thread's onunload() so data is flushed
//                     even though Obsidian does not await async onunload.

import { parentPort } from "worker_threads";
import { DbEngine } from "./db-engine";
import { chunkMarkdown } from "./chunker";

let engine: DbEngine | null = null;

/** Dispatch one operation to the engine. Returns the result (serializable). */
async function handle(op: string, args: any[]): Promise<any> {
	if (!engine) {
		// Only "init" is valid before the engine exists.
		if (op === "init") {
			engine = new DbEngine(args[0]);
			await engine.init();
			return null;
		}
		throw new Error(`Engine not initialized (op=${op})`);
	}

	switch (op) {
		case "chunk": return chunkMarkdown(args[0], args[1], args[2], args[3]);
		case "save": return engine.save();
		case "clearAll": return engine.clearAll();
		case "compact": return engine.compact();
		case "close": return engine.close();
		case "beginTransaction": return engine.beginTransaction();
		case "commitTransaction": return engine.commitTransaction();
		case "rollbackTransaction": return engine.rollbackTransaction();
		case "insertChunk": return engine.insertChunk(args[0]);
		case "getChunksByNotePath": return engine.getChunksByNotePath(args[0]);
		case "getActiveChunks": return engine.getActiveChunks();
		case "getChunkById": return engine.getChunkById(args[0]);
		case "markChunksStale": return engine.markChunksStale(args[0]);
		case "deleteChunksByNotePath": return engine.deleteChunksByNotePath(args[0]);
		case "deleteStaleChunks": return engine.deleteStaleChunks(args[0]);
		case "renameNotePath": return engine.renameNotePath(args[0], args[1]);
		case "getNoteMtime": return engine.getNoteMtime(args[0]);
		case "getAllIndexedPaths": return engine.getAllIndexedPaths();
		case "pruneOrphanedPaths": return engine.pruneOrphanedPaths(args[0]);
		case "getStats": return engine.getStats();
		case "saveEmbeddings": return engine.saveEmbeddings(args[0], args[1]);
		case "loadVectorCache": return engine.loadVectorCache();
		case "search": return engine.search(args[0], args[1], args[2]);
		// queue ops
		case "enqueue": return engine.enqueue(args[0], args[1], args[2]);
		case "enqueueMany": return engine.enqueueMany(args[0]);
		case "dequeue": return engine.dequeue(args[0]);
		case "complete": return engine.complete(args[0]);
		case "fail": return engine.fail(args[0], args[1]);
		case "retryFailed": return engine.retryFailed();
		case "getPendingCount": return engine.getPendingCount();
		case "getCounts": return engine.getCounts();
		case "cleanup": return engine.cleanup(args[0]);
		case "clearQueue": return engine.clearQueue();
		case "getPendingPaths": return engine.getPendingPaths();
		default:
			throw new Error(`Unknown op: ${op}`);
	}
}

parentPort?.on("message", async (msg: any) => {
	const { reqId, op, args } = msg;

	// "close" is special: synchronous flush then exit, used by onunload.
	if (op === "close") {
		try {
			if (engine) {
				// Synchronous save() + close() in this child thread. Even if the
				// main thread terminates immediately after, the data is on disk.
				engine.save();
				engine.close();
				engine = null;
			}
			parentPort?.postMessage({ reqId, result: null });
		} catch (e) {
			parentPort?.postMessage({ reqId, error: String(e) });
		}
		// Exit the worker cleanly.
		process.exit(0);
		return;
	}

	try {
		const result = await handle(op, args ?? []);
		parentPort?.postMessage({ reqId, result });
	} catch (e) {
		parentPort?.postMessage({
			reqId,
			error: e instanceof Error ? e.message : String(e),
		});
	}
});

// Safety net: if the host process is about to exit, flush what we can.
// beforeExit fires on the main thread's event loop idle; in a worker it's
// still a useful last-resort hook.
process.on("beforeExit", () => {
	try { engine?.save(); } catch {}
});
