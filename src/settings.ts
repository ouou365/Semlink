// ========================================
// Semlink - Settings Tab
// ========================================

import { App, PluginSettingTab, Setting } from "obsidian";
import type SmartVaultPlugin from "../main";
import { DEFAULT_SETTINGS } from "./types";

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

		containerEl.createEl("h2", { text: "Semlink 设置" });

		// API Key
		new Setting(containerEl)
			.setName("SiliconFlow API Key")
			.setDesc("在 siliconflow.cn 获取的 API 密钥")
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
				// Mask the API key
				const input = setting.controlEl.querySelector("input") as HTMLInputElement | null;
				if (input) input.type = "password";
			});

		// Embedding Model
		new Setting(containerEl)
			.setName("嵌入模型")
			.setDesc("SiliconFlow 支持的嵌入模型")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						"BAAI/bge-m3": "BAAI/bge-m3 (推荐, 8192 tokens)",
						"Pro/BAAI/bge-m3": "Pro/BAAI/bge-m3 (增强版)",
						"BAAI/bge-large-zh-v1.5": "BAAI/bge-large-zh-v1.5 (中文优化, 512 tokens)",
						"BAAI/bge-large-en-v1.5": "BAAI/bge-large-en-v1.5 (英文优化, 512 tokens)",
					})
					.setValue(this.plugin.settings.embeddingModel)
					.onChange(async (value) => {
						this.plugin.settings.embeddingModel = value;
						await this.plugin.saveSettings();
					})
			);

		// MCP Port
		new Setting(containerEl)
			.setName("MCP 服务端口")
			.setDesc("HTTP MCP 服务监听端口")
			.addText((text) =>
				text
					.setPlaceholder("3001")
					.setValue(String(this.plugin.settings.mcpPort))
					.onChange(async (value) => {
						const port = parseInt(value, 10);
						if (!isNaN(port) && port > 0 && port < 65536) {
							this.plugin.settings.mcpPort = port;
							await this.plugin.saveSettings();
						}
					})
			);

		// MCP API Key
		new Setting(containerEl)
			.setName("MCP 访问密钥")
			.setDesc("MCP 客户端连接时需要提供的 API Key（留空则不验证）")
			.addText((text) =>
				text
					.setPlaceholder("可选认证密钥")
					.setValue(this.plugin.settings.mcpApiKey)
					.onChange(async (value) => {
						this.plugin.settings.mcpApiKey = value;
						await this.plugin.saveSettings();
					})
			);

		// Chunk Size
		new Setting(containerEl)
			.setName("分块大小")
			.setDesc("每个文本块的最大字符数（建议 500-1000）")
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

		// Chunk Overlap
		new Setting(containerEl)
			.setName("分块重叠")
			.setDesc("相邻块之间的重叠字符数")
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

		// Batch Size
		new Setting(containerEl)
			.setName("批量嵌入大小")
			.setDesc("每次 API 调用包含的文本数量（1-128）")
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

		// Request Delay
		new Setting(containerEl)
			.setName("请求间隔 (ms)")
			.setDesc("API 请求之间的延迟毫秒数（防止限流）")
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

		// Exclude paths
		new Setting(containerEl)
			.setName("排除路径")
			.setDesc("每行一个路径前缀，匹配的文件不会被索引")
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

		// Auto index
		new Setting(containerEl)
			.setName("自动索引")
			.setDesc("文件变更时自动更新向量索引")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoIndex)
					.onChange(async (value) => {
						this.plugin.settings.autoIndex = value;
						await this.plugin.saveSettings();
					})
			);

		// Actions section
		containerEl.createEl("h3", { text: "操作" });

		// Start MCP Server
		new Setting(containerEl)
			.setName("MCP 服务")
			.setDesc(this.plugin.mcpServer ? `运行中 (端口 ${this.plugin.mcpServer.port})` : "未启动")
			.addButton((btn) =>
				btn
					.setButtonText(this.plugin.mcpServer ? "重启服务" : "启动服务")
					.onClick(async () => {
						await this.plugin.restartMcpServer();
						this.display(); // Refresh UI
					})
			);

		// Full Reindex
		new Setting(containerEl)
			.setName("全量重建索引")
			.setDesc("重新扫描所有文件并生成向量（耗时较长）")
			.addButton((btn) =>
				btn
					.setButtonText("开始全量索引")
					.setWarning()
					.onClick(() => {
						this.plugin.startFullIndex();
					})
			);

		// Client config
		containerEl.createEl("h3", { text: "客户端配置" });

		const mcpUrl = `http://127.0.0.1:${this.plugin.settings.mcpPort}/mcp`;
		const configJson = JSON.stringify(
			{
				mcpServers: {
					"smart-vault": {
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
			.setName("Claude Desktop / Cursor 配置")
			.setDesc("复制以下 JSON 到 MCP 客户端配置文件中")
			.addTextArea((text) => {
				text.setValue(configJson).then((t) => {
					const textarea = t.inputEl;
					textarea.rows = 12;
					textarea.readOnly = true;
					textarea.style.fontFamily = "monospace";
					textarea.style.fontSize = "12px";
				});
			});

		new Setting(containerEl)
			.setName("Claude Code 命令")
			.setDesc("在终端运行以下命令连接")
			.addTextArea((text) => {
				const cmd = this.plugin.settings.mcpApiKey
					? `claude mcp add --transport http smart-vault ${mcpUrl} --header "Authorization: Bearer ${this.plugin.settings.mcpApiKey}"`
					: `claude mcp add --transport http smart-vault ${mcpUrl}`;
				text.setValue(cmd).then((t) => {
					t.inputEl.rows = 2;
					t.inputEl.readOnly = true;
					t.inputEl.style.fontFamily = "monospace";
					t.inputEl.style.fontSize = "12px";
				});
			});
	}
}
