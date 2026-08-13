// ========================================
// Semlink - Add Feishu Bot Modal (manual)
// ========================================
// Manual appId/appSecret entry for binding a Feishu bot. The primary
// scan-to-create flow is embedded directly in the bot settings tab.

import { App, Modal, Notice, Setting } from "obsidian";
import type SmartVaultPlugin from "../main";
import { verifyFeishuApp } from "./feishu-auth";
import { t } from "./i18n";

export class AddFeishuBotModal extends Modal {
	private plugin: SmartVaultPlugin;
	private onAdded?: () => void;

	constructor(app: App, plugin: SmartVaultPlugin, onAdded?: () => void) {
		super(app);
		this.plugin = plugin;
		this.onAdded = onAdded;
		this.modalEl.addClass("smart-vault-feishu-modal");
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: t("botAddManual") });

		let name = "Feishu Bot";
		let appId = "";
		let appSecret = "";

		new Setting(contentEl).setName(t("botName")).addText((text) => text.setPlaceholder("Semlink").onChange((v) => (name = v)));
		new Setting(contentEl).setName(t("botAppId")).addText((text) => text.setPlaceholder("cli_xxx").onChange((v) => (appId = v.trim())));
		new Setting(contentEl).setName(t("botAppSecret")).addText((text) => text.setPlaceholder("xxx").onChange((v) => (appSecret = v.trim())));

		contentEl.createDiv({ cls: "feishu-prereq", text: t("botPrereq") });

		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText(t("saveModalConfirm")).setClass("mod-cta").onClick(async () => {
					if (!appId || !appSecret) {
						new Notice(t("botVerifyFailed"));
						return;
					}
					const result = await verifyFeishuApp(appId, appSecret);
					if (!result.ok) {
						new Notice(result.error ? `${t("botVerifyFailed")}（${result.error}）` : t("botVerifyFailed"));
						return;
					}
					this.plugin.settings.feishuBots.push({
						id: `bot-${Date.now()}`,
						name: name || "Feishu Bot",
						appId,
						appSecret,
						enabled: true,
						connected: false,
					});
					await this.plugin.saveSettings();
					new Notice(t("botSaved"));
					this.onAdded?.();
					this.close();
				})
			)
			.addButton((btn) => btn.setButtonText(t("saveModalCancel")).onClick(() => this.close()));
	}

	onClose() {
		this.contentEl.empty();
	}
}
