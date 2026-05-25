// ========================================
// Semlink - Settings Tab
// ========================================

import { App, PluginSettingTab, Setting } from "obsidian";
import type SmartVaultPlugin from "../main";
import { DEFAULT_SETTINGS } from "./types";
import { t } from "./i18n";

export class SmartVaultSettingTab extends PluginSettingTab {
	plugin: SmartVaultPlugin;

	constructor(app: App, plugin: SmartVaultPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("smart-vault-settings");

		containerEl.createEl("h2", { text: t("settingsTitle") });

		// Report Bug (top right of title)
		const titleEl = containerEl.querySelector("h2");
		if (titleEl) {
			const bugLink = document.createElement("a");
			bugLink.setText(t("reportBug"));
			bugLink.href = "mailto:ozy2013xm@gmail.com?subject=Semlink Bug Report";
			bugLink.style.cssText = "float:right;font-size:14px;opacity:0.7;";
			titleEl.appendChild(bugLink);
		}

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

		// ══════════════════════════════════════
		// Section: Model Settings
		// ══════════════════════════════════════
		containerEl.createEl("h3", { text: t("sectionModel") });

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

		// ══════════════════════════════════════
		// Section: MCP Service
		// ══════════════════════════════════════
		containerEl.createEl("h3", { text: t("sectionMcp") });

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
					t.inputEl.style.fontFamily = "monospace";
					t.inputEl.style.fontSize = "12px";
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
					textarea.style.fontFamily = "monospace";
					textarea.style.fontSize = "12px";
				});
			});

		// ══════════════════════════════════════
		// Section: Index Management
		// ══════════════════════════════════════
		containerEl.createEl("h3", { text: t("sectionIndex") });

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
			.addButton((btn) =>
				btn
					.setButtonText(t("startFullIndex"))
					.setWarning()
					.onClick(() => {
						this.plugin.startFullIndex();
					})
			);

		// ══════════════════════════════════════
		// Section: Embedding Parameters
		// ══════════════════════════════════════
		containerEl.createEl("h3", { text: t("sectionEmbedding") });

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
}
