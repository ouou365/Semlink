// ========================================
// Semlink - Confirmation modal
// ========================================
// Plugin-guideline replacement for window.confirm(): a small Modal with an
// explicit destructive-looking OK button. Native confirms are flagged by
// the submission linter (obsidianmd/no-native-confirm).

import { App, Modal } from "obsidian";
import { t } from "./i18n";

export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private titleText: string,
		private bodyText: string,
		private onOk: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.titleText);
		this.contentEl.createEl("p", { text: this.bodyText });
		const row = this.contentEl.createDiv({ cls: "semlink-confirm-row" });
		row.createEl("button", { text: t("confirmCancel") })
			.addEventListener("click", () => this.close());
		row.createEl("button", { text: t("confirmOk"), cls: "mod-warning" })
			.addEventListener("click", () => {
				this.close();
				this.onOk();
			});
	}
}
