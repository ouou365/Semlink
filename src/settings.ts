// ========================================
// Semlink - Settings Tab
// ========================================

import { App, DropdownComponent, Modal, Notice, PluginSettingTab, Setting, ToggleComponent, setIcon } from "obsidian";
import * as QRCode from "qrcode";
import type SmartVaultPlugin from "../main";
import type { IndexProgress, McpClientServer, SmartVaultSettings } from "./types";
import { AddFeishuBotModal } from "./feishu-bot-modal";
import { startFeishuRegister, type FeishuScanHandle } from "./feishu-auth";
import { EMPTY_MODELS_TAB_STATE, renderModelsTab, type ModelsTabState } from "./settings-models";
import { LicenseModal } from "./license-modal";
import { licenseErrorMessage } from "./license";
import { LANGUAGES, getLang, t } from "./i18n";
import { ConfirmModal } from "./confirm-modal";
import { markDestructive, rerenderSettingsTab, showSliderValue } from "./ui-compat";
import { ShareQrModal } from "./share-modal";
import { debugLog } from "./log";

type SettingsTab = "general" | "model" | "mcp" | "embedding" | "share" | "bot";

export class SmartVaultSettingTab extends PluginSettingTab {
	plugin: SmartVaultPlugin;
	private activeTab: SettingsTab = "general";
	/** Provider-list state (models management, embedded in the General tab):
	 *  which provider's editor is expanded / which add card is open. */
	private modelsState: ModelsTabState = { ...EMPTY_MODELS_TAB_STATE };
	private feishuScanHandle: FeishuScanHandle | null = null;
	private indexCardUnsub: (() => void) | null = null;

	constructor(app: App, plugin: SmartVaultPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/** Deep-link from the chat view's "Manage models" popup entry: reveal the
	 *  settings with the Model tab active. */
	openModelTab(): void {
		this.activeTab = "model";
		this.display();
	}

	/** Re-render the current tab while keeping the scroll position — row
	 *  expand/collapse, provider create/delete and model add/remove/reorder
	 *  all re-render the whole page, which would otherwise jump back to the
	 *  top. Every scrollable ancestor's offset is recorded and restored
	 *  synchronously, on the next frame, and after a macrotask, so no layout
	 *  pass in between can reset it. */
	private refreshPreservingScroll(): void {
		const scrollers: HTMLElement[] = [];
		let el: HTMLElement | null = this.containerEl.parentElement;
		while (el) {
			const style = getComputedStyle(el);
			if (style.overflowY === "auto" || style.overflowY === "scroll"
				|| style.overflow === "auto" || style.overflow === "scroll") {
				scrollers.push(el);
			}
			el = el.parentElement;
		}
		const tops = scrollers.map((s) => s.scrollTop);
		// Fallback for layouts that scroll the window itself (short settings
		// panel inside a small window) rather than an inner container.
		const winTop = window.scrollY;
		rerenderSettingsTab(this);
		const restore = () => {
			scrollers.forEach((s, i) => { s.scrollTop = tops[i]; });
			if (winTop > 0) window.scrollTo(0, winTop);
		};
		restore();
		window.requestAnimationFrame(restore);
		window.setTimeout(restore, 0);
	}

	display(): void {
		// 打开设置即触发一次总笔记数检查：reset 后（换嵌入模型/重索引/重嵌入）
		// 若尚未跑全量扫描，总数会停在 0，RAG 卡片整体显示 0。
		this.ensureTotalNotesSeeded();
		// Abort any in-flight Feishu scan before re-rendering (a fresh QR
		// session is started by the bot tab).
		this.feishuScanHandle?.abort();
		this.feishuScanHandle = null;
		this.indexCardUnsub?.();
		this.indexCardUnsub = null;

		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("smart-vault-settings");
		// 弹窗（编辑供应商等）也会挂 smart-vault-settings 来复用内部样式，
		// "撑满 Tab 容器"的 flex 布局只能作用于设置 Tab 根节点本身——
		// 用这个专属类做作用域，避免把弹窗撑出一大截空白。
		containerEl.addClass("semlink-settings-root");

		// Title heading row: brand text · version · language dropdown (right).
		// Everything rides in the NAME element: heading-mode settings may hide
		// the control area depending on host CSS — the name always renders.
		const title = new Setting(containerEl).setName(t("settingsTitle")).setHeading();
		title.nameEl.addClass("semlink-settings-heading-row");
		// setName already wrote the text into nameEl — clear it before adding
		// the structured children, or the title renders twice. Layout: title
		// with the version stacked under it (left), language far right.
		title.nameEl.empty();
		const titleLeft = title.nameEl.createDiv({ cls: "semlink-settings-heading-left" });
		titleLeft.createSpan({ cls: "semlink-settings-heading-text", text: t("settingsTitle") });
		titleLeft.createSpan({ cls: "semlink-settings-tagline", text: t("settingsTagline") });
		// Language switcher: saveSettings re-runs setLang and refreshes the
		// language-dependent views; display() re-renders this panel so the
		// settings UI itself follows the new language right away.
		// Lang switcher lives as a DIRECT child of the setting-item root
		// (sibling of .setting-item-info) — the root is already a flex row,
		// so margin-left:auto right-aligns it without fighting name widths.
		const langWrap = title.settingEl.createDiv({ cls: "semlink-settings-lang" });
		new DropdownComponent(langWrap)
			.addOptions({
				auto: t("langAuto"),
				...Object.fromEntries(LANGUAGES.map((l) => [l.value, l.label])),
			})
			.setValue(this.plugin.settings.language)
			.onChange(async (value) => {
				this.plugin.settings.language = value as SmartVaultSettings["language"];
				await this.plugin.saveSettings();
				rerenderSettingsTab(this);
			});

		// Tab navigation
		this.renderTabNav(containerEl);

		// Render only the active tab's content
		const panelEl = containerEl.createDiv({ cls: "semlink-settings-panel" });
		switch (this.activeTab) {
			case "general":
				this.renderGeneralTab(panelEl);
				break;
			case "model":
				renderModelsTab(this.plugin, panelEl, this.modelsState, () => this.refreshPreservingScroll());
				break;
			case "mcp":
				this.renderMcpTab(panelEl);
				break;
			case "share":
				this.renderShareTab(panelEl);
				break;
			case "embedding":
				this.renderEmbeddingTab(panelEl);
				break;
			case "bot":
				this.renderBotTab(panelEl);
				break;
		}
	}

	/** 总笔记数补数：换嵌入模型（saveSettings 指纹联动）、重新索引、重新嵌入
	 *  都会 progress.reset()，而换模型只清向量不触发扫库，reset 后
	 *  progress.totalNotes 停在 0 —— 设置页 RAG 卡片的 笔记总数/待索引 与
	 *  两个百分比就全显示 0。与 onload 的种子逻辑同源：只枚举文件清单
	 *  （不入队、不比对 mtime），代价极低；之后的真实扫描会用权威值覆盖。
	 *  totalNotes 非零时零开销，display() 的每次重渲染都可安全重复调用。 */
	private ensureTotalNotesSeeded(): void {
		if (this.plugin.progress.current.totalNotes !== 0) return;
		const seeded = this.plugin.scheduler.countIndexableNotes();
		if (seeded > 0) {
			this.plugin.progress.setTotalNotes(seeded);
			debugLog(`[Semlink] Settings opened: reseeded total notes to ${seeded}`);
		}
	}

	private renderTabNav(containerEl: HTMLElement): void {
		const navEl = containerEl.createDiv({ cls: "semlink-settings-tabs" });
		const tabs: Array<{ id: SettingsTab; label: string }> = [
			{ id: "general", label: t("tabGeneral") },
			{ id: "model", label: t("tabModel") },
			{ id: "embedding", label: t("tabEmbedding") },
			{ id: "mcp", label: t("tabMcp") },
			{ id: "share", label: t("tabShare") },
			// Bot tab deliberately not listed: the Feishu bot is unpublished
			// (freemium-design v3.6). renderBotTab stays available for re-enable.
		];
		for (const tab of tabs) {
			const btn = navEl.createEl("button", {
				cls: "semlink-settings-tab",
				text: tab.label,
			});
			if (tab.id === this.activeTab) btn.addClass("is-active");
			btn.addEventListener("click", () => {
				if (this.activeTab !== tab.id) {
					this.activeTab = tab.id;
					rerenderSettingsTab(this);
				}
			});
		}
	}

	// ══════════════════════════════════════
	// Tab: General — license, language, sidebar entry, support
	// ══════════════════════════════════════
	private renderGeneralTab(containerEl: HTMLElement): void {
		// ── Pro license status + entry (top of General) ──
		this.renderLicenseSection(containerEl);

		// Open the semantic-search sidebar panel.
		// ── 上手清单：状态自动判定，全部完成后整卡收起为完成态 ──
		// （原「快速开始」行已被清单的「开始对话」动作覆盖，不再重复展示）
		this.renderChecklistSection(containerEl);
	}

	/** 通用页的上手清单：对话模型 / 嵌入模型 / 首次问答 / 解锁，四项状态
	 *  均由实时设置与历史推导（无需用户手动打勾）；每项带直达动作。 */
	private renderChecklistSection(containerEl: HTMLElement): void {
		const providers = this.plugin.settings.providers;
		const chatReady = providers.some(
			(p) => !!p.apiKey.trim() && p.models.some((m) => (m.kind ?? "chat") === "chat" && m.enabled === true),
		);
		const embeddingProviders = providers.filter(
			(p) => !!p.apiKey.trim() && p.models.some((m) => (m.kind ?? "chat") === "embedding"),
		);
		const embedKey = this.plugin.settings.embeddingModelKey;
		const embedPid = embedKey.split("::")[0] ?? "";
		const embedReady = embeddingProviders.some(
			(p) => p.id === embedPid && p.models.some((m) => (m.kind ?? "chat") === "embedding" && `${p.id}::${m.id}` === embedKey),
		);
		let firstChatDone = false;

		const card = containerEl.createDiv({ cls: "semlink-checklist" });
		const head = card.createDiv({ cls: "semlink-checklist-head" });
		head.createSpan({ cls: "semlink-checklist-title", text: t("checklistTitle") });
		const progressEl = head.createSpan({ cls: "semlink-checklist-progress" });
		const bar = card.createDiv({ cls: "semlink-checklist-bar" });
		const barFill = bar.createDiv({ cls: "semlink-checklist-bar-fill" });
		const rowsEl = card.createDiv({ cls: "semlink-checklist-rows" });

		const rows: Array<{
			label: string;
			action: string;
			onAction: () => void;
			check: () => boolean;
			rowEl: HTMLElement;
			actionEl: HTMLElement;
			iconEl: HTMLElement;
		}> = [];

		const addRow = (emoji: string, label: string, actionLabel: string, onAction: () => void, check: () => boolean): void => {
			const rowEl = rowsEl.createDiv({ cls: "semlink-checklist-row" });
			const iconEl = rowEl.createSpan({ cls: "semlink-checklist-icon" });
			rowEl.createSpan({ cls: "semlink-checklist-label", text: emoji ? `${emoji} ${label}` : label });
			const actionEl = rowEl.createEl("button", { cls: "semlink-checklist-action", text: actionLabel });
			actionEl.addEventListener("click", onAction);
			rows.push({ label: emoji ? `${emoji} ${label}` : label, action: actionLabel, onAction, check, rowEl, actionEl, iconEl });
		};

		// 前两行「开始配置」：打开右侧面板并触发对应引导（对话/嵌入目录）
		addRow("", t("checklistChat"), t("ragSetupBtn"), () => {
			(this.app as unknown as { setting: { close(): void } }).setting.close();
			void this.plugin.openSetupGuide("chat");
		}, () => chatReady);
		addRow("", t("checklistEmbedding"), t("ragSetupBtn"), () => {
			(this.app as unknown as { setting: { close(): void } }).setting.close();
			void this.plugin.openSetupGuide("embed");
		}, () => embedReady);
		addRow("", t("checklistFirstChat"), t("checklistStartChat"), () => {
			(this.app as unknown as { setting: { close(): void } }).setting.close();
			void this.plugin.activateSearchView();
		}, () => firstChatDone);

		const refresh = (): void => {
			let done = 0;
			for (const r of rows) {
				const d = r.check();
				if (d) done++;
				r.rowEl.toggleClass("is-done", d);
				setIcon(r.iconEl, d ? "check" : "circle");
			}
			progressEl.setText(done === rows.length ? `✓ ${t("checklistDone")}` : `${done}/${rows.length}`);
			barFill.setAttribute("style", `width: ${Math.round((done / rows.length) * 100)}%`);
			card.toggleClass("is-complete", done === rows.length);
		};
		refresh();

		// 首次问答：历史会话里出现真实消息即视为完成（异步补齐该行）
		void this.plugin.historyStore
			.load()
			.then((sessions) => {
				if (sessions.some((s) => s.messages.some((m) => m.role === "user" || m.role === "assistant"))) {
					firstChatDone = true;
					refresh();
				}
			})
			.catch(() => { /* 历史不可用时保持未完成态 */ });
	}

	/** License card, conversion-first: badge + headline + one-line free
	 *  reassurance, price anchor card ($3 vs struck $19.9, lifetime), and a
	 *  quiet key row. No prose — the price does the talking. */
	private renderLicenseSection(containerEl: HTMLElement): void {
		const lm = this.plugin.licenseManager;
		const pro = lm.isPro();

		const card = containerEl.createDiv({ cls: "semlink-license-card" });
		const head = card.createDiv({ cls: "semlink-license-card-head" });
		const logo = head.createSpan({ cls: "semlink-license-card-logo" });
		setIcon(logo, "semlink-logo");
		head.createSpan({ cls: "semlink-license-card-title", text: "Semlink Pro" });
		if (pro) {
			head.createSpan({ cls: "semlink-license-card-pro-pill", text: `✓ ${t("licenseProActive")}` });
		} else {
			head.createSpan({ cls: "semlink-license-card-badge", text: t("licenseBadge") });
		}

		if (pro) {
			// Pro state, Eagle-style: big congrats + thanks, one quiet footer
			// row (lifetime note · deactivate as a subtle action).
			card.createDiv({ cls: "semlink-license-card-headline", text: t("licenseProHeadline") });
			card.createDiv({ cls: "semlink-license-card-freeline", text: t("openSidebarDesc") });

			const foot = card.createDiv({ cls: "semlink-license-card-footrow" });
			foot.createSpan({ cls: "semlink-license-card-lifetime", text: `♾️ ${t("licenseLifetime")}` });

			const de = foot.createEl("button", { cls: "semlink-license-card-deactivate", text: t("licenseDeactivate") });
			de.addEventListener("click", () => {
				// Deactivate kicks the device out of Pro immediately — confirm first.
				new ConfirmModal(this.app, t("licenseDeactivate"), t("licenseDeactivateConfirmBody"), () => void (async () => {
					if (de.dataset.busy === "1") return;
					de.dataset.busy = "1";
					de.setAttr("disabled", "true");
					de.addClass("is-busy");
					try {
						await lm.deactivate();
						new Notice(t("licenseDeactivated"));
						rerenderSettingsTab(this);
					} catch (e) {
						new Notice(licenseErrorMessage(e));
					} finally {
						de.dataset.busy = "";
						de.removeClass("is-busy");
						de.removeAttribute("disabled");
					}
				})()).open();
			});
			return;
		}

		card.createDiv({
			cls: "semlink-license-card-headline",
			text: t("licenseCardHeadline"),
		});
		card.createDiv({ cls: "semlink-license-card-freeline", text: t("licenseCardFreeLine") });

		{
			const inner = card.createDiv({ cls: "semlink-license-card-inner" });
			const priceRow = inner.createDiv({ cls: "semlink-license-card-pricerow" });
			priceRow.createSpan({ cls: "semlink-license-card-price", text: "$3" });
			priceRow.createSpan({ cls: "semlink-license-card-was", text: "$19.9" });
			priceRow.createSpan({ cls: "semlink-license-card-lifetime", text: t("licenseCardLifetime") });

			const actions = inner.createDiv({ cls: "semlink-license-card-actions" });
			if (!lm.configured) {
				actions.createSpan({ cls: "semlink-license-card-note", text: t("licenseNotConfigured") });
			} else {
				const buyBtn = actions.createEl("button", { cls: "semlink-license-card-apply mod-cta", text: t("licenseCardCta") });
				buyBtn.addEventListener("click", () => void (async () => {
					if (buyBtn.dataset.busy === "1") return;
					buyBtn.dataset.busy = "1";
					try {
						window.open(await lm.openCheckout(), "_blank");
					} catch {
						new Notice(t("upgradeCheckoutUnavailable"));
					} finally {
						buyBtn.dataset.busy = "";
					}
				})());
			}
		}

		// Quiet key row (Free): paste key + Activate.
		const keyRow = card.createDiv({ cls: "semlink-license-card-keyrow" });
		{
			const input = keyRow.createEl("input", {
				cls: "semlink-license-card-input",
				attr: { type: "text", placeholder: t("licenseKeyPlaceholder"), spellcheck: "false" },
			});
			const apply = keyRow.createEl("button", { cls: "semlink-license-card-apply", text: t("licenseActivate") });
			const activate = () => void (async () => {
				const key = input.value.trim();
				if (!key || apply.dataset.busy === "1") return;
				apply.dataset.busy = "1";
				apply.setAttr("disabled", "true");
				apply.addClass("is-busy");
				try {
					await lm.activate(key);
					new Notice(t("licenseActivated"));
					rerenderSettingsTab(this);
				} catch (e) {
					new Notice(licenseErrorMessage(e));
				} finally {
					apply.dataset.busy = "";
					apply.removeClass("is-busy");
					apply.removeAttribute("disabled");
				}
			})();
			apply.addEventListener("click", activate);
			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					activate();
				}
			});
		}
	}

	// ══════════════════════════════════════
	// Tab: Embedding (RAG) — status, model, index controls, rebuild
	// ══════════════════════════════════════
	/** RAG 页的两个进度面板：索引进度（阶段/待索引/已索引）与嵌入进度
	 *  （待嵌入/已嵌入/嵌入率）。数据由进度事件与数据库统计双路刷新。 */
	private renderIndexCard(containerEl: HTMLElement): void {
		const row = (host: HTMLElement, label: string): HTMLElement => {
			const r = host.createDiv({ cls: "semlink-index-card-row" });
			r.createSpan({ cls: "semlink-index-card-label", text: label });
			return r.createSpan({ cls: "semlink-index-card-value" });
		};
		// ── 双面板容器：左右并列（窄幅自动堆叠） ──
		const panelsWrap = containerEl.createDiv({ cls: "semlink-index-panels" });
		// ── 面板 1：索引进度（索引率并入标题，如「索引进度：100%」） ──
		const indexPanel = panelsWrap.createDiv({ cls: "semlink-index-card" });
		const iHead = indexPanel.createDiv({ cls: "semlink-index-card-head" });
		const iTitleEl = iHead.createSpan({ cls: "semlink-index-card-title", text: t("indexProgressTitle") });
		// 标题右侧开关 = 索引总开关（与下方「自动索引」行同一设置）：
		// 关 = 停止文件监听并暂停当前索引；开 = 恢复监听并继续/重启索引。
		const indexToggle = new ToggleComponent(iHead);
		indexToggle.toggleEl.addClass("semlink-index-card-toggle");
		indexToggle.toggleEl.setAttr("aria-label", t("autoIndex"));
		indexToggle
			.setValue(this.plugin.settings.autoIndex)
			.onChange(async (value) => {
				this.plugin.settings.autoIndex = value;
				this.plugin.watcher.setAutoIndex(value);
				await this.plugin.saveSettings();
				if (value) this.plugin.scheduler.resume();
				else this.plugin.scheduler.pause();
				this.refreshPreservingScroll();
			});
		const totalEl = row(indexPanel, t("guideStatTotalNotes"));
		const awaitingEl = row(indexPanel, t("awaitingChunking"));
		const chunkedEl = row(indexPanel, t("chunkedNotes"));

		// ── 面板 2：嵌入进度（嵌入率并入标题，如「嵌入进度：100%」） ──
		const embedPanel = panelsWrap.createDiv({ cls: "semlink-index-card" });
		const eHead = embedPanel.createDiv({ cls: "semlink-index-card-head" });
		const eTitleEl = eHead.createSpan({ cls: "semlink-index-card-title", text: t("embedProgressTitle") });
		// 标题右侧开关 = 自动嵌入总开关。调度器实时读取该设置：关 = 在跑的
		// 索引继续分块、后续笔记不再调嵌入 API；开 = 后续笔记恢复嵌入。
		const embedToggle = new ToggleComponent(eHead);
		embedToggle.toggleEl.addClass("semlink-index-card-toggle");
		embedToggle.toggleEl.setAttr("aria-label", t("autoEmbed"));
		embedToggle
			.setValue(this.plugin.settings.autoEmbed ?? true)
			.onChange(async (value) => {
				this.plugin.settings.autoEmbed = value;
				await this.plugin.saveSettings();
				this.refreshPreservingScroll();
			});
		const modelEl = row(embedPanel, t("ragSemantic"));
		const providerEl = row(embedPanel, t("guideStep1"));
		const vectorizedEl = row(embedPanel, t("vectorizedChunks"));
		// 当前行：正在使用的嵌入模型 + 供应商（未配置显示 —）
		const embedKey = this.plugin.settings.embeddingModelKey || "";
		const ePid = embedKey.split("::")[0] ?? "";
		const eMid = embedKey.split("::").slice(1).join("::");
		const eProv = this.plugin.settings.providers.find((p) => p.id === ePid);
		const eModel = eProv?.models.find((m) => (m.kind ?? "chat") === "embedding" && m.id === eMid);
		modelEl.setText(eProv && eModel ? eModel.id : "—");
		providerEl.setText(eProv && eModel ? eProv.name : "—");

		// 待索引 = 总笔记数 - 已索引（与已索引同源，数据库口径）；
		// apply 用最近一次查到的已索引数做即时倒计时，查库后校正。
		let lastIndexed = 0;
		const apply = (p: IndexProgress): void => {
			awaitingEl.setText(Math.max(0, p.totalNotes - lastIndexed).toLocaleString());
		};
		// 两面板的数值行取数据库真实状态（笔记数），百分比并入标题：
		// 索引进度 = 已索引 / 总笔记数；嵌入进度 = 已嵌入 / 总笔记数。
		// 已嵌入口径 = 至少一个 chunk 带向量的笔记数（getEmbeddedNoteCount），
		// 不读 note_doc_vectors——该表会被算法迁移/换模型清空重建，迁移期恒
		// 为 0；chunk 向量与笔记嵌入同事务落库，进度只增不减。
		// 百分比封顶 100%：重扫进行中 totalNotes 尚未补全时会短暂偏小。
		// 首查常见于插件刚加载、DB worker 尚在初始化——失败不能静默吞掉
		// （空闲时没有进度事件来重试），退避重试直到 worker 就绪补上数值。
		let statsRetryTimer: number | null = null;
		// CJK 文案用全角冒号，其余语言半角
		const sep = ["zh", "zh-Hant", "ja"].includes(getLang()) ? "：" : ": ";
		const rateText = (num: number, denom: number): string =>
			denom > 0 ? `${Math.min(100, (num / denom) * 100).toFixed(1)}%` : "0%";
		const refreshStats = async (attempt = 0): Promise<void> => {
			try {
				const [s, embeddedNotes] = await Promise.all([
					this.plugin.store.getStats(),
					this.plugin.store.getEmbeddedNoteCount(),
				]);
				lastIndexed = s.indexedNotes;
				chunkedEl.setText(s.indexedNotes.toLocaleString());
				const total = Math.max(0, this.plugin.progress.current.totalNotes);
				totalEl.setText(total.toLocaleString());
				const awaiting = Math.max(0, total - s.indexedNotes);
				awaitingEl.setText(awaiting.toLocaleString());
				iTitleEl.setText(`${t("indexProgressTitle")}${sep}${rateText(s.indexedNotes, total)}`);
				vectorizedEl.setText(embeddedNotes.toLocaleString());
				eTitleEl.setText(`${t("embedProgressTitle")}${sep}${rateText(embeddedNotes, total)}`);
			} catch (e) {
				if (attempt >= 8) {
					console.warn("[Semlink] index stats unavailable:", e);
					return;
				}
				statsRetryTimer = window.setTimeout(() => void refreshStats(attempt + 1), 1000 * (attempt + 1));
			}
		};
		apply(this.plugin.progress.current);
		void refreshStats();

		// 单一合并订阅：索引进度事件实时刷新待索引 + 数值行节流查库（≤1s 一次）
		let lastEmbedRefresh = 0;
		const unIndex = this.plugin.progress.onProgress((e) => {
			if (e.type !== "progress") return;
			apply(e.progress);
			const now = Date.now();
			if (now - lastEmbedRefresh >= 1000) {
				lastEmbedRefresh = now;
				void refreshStats();
			}
		});
		this.indexCardUnsub = () => {
			unIndex();
			if (statsRetryTimer != null) window.clearTimeout(statsRetryTimer);
		};
	}

	private renderEmbeddingTab(containerEl: HTMLElement): void {
		// ── 索引进度卡片（实时指标） ──
		this.renderIndexCard(containerEl);

		// 嵌入供应商:配置了 Key 且带有嵌入模型的供应商
		const embeddingProviders = this.plugin.settings.providers.filter(
			(p) => !!p.apiKey.trim() && p.models.some((m) => (m.kind ?? "chat") === "embedding"),
		);

		// ── Semantic search 行：按钮打开侧栏的配置引导（供应商/模型/嵌入） ──
		// 已配置时描述显示当前模型；未配置时显示提示语。
		const currentKey = this.plugin.settings.embeddingModelKey;
		const keyPid = currentKey.split("::")[0] ?? "";
		const keyMid = currentKey.split("::").slice(1).join("::");
		const configuredProvider = embeddingProviders.find((p) => p.id === keyPid);
		const configuredModel = configuredProvider?.models.find(
			(m) => (m.kind ?? "chat") === "embedding" && m.id === keyMid,
		);
		new Setting(containerEl)
			.setName(t("ragSemantic"))
			.setDesc(configuredProvider && configuredModel
				? `${configuredModel.id} · ${configuredProvider.name}`
				: t("ragSemanticHint"))
			.addButton((btn) =>
				btn.setButtonText(t("ragSetupBtn")).onClick(() => {
					// 关闭设置页，打开侧边栏的向量检索配置引导
					// （选嵌入供应商、嵌入模型，然后是咖啡杯嵌入进度）。
					(this.app as unknown as { setting: { close(): void } }).setting.close();
					void this.plugin.openSetupGuide("embed");
				})
			);


		// ── 索引控制（原 Index 页签并入）：排除路径（自动索引开关
		//    已上移为索引进度面板标题右侧的开关） ──
		new Setting(containerEl)
			.setName(t("excludePaths"))
			.setDesc(t("excludePathsDesc"))
			.addButton((btn) =>
				btn.setButtonText(t("configure")).onClick(() => {
					new ExcludePathsModal(this.app, this.plugin).open();
				})
			);

		// ── 重新索引（原在高级选项末尾，移到排除路径下方常驻可见）：
		//    清掉所有索引（含分块），从 0 开始重新分块。破坏性操作带确认。 ──
		new Setting(containerEl)
			.setName(t("reindexAll"))
			.setDesc(t("reindexAllDesc"))
			.addButton((btn) => {
				btn.setButtonText(t("reindexAll"));
				markDestructive(btn).onClick(() => {
					new ConfirmModal(this.app, t("reindexAll"), t("reindexConfirm"), () => {
						void this.plugin.reindexAll();
					}).open();
				});
			});

		// ── 高级选项（默认收起）：分块 / 批量 / 延迟 / 并发 ──
		const advHead = containerEl.createDiv({ cls: "semlink-editor-adv-head" });
		const chev = advHead.createSpan({ cls: "semlink-editor-adv-chevron" });
		setIcon(chev, "chevron-right");
		const advLabel = advHead.createSpan({ cls: "semlink-editor-adv-label", text: t("editorAdvancedShow") });
		const advBody = containerEl.createDiv({ cls: "semlink-editor-adv-body semlink-hidden" });
		advHead.addEventListener("click", () => {
			const open = !advBody.hasClass("semlink-hidden");
			advBody.toggleClass("semlink-hidden", open);
			setIcon(chev, open ? "chevron-right" : "chevron-down");
			advLabel.setText(t(open ? "editorAdvancedShow" : "editorAdvancedHide"));
		});


		// 切块参数（改动后需重建索引）
		new Setting(advBody)
			.setName(t("chunkSize"))
			.setDesc(t("chunkSizeDesc"))
			.addSlider((slider) => {
				showSliderValue(slider.setLimits(200, 2000, 100).setValue(this.plugin.settings.chunkSize));
				return slider.onChange(async (value) => {
					this.plugin.settings.chunkSize = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(advBody)
			.setName(t("chunkOverlap"))
			.setDesc(t("chunkOverlapDesc"))
			.addSlider((slider) => {
				showSliderValue(slider.setLimits(0, 500, 50).setValue(this.plugin.settings.chunkOverlap));
				return slider.onChange(async (value) => {
					this.plugin.settings.chunkOverlap = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(advBody)
			.setName(t("batchSize"))
			.setDesc(t("batchSizeDesc"))
			.addSlider((slider) => {
				showSliderValue(slider.setLimits(1, 128, 1).setValue(this.plugin.settings.batchSize));
				return slider.onChange(async (value) => {
					this.plugin.settings.batchSize = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(advBody)
			.setName(t("requestDelay"))
			.setDesc(t("requestDelayDesc"))
			.addSlider((slider) => {
				showSliderValue(slider.setLimits(0, 1000, 50).setValue(this.plugin.settings.requestDelayMs));
				return slider.onChange(async (value) => {
					this.plugin.settings.requestDelayMs = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(advBody)
			.setName(t("embedConcurrency"))
			.setDesc(t("embedConcurrencyDesc"))
			.addSlider((slider) => {
				showSliderValue(slider.setLimits(1, 5, 1).setValue(this.plugin.settings.embedConcurrency ?? 2));
				return slider.onChange(async (value) => {
					this.plugin.settings.embedConcurrency = value;
					await this.plugin.saveSettings();
				});
			});
	}

	// ══════════════════════════════════════
	// Tab: MCP — single semlink server card with a run toggle
	// ══════════════════════════════════════
	private renderMcpTab(containerEl: HTMLElement): void {
		const running = !!this.plugin.mcpServer;
		const mcpUrl = `http://127.0.0.1:${this.plugin.settings.mcpPort}/mcp`;

		// ── Installed 行：数量统计 + New 按钮 ──
		const installedHead = containerEl.createDiv({ cls: "semlink-mcp-installed-head" });
		installedHead.createSpan({
			cls: "semlink-mcp-installed-title",
			text: t("mcpInstalled"),
		});
		// 免费版最多 2 个外部 MCP Server，授权版无限（clientServers 在下方渲染）
		const FREE_MCP_LIMIT = 2;
		const clientServers = this.plugin.settings.mcpClientServers ?? [];
		const atFreeLimit = !this.plugin.licenseManager.isPro() && clientServers.length >= FREE_MCP_LIMIT;
		// 新增外部 MCP Server 的入口暂时隐藏（功能保留：置回 true 即恢复）
		const mcpNewEnabled = false;
		const newBtn = installedHead.createEl("button", {
			cls: "semlink-mcp-new-btn",
			text: "＋ " + t("mcpNew"),
		});
		newBtn.toggleClass("semlink-hidden", !mcpNewEnabled);
		newBtn.addEventListener("click", () => {
			if (atFreeLimit) {
				new LicenseModal(this.app, this.plugin).open();
				return;
			}
			new McpServerConfigModal(this.app, this.plugin, null, () => rerenderSettingsTab(this)).open();
		});

		// ── 内置 semlink 服务器卡片：不可增删改，右侧开关启停服务 ──
		let list = containerEl.createDiv({ cls: "semlink-mcp-list" });
		const card = list.createDiv({ cls: "semlink-mcp-server" });
		const iconWrap = card.createDiv({
			cls: "semlink-mcp-server-icon",
			attr: { title: running ? t("mcpRunning") : t("mcpStopped") },
		});
		setIcon(iconWrap, "semlink-logo");
		// 运行中显示绿色状态点（右下角）；图标始终为 Semlink 紫
		if (running) {
			iconWrap.createSpan({ cls: "semlink-mcp-server-dot" });
		}
		const main = card.createDiv({ cls: "semlink-mcp-server-main" });
		main.createDiv({ cls: "semlink-mcp-server-name", text: "semlink" });
		main.createDiv({ cls: "semlink-mcp-server-sub", text: `http · ${mcpUrl}` });
		// 分享按钮：开关左侧，把 semlink MCP 接入第三方客户端的说明
		const shareBtn = card.createEl("button", {
			cls: "semlink-mcp-icon-btn",
			attr: { "aria-label": t("mcpShareTitle"), title: t("mcpShareTitle") },
		});
		setIcon(shareBtn, "share-2");
		shareBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			new McpShareModal(this.app, this.plugin).open();
		});
		const toggleWrap = card.createDiv({ cls: "semlink-mcp-server-toggle" });
		new ToggleComponent(toggleWrap)
			.setValue(running)
			.onChange(async (v) => {
				// 开关状态持久化：重启 Obsidian 后保持用户选择
				this.plugin.settings.mcpEnabled = v;
				await this.plugin.saveSettings();
				if (v) await this.plugin.startMcpServer();
				else await this.plugin.stopMcpServer();
				rerenderSettingsTab(this);
			});
		// 点击卡片（避开开关与分享按钮）打开配置编辑弹窗
		card.addEventListener("click", (e) => {
			if ((e.target as HTMLElement).closest(".semlink-mcp-server-toggle")) return;
			if ((e.target as HTMLElement).closest(".semlink-mcp-icon-btn")) return;
			new EditMcpServerModal(this.app, this.plugin, () => rerenderSettingsTab(this)).open();
		});

		// ── 内置 semlink-debug 服务器卡片：ask 单工具，问答端到端测试。
		//    默认关闭（严格 opt-in），并收进「高级选项」折叠区——调试工具
		//    只面向开发者，不该占据普通用户的视线。 ──
		const debugAdvHead = containerEl.createDiv({ cls: "semlink-editor-adv-head" });
		const debugChev = debugAdvHead.createSpan({ cls: "semlink-editor-adv-chevron" });
		setIcon(debugChev, "chevron-right");
		const debugAdvLabel = debugAdvHead.createSpan({ cls: "semlink-editor-adv-label", text: t("editorAdvancedShow") });
		const debugAdvBody = containerEl.createDiv({ cls: "semlink-editor-adv-body semlink-hidden" });
		debugAdvHead.addEventListener("click", () => {
			const open = !debugAdvBody.hasClass("semlink-hidden");
			debugAdvBody.toggleClass("semlink-hidden", open);
			setIcon(debugChev, open ? "chevron-right" : "chevron-down");
			debugAdvLabel.setText(t(open ? "editorAdvancedShow" : "editorAdvancedHide"));
		});
		list = debugAdvBody;
		const debugRunning = !!this.plugin.debugMcpServer;
		const debugCard = list.createDiv({ cls: "semlink-mcp-server" });
		const dIconWrap = debugCard.createDiv({
			cls: "semlink-mcp-server-icon",
			attr: { title: debugRunning ? t("mcpRunning") : t("mcpStopped") },
		});
		setIcon(dIconWrap, "bug");
		if (debugRunning) {
			dIconWrap.createSpan({ cls: "semlink-mcp-server-dot" });
		}
		const dMain = debugCard.createDiv({ cls: "semlink-mcp-server-main" });
		dMain.createDiv({ cls: "semlink-mcp-server-name", text: "semlink-debug" });
		dMain.createDiv({
			cls: "semlink-mcp-server-sub",
			text: `http · http://127.0.0.1:${this.plugin.settings.debugMcpPort ?? 3002}/mcp · ask · reload`,
		});
		const dToggleWrap = debugCard.createDiv({ cls: "semlink-mcp-server-toggle" });
		new ToggleComponent(dToggleWrap)
			.setValue(this.plugin.settings.debugMcpEnabled === true)
			.onChange(async (v) => {
				this.plugin.settings.debugMcpEnabled = v;
				await this.plugin.saveSettings();
				if (v) await this.plugin.startDebugMcpServer();
				else await this.plugin.stopDebugMcpServer();
				rerenderSettingsTab(this);
			});

		// ── 外部 MCP 服务器：可增删改（管理层；运行时接入后续扩展） ──
		if (clientServers.length > 0) {
			const clientList = containerEl.createDiv({ cls: "semlink-mcp-list" });
			for (const s of clientServers) {
				const c = clientList.createDiv({ cls: "semlink-mcp-server" });
				const cIcon = c.createDiv({ cls: "semlink-mcp-server-icon" });
				setIcon(cIcon, "plug-zap");
				const cMain = c.createDiv({ cls: "semlink-mcp-server-main" });
				cMain.createDiv({ cls: "semlink-mcp-server-name", text: s.name });
				cMain.createDiv({
					cls: "semlink-mcp-server-sub",
					text: `${s.type} · ${s.type === "stdio" ? s.command : s.url}`,
				});
				const cToggle = c.createDiv({ cls: "semlink-mcp-server-toggle" });
				new ToggleComponent(cToggle).setValue(s.enabled).onChange((v) => {
					s.enabled = v;
					void this.plugin.saveSettings();
				});
				c.addEventListener("click", (e) => {
					if ((e.target as HTMLElement).closest(".semlink-mcp-server-toggle")) return;
					new McpServerConfigModal(this.app, this.plugin, s, () => rerenderSettingsTab(this)).open();
				});
			}
		}

		// 免费版达到 MCP Server 上限：显示 Pro 门禁（同 Bot 页签的解锁卡）
		if (mcpNewEnabled && atFreeLimit) {
			const gate = containerEl.createDiv({ cls: "semlink-pro-gate" });
			gate.createSpan({ cls: "semlink-pro-badge", text: "✨ Pro" });
			gate.createSpan({ cls: "semlink-pro-gate-text", text: t("mcpFreeLimitDesc") });
			const unlockBtn = gate.createEl("button", { cls: "mod-cta", text: t("unlockPro") });
			unlockBtn.addEventListener("click", () => {
				new LicenseModal(this.app, this.plugin).open();
			});
		}
	}

	// ══════════════════════════════════════
	// Tab: Bot — Feishu bots bound to Semlink
	// ══════════════════════════════════════
	/** Tab: Share — manage the conversations published to the LAN. Each row:
	 *  conversation title, share URL, an on/off pause switch and a delete
	 *  button. Paused links 404 but survive; deleted links are gone for good. */
	private renderShareTab(containerEl: HTMLElement): void {
		// Same head style as the MCP tab's "MCP Server" row.
		const head = containerEl.createDiv({ cls: "semlink-mcp-installed-head" });
		head.createSpan({ cls: "semlink-mcp-installed-title", text: t("shareTabTitle") });
		const server = this.plugin.shareServer;
		const shares = server.listShares();
		if (shares.length === 0) {
			containerEl.createDiv({ cls: "semlink-share-tab-empty", text: t("shareEmpty") });
			return;
		}

		const list = containerEl.createDiv({ cls: "semlink-mcp-list" });
		void (async () => {
			const sessions = await this.plugin.historyStore.load();
			const titleOf = (sessionId: string): string => {
				// Note shares (`note:<path>` keys) title by the note's file name.
				if (sessionId.startsWith("note:")) {
					const p = sessionId.slice("note:".length);
					const f = this.plugin.app.vault.getAbstractFileByPath(p);
					return f ? f.name : p.split("/").pop() || p;
				}
				const st = sessions.find((x) => x.id === sessionId);
				return st?.title || st?.messages.find((m) => m.role === "user")?.content || t("shareUntitled");
			};
			// Sorted: live shares first, then paused; newest session first.
			const rows = shares
				.map((entry) => ({ ...entry, title: titleOf(entry.sessionId) }))
				.sort((a, b) => b.sessionId.localeCompare(a.sessionId));
			list.empty();
			for (const row of rows) {
				// Same card anatomy as the MCP tab: icon, title+FULL-URL main,
				// then copy / QR / open / delete + toggle on the right edge.
				const item = list.createDiv({ cls: "semlink-mcp-server" });
				const icon = item.createDiv({ cls: "semlink-mcp-server-icon" });
				// Note shares get the file-text mark, chats keep share-2.
				setIcon(icon, row.sessionId.startsWith("note:") ? "file-text" : "share-2");
				const main = item.createDiv({ cls: "semlink-mcp-server-main" });
				main.createDiv({ cls: "semlink-mcp-server-name", text: row.title });
				const url = server.urls(row.token)[0];
				main.createDiv({ cls: "semlink-mcp-server-sub", text: url });

				const actions = item.createDiv({ cls: "semlink-mcp-server-actions" });

				// Revoke + drop the row; both the trash button and the QR
				// dialog's "Stop sharing" go through here. The list re-renders
				// to the empty hint once the last row is gone.
				const removeRow = (): void => {
					server.revokeToken(row.token);
					item.remove();
					if (list.children.length === 0) rerenderSettingsTab(this);
				};

				const qrBtn = actions.createEl("button", { cls: "semlink-mcp-icon-btn", attr: { "aria-label": t("shareQrCode"), title: t("shareQrCode") } });
				setIcon(qrBtn, "qr-code");
				qrBtn.addEventListener("click", () => {
					// Same dialog as the chat share button: QR + copy +
					// open-in-browser + stop sharing. Stopping sharing there
					// removes this row too (the modal shows the notice).
					new ShareQrModal(this.app, {
						url,
						onRevoke: removeRow,
					}).open();
				});

				const openBtn = actions.createEl("button", { cls: "semlink-mcp-icon-btn", attr: { "aria-label": t("shareOpenBrowser"), title: t("shareOpenBrowser") } });
				setIcon(openBtn, "external-link");
				openBtn.addEventListener("click", () => {
					window.open(url, "_blank");
				});

				const delBtn = actions.createEl("button", { cls: "semlink-mcp-icon-btn", attr: { "aria-label": t("shareDelete") } });
				setIcon(delBtn, "trash-2");
				delBtn.addEventListener("click", () => {
					removeRow();
					new Notice(t("shareDeleted"));
				});

			}
		})();
	}

	private renderBotTab(containerEl: HTMLElement): void {
		new Setting(containerEl).setName(t("botSection")).setHeading();

		// Pro gate (docs/freemium-design.md §3D): the bot surface stays
		// visible-but-locked on the free tier — one badge row + upgrade entry,
		// no bots are started at runtime (syncFeishuBots checks isPro).
		if (!this.plugin.licenseManager.isPro()) {
			const gate = containerEl.createDiv({ cls: "semlink-pro-gate" });
			gate.createSpan({ cls: "semlink-pro-badge", text: "✨ Pro" });
			gate.createSpan({ cls: "semlink-pro-gate-text", text: t("botProDesc") });
			const btn = gate.createEl("button", { cls: "mod-cta", text: t("unlockPro") });
			btn.addEventListener("click", () => {
				new LicenseModal(this.app, this.plugin).open();
			});
			return;
		}

		containerEl.createDiv({ cls: "feishu-prereq", text: t("botPrereq") });

		const bots = this.plugin.settings.feishuBots;
		if (bots.length === 0) {
			containerEl.createDiv({ cls: "feishu-empty", text: t("botEmpty") });
		}

		for (let i = 0; i < bots.length; i++) {
			const bot = bots[i];
			const status = bot.connected ? t("botStatusConnected") : t("botStatusDisconnected");
			let desc = `${t("botAppId")}: ${bot.appId} · ${t("botStatus")}: ${status}`;
			if (bot.bound) {
				desc += ` · ${t("botBound")}`;
			} else if (bot.bindCode) {
				desc += ` · ${t("botBindPending")}（${t("botBindHint").replace("{code}", bot.bindCode)}）`;
			}
			if (bot.lastError) desc += ` · ${bot.lastError}`;

			new Setting(containerEl)
				.setName(bot.name || bot.appId)
				.setDesc(desc)
				.addToggle((toggle) =>
					toggle
						.setValue(bot.enabled)
						.onChange(async (value) => {
							bot.enabled = value;
							await this.plugin.saveSettings();
							rerenderSettingsTab(this);
						})
				)
				.addExtraButton((btn) => {
					btn.setIcon("trash").setTooltip(t("botDelete")).onClick(async () => {
						bots.splice(i, 1);
						await this.plugin.saveSettings();
						rerenderSettingsTab(this);
					});
				});
		}

		// Inline scan-to-add section: the QR appears directly in the settings
		// page and the user scans it with the Feishu app.
		new Setting(containerEl).setName(t("botAddScan")).setHeading();
		this.renderFeishuScan(containerEl);

		// Manual entry as an alternative.
		new Setting(containerEl).addButton((btn) => {
			btn.setButtonText(t("botAddManual")).onClick(() => {
				new AddFeishuBotModal(this.app, this.plugin, () => rerenderSettingsTab(this)).open();
			});
		});
	}

	/** Show the scan QR inline and bind the created app when scanned. */
	private renderFeishuScan(container: HTMLElement): void {
		const box = container.createDiv({ cls: "feishu-scan-box" });
		const statusEl = box.createDiv({ cls: "feishu-scan-status", text: t("botScanWaiting") });

		this.feishuScanHandle?.abort();
		this.feishuScanHandle = startFeishuRegister(
			"Semlink",
			(url) => {
				void QRCode.toDataURL(url, { width: 200, margin: 1 }).then((dataUrl) => {
					if (!box.isConnected) return;
					box.createEl("img", { cls: "feishu-qr", attr: { src: dataUrl, alt: "QR" } });
					statusEl.setText(t("botScanHint"));
				}).catch(() => {
					statusEl.setText(t("botScanError"));
				});
			},
			(status) => {
				statusEl.setText(`${t("botScanWaiting")} (${status})`);
			},
		);

		this.feishuScanHandle.promise
			.then(async (res) => {
				// One-time bind code: the user confirms the binding in Feishu by
				// sending `/bind <code>` to the bot (ZCode-style flow).
				const bindCode = Math.random().toString(36).slice(2, 8).toUpperCase();
				this.plugin.settings.feishuBots.push({
					id: `bot-${Date.now()}`,
					name: res.userName || "Feishu Bot",
					appId: res.appId,
					appSecret: res.appSecret,
					userOpenId: res.userOpenId,
					bindCode,
					bound: false,
					enabled: true,
					connected: false,
				});
				await this.plugin.saveSettings();
				new Notice(`${t("botSaved")} · ${t("botBindHint").replace("{code}", bindCode)}`);
				rerenderSettingsTab(this);
			})
			.catch((e) => {
				if (!box.isConnected) return;
				const msg = e instanceof Error ? e.message : String(e);
				statusEl.setText(`${t("botScanError")}: ${msg}`);
			});
	}
}


/** "Edit MCP server" 配置弹窗（参照 Cherry Studio）：Form/JSON 双视图。
 *  Form 视图可编辑端口与访问 Key；JSON 视图为生成的客户端接入配置。
 *  保存后若服务正在运行则自动重启使新配置生效。 */
class EditMcpServerModal extends Modal {
	constructor(
		app: App,
		private plugin: SmartVaultPlugin,
		private onSaved: () => void,
	) {
		super(app);
		this.modalEl.addClass("semlink-mcp-edit-modal");
		this.modalEl.addClass("smart-vault-settings");
	}

	onOpen(): void {
		this.titleEl.setText(t("editMcpServer"));
		const { contentEl } = this;
		contentEl.createDiv({ cls: "semlink-mcp-edit-desc", text: t("editMcpServerDesc") });

		let port = this.plugin.settings.mcpPort;
		let apiKey = this.plugin.settings.mcpApiKey;
		const buildJson = (): string => {
			const url = `http://127.0.0.1:${port}/mcp`;
			return JSON.stringify(
				{
					semlink: {
						type: "http",
						url,
						...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
					},
				},
				null,
				2,
			);
		};

		// ── Form / JSON 切换（右上角分段控件） ──
		const segRow = contentEl.createDiv({ cls: "semlink-mcp-edit-segrow" });
		const seg = segRow.createDiv({ cls: "semlink-mcp-edit-seg" });
		const formBtn = seg.createEl("button", { cls: "is-active", text: "Form" });
		const jsonBtn = seg.createEl("button", { text: "JSON" });

		const formView = contentEl.createDiv({ cls: "semlink-mcp-edit-form" });
		const jsonView = contentEl.createDiv({ cls: "semlink-mcp-edit-json semlink-hidden" });
		const jsonArea = jsonView.createEl("textarea", { cls: "semlink-monospace" });
		jsonArea.rows = 12;
		jsonArea.readOnly = true;
		jsonArea.value = buildJson();

		const syncJson = (): void => {
			jsonArea.value = buildJson();
		};

		// ── Form 字段：端口 / 访问 Key ──
		formView.createDiv({ cls: "semlink-editor-field-label", text: t("mcpPort") });
		const portInput = formView.createEl("input", {
			cls: "semlink-editor-input",
			attr: { type: "text", placeholder: "3001", spellcheck: "false" },
		});
		portInput.value = String(port);
		portInput.addEventListener("input", () => {
			const parsed = parseInt(portInput.value, 10);
			port = isNaN(parsed) || parsed <= 0 || parsed >= 65536 ? this.plugin.settings.mcpPort : parsed;
			syncJson();
		});

		formView.createDiv({ cls: "semlink-editor-field-label", text: t("mcpAccessKey") });
		const keyInput = formView.createEl("input", {
			cls: "semlink-editor-input",
			attr: { type: "text", spellcheck: "false" },
		});
		keyInput.value = apiKey;
		keyInput.addEventListener("input", () => {
			apiKey = keyInput.value;
			syncJson();
		});

		const setView = (json: boolean): void => {
			formView.toggleClass("semlink-hidden", json);
			jsonView.toggleClass("semlink-hidden", !json);
			formBtn.toggleClass("is-active", !json);
			jsonBtn.toggleClass("is-active", json);
		};
		formBtn.addEventListener("click", () => setView(false));
		jsonBtn.addEventListener("click", () => setView(true));

		// ── Footer：右侧 Save / Cancel ──
		const footer = contentEl.createDiv({ cls: "semlink-editor-footer is-simple" });
		const cancelBtn = footer.createEl("button", { cls: "semlink-editor-cancel-btn", text: t("cancel") });
		cancelBtn.addEventListener("click", () => this.close());
		const saveBtn = footer.createEl("button", { cls: "semlink-editor-save-btn", text: t("editorSave") });

		const error = contentEl.createDiv({ cls: "semlink-guide-error semlink-hidden" });

		saveBtn.addEventListener("click", () => {
			const parsed = parseInt(portInput.value, 10);
			if (isNaN(parsed) || parsed <= 0 || parsed >= 65536) {
				error.setText(t("mcpPortInvalid"));
				error.removeClass("semlink-hidden");
				return;
			}
			const persist = async (): Promise<void> => {
				this.plugin.settings.mcpPort = parsed;
				this.plugin.settings.mcpApiKey = keyInput.value;
				await this.plugin.saveSettings();
				// 端口/Key 变更需要重启才生效；没在运行则不主动拉起
				if (this.plugin.mcpServer) await this.plugin.restartMcpServer();
				this.close();
				this.onSaved();
			};
			void persist();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** 外部 MCP 服务器的增/改弹窗：Name + Type（http/sse/stdio）+ URL/Command。
 *  编辑态带 Delete（删除走确认）。内置 semlink 不走这个弹窗。 */
class McpServerConfigModal extends Modal {
	constructor(
		app: App,
		private plugin: SmartVaultPlugin,
		/** null = 新增；否则为被编辑的条目。 */
		private server: McpClientServer | null,
		private onDone: () => void,
	) {
		super(app);
		this.modalEl.addClass("semlink-mcp-edit-modal");
		this.modalEl.addClass("semlink-mcp-client-modal");
		// editor-input/select/footer 的样式都挂在 .smart-vault-settings 下
		this.modalEl.addClass("smart-vault-settings");
	}

	onOpen(): void {
		const editing = this.server !== null;
		this.titleEl.setText(editing ? t("editMcpServer") : t("mcpNew"));
		const { contentEl } = this;

		// ── Form / JSON 切换（右上角分段控件，同内置服务配置弹窗） ──
		const segRow = contentEl.createDiv({ cls: "semlink-mcp-edit-segrow" });
		const seg = segRow.createDiv({ cls: "semlink-mcp-edit-seg" });
		const formBtn = seg.createEl("button", { cls: "is-active", text: "Form" });
		const jsonBtn = seg.createEl("button", { text: "JSON" });
		const formView = contentEl.createDiv({ cls: "semlink-mcp-edit-form" });
		const jsonView = contentEl.createDiv({ cls: "semlink-mcp-edit-json semlink-hidden" });

		// ── Form：Name / Type / Timeout / Protocol / URL|Command+Args / Headers ──
		formView.createDiv({ cls: "semlink-editor-field-label", text: t("mcpServerName") });
		const nameInput = formView.createEl("input", {
			cls: "semlink-editor-input",
			attr: { type: "text", placeholder: "my-mcp-server", spellcheck: "false" },
		});
		nameInput.value = this.server?.name ?? "";

		formView.createDiv({ cls: "semlink-editor-field-label", text: t("mcpServerType") });
		const typeSel = formView.createEl("select", { cls: "semlink-editor-select" });
		for (const [value, label] of [["http", "HTTP"], ["sse", "SSE"], ["stdio", "stdio"]] as const) {
			typeSel.createEl("option", { value, text: label });
		}
		typeSel.value = this.server?.type ?? "http";

		formView.createDiv({ cls: "semlink-editor-field-label", text: t("mcpTimeoutMs") });
		const timeoutInput = formView.createEl("input", {
			cls: "semlink-editor-input",
			attr: { type: "text", placeholder: "30000", spellcheck: "false" },
		});
		timeoutInput.value = this.server?.timeoutMs ? String(this.server.timeoutMs) : "";

		formView.createDiv({ cls: "semlink-editor-field-label", text: t("mcpProtocolVersion") });
		const protoSel = formView.createEl("select", { cls: "semlink-editor-select" });
		for (const [value, label] of [
			["", t("mcpProtocolAuto")],
			["2025-06-18", "2025-06-18"],
			["2025-03-26", "2025-03-26"],
			["2024-11-05", "2024-11-05"],
		] as const) {
			protoSel.createEl("option", { value, text: label });
		}
		protoSel.value = this.server?.protocolVersion ?? "";
		const protoHint = document.createElement("div");
		protoHint.addClass("semlink-mcp-edit-desc");
		protoHint.setText(t("mcpProtocolHint"));
		protoSel.insertAdjacentElement("afterend", protoHint);

		const urlLabel = formView.createDiv({ cls: "semlink-editor-field-label", text: t("mcpServerUrl") });
		const urlInput = formView.createEl("input", {
			cls: "semlink-editor-input",
			attr: { type: "text", placeholder: "https://mcp.example.com/mcp", spellcheck: "false" },
		});
		urlInput.value = this.server?.url ?? "";

		const headersLabel = formView.createDiv({ cls: "semlink-editor-field-label", text: `${t("mcpServerHeaders")} (JSON)` });
		const headersInput = formView.createEl("textarea", {
			cls: "semlink-editor-input semlink-monospace",
		});
		headersInput.rows = 4;
		headersInput.placeholder = "{" + "\n" + '  "Authorization": "Bearer your-token"' + "\n" + "}";
		const serverHeaders = this.server?.headers ?? {};
		headersInput.value = Object.keys(serverHeaders).length > 0 ? JSON.stringify(serverHeaders, null, 2) : "";

		const cmdLabel = formView.createDiv({ cls: "semlink-editor-field-label", text: t("mcpServerCommand") });
		const cmdInput = formView.createEl("input", {
			cls: "semlink-editor-input",
			attr: { type: "text", placeholder: "npx -y @some/mcp", spellcheck: "false" },
		});
		cmdInput.value = this.server?.command ?? "";

		const argsLabel = formView.createDiv({ cls: "semlink-editor-field-label", text: t("mcpServerArgs") });
		const argsInput = formView.createEl("input", {
			cls: "semlink-editor-input",
			attr: { type: "text", placeholder: "--port 8080 --verbose", spellcheck: "false" },
		});
		argsInput.value = this.server?.args ?? "";

		// http/sse ↔ stdio 互斥显隐
		const syncType = (): void => {
			const isStdio = typeSel.value === "stdio";
			urlLabel.toggleClass("semlink-hidden", isStdio);
			urlInput.toggleClass("semlink-hidden", isStdio);
			headersLabel.toggleClass("semlink-hidden", isStdio);
			headersInput.toggleClass("semlink-hidden", isStdio);
			cmdLabel.toggleClass("semlink-hidden", !isStdio);
			cmdInput.toggleClass("semlink-hidden", !isStdio);
			argsLabel.toggleClass("semlink-hidden", !isStdio);
			argsInput.toggleClass("semlink-hidden", !isStdio);
		};
		typeSel.addEventListener("change", syncType);
		syncType();

		// ── JSON 视图：完整配置（可粘贴 {"name":{…}} / {"mcpServers":{…}} 回填） ──
		jsonView.createDiv({ cls: "semlink-editor-field-label", text: t("mcpFullConfig") });
		const jsonArea = jsonView.createEl("textarea", { cls: "semlink-editor-input semlink-monospace" });
		jsonArea.rows = 12;
		jsonView.createDiv({ cls: "semlink-mcp-edit-desc", text: t("mcpJsonPasteHint") });

		const headersOfForm = (): Record<string, string> => {
			const raw = headersInput.value.trim();
			if (!raw) return {};
			const out: Record<string, string> = {};
			try {
				const obj = JSON.parse(raw) as Record<string, unknown>;
				for (const [k, v] of Object.entries(obj)) out[k] = String(v);
			} catch {
				return {};
			}
			return out;
		};
		const buildJson = (): string => {
			const isStdio = typeSel.value === "stdio";
			const name = nameInput.value.trim() || "my-mcp-server";
			const timeout = parseInt(timeoutInput.value, 10);
			const server: Record<string, unknown> = { type: typeSel.value };
			if (isStdio) {
				server.command = cmdInput.value.trim();
				server.args = argsInput.value.trim() ? argsInput.value.trim().split(/\s+/) : [];
			} else {
				server.url = urlInput.value.trim();
				const headers = headersOfForm();
				if (Object.keys(headers).length > 0) server.headers = headers;
			}
			if (!isNaN(timeout) && timeout > 0) server.timeoutMs = timeout;
			if (protoSel.value) server.protocolVersion = protoSel.value;
			return JSON.stringify({ [name]: server }, null, 2);
		};

		const setView = (json: boolean): void => {
			formView.toggleClass("semlink-hidden", json);
			jsonView.toggleClass("semlink-hidden", !json);
			formBtn.toggleClass("is-active", !json);
			jsonBtn.toggleClass("is-active", json);
			if (json) jsonArea.value = buildJson();
		};
		formBtn.addEventListener("click", () => setView(false));
		jsonBtn.addEventListener("click", () => setView(true));
		// 表单变化时同步 JSON 视图（切到 JSON 视图也会重建一次）
		for (const el of [nameInput, typeSel, timeoutInput, protoSel, urlInput, cmdInput, argsInput, headersInput]) {
			const sync = (): void => {
				if (!jsonView.hasClass("semlink-hidden")) jsonArea.value = buildJson();
			};
			el.addEventListener("input", sync);
			el.addEventListener("change", sync);
		}

		const error = contentEl.createDiv({ cls: "semlink-guide-error semlink-hidden" });

		// ── Footer：编辑态带 Delete，右侧 Save / Cancel ──
		const footer = contentEl.createDiv({ cls: "semlink-editor-footer is-simple" });
		if (editing) {
			const delBtn = footer.createEl("button", { cls: "semlink-editor-delete-link", text: t("chatDeleteModel") });
			delBtn.addEventListener("click", () => {
				new ConfirmModal(this.app, t("chatDeleteModel"), this.server?.name ?? "", () => {
					this.plugin.settings.mcpClientServers = (this.plugin.settings.mcpClientServers ?? []).filter((x) => x.id !== this.server!.id);
					void this.plugin.saveSettings();
					this.close();
					this.onDone();
				}).open();
			});
		}
		const cancelBtn = footer.createEl("button", { cls: "semlink-editor-cancel-btn", text: t("cancel") });
		cancelBtn.addEventListener("click", () => this.close());
		const saveBtn = footer.createEl("button", { cls: "semlink-editor-save-btn", text: t("editorSave") });

		saveBtn.addEventListener("click", () => {
			// JSON 视图激活时：解析粘贴的完整配置（{"name":{…}} / {"mcpServers":{…}}）
			let name = nameInput.value.trim();
			let typeName = typeSel.value;
			let url = urlInput.value.trim();
			let command = cmdInput.value.trim();
			let args = argsInput.value.trim();
			let headersRaw = headersInput.value.trim();
			const timeoutRaw = timeoutInput.value.trim();
			const protocol = protoSel.value;
			if (!jsonView.hasClass("semlink-hidden")) {
				try {
					const parsed = JSON.parse(jsonArea.value) as Record<string, unknown>;
					const servers = (parsed.mcpServers ?? parsed) as Record<string, Record<string, unknown>>;
					const firstKey = Object.keys(servers)[0];
					if (!firstKey || typeof servers[firstKey] !== "object" || servers[firstKey] === null) {
						throw new Error("empty");
					}
					const s = servers[firstKey];
					name = firstKey;
					typeName = typeof s.type === "string" ? s.type : (s.command ? "stdio" : "http");
					url = typeof s.url === "string" ? s.url : "";
					command = typeof s.command === "string" ? s.command : "";
					args = Array.isArray(s.args) ? (s.args as unknown[]).map(String).join(" ")
						: typeof s.args === "string" ? s.args : "";
					headersRaw = s.headers && typeof s.headers === "object"
						? JSON.stringify(s.headers, null, 2)
						: "";
				} catch {
					error.setText(t("mcpJsonInvalid"));
					error.removeClass("semlink-hidden");
					return;
				}
			}
			if (!name) {
				error.setText(t("mcpNameRequired"));
				error.removeClass("semlink-hidden");
				return;
			}
			const isStdio = typeName === "stdio";
			const target = isStdio ? command : url;
			if (!target) {
				error.setText(isStdio ? t("mcpServerCommand") : t("mcpServerUrl"));
				error.removeClass("semlink-hidden");
				return;
			}
			let headers: Record<string, string> | undefined;
			if (!isStdio && headersRaw) {
				try {
					const obj = JSON.parse(headersRaw) as Record<string, unknown>;
					headers = {};
					for (const [k, v] of Object.entries(obj)) headers[k] = String(v);
				} catch {
					error.setText(t("mcpJsonInvalid"));
					error.removeClass("semlink-hidden");
					return;
				}
			}
			const timeout = parseInt(timeoutRaw, 10);
			const shared = {
				name,
				type: typeName as McpClientServer["type"],
				...(isStdio
					? { command, args: args || undefined }
					: { url, ...(headers && Object.keys(headers).length > 0 ? { headers } : {}) }),
				...(isNaN(timeout) || timeout <= 0 ? {} : { timeoutMs: timeout }),
				...(protocol ? { protocolVersion: protocol } : {}),
			};
			const list = this.plugin.settings.mcpClientServers ??= [];
			if (editing && this.server) {
				Object.assign(this.server, shared);
				if (isStdio) { delete this.server.url; delete this.server.headers; }
				else { delete this.server.command; delete this.server.args; }
			} else {
				list.push({ id: `mcp-${Date.now()}`, ...shared, enabled: true });
			}
			void this.plugin.saveSettings();
			this.close();
			this.onDone();
		});
	}
	onClose(): void {
		this.contentEl.empty();
	}
}

/** 分享弹窗：把 semlink MCP 集成到第三方客户端（Claude Code 命令 +
 *  通用 mcpServers JSON），每段带一键复制。 */
class McpShareModal extends Modal {
	constructor(app: App, private plugin: SmartVaultPlugin) {
		super(app);
		this.modalEl.addClass("semlink-mcp-edit-modal");
		this.modalEl.addClass("smart-vault-settings");
	}

	onOpen(): void {
		this.titleEl.setText(t("mcpShareTitle"));
		const { contentEl } = this;
		const mcpUrl = `http://127.0.0.1:${this.plugin.settings.mcpPort}/mcp`;
		const key = this.plugin.settings.mcpApiKey;

		const copy = (text: string): void => {
			void navigator.clipboard.writeText(text).then(() => new Notice(t("mcpCopied")));
		};

		const section = (label: string, desc: string, code: string): HTMLElement => {
			const wrap = contentEl.createDiv({ cls: "semlink-mcp-share-section" });
			const head = wrap.createDiv({ cls: "semlink-mcp-share-head" });
			const textCol = head.createDiv({ cls: "semlink-mcp-share-text" });
			textCol.createDiv({ cls: "semlink-mcp-share-label", text: label });
			textCol.createDiv({ cls: "semlink-mcp-share-desc", text: desc });
			const copyBtn = head.createEl("button", {
				cls: "semlink-mcp-icon-btn",
				attr: { "aria-label": t("mcpShareCopy"), title: t("mcpShareCopy") },
			});
			setIcon(copyBtn, "copy");
			copyBtn.addEventListener("click", () => copy(code));
			wrap.createEl("pre", { cls: "semlink-mcp-share-code", text: code });
			return wrap;
		};

		section(
			t("claudeCodeCmd"),
			t("claudeCodeDesc"),
			t("mcpConnectInstruction").replace("{url}", mcpUrl),
		);

		section(
			t("claudeDesktopConfig"),
			t("claudeDesktopDesc"),
			JSON.stringify(
				{ semlink: { type: "http", url: mcpUrl, ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}) } },
				null,
				2,
			),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** 排除路径编辑弹窗：Index 面板的「编辑」按钮打开，每行一个前缀。 */
class ExcludePathsModal extends Modal {
	constructor(app: App, private plugin: SmartVaultPlugin) {
		super(app);
		this.modalEl.addClass("semlink-mcp-edit-modal");
		this.modalEl.addClass("smart-vault-settings");
	}

	onOpen(): void {
		this.titleEl.setText(t("excludePaths"));
		const { contentEl } = this;
		contentEl.createDiv({ cls: "semlink-mcp-edit-desc", text: t("excludePathsDesc") });
		const textarea = contentEl.createEl("textarea", { cls: "semlink-editor-input" });
		textarea.rows = 8;
		textarea.value = this.plugin.settings.excludePaths;
		const footer = contentEl.createDiv({ cls: "semlink-editor-footer is-simple" });
		const cancelBtn = footer.createEl("button", { cls: "semlink-editor-cancel-btn", text: t("cancel") });
		cancelBtn.addEventListener("click", () => this.close());
		const saveBtn = footer.createEl("button", { cls: "semlink-editor-save-btn", text: t("editorSave") });
		saveBtn.addEventListener("click", () => {
			this.plugin.settings.excludePaths = textarea.value;
			void this.plugin.saveSettings().then(() => this.close());
		});
		textarea.focus();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}