// ========================================
// Semlink - LAN share server
// ========================================
// Serves read-only snapshots of chat conversations as standalone HTML pages
// reachable from other devices on the same LAN.
//
// Persistence model (share URLs survive Obsidian restarts as long as the
// machine's IP is unchanged):
//  - token ↔ sessionId pairs persist in data/share-registry.json;
//  - the port persists in settings (auto-bumped when taken) and the server
//    starts with the plugin whenever the registry is non-empty;
//  - page HTML is NOT persisted: on a request for an uncached token the
//    server re-renders the session through the injected `render` callback
//    (Obsidian-side markdown) and caches it in memory.

import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { networkInterfaces } from "os";
import { randomBytes } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

/** Upper bound on persisted shares (FIFO eviction, oldest link dies). */
const MAX_SHARES = 50;

interface StoredRegistry {
	shares?: Array<{ token: string; sessionId: string; enabled?: boolean }>;
}

export class ShareServer {
	private server: Server | null = null;
	private listenPort = 0;
	private dataDir: string;
	private registryPath: string;
	/** sessionId -> token (re-share reuses the same URL). */
	private tokens = new Map<string, string>();
	/** token -> sessionId (reverse lookup for request-driven rendering). */
	private sessions = new Map<string, string>();
	/** Tokens currently serving 200s; a paused share stays registered but
	 *  answers 404 until re-enabled. Missing from the set = enabled. */
	private paused = new Set<string>();
	/** token -> rendered page HTML (in-memory cache only). */
	private pages = new Map<string, string>();
	/** In-flight render promises, so concurrent hits render once. */
	private pending = new Map<string, Promise<string | null>>();

	constructor(dataDir: string, private render: (sessionId: string) => Promise<string | null>) {
		this.dataDir = dataDir;
		this.registryPath = join(dataDir, "share-registry.json");
		this.loadRegistry();
	}

	get running(): boolean {
		return this.server !== null;
	}

	/** The port the server is actually listening on (may differ from the
	 *  preferred one when it was taken — the caller persists this). */
	get port(): number {
		return this.listenPort;
	}

	/** True when at least one share link exists (persisted). */
	hasShares(): boolean {
		return this.tokens.size > 0;
	}

	private loadRegistry(): void {
		try {
			if (!existsSync(this.registryPath)) return;
			const raw = JSON.parse(readFileSync(this.registryPath, "utf-8")) as StoredRegistry;
			for (const { token, sessionId, enabled } of raw.shares ?? []) {
				if (typeof token === "string" && typeof sessionId === "string") {
					this.tokens.set(sessionId, token);
					this.sessions.set(token, sessionId);
					if (enabled === false) this.paused.add(token);
				}
			}
		} catch (e) {
			console.warn("[Semlink] failed to load share registry:", e);
		}
	}

	private persistRegistry(): void {
		try {
			if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true });
			const shares = [...this.tokens.entries()].map(([sessionId, token]) => ({
				token,
				sessionId,
				enabled: !this.paused.has(token),
			}));
			writeFileSync(this.registryPath, JSON.stringify({ shares }, null, 2), "utf-8");
		} catch (e) {
			console.warn("[Semlink] failed to persist share registry:", e);
		}
	}

	/** Start listening. `preferredPort` comes from settings; when taken the
	 *  port is bumped (up to 10 tries) — the caller should persist the
	 *  actual port (see `port`) so restarts reuse it. */
	start(preferredPort: number): Promise<void> {
		if (this.server) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const server = createServer((req, res) => {
				void this.handle(req, res).catch((e) => {
					console.error("[Semlink] share request failed:", e);
					res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
					res.end("Internal error");
				});
			});
			let attempt = 0;
			const tryListen = (): void => {
				server.once("error", (err: NodeJS.ErrnoException) => {
					if (err.code === "EADDRINUSE" && ++attempt < 10) {
						this.listenPort += 1;
						tryListen();
					} else {
						this.server = null;
						reject(err instanceof Error ? err : new Error(String(err)));
					}
				});
				server.listen(this.listenPort, "0.0.0.0", () => {
					server.removeAllListeners("error");
					this.server = server;
					resolve();
				});
			};
			this.listenPort = preferredPort;
			tryListen();
		});
	}

	/** Idempotent start with the last-known port. */
	async ensureStarted(preferredPort: number): Promise<void> {
		if (this.server) return;
		await this.start(preferredPort);
	}

	stop(): Promise<void> {
		return new Promise((resolve) => {
			// Pages are a cache — cleared, while the persisted registry (the
			// share URLs themselves) survives the restart by design.
			this.pages.clear();
			this.pending.clear();
			this.paused.clear();
			if (!this.server) {
				resolve();
				return;
			}
			const server = this.server;
			this.server = null;
			// Keep-alive clients could otherwise hold the port after plugin
			// unload — dropping established connections frees the port at
			// once so a plugin reload rebinds the SAME port (no drift, share
			// URLs stay valid).
			server.closeAllConnections?.();
			server.close(() => resolve());
		});
	}

	/** Register (or refresh) the snapshot for a session; returns its stable
	 *  token. Re-sharing a session keeps the same share URL; new tokens are
	 *  persisted so the URL keeps working across restarts. */
	register(sessionId: string, html: string): string {
		let token = this.tokens.get(sessionId);
		if (!token) {
			token = randomBytes(12).toString("hex");
			this.tokens.set(sessionId, token);
			this.sessions.set(token, sessionId);
			this.paused.delete(token);
			while (this.tokens.size > MAX_SHARES) {
				const oldest = this.tokens.keys().next().value as string | undefined;
				if (oldest === undefined) break;
				const oldToken = this.tokens.get(oldest);
				this.tokens.delete(oldest);
				if (oldToken !== undefined) {
					this.sessions.delete(oldToken);
					this.pages.delete(oldToken);
				}
			}
			this.persistRegistry();
		}
		this.pages.set(token, html);
		return token;
	}

	/** Remove a session's share entirely: the URL dies immediately (requests
	 *  404) and the registry is re-persisted. Returns true if it existed. */
	revokeSession(sessionId: string): boolean {
		const token = this.tokens.get(sessionId);
		if (!token) return false;
		return this.revokeToken(token);
	}

	/** Remove one share by token (settings-page management). */
	revokeToken(token: string): boolean {
		const sessionId = this.sessions.get(token);
		if (!sessionId) return false;
		this.tokens.delete(sessionId);
		this.sessions.delete(token);
		this.paused.delete(token);
		this.pages.delete(token);
		this.persistRegistry();
		return true;
	}

	/** Pause (404 while paused, registry kept) or resume a share. */
	setShareEnabled(token: string, enabled: boolean): boolean {
		if (!this.sessions.has(token)) return false;
		if (enabled) this.paused.delete(token);
		else {
			this.paused.add(token);
			this.pages.delete(token);
		}
		this.persistRegistry();
		return true;
	}

	/** All registered shares for the settings page (title resolution is the
	 *  caller's job — it owns the chat-history store). */
	listShares(): Array<{ token: string; sessionId: string; enabled: boolean }> {
		return [...this.tokens.entries()].map(([sessionId, token]) => ({
			token,
			sessionId,
			enabled: !this.paused.has(token),
		}));
	}

	/** Candidate URLs, one per non-internal IPv4 interface (multi-NIC hosts
	 *  may expose several); falls back to localhost for loopback-only dev.
	 *  `query` carries the locked display preferences (?lang=..&theme=..)
	 *  — the server itself ignores it, the embedded page script consumes it. */
	urls(token: string, query?: string): string[] {
		const ips: string[] = [];
		for (const list of Object.values(networkInterfaces())) {
			for (const ni of list ?? []) {
				if (ni.family === "IPv4" && !ni.internal) ips.push(ni.address);
			}
		}
		if (ips.length === 0) ips.push("127.0.0.1");
		const suffix = query ? `?${query}` : "";
		return [...new Set(ips)].map((ip) => `http://${ip}:${this.port}/s/${token}${suffix}`);
	}

	private async page(token: string): Promise<string | null> {
		const cached = this.pages.get(token);
		if (cached !== undefined) return cached;
		const sessionId = this.sessions.get(token);
		if (!sessionId || this.paused.has(token)) return null;
		const inflight = this.pending.get(token);
		if (inflight) return inflight;
		const job = this.render(sessionId)
			.then((html) => {
				this.pending.delete(token);
				if (html === null) return null;
				this.pages.set(token, html);
				return html;
			})
			.catch((e) => {
				this.pending.delete(token);
				console.error("[Semlink] share page render failed:", e);
				return null;
			});
		this.pending.set(token, job);
		return job;
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		// GET-only, single route, token-checked; no CORS (plain page views).
		const m = /^\/s\/([a-f0-9]{24})$/.exec((req.url || "").split("?")[0] || "");
		if (req.method !== "GET" || !m) {
			res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("Not found");
			return;
		}
		const html = await this.page(m[1]);
		if (!html) {
			res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("Not found");
			return;
		}
		res.writeHead(200, {
			"Content-Type": "text/html; charset=utf-8",
			"X-Content-Type-Options": "nosniff",
			"Cache-Control": "no-store",
		});
		res.end(html);
	}
}
