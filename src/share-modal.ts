// ========================================
// Semlink - LAN share modal
// ========================================
// Shown after a conversation snapshot is registered: a local preview link
// (opens the page in the system browser), the LAN URLs other devices use —
// each with one-tap copy — and a revoke button that kills the share.

import { App, Modal, Notice, setIcon } from "obsidian";
import { t } from "./i18n";

export interface ShareModalOptions {
	/** LAN addresses other devices can open. */
	urls: string[];
	/** Loopback address for previewing from THIS machine's browser. */
	previewUrl: string;
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

		// Local preview: opens the page in the system browser (Obsidian's
		// window.open routes to the OS default browser).
		const openRow = this.contentEl.createDiv({ cls: "semlink-share-open" });
		const openBtn = openRow.createEl("button", { cls: "semlink-share-open-btn" });
		setIcon(openBtn, "external-link");
		openBtn.createSpan({ text: t("shareOpenBrowser") });
		openBtn.addEventListener("click", () => {
			window.open(this.opts.previewUrl, "_blank");
		});

		for (const url of this.opts.urls) {
			const row = this.contentEl.createDiv({ cls: "semlink-share-row" });
			row.createSpan({ cls: "semlink-share-url", text: url });
			const copyBtn = row.createEl("button", { cls: "semlink-share-copy", attr: { "aria-label": t("shareCopy") } });
			setIcon(copyBtn, "copy");
			copyBtn.addEventListener("click", () => {
				void navigator.clipboard.writeText(url).then(() => new Notice(t("shareCopied")));
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
