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
import type { DbMode } from "./sqlite-wasm-driver";
import type { NoteChunk, QueueAction } from "./types";

export type Dispatcher = (op: string, args: unknown[]) => Promise<unknown>;

// ──── Worker 侧环形日志（2026-11-18 debug 面板） ────
// 生产环境 worker 的 console/debugLog 远程不可见——RPC 异常、慢操作、
// 未处理 rejection 全部落这条 ring，debug MCP `logs` 工具一键倒出。
export interface WorkerLogEntry {
	at: string;
	kind: "op-error" | "op-slow" | "console-error" | "console-warn" | "unhandled";
	op?: string;
	ms?: number;
	text: string;
}
const WORKER_LOG_RING: WorkerLogEntry[] = [];
const WORKER_LOG_CAP = 200;

export function workerLogPush(kind: WorkerLogEntry["kind"], text: string, op?: string, ms?: number): void {
	WORKER_LOG_RING.push({ at: new Date().toISOString(), kind, op, ms, text: String(text).slice(0, 800) });
	if (WORKER_LOG_RING.length > WORKER_LOG_CAP) WORKER_LOG_RING.shift();
}

export function workerLogGet(clear?: boolean): WorkerLogEntry[] {
	const out = WORKER_LOG_RING.slice();
	if (clear) WORKER_LOG_RING.length = 0;
	return out;
}

/** Create a dispatcher closure owning one DbEngine instance. The dataDir
 *  arrives with the "init" op (each host passes its own); args[1] = 存储驱动
 *  模式（"wasm" = 浏览器 Worker + OPFS 页级持久化；缺省 "sqljs" = sql.js
 *  内存镜像 + 全量导出，Node worker / sync fallback 兼容形态）。 */
export function createDispatcher(): Dispatcher {
	let engine: DbEngine | null = null;

	// dispatch 层统一捕获：op 异常（消息+栈）与慢操作（>2s）进 ring，
	// `logs` 工具远程可读——生产环境 worker 异常不再黑洞。
	return async (op: string, args: unknown[]): Promise<unknown> => {
		const t0 = Date.now();
		try {
			const out = await dispatchInner(op, args);
			const ms = Date.now() - t0;
			if (ms > 2000) workerLogPush("op-slow", `${op} took ${ms}ms`, op, ms);
			return out;
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			const stack = e instanceof Error && e.stack ? ` | ${e.stack.split("\n").slice(1, 4).join(" | ")}` : "";
			workerLogPush("op-error", `${op}: ${msg}${stack}`, op, Date.now() - t0);
			throw e;
		}
	};

	async function dispatchInner(op: string, args: unknown[]): Promise<unknown> {
		// 不依赖 engine：init 崩溃期间的日志恰恰最有价值
		if (op === "getWorkerLogs") return workerLogGet(args[0] === true);
		if (!engine) {
			// Only "init" is valid before the engine exists.
			if (op === "init") {
				engine = new DbEngine(args[0] as string);
				await engine.init((args[1] as DbMode | undefined) ?? "sqljs");
				// 回传 init 分相计时（boot-perf 取证；原先回 null 无人消费）
				return engine.getInitMarks();
			}
			throw new Error(`Engine not initialized (op=${op})`);
		}

		switch (op) {
			case "chunk": return chunkMarkdown(args[0] as string, args[1] as string, args[2] as number, args[3] as number);
			case "save": return engine.save();
			case "exportDb": return engine.exportDb();
			case "lastIndexTime": return engine.lastIndexTime();
			case "auditlog": return engine.auditLog();
			case "durability": return engine.durabilityInfo();
			case "snapshotNow": return engine.writeSnapshotNow();
			case "repairFromBytes": return engine.repairFromBytes(args[0] as Uint8Array, args[1] === true);
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
			case "noteHasVectors": return engine.noteHasVectors(args[0] as string);
			case "getActiveChunks": return engine.getActiveChunks();
			case "vectorCount": return engine.vectorCount();
			case "flushVectorCacheFile": return engine.flushVectorCacheFile(args[0] === true);
			case "getChunkById": return engine.getChunkById(args[0] as string);
			case "markChunksStale": return engine.markChunksStale(args[0] as string);
			case "deleteChunksByNotePath": return engine.deleteChunksByNotePath(args[0] as string);
			case "deleteStaleChunks": return engine.deleteStaleChunks(args[0] as string);
			case "renameNotePath": return engine.renameNotePath(args[0] as string, args[1] as string);
			case "getNoteMtime": return engine.getNoteMtime(args[0] as string);
			case "getAllNoteMtimeEntries": return engine.getAllNoteMtimeEntries();
			case "debugExecSql": return engine.debugExecSql(args[0] as string);
			case "touchNoteMtime": return engine.touchNoteMtime(args[0] as string, args[1] as number);
			case "getAllIndexedPaths": return engine.getAllIndexedPaths();
			case "pruneOrphanedPaths": return engine.pruneOrphanedPaths(args[0] as Set<string>);
			case "getStats": return engine.getStats();
			case "getEmbeddedNoteCount": return engine.getEmbeddedNoteCount();
			case "getEmbedSkippedNoteCount": return engine.getEmbedSkippedNoteCount();
			case "listVectorlessNotes": return engine.listVectorlessNotes(args[0] as number | undefined);
			case "countVectorlessNotes": return engine.countVectorlessNotes();
			case "queueDiagnostics": return engine.queueDiagnostics();
			case "listIndexedNotePaths": return engine.listIndexedNotePaths();
			case "markEmbedSkip": return engine.markEmbedSkip(args[0] as string, args[1] as boolean);
			case "backfillEmbedSkips": return engine.backfillEmbedSkips();
			case "saveEmbeddings": return engine.saveEmbeddings(args[0] as string[], args[1] as number[][]);
			case "saveDocEmbedding": return engine.saveDocEmbedding(args[0] as string, args[1] as number[], args[2] as number, args[3] as string);
			case "getDocVectorNotePaths": return engine.getDocVectorNotePaths();
			case "prepareDocVectorBackfill": return engine.prepareDocVectorBackfill(args[0] as number);
			case "loadVectorCache": return engine.loadVectorCache();
			case "search": return engine.search(args[0] as number[] | Float32Array, args[1] as number, args[2] as number, args[3] as string | undefined, args[4] as string[] | undefined, args[5] as string[] | undefined);
			case "searchRelatedNotes": return engine.searchRelatedNotes(args[0] as string, args[1] as number, args[2] as number, args[3] as number);
			case "textSearch": return engine.textSearch(args[0] as string, args[1] as number, args[2] as string | undefined, args[3] as string[] | undefined, args[4] as string[] | undefined);
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
			case "purgeRedundantQueue": return engine.purgeRedundantQueue(args[0] as Array<{ path: string; mtime: number }>);
			case "noteProbe": return engine.noteProbe(args[0] as string);
			case "invalidateStats": return engine.invalidateStats();
			case "clearQueue": return engine.clearQueue();
			case "getPendingPaths": return engine.getPendingPaths();
			// ── debug 面板（2026-11-18）──
			case "debugExecSqlWrite": return engine.debugExecSqlWrite(args[0] as string);
			case "debugDbState": return engine.debugDbState();
			case "debugQueueFailures": return engine.debugQueueFailures();
			default:
				throw new Error(`Unknown op: ${op}`);
		}
	}
}
