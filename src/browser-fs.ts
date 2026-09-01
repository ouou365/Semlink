// ========================================
// Semlink - browser fs shim (OPFS-backed)
// ========================================
// A synchronous `fs`-compatible shim backed by the Origin Private File System
// (OPFS) *sync access handles* — only usable inside a Web Worker. The browser
// build of the DB worker aliases "fs" to this module so DbEngine's
// readFileSync/writeFileSync/renameSync/... calls keep working unchanged.
//
// Init walks the OPFS namespace once (async) and opens a sync handle per
// file; afterwards every fs operation is a plain synchronous map lookup.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandle = any;

let rootDir: AnyHandle = null; // the OPFS sub-directory namespace
let namespaceName = "semlink-db";
const handles = new Map<string, AnyHandle>(); // normalized path → open sync handle
const memoryFiles = new Map<string, Uint8Array>(); // paths with no OPFS handle yet

const norm = (p: string): string => p.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");

/** Walk the namespace once and open sync handles for existing files. */
export async function initBrowserFs(namespace = "semlink-db"): Promise<void> {
	// Idempotent: handles persist across calls (re-opening a file that
	// already has a sync access handle would throw).
	if (rootDir) return;
	namespaceName = namespace;
	const root = await navigator.storage.getDirectory();
	rootDir = await root.getDirectoryHandle(namespaceName, { create: true });
	for await (const [name, handle] of (rootDir as AnyHandle).entries()) {
		if (handle.kind === "file") {
			// createSyncAccessHandle isn't in this project's DOM lib types yet.
			handles.set(name, await (handle as AnyHandle).createSyncAccessHandle());
		}
	}
}

const getHandle = (path: string): AnyHandle => {
	const key = norm(path);
	const h = handles.get(key);
	if (!h) {
		// Diagnostic: shows exactly which handles the worker owns when a
		// path goes missing (e.g. vault.db.tmp after a worker restart).
		console.error("[Semlink] fs ENOENT:", key, "known:", [...handles.keys()]);
		throw new Error(`ENOENT: no such file ${key}`);
	}
	return h;
};

const ensureFile = async (path: string): Promise<AnyHandle> => {
	const key = norm(path);
	let h = handles.get(key);
	if (h) return h;
	const fh = await (rootDir as AnyHandle).getFileHandle(key, { create: true });
	h = await fh.createSyncAccessHandle();
	handles.set(key, h);
	return h;
};

export function existsSync(path: string): boolean {
	const key = norm(path);
	return handles.has(key) || memoryFiles.has(key);
}

export function mkdirSync(_path: string, _opts?: unknown): void {
	/* namespace is pre-created; directories are implicit */
}

export function readFileSync(path: string): Uint8Array {
	const key = norm(path);
	const h = handles.get(key);
	if (h) {
		const buf = new Uint8Array(h.getSize());
		h.read(buf, { at: 0 });
		return buf;
	}
	const mem = memoryFiles.get(key);
	if (mem) return mem;
	console.error("[Semlink] fs ENOENT:", key, "known opfs:", [...handles.keys()], "memory:", [...memoryFiles.keys()]);
	throw new Error(`ENOENT: no such file ${key}`);
}

/** Open (create if needed) a sync handle for a known file path up front.
 *  The browser worker calls this for every path the engine will touch so
 *  that writeFileSync afterwards never needs an async handle lookup. */
export async function ensureFileSync(path: string): Promise<void> {
	const key = norm(path);
	if (handles.has(key)) return;
	const fh = await (rootDir as AnyHandle).getFileHandle(key, { create: true });
	handles.set(key, await fh.createSyncAccessHandle());
}

export function writeFileSync(path: string, data: Uint8Array): void {
	const key = norm(path);
	const h = handles.get(key);
	if (h) {
		h.write(data, { at: 0 });
		h.truncate(data.length);
		h.flush();
		return;
	}
	// No OPFS handle for this path (e.g. the scratch .tmp was consumed by
	// a previous rename) — back it in memory until rename/persist moves it.
	memoryFiles.set(key, data);
}

export function renameSync(from: string, to: string): void {
	const data = readFileSync(from);
	writeFileSync(norm(to), data);
	// Keep the source file + its open sync handle alive, truncated to zero:
	// the engine reuses vault.db.tmp as its scratch file on every save, and
	// re-opening a sync access handle needs an async call the sync fs API
	// cannot do (deleting it here caused ENOENT on the next save).
	const fromHandle = handles.get(norm(from));
	if (fromHandle) fromHandle.truncate(0);
	else memoryFiles.delete(norm(from));
}

export function unlinkSync(path: string): void {
	const key = norm(path);
	const h = handles.get(key);
	if (h) {
		try { h.close(); } catch { /* already closed */ }
		handles.delete(key);
	}
	(rootDir as AnyHandle).removeEntry(key).catch(() => { /* gone already */ });
}

export function statSync(path: string): { size: number; isFile: () => boolean; mtimeMs: number } {
	const h = getHandle(path);
	return { size: h.getSize(), isFile: () => true, mtimeMs: Date.now() };
}
