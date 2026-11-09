// ========================================
// Semlink - LAN share modal
// ========================================
// Shown after a conversation snapshot is registered: the LAN URLs other
// devices can open — each row with copy and open-in-browser actions — plus a
// revoke button that kills the share.
//
// ShareQrModal also opens in PROGRESS mode (url omitted): a spinner + live
// chunk progress while a long note renders, then the QR content fills the
// dialog in place — the click response is instant, no Notice needed.

import { App, Modal, Notice, setIcon } from "obsidian";
import * as QRCode from "qrcode";
import { t } from "./i18n";

export interface ShareModalOptions {
	/** LAN addresses other devices can open. */
	urls: string[];
	/** What the share is (conversation title / note name) — copied along
	 *  with the URL so a pasted link still says what it points at. */
	name?: string;
	/** Kills the share when invoked (button hidden when absent). */
	onRevoke?: () => void;
}

/** Copy `name` + URL (name first line, link second) when a name is known. */
function copyShareText(clipboard: Clipboard, name: string | undefined, url: string): Promise<void> {
	const text = name ? `${name}\n${url}` : url;
	return clipboard.writeText(text);
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
				void copyShareText(navigator.clipboard, this.opts.name, url).then(() => new Notice(t("shareCopied")));
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

/** Options for the share dialog. `url` may be omitted to open in PROGRESS
 *  mode — the caller fills content via setUrl / reports failure via setError
 *  while rendering runs (setProgress updates the live chunk counter). */
export interface ShareQrModalOptions {
	/** LAN address other devices can open (also shown as text/QR). */
	url?: string;
	/** What the share is (conversation title / note name) — copied along
	 *  with the URL so a pasted link still says what it points at. */
	name?: string;
	/** Kills the share when invoked (button hidden when absent). */
	onRevoke?: () => void;
}

/** 「分享详情」弹窗：条目名 + 200px 二维码 + 折行全显地址 + 复制/打开
 *  双按钮 + 停止共享（红色通栏，详情语境不二次确认）。进度模式（无 url）
 *  仍是 spinner + 分块计数，渲染完成后原地填充为详情。 */
export class ShareQrModal extends Modal {
	private progressTextEl: HTMLElement | null = null;
	private filled = false;

	constructor(app: App, private opts: ShareQrModalOptions) {
		super(app);
		// 复用基座按钮词汇（semlink-btn-secondary/btn-block 的样式挂在
		// .smart-vault-settings 作用域下）。
		this.modalEl.addClass("smart-vault-settings");
	}

	async onOpen(): Promise<void> {
		this.modalEl.addClass("semlink-share-modal");
		if (this.opts.url !== undefined) {
			this.renderContent(this.opts.url);
		} else {
			this.renderProgress();
		}
	}

	/** Progress mode: spinner + label, updated live while chunks render. */
	private renderProgress(): void {
		this.contentEl.empty();
		this.contentEl.createEl("h3", { text: t("shareTitle") });
		const wrap = this.contentEl.createDiv({ cls: "semlink-share-progress" });
		const icon = wrap.createDiv({ cls: "semlink-share-progress-icon" });
		setIcon(icon, "loader-2");
		this.progressTextEl = wrap.createDiv({
			cls: "semlink-share-progress-text",
			text: t("shareNoteRendering"),
		});
	}

	/** Live chunk counter (total <= 1 keeps the plain label). */
	setProgress(done: number, total: number): void {
		if (this.progressTextEl?.isConnected) {
			this.progressTextEl.textContent =
				total > 1 ? `${t("shareNoteRendering")} ${done}/${total}` : t("shareNoteRendering");
		}
	}

	/** Rendering failed — swap the spinner for the error and a close button. */
	setError(message: string): void {
		this.contentEl.empty();
		this.contentEl.createEl("h3", { text: t("shareTitle") });
		this.contentEl.createDiv({ cls: "semlink-share-progress is-error", text: `${t("searchError")} ${message}` });
		const closeBtn = this.contentEl.createEl("button", { cls: "semlink-btn-secondary semlink-btn-block", text: t("cancel") });
		closeBtn.addEventListener("click", () => this.close());
	}

	/** Fill the dialog with the final QR + link content (also used directly
	 *  when the URL is known up front). */
	setUrl(url: string): void {
		this.filled = true;
		this.renderContent(url);
	}

	onClose(): void {
		// Covered by contentEl.empty() below.
	}

	private renderContent(url: string): void {
		this.contentEl.empty();
		this.progressTextEl = null;

		// 头部：条目名（16/650 居中）+ 副题「局域网分享」。
		const head = this.contentEl.createDiv({ cls: "semlink-shareq-head" });
		head.createDiv({ cls: "semlink-shareq-name", text: this.opts.name ?? t("shareUntitled") });
		head.createDiv({ cls: "semlink-shareq-sub", text: t("shareTabTitle") });

		const qrWrap = this.contentEl.createDiv({ cls: "semlink-share-qr" });
		// Build the QR as an inline SVG from the raw module matrix — no
		// canvas dependency, crisp at any size.
		const qr = QRCode.create(url, { errorCorrectionLevel: "M" });
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

		// 地址行（用户拍板）：单行省略号截断（title 悬停看全貌，
		// user-select:all 点一下整段选中——选中的是 DOM 全文，复制仍完整），
		// 行尾两个图标钮：复制地址 / 在浏览器打开。
		const urlRow = this.contentEl.createDiv({ cls: "semlink-shareq-urlrow" });
		const urlBox = urlRow.createDiv({ cls: "semlink-shareq-url", text: url });
		urlBox.setAttribute("title", url);
		const copyBtn = urlRow.createEl("button", { cls: "semlink-shareq-iconbtn", attr: { "aria-label": t("shareCopy") } });
		setIcon(copyBtn, "copy");
		copyBtn.addEventListener("click", () => {
			void copyShareText(navigator.clipboard, this.opts.name, url)
				.then(() => new Notice(t("shareCopied")))
				.catch(() => new Notice(t("shareCopyFailed")));
		});
		// Local preview opens via the loopback address when available.
		const openBtn = urlRow.createEl("button", { cls: "semlink-shareq-iconbtn", attr: { "aria-label": t("shareOpenBrowser") } });
		setIcon(openBtn, "external-link");
		openBtn.addEventListener("click", () => {
			// 总是打开局域网地址（127.0.0.1 只是本机预览出口）
			window.open(url, "_blank");
		});

		this.contentEl.createDiv({ cls: "semlink-share-hint", text: t("shareHint") });

		if (this.opts.onRevoke) {
			const revokeBtn = this.contentEl.createEl("button", {
				cls: "semlink-btn-block semlink-shareq-revoke",
				text: t("shareRevoke"),
			});
			revokeBtn.addEventListener("click", () => {
				// 详情语境的破坏性操作：用户是从「已共享」列表主动进来的，
				// 立即生效 + Notice，不再二次确认。
				this.opts.onRevoke?.();
				new Notice(t("shareRevoked"));
				this.close();
			});
		}
	}
}
