// ========================================
// Semlink - LAN share modal
// ========================================
// Shown after a conversation snapshot is registered: the LAN URLs other
// devices can open — each row with copy and open-in-browser actions — plus a
// revoke button that kills the share.

import { App, Modal, Notice, setIcon } from "obsidian";
import * as QRCode from "qrcode";
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

/** Options for the share dialog. */
export interface ShareQrModalOptions {
	/** LAN address other devices can open (also shown as text/QR). */
	url: string;
	/** Loopback address for previewing from THIS machine's browser. */
	previewUrl?: string;
	/** Kills the share when invoked (button hidden when absent). */
	onRevoke?: () => void;
}

/** QR-code dialog for one share URL: big scannable code, the address with
 *  copy, open-in-browser, and (when the caller allows) a revoke button. */
export class ShareQrModal extends Modal {
	constructor(app: App, private opts: ShareQrModalOptions) {
		super(app);
	}

	async onOpen(): Promise<void> {
		this.modalEl.addClass("semlink-share-modal");
		this.contentEl.empty();
		this.contentEl.createEl("h3", { text: t("shareTitle") });

		const qrWrap = this.contentEl.createDiv({ cls: "semlink-share-qr" });
		// Build the QR as an inline SVG from the raw module matrix — no
		// canvas dependency, crisp at any size.
		const qr = QRCode.create(this.opts.url, { errorCorrectionLevel: "M" });
		const size = qr.modules.size;
		let path = "";
		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				if (qr.modules.data[y * size + x]) path += `M${x} ${y}h1v1h-1z`;
			}
		}
		const NS = "http://www.w3.org/2000/svg";
		const svgEl = document.createElementNS(NS, "svg");
		svgEl.setAttribute("viewBox", `0 0 ${size} ${size}`);
		svgEl.setAttribute("shape-rendering", "crispEdges");
		const pathEl = document.createElementNS(NS, "path");
		pathEl.setAttribute("d", path);
		pathEl.setAttribute("fill", "#111");
		svgEl.appendChild(pathEl);
		qrWrap.createDiv({ cls: "semlink-share-qr-img" }).appendChild(svgEl);

		const row = this.contentEl.createDiv({ cls: "semlink-share-row" });
		row.createSpan({ cls: "semlink-share-url", text: this.opts.url });
		const copyBtn = row.createEl("button", { cls: "semlink-share-copy", attr: { "aria-label": t("shareCopy") } });
		setIcon(copyBtn, "copy");
		copyBtn.addEventListener("click", () => {
			void navigator.clipboard.writeText(this.opts.url).then(() => new Notice(t("shareCopied")));
		});
		// Local preview opens via the loopback address when available.
		const openBtn = row.createEl("button", { cls: "semlink-share-copy", attr: { "aria-label": t("shareOpenBrowser") } });
		setIcon(openBtn, "external-link");
		openBtn.addEventListener("click", () => {
			window.open(this.opts.previewUrl ?? this.opts.url, "_blank");
		});

		this.contentEl.createDiv({ cls: "semlink-share-hint", text: t("shareHint") });

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
