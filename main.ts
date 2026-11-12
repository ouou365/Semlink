// ========================================
// Semlink - Plugin Entry Point
// ========================================

import { Notice, Plugin, FileSystemAdapter, WorkspaceLeaf, WorkspaceSidedock, addIcon, MarkdownView, TFile } from "obsidian";
import { readFileSync, writeFileSync } from "fs";
import { debugLog, setDebugLogging } from "./src/log";
import { join } from "path";
import { DEFAULT_SETTINGS, activeEmbeddingProvider, mergeDuplicateProviders, migrateEmbeddingSettings, type SmartVaultSettings, type HistoryMessage } from "./src/types";
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
	/** RAG 统计快照：启动 DB 就绪后播种（与状态栏同一趟查询）、索引完成
	 *  回写、设置页成功查询写透——三处均同步落盘 data/rag-stats-cache.json
	 *  （persistRagStatsCache），重启后 loadRagStatsCacheFromDisk 预载，
	 *  状态栏/设置页首帧直出、不等 DB 往返；后台查询照跑纠偏，快照最多
	 *  滞后一轮。updatedMs = meta.last_index_activity（更新时间格，用户
	 *  拍板「Updated 的时间没有缓存」——同样要首帧直出）。 */
	ragStatsCache: { indexedNotes: number; embeddedNotes: number; skippedNotes: number; updatedMs: number | null; ready: boolean } = {
		indexedNotes: 0,
		embeddedNotes: 0,
		skippedNotes: 0,
		updatedMs: null,
		ready: false,
	};
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
	/** ragStatsCache 的进度事件节流戳：索引运行期间也保持快照新鲜
	 *  （弹窗/引导的实时缓存回退都吃它，见 showProgressModal/onboarding）。 */
	private lastRagCacheRefresh = 0;

	/** 上次清理索引时用的排除规则（saveSettings 里比对，规则变了才重跑 purge）。 */
	private lastPurgedExcludePaths = "";

	async onload() {
		// [启动性能面包屑] 各阶段耗时累积，onload 后 8s 由静默对账定时器
		// 落盘 data/boot-perf.json——「Loading plugins 变久」的远程取证通道
		// （最后一条 mark = 卡点；正常启动整表可读）。
		const bootT0 = Date.now();
		const bootMarks: Array<{ at: string; ms: number }> = [];
		const bootMark = (label: string): void => {
			bootMarks.push({ at: label, ms: Date.now() - bootT0 });
		};
		bootMark("onload-enter");
		await this.loadSettings();
		bootMark("loadSettings");
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

		// [快照首帧] 预载上一会话的 RAG 统计快照（persistRagStatsCache 落盘）：
		// 状态栏/设置页/弹窗首帧立即直出，不等 DB 往返——启动后 worker 被
		// 任务链占住，首批查询排队分钟级（真机 2026-11-12「打开 Vault 很久
		// 才显数值」）。索引只在 Obsidian 运行中发生，正常退出时的快照近乎
		// 精确；崩溃丢的尾巴由 DB 就绪后的写透静默纠偏。
		this.loadRagStatsCacheFromDisk();

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
		bootMark("worker-script-read");
		this.store = new VectorStore(dataDir, browserWorkerUrl);
		// 向量搜索总开关（设置页 RAG 标签）：实时读设置，关掉即全部语义检索返回空
		// 向量搜索可用性 = 嵌入模型已配置（无独立开关）
		this.store.searchGate = () => activeEmbeddingProvider(this.settings).apiKey.trim() !== "";
		await this.store.init();
		bootMark("store.init");
		// 一次性回填 embed_skips（embed_skips 上线前已完成索引的全稀疏笔记
		// 等不到重索引、也产生不了向量——嵌入进度永远差几个点，如真机的
		// 974/980=99.4%）。幂等、候选集趋近空集，后台跑不阻塞启动。
		void this.store
			.backfillEmbedSkips()
			.then((n) => {
				if (n > 0) debugLog(`[Semlink] embed skips backfilled: ${n} notes`);
			})
			.catch((e) => console.warn("[Semlink] embed skip backfill failed:", e));

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
		this.watcher = new VaultWatcher(this.app, this.scheduler, this.settings, () => this.store.getAllIndexedPaths());
		this.watcher.start(this.settings.autoIndex);
		this.setupSilentReconcile();
		bootMark("watcher+reconcile-setup");

		// [启动性能面包屑] onload 后 8s 落盘 data/boot-perf.json（此时 onload
		// 必已结束；若仍在 store.init，最后一条 mark 即卡点）。
		window.setTimeout(() => {
			try {
				const req = (window as unknown as { require?: (m: string) => unknown }).require;
				const fsMod = req?.("fs") as { writeFileSync(p: string, d: string): void } | undefined;
				fsMod?.writeFileSync(
					join(dataDir, "boot-perf.json"),
					// onloadMs = 最后一条 mark 的时刻：onload-done 已打即 onload
					// 完成耗时；8s 写盘时 onload 若仍未结束，最后一条 mark 就是
					// 卡点（取证语义）。旧版 totalMs 用定时器触发时刻（恒 ≈8s+），
					// 会被误读成「插件加载 9.4s」。
					JSON.stringify({
						onloadDone: bootMarks.some((m) => m.at === "onload-done"),
						onloadMs: bootMarks.length > 0 ? bootMarks[bootMarks.length - 1].ms : -1,
						writtenAtMs: Date.now() - bootT0,
						marks: bootMarks,
					}, null, 1),
				);
			} catch { /* 取证失败不影响主流程 */ }
		}, 8000);

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
		// 数量首帧直出持久化快照（用户拍板「打开 Vault 很久才显数值」）：
		// 预载快照已就绪则立即显示，DB 就绪后 updateInitialStatusBar 纠偏。
		if (this.ragStatsCache.ready) {
			const count = this.statusBarEl.querySelector(".status-count");
			if (count) {
				count.textContent = `${this.ragStatsCache.embeddedNotes + this.ragStatsCache.skippedNotes} ${t("statusIndexed")}`;
			}
		}
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
				// 完成即回写 RAG 统计快照：索引/删除/重分块后设置页打开
				// 就是新值（fire-and-forget，失败等下一个播种点）。
				void this.refreshRagStatsCache();
			} else if (event.type === "progress") {
				const now = Date.now();
				if (now - this.lastStatusBarUpdate >= 500) {
					this.lastStatusBarUpdate = now;
					this.updateStatusBar(event.progress);
				}
				// 索引运行期间节流回写 RAG 统计快照（≥5s 一次）：进度弹窗的
				// 覆盖率回退与引导杯的分子播种都靠它当实时缓存——以前只在
				// 完成/设置页写透时刷新，运行中缓存一直陈旧。
				if (now - this.lastRagCacheRefresh >= 5000) {
					this.lastRagCacheRefresh = now;
					void this.refreshRagStatsCache();
				}
			}
		});

		// Show initial status bar with existing index data
		bootMark("pre-updateInitialStatusBar");
		// 不阻塞 onload：getStats 在数万 chunk 的库上要数秒（冷启动 SAH
		// 冷读 + COUNT 全扫），await 会把「Loading plugins」拖住——状态栏
		// 元素已就位，数字就绪后自行填充（真机 2026-11-12 启动卡 8s+ 根因）。
		void this.updateInitialStatusBar();
		bootMark("updateInitialStatusBar(fired)");

		// Start MCP server：默认开启；用户手动关闭后（mcpEnabled=false）保持关闭
		if (this.settings.mcpEnabled !== false) {
			await this.startMcpServer();
		}
		bootMark("mcp-server");

		// 调试问答服务（semlink-debug）：ask 单工具，端到端跑真实问答管线，
		// 供 ZCode 等 agent 回归测试。仅监听 127.0.0.1（会触发真实 LLM 调用）。
		if (this.settings.debugMcpEnabled === true) {
			await this.startDebugMcpServer();
		}
		bootMark("debug-server");

		// Register settings tab
		this.addSettingTab(new SmartVaultSettingTab(this.app, this));

		// One-shot OPFS feasibility spike (browser Worker + OPFS in the real
		// app:// renderer). Runs once; skips after a result file exists.
		{
			const resultPath = this.app.vault.configDir + "/plugins/" + this.manifest.id + "/opfs-spike-result.json";
			const already = await this.app.vault.adapter.exists(resultPath).catch(() => false);
			if (!already) void runOpfsSpike(this.app, this.manifest.id);
		}

		// Start any enabled Feishu bots. 不阻塞 onload——start() 首步是
		// await verifyFeishuApp()：到 open.feishu.cn 的 HTTPS 往返，网络
		// 一慢「Loading plugins」被整段拖住（真机 2026-11-12 启动慢根因
		// 之一）。机器人是后台长连接，失败已有 scheduleRetry + 状态回调兜底。
		bootMark("feishu-bots(kick)");
		void this.syncFeishuBots()
			.catch((e) => console.warn("[Semlink] Feishu bots sync failed:", e))
			.then(() => bootMark("feishu-bots-done"));

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

		// Update initial status bar：onload 前段（updateInitialStatusBar(fired)）
		// 已 fire-and-forget，这里不再重复 await——真机 2026-11-12 启动慢根因
		// 之一：getStats + 两个 COUNT 在数万 chunk 的冷库上要数秒，await 把
		// onload 尾巴拖住且旧面包屑停在 mcp-server 完全不可见。
		bootMark("onload-done");
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
		// 同一公司的对话/嵌入实例合并（用户："一个配的是对话，一个配的是
		// 嵌入，其实应该合在一起"）——同 apiBase 双实例曾是两个列表行
		mergeDuplicateProviders(this.settings);
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
			(opts) => this.runDebugStats(opts),
			(opts) => this.runDebugUi(opts),
			(opts) => this.runDebugOpfs(opts),
			() => ({ ...this.store.rpcDiag(), arrival: this.watcher?.lastArrivalDiag ?? null }),
			(opts) => this.runDebugModel(opts),
			() => this.runDebugChatView(),
		);
		try {
			await server.start();
			this.debugMcpServer = server;
			debugLog(`[Semlink] debug MCP listening on http://127.0.0.1:${server.port}/mcp`);
		} catch (e) {
			console.warn("[Semlink] debug MCP failed to start:", e);
		}
	}

	/** stats 工具执行器：RAG 卡四格（Indexed/Embedded/Skipped/Excluded）+
	 *  块统计 + 进度弹窗卡片全字段 + 队列诊断——免截图直接读索引卡片
	 *  数值。op="save"/"compact" 触发补救动作（全量导出有成本，慢库
	 *  慎用；compact 适合刚重载、库还在磁盘尺寸时跑一次）。 */
	private async runDebugStats(opts?: { op?: string }): Promise<unknown> {
		const op = opts?.op?.toLowerCase();
		if (op === "noteprobe") {
			// [诊断] 按路径查单篇索引状态 + 登记状态——「这篇为什么没嵌入」
			// 一发即知：registered=false = Obsidian 未登记（获焦登记/等待
			// 外部落盘轮询）；registered=true 且 chunks=0 = 已登记未索引
			// （队列/排除规则问题）。
			const path = (opts as { path?: string })?.path ?? "";
			if (!path) return { op, error: "path required" };
			const probe = await this.store.noteProbe(path);
			const abstract = this.app.vault.getAbstractFileByPath(path);
			const fileStat = abstract instanceof TFile
				? { size: abstract.stat.size, mtime: abstract.stat.mtime }
				: null;
			return {
				op,
				path,
				registered: abstract instanceof TFile,
				file: fileStat,
				index: probe,
				stale: fileStat != null && probe.maxMtime != null && fileStat.mtime > probe.maxMtime,
			};
		}
		if (op === "save" || op === "compact") {
			const t0 = Date.now();
			try {
				if (op === "compact") await this.store.compact();
				else await this.store.save();
				return { op, done: true, durationMs: Date.now() - t0 };
			} catch (e) {
				return { op, done: false, error: e instanceof Error ? e.message : String(e), durationMs: Date.now() - t0 };
			}
		}
		if (op === "resetopfsdb") {
			try {
				const r = await this.store.resetOpfsDb();
				return { op, ...r, note: "reload now — seedDb will re-seed OPFS from the disk vault.db" };
			} catch (e) {
				return { op, error: e instanceof Error ? e.message : String(e) };
			}
		}
		if (op === "repairfrombak") {
			// 槽名错位事故修复通道：pre-wasm.bak（迁移前完整旧索引）原地
			// 导入 canonical 槽。force=true 时活库非空也覆盖。
			try {
				const r = await this.store.repairFromBak((opts as { force?: boolean })?.force === true);
				return { op, ...r };
			} catch (e) {
				return { op, error: e instanceof Error ? e.message : String(e) };
			}
		}
		if (op === "seedfromdisk") {
			// 恢复通道：把插件目录 data/vault.db（真磁盘化石，523MB 完整
			// 旧索引）强制播种进 shim 命名空间；重载后迁移通道自动导入。
			try {
				const req = (window as unknown as { require?: (m: string) => unknown }).require;
				const fsMod = req?.("fs") as { readFileSync(p: string): { buffer: ArrayBuffer } } | undefined;
				const p = this.pluginDir + "/data/vault.db";
				const raw = fsMod?.readFileSync(p);
				if (!raw) return { op, error: "cannot read data/vault.db" };
				const r = await this.store.seedFromBytes(new Uint8Array(raw.buffer));
				return { op, ...r, note: "reload now — the migration imports it" };
			} catch (e) {
				return { op, error: e instanceof Error ? e.message : String(e) };
			}
		}
		if (op === "auditlog") {
			// 黑匣子回读：chunks 删除现场（时间 + 剩余行数）
			try {
				const r = await this.store.auditLog();
				return { op, audit: r };
			} catch (e) {
				return { op, error: e instanceof Error ? e.message : String(e) };
			}
		}
		if (op === "durability") {
			// 持久化取证：journal/synchronous 实际生效值 + flushed 槽字节数 vs
			// 引擎整库字节数——差值 = 未落盘窗口（reload/杀进程丢数据对账）。
			try { return { op, ...(await this.store.durability() as Record<string, unknown>) }; }
			catch (e) { return { op, error: e instanceof Error ? e.message : String(e) }; }
		}
		if (op === "snapshot") {
			// 立即写一次耐久快照并带回错误详情（writeLegacySnapshot 一直静默失败，
			// 这里把 worker 里的异常带出来定位根因）。
			try { return { op, ...(await this.store.snapshotNow() as Record<string, unknown>) }; }
			catch (e) { return { op, error: e instanceof Error ? e.message : String(e) }; }
		}
		if (op === "dumpslot") {
			// 法证通道：主线程直读 sahpool 槽文件（getFile 跨 agent cluster 可用）
			// 字节落真磁盘，供离线 python-sqlite3 检查——完全绕开引擎，看「flushed
			// 槽里到底有什么」。槽文件布局 = 4KB sahpool 头（前 512B = 关联路径
			// 字符串）+ SQLite 镜像；这里按路径头精确选中 /vault.db 的槽。
			try {
				const root = await navigator.storage.getDirectory();
				const opaque = await root.getDirectoryHandle(".opfs-sahpool").then((d) => d.getDirectoryHandle(".opaque"));
				let target: { name: string; size: number } | null = null;
				const slots: Array<{ name: string; path: string; size: number }> = [];
				for await (const [name, handle] of opaque.entries()) {
					if (handle.kind !== "file") continue;
					const f = await (handle as FileSystemFileHandle).getFile();
					const head = new Uint8Array(await f.slice(0, 520).arrayBuffer());
					let path = "";
					for (let i = 0; i < 512 && head[i]; i++) path += String.fromCharCode(head[i]);
					slots.push({ name, path, size: f.size });
					if (path === "/vault.db") target = { name, size: f.size };
				}
				if (!target) return { op, error: "no slot with path /vault.db under .opfs-sahpool/.opaque", slots };
				const fh = await opaque.getFileHandle(target.name);
				const buf = await (await fh.getFile()).arrayBuffer();
				const req = (window as unknown as { require?: (m: string) => unknown }).require;
				const fsMod = req?.("fs") as { writeFileSync(p: string, d: Buffer): void; mkdirSync(p: string, o?: unknown): void } | undefined;
				if (!fsMod) return { op, error: "no fs" };
				const dir = this.pluginDir + "/diag";
				try { fsMod.mkdirSync(dir); } catch { /* 已存在 */ }
				const out = dir + "/slot.bin";
				fsMod.writeFileSync(out, Buffer.from(buf));
				return { op, slot: target.name, size: target.size, dumpedBytes: buf.byteLength, out };
			} catch (e) {
				return { op, error: e instanceof Error ? e.message : String(e) };
			}
		}
		if (op) return { error: `unknown op "${op}" (save | compact | resetOpfsDb | repairFromBak | seedFromDisk | auditLog | durability | snapshot | dumpslot)` };
		const stats = await this.store.getStats();
		// 存储模式诊断：空索引 + 大磁盘库 = 上游加载失败（worker 初始化
		// 失败掉进 browser-worker/sync 空库、或加载抛错）——定位「索引清零」。
		let diskDbSizeMb: number | null = null;
		try {
			const req2 = (window as unknown as { require?: (m: string) => unknown }).require;
			const fsMod = req2?.("fs") as { statSync(p: string): { size: number } } | undefined;
			if (fsMod) diskDbSizeMb = Math.round(fsMod.statSync(this.pluginDir + "/data/vault.db").size / 1048576);
		} catch { /* 文件不存在等 */ }
		const [embedded, skipped, queue, vectorlessTotal, vectorlessSample, queueDiag] = await Promise.all([
			this.store.getEmbeddedNoteCount(),
			this.store.getEmbedSkippedNoteCount(),
			this.scheduler.queueCounts(),
			this.store.countVectorlessNotes(),
			this.store.listVectorlessNotes(8),
			this.store.queueDiagnostics(),
		]);
		const indexable = this.scheduler.countIndexableNotes();
		const vaultMd = this.app.vault.getMarkdownFiles().length;
		const excluded = Math.max(0, vaultMd - indexable);
		const p = this.progress.current;
		return {
			storage: {
				mode: this.store.storageMode,
				nodeWorkerError: this.store.lastNodeWorkerError,
				browserWorkerError: this.store.lastBrowserWorkerError,
				diskDbSizeMb,
				memoryChunks: stats.totalChunks,
				// 空内存库 + 大磁盘库 = 加载失败（空库保险丝会拒绝 save 覆盖）
				loadMismatch: stats.totalChunks === 0 && (diskDbSizeMb ?? 0) > 100,
				// browser-worker 模式：OPFS 命名空间清单 + SQLite 头探测——
				// 确认原索引还在命名空间里可救、判断是「被清空」还是「加载失败」。
				opfs: this.store.storageMode === "browser-worker"
					? {
						files: await this.store.fsList().catch((e) => ({ error: String(e) })),
						probe: await this.store.fsProbe().catch((e) => ({ error: String(e) })),
					}
					: undefined,
			},
			cells: {
				indexed: stats.indexedNotes,
				embedded,
				skipped,
				excluded,
			},
			denominator: {
				indexable,
				vaultMdFiles: vaultMd,
			},
			chunks: {
				total: stats.totalChunks,
				active: stats.activeChunks,
				embedded: stats.embeddedChunks,
			},
			run: {
				phase: p.phase,
				processed: p.processedNotes,
				totalNotes: p.totalNotes,
				isPaused: p.isPaused,
				embeddedChunks: p.embeddedChunks,
			},
			// 进度弹窗卡片（Semlink Index Progress）的全部数值：
			modal: {
				phase: p.phase,
				progress: `${p.totalNotes > 0 ? Math.min(p.processedNotes, p.totalNotes) : p.processedNotes} / ${p.totalNotes}`,
				embeddedChunks: p.embeddedChunks,
				failedChunks: p.failedChunks,
				skippedChunks: p.skippedChunks,
				currentFile: p.currentFile || null,
				activeFiles: p.activeFiles,
				fileChunkProgress: p.fileChunkProgress || null,
				avgResponseMs: p.avgResponseMs,
				network: p.networkStatus,
				consecutiveFailures: p.consecutiveFailures,
				backoffRemainingSec: p.backoffRemainingSec,
				lastError: p.lastError || null,
				isPaused: p.isPaused,
				isAutoPaused: p.isAutoPaused,
				startedAt: p.startedAt || null,
				etaSec: p.estimatedRemainingSec,
				hnswNodeCount: p.hnswNodeCount,
				dbSizeMb: p.dbSizeMb,
			},
			queue,
			// 队列深诊断：pending 残留行（跨重载存活，扫描只清
			// completed/failed）、同一笔记多条 pending（反复入队证据）、
			// 最老 pending 年龄。
			queueDiag,
			// 整篇无向量的笔记（稀疏块无向量是设计行为，整篇无向量才可疑
			// ——「一直嵌入」可能由反复补嵌这些笔记驱动）。
			vectorless: {
				total: vectorlessTotal,
				sample: vectorlessSample,
			},
			// 静默对账（setupSilentReconcile）状态：获焦/启动都会触发全量
			// 扫描——「无新文档却一直索引」先看这里的触发节奏。
			reconcile: {
				autoIndex: this.settings.autoIndex,
				lastFocusReconcileAt: this.lastFocusReconcile || null,
				lastFocusReconcileAgoSec: this.lastFocusReconcile ? Math.round((Date.now() - this.lastFocusReconcile) / 1000) : null,
				schedulerBusy: this.scheduler.isRunning,
				// phase 停在 running 集合但 busy=false = 进度条残留态
				phaseIsStale: !this.scheduler.isRunning && ["scanning", "chunking", "embedding", "building_index"].includes(p.phase),
			},
			pendingSample: await this.scheduler.debugPendingMtimeSample(),
		};
	}

	/** opfs 工具执行器：主线程直读 OPFS（不依赖 DB worker 存活——worker
	 *  死掉/加载失败时 stats 可能失真，这里看真实落盘状态）：storage.estimate
	 *  配额用量、persisted 持久化标记、整树递归清单（可读文件带 size/
	 *  lastModified；被 sync access handle 占用的文件——sahpool 槽与 fs-shim
	 *  命名空间——DOM 规范拒绝 getFile，报 locked:true），按顶层命名空间
	 *  聚合小计。semlink-db/vault.db 的 lastModified = 最近一次耐久快照时刻。 */
	private async runDebugOpfs(opts?: { maxDepth?: number; maxEntries?: number }): Promise<unknown> {
		const maxDepth = Math.max(1, Math.min(10, Math.floor(opts?.maxDepth ?? 5)));
		const maxEntries = Math.max(10, Math.min(2000, Math.floor(opts?.maxEntries ?? 300)));
		// OPFS 句柄结构类型：项目 DOM lib 早于 entries()/getFile 的完整声明
		// （同 browser-fs.ts 的做法），本地声明 + unknown 断言（禁 any）。
		interface OpfsFileHandle { kind: "file"; getFile(): Promise<{ size: number; lastModified: number }>; }
		interface OpfsDirHandle { kind: "directory"; entries(): AsyncIterableIterator<[string, OpfsFileHandle | OpfsDirHandle]>; }
		interface OpfsNode {
			name: string;
			kind: "file" | "directory";
			size?: number;
			lastModified?: number;
			locked?: boolean;
			error?: string;
			children?: OpfsNode[];
		}

		let root: OpfsDirHandle;
		try {
			root = (await navigator.storage.getDirectory()) as unknown as OpfsDirHandle;
		} catch (e) {
			return { available: false, error: `OPFS unavailable: ${e instanceof Error ? e.message : String(e)}` };
		}

		let dirs = 0, files = 0, readableBytes = 0, lockedFiles = 0, truncated = false;
		const namespaces = new Map<string, { files: number; readableBytes: number; lockedFiles: number }>();

		const walk = async (dir: OpfsDirHandle, depth: number, ns: string | null): Promise<OpfsNode[]> => {
			const out: OpfsNode[] = [];
			try {
				for await (const [name, handle] of dir.entries()) {
					if (out.length >= maxEntries) { truncated = true; break; }
					const childNs = ns ?? name; // 第一层目录名 = 命名空间（semlink-db / .opfs-sahpool）
					if (handle.kind === "directory") {
						dirs++;
						const node: OpfsNode = { name, kind: "directory" };
						if (depth < maxDepth) node.children = await walk(handle as OpfsDirHandle, depth + 1, childNs);
						else truncated = true;
						out.push(node);
						continue;
					}
					files++;
					const agg = namespaces.get(childNs) ?? { files: 0, readableBytes: 0, lockedFiles: 0 };
					agg.files++;
					namespaces.set(childNs, agg);
					const node: OpfsNode = { name, kind: "file" };
					try {
						const f = await (handle as OpfsFileHandle).getFile();
						node.size = f.size;
						node.lastModified = f.lastModified;
						readableBytes += f.size;
						agg.readableBytes += f.size;
					} catch {
						// sync access handle 被活的 DB worker 持有（sahpool 槽、
						// fs-shim 文件）：同文件不允许再开/读——只报 locked。
						node.locked = true;
						lockedFiles++;
						agg.lockedFiles++;
					}
					out.push(node);
				}
			} catch (e) {
				out.push({ name: "<entries>", kind: "directory", error: e instanceof Error ? e.message : String(e) });
			}
			return out;
		};

		const tree = await walk(root, 1, null);
		let estimate: unknown = null, estimateError: string | undefined;
		try { estimate = await navigator.storage.estimate(); } catch (e) { estimateError = e instanceof Error ? e.message : String(e); }
		let persisted: boolean | null = null;
		try { persisted = await navigator.storage.persisted(); } catch { /* 不支持/未授权：保持 null */ }

		return {
			available: true,
			// 对照位：wasm = sahpool 槽被驱动持有（locked 属正常）；browser-worker
			// = fs-shim 命名空间被持有。worker 死掉时 locked 应全消失。
			storageMode: this.store.storageMode,
			estimate,
			estimateError,
			persisted,
			tree,
			totals: { directories: dirs, files, readableBytes, lockedFiles, truncated },
			namespaces: Object.fromEntries(namespaces),
			legend: "locked:true = file held by an open sync access handle in the live DB worker (opfs-sahpool slots / semlink-db fs-shim files) — spec refuses getFile() from other contexts, size invisible here. readableBytes sums readable files only; estimate.usage is the authoritative OPFS footprint. semlink-db/vault.db lastModified = last durable snapshot moment.",
		};
	}

	/** model 工具执行器：查询/切换/添加/移除对话模型。get 返回当前模型与
	 *  全部可选项；switch 走 chatClient.setActiveModel（落盘 activeChatModel）；
	 *  add/remove 直接改 settings.providers[].models（kind=chat、enabled=true）
	 *  后 saveSettings + chatClient.updateSettings 强制重同步——被移除的是
	 *  当前模型时选择自动回落到该供应商第一个可用模型。 */
	private async runDebugModel(opts?: {
		op?: string;
		provider?: string;
		model?: string;
		contextWindow?: number;
	}): Promise<unknown> {
		const op = (opts?.op ?? "get").toLowerCase();
		const findProvider = (needle?: string) => {
			const n = (needle ?? "").trim().toLowerCase();
			if (!n) return null;
			return this.settings.providers.find((p) => p.id.toLowerCase() === n)
				?? this.settings.providers.find((p) => p.name.toLowerCase().includes(n))
				?? this.settings.providers.find((p) => p.id.toLowerCase().includes(n))
				?? null;
		};
		const snapshot = () => ({
			active: (() => {
				const a = this.chatClient.getActiveModel();
				return a ? { providerId: a.provider.id, providerName: a.provider.name, model: a.model.id, contextWindow: a.model.contextWindow, apiFormat: a.provider.apiFormat ?? "openai", endpoint: a.provider.baseUrl + (a.provider.wirePath ?? "") } : null;
			})(),
			label: this.chatClient.getActiveModelLabel(),
			options: this.chatClient.getModelOptions().map((g) => ({
				providerId: g.providerId,
				providerName: g.providerName,
				models: g.models.map((m) => m.id),
			})),
		});

		if (op === "get" || op === "list") {
			const snap = snapshot();
			return op === "get" ? snap : { options: snap.options };
		}
		if (op === "switch") {
			const provider = findProvider(opts?.provider);
			if (!provider) return { op, error: `provider not found: "${opts?.provider}"`, available: this.settings.providers.map((p) => ({ id: p.id, name: p.name })) };
			const needle = (opts?.model ?? "").trim().toLowerCase();
			if (!needle) return { op, error: "model is required for switch" };
			const model = provider.models.find((m) => (m.kind ?? "chat") === "chat" && m.enabled === true && m.id.toLowerCase() === needle)
				?? provider.models.find((m) => (m.kind ?? "chat") === "chat" && m.enabled === true && m.id.toLowerCase().includes(needle));
			if (!model) return { op, error: `chat model not found in "${provider.name}": "${opts?.model}"`, models: provider.models.filter((m) => (m.kind ?? "chat") === "chat" && m.enabled === true).map((m) => m.id) };
			const ok = this.chatClient.setActiveModel(provider.id, model.id);
			if (!ok) return { op, error: "setActiveModel returned false" };
			await this.saveSettings();
			return { op, done: true, ...snapshot() };
		}
		if (op === "add") {
			const provider = findProvider(opts?.provider);
			if (!provider) return { op, error: `provider not found: "${opts?.provider}"`, available: this.settings.providers.map((p) => ({ id: p.id, name: p.name })) };
			const id = (opts?.model ?? "").trim();
			if (!id) return { op, error: "model id is required for add" };
			if (provider.models.some((m) => m.id === id)) return { op, error: `model "${id}" already exists in "${provider.name}"`, models: provider.models.map((m) => m.id) };
			provider.models.push({ id, contextWindow: Math.max(4096, Math.floor(opts?.contextWindow ?? 128000)), kind: "chat", enabled: true });
			await this.saveSettings();
			this.chatClient.updateSettings(this.settings);
			return { op, done: true, provider: provider.name, added: id, models: provider.models.filter((m) => (m.kind ?? "chat") === "chat").map((m) => m.id) };
		}
		if (op === "remove") {
			const provider = findProvider(opts?.provider);
			if (!provider) return { op, error: `provider not found: "${opts?.provider}"`, available: this.settings.providers.map((p) => ({ id: p.id, name: p.name })) };
			const needle = (opts?.model ?? "").trim().toLowerCase();
			if (!needle) return { op, error: "model id is required for remove" };
			const before = provider.models.length;
			provider.models = provider.models.filter((m) => m.id.toLowerCase() !== needle);
			if (provider.models.length === before) return { op, error: `model not found in "${provider.name}": "${opts?.model}"`, models: provider.models.map((m) => m.id) };
			await this.saveSettings();
			// 强制重同步：被移除的是当前模型时 activeChatModel 失效，回落
			// 到该供应商第一个可用模型（syncPersistedModel 语义）。
			this.chatClient.updateSettings(this.settings);
			return { op, done: true, provider: provider.name, removed: opts?.model, ...snapshot() };
		}
		return { error: `unknown op "${op}" (get | list | switch | add | remove)` };
	}

	/** chatview 工具执行器：读侧栏聊天视图的实时 DOM 状态——状态头、
	 *  思考预览（滑动尾窗）、流式正文（长度 + 全文，重复调用可看出打字机
	 *  生长曲线）、最近一条已完成的答案全文。取的是用户实际看到的东西，
	 *  比截图便宜、比内部状态真实。 */
	private async runDebugChatView(): Promise<unknown> {
		const leaves = this.app.workspace.getLeavesOfType(SEARCH_VIEW_TYPE);
		const view = leaves[0]?.view as SemanticSearchView | undefined;
		const root = view?.contentEl;
		if (!root) return { viewFound: false };
		const text = (sel: string): string | null => root.querySelector(sel)?.textContent ?? null;
		const streamEl = root.querySelector(".semlink-msg-stream");
		const streaming = !!streamEl && !streamEl.hasClass("semlink-hidden");
		const streamText = streaming ? text(".semlink-msg-stream .semlink-msg-answer") : null;
		// 最终答案 = 不在流式容器里的最后一个 .semlink-msg-answer
		const finals = Array.from(root.querySelectorAll(".semlink-msg-answer"))
			.filter((el) => !el.closest(".semlink-msg-stream"))
			.map((el) => el.textContent ?? "").filter((t) => t.trim().length > 0);
		return {
			viewFound: true,
			model: this.chatClient.getActiveModelLabel(),
			header: text(".semlink-msg-loading-text"),
			thinking: {
				liveReasoning: text(".semlink-live-reasoning"),
				liveBodyLen: text(".semlink-thinking-live-body")?.length ?? 0,
			},
			answer: {
				streaming,
				streamLen: streamText?.length ?? 0,
				streamText,
				lastFinalLen: finals.at(-1)?.length ?? 0,
				lastFinal: finals.at(-1) ?? null,
			},
		};
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

	private async runDebugMeasure(opts?: { popout?: boolean; repro?: boolean; sessionIdx?: number; nav?: number | string; width?: number; height?: number; dock?: boolean; scrollPanel?: number; scrollConfig?: number; advClick?: boolean; keyEditClick?: boolean; keyProbeFill?: boolean; keyProbeValue?: string; keyProbeCommit?: boolean; keyKebabClick?: boolean; keySaveClick?: boolean; fmtClick?: boolean; fmtPick?: string; pickProvider?: string; drillClick?: boolean; backClick?: boolean; keyModalProbe?: boolean; keyModalClose?: boolean; variantPick?: string; epClick?: boolean; epPick?: string; ragDomProbe?: boolean; onboardOpen?: boolean; guideBackProbe?: boolean; addProviderProbe?: boolean; scrollPerf?: boolean; countProbe?: boolean; forcePro?: boolean }): Promise<unknown> {
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
					// nav 语义 = 菜单位置（用户拍板顺序：Basic 第一）
					const ids = ["general", "model", "embedding", "mcp", "share"] as const;
					const inst = (sv as unknown as {
						settingsEmbed?: { tab?: { activeTab?: string; display(reset?: boolean): void } };
					}).settingsEmbed?.tab;
					navDbg = { hadInst: !!inst, instTab: inst?.activeTab ?? null, navRaw: String(opts.nav) };
					if (inst && ids[navIdx]) {
						inst.activeTab = ids[navIdx];
						// display(false)：保留刚设置的 activeTab——无参调用会被
						// 当成"打开设置"重置回 Basic（display 的默认语义）。
						inst.display(false);
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
			// backClick：窄幅钻入态点返回箭头（头部内嵌 ‹ Google，兜底旧独立
			// 返回行），回到供应商列表（验收列表滚动条位置等列表态布局）。
			if (opts?.backClick) {
				const backLeaves = this.app.workspace.getLeavesOfType(SEARCH_VIEW_TYPE);
				for (const leaf of backLeaves) {
					const el = ((leaf as unknown as { containerEl?: HTMLElement }).containerEl
						?? (leaf.view as unknown as { containerEl?: HTMLElement }).containerEl);
					const bDoc = el?.ownerDocument;
					if (!bDoc) continue;
					const back = Array.from(
						bDoc.querySelectorAll<HTMLElement>(".semlink-mt-config-back, .semlink-mt-back"),
					).find((r) => r.offsetParent !== null);
					if (back) {
						back.click();
						break;
					}
				}
				await new Promise((r) => window.setTimeout(r, 400));
			}
			// drillClick：窄幅点第一个可见供应商行，钻入配置栏（验收窄幅
				// Key 换行等钻入态布局；宽幅点行 = 切右栏，同样无害）。
				if (opts?.drillClick) {
					const drillLeaves = this.app.workspace.getLeavesOfType(SEARCH_VIEW_TYPE);
					for (const leaf of drillLeaves) {
						const el = ((leaf as unknown as { containerEl?: HTMLElement }).containerEl
							?? (leaf.view as unknown as { containerEl?: HTMLElement }).containerEl);
						const dDoc = el?.ownerDocument;
						if (!dDoc) continue;
						const row = Array.from(dDoc.querySelectorAll<HTMLElement>(".semlink-mt-provider"))
							.find((r) => r.offsetParent !== null);
						if (row) {
							row.click();
							break;
						}
					}
					await new Promise((r) => window.setTimeout(r, 400));
				}
				// pickProvider：按名称点可见供应商行（切右栏到指定供应商——
				// 验证不同配置状态下的联动显隐）
				if (opts?.pickProvider) {
					const pickLeaves = this.app.workspace.getLeavesOfType(SEARCH_VIEW_TYPE);
					let picked: string | null = null;
					for (const leaf of pickLeaves) {
						const el = ((leaf as unknown as { containerEl?: HTMLElement }).containerEl
							?? (leaf.view as unknown as { containerEl?: HTMLElement }).containerEl);
						const dDoc = el?.ownerDocument;
						if (!dDoc) continue;
						const row = Array.from(dDoc.querySelectorAll<HTMLElement>(".semlink-mt-provider"))
							.find((r) => r.offsetParent !== null && (r.textContent ?? "").includes(opts.pickProvider as string));
						if (row) {
							row.click();
							picked = opts.pickProvider;
							break;
						}
					}
					(navDbg ??= {}).pickedProvider = picked;
					await new Promise((r) => window.setTimeout(r, 400));
				}
			// scrollConfig：滚 Model 页右栏配置表单的内部滚动容器（-1 = 滚到底）。
			// "高级选项"节在折叠线以下，收起态/展开态验收靠它。侧栏/弹窗/
			// 主区可能并存多个实例，遍历全部视图文档逐一滚动（隐藏实例的
			// scrollTop 赋值是空操作，无害）。advClick = 顺手点开高级选项头
			// （先点开再滚到底，展开的身体完整入镜）。
			if (typeof opts?.scrollConfig === "number") {
				const cfgLeaves = this.app.workspace.getLeavesOfType(SEARCH_VIEW_TYPE);
				let cfgCount = 0;
				const advProbe: Array<Record<string, unknown>> = [];
				for (const leaf of cfgLeaves) {
					const el = ((leaf as unknown as { containerEl?: HTMLElement }).containerEl
						?? (leaf.view as unknown as { containerEl?: HTMLElement }).containerEl);
					const cfgDoc = el?.ownerDocument;
					if (!cfgDoc) continue;
					const head = cfgDoc.querySelector<HTMLElement>(".semlink-mt-config-advhead");
					const body = cfgDoc.querySelector<HTMLElement>(".semlink-mt-config-advbody");
					// 只取可见实例：隐藏配置栏（窄幅未钻入 display:none）的
					// headTop 恒为 0，click/探针只会污染数据
					if (head && head.offsetParent !== null) {
						const r = head.getBoundingClientRect();
						advProbe.push({
							__doc: cfgDoc,
							text: (head.textContent ?? "").slice(0, 24),
							bodyHidden: body ? body.hasClass("semlink-hidden") : null,
							headTop: Math.round(r.top),
							// 点击后回读 + 配置栏子节顺序（验收"Key 下高级选项"位次）
							afterClickText: (head.textContent ?? "").slice(0, 24),
							afterClickBodyHidden: body ? body.hasClass("semlink-hidden") : null,
							sections: body && body.parentElement
								? Array.from(body.parentElement.children).map((c) =>
									(c.className || "").toString().replace("semlink-mt-config-", "").slice(0, 30))
								: null,
						});
						if (opts.advClick) head.click();
						advProbe[advProbe.length - 1].afterClickText = (head.textContent ?? "").slice(0, 24);
						advProbe[advProbe.length - 1].afterClickBodyHidden = body ? body.hasClass("semlink-hidden") : null;
						// fmtClick：点自绘 API Type 下拉触发钮（弹 Obsidian Menu，
						// 留给截图取证）；fmtPick 传菜单项文字则顺手点选（验证
						// 选中→落盘→触发钮文案/Endpoint 联动，随后可再点选回原值）
						if (opts.fmtClick || opts.fmtPick) {
							const sb = cfgDoc.querySelector<HTMLElement>(
								".semlink-mt-config-selectbtn",
							);
							if (sb && sb.offsetParent !== null) {
								const fp: Record<string, unknown> = {
									before: (sb.querySelector(".semlink-mt-config-selectbtn-label")?.textContent ?? "").slice(0, 20),
								};
								// HTMLElement.click() 的合成事件无坐标无 view——Obsidian
								// Menu.showAtMouseEvent 靠 clientX/Y 定位、按事件归属定
								// 弹层窗体。手工派发带真实几何与弹窗 view 的 MouseEvent。
								// dispatchEvent 里监听器的异常不会回传调用方——挂 error
								// 钩子取证（弹窗上下文里 Menu 真炸了也能看见）。
								const sbR = sb.getBoundingClientRect();
								fp.rect = { l: Math.round(sbR.left), t: Math.round(sbR.top), w: Math.round(sbR.width), h: Math.round(sbR.height) };
								const w2 = cfgDoc.defaultView as Window | null;
								const onErr = (ev: Event): void => {
									fp.handlerError = (ev as ErrorEvent).message?.slice(0, 160) ?? "error-event";
								};
								w2?.addEventListener("error", onErr);
								sb.dispatchEvent(new MouseEvent("click", {
									bubbles: true,
									cancelable: true,
									clientX: sbR.left + sbR.width / 2,
									clientY: sbR.top + sbR.height / 2,
									view: w2 ?? undefined,
								}) as MouseEvent);
								w2?.removeEventListener("error", onErr);
								// 菜单容器可能挂在本窗 body 也可能挂到主窗（程序化
								// click 的 activeWindow 归属），两处都找
								const readMenus = (): Array<{ where: string; items: string[] }> => {
									const out: Array<{ where: string; items: string[] }> = [];
									for (const [where, doc] of [["cfg", cfgDoc], ["main", window.document]] as Array<[string, Document]>) {
										const items = Array.from(doc.querySelectorAll<HTMLElement>(".menu .menu-item"))
											.map((mi) => (mi.textContent ?? "").trim().slice(0, 20));
										if (items.length > 0) out.push({ where, items });
									}
									return out;
								};
								fp.menus = readMenus();
								// 对照组：头部 kebab（先于本次改动就存在的 Menu 调用）
								// 同样的合成事件——若同样打不开，即证明是自动化局限
								const kebab = cfgDoc.querySelector<HTMLElement>(".semlink-mt-config-kebab");
								if (kebab) {
									const kbR = kebab.getBoundingClientRect();
									kebab.dispatchEvent(new MouseEvent("click", {
										bubbles: true,
										cancelable: true,
										clientX: kbR.left + kbR.width / 2,
										clientY: kbR.top + kbR.height / 2,
										view: w2 ?? undefined,
									}) as MouseEvent);
									fp.kebabMenus = readMenus();
								}
								const pickFrom = (want: string): HTMLElement | null => {
									for (const doc of [cfgDoc, window.document]) {
										const hit = Array.from(doc.querySelectorAll<HTMLElement>(".menu .menu-item"))
											.find((mi) => (mi.textContent ?? "").includes(want));
										if (hit) return hit;
									}
									return null;
								};
								const item = opts.fmtPick ? pickFrom(opts.fmtPick) : null;
								if (item) {
									item.click();
									fp.picked = opts.fmtPick;
									fp.after = (sb.querySelector(".semlink-mt-config-selectbtn-label")?.textContent ?? "").slice(0, 20);
									const ep = cfgDoc.querySelector<HTMLInputElement>(".semlink-mt-config-advbody .semlink-mt-config-input");
									fp.endpoint = ep ? ep.value.slice(0, 60) : null;
								}
								void window.setTimeout(() => {
									fp.delayedMenus = readMenus();
								}, 300);
								(navDbg ??= {}).fmtProbe = fp;
							}
						}
					}
					for (const c of Array.from(cfgDoc.querySelectorAll<HTMLElement>(".semlink-mt-config"))) {
						// 隐藏实例（display:none）跳过：scrollTop 赋值是空操作
						if (c.offsetParent === null && c.clientHeight === 0) continue;
						c.scrollTop = opts.scrollConfig < 0 ? c.scrollHeight : opts.scrollConfig;
						cfgCount++;
						// sticky 取证：滚动后回读头部坐标——吸附时 headTop 恒定
						// （≈窗格顶），未吸附则随滚动上移出屏。本叶 push 过条目
						// 才能写（高级选项整节隐藏时 head 被 offsetParent 过滤，
						// 无条目——写 len-1 会炸到上一叶或 undefined）
						if (head && advProbe.length > 0) {
							const r2 = head.getBoundingClientRect();
							advProbe[advProbe.length - 1].scrollTopAfter = Math.round(c.scrollTop);
							advProbe[advProbe.length - 1].headTopAfterScroll = Math.round(r2.top);
						}
					}
				}
				(navDbg ??= {}).configCount = cfgCount;
				(navDbg ??= {}).advProbe = advProbe;
				// 粘性头几何：钉住位置 vs 滚动容器/面板顶（"顶部透出内容"取证）
				(navDbg ??= {}).headGeo = (() => {
					const heads: Array<Record<string, unknown>> = [];
					for (const leaf of cfgLeaves) {
						const el = ((leaf as unknown as { containerEl?: HTMLElement }).containerEl
							?? (leaf.view as unknown as { containerEl?: HTMLElement }).containerEl);
						const cfgDoc = el?.ownerDocument;
						if (!cfgDoc) continue;
						const head = cfgDoc.querySelector<HTMLElement>(".semlink-mt-config-head");
						const cfg = head?.parentElement as HTMLElement | null;
						if (!head || !cfg) continue;
						// 返回箭头取证：单列钻入态头部应内嵌 ‹ 箭头（空态兜底为
						// 独立返回行）
						const back = cfg.querySelector<HTMLElement>(".semlink-mt-config-back")
							?? cfg.querySelector<HTMLElement>(".semlink-mt-back");
						const backR = back?.getBoundingClientRect();
						// 模型行溢出取证：逃逸行是 rows 卡子元素还是卡外兄弟
						const rowsCard = cfg.querySelector<HTMLElement>(".semlink-mt-rows");
						const rowsSec = rowsCard?.parentElement as HTMLElement | null;
						const rowsGeo = rowsCard && rowsSec ? {
							cardRect: (() => { const r = rowsCard.getBoundingClientRect(); return { t: Math.round(r.top), b: Math.round(r.bottom), h: Math.round(r.height) }; })(),
							secRect: (() => { const r = rowsSec.getBoundingClientRect(); return { t: Math.round(r.top), b: Math.round(r.bottom), h: Math.round(r.height) }; })(),
							cardChildren: rowsCard.children.length,
							secChildren: Array.from(rowsSec.children).map((c) =>
								(c.className || c.tagName).toString().replace("semlink-mt-config-", "").slice(0, 22)),
							rowsOverflowY: rowsCard.ownerDocument.defaultView?.getComputedStyle(rowsCard).overflowY ?? null,
							secAfterCard: Array.from(rowsSec.children).slice(Array.from(rowsSec.children).indexOf(rowsCard) + 1).length,
						} : null;
						const hcs = cfgDoc.defaultView?.getComputedStyle(head);
						const hr = head.getBoundingClientRect();
						const cr = cfg.getBoundingClientRect();
						const panel = head.closest(".semlink-settings-panel");
						const pr = panel?.getBoundingClientRect();
						heads.push({
							rowsGeo,
							backRow: back
								? {
									kind: back.hasClass("semlink-mt-config-back") ? "inline" : "standalone",
									text: (back.textContent ?? "").slice(0, 20),
									hidden: back.offsetParent === null,
									w: backR ? Math.round(backR.width) : null,
									h: backR ? Math.round(backR.height) : null,
									top: backR ? Math.round(backR.top) : null,
								}
								: null,
							// 头部名称 + Endpoint 行（系列选型链路验收：切成员后
							// 头名与端点行文本应随之变化）
							headName: cfgDoc.querySelector<HTMLElement>(".semlink-mt-config-name")?.textContent ?? null,
							epRow: (() => {
								const ep = cfg.querySelector<HTMLElement>(".semlink-mt-config-eprow");
								if (!ep) return null;
								return {
									label: ep.querySelector<HTMLElement>(".semlink-mt-config-label")?.textContent ?? null,
									value: (ep.querySelector<HTMLElement>(".semlink-mt-config-epval")?.textContent ?? "").slice(0, 80),
								};
							})(),
							visible: head.offsetParent !== null,
							position: hcs?.position ?? null,
							top: hcs?.top ?? null,
							zIndex: hcs?.zIndex ?? null,
							bg: hcs?.background.slice(0, 60) ?? null,
							headTop: Math.round(hr.top),
							headBottom: Math.round(hr.bottom),
							cfgTop: Math.round(cr.top),
							cfgScrollTop: Math.round(cfg.scrollTop),
							cfgOverflowY: cfg.ownerDocument.defaultView?.getComputedStyle(cfg).overflowY ?? null,
							panelTop: pr ? Math.round(pr.top) : null,
							panelScrollTop: panel ? Math.round(panel.scrollTop) : null,
						});
					}
					return heads;
				})();
				// 异步复检：500ms 后再读一次（捉同步块之后才发生的重渲染）
				await new Promise((r) => window.setTimeout(r, 500));
				for (const p of Array.from((navDbg as Record<string, unknown>).advProbe as Array<Record<string, unknown>>)) {
					const wDoc = (p as { __doc?: Document }).__doc ?? window.document;
					const h2 = wDoc.querySelector<HTMLElement>(".semlink-mt-config-advhead");
					const b2 = wDoc.querySelector<HTMLElement>(".semlink-mt-config-advbody");
					const c2 = wDoc.querySelector<HTMLElement>(".semlink-mt-config");
					p.delayedText = h2 ? (h2.textContent ?? "").slice(0, 24) : null;
					p.delayedBodyHidden = b2 ? b2.hasClass("semlink-hidden") : null;
					p.delayedScrollTop = c2 ? Math.round(c2.scrollTop) : null;
					p.delayedHeadTop = h2 ? Math.round(h2.getBoundingClientRect().top) : null;
				}
				// keyProbe：Key 行双态取证（Cherry 式只读胶囊 ↔ 编辑输入框）。
					// keyEditClick 点只读态铅笔切编辑态；keyProbeFill 往输入框塞
					// 假值派发 input（不走 change——不落盘）；keySaveClick 点 Save
					// 落盘并收回只读态。每步读一次行子元素清单。
					const keyProbe: Array<Record<string, unknown>> = [];
					for (const leaf of cfgLeaves) {
						const el = ((leaf as unknown as { containerEl?: HTMLElement }).containerEl
							?? (leaf.view as unknown as { containerEl?: HTMLElement }).containerEl);
						const cfgDoc = el?.ownerDocument;
						if (!cfgDoc) continue;
						const kr = cfgDoc.querySelector<HTMLElement>(".semlink-mt-config-keyrow");
						if (!kr) continue;
						const inputOf = () => kr.querySelector<HTMLInputElement>("input.semlink-mt-config-input");
						const read = (note: string) => {
							const ki = inputOf();
							keyProbe.push({
								note,
								keyLen: ki ? ki.value.length : null,
								mode: kr.querySelector(".semlink-mt-config-keypill") ? "readonly-pill" : (ki ? "edit-input" : "?"),
								// 取钥外链图标在行内是否存在（配置完成后应隐藏）
								linkIcon: !!kr.querySelector(".semlink-mt-config-link"),
								// 密钥行的子元素清单（验收眼睛按钮确已移除）
								rowChildren: Array.from(kr.children).map((c) =>
									(c.className || c.tagName).toString().replace("semlink-mt-config-", "").slice(0, 24)),
								// 胶囊几何取证：内嵌动作钮是否真在胶囊盒内
								pillGeo: (() => {
									const pill = kr.querySelector<HTMLElement>(".semlink-mt-config-keypill");
									if (!pill) return null;
									const pcs = pill.ownerDocument.defaultView?.getComputedStyle(pill);
									const acts = pill.querySelector<HTMLElement>(".semlink-mt-config-keypill-actions");
									const pr = pill.getBoundingClientRect();
									return {
										display: pcs?.display ?? null,
										flexWrap: pcs?.flexWrap ?? null,
										pillW: Math.round(pr.width),
										pillRight: Math.round(pr.right),
										hasActions: !!acts,
										actsW: acts ? Math.round(acts.getBoundingClientRect().width) : null,
										actsRight: acts ? Math.round(acts.getBoundingClientRect().right) : null,
									};
								})(),
								statusText: kr.parentElement?.querySelector<HTMLElement>(".semlink-mt-config-status")?.textContent ?? null,
							});
						};
						read("initial");
						if (opts.keyEditClick) {
							kr.querySelector<HTMLElement>(".semlink-mt-config-icon-btn")?.click();
							read("after-edit-click");
						}
						if (opts.keyProbeFill) {
							const ki = inputOf();
							if (ki) {
								ki.value = opts.keyProbeValue ?? "sk-test-verification";
								ki.dispatchEvent(new Event("input"));
								// keyProbeCommit：走 change 提交（编辑态的失焦保存同
								// 路径）——探针收尾用它把假 Key 清回真实状态
								if (opts.keyProbeCommit) ki.dispatchEvent(new Event("change"));
							}
							read("after-fill");
						}
						if (opts.keyKebabClick) {
							// 竖点（行内第二个 icon-btn）：开菜单不点项，留给截图取证
							const btns = kr.querySelectorAll<HTMLElement>(".semlink-mt-config-icon-btn");
							btns[btns.length - 1]?.click();
							read("after-kebab-click");
						}
						if (opts.keySaveClick) {
							kr.querySelector<HTMLButtonElement>(".semlink-mt-config-detect")?.click();
							read("after-save-click");
						}
					}
					(navDbg ??= {}).keyProbe = keyProbe;
					await new Promise((r) => window.setTimeout(r, 250));
			}
		}
		// variantPick：在打开的选型弹窗里点指定成员行（验收选型 → 切配置）。
		// 弹窗已从 VariantPickerModal（semlink-variant-*）换成 SeriesPickModal
		// （semlink-guide-series-modal / guide-provider-card）——类名同步。
		if (opts?.variantPick) {
			const vLeaves = this.app.workspace.getLeavesOfType(SEARCH_VIEW_TYPE);
			let vPicked: string | null = null;
			for (const leaf of vLeaves) {
				const el = ((leaf as unknown as { containerEl?: HTMLElement }).containerEl
					?? (leaf.view as unknown as { containerEl?: HTMLElement }).containerEl);
				const vDoc = el?.ownerDocument;
				if (!vDoc) continue;
				const rows = Array.from(vDoc.querySelectorAll<HTMLElement>(
					".semlink-guide-series-modal .semlink-guide-provider-card",
				)).filter((x) => x.offsetParent !== null);
				const target = rows.find((x) =>
					(x.querySelector<HTMLElement>(".semlink-guide-provider-name")?.textContent ?? "").includes(opts.variantPick as string));
				if (target) {
					vPicked = target.querySelector<HTMLElement>(".semlink-guide-provider-name")?.textContent ?? null;
					target.click();
					break;
				}
			}
			(navDbg ??= {}).variantPicked = vPicked;
			await new Promise((r) => window.setTimeout(r, 400));
			// 选后回读：弹窗是否已关 + 实时 DOM 的配置头名/钻入态
			(navDbg ??= {}).variantAfter = (() => {
				const live = Array.from(this.app.workspace.getLeavesOfType(SEARCH_VIEW_TYPE))
					.map((lf) => {
						const le = ((lf as unknown as { containerEl?: HTMLElement }).containerEl
							?? (lf.view as unknown as { containerEl?: HTMLElement }).containerEl);
						const ld = le?.ownerDocument;
						if (!ld) return null;
						return {
							modalOpen: !!ld.querySelector(".semlink-guide-series-modal"),
							headName: ld.querySelector<HTMLElement>(".semlink-mt-config-name")?.textContent ?? null,
							drilled: !!ld.querySelector(".semlink-settings-root.is-drilled"),
						};
					})
					.filter(Boolean);
				return live;
			})();
		}
		// epClick：点配置栏 Endpoint 行（系列供应商专属）→ 弹选型窗。
		if (opts?.epClick) {
			const eLeaves = this.app.workspace.getLeavesOfType(SEARCH_VIEW_TYPE);
			for (const leaf of eLeaves) {
				const el = ((leaf as unknown as { containerEl?: HTMLElement }).containerEl
					?? (leaf.view as unknown as { containerEl?: HTMLElement }).containerEl);
				const eDoc = el?.ownerDocument;
				if (!eDoc) continue;
				const ep = Array.from(eDoc.querySelectorAll<HTMLElement>(".semlink-mt-config-eprow"))
					.find((x) => x.offsetParent !== null);
				if (ep) {
					ep.click();
					break;
				}
			}
			await new Promise((r) => window.setTimeout(r, 400));
			// 点后回读：弹窗行清单（验收 current 高亮与成员/端点渲染）
			(navDbg ??= {}).epModalAfter = (() => {
				for (const lf of this.app.workspace.getLeavesOfType(SEARCH_VIEW_TYPE)) {
					const le = ((lf as unknown as { containerEl?: HTMLElement }).containerEl
						?? (lf.view as unknown as { containerEl?: HTMLElement }).containerEl);
					const ld = le?.ownerDocument;
					const modal = ld?.querySelector<HTMLElement>(".semlink-variant-modal");
					if (!modal || !ld) continue;
					return Array.from(modal.querySelectorAll<HTMLElement>(".semlink-variant-row")).map((rw) => ({
						name: rw.querySelector<HTMLElement>(".semlink-variant-name")?.textContent ?? null,
						isCurrent: rw.hasClass("is-current"),
						endpoint: (rw.querySelector<HTMLElement>(".semlink-variant-endpoint")?.textContent ?? "").slice(0, 60),
					}));
				}
				return null;
			})();
		}

		// epPick：在 Endpoint 行弹出的选型窗里点成员（验收端点弹窗切换
		// 成员的完整闭环——与组行弹窗同一 VariantPickerModal 路径）。
		if (opts?.epPick) {
			let picked2: string | null = null;
			for (const lf of this.app.workspace.getLeavesOfType(SEARCH_VIEW_TYPE)) {
				const le = ((lf as unknown as { containerEl?: HTMLElement }).containerEl
					?? (lf.view as unknown as { containerEl?: HTMLElement }).containerEl);
				const ld = le?.ownerDocument;
				if (!ld) continue;
				const rows2 = Array.from(ld.querySelectorAll<HTMLElement>(".semlink-variant-row"))
					.filter((x) => x.offsetParent !== null);
				const tgt = rows2.find((x) =>
					(x.querySelector<HTMLElement>(".semlink-variant-name")?.textContent ?? "").includes(opts.epPick as string));
				if (tgt) {
					picked2 = tgt.querySelector<HTMLElement>(".semlink-variant-name")?.textContent ?? null;
					tgt.click();
					break;
				}
			}
			(navDbg ??= {}).epPicked = picked2;
			await new Promise((r) => window.setTimeout(r, 400));
			(navDbg ??= {}).epPickAfter = (() => {
				for (const lf of this.app.workspace.getLeavesOfType(SEARCH_VIEW_TYPE)) {
					const le = ((lf as unknown as { containerEl?: HTMLElement }).containerEl
						?? (lf.view as unknown as { containerEl?: HTMLElement }).containerEl);
					const ld = le?.ownerDocument;
					if (!ld) continue;
					return {
						modalOpen: !!ld.querySelector(".semlink-variant-modal"),
						headName: ld.querySelector<HTMLElement>(".semlink-mt-config-name")?.textContent ?? null,
					};
				}
				return null;
			})();
		}
		// guideBackProbe：引导返回直达来源屏全链路（用户拍板"从哪里跳进去
		// 就从返回到哪里"）：点 RAG 嵌入行 Configure（openSetupGuide embed，
		// guideDirect=true）→ 引导页 → 点 ← → 回读落点（应为设置屏而非 hub）。
		if (opts?.guideBackProbe) {
			const g: Record<string, unknown> = {};
			for (const lf of this.app.workspace.getLeavesOfType(SEARCH_VIEW_TYPE)) {
				const le = ((lf as unknown as { containerEl?: HTMLElement }).containerEl
					?? (lf.view as unknown as { containerEl?: HTMLElement }).containerEl);
				const ld = le?.ownerDocument;
				if (!ld) continue;
				const cfgBtn = ld.querySelector<HTMLElement>(
					".semlink-rag-card .semlink-row .semlink-row-control button");
				if (!cfgBtn) { g.error = "no-configure-btn"; break; }
				cfgBtn.click();
				await new Promise((r) => window.setTimeout(r, 900));
				g.guideShown = !!ld.querySelector(".semlink-search-welcome-guide");
				g.hubShown = !!ld.querySelector(".semlink-guide-hub");
				const back = ld.querySelector<HTMLElement>(".semlink-guide-corners .semlink-search-icon-btn");
				if (!back) { g.error = "no-back-btn"; break; }
				back.click();
				await new Promise((r) => window.setTimeout(r, 700));
				g.afterBackSettings = !!ld.querySelector(".semlink-settings-screen");
				g.afterBackHub = !!ld.querySelector(".semlink-guide-hub");
				g.afterBackGuide = !!ld.querySelector(".semlink-search-welcome-guide");
				break;
			}
			(navDbg ??= {}).guideBack = g;
		}
		// onboardOpen：点设置页引导行的 Open（拉取版 Pro 页结构）→ 引导
		// hub，验证引导头部新窗口切换图标。
		if (opts?.onboardOpen) {
			for (const lf of this.app.workspace.getLeavesOfType(SEARCH_VIEW_TYPE)) {
				const le = ((lf as unknown as { containerEl?: HTMLElement }).containerEl
					?? (lf.view as unknown as { containerEl?: HTMLElement }).containerEl);
				const ld = le?.ownerDocument;
				if (!ld) continue;
				const btn = ld.querySelector<HTMLElement>(
					".semlink-guide-row-card .semlink-row-control button");
				if (!btn) continue;
				btn.click();
				await new Promise((r) => window.setTimeout(r, 900));
				(navDbg ??= {}).onboardGuide = {
					hubShown: !!ld.querySelector(".semlink-guide-hub"),
				};
				break;
			}
		}
		// ragDomProbe：RAG 高级选项折叠体取证——只点**可见**实例的头（此前
		// 盲取第一个含该 DOM 的 leaf，命中过隐藏副本点了等于白点），点开后
		// 逐行读计算底色 + 从行向上回溯每一层祖先的底色（谁在染灰直接现形）。
		if (opts?.ragDomProbe) {
			for (const lf of this.app.workspace.getLeavesOfType(SEARCH_VIEW_TYPE)) {
				const le = ((lf as unknown as { containerEl?: HTMLElement }).containerEl
					?? (lf.view as unknown as { containerEl?: HTMLElement }).containerEl);
				const ld = le?.ownerDocument;
				if (!ld) continue;
				const head = ld.querySelector<HTMLElement>(".semlink-collapse-head");
				if (!head || head.offsetParent === null) continue;
				// 截图取证前置：把折叠头点开（body 在 DOM 里但 semlink-hidden）
				head.click();
				await new Promise((r) => window.setTimeout(r, 350));
				const body = ld.querySelector<HTMLElement>(".semlink-collapse-body");
				if (!body) continue;
				const win = ld.defaultView!;
				const bgOf = (el: Element): string => {
					const cs = win.getComputedStyle(el);
					return cs.backgroundColor + (cs.backgroundImage !== "none" ? " " + cs.backgroundImage.slice(0, 40) : "");
				};
				const dump = (el: Element, depth: number): string => {
					const cls = (el.className || "").toString().slice(0, 70);
					const line = `${"  ".repeat(depth)}<${el.tagName.toLowerCase()}${cls ? "." + cls.replace(/\s+/g, ".") : ""}>`;
					if (depth > 5) return line;
					return line + "\n" + Array.from(el.children).map((c) => dump(c, depth + 1)).join("\n");
				};
				const dbg: Record<string, unknown> = {};
				dbg.headWasHidden = body.hasClass("semlink-hidden") === false ? "expanded" : "still-hidden";
				dbg.bodyBg = bgOf(body);
				// 折叠头对齐取证：计算样式 + 图标/文字相对头的横向起点
				{
					const cs = win.getComputedStyle(head);
					const hr = head.getBoundingClientRect();
					const chev = head.querySelector(".semlink-collapse-chevron");
					const lab = head.querySelector(".semlink-collapse-label");
					const cr = chev?.getBoundingClientRect();
					const lr = lab?.getBoundingClientRect();
					dbg.headStyle = {
						display: cs.display,
						justifyContent: cs.justifyContent,
						headRect: { l: Math.round(hr.left), r: Math.round(hr.right) },
						chevLeft: cr ? Math.round(cr.left - hr.left) : null,
						labelLeft: lr ? Math.round(lr.left - hr.left) : null,
					};
				}
				dbg.ragDom = dump(body.children[0] as Element, 0);
				dbg.rows = Array.from(body.querySelectorAll(".setting-item")).map((row) => ({
					text: (row.querySelector(".setting-item-name")?.textContent ?? "").slice(0, 24),
					bg: bgOf(row),
				}));
				// 从第一条行向上回溯：把每层有底色的祖先列出来（定位染灰层）
				const chain: Array<Record<string, unknown>> = [];
				let el: HTMLElement | null = body.querySelectorAll(".setting-item")[0] ?? null;
				while (el && chain.length < 14) {
					const bg = bgOf(el);
					if (bg !== "rgba(0, 0, 0, 0)") {
						chain.push({ el: el.tagName.toLowerCase() + "." + (el.className || "").toString().split(/\s+/).slice(0, 3).join("."), bg });
					}
					el = el.parentElement;
				}
				dbg.bgChain = chain;
				(navDbg ??= {}).ragProbe = dbg;
				break;
			}
		}
		// keyModalProbe：Key 弹窗内取证（用户拍板"去掉输入框和异常提示
		// 之间的空行"）：塞假 Key → 点 Test & Save → 等检测失败 → 读输入
		// 框/状态行矩形与计算 margin。失败不落盘（先测后存），无副作用；
		// 弹窗留在原地供截图，收尾用 keyModalClose 点 Cancel。
		if (opts?.keyModalProbe) {
			const keyModalDbg: Array<Record<string, unknown>> = [];
			const mLeaves = this.app.workspace.getLeavesOfType(SEARCH_VIEW_TYPE);
			for (const leaf of mLeaves) {
				const el = ((leaf as unknown as { containerEl?: HTMLElement }).containerEl
					?? (leaf.view as unknown as { containerEl?: HTMLElement }).containerEl);
				const mDoc = el?.ownerDocument;
				if (!mDoc) continue;
				const modal = mDoc.querySelector<HTMLElement>(".semlink-key-modal");
				if (!modal) continue;
				const input = modal.querySelector<HTMLInputElement>(".semlink-editor-input");
				const status = modal.querySelector<HTMLElement>(".semlink-mt-config-status");
				const saveBtn = modal.querySelector<HTMLButtonElement>(".semlink-editor-save-btn");
				if (!input || !status || !saveBtn) {
					keyModalDbg.push({ error: "missing-parts" });
					continue;
				}
				input.value = opts.keyProbeValue ?? "sk-probe-invalid";
				input.dispatchEvent(new Event("input"));
				saveBtn.click();
				await new Promise((r) => window.setTimeout(r, 3000));
				const win = modal.ownerDocument.defaultView;
				const ir = input.getBoundingClientRect();
				const sr = status.getBoundingClientRect();
				keyModalDbg.push({
					statusText: (status.textContent ?? "").slice(0, 60),
					statusIsErr: status.hasClass("is-err"),
					inputMarginBottom: win?.getComputedStyle(input).marginBottom ?? null,
					statusMarginTop: win?.getComputedStyle(status).marginTop ?? null,
					inputBottom: Math.round(ir.bottom),
					statusTop: Math.round(sr.top),
					gap: Math.round(sr.top - ir.bottom),
				});
				break;
			}
			(navDbg ??= {}).keyModalProbe = keyModalDbg;
		}
		// keyModalClose：收尾——点开着的 Key 弹窗里第一个可见 Cancel/Close
		if (opts?.keyModalClose) {
			const mLeaves = this.app.workspace.getLeavesOfType(SEARCH_VIEW_TYPE);
			for (const leaf of mLeaves) {
				const el = ((leaf as unknown as { containerEl?: HTMLElement }).containerEl
					?? (leaf.view as unknown as { containerEl?: HTMLElement }).containerEl);
				const mDoc = el?.ownerDocument;
				if (!mDoc) continue;
				const modal = mDoc.querySelector<HTMLElement>(".semlink-key-modal");
				if (!modal) continue;
				const btn = Array.from(modal.querySelectorAll<HTMLButtonElement>(".semlink-editor-cancel-btn"))
					.find((b) => b.offsetParent !== null);
				btn?.click();
			}
			await new Promise((r) => window.setTimeout(r, 300));
		}
		// addProviderProbe：AddProviderModal（自定义供应商）取证——用户截图
		// 里两个原生 select（API 类型 / 鉴权）文字被竖向裁掉一半。自动开
		// 弹窗，量 select 与相邻 input 的几何 + 计算样式对比定位，量完即关
		// （不落盘，无副作用）。
		if (opts?.addProviderProbe) {
			const dbg: Record<string, unknown> = {};
			try {
				const { AddProviderModal } = await import("./src/settings-models");
				const modal = new AddProviderModal(this.app, this, "custom", () => {});
				modal.open();
				await new Promise((r) => window.setTimeout(r, 400));
				const doc = modal.modalEl.ownerDocument;
				const win = doc.defaultView;
				const pick = (sel: string): Record<string, unknown> | null => {
					const el = modal.modalEl.querySelector<HTMLElement>(sel);
					if (!el) return null;
					const r = el.getBoundingClientRect();
					const cs = win!.getComputedStyle(el);
					return {
						text: (el.textContent ?? "").slice(0, 40),
						rect: { top: Math.round(r.top), height: Math.round(r.height), width: Math.round(r.width) },
						paddingTop: cs.paddingTop,
						paddingBottom: cs.paddingBottom,
						height: cs.height,
						lineHeight: cs.lineHeight,
						fontSize: cs.fontSize,
						appearance: (cs as CSSStyleDeclaration & { webkitAppearance?: string }).webkitAppearance ?? cs.appearance,
						overflow: cs.overflow,
					};
				};
				const selects = Array.from(modal.modalEl.querySelectorAll<HTMLSelectElement>("select.semlink-editor-select"));
				dbg.selectCount = selects.length;
				dbg.selects = selects.map((s) => {
					const r = s.getBoundingClientRect();
					const cs = win!.getComputedStyle(s);
					return {
						value: s.value,
						rect: { top: Math.round(r.top), height: Math.round(r.height), width: Math.round(r.width) },
						padding: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`,
						height: cs.height,
						lineHeight: cs.lineHeight,
						fontSize: cs.fontSize,
						appearance: (cs as CSSStyleDeclaration & { webkitAppearance?: string }).webkitAppearance ?? cs.appearance,
					};
				});
				dbg.input = pick("input.semlink-editor-input");
				modal.close();
			} catch (e) {
				dbg.error = String(e);
			}
			(navDbg ??= {}).addProviderProbe = dbg;
		}
		// scrollPerf：配置页滚动卡顿取证（用户报"往下滚动很卡"）——找到可见
		// 且可滚的模型列表卡（.semlink-mt-rows）与其外层配置列滚动容器，
		// 程序化驱动滚动（每帧步进），记录 rAF 帧间隔分布。主线程被布局/
		// 绘制拖住时帧间隔拉长，avgDt/maxDt/slowFrames 即卡顿客观指标。
		if (opts?.scrollPerf) {
			const dbg: Record<string, unknown> = {};
			const diag: Array<Record<string, unknown>> = [];
			for (const leaf of this.app.workspace.getLeavesOfType(SEARCH_VIEW_TYPE)) {
				const el = ((leaf as unknown as { containerEl?: HTMLElement }).containerEl
					?? (leaf.view as unknown as { containerEl?: HTMLElement }).containerEl);
				const doc = el?.ownerDocument;
				if (!doc) continue;
				const all = Array.from(doc.querySelectorAll<HTMLElement>(".semlink-mt-rows"));
				// 命中条件：可见且自身有滚动量程（窗口化后列表卡就是内层滚动
				// 容器，只渲染 ~30 行；无界形态时行数多）
				const rows = all
					.find((x) => x.offsetParent !== null && x.scrollHeight > x.clientHeight + 100);
				diag.push({
					hasSettings: !!doc.querySelector(".semlink-settings-root"),
					rows: all.map((x) => ({
						visible: x.offsetParent !== null,
						scrollH: x.scrollHeight,
						clientH: x.clientHeight,
						models: x.querySelectorAll(".semlink-mt-model").length,
					})),
				});
				if (!rows) continue;
				// 外层滚动容器：从列表卡向上找第一个 overflow auto/scroll
				let outer: HTMLElement | null = rows.parentElement;
				while (outer && outer !== doc.body) {
					const oy = doc.defaultView!.getComputedStyle(outer).overflowY;
					if (oy === "auto" || oy === "scroll") break;
					outer = outer.parentElement;
				}
				if (outer === doc.body) outer = null;
				const drive = (target: HTMLElement): Promise<Record<string, unknown>> => {
					const run = (): Promise<Record<string, unknown>> =>
						new Promise((resolve) => {
							const win = doc.defaultView!;
							const start = target.scrollTop;
							const end = target.scrollHeight - target.clientHeight;
							if (end <= start + 100) {
								resolve({ skipped: "no-scroll-range" });
								return;
							}
							const step = Math.max(80, Math.round((end - start) / 60));
							const dts: number[] = [];
							let last = win.performance.now();
							let y = start;
							const tick = (): void => {
								const now = win.performance.now();
								dts.push(now - last);
								last = now;
								y += step;
								target.scrollTop = Math.min(y, end);
								if (y >= end) {
									const avg = dts.reduce((a, b) => a + b, 0) / Math.max(1, dts.length);
									resolve({
										distance: Math.round(end - start),
										frames: dts.length,
										avgDt: Math.round(avg * 10) / 10,
										maxDt: Math.round(Math.max(...dts)),
										slowFrames: dts.filter((d) => d > 32).length,
									});
									return;
								}
								win.requestAnimationFrame(tick);
							};
							win.requestAnimationFrame(tick);
						});
					// 窗口被遮挡时 rAF 暂停，驱动循环永不结束——8s 兜底返回
					const stall = new Promise<Record<string, unknown>>((resolve) =>
						setTimeout(() => resolve({ stalled: "rAF paused (window occluded?)" }), 8000),
					);
					return Promise.race([run(), stall]);
				};
				dbg.modelRows = rows.querySelectorAll(".semlink-mt-model").length;
				dbg.rowsBox = { scrollH: rows.scrollHeight, clientH: rows.clientHeight };
				dbg.outerFound = !!outer;
				// 跑马灯计数：溢出模型名的 marquee 动画（track 双 span 无限
				// 循环）——超大目录里可能是常驻动画把滚动拖卡的主因
				dbg.marquees = rows.querySelectorAll(".semlink-mt-model-name-track").length;
				dbg.innerDrive = await drive(rows);
				// 对照组：禁掉跑马灯动画再量同一容器（先回滚到顶恢复量程）
				rows.scrollTop = 0;
				await new Promise((r) => doc.defaultView!.requestAnimationFrame(r));
				const styleEl = doc.createElement("style");
				styleEl.textContent =
					".semlink-mt-model-name-track, .semlink-mt-model-name-text { animation: none !important; }";
				doc.head.appendChild(styleEl);
				dbg.innerDriveNoMarquee = await drive(rows);
				styleEl.remove();
				if (outer) dbg.outerDrive = await drive(outer);
				dbg.docs = diag;
				break;
			}
			// 无命中时也带出全部叶子诊断（dbg.docs 只在成功路径写入）
			if (!dbg.docs) dbg.docs = diag;
			(navDbg ??= {}).scrollPerf = dbg;
		}
		// countProbe：vault 可索引数取证——调度器口径（countIndexableNotes）
		// 与 vault 原始清单、磁盘 walk 对不上时（用户报"共 980 篇不更新"），
		// 分桶看差在哪：vault md 总数 / 非空 / 命中排除各多少。
		if (opts?.countProbe && opts?.forcePro) {
			// 仅供样式目检的内存桩：isPro 强 true（不落盘、重载即消失）
			const lmAny = this.licenseManager as unknown as { isPro?: () => boolean };
			lmAny.isPro = () => true;
		}
		if (opts?.countProbe) {
			const dbg: Record<string, unknown> = {};
			try {
				const all = this.app.vault.getMarkdownFiles();
				const patterns = this.settings.excludePaths
					.split("\n")
					.map((x) => x.trim())
					.filter((x) => x.length > 0);
				const isEx = (path: string): boolean =>
					patterns.some((x) => path.startsWith(x) || path.includes(x)) ||
					path.startsWith(this.app.vault.configDir + "/");
				const nonEmpty = all.filter((f) => f.stat.size > 0);
				const excluded = nonEmpty.filter((f) => isEx(f.path));
				dbg.vaultMd = all.length;
				dbg.vaultMdNonEmpty = nonEmpty.length;
				dbg.excludedByRule = excluded.length;
				dbg.countIndexable = this.scheduler.countIndexableNotes();
				dbg.emptyMd = all.length - nonEmpty.length;
				dbg.trackerTotalNotes = this.progress.current.totalNotes;
				dbg.trackerProcessed = this.progress.current.processedNotes;
				dbg.trackerPhase = this.progress.current.phase;
				const [stats, embedded] = await Promise.all([
					this.store.getStats(),
					this.store.getEmbeddedNoteCount(),
				]);
				dbg.db = stats;
				dbg.dbEmbeddedNotes = embedded;
				// "卡在 99.8%" 取证：哪些笔记有 active chunk 但零向量（毒丸
				// 候选），加队列四个计数的快照。
				dbg.vectorlessNotes = await this.store.listVectorlessNotes(10);
				dbg.queueCounts = await (this.scheduler as unknown as {
					queue: { getCounts(): Promise<{ pending: number; processing: number; failed: number; completed: number }> };
				}).queue.getCounts();
				// "总数 982 但永远 980" 差集取证：活库应索引清单 vs DB 已索引
				// 清单——缺的到底是哪几篇、为何进不了库。
				{
					const dbPaths = new Set(await this.store.listIndexedNotePaths());
					const live: string[] = [];
					for (const f of this.app.vault.getMarkdownFiles()) {
						if (f.stat.size === 0) continue;
						if (isEx(f.path)) continue;
						live.push(f.path);
					}
					const missing = live.filter((p) => !dbPaths.has(p));
					const stale = Array.from(dbPaths).filter((p) => {
						const f = this.app.vault.getAbstractFileByPath(p);
						if (!f || !(f instanceof TFile)) return true;
						return f.stat.size === 0 || isEx(p);
					});
					dbg.dbVsLive = {
						live: live.length,
						dbIndexed: dbPaths.size,
						missingFromDb: missing.slice(0, 10),
						staleInDb: stale.slice(0, 10),
					};
				}
				dbg.timeOrigin = Math.round(performance.timeOrigin);
				dbg.modals = Array.from(document.querySelectorAll('.smart-vault-progress-modal')).length;
				const lmAny = this.licenseManager as unknown as { state?: { key?: string; token?: string; instanceId?: string; lastValidatedAt?: number }; fp?: string; appId?: string };
				// 跨窗口检查 collapse-body-card 的实际计算底色与宿主类
				const envs: Array<Record<string, unknown>> = [];
				const allDocs: Document[] = [window.document];
				const floats = (this.app.workspace as unknown as { floatingSplit?: { children?: Array<{ win?: Window }> } }).floatingSplit;
				for (const c of floats?.children ?? []) {
					if (c?.win?.document) allDocs.push(c.win.document);
				}
				for (const d of allDocs) {
					const el = d.querySelector('.semlink-collapse-body-card');
					if (!el) continue;
					const cs = d.defaultView!.getComputedStyle(el);
					const root = el.closest('.semlink-settings-root');
					envs.push({
						docTitle: d.title.slice(0, 30),
						hasSettingsRoot: !!root,
						classes: el.className,
						bg: cs.backgroundColor,
						bgImage: cs.backgroundImage.slice(0, 40),
						rootVarCard: root ? root.getAttribute('style') + '' : null,
						varCardResolved: root ? d.defaultView!.getComputedStyle(root).getPropertyValue('--sl-card') : null,
					});
				}
				dbg.collapseEnv = envs;
				dbg.zaiWire = (this.settings.providers ?? [])
					.filter((x) => (x.apiBase ?? '').includes('bigmodel') || (x.name ?? '').includes('Z.AI'))
					.map((x) => ({ name: x.name, apiBase: x.apiBase, wirePath: x.wirePath ?? null, curated: x.curated ?? null }));
				dbg.license = {
					isPro: this.licenseManager.isPro(),
					configured: this.licenseManager.configured,
					hasKey: !!lmAny.state?.key,
					keyPrefix: (lmAny.state?.key ?? '').slice(0, 4),
					hasToken: !!lmAny.state?.token,
					tokenLen: (lmAny.state?.token ?? '').length,
					hasInstanceId: !!lmAny.state?.instanceId,
					fpLen: (lmAny.fp ?? '').length,
					fpHead: (lmAny.fp ?? '').slice(0, 8),
					appId: lmAny.appId ?? null,
				};
			} catch (e) {
				dbg.error = String(e);
			}
			(navDbg ??= {}).countProbe = dbg;
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
								const tr = tgl.getBoundingClientRect();
								// 圆钮实际渲染框：Range 包住 ::after 量不到——改用
								// knob 中心列扫描太重，这里报 computed top/left +
								// transform，配合容器 rect 可推实际几何。
								return {
									w: Math.round(tr.width),
									h: Math.round(tr.height),
									top: Math.round(tr.top),
									width: cs.width,
									height: cs.height,
									display: cs.display,
									flexShrink: cs.flexShrink,
									afterW: after.width,
									afterH: after.height,
									afterTop: after.top,
									afterLeft: after.left,
									afterMargin: after.margin,
									afterPosition: after.position,
									afterTransform: after.transform,
								};
							})(),
							// 模型行开关同规格取证（51×31 Cupertino 基线）
							rowToggle: (() => {
								const tgl = root.querySelector(
									".semlink-mt-rows .checkbox-container, .semlink-mt-config .checkbox-container:not(.semlink-mt-config-master *)",
								) as HTMLElement | null;
								if (!tgl) return null;
								const after = getComputedStyle(tgl, "::after");
								const tr = tgl.getBoundingClientRect();
								return {
									w: Math.round(tr.width),
									h: Math.round(tr.height),
									afterW: after.width,
									afterH: after.height,
									afterTop: after.top,
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
							// 供应商列表宽度探针：搜索胶囊 vs 行盒的四缘坐标与滚动条
							// 占位取证（margin/padding/gutter/滚动条宽度）——"行比
							// 搜索框窄"类问题一测便知差在哪个缘。
							provBox: (() => {
								const card = root.querySelector(".semlink-mt-providers") as HTMLElement | null;
								const search = root.querySelector(".semlink-mt-prov-search") as HTMLElement | null;
								const list = root.querySelector(".semlink-mt-provider-list") as HTMLElement | null;
								const row = root.querySelector(".semlink-mt-provider") as HTMLElement | null;
								if (!card || !search || !list || !row) return null;
								const box = (el: HTMLElement) => {
									const r = el.getBoundingClientRect();
									return { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) };
								};
								const cs = w.getComputedStyle(list);
								// 全样式表扫 ::-webkit-scrollbar* 规则：谁在场上、各声明什么
								const sbRules: Array<Record<string, unknown>> = [];
								for (const sheet of Array.from(w.document.styleSheets)) {
									let rules: CSSRuleList | undefined;
									try { rules = (sheet as CSSStyleSheet).cssRules as CSSRuleList; } catch { continue; }
									if (!rules) continue;
									const walkRules = (rs: CSSRuleList): void => {
										for (let i = 0; i < rs.length; i++) {
											const r = rs[i] as CSSRule;
											const grp = r as CSSGroupingRule;
											if (grp.cssRules && grp.cssRules.length > 0) {
												walkRules(grp.cssRules);
											}
											const sel = (r as CSSStyleRule).selectorText ?? "";
											if (sel.includes("::-webkit-scrollbar") && sel.includes("mt-provider-list")) {
												sbRules.push({
													sel: sel.slice(0, 120),
													css: (r as CSSStyleRule).style?.cssText.slice(0, 160),
													href: sheet.href?.split("/").pop() ?? "(inline)",
												});
											}
										}
									};
									walkRules(rules);
								}
								return {
									card: box(card),
									search: box(search),
									list: box(list),
									row: box(row),
									listClientW: list.clientWidth,
									listOffsetW: list.offsetWidth,
									// offsetWidth - clientWidth = 滚动条占位（>0 即经典滚动条在场）
									scrollbarW: list.offsetWidth - list.clientWidth,
									marginRight: cs.marginRight,
									paddingRight: cs.paddingRight,
									scrollbarGutter: cs.scrollbarGutter,
									stdScrollbarWidth: cs.scrollbarWidth,
									stdScrollbarColor: cs.scrollbarColor,
									matchesSel: list.matches(".smart-vault-settings .semlink-mt-provider-list"),
									sbRules,
									// 选中行 computed 背景：淡紫→灰改动的落点取证
									activeRowBg: (() => {
										const act = root.querySelector(".semlink-mt-provider.is-active") as HTMLElement | null;
										if (!act) return null;
										const acs = w.getComputedStyle(act);
										return {
											backgroundColor: acs.backgroundColor,
											bgVarActive: acs.getPropertyValue("--sl-active").trim(),
											bgVarFill: acs.getPropertyValue("--sl-fill").trim(),
											bgVarHover: acs.getPropertyValue("--background-modifier-hover").trim(),
											reducedTransparency: (w as WinLike & { matchMedia?: (q: string) => { matches: boolean } }).matchMedia?.("(prefers-reduced-transparency: reduce)")?.matches ?? false,
										};
										})(),
										// 选中行子元素宽度表：行内竖点加入后名称是否被挤截断
										rowKids: (() => {
											const act = root.querySelector(".semlink-mt-provider.is-active") as HTMLElement | null;
											if (!act) return null;
											return {
												rowW: Math.round(act.getBoundingClientRect().width),
												nameTruncated: (act.querySelector(".semlink-mt-provider-name") as HTMLElement | null)
													? (act.querySelector(".semlink-mt-provider-name") as HTMLElement).scrollWidth > (act.querySelector(".semlink-mt-provider-name") as HTMLElement).clientWidth
													: null,
												kids: Array.from(act.children).map((c) => ({
													cls: (c.className || c.tagName).toString().replace("semlink-mt-provider-", "").slice(0, 16),
													w: Math.round(c.getBoundingClientRect().width),
												})),
											};
										})(),
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
				viewClasses: (el.className || "").toString().slice(0, 120),
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

	/** ui 执行器：通用 DOM 级界面交互（query/click/type）。文档收集 = 主窗 +
	 *  全部 leaf 的 ownerDocument（popout 窗口各自一份 document；modal 挂在
	 *  所在窗的 body 上，随窗覆盖）。可见判定 = getBoundingClientRect 非零
	 *  （display:none / 未激活 tab 零尺寸被过滤）。文本匹配取最内层命中——
	 *  外层行与内层按钮同时含文本时只留内层，点它才走真按钮处理器。
	 *  跨 realm 注意：popout 元素不能 instanceof 主窗构造函数，一律用
	 *  tagName / isContentEditable 判定，value setter 取元素自己 realm 的原型。 */
	private async runDebugUi(opts?: { action?: string; selector?: string; text?: string; value?: string; index?: number; doc?: string }): Promise<unknown> {
		const action = (opts?.action ?? "query").toLowerCase();
		const sel = opts?.selector?.trim() ?? "";
		const text = opts?.text?.trim() ?? "";
		const idx = typeof opts?.index === "number" ? Math.max(0, Math.floor(opts.index)) : 0;
		const docFilter = opts?.doc?.trim().toLowerCase() ?? "";
		if (action !== "query" && action !== "click" && action !== "type") {
			return { error: `unknown action "${action}" (query | click | type)` };
		}
		if (action === "type" && !sel) return { error: "type needs a selector (input target)" };
		if (!sel && !text) return { error: "ui needs a selector and/or text" };

		const docs = new Set<Document>([window.document]);
		this.app.workspace.iterateAllLeaves((leaf) => {
			const el = (leaf as unknown as { containerEl?: HTMLElement }).containerEl
				?? (leaf.view as unknown as { containerEl?: HTMLElement }).containerEl;
			if (el?.ownerDocument) docs.add(el.ownerDocument);
		});

		interface UiMatch {
			doc: string;
			tag: string;
			cls: string;
			text: string;
			rect: { x: number; y: number; w: number; h: number };
			el: Element;
		}
		const matches: UiMatch[] = [];
		for (const doc of docs) {
			let found: Element[];
			try {
				found = sel ? Array.from(doc.querySelectorAll(sel)) : Array.from(doc.querySelectorAll("*"));
			} catch (e) {
				return { error: `bad selector: ${e instanceof Error ? e.message : String(e)}` };
			}
			const lower = text.toLowerCase();
			for (const el of found) {
				if (text && !(el.textContent ?? "").trim().toLowerCase().includes(lower)) continue;
				const r = el.getBoundingClientRect();
				if (r.width <= 0 || r.height <= 0) continue;
				const docName = doc === window.document ? "main" : "popout";
				// doc 过滤：同名按钮/文本在主窗与 popout 各有一份时精确定位
				if (docFilter && docName !== docFilter) continue;
				matches.push({
					doc: docName,
					tag: el.tagName.toLowerCase(),
					cls: el.getAttribute("class") ?? "",
					text: (el.textContent ?? "").trim().slice(0, 80),
					rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
					el,
				});
			}
		}
		if (text) {
			// 只留最内层：没有更深的命中包含在自己里面
			for (let i = matches.length - 1; i >= 0; i--) {
				const m = matches[i];
				if (matches.some((o) => o !== m && m.el.contains(o.el))) matches.splice(i, 1);
			}
		}
		const info = matches.map(({ el, ...rest }) => rest);

		if (action === "query") return { action, count: matches.length, matches: info };
		const m = matches[idx];
		if (!m) {
			return { error: `visible match index ${idx} out of range (${matches.length} matches)`, matches: info };
		}
		if (action === "click") {
			const el = m.el as HTMLElement;
			if (typeof el.click === "function") el.click();
			else el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
			return { action, clicked: info[idx] };
		}
		// type：input/textarea/select/contenteditable 统一入口。赋值走元素
		// 自己 realm 的原型 setter（兼容 value-tracker 类框架），再补
		// input+change 事件——与真实编辑等价。
		const el = m.el;
		const value = opts?.value ?? "";
		const win = el.ownerDocument.defaultView as unknown as {
			HTMLInputElement?: { prototype: Record<string, unknown> };
			HTMLTextAreaElement?: { prototype: Record<string, unknown> };
		};
		const tag = el.tagName;
		if (tag === "INPUT" || tag === "TEXTAREA") {
			const proto = tag === "TEXTAREA" ? win.HTMLTextAreaElement?.prototype : win.HTMLInputElement?.prototype;
			const setter = proto ? Object.getOwnPropertyDescriptor(proto, "value")?.set : null;
			if (setter) setter.call(el, value);
			else (el as HTMLInputElement).value = value;
			el.dispatchEvent(new Event("input", { bubbles: true }));
			el.dispatchEvent(new Event("change", { bubbles: true }));
		} else if (tag === "SELECT") {
			(el as HTMLSelectElement).value = value;
			el.dispatchEvent(new Event("change", { bubbles: true }));
		} else if ((el as HTMLElement).isContentEditable) {
			(el as HTMLElement).focus();
			(el as HTMLElement).textContent = value;
			el.dispatchEvent(new Event("input", { bubbles: true }));
		} else {
			return { error: "target is not an input/textarea/select/contenteditable", matched: info[idx] };
		}
		return { action, typed: info[idx], value };
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

	/** 获焦对账上次触发时间（节流用；debug 工具读数——判断「一直索引」
	 *  是否由获焦对账反复触发全量扫描）。 */
	lastFocusReconcile = 0;

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
		// 启动对账：等 watcher 5s 宽限期与启动风暴过去后再跑。vault 清单可能
		// 比插件更晚就绪（真机 2026-11-12：8s 时 getMarkdownFiles() 仍为空 →
		// 对账白跑、prune 被守卫跳过，且一次定终身只能等 ≥5min 获焦对账）。
		// 改为「先探清单再跑」：countIndexableNotes()==0 = 未就绪，8s 后再探，
		// 至多 5 轮；就绪即跑一次收尾。计时器全部挂 registerInterval，unload
		// 自动清。真空库（本来就没笔记）多探几轮后照跑一次，是廉价 no-op。
		let bootReconcileTries = 0;
		const tryBootReconcile = (): void => {
			if (!this.settings.autoIndex) return;
			if (this.scheduler.countIndexableNotes() === 0 && bootReconcileTries < 5) {
				bootReconcileTries++;
				console.warn(`[Semlink] boot reconcile: vault manifest not ready (${bootReconcileTries}/5), retrying in 8s`);
				this.registerInterval(window.setTimeout(tryBootReconcile, 8000));
				return;
			}
			this.startFullIndex();
		};
		this.registerInterval(window.setTimeout(tryBootReconcile, 8000));
	}

	startFullIndex() {
		// 静默守卫 + 静默启动：索引状态由状态栏/进度面板呈现，不再弹提示。
		if (this.scheduler.isRunning) return;
		void this.scheduler.run();
	}

	/** 设置页"Rebuild"：随时可用（用户拍板「保持 Rebuild 随时可用」）——
	 *  索引运行中也能重建：先 abort 中止当前循环，等其退出（在途批次秒级
	 *  收敛，finally 落盘后 isRunning 才翻转）再清库，从 0 开始重跑。
	 *  未配置嵌入模型时也允许——调度器会退化为只做分块索引。 */
	async reindexAll() {
		this.scheduler.abort();
		// 30s 兜底后照常继续：旧循环已带 abort 标记，最迟在当前批结束后
		// 退出，不会与新 run 长期并存；卡满 30s 属异常，留下告警线索。
		for (let i = 0; i < 300 && this.scheduler.isRunning; i++) {
			await new Promise((r) => setTimeout(r, 100));
		}
		if (this.scheduler.isRunning) {
			console.warn("[Semlink] reindexAll: previous run still exiting after 30s — proceeding anyway");
		}
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
		const modal = new ProgressModal(this.app, this.progress, async () => {
			// 覆盖率口径（与 RAG 卡 hero 一致）：**(Embedded + Skipped)** /
			// vault 应索引总数。跳过的笔记（空文件/全稀疏）永远不产生向量
			// 但已处理完，只数 Embedded 会把收尾钉在 99.4% 差一截（用户
			// 反馈）。曾用「已建索引笔记数」——重嵌入重建期间它恒定不动
			// （重建不产生新笔记，只刷新向量），弹窗分子冻在 801 很费解。
			try {
				const [embedded, skipped] = await Promise.all([
					this.store.getEmbeddedNoteCount(),
					this.store.getEmbedSkippedNoteCount(),
				]);
				return { indexed: embedded + skipped, total: this.scheduler.countIndexableNotes() };
			} catch {
				// worker 繁忙/退避中 DB 查询失败：退实时快照（索引运行中每
				// 5s 节流回写），别把弹窗钉在 0/0——分母走主线程文件遍历，
				// 零 DB 依赖，永远拿得到。
				const c = this.ragStatsCache;
				return { indexed: c.embeddedNotes + c.skippedNotes, total: this.scheduler.countIndexableNotes() };
			}
		}, {
			// 首帧播种：DB 查询到达前先直出快照（同「0/0」根因的修复）
			indexed: this.ragStatsCache.embeddedNotes + this.ragStatsCache.skippedNotes,
			total: this.scheduler.countIndexableNotes(),
		});
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
	/** 打开引导界面（hub）：Pro 页「打开引导」按钮用——泛入口（可选对话
	 *  /嵌入两条配置流），不跳过 hub。 */
	async openGuideHub(): Promise<void> {
		const leaf = await this.activateSearchView();
		(leaf?.view as unknown as {
			openGuide?: (mode?: "hub" | "chat" | "embed", from?: "home" | "settings") => void;
		} | undefined)?.openGuide?.("hub", "settings");
	}

	async openSetupGuide(kind: "chat" | "embed" = "chat"): Promise<void> {
		const leaf = await this.activateSearchView();
		(leaf?.view as SemanticSearchView | undefined)?.openSetupGuide(kind);
	}


	private updateStatusBar(p: import("./src/types").IndexProgress) {
		if (!this.statusBarEl) return;

		const dot = this.statusBarEl.querySelector(".status-dot");

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

		// 数量 = 覆盖率分子（Embedded + Skipped，DB 直读）——与设置页
		// Indexed 格、进度弹窗分子同源同口径（用户拍板「三处值保持同步」）。
		// 旧 processedNotes 是内存计数器，与 DB 直读天然差一笔在途笔记，
		// 三处必然漂移（真机 2026-11-12：129/129/128）。
		void this.refreshStatusBarCount();
	}

	/** 状态栏数量直读（防重入：500ms 节流间隔内回包 busy 请求直接丢弃，
	 *  等下一个节流点）。查询失败保持旧值——索引运行中 worker 会忙几秒。 */
	private statusBarCountBusy = false;
	private async refreshStatusBarCount(): Promise<void> {
		if (this.statusBarCountBusy || !this.statusBarEl) return;
		this.statusBarCountBusy = true;
		try {
			const [embedded, skipped] = await Promise.all([
				this.store.getEmbeddedNoteCount(),
				this.store.getEmbedSkippedNoteCount(),
			]);
			const count = this.statusBarEl?.querySelector(".status-count");
			if (count) count.textContent = `${embedded + skipped} ${t("statusIndexed")}`;
		} catch {
			/* 保持旧值，下一个节流点再试 */
		} finally {
			this.statusBarCountBusy = false;
		}
	}

	private async updateInitialStatusBar() {
		if (this.statusBarEl) {
			const dot = this.statusBarEl.querySelector(".status-dot");
			if (dot) dot.className = "status-dot idle";
			const count = this.statusBarEl.querySelector(".status-count");
			if (count) {
				// 四查并行：状态栏数量（覆盖率口径，用户拍板「三处值同步」）
				// + 进度追踪器权威播种 + RAG 快照写透（含更新时间），一趟拿全。
				const [stats, embedded, skipped, idxTime] = await Promise.all([
					this.store.getStats(),
					this.store.getEmbeddedNoteCount(),
					this.store.getEmbedSkippedNoteCount(),
					this.store.lastIndexTime(),
				]);
				count.textContent = `${embedded + skipped} ${t("statusIndexed")}`;
				// 用 DB 权威值播种进度追踪器：否则启动后任何一次进度事件
				// （扫描枚举阶段 processedNotes=0）都会把状态栏覆盖成
				// 「0 个文件」，直到打开面板/设置触发重播种才恢复。
				this.progress.initFromStats(
					stats.indexedNotes,
					stats.activeChunks,
					Math.max(this.progress.current.totalNotes, stats.indexedNotes),
				);
				// 同一趟顺路写透 RAG 统计快照（值已在手，省一轮往返）：
				// 此后设置页 RAG tab 打开即有值，不等 DB 往返。
				Object.assign(this.ragStatsCache, {
					indexedNotes: stats.indexedNotes,
					embeddedNotes: embedded,
					skippedNotes: skipped,
					updatedMs: idxTime,
					ready: true,
				});
				this.persistRagStatsCache();
			}
		}
	}

	/** RAG 统计快照刷新（三查并行）：失败静默保旧值——worker 未就绪/繁忙
	 *  时由设置页自身的退避重试兜底，快照只求「大概率新鲜」，不求强一致。 */
	async refreshRagStatsCache(): Promise<void> {
		try {
			const [s, embeddedNotes, skippedNotes, updatedMs] = await Promise.all([
				this.store.getStats(),
				this.store.getEmbeddedNoteCount(),
				this.store.getEmbedSkippedNoteCount(),
				this.store.lastIndexTime(),
			]);
			this.ragStatsCache = { indexedNotes: s.indexedNotes, embeddedNotes, skippedNotes, updatedMs, ready: true };
			this.persistRagStatsCache();
		} catch { /* 保旧值，等下一个播种点（完成事件/设置页写透） */ }
	}

	/** RAG 统计快照落盘（data/rag-stats-cache.json，~120 字节同步写）：重启
	 *  后状态栏/设置页/弹窗首帧直出上一会话的值（loadRagStatsCacheFromDisk
	 *  预载），DB 就绪后写透纠偏。失败静默——最坏回退为原来的等 DB 行为。
	 *  settings 页轮询兜底也写透（数值变化才写），须跨类可见。 */
	persistRagStatsCache(): void {
		try {
			writeFileSync(
				join(this.pluginDir, "data", "rag-stats-cache.json"),
				JSON.stringify(this.ragStatsCache),
				"utf-8",
			);
		} catch { /* 快照写失败不致命 */ }
	}

	private loadRagStatsCacheFromDisk(): void {
		try {
			const raw = readFileSync(join(this.pluginDir, "data", "rag-stats-cache.json"), "utf-8");
			const c = JSON.parse(raw) as { indexedNotes?: unknown; embeddedNotes?: unknown; skippedNotes?: unknown; updatedMs?: unknown };
			if (
				typeof c.indexedNotes === "number" && c.indexedNotes >= 0 &&
				typeof c.embeddedNotes === "number" && c.embeddedNotes >= 0 &&
				typeof c.skippedNotes === "number" && c.skippedNotes >= 0
			) {
				this.ragStatsCache = {
					indexedNotes: c.indexedNotes,
					embeddedNotes: c.embeddedNotes,
					skippedNotes: c.skippedNotes,
					updatedMs: typeof c.updatedMs === "number" && c.updatedMs > 0 ? c.updatedMs : null,
					ready: true,
				};
			}
		} catch { /* 无文件/损坏 → 空快照，走原 DB 路径 */ }
	}
}
