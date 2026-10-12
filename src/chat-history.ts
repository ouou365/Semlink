// ========================================
// Semlink - Chat History Store
// ========================================
// Persists chat sessions to a standalone JSON file under the plugin's data
// directory, keeping data.json (settings) lean. Sessions are capped to
// MAX_SESSIONS; the oldest are evicted when the cap is exceeded.

import type { ChatSession, HistoryMessage } from "./types";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

/** Maximum number of sessions to keep on disk. */
const MAX_SESSIONS = 500;

/** Shape of chat-history.json on disk: v1 was a bare session array; v2 wraps
 *  the sessions with an explicit folder registry. */
type StoredHistory = ChatSession[] | { sessions?: ChatSession[]; folders?: string[] };

export class ChatHistoryStore {
	private filePath: string;
	private sessions: ChatSession[] = [];
	/** Explicitly created (possibly still empty) folder paths. */
	private folderRegistry: string[] = [];
	private loaded = false;

	constructor(dataDir: string) {
		this.filePath = join(dataDir, "chat-history.json");
	}

	/** Load sessions from disk (once; subsequent calls return the cache). */
	async load(): Promise<ChatSession[]> {
		if (this.loaded) return this.sessions;
		try {
			if (existsSync(this.filePath)) {
				const raw = JSON.parse(readFileSync(this.filePath, "utf-8")) as StoredHistory;
				// v1 format was a bare session array; v2 wraps it so empty
				// folders survive without any session pointing at them.
				if (Array.isArray(raw)) {
					this.sessions = raw;
				} else {
					this.sessions = raw.sessions || [];
					this.folderRegistry = raw.folders || [];
				}
			}
		} catch {
			this.sessions = [];
		}
		this.loaded = true;
		return this.sessions;
	}

	/** Persist current sessions to disk. */
	async save(): Promise<void> {
		try {
			const dir = join(this.filePath, "..");
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			writeFileSync(this.filePath, JSON.stringify({ sessions: this.sessions, folders: this.folderRegistry }, null, 2), "utf-8");
		} catch (e) {
			console.error("[Semlink] Failed to save chat history:", e);
		}
	}

	/** All sessions, newest first. */
	list(): ChatSession[] {
		return [...this.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
	}

	/** Create a new session and return its id. */
	createSession(title: string): string {
		const now = Date.now();
		const session: ChatSession = {
			id: `s-${now}`,
			title: title.slice(0, 40) || "新对话",
			messages: [],
			createdAt: now,
			updatedAt: now,
		};
		this.sessions.push(session);
		this.evict();
		return session.id;
	}

	/** Append a message to a session, updating its timestamp + title. */
	addMessage(sessionId: string, message: HistoryMessage): void {
		const session = this.sessions.find((s) => s.id === sessionId);
		if (!session) return;
		session.messages.push(message);
		session.updatedAt = Date.now();
		// If this is the first user message, use it as the title.
		if (message.role === "user" && session.messages.filter((m) => m.role === "user").length === 1) {
			session.title = message.content.slice(0, 40) || "新对话";
		}
	}

	/** Delete a session by id. */
	deleteSession(id: string): void {
		this.sessions = this.sessions.filter((s) => s.id !== id);
	}

	/** Get a session by id. */
	get(id: string): ChatSession | undefined {
		return this.sessions.find((s) => s.id === id);
	}

	/** Patch a session (folder moves / archive toggles from the drawer). */
	updateSession(id: string, patch: Partial<Pick<ChatSession, "folder" | "archived" | "pinned">>): void {
		const session = this.sessions.find((s) => s.id === id);
		if (!session) return;
		if (patch.folder !== undefined) {
			if (patch.folder) session.folder = patch.folder;
			else delete session.folder;
		}
		if (patch.archived !== undefined) {
			if (patch.archived) session.archived = true;
			else delete session.archived;
		}
		if (patch.pinned !== undefined) {
			if (patch.pinned) session.pinned = true;
			else delete session.pinned;
		}
	}

	/** Distinct folder paths: the registry plus any session-derived ones. */
	folders(): string[] {
		const set = new Set<string>(this.folderRegistry);
		for (const s of this.sessions) if (s.folder) set.add(s.folder);
		return [...set];
	}

	/** Register a (possibly empty) folder path ("A/B" nests under A). */
	createFolder(path: string): void {
		if (!this.folderRegistry.includes(path)) this.folderRegistry.push(path);
	}

	/** Remove a folder (and any nested sub-folders) from the registry;
	 *  affected sessions become un-filed. Conversations are never deleted. */
	deleteFolder(path: string): void {
		const under = (p?: string): boolean => !!p && (p === path || p.startsWith(path + "/"));
		this.folderRegistry = this.folderRegistry.filter((f) => !under(f));
		for (const s of this.sessions) {
			if (under(s.folder)) delete s.folder;
		}
	}

	/** Rename a folder path, retargeting nested sub-paths and sessions. */
	renameFolder(oldPath: string, newPath: string): void {
		if (!newPath || newPath === oldPath) return;
		const map = (p: string): string =>
			p === oldPath ? newPath : (p.startsWith(oldPath + "/") ? newPath + p.slice(oldPath.length) : p);
		this.folderRegistry = this.folderRegistry.map(map);
		for (const s of this.sessions) {
			if (s.folder) s.folder = map(s.folder);
		}
	}

	/** Evict oldest sessions beyond MAX_SESSIONS. Pinned sessions are never
	 *  evicted — pinning is an explicit keep signal. */
	private evict(): void {
		if (this.sessions.length <= MAX_SESSIONS) return;
		this.sessions.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt);
		const pinnedCount = this.sessions.filter((s) => s.pinned).length;
		this.sessions = this.sessions.slice(0, Math.max(MAX_SESSIONS, pinnedCount));
	}
}
