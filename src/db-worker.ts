// ========================================
// Semlink - DB Worker (worker_threads child)
// ========================================
// Node worker_threads entry — runs on desktop Electron where worker_threads
// is available. The op dispatch table lives in db-worker-core.ts, shared
// with the browser Web Worker entry (db-worker.browser.ts).
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
import { createDispatcher } from "./db-worker-core";

const dispatch = createDispatcher();

parentPort?.on("message", async (msg: any) => {
	const { reqId, op, args } = msg;

	// "close" is special: synchronous flush then exit, used by onunload.
	if (op === "close") {
		try {
			await dispatch("close", []);
			parentPort?.postMessage({ reqId, result: null });
		} catch (e) {
			parentPort?.postMessage({ reqId, error: String(e) });
		}
		// Exit the worker cleanly.
		process.exit(0);
		return;
	}

	try {
		const result = await dispatch(op, args ?? []);
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
	void dispatch("save", []).catch(() => {});
});
