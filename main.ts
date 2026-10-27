// ========================================
// Semlink - Plugin Entry Point
// ========================================

import { Notice, Plugin, FileSystemAdapter, WorkspaceSidedock, addIcon, MarkdownView, TFile } from "obsidian";
import { debugLog, setDebugLogging } from "./src/log";
import { join } from "path";
import { DEFAULT_SETTINGS, activeEmbeddingProvider, migrateEmbeddingSettings, type SmartVaultSettings, type HistoryMessage } from "./src/types";
import { UsageStore } from "./src/usage-store";
import { migrateLegacyCatalogBases, sanitizeProviderOrder, syncCatalogModels } from "./src/settings-models";
import { VectorStore } from "./src/vector-store";
import { IndexQueue } from "./src/index-queue";
import { EmbeddingClient } from "./src/embedding-client";
import { ChatClient, inferAgentDepth, type ThinkingStep } from "./src/chat-client";
import { SemlinkTools } from "./src/chat-tools";
import { parseExcludePaths } from "./src/tools-core";
import { Scheduler } from "./src/scheduler";
import { ProgressTracker } from "./src/progress";
import { McpServer } from "./src/mcp-server";
import { DebugMcpServer } from "./src/debug-mcp-server";
import { ShareServer } from "./src/share-server";
import { NoteShare, attachNoteShareAction } from "./src/note-share";
import { ChatHistoryStore } from "./src/chat-history";
import { renderSharePage } from "./src/share-page";
import { VaultWatcher } from "./src/watcher";
import { SmartVaultSettingTab } from "./src/settings";
import { ProgressModal } from "./src/progress-modal";
import { SemanticSearchView, SEARCH_VIEW_TYPE } from "./src/search-view";
import { runOpfsSpike } from "./src/opfs-spike";
import { ActivityGate } from "./src/activity-gate";
import { FeishuBot, type FeishuAskHandler } from "./src/feishu-bot";
import { LicenseManager } from "./src/license";
import { setLang, t } from "./src/i18n";
import logoSvg from "./src/semlink-logo.svg";

export default class SmartVaultPlugin extends Plugin {
	settings: SmartVaultSettings = { ...DEFAULT_SETTINGS };

	store!: VectorStore;
	queue!: IndexQueue;
	client!: EmbeddingClient;
	chatClient!: ChatClient;
	usageStore!: UsageStore;
	chatTools!: SemlinkTools;
	scheduler!: Scheduler;
	progress!: ProgressTracker;
	mcpServer: McpServer | null = null;
	debugMcpServer: DebugMcpServer | null = null;
	/** LAN share server for conversation snapshots. Token↔session pairs
	 *  persist in data/share-registry.json and the port in settings, so a
	 *  share URL keeps working across restarts (unchanged IP); page HTML is
	 *  re-rendered from chat history on request. */
	shareServer: ShareServer;
	/** Note-level LAN sharing: reuses the ShareServer registry with
	 *  `note:<path>` keys and drives the editor-header two-state icon. */
	noteShare!: NoteShare;
	historyStore!: ChatHistoryStore;
	watcher!: VaultWatcher;
	pluginDir: string = "";

	/** Watches for user activity so indexing yields while they're working. */
	activityGate!: ActivityGate;

	/** Pro license checks + activation (docs/freemium-design.md). */
	licenseManager!: LicenseManager;

	/** Running Feishu bot instances, keyed by bot id. */
	private feishuBots: Map<string, FeishuBot> = new Map();

	private statusBarEl: HTMLElement | null = null;
	private lastStatusBarUpdate = 0;

	/** 上次清理索引时用的排除规则（saveSettings 里比对，规则变了才重跑 purge）。 */
	private lastPurgedExcludePaths = "";

	async onload() {
		await this.loadSettings();
		setDebugLogging(this.settings.debugLogging ?? false);

		// Initialize i18n
		setLang(this.settings.language);

		// License: create the manager right after settings load so every
		// feature gate (history limit, Feishu) can ask isPro() from here on.
		this.licenseManager = new LicenseManager(this);
		this.licenseManager.isPro();
		// Re-validate on every startup so a refund/revocation takes effect at
		// the next Obsidian launch instead of waiting for the 24h refresh.
		// Network failure is silent — the local token's 7-day grace covers it.
		void this.licenseManager.validate().catch(() => { /* offline grace */ });

		// Resolve plugin directory (manifest.dir is relative to vault root)
		const adapter = this.app.vault.adapter;
		const vaultBasePath = adapter instanceof FileSystemAdapter
			? adapter.getBasePath()
			: (adapter as unknown as { basePath: string }).basePath;
		this.pluginDir = join(vaultBasePath, this.manifest.dir
			|| join(this.app.vault.configDir, "plugins", this.manifest.id));

		const dataDir = join(this.pluginDir, "data");

		// Initialize components
		this.progress = new ProgressTracker();
		// Browser Web Worker fallback channel: loads the same DB engine from
		// the plugin folder when worker_threads is unavailable in the host.
		// Read the script through the VAULT ADAPTER (plain text) and spawn the
		// worker from a Blob URL — getResourcePath()'s app:// URL can't be
		// fetched via requestUrl (Electron net only supports http/https),
		// which used to force desktop onto the sync fallback.
		let browserWorkerUrl: string | undefined;
		try {
			const code = await this.app.vault.adapter.read(
				`${this.app.vault.configDir}/plugins/${this.manifest.id}/db-worker.browser.js`
			);
			browserWorkerUrl = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
		} catch { /* leave undefined → sync fallback */ }
		this.store = new VectorStore(dataDir, browserWorkerUrl);
		// 向量搜索总开关（设置页 RAG 标签）：实时读设置，关掉即全部语义检索返回空
		// 向量搜索可用性 = 嵌入模型已配置（无独立开关）
		this.store.searchGate = () => activeEmbeddingProvider(this.settings).apiKey.trim() !== "";
		await this.store.init();

		this.queue = new IndexQueue(this.store);
		this.client = new EmbeddingClient(this.settings);
		this.chatTools = new SemlinkTools(this.store, this.client, this.app.vault, () => this.app.workspace.getActiveFile()?.path ?? null, () => this.settings.excludePaths);
		this.chatClient = new ChatClient(this.settings, this.chatTools);
		// Single shared chat-history store: the search view writes to it and
		// the LAN share server renders from it, so re-opened share URLs see
		// the latest saved messages without cache drift.
		this.historyStore = new ChatHistoryStore(dataDir);
		// Persist the active chat model whenever it changes (search-view picker
		// or the General settings dropdown).
		this.chatClient.setModelChangeHandler(() => {
			void this.saveSettings();
		});
		// Pro usage dashboard: every completed chat request reports its summed
		// token usage. Recording runs for everyone (local data); viewing is
		// Pro-gated in the modal.
		this.usageStore = new UsageStore(dataDir);
		this.chatClient.onUsage = (u) => this.usageStore.record(u);
		void this.usageStore.load();
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
		// 启动补数：本会话首次扫描前，进度追踪器的 totalNotes 是 0，设置页
		// 的 笔记总数/待索引 会显示 0。只枚举文件清单（不比对 mtime、不入队），
		// 之后的真实扫描会用权威值覆盖。
		if (this.progress.current.totalNotes === 0) {
			this.progress.setTotalNotes(this.scheduler.countIndexableNotes());
			debugLog(`[Semlink] Seeded total notes before first scan: ${this.progress.current.totalNotes}`);
		}

		// File watcher
		this.watcher = new VaultWatcher(this.app, this.scheduler, this.settings);
		this.watcher.start(this.settings.autoIndex);

		// Background: ensure document-level vectors exist (one-time backfill if
		// the table is empty or an algorithm bump cleared it). Runs async —
		// never blocks plugin load; a no-op when the index is empty.
		void this.scheduler.backfillDocVectors().then((n) => {
			if (n > 0) new Notice(`Semlink: ${t("noticeDocVectorsReady").replace("{n}", String(n))}`);
		}).catch(() => { /* best-effort; falls back to chunk max-pooling */ });

		// Status bar
		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass("smart-vault-status-bar");
		this.statusBarEl.createSpan({ text: "Semlink" });
		this.statusBarEl.createSpan({ cls: "status-dot" });
		this.statusBarEl.createSpan({ cls: "status-count" });
		this.statusBarEl.onClickEvent(() => {
			void this.showProgressModal();
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

		// Start MCP server：默认开启；用户手动关闭后（mcpEnabled=false）保持关闭
		if (this.settings.mcpEnabled !== false) {
			await this.startMcpServer();
		}

		// 调试问答服务（semlink-debug）：ask 单工具，端到端跑真实问答管线，
		// 供 ZCode 等 agent 回归测试。仅监听 127.0.0.1（会触发真实 LLM 调用）。
		if (this.settings.debugMcpEnabled === true) {
			await this.startDebugMcpServer();
		}

		// Register settings tab
		this.addSettingTab(new SmartVaultSettingTab(this.app, this));

		// One-shot OPFS feasibility spike (browser Worker + OPFS in the real
		// app:// renderer). Runs once; skips after a result file exists.
		{
			const resultPath = this.app.vault.configDir + "/plugins/" + this.manifest.id + "/opfs-spike-result.json";
			const already = await this.app.vault.adapter.exists(resultPath).catch(() => false);
			if (!already) void runOpfsSpike(this.app, this.manifest.id);
		}

		// Start any enabled Feishu bots.
		await this.syncFeishuBots();

		// Semantic Search sidebar view
		this.registerView(SEARCH_VIEW_TYPE, (leaf) => new SemanticSearchView(
			leaf, this.store, this.client, this.app.vault, this.chatClient, this.historyStore, this,
		));

		// LAN share server: persisted share URLs keep working after a restart
		// — with the registry non-empty the server comes up on plugin load
		// (port from settings, auto-bumped when taken and re-persisted); a
		// request for an uncached token re-renders the page from history.
		this.shareServer = new ShareServer(dataDir, async (sessionId, sharedAt) => {
			// Note shares (`note:<path>` keys) render the note's CURRENT
			// content; bare session ids render the chat from history.
			if (sessionId.startsWith("note:")) {
				const path = sessionId.slice("note:".length);
				const file = this.app.vault.getAbstractFileByPath(path);
				if (!(file instanceof TFile)) return null;
				return await this.noteShare.renderPage(path, await this.app.vault.read(file), sharedAt);
			}
			const sessions = await this.historyStore.load();
			const session = sessions.find((s) => s.id === sessionId);
			if (!session || session.messages.length === 0) return null;
			const firstUser = session.messages.find((m) => m.role === "user");
			const title = (firstUser?.content || session.title || t("shareTitle")).replace(/\s+/g, " ").trim();
			return renderSharePage(this.app, session.messages, title, this, "light", sharedAt);
		});
		this.noteShare = new NoteShare(
			this.app,
			this.shareServer,
			this,
			async (path) => {
				const file = this.app.vault.getAbstractFileByPath(path);
				return file instanceof TFile ? this.app.vault.read(file) : null;
			},
			() => this.saveSettings(),
			() => this.settings.sharePort,
			() => this.updateNoteShareAction(),
		);
		if (this.shareServer.hasShares()) {
			void this.shareServer.start(this.settings.sharePort).then(() => {
				if (this.shareServer.port !== this.settings.sharePort) {
					this.settings.sharePort = this.shareServer.port;
					void this.saveSettings();
				}
			}).catch((e) => console.warn("[Semlink] share server failed to start:", e));
		}

		// Editor-header share icon: attach to the active markdown view and
		// refresh its state on every file switch (file-open also fires when
		// the same leaf opens a different note).
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.updateNoteShareAction()));
		this.registerEvent(this.app.workspace.on("file-open", () => this.updateNoteShareAction()));
		this.app.workspace.onLayoutReady(() => this.updateNoteShareAction());

		// Register the custom Semlink logo as a named Obsidian icon so that both
		// the left ribbon button and the right sidebar tab use the same brand
		// mark. addIcon() wraps content in a fixed `0 0 100 100` viewBox, but our
		// logo uses a 1024 coordinate space, so we wrap the extracted inner markup
		// in a scale group (100/1024 ≈ 0.0977) to map it into that 100x100 box.
		const logoInner = logoSvg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
		addIcon("semlink-logo", `<g transform="scale(0.09765625)">${logoInner}</g>`);

		this.addRibbonIcon("semlink-logo", t("searchViewTitle"), () => {
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

		this.addCommand({
			id: "smart-vault-toggle-debug-logging",
			name: t("cmdToggleDebug"),
			callback: () => {
				this.settings.debugLogging = !(this.settings.debugLogging ?? false);
				setDebugLogging(this.settings.debugLogging);
				void this.saveSettings();
				new Notice(`Semlink: ${this.settings.debugLogging ? t("noticeDebugOn") : t("noticeDebugOff")}`);
			},
		});

		// Event listeners for progress modal
		this.registerEvent(
			(this.app.workspace as unknown as { on(name: string, cb: () => void): void }).on("smart-vault:pause", () => {
				this.scheduler.pause();
				new Notice(`Semlink: ${t("noticeIndexPaused")}`);
			})
		);
		this.registerEvent(
			(this.app.workspace as unknown as { on(name: string, cb: () => void): void }).on("smart-vault:resume", () => {
				this.scheduler.resume();
				new Notice(`Semlink: ${t("noticeIndexResumed")}`);
			})
		);

		// Update initial status bar
		await this.updateInitialStatusBar();

		debugLog("[Semlink] Plugin loaded");
	}

	/** Attach/refresh the two-state share icon on the active note's header. */
	private updateNoteShareAction(): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;
		attachNoteShareAction(
			view,
			(path) => {
				// Already shared → dialog with refresh + stop sharing; first
				// tap publishes the note and opens the same dialog.
				if (this.noteShare.isShared(path)) void this.noteShare.showShareDialog(path);
				else void this.noteShare.share(path);
			},
			(path) => this.noteShare.isShared(path),
			t("shareNoteAction"),
		);
	}

	onunload() {
		void this.usageStore?.save();
		// All synchronous — Obsidian does NOT await async onunload.
		try { this.scheduler?.abort(); } catch { /* best-effort */ }
		try { this.watcher?.stop(); } catch { /* best-effort */ }
		try { void this.mcpServer?.stop(); } catch { /* best-effort */ }
		try { void this.debugMcpServer?.stop(); } catch { /* best-effort */ }
		// Ends all LAN shares (snapshots are memory-only by design).
		try { void this.shareServer.stop(); } catch { /* best-effort */ }
		try { this.activityGate?.dispose(); } catch { /* best-effort */ }
		for (const bot of this.feishuBots.values()) {
			try { void bot.stop(); } catch { /* best-effort */ }
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
		try { void this.store?.close(); } catch { /* best-effort */ }
		debugLog("[Semlink] Plugin unloaded");
	}

	async loadSettings() {
		const data = (await this.loadData()) as Partial<SmartVaultSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...data };
		// Data written before the unified provider list existed carries the
		// old embeddingProviders/chatProviders split (and earlier still, flat
		// provider/apiBase/*ApiKey fields) — fold them into `providers` once.
		const raw = data;
		const hasProviders = Array.isArray(raw?.providers) && (raw.providers?.length ?? 0) > 0;
		if (!hasProviders) migrateEmbeddingSettings(this.settings);
		// Providers added from an earlier catalog version may carry a base URL
		// whose wire path was wrong from day one — patch those exact dead
		// values (idempotent: a fixed base no longer matches).
		migrateLegacyCatalogBases(this.settings);
		// 手动排序（providerOrder）只保留仍然存在的条目：目录里已删除/已
		// 改名的供应商、以及指向旧 logo 分组的大段 SVG 键都会残留在里面，
		// 不清洗的话会一直以旧顺序压住默认排名。
		sanitizeProviderOrder(this.settings);
		syncCatalogModels(this.settings);
	}

	async saveSettings() {
		// 嵌入模型指纹联动：模型变化（含移除/停用）→ 清向量（保留 chunks）
		// + 清 mtime，下次索引用当前形态重建；移除后向量本就不该再存在。
		const active = activeEmbeddingProvider(this.settings);
		const fingerprint = active.apiKey.trim() ? this.settings.embeddingModelKey || "" : "";
		if ((this.settings.embeddingModelFingerprint ?? "") !== fingerprint) {
			const hadPrevious = (this.settings.embeddingModelFingerprint ?? "") !== "";
			this.settings.embeddingModelFingerprint = fingerprint;
			if (hadPrevious) {
				await this.store.clearVectors();
				this.progress.reset();
				if (fingerprint) new Notice(`Semlink: ${t("embedModelChanged")}`);
			}
		}
		// 排除规则变化：把新规则命中的已索引内容从索引中移除，让检索
		//（SQL 快路径/向量）与索引侧立即一致，而不是等下次全量重建。
		if ((this.lastPurgedExcludePaths ?? "") !== this.settings.excludePaths) {
			this.lastPurgedExcludePaths = this.settings.excludePaths;
			await this.purgeExcludedFromIndex();
		}
		await this.saveData(this.settings);
		setLang(this.settings.language);
		// Re-render the search view's language-dependent UI (welcome screen,
		// input placeholder, icon tooltips) right away.
		for (const leaf of this.app.workspace.getLeavesOfType(SEARCH_VIEW_TYPE)) {
			(leaf.view as SemanticSearchView).refreshLanguage?.();
			// License changes persist through saveSettings too — flip the
			// header upgrade button / archive visibility right away.
			(leaf.view as SemanticSearchView).refreshLicenseUI?.();
		}
		this.client?.updateSettings(this.settings);
		this.chatClient?.updateSettings(this.settings);
		this.scheduler?.updateSettings(this.settings);
		this.mcpServer?.updateSettings(this.settings);
		this.watcher?.updateSettings(this.settings);
		await this.syncFeishuBots();
	}

	/** 排除规则变化后，把命中的已索引路径从索引中移除（chunks + 文档向量）。
	 *  让 SQL 快路径与向量检索立即和索引侧一致；规则放宽后走全量重建找回。 */
	async purgeExcludedFromIndex(): Promise<void> {
		const patterns = parseExcludePaths(this.settings.excludePaths);
		if (patterns.length === 0 || !this.store) return;
		try {
			const indexed = Array.from(await this.store.getAllIndexedPaths());
			const doomed = indexed.filter((p) =>
				patterns.some((g) => p.startsWith(g) || p.includes(g)),
			);
			for (const p of doomed) {
				try {
					await this.store.deleteChunksByNotePath(p);
				} catch {
					// best-effort：单条失败不阻断其余清理
				}
			}
			if (doomed.length > 0) {
				debugLog(`[Semlink] 排除规则更新：已从索引移除 ${doomed.length} 条匹配路径`);
			}
		} catch (e) {
			console.warn("[Semlink] purgeExcludedFromIndex failed:", e);
		}
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
			() => this.app.workspace.getActiveFile()?.path ?? null,
		);

		try {
			// 启动成功不打扰——MCP 是常驻后台服务，静默即可；失败仍需提示。
			await this.mcpServer.start();
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

	// ──── Debug MCP（semlink-debug）：ask 单工具，端到端测试问答 ────

	async startDebugMcpServer() {
		if (this.debugMcpServer) return;
		const server = new DebugMcpServer(
			this.settings.debugMcpPort ?? 3002,
			(q) => this.runDebugAsk(q),
			() => this.runDebugReload(),
			(path, line) => this.runDebugJump(path, line),
		);
		try {
			await server.start();
			this.debugMcpServer = server;
			debugLog(`[Semlink] debug MCP listening on http://127.0.0.1:${server.port}/mcp`);
		} catch (e) {
			console.warn("[Semlink] debug MCP failed to start:", e);
		}
	}

	async stopDebugMcpServer() {
		await this.debugMcpServer?.stop();
		this.debugMcpServer = null;
	}

	/** ask 执行器：与侧栏同一条管线（agentic 模式、按问题推断读取深度、
	 *  空历史——每次 ask 都是独立会话），收集完整思考过程与最终回答。 */
	private debugAskRunning = false;
	private async runDebugAsk(question: string): Promise<unknown> {
		if (this.debugAskRunning) throw new Error("Another ask is still running");
		this.debugAskRunning = true;
		const startedAt = Date.now();
		try {
			const thinking: ThinkingStep[] = [];
			const result = await this.chatClient.chat(
				"",
				question,
				[],
				() => { /* onToolCall：UI 动画用，调试服务无消费方 */ },
				inferAgentDepth(question),
				undefined, // onStream
				undefined, // onRoundStart
				(step) => thinking.push(step),
			);
			return {
				question,
				answer: result.answer,
				thinking,
				usedNotes: result.usedNotes,
				readNotes: result.readNotes,
				// Citation anchors: paths[n-1] is cited as [n]; lines[n-1] is the
				// jump-to line (undefined = never read/grep-anchored). Debug-only
				// visibility so the MCP surface can verify line-anchored citations.
				citeRegistry: this.chatClient.latestCiteRegistry,
				citeLines: this.chatClient.latestCiteLines,
				elapsedMs: Date.now() - startedAt,
			};
		} finally {
			this.debugAskRunning = false;
		}
	}

	/** reload 工具执行器：同命令面板的「Reload app without saving」。
	 *  整个应用窗口重载、放弃未保存修改——插件新构建加载的唯一可靠途径。 */
	/** jump 调试工具执行器：走侧栏 openNote 的真实跳行路径，然后回报实际
	 *  视图模式 / 光标行 / 滚动位置——引用跳行链路的端到端自动验证。 */
	private async runDebugJump(path: string, line: number): Promise<unknown> {
		const sidebarLeaf = this.app.workspace.getLeavesOfType(SEARCH_VIEW_TYPE)[0];
		if (!sidebarLeaf) throw new Error("search view not open — open the Semlink sidebar once first");
		const view = sidebarLeaf.view as unknown as {
			openNote(notePath: string, preview: string, lineHint?: number): Promise<void>;
		};
		const resolved = this.app.vault.getAbstractFileByPath(path) instanceof TFile;
		await view.openNote(path, "", line);
		// Give the view a beat to settle its scroll restoration, then report.
		await new Promise((r) => window.setTimeout(r, 300));
		const leaf = this.app.workspace.getLeaf(false);
		const v = leaf?.view as MarkdownView | null;
		if (!v) return { mode: "none", expectedLine: line, resolved };
		const totalLines = (await this.app.vault.cachedRead(v.file!)).split("\n").length;
		const viewFileCodes = v.file ? Array.from(v.file.path.slice(0, 24)).map((c) => c.codePointAt(0)!.toString(16)).join(",") : null;
		const mode = v.getMode();
		if (mode === "source") {
			const cur = v.editor.getCursor();
			const si = v.editor.getScrollInfo();
			return { mode, resolved, cursorLine: cur.line + 1, expectedLine: line, totalLines, scrollTop: Math.round(si.top), file: v.file?.path };
		}
		const scroller = (v.contentEl.querySelector(".markdown-preview-view") ?? v.contentEl) as HTMLElement | null;
		return { mode, resolved, scrollTop: Math.round(scroller?.scrollTop ?? -1), scrollHeight: scroller?.scrollHeight ?? -1, expectedLine: line, totalLines, file: v.file?.path };
	}

	private runDebugReload(): void {
		// commands 在当前 obsidian 类型里未公开，与 setting 等内部 API 同款断言
		(this.app as unknown as { commands: { executeCommandById(id: string): void } })
			.commands.executeCommandById("app:reload");
	}

	async toggleMcpServer() {
		if (this.mcpServer) {
			await this.stopMcpServer();
			this.settings.mcpEnabled = false;
		} else {
			await this.startMcpServer();
			this.settings.mcpEnabled = true;
		}
		await this.saveSettings();
	}

	// ──── Feishu Bots ────

	/** Reconcile running bot instances with the configured bot list. The
	 *  Feishu bot is a Pro feature (docs/freemium-design.md §3D): without a
	 *  valid license, configured bots are kept on disk but never started. */
	private async syncFeishuBots(): Promise<void> {
		const proGate = this.licenseManager?.isPro() ?? false;
		const configured = new Set<string>();
		for (const bot of this.settings.feishuBots) {
			configured.add(bot.id);
			const running = this.feishuBots.get(bot.id);
			if (!bot.enabled || !proGate) {
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

	/** Shared QA pipeline used by Feishu bots — mirrors the sidebar search
	 *  view's runSearch (agentic: no upfront retrieval; the model gathers
	 *  evidence via its own tool calls, same depth heuristic, same native
	 *  history array) so both surfaces answer identically. */
	private buildFeishuAskHandler(): FeishuAskHandler {
		return async (question, onToken, history, signal, onThinking) => {
			// Same as the sidebar: prior turns as a native message array
			// (chat-client expands them; sliding-window truncation applies).
			const historyMessages: HistoryMessage[] = (history || []).map((t) => ({
				role: t.role,
				content: t.content,
				timestamp: Date.now(),
			}));
			// Bridge chat-client's onToolCall into our per-event onThinking, so
			// the Feishu bot can stream each tool call into the thinking panel.
			const onToolCall = onThinking
				? (name: string, args: unknown) => onThinking({ type: "tool", name, args })
				: undefined;
			// Same depth heuristic as the sidebar (介绍/分析/总结 → enhanced).
			const chatResult = await this.chatClient.chat(
				"",
				question,
				historyMessages,
				onToolCall,
				inferAgentDepth(question),
				onToken,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				// No preset context — the registry starts empty and gets its
				// numbers from the agent's own tool calls, same as the sidebar.
				[],
			);
			// Honor an abort signal by rejecting (the bot treats this as stopped).
			if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
			return {
				answer: chatResult.answer,
				thinking: chatResult.thinking,
				usedNotes: chatResult.usedNotes,
			};
		};
	}

	// ──── Indexing ────

	startFullIndex() {
		// 静默守卫 + 静默启动：索引状态由状态栏/进度面板呈现，不再弹提示。
		if (this.scheduler.isRunning) return;
		void this.scheduler.run();
	}

	/** 设置页"重新索引"：清空全部索引（含分块），从 0 开始重新分块。
	 *  未配置嵌入模型时也允许——调度器会退化为只做分块索引。 */
	async reindexAll() {
		if (this.scheduler.isRunning) return;
		new Notice(`Semlink: ${t("noticeRebuildStarted")}`);
		await this.store.clearAll();
		this.progress.reset();
		void this.scheduler.run();
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
			// setActiveLeaf only focuses the leaf — it does NOT uncollapse a
			// collapsed sidebar (revealLeaf does, but it's @since 1.7.2, above
			// our declared minAppVersion). Expand the right dock explicitly so
			// clicking the ribbon button always reveals the panel.
			const rightDock = this.app.workspace.rightSplit;
			if (rightDock instanceof WorkspaceSidedock && rightDock.collapsed) {
				rightDock.expand();
			}
			workspace.setActiveLeaf(leaf, { focus: true });
		}
	}

	/** 打开侧栏并进入对应的配置引导：chat = 对话目录（首次引导同款），
	 *  embed = 嵌入专用目录（RAG 页「开始配置」），选完模型即触发索引。 */
	async openSetupGuide(kind: "chat" | "embed" = "chat"): Promise<void> {
		await this.activateSearchView();
		const leaf = this.app.workspace.getLeavesOfType(SEARCH_VIEW_TYPE)[0];
		(leaf?.view as SemanticSearchView | undefined)?.openSetupGuide(kind);
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
				// 用 DB 权威值播种进度追踪器：否则启动后任何一次进度事件
				// （扫描枚举阶段 processedNotes=0）都会把状态栏覆盖成
				// 「0 个文件」，直到打开面板/设置触发重播种才恢复。
				this.progress.initFromStats(
					stats.indexedNotes,
					stats.activeChunks,
					Math.max(this.progress.current.totalNotes, stats.indexedNotes),
				);
			}
		}
	}
}
