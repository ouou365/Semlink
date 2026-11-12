// ========================================
// Semlink - Vault File Watcher
// ========================================

import { App, Vault, TFile, TAbstractFile, FileSystemAdapter, Notice } from "obsidian";
import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { debugLog } from "./log";
import type { Scheduler } from "./scheduler";
import type { SmartVaultSettings } from "./types";
import { activeEmbeddingProvider } from "./types";
import { t } from "./i18n";

/** Grace period (ms) after startup during which events are ignored */
const STARTUP_GRACE_MS = 5000;

export class VaultWatcher {
	private app: App;
	private vault: Vault;
	private scheduler: Scheduler;
	private settings: SmartVaultSettings;
	private autoIndex: boolean;
	private ready = false;

	private createHandler: (file: TAbstractFile) => void;
	private modifyHandler: (file: TAbstractFile) => void;
	private deleteHandler: (file: TAbstractFile) => void;
	private renameHandler: (file: TAbstractFile, oldPath: string) => void;

	constructor(app: App, scheduler: Scheduler, settings: SmartVaultSettings, private getIndexedPaths?: () => Promise<Set<string>>) {
		this.app = app;
		this.vault = app.vault;
		this.scheduler = scheduler;
		this.settings = settings;

		// Bound handlers (arrow wrappers: typed in every tsconfig, no casts)
		this.createHandler = (file) => this.onCreate(file);
		this.modifyHandler = (file) => this.onModify(file);
		this.deleteHandler = (file) => this.onDelete(file);
		this.renameHandler = (file, oldPath) => this.onRename(file, oldPath);
	}

	start(autoIndex: boolean): void {
		this.autoIndex = autoIndex;
		this.ready = false;

		this.vault.on("create", this.createHandler);
		this.vault.on("modify", this.modifyHandler);
		this.vault.on("delete", this.deleteHandler);
		this.vault.on("rename", this.renameHandler);

		// Grace period: ignore vault-loading events that fire at startup
		window.setTimeout(() => {
			this.ready = true;
			debugLog("[Semlink] Watcher ready, listening for file changes");
		}, STARTUP_GRACE_MS);

		// [外部落盘自动登记] 首轮 10s 后跑（启动宽限后尽早收编），此后 30s 一轮。
		this.arrivalTimer = window.setInterval(() => void this.pollExternalArrivals(), 30_000);
		window.setTimeout(() => void this.pollExternalArrivals(), 10_000);
	}

	stop(): void {
		this.vault.off("create", this.createHandler);
		this.vault.off("modify", this.modifyHandler);
		this.vault.off("delete", this.deleteHandler);
		this.vault.off("rename", this.renameHandler);
		if (this.arrivalTimer !== null) {
			window.clearInterval(this.arrivalTimer);
			this.arrivalTimer = null;
		}
	}

	setAutoIndex(enabled: boolean): void {
		this.autoIndex = enabled;
	}

	updateSettings(settings: SmartVaultSettings): void {
		this.settings = settings;
	}

	private onCreate(file: TAbstractFile) {
		if (!this.autoIndex || !this.ready) return;
		if (!(file instanceof TFile)) return;
		if (file.extension !== "md") return;
		if (this.isExcluded(file.path)) return;

		this.debounce(file.path, () => void (async () => {
			await this.scheduler.enqueueFile(file.path, "add");
			this.ensureSchedulerRunning();
		})());
	}

	private onModify(file: TAbstractFile) {
		if (!this.autoIndex || !this.ready) return;
		if (!(file instanceof TFile)) return;
		if (file.extension !== "md") return;
		if (this.isExcluded(file.path)) return;

		this.debounce(file.path, () => void (async () => {
			await this.scheduler.enqueueFile(file.path, "update");
			this.ensureSchedulerRunning();
		})());
	}

	private onDelete(file: TAbstractFile) {
		if (!this.autoIndex || !this.ready) return;
		if (!(file instanceof TFile)) return;

		// Fire-and-forget: enqueue is async (routes through the worker), but the
		// event handler itself must stay synchronous.
		void this.scheduler.enqueueFile(file.path, "delete").then(() => this.ensureSchedulerRunning());
	}

	private onRename(file: TAbstractFile, oldPath: string) {
		if (!this.autoIndex || !this.ready) return;
		if (!(file instanceof TFile)) return;
		if (file.extension !== "md") return;

		if (this.isExcluded(file.path)) {
			// Moved to excluded location — delete old index entries
			void this.scheduler.enqueueFile(oldPath, "delete").then(() => this.ensureSchedulerRunning());
		} else {
			// Old path was indexed → real rename, update the path in-place, no
			// re-embedding needed. Otherwise the file is arriving into scope
			// from a never-indexed location (e.g. moved out of an excluded
			// folder) — there are no rows to rename, index it fresh.
			void (async () => {
				if (await this.scheduler.hasIndexEntries(oldPath)) {
					await this.scheduler.renamePath(oldPath, file.path);
				} else {
					await this.scheduler.enqueueFile(file.path, "add");
					this.ensureSchedulerRunning();
				}
			})();
		}
	}

	/** Start the scheduler in incremental mode (no full scan) */
	private ensureSchedulerRunning() {
		// 文件变化触发的增量索引不依赖嵌入 Key：无 Key 时调度器仅索引文本
		if (!this.scheduler.isRunning) {
			this.scheduler.runIncremental();
		}
	}

	/** Check if a path should be excluded from indexing */
	private isExcluded(path: string): boolean {
		const patterns = this.settings.excludePaths
			.split("\n")
			.map((p) => p.trim())
			.filter((p) => p.length > 0);
		patterns.push(this.vault.configDir);
		for (const pattern of patterns) {
			if (path.startsWith(pattern) || path.includes(pattern)) {
				return true;
			}
		}
		return false;
	}

	// ──── 外部落盘自动登记（用户拍板「可以自动检测吗」，2026-11-12） ────

	/** Obsidian 只在窗口获焦时把外部变更纳入文件清单——焦点之外拖入/
	 *  同步落盘的笔记对 watcher 完全不可见（getMarkdownFiles 不含它），
	 *  嵌入一直不触发（真机 2026-11-12：拖入新文件无反应，磁盘 1032 vs
	 *  登记 990）。方案：fs 直读磁盘（~千文件 <50ms）diff 已登记集合，
	 *  缺的用 adapter.write 原位覆写一次——adapter 层写入让 vault 立即
	 *  建 TFile 并对外发 create 事件 → 既有管道（debounce/enqueue/scheduler）
	 *  原样工作，零新索引逻辑。点目录（.zcode-tmp/.opencode 等）Obsidian
	 *  本就不导入，跳过；write 过仍未登记的路径不再重试（获焦对账兜底）。 */
	private arrivalTimer: ReturnType<typeof setInterval> | null = null;
	private registrationTried = new Set<string>();
	/** 上一轮轮询结果（rpcdiag 透出——生产无 console 时唯一取证口）。 */
	lastArrivalDiag: unknown = { ran: false };

	private async pollExternalArrivals(): Promise<void> {
		if (!this.autoIndex || !this.ready) {
			this.lastArrivalDiag = { ran: false, reason: `autoIndex=${this.autoIndex} ready=${this.ready}` };
			return;
		}
		const adapter = this.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			this.lastArrivalDiag = { ran: false, reason: "not FileSystemAdapter" };
			return;
		}
		const base = adapter.getBasePath();
		try {
			const entries = await readdir(base, { recursive: true });
			const registered = new Set(this.vault.getMarkdownFiles().map((f) => f.path));
			const missing: string[] = [];
			for (const rel of entries) {
				const p = rel.replace(/\\/g, "/");
				// 与 Obsidian 同规则：点目录/点文件不可见，仅 .md，排除规则外
				if (!p.endsWith(".md")) continue;
				if (p.split("/").some((seg) => seg.startsWith("."))) continue;
				if (this.isExcluded(p)) continue;
				if (registered.has(p)) continue;
				if (this.registrationTried.has(p)) continue;
				missing.push(p);
				if (missing.length >= 20) break; // 单轮上限，收编分批进行
			}
			// [幽灵检测] DB 索引集里有、注册表里没有的 = 已删除文件的残留
			// chunks（外部删除在获焦登记后才可见，队列 delete 事件可能错过）
			// ——Indexed 会 > 总数（真机 2026-11-12：989 > 988）。发现即踢一次
			// 全扫：批量 mtime 后全扫 1-2s，prune 一趟清完 + 顺带入队新增。
			let ghosts: string[] = [];
			if (this.getIndexedPaths) {
				const indexedPaths = await this.getIndexedPaths();
				ghosts = [...indexedPaths].filter((p) => !registered.has(p)).slice(0, 50);
			}
			this.lastArrivalDiag = {
				ran: true,
				at: new Date().toISOString(),
				diskEntries: entries.length,
				registered: registered.size,
				missing,
				ghosts,
			};
			if (missing.length > 0) {
				for (const p of missing) {
					this.registrationTried.add(p);
					const content = await readFile(join(base, p), "utf-8");
					await this.vault.adapter.write(p, content);
					debugLog(`[Semlink] external note registered via adapter: ${p}`);
				}
				debugLog(`[Semlink] external arrival poll: adopted ${missing.length} file(s)`);
			}
			if (ghosts.length > 0) {
				debugLog(`[Semlink] external arrival poll: ${ghosts.length} ghost path(s), triggering reconcile scan`);
				this.ensureSchedulerRunning();
			}
		} catch (e) {
			this.lastArrivalDiag = { ran: true, error: e instanceof Error ? e.message : String(e) };
			debugLog(`[Semlink] external arrival poll failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}


	// Debounce per-path to avoid excessive indexing during saves.
	// 5s is long enough that a brief pause while typing won't trigger an
	// embedding round-trip (which churns progress events / UI updates), but
	// short enough that a real edit is picked up promptly.
	private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

	private debounce(path: string, fn: () => void, delay = 5000) {
		const existing = this.debounceTimers.get(path);
		if (existing) window.clearTimeout(existing);

		this.debounceTimers.set(path, window.setTimeout(() => {
			this.debounceTimers.delete(path);
			fn();
		}, delay));
	}
}
