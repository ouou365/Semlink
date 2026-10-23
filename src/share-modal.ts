// ========================================
// Semlink - LAN share modal
// ========================================
// Shown after a conversation snapshot is registered: lists the LAN URLs the
// page is reachable on, each with one-tap copy, plus a revoke button that
// kills the share (URL 404s immediately, registry re-persisted).

import { App, Modal, Notice, setIcon } from "obsidian";
import { t } from "./i18n";

export class ShareModal extends Modal {
	constructor(
		app: App,
		private urls: string[],
		private onRevoke?: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("semlink-share-modal");
		this.contentEl.empty();
		this.contentEl.createEl("h3", { text: t("shareTitle") });
		this.contentEl.createDiv({ cls: "semlink-share-hint", text: t("shareHint") });

		for (const url of this.urls) {
			const row = this.contentEl.createDiv({ cls: "semlink-share-row" });
			row.createSpan({ cls: "semlink-share-url", text: url });
			const copyBtn = row.createEl("button", { cls: "semlink-share-copy", attr: { "aria-label": t("shareCopy") } });
			setIcon(copyBtn, "copy");
			copyBtn.addEventListener("click", () => {
				void navigator.clipboard.writeText(url).then(() => new Notice(t("shareCopied")));
			});
		}

		if (this.onRevoke) {
			const revokeBtn = this.contentEl.createEl("button", {
				cls: "semlink-share-revoke",
				text: t("shareRevoke"),
			});
			revokeBtn.addEventListener("click", () => {
				this.onRevoke?.();
				new Notice(t("shareRevoked"));
				this.close();
			});
		}
	}
}
