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
import { existsSync as shimExists, readFileSync as shimRead, statSync as shimStat, renameSync as shimRename, ensureFileSync as shimEnsure, writeFileSync as shimWrite } from "./browser-fs";

/** sql.js 形态的查询结果（与 DbEngine 现有消费方式逐字节兼容）。 */
type QueryResult = { columns: string[]; values: unknown[][] };

export type DbMode = "wasm" | "sqljs";

interface OfficialStmt {
	bind(params?: unknown[]): void;
	step(): boolean;
	/** 官方 API 两种形态都有：get()（带列索引）与 get(array)（整行回填，
	 *  本驱动统一用后者——无参 get() 会走 affirmColIndex(undefined) 抛越界）。 */
	get(data?: unknown[]): unknown[];
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
	/** 整库序列化（export/备份诊断用）：本构建的 sqlite3_serialize 绑定返回
	 *  裸指针数字，Uint8Array 适配层在 sqlite3_js_db_export（官方 JS 包装）。 */
	sqlite3_js_db_export(pDb: number, schema?: string | number): Uint8Array;
}

interface PoolSahLike {
	getSize(): number;
}

interface PoolUtilLike {
	importDb(name: string, bytes: Uint8Array): Promise<void>;
	/** 槽句柄（同一 sync access handle 只能开一个——pool 自己持有，
	 *  这里只借用 getSize 取槽字节数做诊断）。 */
	getSAHForPath?(path: string): PoolSahLike | undefined;
}

interface OfficialModule {
	oo1: {
		DB: new (opts: { filename: string; vfs: string }) => OfficialDb;
	};
	capi: OfficialCapi;
	installOpfsSAHPoolVfs(options?: Record<string, unknown>): Promise<PoolUtilLike>;
}

const DB_FILE = "vault.db";
/** sahpool 槽的 canonical 名（xOpen 经 getSlasherPath 加前导斜杠）。
 *  importDb 不做 canonical 化——真机 2026-11-11 事故：importDb("vault.db")
 *  落在无斜杠槽，open("vault.db") 解析成 "/vault.db" 另开空槽 → 迁移数据
 *  全部不可见 → 全量重扫。所有 API 统一用 DB_PATH。 */
const DB_PATH = "/vault.db";

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
	private poolUtil: PoolUtilLike;
	private stmtCache = new Map<string, OfficialStmt>();
	/** 页大小 × 页数（getStats 的 dbSizeMb 用，替代磁盘 statSync）。 */
	bytesTotal = 0;

	private constructor(db: OfficialDb, capi: OfficialCapi, poolUtil: PoolUtilLike, private reopenDb: () => OfficialDb) {
		this.db = db;
		this.capi = capi;
		this.poolUtil = poolUtil;
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
		// shim 命名空间（'semlink-db'）里的 vault.db 有两种身份：
		// a) sql.js 时代的旧库（一次性迁移源）；b) 耐久快照（writeLegacySnapshot
		// 每 ≥10min 写一次的整库副本，槽丢失时的恢复源）。
		// 名字必须用 canonical 的 DB_PATH（带斜杠），与 open 对齐（见 DB_PATH 注释）。
		const legacySize = shimExists(DB_FILE) ? shimStat(DB_FILE).size : 0;
		const openDb = (): OfficialDb => new mod.oo1.DB({ filename: DB_PATH, vfs: "opfs-sahpool" });
		const pageCountOf = (d: OfficialDb): number => {
			const stmt = d.prepare("PRAGMA page_count");
			try {
				// get() 无参重载会 affirmColIndex(undefined) 抛越界（见本文件
				// exec 的注释）——必须用 get(array) 回填。
				const row: unknown[] = [];
				stmt.step();
				stmt.get(row);
				return Number(row[0] ?? 0);
			} finally { stmt.finalize(); }
		};
		// 导入 shim 镜像进槽（恢复场景专用）+ bak 留底 + 源清零。
		// await 必须显式：ensureFileSync 是 async（SAH 注册在微任务后），
		// 不 await 的话 renameSync 落笔时 handles 还没有 bak → 写进
		// memoryFiles（进程死即失），磁盘 bak 永远 0 字节（真机 2026-11-11）。
		const importLegacy = async (reason: string): Promise<void> => {
			const legacy = shimRead(DB_FILE);
			await poolUtil.importDb(DB_PATH, legacy);
			await shimEnsure(`${DB_FILE}.pre-wasm.bak`);
			shimRename(DB_FILE, `${DB_FILE}.pre-wasm.bak`);
			// 迁移完成标记：断掉「自动播种 → 迁移」的死循环（详见旧注释——
			// marker 失踪会让化石盘库被反复播种/导入，覆盖活槽）。
			// marker 必须先 ensureFileSync：shimWrite 无句柄时落 memoryFiles，
			// worker 一死标记即失 → 下轮启动化石重播种 + 重迁移。
			await shimEnsure(`${DB_FILE}.migrated`);
			shimWrite(`${DB_FILE}.migrated`, new Uint8Array(1));
			console.error(`[Semlink][migdbg] import(${reason}) legacyBytes=${legacy.byteLength} bakSize=${shimStat(`${DB_FILE}.pre-wasm.bak`).size} vaultSize=${shimStat(DB_FILE).size}`);
		};

		// 首开探测（守卫的核心）：sqlite 自己报槽状态——
		//   open 抛错            → 槽页撕裂/损坏
		//   page_count == 0      → 槽空（从未初始化或槽丢失）
		//   page_count > 0       → 活槽健在，内容必然 ≥ 任何 shim 快照
		// 旧代码只看 legacySize>0 就 importDb——耐久快照写成功后，下次 reload
		// 就把活槽整体回滚到快照时刻（真机 2026-11-23:23:36/23:44 两次实测
		// 216→203、300→251 的「reload 丢已嵌入数据」根因），还把 pre-wasm.bak
		// 顶掉。守卫三分支：
		//   活槽健在 + 快照在 → 快照过期冗余，清零防后患（绝不 import）
		//   槽空 + 快照在     → 真恢复场景，导入
		//   槽撕裂 + 快照在   → 整槽覆盖重建后重开
		let db: OfficialDb | null = null;
		let pageCount = -1;
		let openErr: unknown = null;
		try {
			db = openDb();
			pageCount = pageCountOf(db);
		} catch (e) {
			openErr = e;
			try { db?.close(); } catch { /* 已死 */ }
			db = null;
		}
		if (db && pageCount === 0 && legacySize > 0) {
			db.close();
			db = null;
			await importLegacy("slot-empty recovery");
			db = openDb();
			pageCount = pageCountOf(db);
		} else if (!db && legacySize > 0) {
			await importLegacy("slot-corrupt repair");
			db = openDb();
			pageCount = pageCountOf(db);
		} else if (db && pageCount > 0 && legacySize > 0) {
			// 活槽 ≥ 快照：清零 shim 快照（writeFileSync 截零，句柄保留），
			// 否则这份过期镜像会一直躺在命名空间里等下一次 reload 误导回。
			shimWrite(DB_FILE, new Uint8Array(0));
			console.error(`[Semlink][migdbg] live slot intact (${pageCount} pages) — stale shim snapshot (${legacySize}B) discarded, NO import`);
		} else if (!db) {
			throw openErr instanceof Error ? openErr : new Error(String(openErr));
		}

		if (!db) throw new Error("[wasm-driver] unreachable: db not opened");
		// 一次性开好 shim vault.db 的句柄：worker 生命周期内的 shim 写
		// （writeLegacySnapshot 耐久快照、迁移标记等）全部落 OPFS 句柄，
		// 跨 worker 重启存活——无句柄的 shimWrite 落 memoryFiles，进程死
		// 即失（marker 失踪引发的化石重播种死循环，见迁移块注释）。
		await shimEnsure(DB_FILE);
		return new SqliteWasmDb(db, mod.capi, poolUtil, openDb);
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

	/** 用完整 DB 字节替换当前槽内容（修复通道）：关连接 → importDb 覆盖
	 *  canonical 槽 → 重开。importDb 对已关联的槽 = 原地覆盖（mapFilename
	 *  ToSAH.get 命中同一个 SAH）。调用方负责 guards（活库非空拒换）。 */
	async replaceFromBytes(bytes: Uint8Array): Promise<void> {
		this.close();
		await this.poolUtil.importDb(DB_PATH, bytes);
		this.db = this.reopenDb();
		const r = this.exec("PRAGMA page_count");
		const page = this.exec("PRAGMA page_size");
		this.bytesTotal = Number(r[0]?.values[0]?.[0] ?? 0) * Number(page[0]?.values[0]?.[0] ?? 0);
	}

	/** 删除 OPFS 根上的库文件（损坏恢复：备份后删库重开）。静态方法，
	 *  不持有 sahpool 句柄时才能删——只在 open 失败路径调用。 */
	static async removeDbFile(): Promise<void> {
		const root = await navigator.storage.getDirectory();
		try { await root.removeEntry(DB_FILE); } catch { /* 本就不存在 */ }
	}

	/** 整库字节（备份/诊断用；热路径不调用）。OO DB 本构建没有 serialize
	 *  方法、capi.sqlite3_serialize 是裸指针绑定——官方 JS 包装
	 *  sqlite3_js_db_export 才回 Uint8Array。 */
	export(): Uint8Array {
		return this.capi.sqlite3_js_db_export(this.db.pointer);
	}

	/** 耐久快照：整库序列化后写进 shim 命名空间的 vault.db（shim 的
	 *  writeFileSync 自带 flush，真机证实跨 worker 存活——与 pool 槽的
	 *  「杀进程即丢」形成互补）。下次 init 的 legacy 迁移通道会自动把
	 *  非空 shim vault.db 导回 canonical 槽，恢复零新代码。
	 *  返回是否实际写入（调用方负责 fuse：空库不得覆盖好快照）。 */
	writeLegacySnapshot(): boolean {
		try {
			const bytes = this.export();
			if (bytes.byteLength <= 0) return false;
			shimWrite(DB_FILE, bytes);
			return true;
		} catch (e) {
			console.error(`[Semlink] snapshot write failed: ${e instanceof Error ? e.message : String(e)}`);
			return false;
		}
	}

	/** 持久化诊断：连接层 journal/synchronous 实际生效值 + 引擎侧整库字节
	 *  数（page_count×page_size）。reload/杀进程丢数据时先看这里：配置被
	 *  改成 non-durable 会直接暴露。 */
	durabilityInfo(): { journalMode: string; synchronous: string; bytesTotal: number } {
		const jm = this.exec("PRAGMA journal_mode")[0]?.values?.[0]?.[0];
		const sync = this.exec("PRAGMA synchronous")[0]?.values?.[0]?.[0];
		return {
			journalMode: String(jm ?? "?"),
			synchronous: String(sync ?? "?"),
			bytesTotal: this.bytesTotal,
		};
	}

	close(): void {
		for (const stmt of this.stmtCache.values()) {
			try { stmt.finalize(); } catch { /* 已释放 */ }
		}
		this.stmtCache.clear();
		this.db.close();
	}
}
