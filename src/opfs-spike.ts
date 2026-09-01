// ========================================
// Semlink - one-shot OPFS feasibility spike
// ========================================
// Verifies, inside the REAL app://obsidian.md renderer: browser Worker from
// a blob URL, OPFS availability inside that worker, async write/read
// round-trip, and the worker-only createSyncAccessHandle fast path. Writes
// the results to opfs-spike-result.json next to the plugin so they can be
// read from outside the app. Remove after the Web Worker migration lands.

import type { App } from "obsidian";

const WORKER_CODE = `
self.onmessage = async () => {
	const out = {};
	try {
		out.inWorker = true;
		out.opfsApiPresent = typeof navigator.storage?.getDirectory === "function";
		const root = await navigator.storage.getDirectory();
		const dir = await root.getDirectoryHandle("semlink-spike", { create: true });
		const fh = await dir.getFileHandle("roundtrip.txt", { create: true });
		const payload = "hello from " + self.location.origin;
		const w = await fh.createWritable();
		await w.write(new TextEncoder().encode(payload));
		await w.close();
		out.readBack = await (await fh.getFile()).text();
		out.asyncRoundTrip = out.readBack === payload;
		const sfh = await dir.getFileHandle("sync.dat", { create: true });
		const sh = await sfh.createSyncAccessHandle();
		const buf = new TextEncoder().encode("sync-ok");
		sh.write(buf, { at: 0 });
		sh.truncate(buf.length);
		const rd = new Uint8Array(buf.length);
		sh.read(rd, { at: 0 });
		sh.close();
		out.syncAccessHandle = new TextDecoder().decode(rd) === "sync-ok";
		out.ok = out.asyncRoundTrip && out.syncAccessHandle;
	} catch (err) {
		out.error = String(err && err.message || err);
	}
	self.postMessage(out);
};
`;

/** Run the spike and persist the report. Never throws. */
export async function runOpfsSpike(app: App, pluginId: string): Promise<void> {
	const out: Record<string, unknown> = {
		startedAt: new Date().toISOString(),
		origin: location.origin,
	};
	try {
		out.secureContext = window.isSecureContext;
		out.opfsMainThread = typeof (navigator as unknown as { storage?: { getDirectory?: unknown } }).storage?.getDirectory === "function";

		const worker = new Worker(URL.createObjectURL(new Blob([WORKER_CODE], { type: "text/javascript" })));
		out.worker = await new Promise((resolve, reject) => {
			worker.onmessage = (e) => resolve(e.data);
			worker.onerror = (e) => reject(new Error(String((e as ErrorEvent).message || "worker error")));
			worker.postMessage("go");
			window.setTimeout(() => reject(new Error("worker timeout (10s)")), 10000);
		});
		worker.terminate();
	} catch (e) {
		out.error = String(e);
	}
	try {
		const path = `${app.vault.configDir}/plugins/${pluginId}/opfs-spike-result.json`;
		await app.vault.adapter.write(path, JSON.stringify(out, null, 2));
	} catch (e) {
		console.error("Semlink OPFS spike: failed to write result file", e);
	}
}
