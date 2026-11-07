// ========================================
// Semlink - Plugin Entry Point
// ========================================

import { Notice, Plugin, FileSystemAdapter, WorkspaceLeaf, WorkspaceSidedock, addIcon, MarkdownView, TFile } from "obsidian";
import { debugLog, setDebugLogging } from "./src/log";
import { join } from "path";
import { DEFAULT_SETTINGS, activeEmbeddingProvider, migrateEmbeddingSettings, type SmartVaultSettings, type HistoryMessage } from "./src/types";
import { WebSearchService } from "./src/web-search";
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
	/** 内置 MCP 服务最后一次启动失败的原因（瞬态，不进 data.json）：
	 *  startMcpServer 成功置 null、失败写 err.message，MCP 设置页据此
	 *  把内置服务行渲染成「连接失败」态并展示原因。 */
	mcpLastError: string | null = null;
	/** LAN share server for conversation snapshots. Token↔session pairs
	 *  persist in data/share-registry.json and the port in settings, so a
	 *  share URL keeps working across restarts (unchanged IP); page HTML is
	 *  re-rendered from chat history on request. */
	shareServer: ShareServer;
	/** Note-level LAN sharing: reuses the ShareServer registry with
	 *  `note:<path>` keys and drives the editor-header two-state icon. */
	noteShare!: NoteShare;
	/** DeepSeek 网页搜索：复用带 Key 的 DeepSeek 聊天供应商，无则 web_search 不注册。 */
	webSearch!: WebSearchService;
	historyStore!: ChatHistoryStore;
	watcher!: VaultWatcher;
	pluginDir: string = "";

	/** 对话浮窗状态：Semlink 视图已迁入独立 popout（弹出按钮置位）。
	 *  该窗口关闭且全库已无 Semlink 视图时，window-close 处理器自动把
	 *  主页放回右侧栏（视图实例随窗口销毁，重开为新实例，历史会话
	 *  持久在库中，打开后可从历史继续）。 */
	semlinkPopoutActive = false;

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
		// DeepSeek 网页搜索：供应商配置现读（换 Key/换供应商即时生效）
		this.webSearch = new WebSearchService({ getSettings: () => this.settings });
		this.chatTools = new SemlinkTools(this.store, this.client, this.app.vault, () => this.app.workspace.getActiveFile()?.path ?? null, () => this.settings.excludePaths, this.webSearch, () => this.mcpInfoText());
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
		this.setupSilentReconcile();

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

		// 新建标签页显示 Semlink 主页：等布局就绪后开始接管，避免在启动
		// 恢复布局的中途替换视图。

		// 对话浮窗回归侧栏：弹出的 popout 窗口关闭且已无任何 Semlink 视图
		// 时，自动把主页放回右侧栏。延迟一个宏任务——window-close 触发时
		// 窗口内的 leaf 可能尚未完成注销，等注销后再清点才准确。
		this.registerEvent(this.app.workspace.on("window-close", () => {
			if (!this.semlinkPopoutActive) return;
			window.setTimeout(() => {
				const stillOpen = this.app.workspace.getLeavesOfType(SEARCH_VIEW_TYPE).length > 0;
				this.semlinkPopoutActive = false;
				// 还有别的实例（如新标签页主页）在运行就不重复开
				if (!stillOpen) void this.activateSearchView();
			}, 0);
		}));

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

		this.addRibbonIcon("semlink-logo", "Semlink", () => {
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

	/** mcp_info 工具的实现：服务端配置 + 外部客户端连接 JSON + 已接入的
	 *  外部 MCP 服务器清单。密钥只报"已设置/未设置"，外部服务器的
	 *  Authorization/Token 类头值打码——工具结果会进模型上下文，不回明文。 */
	private async mcpInfoText(): Promise<string> {
		const s = this.settings;
		const keySet = !!s.mcpApiKey?.trim();
		const running = !!this.mcpServer;
		const baseUrl = `http://127.0.0.1:${s.mcpPort}`;
		const maskHeaders = (headers?: Record<string, string>): string => {
			if (!headers || Object.keys(headers).length === 0) return "";
			const parts = Object.entries(headers).map(([k, v]) =>
				/auth|token|key|secret/i.test(k) ? `${k}=***` : `${k}=${v}`,
			);
			return ` headers: ${parts.join(", ")}`;
		};
		const lines: string[] = [];
		lines.push(`Semlink MCP server: ${s.mcpEnabled === false ? "disabled in settings" : running ? "running" : "enabled but not running"} | ${baseUrl}`);
		lines.push(`Auth: ${keySet ? "key set (send as Authorization: Bearer <key>)" : "no key required"}`);
		const tools = running ? this.mcpServer?.toolNames() ?? [] : [];
		if (tools.length > 0) lines.push(`Tools exposed (${tools.length}): ${tools.join(", ")}`);
		const connect: Record<string, unknown> = { url: baseUrl };
		if (keySet) connect.headers = { Authorization: `Bearer <your-key>` };
		lines.push(`Connect JSON for external clients:\n${JSON.stringify({ mcpServers: { semlink: connect } }, null, 2)}`);

		const clients = s.mcpClientServers ?? [];
		if (clients.length === 0) {
			lines.push("External MCP servers: none configured (Settings → MCP to add)");
		} else {
			lines.push(`External MCP servers (${clients.length}):`);
			for (const c of clients) {
				const endpoint = c.type === "stdio" ? [c.command, ...(c.args ? c.args.split(/\s+/) : [])].filter(Boolean).join(" ") : c.url ?? "";
				lines.push(`- [${c.enabled ? "enabled" : "disabled"}] ${c.name} (${c.type}) → ${endpoint}${maskHeaders(c.headers)}`);
			}
		}
		return lines.join("\n");
	}

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
			this.webSearch,
			() => this.mcpInfoText(),
		);

		try {
			// 启动成功不打扰——MCP 是常驻后台服务，静默即可；失败仍需提示。
			await this.mcpServer.start();
			this.mcpLastError = null;
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Semlink MCP: ${t("noticeMcpFailed")} - ${msg}`);
			this.mcpLastError = msg;
			this.mcpServer = null;
		}
	}

	async stopMcpServer() {
		if (this.mcpServer) {
			await this.mcpServer.stop();
			this.mcpServer = null;
			new Notice(`Semlink MCP: ${t("noticeMcpStopped")}`);
		}
		// 手动停止不是失败：清掉上一次的启动错误，设置页回到「已停止」态。
		this.mcpLastError = null;
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
			(opts) => this.runDebugMeasure(opts),
			(opts) => this.runDebugShot(opts),
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

	private async runDebugMeasure(opts?: { popout?: boolean; repro?: boolean; sessionIdx?: number; nav?: number | string; width?: number; height?: number; dock?: boolean; scrollPanel?: number }): Promise<unknown> {
		// 可选：先把搜索视图移入独立弹窗再量（弹窗实例的布局与主窗不同）。
		// width/height 自定弹窗尺寸（≤480 可测窄幅断点）；不传用形态默认值。
		// 对已在弹窗里的 leaf 再次 moveLeafToPopout = 按新尺寸重建弹窗，
		// 旧窗随之空置自动关闭——调宽度无需先收回。
		if (opts?.popout) {
			const leaf = this.app.workspace.getLeavesOfType(SEARCH_VIEW_TYPE)[0];
			if (leaf) {
				const w = typeof opts.width === "number" ? opts.width : opts.popout === true ? 420 : 780;
				const h = typeof opts.height === "number" ? opts.height : opts.popout === true ? 800 : 720;
				await this.app.workspace.moveLeafToPopout(leaf, { size: { width: w, height: h } });
				await new Promise((r) => window.setTimeout(r, 800));
			}
		}
		// 可选：把弹窗实例收回侧栏（点视图自己的收回按钮——插件的迁移
		// 逻辑处理实例搬运与会话保持，比 workspace 内部 API 搬运可靠）。
		if (opts?.dock) {
			const leaves = this.app.workspace.getLeavesOfType(SEARCH_VIEW_TYPE);
			const floatLeaf = leaves.find((l) => (l.view as unknown as { containerEl?: { ownerDocument?: Document } }).containerEl?.ownerDocument !== window.document);
			const svDock = (floatLeaf ?? leaves[0])?.view as unknown as { popoutBtnEl?: HTMLElement } | null;
			svDock?.popoutBtnEl?.click();
			await new Promise((r) => window.setTimeout(r, 1000));
		}
		// 导航注入：nav="settings" 打开内嵌设置屏；nav=数字 点击第 N 个
		// 设置 tab（0=模型 1=RAG 2=MCP 3=分享 4=Pro）。供截图走查。
		let navDbg: Record<string, unknown> | null = null;
		if (opts?.nav !== undefined) {
			// 先把 Semlink 视图激活到前台（同一右栏里可能有笔记 tab 挡着），
			// 并用 activateSearchView 返回的确切 leaf——getLeavesOfType[0]
			// 可能是另一个不可见实例，nav 操作它等于白做。
			const navLeaf = await this.activateSearchView();
			await new Promise((r) => window.setTimeout(r, 500));
			if (!navLeaf) {
				await this.activateSearchView();
				await new Promise((r) => window.setTimeout(r, 800));
			}
			const leafForNav = navLeaf ?? this.app.workspace.getLeavesOfType(SEARCH_VIEW_TYPE)[0];
			const sv = leafForNav?.view as unknown as {
				contentEl?: HTMLElement;
				openSettingsScreen?: () => void;
			} | null;
			if (sv?.contentEl) {
				if (opts.nav === "settings") {
					sv.openSettingsScreen?.();
					await new Promise((r) => window.setTimeout(r, 700));
				} else if (/^\d+$/.test(String(opts.nav))) {
					// MCP 客户端可能把数字参数强转成字符串（实测 nav=0 到达时是
					// "0"）——typeof number 判定永远落空，这里按数字字符串兼容。
					const navIdx = parseInt(String(opts.nav), 10);
					sv.openSettingsScreen?.();
					await new Promise((r) => window.setTimeout(r, 500));
					// DOM .click() 在这个嵌入实例上不生效——直接改设置 tab
					// 实例的 activeTab 并重渲染，确定性切换。
					// nav 语义 = 菜单位置（用户拍板顺序：Model 第一、Pro 最后）
					const ids = ["model", "embedding", "mcp", "share", "general"] as const;
					const inst = (sv as unknown as {
						settingsEmbed?: { tab?: { activeTab?: string; display(): void } };
					}).settingsEmbed?.tab;
					navDbg = { hadInst: !!inst, instTab: inst?.activeTab ?? null, navRaw: String(opts.nav) };
					if (inst && ids[navIdx]) {
						inst.activeTab = ids[navIdx];
						inst.display();
						// 横向 tab 栏无层级：切 tab 即所见（窄幅下详情也在栏下方
						// 常显，导航注入直接可读）。
						navDbg.switched = inst.activeTab;
						const doc0 = sv.contentEl?.ownerDocument;
						navDbg.domRightAfter = doc0?.querySelector(".semlink-settings-menu-item.is-active .semlink-settings-menu-label")?.textContent ?? null;
						// 选中段计算样式：取证白拇指被 blanket 按钮规则压掉与否
						const activeItem = doc0?.querySelector<HTMLElement>(".semlink-settings-menu-item.is-active");
						if (activeItem) {
							const cs = doc0!.defaultView!.getComputedStyle(activeItem);
							navDbg.activeStyle = {
								backgroundColor: cs.backgroundColor,
								boxShadow: cs.boxShadow.slice(0, 60),
								color: cs.color,
							};
						}
						navDbg.drilled = !!doc0?.querySelector(".semlink-settings-root.is-drilled");
						navDbg.docIsMain = doc0 === window.document;
					} else {
						const doc = sv.contentEl.ownerDocument;
						const chips = doc.querySelectorAll(".semlink-settings-menu-item");
						(chips[navIdx] as HTMLElement | undefined)?.click();
					}
					await new Promise((r) => window.setTimeout(r, 700));
				}
			}
			// scrollPanel：把设置面板滚到指定 scrollTop（-1 = 滚到底）。
			// License 卡在面板顶部占一屏，下方折行的开关/按钮行验收全靠它。
			if (typeof opts?.scrollPanel === "number" && sv?.contentEl) {
				const doc0 = sv.contentEl.ownerDocument;
				const panels = doc0.querySelectorAll<HTMLElement>(".semlink-settings-panel");
				(navDbg ??= {}).panelCount = panels.length;
				for (const p of Array.from(panels)) {
					p.scrollTop = opts.scrollPanel < 0 ? p.scrollHeight : opts.scrollPanel;
					(navDbg as Record<string, unknown>).scrollTopAfter = Math.round(p.scrollTop);
				}
				await new Promise((r) => window.setTimeout(r, 250));
			}
		}
		// 复现「点弹窗按钮后咖啡杯丢失」：进入嵌入引导 → 点真实弹窗按钮 →
		// 按时间点扫描所有窗口里的 cup canvas（存在性 + 像素）。
		const reproLog: Array<Record<string, unknown>> = [];
		const probeCanvas = (tag: string): void => {
			const wins: Document[] = [window.document];
			const floats = (this.app.workspace as unknown as { floatingSplit?: { children?: Array<{ win?: Window }> } }).floatingSplit;
			for (const c of floats?.children ?? []) {
				if (c?.win?.document) wins.push(c.win.document);
			}
			for (const doc of wins) {
				const c = doc.querySelector(".semlink-guide-index-cupcanvas") as HTMLCanvasElement | null;
				let painted = -1;
				if (c) {
					try {
						const ctx2 = c.getContext("2d");
						if (ctx2) {
							const img = ctx2.getImageData(0, 0, c.width, c.height).data;
							let n = 0;
							for (let i = 3; i < img.length; i += 16) if (img[i] > 0) n++;
							painted = n;
						}
					} catch {
						painted = -2;
					}
				}
				const welcome = doc.querySelector(".semlink-search-welcome");
				reproLog.push({
					tag,
					win: doc === window.document ? "main" : "popout",
					canvas: !!c,
					painted,
					screen: welcome
						? welcome.classList.contains("semlink-search-welcome-guide") ? "guide"
							: welcome.classList.contains("semlink-settings-screen") ? "settings" : "home"
						: "session-or-none",
				});
			}
		};
		if (opts?.repro) {
			// 上一次复现可能把视图留在了弹窗里——先关掉弹窗让它回侧栏。
			const floatsPre = (this.app.workspace as unknown as { floatingSplit?: { children?: Array<{ win?: { close?: () => void } }> } }).floatingSplit;
			if (floatsPre?.children?.length) {
				floatsPre.children[0]?.win?.close?.();
				await new Promise((r) => window.setTimeout(r, 1200));
			}
			// reload 后视图可能根本没恢复（弹窗不进会话）——先唤起侧栏实例。
			if (this.app.workspace.getLeavesOfType(SEARCH_VIEW_TYPE).length === 0) {
				await this.activateSearchView();
				await new Promise((r) => window.setTimeout(r, 800));
			}
			const leaf0 = this.app.workspace.getLeavesOfType(SEARCH_VIEW_TYPE)[0];
			const sv = leaf0?.view as unknown as {
				guideRequested?: boolean; guideMode?: string; messagesEl?: HTMLElement;
				renderWelcome?: () => void; popoutBtnEl?: HTMLElement;
			} | null;
			if (sv?.messagesEl && sv.renderWelcome && sv.popoutBtnEl) {
				sv.guideRequested = true;
				sv.guideMode = "embed";
				sv.messagesEl.empty();
				sv.renderWelcome();
				await new Promise((r) => window.setTimeout(r, 400));
				probeCanvas("guide-in-sidebar");
				sv.popoutBtnEl.click();
				await new Promise((r) => window.setTimeout(r, 300));
				probeCanvas("t+300ms-after-click");
				await new Promise((r) => window.setTimeout(r, 1700));
				probeCanvas("t+2000ms-after-click");
			} else {
				const all = this.app.workspace.getLeavesOfType(SEARCH_VIEW_TYPE);
				reproLog.push({
					tag: "setup-failed",
					leafCount: all.length,
					leafs: all.map((l) => ({
						hasView: !!l.view,
						doc: l.view ? (l.view as unknown as { containerEl?: { ownerDocument?: Document } }).containerEl?.ownerDocument === window.document ? "main" : "popout" : "no-view",
					})),
					floats: floatsPre?.children?.length ?? 0,
				});
			}
		}
		type WinLike = { document: Document; innerWidth: number; innerHeight: number; devicePixelRatio: number; getComputedStyle(el: Element): CSSStyleDeclaration; CSSStyleRule: typeof CSSStyleRule };
		// 主窗 + 全部弹窗（floatingSplit 子树各持自己的 window）
		const wins: WinLike[] = [window as unknown as WinLike];
		const floats = (this.app.workspace as unknown as { floatingSplit?: { children?: Array<{ win?: WinLike }> } }).floatingSplit;
		for (const c of floats?.children ?? []) {
			if (c?.win) wins.push(c.win);
		}
		const out: Record<string, unknown> = {};
		for (const w of wins) {
			const view = w.document.querySelector(".semlink-search-view");
			if (!view) continue;
			const pick = (sel: string) => {
				const el = w.document.querySelector(sel) as HTMLElement | null;
				if (!el) return null;
				const r = el.getBoundingClientRect();
				const cs = w.getComputedStyle(el);
				return {
					rect: { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), width: Math.round(r.width) },
					padding: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`,
					margin: `${cs.marginTop} ${cs.marginRight} ${cs.marginBottom} ${cs.marginLeft}`,
					display: cs.display,
					alignItems: cs.alignItems,
				};
			};
			// 头部左右按钮组的垂直中心对比（对齐诊断）＋横向坐标（左右对称性诊断）
			const sides = Array.from(w.document.querySelectorAll(".semlink-search-header-side")) as HTMLElement[];
			const headerSides = sides.map((side) => {
				const r = side.getBoundingClientRect();
				const btns = Array.from(side.querySelectorAll("button")) as HTMLElement[];
				return {
					side: { top: Math.round(r.top), height: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right) },
					firstBtnCenter: btns.length ? Math.round(btns[0].getBoundingClientRect().top + btns[0].getBoundingClientRect().height / 2) : null,
					buttons: btns.map((b) => {
						const br = b.getBoundingClientRect();
						return { left: Math.round(br.left), right: Math.round(br.right), w: Math.round(br.width), hidden: b.offsetParent === null };
					}),
					display: w.getComputedStyle(side).display,
					alignItems: w.getComputedStyle(side).alignItems,
				};
			});
			// 找出给视图设置 padding 的样式表规则（含来源 href）——
			// 12/12/32 的来源在插件样式表之外，需要定位是哪条规则。
			const probeView = w.document.querySelector(".semlink-search-view") as HTMLElement | null;
			const padRules: Array<{ href: string; selector: string; padding: string; important: boolean }> = [];
			if (probeView) {
				const inline = probeView.getAttribute("style") ?? "";
				for (const sheet of Array.from(w.document.styleSheets)) {
					let rules: CSSRuleList;
					try { rules = sheet.cssRules; } catch { continue; }
					for (const rule of Array.from(rules)) {
						const styleRule = rule as CSSStyleRule;
						if (!styleRule.selectorText || !styleRule.style) continue;
						try {
							if (!styleRule.style.paddingBottom) continue;
							if (!probeView.matches(styleRule.selectorText)) continue;
							padRules.push({
								href: sheet.href?.split("/").slice(-1)[0] ?? "(inline)",
								selector: styleRule.selectorText,
								padding: `${styleRule.style.paddingTop} ${styleRule.style.paddingRight} ${styleRule.style.paddingBottom} ${styleRule.style.paddingLeft}`,
								important: styleRule.style.getPropertyPriority("padding-bottom") === "important",
							});
						} catch { continue; }
					}
				}
				if (inline) padRules.push({ href: "(inline)", selector: "style attr", padding: inline, important: false });
			}
			// 主页 ↔ 引导 hub 抖动诊断：临时切到 hub 量一次再切回（不落盘）。
			let jitter: Record<string, unknown> | null = null;
			// 视图对象（不是 DOM 元素）：messagesEl/renderWelcome 都在实例上
			const semView = this.app.workspace.getLeavesOfType(SEARCH_VIEW_TYPE)
				.map((l) => l.view as unknown as {
					contentEl?: HTMLElement; guideRequested?: boolean; messagesEl?: HTMLElement;
					renderWelcome?: () => void; newChatFromUi?: () => void;
				} | null)
				.find((v) => v?.contentEl?.ownerDocument === w.document) ?? null;
			const rectOf = (sel: string): { x: number; y: number; w: number; h: number } | null => {
				const el = w.document.querySelector(sel) as HTMLElement | null;
				if (!el) return null;
				const r = el.getBoundingClientRect();
				return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
			};
			if (semView?.messagesEl && semView.renderWelcome && !w.document.querySelector(".semlink-search-welcome")) {
				// 停在会话里 → 先回到主页（会话已持久化，可从历史恢复）
				semView.newChatFromUi?.();
				await new Promise((r2) => setTimeout(r2, 400));
			}
			const dbg = {
				hasSemView: !!semView,
				hasMessages: !!semView?.messagesEl,
				hasRender: typeof semView?.renderWelcome,
				hasNewChat: typeof semView?.newChatFromUi,
				welcomeCount: w.document.querySelectorAll(".semlink-search-welcome").length,
				guideCount: w.document.querySelectorAll(".semlink-search-welcome-guide").length,
				msgChildren: semView?.messagesEl?.children.length ?? -1,
				msgFirstCls: semView?.messagesEl?.firstElementChild?.className ?? null,
			};
			// jitter 诊断会切走再切回渲染（破坏设置屏/会话）——nav 注入时跳过。
			// 设置屏/引导屏占据欢迎区时同样跳过：它们不是可随手重渲的「主页」，
			// swap 会把嵌入的设置 Tab 实例连带毁掉（用户正在填的表单清空）。
			const busyScreen = w.document.querySelector(".semlink-settings-screen, .semlink-search-welcome-guide");
			if (opts?.nav === undefined && !busyScreen && semView?.messagesEl && semView.renderWelcome && w.document.querySelector(".semlink-search-welcome:not(.semlink-search-welcome-guide)")) {
				const home = {
					brand: rectOf(".semlink-search-brand-group"),
					rightIcons: rectOf(".semlink-search-header-right"),
					leftIcons: rectOf(".semlink-search-view > .semlink-search-header .semlink-search-header-side:not(.semlink-search-header-right)"),
					emoji: rectOf(".semlink-search-welcome-emoji"),
					greeting: rectOf(".semlink-search-welcome-greeting"),
				};
				semView.guideRequested = true;
				semView.messagesEl.empty();
				semView.renderWelcome();
				await new Promise((r2) => setTimeout(r2, 600));
					const cs = w.document.querySelector(".semlink-guide-corners") as HTMLElement | null;
					const csStyle = cs ? w.getComputedStyle(cs) : null;
					const msgs = w.document.querySelector(".semlink-search-messages") as HTMLElement | null;
					const msgsStyle = msgs ? w.getComputedStyle(msgs) : null;
					const guide = {
						cornersBox: cs && csStyle ? { margin: `${csStyle.marginTop} ${csStyle.marginRight} ${csStyle.marginBottom} ${csStyle.marginLeft}`, width: csStyle.width, parentCls: cs.parentElement?.className } : null,
						messagesBox: msgs && msgsStyle ? { rect: rectOf(".semlink-search-messages"), padding: `${msgsStyle.paddingTop} ${msgsStyle.paddingRight} ${msgsStyle.paddingBottom} ${msgsStyle.paddingLeft}` } : null,
						corners: rectOf(".semlink-guide-corners"),
						brand: rectOf(".semlink-guide-corners .semlink-search-brand-group"),
						rightIcons: rectOf(".semlink-guide-corners .semlink-search-header-right"),
						leftIcons: rectOf(".semlink-guide-corners .semlink-search-header-side:not(.semlink-search-header-right)"),
						emoji: rectOf(".semlink-guide-hub-emoji"),
						name: rectOf(".semlink-guide-hub-name"),
					};
				semView.guideRequested = false;
				semView.messagesEl.empty();
				semView.renderWelcome();
				await new Promise((r2) => setTimeout(r2, 600));
				const d = (a: { x: number; y: number } | null, b: { x: number; y: number } | null) =>
					a && b ? { dx: b.x - a.x, dy: b.y - a.y } : null;
				jitter = {
					home, guide,
					brandDelta: d(home.brand, guide.brand),
					rightIconsDelta: d(home.rightIcons, guide.rightIcons),
					emojiDelta: d(home.emoji, guide.emoji),
				};
			}
			// 对话列裁剪诊断：消息区与首条用户气泡/回答卡的横向坐标。
			// 界面停在主页时先加载最近一次会话，复现有气泡的真实状态。
			// sessionIdx：可指定加载第 N 个会话（0=最新）——用于对比
			// 「有滚动条的长对话 vs 无滚动条的短对话」的卡片右缘。
			// nav 注入（设置屏截图走查）时跳过——否则会把刚打开的设置屏
			// 用会话顶掉。设置屏/引导屏同样跳过（同上：诊断不得顶掉业务屏）。
			if (opts?.nav === undefined && !busyScreen && !w.document.querySelector(".semlink-msg-user-turn")) {
				const sv = semView as unknown as {
					history?: { load(): Promise<Array<Record<string, unknown>>> };
					loadSession?: (s: unknown) => Promise<void>;
				};
				try {
					const sessions = await sv.history?.load?.();
					const pick = sessions?.[opts?.sessionIdx ?? 0];
					if (pick) {
						await sv.loadSession?.(pick);
						await new Promise((r2) => setTimeout(r2, 600));
					}
				} catch { /* 诊断尽力而为 */ }
			}
			const msgsBox = (() => {
				const m = w.document.querySelector(".semlink-search-messages") as HTMLElement | null;
				if (!m) return null;
				const r = m.getBoundingClientRect();
				const cs = w.getComputedStyle(m);
				return { rect: { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) }, padding: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`, margin: `${cs.marginTop} ${cs.marginRight} ${cs.marginBottom} ${cs.marginLeft}` };
			})();
			out[`window_${Math.round(w.innerWidth)}x${Math.round(w.innerHeight)}@${w.devicePixelRatio}`] = {
				dbg,
				jitter,
				padRules,
				headerSides,
				// 咖啡杯 canvas 探针：是否在本文档、尺寸、以及是否有非透明像素
				cupProbe: (() => {
					const c = w.document.querySelector(".semlink-guide-index-cupcanvas") as HTMLCanvasElement | null;
					const r0 = c?.getBoundingClientRect();
					let painted = -1;
					try {
						const ctx2 = c?.getContext("2d");
						if (c && ctx2) {
							const img = ctx2.getImageData(0, 0, c.width, c.height).data;
							let n = 0;
							for (let i = 3; i < img.length; i += 16) if (img[i] > 0) n++;
							painted = n;
						}
					} catch {
						painted = -2;
					}
					return {
						inThisDoc: !!c && c.ownerDocument === w.document,
						rect: r0 ? { left: Math.round(r0.left), top: Math.round(r0.top), w: Math.round(r0.width), h: Math.round(r0.height) } : null,
						canvasW: c?.width ?? 0,
						canvasH: c?.height ?? 0,
						paintedSamples: painted,
						// 界面判定：当前渲染的是哪一块
						screen: {
							indexstats: !!w.document.querySelector(".semlink-guide-indexstats"),
							guide: !!w.document.querySelector(".semlink-search-welcome-guide"),
							hub: !!w.document.querySelector(".semlink-guide-hub-card"),
							home: !!w.document.querySelector(".semlink-search-welcome:not(.semlink-search-welcome-guide):not(.semlink-settings-screen)"),
							settings: !!w.document.querySelector(".semlink-settings-screen"),
							canvasTotal: w.document.querySelectorAll("canvas").length,
						},
					};
				})(),
				// 对话列裁剪诊断：消息区与首条用户气泡/回答卡的横向坐标
				activeTab: (() => {
					const t = w.document.querySelector(".semlink-settings-tab.is-active");
					return (t ? t.textContent : null) + " chips=" + w.document.querySelectorAll(".semlink-settings-tabs button").length + " screen=" + !!w.document.querySelector(".semlink-settings-screen") + " roots=" + w.document.querySelectorAll(".semlink-settings-root").length;
				})(),
				// 设置菜单卡宽度诊断：遍历文档内全部设置根实例（侧栏/主区 tab
				// 可能并存，querySelector 首个会被隐藏实例污染）
				settingsCard: (() => {
					const roots = Array.from(w.document.querySelectorAll(".semlink-settings-root")) as HTMLElement[];
					return roots.map((root) => {
						const col = root.querySelector(":scope > .semlink-settings-layout > .semlink-settings-menu-col") as HTMLElement | null;
						const menu = root.querySelector(".semlink-settings-menu") as HTMLElement | null;
						const panel = root.querySelector(".semlink-settings-panel") as HTMLElement | null;
						const mt = root.querySelector(".semlink-mt") as HTMLElement | null;
							const prov = root.querySelector(".semlink-mt-providers") as HTMLElement | null;
							const models = root.querySelector(".semlink-mt-config") as HTMLElement | null;
						const rect = (el: HTMLElement | null) => { const r = el?.getBoundingClientRect(); return r ? Math.round(r.width) : -1; };
						const hint = root.querySelector(".semlink-settings-menu-hint") as HTMLElement | null;
						const chev = root.querySelector(".semlink-settings-menu-chevron") as HTMLElement | null;
						return {
							rootW: root.offsetWidth,
							colW: col?.offsetWidth ?? -1,
							menuW: menu?.offsetWidth ?? -1,
							hintVisible: hint ? hint.offsetWidth > 0 : null,
							chevronVisible: chev ? chev.offsetWidth > 0 : null,
							panelClientW: panel?.clientWidth ?? -1,
							panelScrollW: panel?.scrollWidth ?? -1,
							// 溢出元素定位：横向 scrollWidth 超出 clientWidth 的前 3 个
							// 后代（类名 + 宽度）——Model 页/MCP 页窄幅溢出类问题的
							// 病根探测器，不再靠猜。另附直接子项宽度（面板 scrollWidth
							// 超标时先看是谁宽）。
							overflowers: (() => {
								if (!panel) return null;
								const panelRect = panel.getBoundingClientRect();
								const direct = Array.from(panel.children).map((c) => ({
									cls: (c.className || "").toString().slice(0, 40),
									w: (c as HTMLElement).offsetWidth,
								}));
								const hits: Array<Record<string, unknown>> = [];
								const widest: Array<Record<string, unknown>> = [];
								const walk = (el: Element, depth: number): void => {
									if (depth > 12) return;
									for (const child of Array.from(el.children)) {
										const h = child as HTMLElement;
										if (hits.length < 3 && h.scrollWidth > h.clientWidth + 2 && h.clientWidth > 0) {
											hits.push({ cls: (h.className || "").toString().slice(0, 60), client: h.clientWidth, scroll: h.scrollWidth });
										}
										if (widest.length < 4) {
											const r = h.getBoundingClientRect();
											widest.push({
												cls: (h.className || "").toString().slice(0, 50),
												w: h.offsetWidth,
												// 右缘相对面板左缘：超出 clientWidth 的就是
												// scrollWidth 溢出的真凶（含绝对定位逃逸者）。
												right: Math.round(r.right - panelRect.left),
											});
											widest.sort((a, b) => (b.right as number) - (a.right as number));
											if (widest.length > 4) widest.pop();
										}
										walk(child, depth + 1);
									}
								};
								walk(panel, 0);
								return { panelW: panel.offsetWidth, direct, widest, hits: hits.length ? hits : "none" };
							})(),
							mtW: rect(mt),
							providersW: rect(prov),
							modelsW: rect(models),
							// 总开关实测：容器与 ::after 圆钮的渲染尺寸/位移——
							// 51×31+27 规格被哪条规则改写一测便知。
							mtToggle: (() => {
								const tgl = root.querySelector(
									".semlink-mt-config-master .checkbox-container",
								) as HTMLElement | null;
								if (!tgl) return null;
								const cs = getComputedStyle(tgl);
								const after = getComputedStyle(tgl, "::after");
								return {
									w: Math.round(tgl.getBoundingClientRect().width),
									h: Math.round(tgl.getBoundingClientRect().height),
									width: cs.width,
									height: cs.height,
									display: cs.display,
									flexShrink: cs.flexShrink,
									afterW: after.width,
									afterH: after.height,
									afterTransform: after.transform,
								};
							})(),
							// Model 页纵向链诊断：面板/mt/列/行卡的 clientHeight 与
							// scrollHeight——短列表下方灰底空洞（fill 链断裂）或
							// 超高列表（内部滚动失效）都靠这组数定位。
							mtHeights: (() => {
								const h = (el: HTMLElement | null) => el
									? { ch: el.clientHeight, sh: el.scrollHeight }
									: null;
								// 面板向上到视图根的祖先链：类名 + 高度 + overflow-y +
								// display——纵向 fill 链断在哪一环直接看这条链。
								const chain: Array<Record<string, unknown>> = [];
								if (panel) {
									let el: HTMLElement | null = panel;
									while (el && chain.length < 14) {
										const cs = getComputedStyle(el);
										chain.push({
											cls: (el.className || "").toString().slice(0, 60),
											ch: el.clientHeight,
											sh: el.scrollHeight,
											oy: cs.overflowY,
											disp: cs.display,
											fxd: cs.flexDirection,
										});
										el = el.parentElement;
									}
								}
								return {
									panel: h(panel),
									mt: h(mt),
									prov: h(prov),
									// 展开文件夹后中栏列表 scrollTop 归零（向上跳）的取证
									provSt: prov ? prov.scrollTop : -1,
									mtTrace: ((root.querySelector(".semlink-settings-panel") as unknown as { __mtTrace?: string[] } | null)?.__mtTrace ?? []).slice(-10),
									models: h(models),
									rows: h((root.querySelector(".semlink-mt-rows") as HTMLElement | null)),
									chain,
								};
							})(),
						};
					});
				})(),
				msgsBox,
				// 横向溢出诊断：scrollWidth 超过 clientWidth 说明卡片真的被裁
				clipProbe: (() => {
					const m = w.document.querySelector(".semlink-search-messages") as HTMLElement | null;
					if (!m) return null;
					const bubble = m.querySelector(".semlink-msg-turn:not(.semlink-msg-user-turn) .semlink-msg-bubble") as HTMLElement | null;
					const br = bubble?.getBoundingClientRect();
					const turn = m.querySelector(".semlink-msg-turn:not(.semlink-msg-user-turn)") as HTMLElement | null;
					const tr = turn?.getBoundingClientRect();
					return {
						scrollW: m.scrollWidth,
						clientW: m.clientWidth,
						overflow: m.scrollWidth > m.clientWidth,
						bubble: br ? { left: Math.round(br.left), right: Math.round(br.right), w: Math.round(br.width) } : null,
						turn: tr ? { left: Math.round(tr.left), right: Math.round(tr.right), w: Math.round(tr.width) } : null,
						// 右缘视觉诊断：边框/圆角/裁剪链
						bubbleStyle: bubble ? ((cs2) => ({
							borderRight: `${cs2.borderRightWidth} ${cs2.borderRightStyle} ${cs2.borderRightColor}`,
							borderLeft: `${cs2.borderLeftWidth} ${cs2.borderLeftStyle} ${cs2.borderLeftColor}`,
							radius: cs2.borderTopRightRadius,
							overflowX: cs2.overflowX,
							marginR: cs2.marginRight,
							width: cs2.width,
							maxWidth: cs2.maxWidth,
						}))(w.getComputedStyle(bubble)) : null,
						turnOverflow: turn ? w.getComputedStyle(turn).overflowX : null,
					};
				})(),
				userBubble: rectOf(".semlink-msg-user-turn"),
				answerCard: rectOf(".semlink-msg-turn:not(.semlink-msg-user-turn)"),
				view: pick(".semlink-search-view"),
				footer: pick(".semlink-search-footer"),
				wrapper: pick(".semlink-search-input-wrapper"),
				row: pick(".semlink-search-input-row"),
				input: pick(".semlink-search-input"),
				model: pick(".semlink-search-model"),
			};
		}
		if (navDbg) out.navDbg = navDbg;
		out.winState = this.collectDebugWinState();
		if (reproLog.length > 0) out.reproLog = reproLog;
		if (Object.keys(out).length === 0) {
			// 没有任何窗口开着视图——主动唤起主区标签页实例再量一次。
			await this.activateSearchView();
			await new Promise((r) => window.setTimeout(r, 600));
			const view = document.querySelector(".semlink-search-view");
			if (!view) return { error: "search view did not open" };
		}
		return out;
	}

	/** shot 执行器：Electron capturePage 截取窗口 PNG 到系统临时目录并返回
	 *  绝对路径。capturePage 走合成器（不依赖窗口是否被遮挡/置顶），弹窗与
	 *  主窗都能截；DPR 缩放保留在像素里（retina 下文件是 2x）。 */
	/** winState 探针：枚举全部 Semlink 视图实例，回报窗口形态与尺寸。
	 *  形态判定：独立文档 = 弹窗；主文档内落在左右分栏 = 侧栏；其余 = 主区。
	 *  尺寸两级：viewport（布局/容器查询实际生效面）与 OS 窗口外框
	 *  （outerWidth/Height，Electron 渲染进程原生支持）。断点口径与
	 *  设置屏容器查询一致（480/720）。 */
	private collectDebugWinState(): Array<Record<string, unknown>> {
		const out: Array<Record<string, unknown>> = [];
		const leaves = this.app.workspace.getLeavesOfType(SEARCH_VIEW_TYPE);
		for (const leaf of leaves) {
			const el = ((leaf as unknown as { containerEl?: HTMLElement }).containerEl
				?? (leaf.view as unknown as { containerEl?: HTMLElement }).containerEl);
			const doc = el?.ownerDocument;
			const dv = doc?.defaultView;
			if (!el || !doc || !dv) continue;
			const isPopout = doc !== window.document;
			const kind = isPopout
				? "popout"
				: el.closest(".mod-left-split")
					? "sidebar-left"
					: el.closest(".mod-right-split")
						? "sidebar-right"
						: "main-area";
			const root = doc.querySelector<HTMLElement>(".semlink-settings-root");
			const rootW = root ? root.getBoundingClientRect().width : -1;
			const bp = rootW < 0 ? null : rootW <= 480 ? "narrow" : rootW <= 720 ? "mid" : "wide";
			const r = el.getBoundingClientRect();
			out.push({
				kind,
				viewport: { w: dv.innerWidth, h: dv.innerHeight },
				outer: { w: dv.outerWidth, h: dv.outerHeight },
				dpr: dv.devicePixelRatio,
				docTitle: doc.title,
				viewRect: { w: Math.round(r.width), h: Math.round(r.height) },
				settingsRootW: Math.round(rootW),
				breakpoint: bp,
				settingsScreenActive: !!doc.querySelector(".semlink-search-view.semlink-settings-active"),
				// 屏幕切换 breadcrumbs：设置屏幽灵自愈路径的取证（谁把它关了）
				trace: (leaf.view as unknown as { screenTrace?: string[] }).screenTrace?.slice(-25) ?? null,
			});
		}
		return out;
	}

	private async runDebugShot(opts?: { target?: string | number; resize?: { index?: number; width: number; height: number } }): Promise<unknown> {
		interface ElectronWindowLike {
			isDestroyed(): boolean;
			getTitle(): string;
			getBounds(): { x: number; y: number; width: number; height: number };
			setBounds?(bounds: { x: number; y: number; width: number; height: number }): void;
			webContents: {
				capturePage(): Promise<{ toPNG(): Uint8Array; getSize(): { width: number; height: number } }>;
				getZoomFactor(): number;
			};
		}
		try {
			const req = (window as unknown as { require?: (m: string) => unknown }).require;
			if (!req) return { error: "renderer require unavailable" };
			const electron = req("electron") as
				| { remote?: { BrowserWindow: { getAllWindows(): ElectronWindowLike[] } } }
				| undefined;
			const remote = electron?.remote;
			if (!remote) return { error: "electron remote unavailable (Obsidian remote not initialized)" };
			const fsMod = req("fs") as { mkdirSync(d: string, o?: { recursive?: boolean }): void; writeFileSync(f: string, d: Uint8Array): void };
			const osMod = req("os") as { tmpdir(): string };
			const pathMod = req("path") as { join(...p: string[]): string };
			const dir = pathMod.join(osMod.tmpdir(), "semlink-debug-shots");
			fsMod.mkdirSync(dir, { recursive: true });

			const all = remote.BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.getBounds().width > 0);
			if (all.length === 0) return { error: "no windows found" };
			// 可选：截图前先改窗口尺寸（moveLeafToPopout 有 600px 最小宽，
			// 窄幅 (<480 容器) 走查只能靠 Electron setBounds 绕过）。
			if (opts?.resize) {
				const idx = typeof opts.resize.index === "number" ? opts.resize.index : 0;
				const w = all[idx];
				if (w?.setBounds) {
					const b = w.getBounds();
					w.setBounds({ x: b.x, y: b.y, width: opts.resize.width, height: opts.resize.height });
					await new Promise((r) => window.setTimeout(r, 500));
				}
			}
			let targets = all;
			if (typeof opts?.target === "number") {
				targets = [all[opts.target]].filter(Boolean);
				if (targets.length === 0) return { error: `window index ${opts.target} out of range (${all.length} windows)` };
			}

			const shots: Array<{ file: string; title: string; bounds: { x: number; y: number; width: number; height: number }; pixels: { width: number; height: number } }> = [];
			for (let i = 0; i < targets.length; i++) {
				const w = targets[i];
				const img = await w.webContents.capturePage();
				const safe = (w.getTitle() || "window").replace(/[\\/:*?"<>|]/g, "_").slice(0, 24);
				const file = pathMod.join(dir, `shot${i}_${safe}.png`);
				fsMod.writeFileSync(file, img.toPNG());
				const size = img.getSize();
				shots.push({ file, title: w.getTitle(), bounds: w.getBounds(), pixels: size });
			}
			return { dir, count: shots.length, shots };
		} catch (e) {
			return { error: e instanceof Error ? e.message : String(e) };
		}
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

	/** 获焦对账上次触发时间（节流用）。 */
	private lastFocusReconcile = 0;

	/** 静默对账：mtime 增量全扫（scanVault），未变更文件零成本跳过，只有
	 *  新增/变更文件真正分块嵌入。兜住 watcher 收不到的事件——Obsidian
	 *  关闭或插件重载窗口期间的外部写入、后台窗口期间 Obsidian 尚未察觉
	 *  的外部新建（这类文件不进 vault.getMarkdownFiles，手动“开始索引”
	 *  同样看不见）。与 watcher 共用 autoIndex 开关；调度器运行中自动让路。 */
	private setupSilentReconcile() {
		this.lastFocusReconcile = Date.now();
		// 获焦对账：Obsidian 在窗口获焦时才把外部变更纳入文件清单，此时对账
		// 恰好能看到刚被察觉的文件。节流 ≥5 分钟一次。
		this.registerDomEvent(window, "focus", () => {
			if (!this.settings.autoIndex) return;
			const now = Date.now();
			if (now - this.lastFocusReconcile < 5 * 60 * 1000) return;
			this.lastFocusReconcile = now;
			this.startFullIndex();
		});
		// 启动对账：等 watcher 5s 宽限期与启动风暴过去后再跑一次。
		this.registerInterval(window.setTimeout(() => {
			if (this.settings.autoIndex) this.startFullIndex();
		}, 8000));
	}

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

	/** Reveal (or create) the semantic-search view in the right sidebar.
	 *  主区域标签页里可能也存在一个同类型实例（新标签页主页）：已有侧栏
	 *  实例时优先聚焦侧栏，两者皆无才在右栏新建；返回实际聚焦的 leaf。 */
	async activateSearchView(): Promise<WorkspaceLeaf | null> {
		const { workspace } = this.app;
		const leaves = workspace.getLeavesOfType(SEARCH_VIEW_TYPE);
		// 已有实例时优先聚焦侧栏里的那个（containerEl 不在公开类型上，运行时存在）
		let leaf: WorkspaceLeaf | null =
			leaves.find((l) => (l as unknown as { containerEl: HTMLElement }).containerEl
				.closest(".mod-right-split") !== null) ?? leaves[0] ?? null;
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
		return leaf ?? null;
	}

	/** 打开侧栏并进入对应的配置引导：chat = 对话目录（首次引导同款），
	 *  embed = 嵌入专用目录（RAG 页「开始配置」），选完模型即触发索引。 */
	async openSetupGuide(kind: "chat" | "embed" = "chat"): Promise<void> {
		const leaf = await this.activateSearchView();
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
