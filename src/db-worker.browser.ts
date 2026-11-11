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
import { initBrowserFs, ensureFileSync, existsSync as existsSyncShim, writeFileSync, readFileSync, listFiles, unlinkSync, statSync as statSyncShim } from "./browser-fs";
import { createDispatcher } from "./db-worker-core";
import { probeSqliteBytes } from "./db-engine";

// Virtual root: all engine paths are relative to the OPFS namespace.
const dispatch = createDispatcher();
let ready = false;
/** init（含旧库迁移 + 大库 OPFS 加载）完成前到达的调用在此排队，init 后
 *  按序补处理——替代旧行为的直接 throw（主线程会把调用当失败）。 */
const preInitQueue: Array<{ reqId?: number; op: string; args?: unknown[] }> = [];

interface WorkerScope {
	postMessage(msg: unknown): void;
	close(): void;
	onmessage: ((e: MessageEvent) => void | Promise<void>) | null;
}
const selfAsAny = self as unknown as WorkerScope;

selfAsAny.onmessage = async (e: MessageEvent) => {
	const { reqId, op, args } = (e.data ?? {}) as { reqId?: number; op: string; args?: unknown[] };

	// One-time seed: store the legacy disk DB in OPFS before the engine
	// initializes. Skipped when an OPFS copy already exists — never
	// overwrite a newer OPFS index with the stale disk one.
	if (op === "fsList") {
		// 诊断：OPFS 命名空间清单（不碰 engine，空库/加载失败态也可用）。
		try {
			const files = await listFiles();
			selfAsAny.postMessage({ reqId, result: files });
		} catch (err) {
			selfAsAny.postMessage({ reqId, error: String(err instanceof Error ? err.message : err) });
		}
		return;
	}
	if (op === "fsProbe") {
		// 诊断：解析 OPFS vault.db 的 SQLite 头——magic/页大小/总页数/
		// 空闲页数。空闲页巨大 = 行被清过但页没回收（数据可救性判断）。
		try {
			await initBrowserFs("semlink-db");
			const buf = existsSyncShim("vault.db") ? readFileSync("vault.db") : new Uint8Array(0);
			const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
			let magic = "";
			for (let i = 0; i < 15; i++) magic += String.fromCharCode(buf[i]);
			const pageSize = buf.length >= 18 ? dv.getUint16(16) : 0;
			const pageCount = buf.length >= 32 ? dv.getUint32(28) : 0;
			const freelistTrunk = buf.length >= 40 ? dv.getUint32(36) : 0;
			const freelistCount = buf.length >= 44 ? dv.getUint32(40) : 0;
			// 用 sql.js 实际打开字节并数行——终极判断数据是否在字节里
			const rows = buf.length > 0 ? await probeSqliteBytes(buf) : { chunks: -1, queue: -1, distinctNotes: -1 };
			selfAsAny.postMessage({ reqId, result: { sizeBytes: buf.length, magic, pageSize, pageCount, freelistTrunk, freelistCount, rows } });
		} catch (err) {
			selfAsAny.postMessage({ reqId, error: String(err instanceof Error ? err.message : err) });
		}
		return;
	}
	if (op === "fsResetDb") {
		// 补救：把 OPFS 里被写坏的空壳 vault.db 删掉让路——下一次 init 的
		// seedDb 会把磁盘库重新种进来。空壳数据已确认 0 行（fsProbe），
		// 无保留价值；磁盘另有 vault.db.bak-20261111 兜底。
		try {
			await initBrowserFs("semlink-db");
			const existed = existsSyncShim("vault.db");
			if (existed) unlinkSync("vault.db");
			selfAsAny.postMessage({ reqId, result: { removed: existed } });
		} catch (err) {
			selfAsAny.postMessage({ reqId, error: String(err instanceof Error ? err.message : err) });
		}
		return;
	}
	if (op === "seedDb") {
		// 一次性播种磁盘库进 OPFS。原实现 ensureFileSync 在 existsSync 之前
		// 把文件建出来，existsSync 恒真 → 写入永远被跳过（真机 2026-11-11：
		// 重置 OPFS 后文件 0 字节、seed 静默不写）。
		// 规则：OPFS 文件 0 字节 → 播种；主线程传 force=true（磁盘有
		// reseed.requested 标记，恢复流程用）→ 无条件覆盖。非 0 且无
		// force = 已有更新索引，跳过（绝不拿化石磁盘库覆盖活索引）。
		try {
			await initBrowserFs("semlink-db");
			await ensureFileSync("vault.db");
			const bytes = (args?.[0] as Uint8Array) ?? new Uint8Array(0);
			const force = args?.[1] === true;
			const cur = statSyncShim("vault.db").size;
			const shouldSeed = force || (cur === 0 && bytes.length > 0);
			if (shouldSeed && bytes.length > 0) {
				writeFileSync("vault.db", bytes);
			}
			selfAsAny.postMessage({ reqId, result: { seeded: shouldSeed && bytes.length > 0, force, existingBytes: cur, seedBytes: bytes.length } });
		} catch (err) {
			selfAsAny.postMessage({ reqId, error: String(err instanceof Error ? err.message : err) });
		}
		return;
	}

	try {
		if (!ready) {
			if (op !== "init") {
				// init（含旧库迁移 + 大库加载）完成前到达的调用入队，init 后
				// 按序补处理——直接 throw 会让主线程把调用当失败（真机报障：
				// "purgeExcludedFromIndex failed: Engine not initialized"，2026-11-11）。
				preInitQueue.push({ reqId, op, args: args ?? [] });
				return;
			}
			await initBrowserFs("semlink-db");
			// mode="wasm"：sqlite3-wasm + opfs-sahpool（事务即落盘）。旧 sql.js
			// 库的迁移（semlink-db/vault.db → OPFS 根 → 备份清零）封装在驱动
			// open() 里；不再需要 sql.js 时代的 .tmp 草稿文件。
			await dispatch("init", ["", "wasm"]);
			ready = true;
			selfAsAny.postMessage({ reqId, result: null });
			// 补处理 init 期间排队的调用
			const queued = preInitQueue.splice(0);
			for (const item of queued) {
				try {
					const result = await dispatch(item.op, item.args ?? []);
					selfAsAny.postMessage({ reqId: item.reqId, result });
				} catch (err) {
					selfAsAny.postMessage({ reqId: item.reqId, error: String(err instanceof Error ? err.message : err) });
				}
			}
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
		// init 失败必须可远程诊断：错误消息 + 栈头一起回主线程
		const msg = err instanceof Error ? err.message : String(err);
		const stack = err instanceof Error ? (err.stack ?? "").split("\n").slice(0, 4).join(" | ") : "";
		selfAsAny.postMessage({
			reqId,
			error: msg + (stack ? " | " + stack : ""),
		});
	}
};
