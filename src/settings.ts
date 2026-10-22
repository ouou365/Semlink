// ========================================
// Semlink - Settings Tab
// ========================================

import { App, ButtonComponent, DropdownComponent, Modal, Notice, PluginSettingTab, Setting, ToggleComponent, setIcon } from "obsidian";
import * as QRCode from "qrcode";
import type SmartVaultPlugin from "../main";
import type { IndexProgress, ModelProvider, SmartVaultSettings } from "./types";
import { activeEmbeddingProvider } from "./types";
import { AddFeishuBotModal } from "./feishu-bot-modal";
import { mountCoffeeCanvas } from "./coffee-canvas";
import { startFeishuRegister, type FeishuScanHandle } from "./feishu-auth";
import { EMPTY_MODELS_TAB_STATE, renderModelsTab, type ModelsTabState } from "./settings-models";
import { LicenseModal } from "./license-modal";
import { licenseErrorMessage } from "./license";
import { LANGUAGES, t } from "./i18n";
import { ConfirmModal } from "./confirm-modal";
import { markDestructive, rerenderSettingsTab, showSliderValue } from "./ui-compat";

type SettingsTab = "general" | "model" | "mcp" | "index" | "embedding" | "bot";

export class SmartVaultSettingTab extends PluginSettingTab {
	plugin: SmartVaultPlugin;
	private indexBtn: ButtonComponent | null = null;
	private indexBtnUnsubscribe: (() => void) | null = null;
	private indexBtnCurrentState: "resume" | "pause" | "none" = "none";
	private indexBtnLoading = false;
	private activeTab: SettingsTab = "general";
	/** Provider-list state (models management, embedded in the General tab):
	 *  which provider's editor is expanded / which add card is open. */
	private modelsState: ModelsTabState = { ...EMPTY_MODELS_TAB_STATE };
	private feishuScanHandle: FeishuScanHandle | null = null;

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
		this.indexBtnUnsubscribe?.();
		this.indexBtnUnsubscribe = null;
		this.indexBtn = null;
		this.indexBtnLoading = false;
		this.indexBtnCurrentState = "none";
		// Abort any in-flight Feishu scan before re-rendering (a fresh QR
		// session is started by the bot tab).
		this.feishuScanHandle?.abort();
		this.feishuScanHandle = null;

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
			case "index":
				this.renderIndexTab(panelEl);
				break;
			case "embedding":
				this.renderEmbeddingTab(panelEl);
				break;
			case "bot":
				this.renderBotTab(panelEl);
				break;
		}
	}

	private renderTabNav(containerEl: HTMLElement): void {
		const navEl = containerEl.createDiv({ cls: "semlink-settings-tabs" });
		const tabs: Array<{ id: SettingsTab; label: string }> = [
			{ id: "general", label: t("tabGeneral") },
			{ id: "model", label: t("tabModel") },
			{ id: "embedding", label: t("tabEmbedding") },
			{ id: "mcp", label: t("tabMcp") },
			{ id: "index", label: t("tabIndex") },
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
		new Setting(containerEl)
			.setName(t("openSidebar"))
			.setDesc(t("openSidebarDesc"))
			.addButton((btn) =>
				btn.setButtonText(t("open")).onClick(() => {
					// Close the settings pane first — the sidebar opens into
					// the workspace the user returns to.
					(this.app as unknown as { setting: { close(): void } }).setting.close();
					void this.plugin.activateSearchView();
				})
			);


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
	// Tab: Index — exclude paths, auto-index, full reindex
	// ══════════════════════════════════════
	private renderIndexTab(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName(t("excludePaths"))
			.setDesc(t("excludePathsDesc"))
			.addTextArea((text) =>
				text
					.setPlaceholder("templates/\n.git/\nnode_modules/")
					.setValue(this.plugin.settings.excludePaths)
					.onChange(async (value) => {
						this.plugin.settings.excludePaths = value;
						await this.plugin.saveSettings();
					})
			)
			.then((setting) => {
				(setting.controlEl.querySelector("textarea") as HTMLTextAreaElement).rows = 4;
			});

		new Setting(containerEl)
			.setName(t("autoIndex"))
			.setDesc(t("autoIndexDesc"))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoIndex)
					.onChange(async (value) => {
						this.plugin.settings.autoIndex = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(t("fullReindex"))
			.setDesc(t("fullReindexDesc"))
			.addButton((btn) => {
				this.indexBtn = btn;
				this.indexBtnCurrentState = "none";
				this.applyIndexBtnState(this.plugin.progress.current);
				this.indexBtnUnsubscribe = this.plugin.progress.onProgress((event) => {
					if (event.type === "progress") {
						this.applyIndexBtnState(event.progress);
					}
				});
			});
	}

	// ══════════════════════════════════════
	// Tab: Embedding — model, chunking params, rebuild
	// ══════════════════════════════════════
	private renderEmbeddingTab(containerEl: HTMLElement): void {
		// 嵌入供应商：配置了 Key 且带有嵌入模型的供应商
		const embeddingProviders = this.plugin.settings.providers.filter(
			(p) => !!p.apiKey.trim() && p.models.some((m) => (m.kind ?? "chat") === "embedding"),
		);
		const active = activeEmbeddingProvider(this.plugin.settings);
		const currentKey = this.plugin.settings.embeddingModelKey
			|| `${active.id}::${active.model}`;
		const activeProvider =
			embeddingProviders.find((p) => p.id === currentKey.split("::")[0])
			?? embeddingProviders.find((p) => p.id === active.id)
			?? embeddingProviders[0];

		// ── 向量搜索总开关：关闭后所有语义检索返回空 ──
		new Setting(containerEl)
			.setName(t("vectorSearch"))
			.setDesc(t("vectorSearchDesc"))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.vectorSearchEnabled !== false)
					.onChange(async (value) => {
						this.plugin.settings.vectorSearchEnabled = value;
						await this.plugin.saveSettings();
					})
			);

		// ── 供应商 + 嵌入模型两级选择 ──
		new Setting(containerEl)
			.setName(t("embeddingProvider"))
			.addDropdown((dropdown) => {
				for (const p of embeddingProviders) dropdown.addOption(p.id, p.name);
				if (activeProvider) dropdown.setValue(activeProvider.id);
				dropdown.onChange(async (value) => {
					// 切换供应商：嵌入模型落到该供应商的第一个嵌入模型
					const p = embeddingProviders.find((x) => x.id === value);
					const model = p?.models.find((m) => (m.kind ?? "chat") === "embedding");
					if (p && model) {
						this.plugin.settings.embeddingModelKey = `${p.id}::${model.id}`;
						await this.plugin.saveSettings();
						rerenderSettingsTab(this);
					}
				});
			});

		new Setting(containerEl)
			.setName(t("embeddingModel"))
			.addDropdown((dropdown) => {
			const options: Record<string, string> = {};
			for (const m of activeProvider?.models.filter((m) => (m.kind ?? "chat") === "embedding") ?? []) {
				options[`${activeProvider.id}::${m.id}`] = m.id;
			}
				// 自定义（非目录）模型在选中态保持可选
				if (activeProvider && !(currentKey in options)) {
					options[currentKey] = currentKey.split("::").slice(1).join("::");
				}
				dropdown
					.addOptions(options)
					.setValue(currentKey in options ? currentKey : Object.keys(options)[0] ?? "")
					.onChange(async (value) => {
						this.plugin.settings.embeddingModelKey = value;
						await this.plugin.saveSettings();
					});
			});

		// ── 咖啡杯索引可视化：液面 = 嵌入进度，完成时庆祝 ──
		const coffeeHost = containerEl.createDiv({ cls: "semlink-rag-coffee" });
		const coffee = mountCoffeeCanvas(coffeeHost, { modelName: active.model });
		const applyCoffee = (p: IndexProgress): void => {
			const total = Math.max(p.totalChunks, 0);
			const pct = total > 0 ? Math.min(100, Math.round((p.embeddedChunks / total) * 100)) : 0;
			coffee.setLevel(pct, p.phase === "embedding");
			if (p.phase === "completed" && total > 0) coffee.celebrate();
		};
		applyCoffee(this.plugin.progress.current);
		this.indexBtnUnsubscribe = this.plugin.progress.onProgress((event) => {
			if (event.type === "progress") applyCoffee(event.progress);
		});

		// ── 高级选项（默认收起）：分块 / 批量 / 延迟 / 并发 / 重建索引 ──
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

		// ── Re-embed (force full rebuild) ──
		new Setting(advBody)
			.setName(t("rebuildIndex"))
			.setDesc(t("rebuildIndexDesc"))
			.addButton((btn) => {
				btn.setButtonText(t("rebuildIndex"));
				markDestructive(btn).onClick(() => {
					new ConfirmModal(this.app, t("rebuildIndex"), t("rebuildConfirm"), () => {
						// 重建索引并直接在引导页数据索引环节可视化进度
						void this.plugin.rebuildIndexWithGuide();
					}).open();
				});
			});
	}

	// ══════════════════════════════════════
	// Tab: MCP — single semlink server card with a run toggle
	// ══════════════════════════════════════
	private renderMcpTab(containerEl: HTMLElement): void {
		const running = !!this.plugin.mcpServer;
		const mcpUrl = `http://127.0.0.1:${this.plugin.settings.mcpPort}/mcp`;

		// MCP 标签只显示一行 semlink 服务器卡片：右侧开关直接启停服务
		const list = containerEl.createDiv({ cls: "semlink-mcp-list" });
		const card = list.createDiv({ cls: "semlink-mcp-server" });
		const iconWrap = card.createDiv({
			cls: "semlink-mcp-server-icon",
			attr: { title: running ? t("mcpRunning") : t("mcpStopped") },
		});
		setIcon(iconWrap, "semlink-logo");
		iconWrap.createSpan({ cls: `semlink-mcp-server-dot${running ? " is-on" : ""}` });
		const main = card.createDiv({ cls: "semlink-mcp-server-main" });
		main.createDiv({ cls: "semlink-mcp-server-name", text: "semlink" });
		main.createDiv({ cls: "semlink-mcp-server-sub", text: `http · ${mcpUrl}` });
		const toggleWrap = card.createDiv({ cls: "semlink-mcp-server-toggle" });
		new ToggleComponent(toggleWrap)
			.setValue(running)
			.onChange(async (v) => {
				if (v) await this.plugin.startMcpServer();
				else await this.plugin.stopMcpServer();
				rerenderSettingsTab(this);
			});
		// 点击卡片（避开开关）打开配置编辑弹窗
		card.addEventListener("click", (e) => {
			if ((e.target as HTMLElement).closest(".semlink-mcp-server-toggle")) return;
			new EditMcpServerModal(this.app, this.plugin, () => rerenderSettingsTab(this)).open();
		});
	}

	// ══════════════════════════════════════
	// Tab: Bot — Feishu bots bound to Semlink
	// ══════════════════════════════════════
	// ══════════════════════════════════════
	// Tab: Bot — Feishu bots bound to Semlink
	// ══════════════════════════════════════
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

	private applyIndexBtnState(p: IndexProgress) {
		const btn = this.indexBtn;
		if (!btn) return;

		let desired: "resume" | "pause" | "none";
		if (p.isPaused || p.phase === "idle" || p.phase === "completed") {
			desired = "resume";
		} else {
			desired = "pause";
		}

		if (this.indexBtnLoading) {
			if (desired === this.indexBtnCurrentState) return;
			this.indexBtnLoading = false;
		}

		if (desired === this.indexBtnCurrentState) return;
		this.indexBtnCurrentState = desired;

		const el = btn.buttonEl;
		el.setCssStyles({ minWidth: "" });
		btn.setDisabled(false);
		el.removeClass("mod-cta");

		if (desired === "resume") {
			btn.setButtonText(t("startFullIndex")).setClass("mod-cta");
			btn.onClick(() => {
				this.indexBtnLoading = true;
				el.setCssStyles({ minWidth: el.offsetWidth + "px" });
				btn.setButtonText(t("btnLoading")).setDisabled(true);
				window.setTimeout(() => {
					this.plugin.startFullIndex();
				}, 300);
			});
		} else if (desired === "pause") {
			btn.setButtonText(t("btnPause"));
			btn.onClick(() => {
				this.indexBtnLoading = true;
				el.setCssStyles({ minWidth: el.offsetWidth + "px" });
				btn.setButtonText(t("btnPausing")).setDisabled(true);
				window.setTimeout(() => {
					this.app.workspace.trigger("smart-vault:pause");
				}, 300);
			});
		}
	}
}


/** The embedding models configured for a provider: its kind-tagged
 *  "embedding" entries that are enabled. */
function embeddingModelsOf(p: ModelProvider): string[] {
	return (p.models ?? [])
		.filter((m) => (m.kind ?? "chat") === "embedding" && m.enabled === true)
		.map((m) => m.id)
		.filter((id) => id.length > 0);
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
					mcpServers: {
						semlink: {
							type: "http",
							url,
							...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
						},
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
