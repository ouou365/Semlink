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
const MAX_SESSIONS = 50;

export class ChatHistoryStore {
	private filePath: string;
	private sessions: ChatSession[] = [];
	private loaded = false;

	constructor(dataDir: string) {
		this.filePath = join(dataDir, "chat-history.json");
	}

	/** Load sessions from disk (once; subsequent calls return the cache). */
	async load(): Promise<ChatSession[]> {
		if (this.loaded) return this.sessions;
		try {
			if (existsSync(this.filePath)) {
				const raw = readFileSync(this.filePath, "utf-8");
				this.sessions = JSON.parse(raw) || [];
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
			writeFileSync(this.filePath, JSON.stringify(this.sessions, null, 2), "utf-8");
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

	/** Evict oldest sessions beyond MAX_SESSIONS. */
	private evict(): void {
		if (this.sessions.length <= MAX_SESSIONS) return;
		this.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
		this.sessions = this.sessions.slice(0, MAX_SESSIONS);
	}
}
