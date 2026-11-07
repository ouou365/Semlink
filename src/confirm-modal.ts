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
		/** 确认按钮文字；缺省「确定」——破坏性操作应传明确动词（如「删除」），
		 *  契约 §6：禁「确定/取消」裸确认，按钮说动作、正文说后果。 */
		private okText?: string,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(this.titleText);
		this.contentEl.createEl("p", { text: this.bodyText });
		const row = this.contentEl.createDiv({ cls: "semlink-confirm-row" });
		row.createEl("button", { text: t("confirmCancel") })
			.addEventListener("click", () => this.close());
		row.createEl("button", { text: this.okText ?? t("confirmOk"), cls: "mod-warning" })
			.addEventListener("click", () => {
				this.close();
				this.onOk();
			});
	}
}
