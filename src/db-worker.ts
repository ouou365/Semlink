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
let ready = false;
/** init 完成前到达的调用排队（与 browser worker 同策略）——直接 throw
 *  会让主线程把调用当失败（同款启动竞态）。 */
const preInitQueue: Array<{ reqId?: number; op: string; args?: unknown[] }> = [];

/** Main → worker request: one op plus its positional arguments. */
interface WorkerRequest {
	reqId?: number;
	op: string;
	args?: unknown[];
}

parentPort?.on("message", (msg: WorkerRequest) => void (async () => {
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
		if (!ready && op !== "init" && op !== "close") {
			// init（含大库加载）完成前到达的调用入队，init 后补处理
			preInitQueue.push({ reqId, op, args: args ?? [] });
			return;
		}
		const result = await dispatch(op, args ?? []);
		parentPort?.postMessage({ reqId, result });
		if (!ready) {
			// init 刚完成 → 补处理排队的调用
			ready = true;
			const queued = preInitQueue.splice(0);
			for (const item of queued) {
				try {
					const r2 = await dispatch(item.op, item.args ?? []);
					parentPort?.postMessage({ reqId: item.reqId, result: r2 });
				} catch (e2) {
					parentPort?.postMessage({ reqId: item.reqId, error: String(e2 instanceof Error ? e2.message : e2) });
				}
			}
		}
	} catch (e) {
		parentPort?.postMessage({
			reqId,
			error: e instanceof Error ? e.message : String(e),
		});
	}
})());

// Safety net: if the host process is about to exit, flush what we can.
// beforeExit fires on the main thread's event loop idle; in a worker it's
// still a useful last-resort hook.
process.on("beforeExit", () => {
	void dispatch("save", []).catch(() => {});
});
