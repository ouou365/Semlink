// ========================================
// Semlink - LAN share modal
// ========================================
// Shown after a conversation snapshot is registered: the LAN URLs other
// devices can open — each row with copy and open-in-browser actions — plus a
// revoke button that kills the share.

import { App, Modal, Notice, setIcon } from "obsidian";
import { t } from "./i18n";

export interface ShareModalOptions {
	/** LAN addresses other devices can open. */
	urls: string[];
	/** Kills the share when invoked (button hidden when absent). */
	onRevoke?: () => void;
}

export class ShareModal extends Modal {
	constructor(app: App, private opts: ShareModalOptions) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("semlink-share-modal");
		this.contentEl.empty();
		this.contentEl.createEl("h3", { text: t("shareTitle") });
		this.contentEl.createDiv({ cls: "semlink-share-hint", text: t("shareHint") });

		for (const url of this.opts.urls) {
			const row = this.contentEl.createDiv({ cls: "semlink-share-row" });
			row.createSpan({ cls: "semlink-share-url", text: url });
			const copyBtn = row.createEl("button", { cls: "semlink-share-copy", attr: { "aria-label": t("shareCopy") } });
			setIcon(copyBtn, "copy");
			copyBtn.addEventListener("click", () => {
				void navigator.clipboard.writeText(url).then(() => new Notice(t("shareCopied")));
			});
			// Open THIS row's address in the system browser (Obsidian's
			// window.open routes to the OS default browser).
			const openBtn = row.createEl("button", { cls: "semlink-share-copy", attr: { "aria-label": t("shareOpenBrowser") } });
			setIcon(openBtn, "external-link");
			openBtn.addEventListener("click", () => {
				window.open(url, "_blank");
			});
		}

		if (this.opts.onRevoke) {
			const revokeBtn = this.contentEl.createEl("button", {
				cls: "semlink-share-revoke",
				text: t("shareRevoke"),
			});
			revokeBtn.addEventListener("click", () => {
				this.opts.onRevoke?.();
				new Notice(t("shareRevoked"));
				this.close();
			});
		}
	}
}
