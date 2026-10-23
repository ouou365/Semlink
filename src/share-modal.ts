// ========================================
// Semlink - LAN share modal
// ========================================
// Shown after a conversation snapshot is registered: lists the LAN URLs the
// page is reachable on, each with one-tap copy. Pure display — the snapshot
// itself was already registered by the search view.

import { App, Modal, Notice, setIcon } from "obsidian";
import { t } from "./i18n";

export class ShareModal extends Modal {
	constructor(app: App, private urls: string[]) {
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
	}
}
