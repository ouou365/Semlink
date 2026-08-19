// ========================================
// Semlink - Settings Tab
// ========================================

import { App, ButtonComponent, Notice, PluginSettingTab, Setting } from "obsidian";
import * as QRCode from "qrcode";
import type SmartVaultPlugin from "../main";
import type { EmbeddingProviderConfig, IndexProgress, SmartVaultSettings } from "./types";
import { activeEmbeddingProvider } from "./types";
import { AddFeishuBotModal } from "./feishu-bot-modal";
import { startFeishuRegister, type FeishuScanHandle } from "./feishu-auth";
import { EMPTY_MODELS_TAB_STATE, renderModelsTab, type ModelsTabState } from "./settings-models";
import { t } from "./i18n";

type SettingsTab = "general" | "mcp" | "bot";

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
	/** Whether the collapsible embedding-params section is expanded. */
	private embeddingParamsOpen = false;
	/** Whether the collapsible index-management section is expanded. */
	private indexOpen = false;
	private feishuScanHandle: FeishuScanHandle | null = null;

	constructor(app: App, plugin: SmartVaultPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/** The nearest scrollable ancestor of the settings content (Obsidian's
	 *  settings pane scrolls a `.vertical-tab-content-container`). */
	private findScrollContainer(): HTMLElement | null {
		let el: HTMLElement | null = this.containerEl.parentElement;
		while (el) {
			const style = getComputedStyle(el);
			if (style.overflowY === "auto" || style.overflowY === "scroll") return el;
			el = el.parentElement;
		}
		return null;
	}

	/** Re-render the current tab while keeping the scroll position — row
	 *  expand/collapse and provider create/delete re-render the whole page,
	 *  which would otherwise jump back to the top. */
	private refreshPreservingScroll(): void {
		const scroller = this.findScrollContainer();
		const top = scroller?.scrollTop ?? 0;
		this.display();
		requestAnimationFrame(() => {
			if (scroller) scroller.scrollTop = top;
		});
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

		// Title heading
		new Setting(containerEl).setName(t("settingsTitle")).setHeading();

		// Tab navigation
		this.renderTabNav(containerEl);

		// Render only the active tab's content
		const panelEl = containerEl.createDiv({ cls: "semlink-settings-panel" });
		switch (this.activeTab) {
			case "general":
				this.renderGeneralTab(panelEl);
				break;
			case "mcp":
				this.renderMcpTab(panelEl);
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
			{ id: "mcp", label: t("tabMcp") },
			{ id: "bot", label: t("tabBot") },
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
					this.display();
				}
			});
		}
	}

	// ══════════════════════════════════════
	// Tab: General — language, embedding, index management & support
	// ══════════════════════════════════════
	private renderGeneralTab(containerEl: HTMLElement): void {
		// Language
		new Setting(containerEl)
			.setName(t("language"))
			.setDesc(t("languageDesc"))
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({ auto: t("langAuto"), zh: "中文", en: "English" })
					.setValue(this.plugin.settings.language)
					.onChange(async (value) => {
						this.plugin.settings.language = value as "auto" | "zh" | "en";
						await this.plugin.saveSettings();
						this.display();
					})
			);

		// ── Section: Model configuration (embedding + chat) ──
		new Setting(containerEl).setName(t("modelConfigSection")).setHeading();

		// Embedding model — one dropdown entry per (service, model) combo,
		// e.g. "SiliconFlow CN/BAAI/bge-m3"; picking one sets both the
		// active embedding service and its model.
		new Setting(containerEl)
			.setName(t("embeddingModel"))
			.addDropdown((dropdown) => {
				const options = embeddingModelComboOptions(this.plugin.settings);
				const active = activeEmbeddingProvider(this.plugin.settings);
				const currentKey = `${active.id}::${active.model}`;
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
						const sep = value.indexOf("::");
						const pid = value.slice(0, sep);
						const model = value.slice(sep + 2);
						const provider = this.plugin.settings.embeddingProviders.find((p) => p.id === pid);
						if (!provider) return;
						this.plugin.settings.embeddingProviderId = pid;
						provider.model = model;
						await this.plugin.saveSettings();
					});
			});

		// Chat model — the model the conversational search answers with.
		new Setting(containerEl)
			.setName(t("chatModel"))
			.addDropdown((dropdown) => {
				const options = chatModelOptions(this.plugin);
				const persisted = this.plugin.settings.activeChatModel;
				const active = this.plugin.chatClient.getActiveModel();
				// Only selectable options are keyed providers; a persisted or
				// resolved model whose provider lost its key just shows blank.
				let current = persisted && persisted in options
					? persisted
					: active ? `${active.provider.id}/${active.model.id}` : "";
				if (!(current in options)) {
					current = "";
					if (Object.keys(options).length === 0) {
						options[""] = t("chatModelEmpty");
					}
				}
				dropdown
					.addOptions(options)
					.setValue(current)
					.onChange((value) => {
						const sep = value.indexOf("/");
						const pid = value.slice(0, sep);
						const mid = value.slice(sep + 1);
						// setActiveModel persists via the plugin's change handler.
						this.plugin.chatClient.setActiveModel(pid, mid);
					});
			});

		// ── Provider management (former Models tab) directly under the model
		// configuration: embedding + chat providers, add/edit/remove, fetch.
		renderModelsTab(this.plugin, containerEl, this.modelsState, () => this.refreshPreservingScroll());

		// ── Secondary: embedding parameters (click to expand) ──
		this.renderEmbeddingParamsSection(containerEl);

		// ── Index Management (collapsible, like the embedding parameters) ──
		this.renderIndexManagementSection(containerEl);

		// Report Bug
		new Setting(containerEl)
			.setName(t("reportBug"))
			.setDesc(t("reportBugDesc"))
			.addButton((btn) =>
				btn
					.setButtonText(t("reportBugButton"))
					.onClick(() => {
						window.location.href = "mailto:ozy2013xm@gmail.com?subject=Semlink Bug Report";
					})
			);
	}

	/** Former "Index Management" heading, collapsed like the embedding
	 *  parameters: exclude paths, auto-index and the full reindex action. */
	private renderIndexManagementSection(containerEl: HTMLElement): void {
		const details = containerEl.createEl("details", { cls: "semlink-collapsible" });
		details.open = this.indexOpen;
		details.addEventListener("toggle", () => {
			this.indexOpen = details.open;
		});
		const summary = details.createEl("summary", { cls: "semlink-collapsible-summary" });
		summary.createSpan({ text: t("sectionIndex") });
		const body = details.createDiv({ cls: "semlink-collapsible-body" });

		new Setting(body)
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

		new Setting(body)
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

		new Setting(body)
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

	/** Former "Embedding" tab, demoted to a collapsible secondary section. */
	private renderEmbeddingParamsSection(containerEl: HTMLElement): void {
		const details = containerEl.createEl("details", { cls: "semlink-collapsible" });
		details.open = this.embeddingParamsOpen;
		details.addEventListener("toggle", () => {
			this.embeddingParamsOpen = details.open;
		});
		const summary = details.createEl("summary", { cls: "semlink-collapsible-summary" });
		summary.createSpan({ text: t("sectionEmbedding") });
		const body = details.createDiv({ cls: "semlink-collapsible-body" });

		new Setting(body)
			.setName(t("chunkSize"))
			.setDesc(t("chunkSizeDesc"))
			.addSlider((slider) =>
				slider
					.setLimits(200, 2000, 100)
					.setValue(this.plugin.settings.chunkSize)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.chunkSize = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(body)
			.setName(t("chunkOverlap"))
			.setDesc(t("chunkOverlapDesc"))
			.addSlider((slider) =>
				slider
					.setLimits(0, 500, 50)
					.setValue(this.plugin.settings.chunkOverlap)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.chunkOverlap = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(body)
			.setName(t("batchSize"))
			.setDesc(t("batchSizeDesc"))
			.addSlider((slider) =>
				slider
					.setLimits(1, 128, 1)
					.setValue(this.plugin.settings.batchSize)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.batchSize = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(body)
			.setName(t("requestDelay"))
			.setDesc(t("requestDelayDesc"))
			.addSlider((slider) =>
				slider
					.setLimits(0, 1000, 50)
					.setValue(this.plugin.settings.requestDelayMs)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.requestDelayMs = value;
						await this.plugin.saveSettings();
					})
			);

		// ── Re-embed (force full rebuild) ──
		new Setting(body)
			.setName(t("rebuildIndex"))
			.setDesc(t("rebuildIndexDesc"))
			.addButton((btn) =>
				btn
					.setButtonText(t("rebuildIndex"))
					.setWarning()
					.onClick(async () => {
						if (!window.confirm(t("rebuildConfirm"))) return;
						await this.plugin.rebuildAll();
					})
			);
	}

	// ══════════════════════════════════════
	// Tab: MCP — service port, access key, status & client config
	// ══════════════════════════════════════
	private renderMcpTab(containerEl: HTMLElement): void {
		new Setting(containerEl).setName(t("sectionMcp")).setHeading();

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
							this.display();
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
						this.display();
					})
			);

		// MCP Service status & control
		new Setting(containerEl)
			.setName(t("mcpService"))
			.setDesc(this.plugin.mcpServer ? `${t("mcpRunning")} (端口 ${this.plugin.mcpServer.port})` : t("mcpStopped"))
			.addButton((btn) =>
				btn
					.setButtonText(this.plugin.mcpServer ? t("restartService") : t("startService"))
					.onClick(async () => {
						await this.plugin.restartMcpServer();
						this.display();
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
							this.display();
						})
				)
				.addExtraButton((btn) => {
					btn.setIcon("trash").setTooltip(t("botDelete")).onClick(async () => {
						bots.splice(i, 1);
						await this.plugin.saveSettings();
						this.display();
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
				new AddFeishuBotModal(this.app, this.plugin, () => this.display()).open();
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
				this.display();
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

/** One combined option per (embedding service, model) pair, keyed
 *  `${providerId}::${modelId}` and labelled like
 *  `SiliconFlow CN/BAAI/bge-m3` (provider display name + model). The models
 *  come from what the user configured on the Models tab (the provider's
 *  kind-tagged model list, or the current embedding model) — NOT the built-in
 *  catalog. Only providers with a key are listed. */
function embeddingModelComboOptions(settings: SmartVaultSettings): Record<string, string> {
	const options: Record<string, string> = {};
	for (const p of settings.embeddingProviders) {
		if (!p.apiKey || !p.apiKey.trim()) continue;
		const seen = new Set<string>();
		for (const model of embeddingModelsOf(p)) {
			if (seen.has(model)) continue;
			seen.add(model);
			options[`${p.id}::${model}`] = `${p.name}/${model}`;
		}
	}
	return options;
}

/** The embedding models configured for a provider: the kind-tagged "embedding"
 *  entries of its model list, falling back to the current embedding model,
 *  and finally to nothing (no built-in catalog). */
function embeddingModelsOf(p: EmbeddingProviderConfig): string[] {
	const configured = (p.models ?? [])
		.filter((m) => (m.kind ?? "chat") === "embedding")
		.map((m) => m.id)
		.filter((id) => id.length > 0);
	if (configured.length > 0) return configured;
	if (p.model && p.model.trim().length > 0) return [p.model];
	return [];
}

/** One option per usable chat model, keyed `${providerId}/${modelId}`.
 *  Sources: chat providers with a key AND a base URL, plus the kind-tagged
 *  "chat" entries of embedding providers (SiliconFlow CN/Global, Hugging
 *  Face) that have a key — matching what ChatClient.getActiveModel resolves. */
function chatModelOptions(plugin: SmartVaultPlugin): Record<string, string> {
	const options: Record<string, string> = {};
	for (const p of plugin.settings.chatProviders) {
		if (!p.apiKey || !p.apiKey.trim()) continue;
		if (!p.baseUrl || !p.baseUrl.trim()) continue;
		for (const m of p.models) {
			options[`${p.id}/${m.id}`] = `${p.name || p.id}/${m.id}`;
		}
	}
	for (const p of plugin.settings.embeddingProviders) {
		if (!p.apiKey || !p.apiKey.trim()) continue;
		if (!p.apiBase || !p.apiBase.trim()) continue;
		for (const m of p.models ?? []) {
			if ((m.kind ?? "chat") !== "chat") continue;
			options[`${p.id}/${m.id}`] = `${p.name}/${m.id}`;
		}
	}
	return options;
}
