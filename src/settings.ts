// ========================================
// Semlink - Settings Tab
// ========================================

import { App, ButtonComponent, DropdownComponent, Notice, PluginSettingTab, Setting, setIcon } from "obsidian";
import * as QRCode from "qrcode";
import type SmartVaultPlugin from "../main";
import type { IndexProgress, ModelProvider, SmartVaultSettings } from "./types";
import { activeEmbeddingProvider } from "./types";
import { AddFeishuBotModal } from "./feishu-bot-modal";
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
			{ id: "mcp", label: t("tabMcp") },
			{ id: "embedding", label: t("tabEmbedding") },
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
			foot.createSpan({ cls: "semlink-license-card-lifetime", text: t("licenseLifetime") });

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
		// Embedding model — one dropdown entry per (provider, model) combo,
		// e.g. "SiliconFlow/BAAI/bge-m3"; picking one sets the active
		// embedding model key.
		new Setting(containerEl)
			.setName(t("embeddingModel"))
			.addDropdown((dropdown) => {
				const options = embeddingModelComboOptions(this.plugin.settings);
				const active = activeEmbeddingProvider(this.plugin.settings);
				const currentKey = this.plugin.settings.embeddingModelKey
					|| `${active.id}::${active.model}`;
				// Keep a custom (non-catalog) model selectable, but only while
				// its provider has a key — unconfigured services must not be
				// selectable here.
				if (active.apiKey.trim() && !(currentKey in options)) {
					options[currentKey] = `${active.name}/${active.model}`;
				}
				dropdown
					.addOptions(options)
					.setValue(currentKey)
					.onChange(async (value) => {
						this.plugin.settings.embeddingModelKey = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName(t("chunkSize"))
			.setDesc(t("chunkSizeDesc"))
			.addSlider((slider) => {
				showSliderValue(slider.setLimits(200, 2000, 100).setValue(this.plugin.settings.chunkSize));
				return slider.onChange(async (value) => {
					this.plugin.settings.chunkSize = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName(t("chunkOverlap"))
			.setDesc(t("chunkOverlapDesc"))
			.addSlider((slider) => {
				showSliderValue(slider.setLimits(0, 500, 50).setValue(this.plugin.settings.chunkOverlap));
				return slider.onChange(async (value) => {
					this.plugin.settings.chunkOverlap = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName(t("batchSize"))
			.setDesc(t("batchSizeDesc"))
			.addSlider((slider) => {
				showSliderValue(slider.setLimits(1, 128, 1).setValue(this.plugin.settings.batchSize));
				return slider.onChange(async (value) => {
					this.plugin.settings.batchSize = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName(t("requestDelay"))
			.setDesc(t("requestDelayDesc"))
			.addSlider((slider) => {
				showSliderValue(slider.setLimits(0, 1000, 50).setValue(this.plugin.settings.requestDelayMs));
				return slider.onChange(async (value) => {
					this.plugin.settings.requestDelayMs = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
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
		new Setting(containerEl)
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
	// Tab: MCP — service port, access key, status & client config
	// ══════════════════════════════════════
	private renderMcpTab(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName(t("mcpPort"))
			.setDesc(t("mcpPortDesc"))
			.addText((text) =>
				text
					.setPlaceholder("3001")
					.setValue(String(this.plugin.settings.mcpPort))
					.onChange(async (value) => {
						const port = parseInt(value, 10);
						if (!isNaN(port) && port > 0 && port < 65536) {
							this.plugin.settings.mcpPort = port;
							await this.plugin.saveSettings();
							rerenderSettingsTab(this);
						}
					})
			);

		new Setting(containerEl)
			.setName(t("mcpAccessKey"))
			.setDesc(t("mcpAccessKeyDesc"))
			.addText((text) =>
				text
					.setPlaceholder(t("mcpAccessKeyPlaceholder"))
					.setValue(this.plugin.settings.mcpApiKey)
					.onChange(async (value) => {
						this.plugin.settings.mcpApiKey = value;
						await this.plugin.saveSettings();
						rerenderSettingsTab(this);
					})
			);

		// MCP Service status & control
		new Setting(containerEl)
			.setName(t("mcpService"))
			.setDesc(this.plugin.mcpServer ? `${t("mcpRunning")} (${t("mcpPortLabel")} ${this.plugin.mcpServer.port})` : t("mcpStopped"))
			.addButton((btn) =>
				btn
					.setButtonText(this.plugin.mcpServer ? t("restartService") : t("startService"))
					.onClick(async () => {
						await this.plugin.restartMcpServer();
						rerenderSettingsTab(this);
					})
			);

		// Client configuration
		const mcpUrl = `http://127.0.0.1:${this.plugin.settings.mcpPort}/mcp`;

		new Setting(containerEl)
			.setName(t("claudeCodeCmd"))
			.setDesc(t("claudeCodeDesc"))
			.addTextArea((text) => {
				const cmd = this.plugin.settings.mcpApiKey
					? `claude mcp add --transport http semlink ${mcpUrl} --header "Authorization: Bearer ${this.plugin.settings.mcpApiKey}"`
					: `claude mcp add --transport http semlink ${mcpUrl}`;
				text.setValue(cmd).then((t) => {
					t.inputEl.rows = 2;
					t.inputEl.readOnly = true;
					t.inputEl.addClass("semlink-monospace");
				});
			});

		const configJson = JSON.stringify(
			{
				mcpServers: {
					semlink: {
						type: "http",
						url: mcpUrl,
						...(this.plugin.settings.mcpApiKey
							? { headers: { Authorization: `Bearer ${this.plugin.settings.mcpApiKey}` } }
							: {}),
					},
				},
			},
			null,
			2,
		);

		new Setting(containerEl)
			.setName(t("claudeDesktopConfig"))
			.setDesc(t("claudeDesktopDesc"))
			.addTextArea((text) => {
				text.setValue(configJson).then((t) => {
					const textarea = t.inputEl;
					textarea.rows = 12;
					textarea.readOnly = true;
					textarea.addClass("semlink-monospace");
				});
			});
	}

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

/** One combined option per (embedding provider, model) pair, keyed
 *  `${providerId}::${modelId}` and labelled like
 *  `SiliconFlow/BAAI/bge-m3`. The models come from the unified provider
 *  list, filtered to kind-tagged "embedding" entries. Only providers with a
 *  key AND a base URL are listed. */
function embeddingModelComboOptions(settings: SmartVaultSettings): Record<string, string> {
	const options: Record<string, string> = {};
	for (const p of settings.providers) {
		if (!p.apiKey || !p.apiKey.trim()) continue;
		if (!p.apiBase || !p.apiBase.trim()) continue;
		const seen = new Set<string>();
		for (const model of embeddingModelsOf(p)) {
			if (seen.has(model)) continue;
			seen.add(model);
			options[`${p.id}::${model}`] = `${p.name}/${model}`;
		}
	}
	return options;
}

/** The embedding models configured for a provider: its kind-tagged
 *  "embedding" entries that are enabled. */
function embeddingModelsOf(p: ModelProvider): string[] {
	return (p.models ?? [])
		.filter((m) => (m.kind ?? "chat") === "embedding" && m.enabled === true)
		.map((m) => m.id)
		.filter((id) => id.length > 0);
}
