// ========================================
// Semlink - Chat History Store
// ========================================
// Persists chat sessions as one JSON blob in the DB worker's OPFS (off the
// main thread — the file grows into tens of MB and main-thread writeFileSync
// blocked the renderer on every save). First load migrates the legacy disk
// file (data/chat-history.json) into OPFS and retires it; on OPFS write
// failure the legacy disk path stays as a fallback. Sessions are capped to
// MAX_SESSIONS; the oldest are evicted when the cap is exceeded.

import type { ChatSession, HistoryMessage } from "./types";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { join } from "path";

/** Maximum number of sessions to keep on disk. */
const MAX_SESSIONS = 500;

/** Shape of chat-history.json: v1 was a bare session array; v2 wraps the
 *  sessions with an explicit folder registry. */
type StoredHistory = ChatSession[] | { sessions?: ChatSession[]; folders?: string[] };

/** 存储通道（worker OPFS RPC）。read 返回 null = OPFS 无数据（首次迁移）。 */
export interface ChatHistoryIo {
	read(): Promise<string | null>;
	write(json: string): Promise<unknown>;
}

export class ChatHistoryStore {
	private legacyPath: string;
	private sessions: ChatSession[] = [];
	/** Explicitly created (possibly still empty) folder paths. */
	private folderRegistry: string[] = [];
	private loaded = false;
	/** load 时发现数据来自旧磁盘文件（OPFS 空）→ 首次 save 后把旧文件改名
	 *  退役，防下轮又从旧文件回灌。 */
	private retireLegacy = false;
	private legacyRetired = false;

	constructor(private io: ChatHistoryIo, dataDir: string) {
		this.legacyPath = join(dataDir, "chat-history.json");
	}

	/** Load sessions (once; subsequent calls return the cache). OPFS 优先，
	 *  OPFS 无数据时回落旧磁盘文件（迁移源）。 */
	async load(): Promise<ChatSession[]> {
		if (this.loaded) return this.sessions;
		try {
			const raw = (await this.io.read()) ?? this.readLegacy();
			if (raw) {
				const parsed = JSON.parse(raw) as StoredHistory;
				// v1 format was a bare session array; v2 wraps it so empty
				// folders survive without any session pointing at them.
				if (Array.isArray(parsed)) {
					this.sessions = parsed;
				} else {
					this.sessions = parsed.sessions || [];
					this.folderRegistry = parsed.folders || [];
				}
			}
		} catch (e) {
			console.error("[Semlink] Failed to load chat history:", e);
			this.sessions = [];
		}
		this.loaded = true;
		return this.sessions;
	}

	/** 旧磁盘文件（迁移源）：OPFS 无数据时读一次。 */
	private readLegacy(): string | null {
		try {
			if (!existsSync(this.legacyPath)) return null;
			const text = readFileSync(this.legacyPath, "utf-8");
			if (text.trim().length === 0) return null;
			this.retireLegacy = true;
			return text;
		} catch {
			return null;
		}
	}

	/** Persist current sessions（worker OPFS RPC，主线程零阻塞）。紧凑
	 *  序列化（无缩进）——16MB 级 blob 缩 1/3，parse/write 同步提速。OPFS
	 *  写失败回落旧磁盘路径（保底可读）。 */
	async save(): Promise<void> {
		const json = JSON.stringify({ sessions: this.sessions, folders: this.folderRegistry });
		try {
			await this.io.write(json);
			if (this.retireLegacy && !this.legacyRetired) {
				// OPFS 已接管 → 旧磁盘文件改名退役（防下轮空 OPFS 时又从旧
				// 文件回灌出双头数据）。失败无碍——OPFS 已是唯一事实源。
				try {
					if (existsSync(this.legacyPath)) renameSync(this.legacyPath, this.legacyPath + ".pre-opfs");
					this.legacyRetired = true;
				} catch { /* 改名失败不影响功能 */ }
			}
		} catch (e) {
			console.error("[Semlink] Failed to save chat history to OPFS, falling back to disk:", e);
			try {
				const dir = join(this.legacyPath, "..");
				if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
				writeFileSync(this.legacyPath, json, "utf-8");
			} catch (e2) {
				console.error("[Semlink] Failed to save chat history to disk fallback:", e2);
			}
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

	/** Drop session messages from `index` onward (edit-and-regenerate
	 *  truncation), or `deleteCount` of them from `index` (per-turn delete).
	 *  Message objects are shared with the view's currentMessages — the view
	 *  splices its own array separately and edits fields on the shared refs. */
	spliceMessages(sessionId: string, index: number, deleteCount?: number): void {
		const session = this.sessions.find((s) => s.id === sessionId);
		if (!session) return;
		if (deleteCount === undefined) session.messages.splice(index);
		else session.messages.splice(index, deleteCount);
		session.updatedAt = Date.now();
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
	updateSession(id: string, patch: Partial<Pick<ChatSession, "folder" | "archived" | "pinned" | "projectId">>): void {
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
		if (patch.projectId !== undefined) {
			if (patch.projectId) session.projectId = patch.projectId;
			else delete session.projectId;
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
