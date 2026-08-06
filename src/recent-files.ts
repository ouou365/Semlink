// ========================================
// Semlink - Recent Files Tracker
// ========================================
// Tracks the most recently opened / created / edited vault files and persists
// them to a standalone JSON under the plugin's data directory, so the welcome
// screen's AI-generated questions can follow what the user is working on.

import type { Vault } from "obsidian";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

/** Maximum number of tracked files (oldest are evicted). */
const MAX_FILES = 60;
/** Debounce delay before persisting a burst of record() calls. */
const SAVE_DEBOUNCE_MS = 3000;

export interface RecentFileEntry {
	path: string;
	ts: number;
}

export class RecentFilesTracker {
	private filePath: string;
	private entries: RecentFileEntry[] = [];
	private loaded = false;
	private saveTimer: number | null = null;

	constructor(private vault: Vault, dataDir: string) {
		this.filePath = join(dataDir, "recent-files.json");
	}

	/** Load tracked files from disk (once; subsequent calls return cache). */
	load(): RecentFileEntry[] {
		if (this.loaded) return this.entries;
		try {
			if (existsSync(this.filePath)) {
				const raw = readFileSync(this.filePath, "utf-8");
				const parsed = JSON.parse(raw);
				if (Array.isArray(parsed)) {
					this.entries = parsed.filter(
						(e) => typeof e?.path === "string" && typeof e?.ts === "number",
					);
				}
			}
		} catch {
			this.entries = [];
		}
		this.loaded = true;
		return this.entries;
	}

	/** Record file activity (open / create / modify), newest first. */
	record(path: string, ts = Date.now()): void {
		this.load();
		const existing = this.entries.find((e) => e.path === path);
		if (existing) {
			existing.ts = ts;
		} else {
			this.entries.push({ path, ts });
		}
		this.entries.sort((a, b) => b.ts - a.ts);
		if (this.entries.length > MAX_FILES) {
			this.entries = this.entries.slice(0, MAX_FILES);
		}
		this.scheduleSave();
	}

	/** Persist now (used on plugin unload; record() saves debounced). */
	save(): void {
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		try {
			const dir = join(this.filePath, "..");
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2), "utf-8");
		} catch (e) {
			console.error("[Semlink] Failed to save recent files:", e);
		}
	}

	/** Basenames of the n most recently touched files. Falls back to the
	 *  vault's markdown files by mtime when nothing has been tracked yet. */
	getRecentNames(n: number): string[] {
		this.load();
		let list: RecentFileEntry[] = this.entries;
		if (list.length === 0) {
			list = this.vault
				.getMarkdownFiles()
				.map((f) => ({ path: f.path, ts: f.stat?.mtime ?? 0 }))
				.sort((a, b) => b.ts - a.ts);
		}
		return list
			.slice(0, n)
			.map((e) => e.path.split("/").pop() || e.path)
			.filter((name) => name.length > 0);
	}

	private scheduleSave(): void {
		if (this.saveTimer !== null) return;
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			this.save();
		}, SAVE_DEBOUNCE_MS);
	}
}
