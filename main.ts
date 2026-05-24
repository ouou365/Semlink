// ========================================
// Semlink - Plugin Entry Point
// ========================================

import { Notice, Plugin, TFile, FileSystemAdapter } from "obsidian";
import { join } from "path";
import { existsSync } from "fs";
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

		// Resolve plugin directory (manifest.dir is relative to vault root)
		const adapter = this.app.vault.adapter;
		const vaultBasePath = adapter instanceof FileSystemAdapter
			? adapter.getBasePath()
			: (adapter as any).basePath as string;
		this.pluginDir = join(vaultBasePath, this.manifest.dir || ".obsidian/plugins/semlink");

		const dataDir = join(this.pluginDir, "data");
		const wasmPath = join(this.pluginDir, "sql-wasm.wasm");

		if (!existsSync(wasmPath)) {
			new Notice("Semlink: sql-wasm.wasm not found. Run npm run build first.", 10000);
			console.error("[Semlink] WASM file missing:", wasmPath);
			console.error("[Semlink] Plugin dir:", this.pluginDir);
		}

		// Initialize components
		this.progress = new ProgressTracker();
		this.store = new VectorStore(dataDir, wasmPath);
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
		this.statusBarEl.createSpan({ cls: "status-dot" });
		this.statusBarEl.createSpan({ text: "Semlink: 初始化中..." });
		this.statusBarEl.onClickEvent(() => {
			this.showProgressModal();
		});

		// Subscribe to progress for status bar updates
		this.progress.onProgress((event) => {
			if (event.type === "progress") {
				this.updateStatusBar(event.progress);
			}
		});

		// Start MCP server
		if (this.settings.siliconFlowApiKey) {
			await this.startMcpServer();
		}

		// Register settings tab
		this.addSettingTab(new SmartVaultSettingTab(this.app, this));

		// Commands
		this.addCommand({
			id: "smart-vault-full-index",
			name: "全量重建索引",
			callback: () => this.startFullIndex(),
		});

		this.addCommand({
			id: "smart-vault-toggle-mcp",
			name: "启动/停止 MCP 服务",
			callback: () => this.toggleMcpServer(),
		});

		this.addCommand({
			id: "smart-vault-show-progress",
			name: "查看索引进度",
			callback: () => this.showProgressModal(),
		});

		this.addCommand({
			id: "smart-vault-resume-index",
			name: "恢复索引",
			callback: () => {
				this.scheduler.resume();
				new Notice("Semlink: 索引已恢复");
			},
		});

		this.addCommand({
			id: "smart-vault-pause-index",
			name: "暂停索引",
			callback: () => {
				this.scheduler.pause();
				new Notice("Semlink: 索引已暂停");
			},
		});

		// Event listeners for progress modal
		this.registerEvent(
			(this.app.workspace as any).on("smart-vault:pause" as any, () => {
				this.scheduler.pause();
				new Notice("Semlink: 索引已暂停");
			})
		);
		this.registerEvent(
			(this.app.workspace as any).on("smart-vault:resume" as any, () => {
				this.scheduler.resume();
				new Notice("Semlink: 索引已恢复");
			})
		);

		// Update initial status bar
		this.updateInitialStatusBar();

		console.log("[Semlink] Plugin loaded");
	}

	onunload() {
		try { this.scheduler?.abort(); } catch {}
		try { this.watcher?.stop(); } catch {}
		try { this.mcpServer?.stop(); } catch {}
		try { this.store?.close(); } catch {}
		console.log("[Semlink] Plugin unloaded");
	}

	async loadSettings() {
		const data = await this.loadData();
		this.settings = { ...DEFAULT_SETTINGS, ...data };
	}

	async saveSettings() {
		await this.saveData(this.settings);
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
			new Notice(`Semlink MCP: 服务已启动 (端口 ${this.mcpServer.port})`);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Semlink MCP: 启动失败 - ${msg}`);
			this.mcpServer = null;
		}
	}

	async stopMcpServer() {
		if (this.mcpServer) {
			await this.mcpServer.stop();
			this.mcpServer = null;
			new Notice("Semlink MCP: 服务已停止");
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
			new Notice("Semlink: 索引正在进行中");
			return;
		}

		if (!this.settings.siliconFlowApiKey) {
			new Notice("Semlink: 请先配置 SiliconFlow API Key");
			return;
		}

		new Notice("Semlink: 开始全量索引...");
		this.scheduler.run();
	}

	// ──── UI ────

	showProgressModal() {
		const modal = new ProgressModal(this.app, this.progress);
		modal.open();
	}

	private updateStatusBar(p: import("./src/types").IndexProgress) {
		if (!this.statusBarEl) return;

		const dot = this.statusBarEl.querySelector(".status-dot");
		const text = this.statusBarEl.querySelector("span:last-child");

		if (dot) {
			dot.className = `status-dot ${p.networkStatus}`;
		}

		if (text) {
			switch (p.phase) {
				case "idle":
					text.textContent = `Semlink: 就绪`;
					break;
				case "completed":
					text.textContent = `Semlink: 索引完成 ✓`;
					break;
				default: {
					const pct = p.totalNotes > 0
						? ((p.processedNotes / p.totalNotes) * 100).toFixed(0)
						: "?";
					const paused = p.isPaused ? " ⏸" : "";
					text.textContent = `Semlink: ${pct}% (${p.processedNotes}/${p.totalNotes})${paused}`;
					break;
				}
			}
		}
	}

	private updateInitialStatusBar() {
		const stats = this.store.getStats();
		if (this.statusBarEl) {
			const text = this.statusBarEl.querySelector("span:last-child");
			if (text) {
				text.textContent = `Semlink: ${stats.indexedNotes} 笔记已索引`;
			}
		}
	}
}
