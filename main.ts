// ========================================
// Semlink - Plugin Entry Point
// ========================================

import { Notice, Plugin, TFile, FileSystemAdapter } from "obsidian";
import { join } from "path";
import { DEFAULT_SETTINGS, type SmartVaultSettings } from "./src/types";
import { VectorStore } from "./src/vector-store";
import { IndexQueue } from "./src/index-queue";
import { EmbeddingClient } from "./src/embedding-client";
import { Scheduler } from "./src/scheduler";
import { ProgressTracker } from "./src/progress";
import { McpServer } from "./src/mcp-server";
import { VaultWatcher } from "./src/watcher";
import { SmartVaultSettingTab } from "./src/settings";
import { ProgressModal } from "./src/progress-modal";
import { setLang, t } from "./src/i18n";

export default class SmartVaultPlugin extends Plugin {
	settings: SmartVaultSettings = { ...DEFAULT_SETTINGS };

	store!: VectorStore;
	queue!: IndexQueue;
	client!: EmbeddingClient;
	scheduler!: Scheduler;
	progress!: ProgressTracker;
	mcpServer: McpServer | null = null;
	watcher!: VaultWatcher;
	pluginDir: string = "";

	private statusBarEl: HTMLElement | null = null;

	async onload() {
		await this.loadSettings();

		// Initialize i18n
		setLang(this.settings.language);

		// Resolve plugin directory (manifest.dir is relative to vault root)
		const adapter = this.app.vault.adapter;
		const vaultBasePath = adapter instanceof FileSystemAdapter
			? adapter.getBasePath()
			: (adapter as any).basePath as string;
		this.pluginDir = join(vaultBasePath, this.manifest.dir || ".obsidian/plugins/semlink");

		const dataDir = join(this.pluginDir, "data");

		// Initialize components
		this.progress = new ProgressTracker();
		this.store = new VectorStore(dataDir);
		await this.store.init();

		this.queue = new IndexQueue((this.store as any).db);
		this.client = new EmbeddingClient(this.settings);
		this.scheduler = new Scheduler(
			this.app,
			this.store,
			this.queue,
			this.client,
			this.progress,
			this.settings,
		);

		// File watcher
		this.watcher = new VaultWatcher(this.app, this.scheduler, this.settings);
		this.watcher.start(this.settings.autoIndex);

		// Status bar
		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass("smart-vault-status-bar");
		this.statusBarEl.createSpan({ text: "Semlink" });
		this.statusBarEl.createSpan({ cls: "status-dot" });
		this.statusBarEl.createSpan({ cls: "status-count" });
		this.statusBarEl.onClickEvent(() => {
			this.showProgressModal();
		});

		// Subscribe to progress for status bar updates
		this.progress.onProgress((event) => {
			if (event.type === "progress") {
				this.updateStatusBar(event.progress);
			}
		});

		// Show initial status bar with existing index data
		this.updateInitialStatusBar();

		// Start MCP server
		if (this.settings.siliconFlowApiKey) {
			await this.startMcpServer();
		}

		// Register settings tab
		this.addSettingTab(new SmartVaultSettingTab(this.app, this));

		// Commands
		this.addCommand({
			id: "smart-vault-full-index",
			name: t("cmdFullReindex"),
			callback: () => this.startFullIndex(),
		});

		this.addCommand({
			id: "smart-vault-toggle-mcp",
			name: t("cmdToggleMcp"),
			callback: () => this.toggleMcpServer(),
		});

		this.addCommand({
			id: "smart-vault-show-progress",
			name: t("cmdShowProgress"),
			callback: () => this.showProgressModal(),
		});

		this.addCommand({
			id: "smart-vault-resume-index",
			name: t("cmdResumeIndex"),
			callback: () => {
				this.scheduler.resume();
				new Notice(`Semlink: ${t("noticeIndexResumed")}`);
			},
		});

		this.addCommand({
			id: "smart-vault-pause-index",
			name: t("cmdPauseIndex"),
			callback: () => {
				this.scheduler.pause();
				new Notice(`Semlink: ${t("noticeIndexPaused")}`);
			},
		});

		// Event listeners for progress modal
		this.registerEvent(
			(this.app.workspace as any).on("smart-vault:pause" as any, () => {
				this.scheduler.pause();
				new Notice(`Semlink: ${t("noticeIndexPaused")}`);
			})
		);
		this.registerEvent(
			(this.app.workspace as any).on("smart-vault:resume" as any, () => {
				this.scheduler.resume();
				new Notice(`Semlink: ${t("noticeIndexResumed")}`);
			})
		);

		// Update initial status bar
		this.updateInitialStatusBar();

		console.log("[Semlink] Plugin loaded");
	}

	onunload() {
		// All synchronous — Obsidian does NOT await async onunload
		try { this.scheduler?.abort(); } catch {}
		try { this.watcher?.stop(); } catch {}
		try { this.mcpServer?.stop(); } catch {}
		// store.close() calls save() internally — flushes in-memory SQLite to disk
		try { this.store?.close(); } catch {}
		console.log("[Semlink] Plugin unloaded");
	}

	async loadSettings() {
		const data = await this.loadData();
		this.settings = { ...DEFAULT_SETTINGS, ...data };
	}

	async saveSettings() {
		await this.saveData(this.settings);
		setLang(this.settings.language);
		this.client?.updateSettings(this.settings);
		this.scheduler?.updateSettings(this.settings);
		this.mcpServer?.updateSettings(this.settings);
		this.watcher?.updateSettings(this.settings);
	}

	// ──── MCP Server ────

	async startMcpServer() {
		if (this.mcpServer) return;

		this.mcpServer = new McpServer(
			this.store,
			this.client,
			this.progress,
			this.scheduler,
			this.settings,
			this.app.vault,
		);

		try {
			await this.mcpServer.start();
			new Notice(`Semlink MCP: ${t("noticeMcpStarted")} (端口 ${this.mcpServer.port})`);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Semlink MCP: ${t("noticeMcpFailed")} - ${msg}`);
			this.mcpServer = null;
		}
	}

	async stopMcpServer() {
		if (this.mcpServer) {
			await this.mcpServer.stop();
			this.mcpServer = null;
			new Notice(`Semlink MCP: ${t("noticeMcpStopped")}`);
		}
	}

	async restartMcpServer() {
		await this.stopMcpServer();
		await this.startMcpServer();
	}

	async toggleMcpServer() {
		if (this.mcpServer) {
			await this.stopMcpServer();
		} else {
			await this.startMcpServer();
		}
	}

	// ──── Indexing ────

	startFullIndex() {
		if (this.scheduler.isRunning) {
			new Notice(`Semlink: ${t("noticeIndexRunning")}`);
			return;
		}

		if (!this.settings.siliconFlowApiKey) {
			new Notice(`Semlink: ${t("noticeNoApiKey")}`);
			return;
		}

		new Notice(`Semlink: ${t("noticeStartIndex")}`);
		this.scheduler.run();
	}

	// ──── UI ────

	showProgressModal() {
		// Sync store stats to progress tracker before opening
		if (this.progress.current.phase === "idle") {
			const stats = this.store.getStats();
			const totalNotes = this.app.vault.getMarkdownFiles().length;
			this.progress.initFromStats(stats.indexedNotes, stats.activeChunks, totalNotes);
		}
		const modal = new ProgressModal(this.app, this.progress);
		modal.open();
	}

	private updateStatusBar(p: import("./src/types").IndexProgress) {
		if (!this.statusBarEl) return;

		const dot = this.statusBarEl.querySelector(".status-dot");
		const count = this.statusBarEl.querySelector(".status-count");

		if (dot) {
			switch (p.phase) {
				case "idle":
					dot.className = "status-dot idle";
					break;
				case "completed":
					dot.className = "status-dot completed";
					break;
				default:
					if (p.isPaused) {
						dot.className = "status-dot paused";
					} else if (p.networkStatus === "degraded") {
						dot.className = "status-dot degraded";
					} else {
						dot.className = "status-dot running";
					}
					break;
			}
		}

		if (count) {
			count.textContent = `${p.processedNotes} ${t("statusFilesCount")}`;
		}
	}

	private updateInitialStatusBar() {
		if (this.statusBarEl) {
			const dot = this.statusBarEl.querySelector(".status-dot");
			if (dot) dot.className = "status-dot idle";
			const count = this.statusBarEl.querySelector(".status-count");
			if (count) {
				const stats = this.store.getStats();
				count.textContent = `${stats.indexedNotes} ${t("statusFilesCount")}`;
			}
		}
	}
}
