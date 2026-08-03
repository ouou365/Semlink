// ========================================
// Semlink - Save Answer Modal
// ========================================
// Lets the user save a chat answer to a note at a chosen path in the vault.
// Parent folders are created on demand.

import { App, Modal, Notice, Setting, normalizePath } from "obsidian";
import { t } from "./i18n";

export class SaveNoteModal extends Modal {
	private question: string;
	private answer: string;
	private pathValue: string;

	constructor(app: App, question: string, answer: string) {
		super(app);
		this.question = question;
		this.answer = answer;

		const now = new Date();
		const pad = (n: number) => String(n).padStart(2, "0");
		const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
		this.pathValue = `Semlink/回答-${ts}.md`;

		this.modalEl.addClass("smart-vault-save-modal");
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: t("saveModalTitle") });

		new Setting(contentEl)
			.setName(t("saveModalPath"))
			.setDesc(t("saveModalPathDesc"))
			.addText((text) =>
				text
					.setPlaceholder("Semlink/回答-xxx.md")
					.setValue(this.pathValue)
					.onChange((value) => {
						this.pathValue = value;
					})
			);

		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText(t("saveModalConfirm")).setClass("mod-cta").onClick(() => void this.save())
			)
			.addButton((btn) => btn.setButtonText(t("saveModalCancel")).onClick(() => this.close()));
	}

	private async save(): Promise<void> {
		const raw = this.pathValue.trim();
		const path = normalizePath(raw || `Semlink/回答-${Date.now()}.md`);

		try {
			// Create parent folders level by level (createFolder requires the
			// parent to exist and throws when the target already exists).
			const slash = path.lastIndexOf("/");
			if (slash > 0) {
				const dirs = path.slice(0, slash).split("/");
				let cur = "";
				for (const part of dirs) {
					cur = cur ? `${cur}/${part}` : part;
					await this.app.vault.createFolder(cur).catch(() => {});
				}
			}

			const content = `# ${this.question}\n\n${this.answer}\n`;
			await this.app.vault.create(path, content);
			new Notice(`${t("saveSaved")}: ${path}`);
			this.close();
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`${t("saveFailed")}: ${msg}`);
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}
