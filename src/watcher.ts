// ========================================
// Semlink - Vault File Watcher
// ========================================

import { App, Vault, TFile, TAbstractFile, Notice } from "obsidian";
import type { Scheduler } from "./scheduler";
import type { SmartVaultSettings } from "./types";
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

	constructor(app: App, scheduler: Scheduler, settings: SmartVaultSettings) {
		this.app = app;
		this.vault = app.vault;
		this.scheduler = scheduler;
		this.settings = settings;

		// Bound handlers
		this.createHandler = this.onCreate.bind(this);
		this.modifyHandler = this.onModify.bind(this);
		this.deleteHandler = this.onDelete.bind(this);
		this.renameHandler = this.onRename.bind(this);
	}

	start(autoIndex: boolean): void {
		this.autoIndex = autoIndex;
		this.ready = false;

		this.vault.on("create", this.createHandler);
		this.vault.on("modify", this.modifyHandler);
		this.vault.on("delete", this.deleteHandler);
		this.vault.on("rename", this.renameHandler);

		// Grace period: ignore vault-loading events that fire at startup
		setTimeout(() => {
			this.ready = true;
			console.log("[Semlink] Watcher ready, listening for file changes");
		}, STARTUP_GRACE_MS);
	}

	stop(): void {
		this.vault.off("create", this.createHandler);
		this.vault.off("modify", this.modifyHandler);
		this.vault.off("delete", this.deleteHandler);
		this.vault.off("rename", this.renameHandler);
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

		this.debounce(file.path, async () => {
			await this.scheduler.enqueueFile(file.path, "add");
			this.ensureSchedulerRunning();
		});
	}

	private onModify(file: TAbstractFile) {
		if (!this.autoIndex || !this.ready) return;
		if (!(file instanceof TFile)) return;
		if (file.extension !== "md") return;
		if (this.isExcluded(file.path)) return;

		this.debounce(file.path, async () => {
			await this.scheduler.enqueueFile(file.path, "update");
			this.ensureSchedulerRunning();
		});
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
			// Just update the path in-place, no re-embedding needed
			void this.scheduler.renamePath(oldPath, file.path);
		}
	}

	/** Start the scheduler in incremental mode (no full scan) */
	private noKeyNoticeShown = false;
	private ensureSchedulerRunning() {
		if (!this.settings.siliconFlowApiKey) {
			if (!this.noKeyNoticeShown) {
				this.noKeyNoticeShown = true;
				new Notice(`Semlink: ${t("noticeNoApiKey")}`, 6000);
			}
			return;
		}
		if (!this.scheduler.isRunning) {
			this.noKeyNoticeShown = false;
			this.scheduler.runIncremental();
		}
	}

	/** Check if a path should be excluded from indexing */
	private isExcluded(path: string): boolean {
		const patterns = this.settings.excludePaths
			.split("\n")
			.map((p) => p.trim())
			.filter((p) => p.length > 0);
		for (const pattern of patterns) {
			if (path.startsWith(pattern) || path.includes(pattern)) {
				return true;
			}
		}
		return false;
	}

	// Debounce per-path to avoid excessive indexing during saves
	private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

	private debounce(path: string, fn: () => void, delay = 2000) {
		const existing = this.debounceTimers.get(path);
		if (existing) clearTimeout(existing);

		this.debounceTimers.set(path, setTimeout(() => {
			this.debounceTimers.delete(path);
			fn();
		}, delay));
	}
}
