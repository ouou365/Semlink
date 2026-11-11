// ========================================
// Semlink - sqlite3-wasm driver (page-level persistence)
// ========================================
// Wraps the official @sqlite.org/sqlite-wasm build with the sql.js-shaped
// surface DbEngine expects (exec -> QueryResult[], run, export, close).
//
// Why this replaces sql.js (2026-11-11 spike + 真机事故):
//   sql.js keeps the whole DB in memory and only persists via a full-DB
//   export (~393MB) — which ran just once per scan exit, so a reload lost
//   the entire run's progress and the queue restarted from zero. This
//   driver uses the `opfs-sahpool` VFS: every transaction commits its dirty
//   pages straight to OPFS (KB-scale), i.e. persistence IS the write, and
//   reloads resume from the last committed note instead of rescanning.
//
// Migration: the sql.js-era DB lives in the fs-shim namespace
// (`semlink-db/vault.db`, see browser-fs.ts). On first open with non-empty
// legacy bytes we copy them into the OPFS root file that opfs-sahpool
// opens, back the legacy file up and truncate it to zero (size-0 = "already
// migrated" marker — a real sql.js DB is never zero bytes).
//
// Scope: browser Web Worker only. opfs-sahpool needs FileSystemSyncAccess
// Handle (worker context), which is exactly where this driver is used. The
// Node worker (db-worker.ts) and the sync fallback keep the sql.js driver.

import initSqlJsOfficial from "@sqlite.org/sqlite-wasm";
import sqlite3WasmBase64 from "@sqlite.org/sqlite-wasm/sqlite3.wasm";
import type { Database as SqlJsDatabase } from "sql.js";
// 直接相对路径引入 OPFS shim（不要走 "fs" 别名：驱动同时被打进 Node 构建，
// 那里 "fs" 是真 fs，没有 ensureFileSync 这类 shim 导出）。旧库迁移（读
// sql.js 时代的命名空间文件）需要它；shim 顶层无副作用，打进 main.js 无害。
import { existsSync as shimExists, readFileSync as shimRead, statSync as shimStat, renameSync as shimRename, ensureFileSync as shimEnsure } from "./browser-fs";

/** sql.js 形态的查询结果（与 DbEngine 现有消费方式逐字节兼容）。 */
type QueryResult = { columns: string[]; values: unknown[][] };

export type DbMode = "wasm" | "sqljs";

interface OfficialStmt {
	bind(params?: unknown[]): void;
	step(): boolean;
	get(): unknown[];
	reset(): void;
	finalize(): void;
	getColumnNames(target?: string[]): string[];
}

interface OfficialDb {
	exec(sql: string): void;
	prepare(sql: string): OfficialStmt;
	serialize(): Uint8Array;
	close(): void;
	pointer: number;
}

interface OfficialCapi {
	sqlite3_changes(dbPtr: number): number;
}

interface PoolUtilLike {
	importDb(name: string, bytes: Uint8Array): Promise<void>;
}

interface OfficialModule {
	oo1: {
		DB: new (opts: { filename: string; vfs: string }) => OfficialDb;
	};
	capi: OfficialCapi;
	installOpfsSAHPoolVfs(options?: Record<string, unknown>): Promise<PoolUtilLike>;
}

const DB_FILE = "vault.db";

/** 把 base64 的 wasm 解码成字节（browser worker 无 Buffer）。 */
function decodeBase64(b64: string): Uint8Array {
	if (typeof Buffer !== "undefined") return Buffer.from(b64, "base64");
	return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** DbEngine 对 DB 句柄的全部依赖面——三种驱动（wasm-sahpool / node-sqlite
 *  / sqljs）都实现这一个小接口，engine 其余代码保持引擎无关。 */
export interface SemDb {
	exec(sql: string, params?: unknown[]): QueryResult[];
	run(sql: string, params?: unknown[]): { changes: number };
	save(): void;
	export(): Uint8Array;
	close(): void;
}

/** sql.js 驱动（sync fallback 主线程 / Node worker 兜底路径）：
 *  整库内存镜像 + save 全量导出。save 的磁盘落盘（含空库保险丝）由
 *  engine 在 sqljs 分支直接实现——本驱动保持无 fs 依赖（wasm 驱动同文件，
 *  浏览器构建里 fs 是 OPFS shim，不能让驱动间接依赖它）。 */
export class SqlJsSemDb implements SemDb {
	constructor(private db: SqlJsDatabase) {}

	exec(sql: string): QueryResult[] {
		return this.db.exec(sql) as unknown as QueryResult[];
	}

	run(sql: string, params?: unknown[]): { changes: number } {
		return this.db.run(sql, params);
	}

	save(): void {
		// 全量导出的实际落盘在 engine.save() 的 sqljs 分支（需要 dataDir/fs）。
		// 这里保持接口形状：export 的字节由调用方写盘。
	}

	export(): Uint8Array {
		return this.db.export();
	}

	close(): void {
		this.db.close();
	}
}

export class SqliteWasmDb {
	private db: OfficialDb;
	private capi: OfficialCapi;
	private stmtCache = new Map<string, OfficialStmt>();
	/** 页大小 × 页数（getStats 的 dbSizeMb 用，替代磁盘 statSync）。 */
	bytesTotal = 0;

	private constructor(db: OfficialDb, capi: OfficialCapi) {
		this.db = db;
		this.capi = capi;
		const r = this.exec("PRAGMA page_count");
		const page = this.exec("PRAGMA page_size");
		this.bytesTotal = Number(r[0]?.values[0]?.[0] ?? 0) * Number(page[0]?.values[0]?.[0] ?? 0);
	}

	/** 打开（含一次性迁移）：legacyBytes = sql.js 时代命名空间里的旧库字节
	 *  （调用方从 fs shim 读好传入；非空才迁移）。迁移写法：把字节写进
	 *  opfs-sahpool 将要打开的 OPFS 根路径文件——必须在 sahpool 拿独占
	 *  句柄之前完成。之后事务即持久，save() 退化为周期维护。 */
	static async open(): Promise<SqliteWasmDb> {
		const wasmBinary = decodeBase64(sqlite3WasmBase64 as string).buffer;
		// 关掉 'opfs'/'opfs-vfs' 的自动安装：它们要按相对 URL 起 proxy worker，
		// 在 esbuild 打包后的 Blob-URL Worker 里 new URL 会 Invalid URL（真机
		// 2026-11-11：browser worker init 因此整体失败 → 掉进 sync fallback）。
		// bootstrap 从 globalThis.sqlite3ApiConfig 读配置；sahpool 不受影响。
		(globalThis as unknown as { sqlite3ApiConfig?: unknown }).sqlite3ApiConfig = {
			disable: { vfs: { opfs: true, "opfs-vfs": true } },
		};
		const initFn = initSqlJsOfficial as unknown as (opts: Record<string, unknown>) => Promise<OfficialModule>;
		const mod = (await initFn({
			wasmBinary,
			// Blob-URL Worker 里 import.meta.url 被 esbuild 换成空对象属性，
			// glue 内部 new URL("sqlite3.wasm", import.meta.url) 会 Invalid URL
			// （wasm 加载器 uj 的无条件路径计算，真机+本地复现）。
			// locateFile 恒定返回文件名 + wasmBinary 已提供 → 永不走 URL fetch。
			locateFile: (f: string) => f,
		})) as unknown as OfficialModule;

		// 显式安装 opfs-sahpool VFS（不会自动注册；返回的 PoolUtil 提供
		// importDb——官方文档推荐的 DB 字节导入通道，正好承接 sql.js 旧库迁移）。
		let poolUtil: PoolUtilLike;
		try {
			poolUtil = await mod.installOpfsSAHPoolVfs({ name: "opfs-sahpool" });
		} catch (e) {
			throw new Error(`[wasm-driver installOpfsSAHPoolVfs] ${e instanceof Error ? e.message : String(e)}`);
		}
		// 迁移：shim 命名空间（'semlink-db'）的旧库 → importDb 进 pool。
		const legacySize = shimExists(DB_FILE) ? shimStat(DB_FILE).size : 0;
		if (legacySize > 0) {
			const legacy = shimRead(DB_FILE);
			await poolUtil.importDb(DB_FILE, legacy);
			// 备份 + 源清零（shim renameSync = 写新文件 + 源截零；源句柄保留）。
			// size 0 = 已迁移标记，下次启动跳过。
			shimEnsure(`${DB_FILE}.pre-wasm.bak`);
			shimRename(DB_FILE, `${DB_FILE}.pre-wasm.bak`);
			console.log(`[Semlink] migrated legacy sql.js DB (${Math.round(legacySize / 1048576)}MB) into sqlite3-wasm opfs-sahpool storage`);
		}

		const db = new mod.oo1.DB({ filename: DB_FILE, vfs: "opfs-sahpool" });
		return new SqliteWasmDb(db, mod.capi);
	}

	/** 查询（SELECT/PRAGMA）：返回 sql.js 形态的结果组。DML 返回空数组，
	 *  与 sql.js exec 行为一致——DbEngine 的调用点（r.length === 0 判断）
	 *  无需修改。db-engine 的查询全部是单语句，这里按单语句编译执行。 */
	exec(sql: string, params?: unknown[]): QueryResult[] {
		const stmt = this.db.prepare(sql);
		try {
			if (params !== undefined && params.length > 0) stmt.bind(params);
			const columns = stmt.getColumnNames();
			const values: unknown[][] = [];
			// 官方 OO API 的 get() 无无参重载：get(array) = 用行值回填数组。
			// 无参调用会走 affirmColIndex(undefined) → "Column index is out of range"。
			while (stmt.step()) {
				const row: unknown[] = [];
				stmt.get(row);
				values.push(row);
			}
			return values.length > 0 ? [{ columns, values }] : [];
		} catch (e) {
			throw new Error(`[wasm-driver exec] ${sql.slice(0, 60)} | ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			stmt.finalize();
		}
	}

	/** 写入：带参数 = 预编译（语句缓存，重嵌入的逐行 UPDATE 不再反复编译）；
	 *  无参数 = 透传多语句 DDL。 */
	run(sql: string, params?: unknown[]): { changes: number } {
		if (params === undefined) {
			this.db.exec(sql);
			return { changes: 0 };
		}
		const stmt = this.stmtCache.get(sql) ?? this.cacheStmt(sql);
		stmt.reset();
		stmt.bind(params);
		stmt.step();
		return { changes: this.capi.sqlite3_changes(this.db.pointer) };
	}

	private cacheStmt(sql: string): OfficialStmt {
		const stmt = this.db.prepare(sql);
		this.stmtCache.set(sql, stmt);
		return stmt;
	}

	/** 保存：opfs-sahpool 下事务即持久化——这里退化为周期性维护
	 *  （PRAGMA optimize 重整查询规划），不再有全量导出。 */
	save(): void {
		try { this.exec("PRAGMA optimize"); } catch { /* 维护失败不影响主流程 */ }
	}

	/** 删除 OPFS 根上的库文件（损坏恢复：备份后删库重开）。静态方法，
	 *  不持有 sahpool 句柄时才能删——只在 open 失败路径调用。 */
	static async removeDbFile(): Promise<void> {
		const root = await navigator.storage.getDirectory();
		try { await root.removeEntry(DB_FILE); } catch { /* 本就不存在 */ }
	}

	/** 整库字节（备份/诊断用；热路径不调用）。 */
	export(): Uint8Array {
		return this.db.serialize();
	}

	close(): void {
		for (const stmt of this.stmtCache.values()) {
			try { stmt.finalize(); } catch { /* 已释放 */ }
		}
		this.stmtCache.clear();
		this.db.close();
	}
}
