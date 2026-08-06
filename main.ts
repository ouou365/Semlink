// ========================================
// Semlink - Plugin Entry Point
// ========================================

import { Notice, Plugin, TFile, FileSystemAdapter, addIcon } from "obsidian";
import { join } from "path";
import { DEFAULT_SETTINGS, type SmartVaultSettings } from "./src/types";
import { VectorStore } from "./src/vector-store";
import { IndexQueue } from "./src/index-queue";
import { EmbeddingClient } from "./src/embedding-client";
import { ChatClient } from "./src/chat-client";
import { SemlinkTools } from "./src/chat-tools";
import { Scheduler } from "./src/scheduler";
import { ProgressTracker } from "./src/progress";
import { McpServer } from "./src/mcp-server";
import { VaultWatcher } from "./src/watcher";
import { SmartVaultSettingTab } from "./src/settings";
import { ProgressModal } from "./src/progress-modal";
import { SemanticSearchView, SEARCH_VIEW_TYPE } from "./src/search-view";
import { RecentFilesTracker } from "./src/recent-files";
import { QuestionBankStore } from "./src/question-bank";
import { ActivityGate } from "./src/activity-gate";
import { FeishuBot, type FeishuAskHandler } from "./src/feishu-bot";
import { setLang, t } from "./src/i18n";
import logoSvg from "./src/semlink-logo.svg";

export default class SmartVaultPlugin extends Plugin {
	settings: SmartVaultSettings = { ...DEFAULT_SETTINGS };

	store!: VectorStore;
	queue!: IndexQueue;
	client!: EmbeddingClient;
	chatClient!: ChatClient;
	chatTools!: SemlinkTools;
	scheduler!: Scheduler;
	progress!: ProgressTracker;
	mcpServer: McpServer | null = null;
	watcher!: VaultWatcher;
	pluginDir: string = "";

	/** Recently touched files — feeds the welcome screen's AI questions. */
	recentFiles!: RecentFilesTracker;
	/** Persistent pool of AI-generated welcome questions. */
	questionBank!: QuestionBankStore;
	/** Watches for user activity so indexing yields while they're working. */
	activityGate!: ActivityGate;

	/** Running Feishu bot instances, keyed by bot id. */
	private feishuBots: Map<string, FeishuBot> = new Map();

	private statusBarEl: HTMLElement | null = null;
	private lastStatusBarUpdate = 0;

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

		this.queue = new IndexQueue(this.store);
		this.client = new EmbeddingClient(this.settings);
		this.chatTools = new SemlinkTools(this.store, this.client, this.app.vault);
		this.chatClient = new ChatClient(this.settings, this.chatTools);
		// Indexing pauses while the user is actively working (clicks, typing,
		// scrolling) so heavy scans never make the frontend feel laggy.
		this.activityGate = new ActivityGate();
		this.scheduler = new Scheduler(
			this.app,
			this.store,
			this.queue,
			this.client,
			this.progress,
			this.settings,
			this.activityGate,
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

		// Subscribe to progress for status bar updates.
		// Throttle to once per 500ms — the progress tracker can emit dozens of
		// updates per second during indexing, but the status bar only needs a
		// coarse refresh. This avoids per-frame DOM writes while typing.
		this.progress.onProgress((event) => {
			if (event.type === "complete") {
				// Always refresh on completion so the final count is shown.
				this.lastStatusBarUpdate = Date.now();
				this.updateStatusBar(this.progress.current);
			} else if (event.type === "progress") {
				const now = Date.now();
				if (now - this.lastStatusBarUpdate >= 500) {
					this.lastStatusBarUpdate = now;
					this.updateStatusBar(event.progress);
				}
			}
		});

		// Show initial status bar with existing index data
		await this.updateInitialStatusBar();

		// Start MCP server
		if (this.settings.siliconFlowApiKey || this.settings.huggingFaceApiKey) {
			await this.startMcpServer();
		}

		// Register settings tab
		this.addSettingTab(new SmartVaultSettingTab(this.app, this));

		// Start any enabled Feishu bots.
		await this.syncFeishuBots();

		// Semantic Search sidebar view
		this.recentFiles = new RecentFilesTracker(this.app.vault, dataDir);
		this.recentFiles.load();
		this.questionBank = new QuestionBankStore(dataDir);
		this.questionBank.load();
		// Track recently touched files so the AI questions can follow what the
		// user is working on (opened, created or edited notes).
		this.registerEvent(this.app.workspace.on("file-open", (file) => {
			if (file) this.recentFiles.record(file.path);
		}));
		this.registerEvent(this.app.vault.on("create", (file) => {
			if (file instanceof TFile) this.recentFiles.record(file.path);
		}));
		this.registerEvent(this.app.vault.on("modify", (file) => {
			if (file instanceof TFile) this.recentFiles.record(file.path);
		}));
		this.registerView(SEARCH_VIEW_TYPE, (leaf) => new SemanticSearchView(
			leaf, this.store, this.client, this.app.vault, this.chatClient, dataDir,
			this.recentFiles, this.questionBank,
		));

		// Register the custom Semlink logo as a named Obsidian icon so that both
		// the left ribbon button and the right sidebar tab use the same brand
		// mark. addIcon() wraps content in a fixed `0 0 100 100` viewBox, but our
		// logo uses a 1024 coordinate space, so we wrap the extracted inner markup
		// in a scale group (100/1024 ≈ 0.0977) to map it into that 100x100 box.
		const logoInner = logoSvg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
		addIcon("semlink-logo", `<g transform="scale(0.09765625)">${logoInner}</g>`);

		const ribbonBtn = this.addRibbonIcon("semlink-logo", t("searchViewTitle"), () => {
			void this.activateSearchView();
		});

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
			id: "smart-vault-open-search",
			name: t("cmdOpenSearch"),
			callback: () => void this.activateSearchView(),
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
		await this.updateInitialStatusBar();

		console.log("[Semlink] Plugin loaded");
	}

	onunload() {
		// All synchronous — Obsidian does NOT await async onunload.
		try { this.scheduler?.abort(); } catch {}
		try { this.watcher?.stop(); } catch {}
		try { this.mcpServer?.stop(); } catch {}
		try { this.recentFiles?.save(); } catch {}
		try { this.activityGate?.dispose(); } catch {}
		for (const bot of this.feishuBots.values()) {
			try { void bot.stop(); } catch {}
		}
		this.feishuBots.clear();
		// Persist & close the store. store.close() is async, but:
		//  - In worker mode it sends a `close` message to the child, which
		//    performs a synchronous save() + db.close() in its own thread and
		//    then exits. Data lands on disk even if the host tears down
		//    immediately after.
		//  - In fallback mode close() runs synchronously.
		// Either way we don't block on the promise here (we can't — onunload
		// is sync); the worker handles flushing on its end.
		try { void this.store?.close(); } catch {}
		console.log("[Semlink] Plugin unloaded");
	}

	async loadSettings() {
		const data = await this.loadData();
		this.settings = { ...DEFAULT_SETTINGS, ...data };
	}

	async saveSettings() {
		await this.saveData(this.settings);
		setLang(this.settings.language);
		// Re-render the search view's language-dependent UI (welcome screen,
		// input placeholder, icon tooltips) right away.
		for (const leaf of this.app.workspace.getLeavesOfType(SEARCH_VIEW_TYPE)) {
			(leaf.view as SemanticSearchView).refreshLanguage?.();
		}
		this.client?.updateSettings(this.settings);
		this.chatClient?.updateSettings(this.settings);
		this.scheduler?.updateSettings(this.settings);
		this.mcpServer?.updateSettings(this.settings);
		this.watcher?.updateSettings(this.settings);
		await this.syncFeishuBots();
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

	// ──── Feishu Bots ────

	/** Reconcile running bot instances with the configured bot list. */
	private async syncFeishuBots(): Promise<void> {
		const configured = new Set<string>();
		for (const bot of this.settings.feishuBots) {
			configured.add(bot.id);
			const running = this.feishuBots.get(bot.id);
			if (!bot.enabled) {
				if (running) {
					await running.stop();
					this.feishuBots.delete(bot.id);
				}
				continue;
			}
			if (running) continue;

			const instance = new FeishuBot(bot, this.buildFeishuAskHandler(), () => {
				// Persist state mutations (bound confirmation, connection state)
				// — syncFeishuBots is idempotent, so no recursion here.
				void this.saveSettings();
			});
			this.feishuBots.set(bot.id, instance);
			try {
				await instance.start();
			} catch (e) {
				bot.connected = false;
				bot.lastError = e instanceof Error ? e.message : String(e);
			}
		}

		for (const [id, running] of this.feishuBots) {
			if (!configured.has(id)) {
				await running.stop();
				this.feishuBots.delete(id);
			}
		}
	}

	/** Shared QA pipeline used by Feishu bots (embed → search → chat). */
	private buildFeishuAskHandler(): FeishuAskHandler {
		return async (question, onToken, history, signal, onThinking) => {
			const embedResult = await this.client.embed([question]);
			const results = await this.store.search(embedResult.embeddings[0], 10, 0.3);
			const context = this.buildFeishuContext(results.slice(0, 5));
			// Fold conversation history into the question so the LLM has
			// multi-turn context (chat-client.chat itself is stateless).
			let fullQuestion = question;
			if (history && history.length > 0) {
				const transcript = history
					.map((t) => `${t.role === "user" ? "用户" : "助手"}：${t.content}`)
					.join("\n\n");
				fullQuestion = `以下是之前的对话历史：\n${transcript}\n\n用户最新问题：${question}`;
			}
			// Bridge chat-client's onToolCall into our per-event onThinking, so
			// the Feishu bot can stream each tool call into the thinking panel.
			const onToolCall = onThinking
				? (name: string, args: any) => onThinking({ type: "tool", name, args })
				: undefined;
			const chatResult = await this.chatClient.chat(context, fullQuestion, onToolCall, "standard", onToken);
			// Honor an abort signal by rejecting (the bot treats this as stopped).
			if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
			return {
				answer: chatResult.answer,
				thinking: chatResult.thinking,
				usedNotes: chatResult.usedNotes,
			};
		};
	}

	private buildFeishuContext(results: Array<{ heading: string; notePath: string; contentPreview: string }>): string {
		return results
			.map((r, i) => `[${i + 1}] ${r.heading || r.notePath}（${r.notePath}）\n${r.contentPreview}`)
			.join("\n\n");
	}

	// ──── Indexing ────

	startFullIndex() {
		if (this.scheduler.isRunning) {
			new Notice(`Semlink: ${t("noticeIndexRunning")}`);
			return;
		}

		const hasApiKey = this.settings.provider === "huggingface"
			? !!this.settings.huggingFaceApiKey
			: !!this.settings.siliconFlowApiKey;

		if (!hasApiKey) {
			new Notice(`Semlink: ${t("noticeNoApiKey")}`);
			return;
		}

		new Notice(`Semlink: ${t("noticeStartIndex")}`);
		this.scheduler.run();
	}

	// ──── UI ────

	async showProgressModal() {
		// Sync store stats to progress tracker before opening
		// Both "idle" and "completed" phases need DB stats — the in-memory
		// progress values may be stale (e.g. after an incremental/watcher run
		// only processed a handful of files).
		const phase = this.progress.current.phase;
		if (phase === "idle" || phase === "completed") {
			const stats = await this.store.getStats();
			this.progress.initFromStats(stats.indexedNotes, stats.activeChunks, stats.indexedNotes);
		}
		const modal = new ProgressModal(this.app, this.progress);
		modal.open();
	}

	/** Reveal (or create) the semantic-search view in the right sidebar. */
	async activateSearchView(): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(SEARCH_VIEW_TYPE)[0];
		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.setViewState({
					type: SEARCH_VIEW_TYPE,
					active: true,
				});
			}
		}
		if (leaf) {
			await workspace.revealLeaf(leaf);
		}
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

	private async updateInitialStatusBar() {
		if (this.statusBarEl) {
			const dot = this.statusBarEl.querySelector(".status-dot");
			if (dot) dot.className = "status-dot idle";
			const count = this.statusBarEl.querySelector(".status-count");
			if (count) {
				const stats = await this.store.getStats();
				count.textContent = `${stats.indexedNotes} ${t("statusFilesCount")}`;
			}
		}
	}
}
