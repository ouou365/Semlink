// ========================================
// Semlink - DB Worker (browser Web Worker)
// ========================================
// Browser entry for renderers where Node worker_threads is unavailable
// (Obsidian's Electron renderer). Same JSON-RPC-ish protocol as
// db-worker.ts; persistence goes through the OPFS-backed fs shim (aliased
// as "fs" in the esbuild browser build).
//
// Loaded via adapter.getResourcePath(...) from the main thread.

import "./browser-polyfills";
import { initBrowserFs, ensureFileSync, existsSync as existsSyncShim, writeFileSync } from "./browser-fs";
import { createDispatcher } from "./db-worker-core";

// Virtual root: all engine paths are relative to the OPFS namespace.
const dispatch = createDispatcher();
let ready = false;

const selfAsAny: any = self;

selfAsAny.onmessage = async (e: MessageEvent) => {
	const { reqId, op, args } = (e.data ?? {}) as { reqId?: number; op: string; args?: any[] };

	// One-time seed: store the legacy disk DB in OPFS before the engine
	// initializes. Skipped when an OPFS copy already exists — never
	// overwrite a newer OPFS index with the stale disk one.
	if (op === "seedDb") {
		try {
			await initBrowserFs("semlink-db");
			await ensureFileSync("vault.db");
			if (!existsSyncShim("vault.db")) {
				writeFileSync("vault.db", new Uint8Array((args?.[0] as ArrayBuffer) ?? 0));
			}			selfAsAny.postMessage({ reqId, result: null });
		} catch (err) {
			selfAsAny.postMessage({ reqId, error: String(err instanceof Error ? err.message : err) });
		}
		return;
	}

	try {
		if (!ready) {
			if (op !== "init") throw new Error(`Engine not initialized (op=${op})`);
			await initBrowserFs("semlink-db");
			// Pre-open every path the engine will write synchronously.
			await ensureFileSync("vault.db");
			await ensureFileSync("vault.db.tmp");
			await dispatch("init", [""]); // dataDir "" = the OPFS namespace root
			ready = true;
			selfAsAny.postMessage({ reqId, result: null });
			return;
		}
		if (op === "close") {
			// save + close; the page may be unloading — respond first, then close.
			await dispatch("close", []);
			selfAsAny.postMessage({ reqId, result: null });
			selfAsAny.close();
			return;
		}
		const result = await dispatch(op, args ?? []);
		selfAsAny.postMessage({ reqId, result });
	} catch (err) {
		selfAsAny.postMessage({
			reqId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
};
