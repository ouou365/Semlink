// ========================================
// Semlink - Chat Models Modal
// ========================================

import { App, Modal, Setting } from "obsidian";
import type SmartVaultPlugin from "../main";
import type { ChatProvider } from "./types";
import { t } from "./i18n";
import { parseContextWindow, formatContextWindow } from "./settings-models";

export class ChatModelsModal extends Modal {
	private plugin: SmartVaultPlugin;
	private provider: ChatProvider;
	private onChange: (() => void) | null;

	constructor(app: App, plugin: SmartVaultPlugin, provider: ChatProvider, onChange?: () => void) {
		super(app);
		this.plugin = plugin;
		this.provider = provider;
		this.onChange = onChange ?? null;
		this.modalEl.addClass("smart-vault-chat-models-modal");
	}

	onOpen() {
		this.render();
	}

	onClose() {
		this.contentEl.empty();
	}

	private render() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: `${t("chatModels")} — ${this.provider.name}` });

		const models = this.provider.models;

		if (models.length === 0) {
			contentEl.createDiv({ cls: "model-empty", text: t("chatNoModels") });
		}

		models.forEach((model, mi) => {
			new Setting(contentEl)
				.setName(t("chatModelId"))
				.addText((text) =>
					text
						.setPlaceholder("model-id")
						.setValue(model.id)
						.onChange(async (value) => {
							model.id = value;
							await this.plugin.saveSettings();
						})
				)
				.addText((text) =>
					text
						.setPlaceholder("200000")
						.setValue(model.contextWindow != null ? formatContextWindow(model.contextWindow) : "")
						.onChange(async (value) => {
							const n = parseContextWindow(value);
							if (n !== null) {
								model.contextWindow = n;
								await this.plugin.saveSettings();
							}
						})
				)
				.addExtraButton((btn) => {
					btn.setIcon("trash")
						.setTooltip(t("chatDeleteModel"))
						.onClick(async () => {
							models.splice(mi, 1);
							await this.plugin.saveSettings();
							this.onChange?.();
							this.render();
						});
				});
		});

		// Footer: add model + done
		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText(t("chatAddModel")).setClass("mod-cta").onClick(async () => {
					models.push({ id: "new-model", contextWindow: 200000 });
					await this.plugin.saveSettings();
					this.onChange?.();
					this.render();
				})
			)
			.addButton((btn) => btn.setButtonText(t("chatDone")).onClick(() => this.close()));
	}
}
