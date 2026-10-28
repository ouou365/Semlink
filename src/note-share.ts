// ========================================
// Semlink - Note LAN sharing
// ========================================
// Publishes a single note as a read-only web page on the LAN, reusing the
// chat share infrastructure: the ShareServer registry keys the note by
// `note:<vault path>` (chat sessions use bare session ids), and the page is
// rendered by the same postcard renderer via a one-message HistoryMessage.
//
// Re-sharing a note keeps its URL (same registry token) and refreshes the
// cached snapshot to the note's CURRENT content — so the icon is also the
// "update the shared copy" action. Renaming a note orphans its share (the
// old URL 404s); share it again to re-publish under the new path.

import { App, Component, Notice, TFile } from "obsidian";
import { ShareServer } from "./share-server";
import { ShareQrModal } from "./share-modal";
import { renderSharePage, renderMarkdownChunked } from "./share-page";
import { t } from "./i18n";

export class NoteShare {
	constructor(
		private app: App,
		private server: ShareServer,
		/** Lifecycle owner for the off-screen markdown render. */
		private component: Component,
		/** Read the note's current markdown (vault read). */
		private readNote: (path: string) => Promise<string | null>,
		/** Persist settings when the share server's port auto-bumped. */
		private persist: () => Promise<void>,
		/** Port preference from settings. */
		private preferredPort: () => number,
		/** Notifies the host that share state changed (icon refresh). */
		private onChanged: () => void = () => {},
	) {}

	/** Registry key for a note path (`note:` prefix vs bare chat ids). */
	private key(path: string): string {
		return `note:${path}`;
	}

	isShared(path: string): boolean {
		return this.server.listShares().some((s) => s.sessionId === this.key(path));
	}

	token(path: string): string | null {
		return this.server.listShares().find((s) => s.sessionId === this.key(path))?.token ?? null;
	}

	/** Render the note into the standalone postcard page. Shared by the live
	 *  share action and the request-driven re-render after a restart. The
	 *  markdown is rendered in UI-yielding chunks — a long note no longer
	 *  freezes the editor for seconds in one MarkdownRenderer call. */
	async renderPage(
		path: string,
		content: string,
		sharedAt: number,
		onProgress?: (done: number, total: number) => void,
	): Promise<string> {
		// One assistant bubble = one continuous document; the renderer handles
		// Obsidian markdown (headings, tables, code) exactly like chat answers.
		const html = await renderMarkdownChunked(this.app, content, this.component, onProgress);
		return renderSharePage(
			this.app,
			[{ role: "assistant", content, timestamp: sharedAt }],
			path.split("/").pop()?.replace(/\.[^.]+$/, "") || path,
			this.component,
			"light",
			sharedAt,
			html,
		);
	}

	/** Share (or refresh) the note's LAN snapshot and open the link dialog.
	 *  The server is started on demand — notes are usually shared before any
	 *  chat share exists. The dialog opens INSTANTLY in progress mode (the
	 *  chunk counter fills in place), so a long document never reads as a
	 *  frozen UI — no Notice needed. */
	async share(path: string): Promise<void> {
		const content = await this.readNote(path);
		if (content === null) {
			new Notice(t("shareNoteMissing"));
			return;
		}
		await this.server.ensureStarted(this.preferredPort());
		if (this.server.port !== this.preferredPort()) {
			await this.persist();
		}
		const modal = new ShareQrModal(this.app, {
			name: path.split("/").pop()?.replace(/\.[^.]+$/, "") || path,
			onRevoke: () => {
				this.revoke(path);
			},
		});
		modal.open();
		try {
			const token = this.server.register(
				this.key(path),
				await this.renderPage(path, content, Date.now(), (done, total) => modal.setProgress(done, total)),
			);
			// Register caches the snapshot; re-share refreshes it to CURRENT
			// content while the URL stays stable.
			modal.setUrl(this.server.urls(token)[0]);
		} catch (e) {
			modal.setError(e instanceof Error ? e.message : String(e));
			return;
		}
		this.onChanged();
	}

	/** Open the link dialog for an already-shared note (QR + copy + open +
	 *  stop sharing). The modal opens IMMEDIATELY with the existing snapshot;
	 *  the refresh to the note's current content happens in the background —
	 *  re-tapping the icon after an edit never blocks on a long render. */
	async showShareDialog(path: string): Promise<void> {
		const token = this.token(path);
		if (!token) {
			await this.share(path);
			return;
		}
		new ShareQrModal(this.app, {
			url: this.server.urls(token)[0],
			name: path.split("/").pop()?.replace(/\.[^.]+$/, "") || path,
			onRevoke: () => {
				this.revoke(path);
			},
		}).open();
		// Background refresh: same token, updated snapshot. Best-effort and
		// silent — chunked rendering keeps the UI responsive, and a failed
		// render just leaves the previous snapshot in place.
		void this.readNote(path).then((content) => {
			if (content === null) return;
			return this.renderPage(path, content, this.sharedAtOf(token))
				.then((html) => {
					this.server.register(this.key(path), html);
				})
				.catch(() => {});
		});
	}

	/** The share moment of a token (stable page timestamp across refreshes). */
	private sharedAtOf(token: string): number {
		return this.server.listShares().find((s) => s.token === token)?.sharedAt ?? Date.now();
	}

	/** Kill the note's share (URL 404s immediately) and refresh the icon. */
	revoke(path: string): void {
		this.server.revokeSession(this.key(path));
		this.onChanged();
	}
}

/** Editor-header share action for the active markdown view: one icon in two
 *  colors — theme-default gray when unshared, accent color when the note is
 *  already published. The button element is attached to the view once
 *  (addAction), then re-styled on file switches. */
export function attachNoteShareAction(
	view: { addAction: (icon: string, title: string, cb: () => void) => HTMLElement; file: TFile | null },
	onClick: (path: string) => void,
	isShared: (path: string) => boolean,
	title: string,
): void {
	let btn = (view as unknown as { semlinkShareBtn?: HTMLElement }).semlinkShareBtn;
	if (!btn || !btn.isConnected) {
		btn = view.addAction("upload", title, () => {
			const path = view.file?.path;
			if (path) onClick(path);
		});
		(view as unknown as { semlinkShareBtn?: HTMLElement }).semlinkShareBtn = btn;
	}
	const shared = view.file?.path ? isShared(view.file.path) : false;
	btn.toggleClass("semlink-share-btn-active", shared);
	btn.setAttribute("aria-label", shared ? t("shareNoteShared") : title);
}
