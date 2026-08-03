// ========================================
// Semlink - Settings Tab
// ========================================

import { App, ButtonComponent, PluginSettingTab, Setting } from "obsidian";
import * as QRCode from "qrcode";
import type SmartVaultPlugin from "../main";
import { DEFAULT_SETTINGS } from "./types";
import type { ChatProvider, IndexProgress } from "./types";
import { ChatModelsModal } from "./chat-models-modal";
import { AddFeishuBotModal } from "./feishu-bot-modal";
import { startFeishuRegister, type FeishuScanHandle } from "./feishu-auth";
import { t } from "./i18n";

type SettingsTab = "general" | "embedding" | "chat" | "mcp" | "bot";

export class SmartVaultSettingTab extends PluginSettingTab {
	plugin: SmartVaultPlugin;
	private indexBtn: ButtonComponent | null = null;
	private indexBtnUnsubscribe: (() => void) | null = null;
	private indexBtnCurrentState: "resume" | "pause" | "none" = "none";
	private indexBtnLoading = false;
	private activeTab: SettingsTab = "general";
	private feishuScanHandle: FeishuScanHandle | null = null;

	constructor(app: App, plugin: SmartVaultPlugin) {
		super(app, plugin);
		this.plugin = plugin;
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
			case "embedding":
				this.renderEmbeddingTab(panelEl);
				break;
			case "chat":
				this.renderChatTab(panelEl);
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
			{ id: "embedding", label: t("tabEmbedding") },
			{ id: "chat", label: t("tabChat") },
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
	// Tab: General — language, index management & support
	// ══════════════════════════════════════
	private renderGeneralTab(containerEl: HTMLElement): void {
		// Language
		new Setting(containerEl)
			.setName(t("language"))
			.setDesc(t("languageDesc"))
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({ "zh": "中文", "en": "English" })
					.setValue(this.plugin.settings.language)
					.onChange(async (value) => {
						this.plugin.settings.language = value as "zh" | "en";
						await this.plugin.saveSettings();
						this.display();
					})
			);

		// ── Section: Index Management ──
		new Setting(containerEl).setName(t("sectionIndex")).setHeading();

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

	// ══════════════════════════════════════
	// Tab: Embedding — embedding model & embedding params
	// ══════════════════════════════════════
	private renderEmbeddingTab(containerEl: HTMLElement): void {
		// ── Section: Embedding Model ──
		new Setting(containerEl).setName(t("sectionModel")).setHeading();

		// Provider selection
		new Setting(containerEl)
			.setName(t("provider"))
			.setDesc(t("providerDesc"))
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						"siliconflow": t("providerSiliconFlow"),
						"huggingface": t("providerHuggingFace"),
					})
					.setValue(this.plugin.settings.provider || "siliconflow")
					.onChange(async (value) => {
						this.plugin.settings.provider = value as "siliconflow" | "huggingface";
						await this.plugin.saveSettings();
						this.display();
					})
			);

		const provider = this.plugin.settings.provider || "siliconflow";

		if (provider === "siliconflow") {
			// SiliconFlow: API Region
			new Setting(containerEl)
				.setName(t("apiBase"))
				.setDesc(t("apiBaseDesc"))
				.addDropdown((dropdown) =>
					dropdown
						.addOptions({
							"https://api.siliconflow.cn": t("apiBaseCN"),
							"https://api.siliconflow.com": t("apiBaseGlobal"),
						})
						.setValue(this.plugin.settings.apiBase)
						.onChange(async (value) => {
							this.plugin.settings.apiBase = value;
							await this.plugin.saveSettings();
							this.display();
						})
				);

			// SiliconFlow: API Key
			const apiSite = this.plugin.settings.apiBase.includes("siliconflow.com") ? "siliconflow.com" : "siliconflow.cn";
			new Setting(containerEl)
				.setName(t("apiKey"))
				.setDesc(t("apiKeyDesc").replace("{site}", apiSite))
				.addText((text) =>
					text
						.setPlaceholder("sk-...")
						.setValue(this.plugin.settings.siliconFlowApiKey)
						.onChange(async (value) => {
							this.plugin.settings.siliconFlowApiKey = value;
							await this.plugin.saveSettings();
						})
				)
				.then((setting) => {
					const input = setting.controlEl.querySelector("input") as HTMLInputElement | null;
					if (input) input.type = "password";
				});

			// SiliconFlow: Model selection
			new Setting(containerEl)
				.setName(t("embeddingModel"))
				.setDesc(t("embeddingModelDesc"))
				.addDropdown((dropdown) =>
					dropdown
						.addOptions({
							"BAAI/bge-m3": `BAAI/bge-m3 (${t("modelRecommended")})`,
							"Pro/BAAI/bge-m3": `Pro/BAAI/bge-m3 (${t("modelEnhanced")})`,
							"BAAI/bge-large-zh-v1.5": `BAAI/bge-large-zh-v1.5 (${t("modelZhOptimized")})`,
							"BAAI/bge-large-en-v1.5": `BAAI/bge-large-en-v1.5 (${t("modelEnOptimized")})`,
						})
						.setValue(this.plugin.settings.embeddingModel)
						.onChange(async (value) => {
							this.plugin.settings.embeddingModel = value;
							await this.plugin.saveSettings();
						})
				);
		} else {
			// Hugging Face: API Key
			new Setting(containerEl)
				.setName(t("huggingFaceApiKey"))
				.setDesc(t("huggingFaceApiKeyDesc"))
				.addText((text) =>
					text
						.setPlaceholder("hf_...")
						.setValue(this.plugin.settings.huggingFaceApiKey)
						.onChange(async (value) => {
							this.plugin.settings.huggingFaceApiKey = value;
							await this.plugin.saveSettings();
						})
				)
				.then((setting) => {
					const input = setting.controlEl.querySelector("input") as HTMLInputElement | null;
					if (input) input.type = "password";
				});

			// Hugging Face: Model selection
			new Setting(containerEl)
				.setName(t("embeddingModel"))
				.setDesc(t("embeddingModelDesc"))
				.addDropdown((dropdown) =>
					dropdown
						.addOptions({
							"BAAI/bge-m3": `BAAI/bge-m3 (${t("modelRecommended")})`,
							"BAAI/bge-large-zh-v1.5": `BAAI/bge-large-zh-v1.5 (${t("modelZhOptimized")})`,
							"BAAI/bge-large-en-v1.5": `BAAI/bge-large-en-v1.5 (${t("modelEnOptimized")})`,
							"intfloat/multilingual-e5-large": `intfloat/multilingual-e5-large (${t("modelZhOptimized")})`,
						})
						.setValue(this.plugin.settings.embeddingModel)
						.onChange(async (value) => {
							this.plugin.settings.embeddingModel = value;
							await this.plugin.saveSettings();
						})
				);
		}

		// ── Section: Embedding Parameters ──
		new Setting(containerEl).setName(t("sectionEmbedding")).setHeading();

		new Setting(containerEl)
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

		new Setting(containerEl)
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

		new Setting(containerEl)
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

		new Setting(containerEl)
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
	}

	// ══════════════════════════════════════
	// Tab: Chat — chat providers & models
	// ══════════════════════════════════════
	private renderChatTab(containerEl: HTMLElement): void {
		this.renderChatModelsSection(containerEl);
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

	// ──── Chat Models Section ────

	private renderChatModelsSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName(t("sectionChat")).setHeading();

		const providers = this.plugin.settings.chatProviders;
		for (let pi = 0; pi < providers.length; pi++) {
			this.renderChatProvider(containerEl, pi);
		}

		// Add provider button
		new Setting(containerEl)
			.addButton((btn) => {
				btn.setButtonText(t("chatAddProvider")).setClass("mod-cta").onClick(async () => {
					providers.push({
						id: `provider-${Date.now()}`,
						name: "New Provider",
						baseUrl: "",
						apiKey: "",
						apiFormat: "openai",
						models: [],
					});
					await this.plugin.saveSettings();
					this.display();
				});
			});
	}

	private renderChatProvider(containerEl: HTMLElement, index: number): void {
		const provider = this.plugin.settings.chatProviders[index];
		if (!provider) return;

		// Provider name
		new Setting(containerEl)
			.setName(t("chatProviderName"))
			.addText((text) =>
				text
					.setPlaceholder("DeepSeek")
					.setValue(provider.name)
					.onChange(async (value) => {
						provider.name = value;
						await this.plugin.saveSettings();
					})
			);

		// Base URL
		new Setting(containerEl)
			.setName(t("chatBaseUrl"))
			.addText((text) =>
				text
					.setPlaceholder("https://api.example.com")
					.setValue(provider.baseUrl)
					.onChange(async (value) => {
						provider.baseUrl = value;
						await this.plugin.saveSettings();
					})
			);

		// API Key
		new Setting(containerEl)
			.setName(t("chatApiKey"))
			.addText((text) =>
				text
					.setPlaceholder("sk-...")
					.setValue(provider.apiKey)
					.onChange(async (value) => {
						provider.apiKey = value;
						await this.plugin.saveSettings();
					})
			)
			.then((setting) => {
				const input = setting.controlEl.querySelector("input") as HTMLInputElement | null;
				if (input) input.type = "password";
			});

		// API Format
		new Setting(containerEl)
			.setName(t("chatApiFormat"))
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						"openai": t("chatFormatOpenAI"),
						"anthropic": t("chatFormatAnthropic"),
					})
					.setValue(provider.apiFormat)
					.onChange(async (value) => {
						provider.apiFormat = value as "openai" | "anthropic";
						await this.plugin.saveSettings();
					})
			);

		// Models sub-item — click to open the management modal
		new Setting(containerEl)
			.setName(t("chatModels"))
			.setDesc(t("chatModelsDesc").replace("{count}", String(provider.models.length)))
			.addButton((btn) =>
				btn.setButtonText(t("chatManageModels")).onClick(() => {
					new ChatModelsModal(this.app, this.plugin, provider, () => this.display()).open();
				})
			);

		// Delete provider button
		new Setting(containerEl).addButton((btn) => {
			btn.setButtonText(t("chatDeleteProvider")).setWarning().onClick(async () => {
				this.plugin.settings.chatProviders.splice(index, 1);
				await this.plugin.saveSettings();
				this.display();
			});
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
