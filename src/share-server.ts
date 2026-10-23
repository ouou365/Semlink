// ========================================
// Semlink - LAN share server
// ========================================
// Serves read-only snapshots of chat conversations as standalone HTML pages
// reachable from other devices on the same LAN. Snapshots live in memory
// ONLY: sharing ends when the plugin unloads / Obsidian restarts, nothing is
// written to disk, and a snapshot is reachable only via its unguessable
// random token — created when the user explicitly clicks Share.

import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { networkInterfaces } from "os";
import { randomBytes } from "crypto";

/** Upper bound on concurrent snapshots (FIFO eviction). */
const MAX_SNAPSHOTS = 20;

export class ShareServer {
	private server: Server | null = null;
	private port = 0;
	/** sessionId -> token, so re-sharing a conversation reuses its URL. */
	private tokens = new Map<string, string>();
	/** token -> rendered page HTML. */
	private pages = new Map<string, string>();

	get running(): boolean {
		return this.server !== null;
	}

	/** Start lazily before the first share. Binds all interfaces (LAN
	 *  reachability) on a random free port. */
	start(): Promise<void> {
		if (this.server) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const server = createServer((req, res) => this.handle(req, res));
			server.on("error", (err) => {
				this.server = null;
				reject(err instanceof Error ? err : new Error(String(err)));
			});
			server.listen(0, "0.0.0.0", () => {
				const addr = server.address();
				this.port = typeof addr === "object" && addr ? addr.port : 0;
				this.server = server;
				resolve();
			});
		});
	}

	stop(): Promise<void> {
		return new Promise((resolve) => {
			this.tokens.clear();
			this.pages.clear();
			if (!this.server) {
				resolve();
				return;
			}
			const server = this.server;
			this.server = null;
			server.close(() => resolve());
		});
	}

	/** Register (or refresh) the snapshot for a session; returns its stable
	 *  token. Re-sharing a session keeps the same share URL. */
	register(sessionId: string, html: string): string {
		let token = this.tokens.get(sessionId);
		if (!token) {
			token = randomBytes(12).toString("hex");
			this.tokens.set(sessionId, token);
			while (this.tokens.size > MAX_SNAPSHOTS) {
				const oldest = this.tokens.keys().next().value as string | undefined;
				if (oldest === undefined) break;
				const oldToken = this.tokens.get(oldest);
				this.tokens.delete(oldest);
				if (oldToken !== undefined) this.pages.delete(oldToken);
			}
		}
		this.pages.set(token, html);
		return token;
	}

	/** Candidate URLs, one per non-internal IPv4 interface (multi-NIC hosts
	 *  may expose several); falls back to localhost for loopback-only dev. */
	urls(token: string): string[] {
		const ips: string[] = [];
		for (const list of Object.values(networkInterfaces())) {
			for (const ni of list ?? []) {
				if (ni.family === "IPv4" && !ni.internal) ips.push(ni.address);
			}
		}
		if (ips.length === 0) ips.push("127.0.0.1");
		return [...new Set(ips)].map((ip) => `http://${ip}:${this.port}/s/${token}`);
	}

	private handle(req: IncomingMessage, res: ServerResponse): void {
		// GET-only, single route, token-checked; no CORS (plain page views).
		const m = /^\/s\/([a-f0-9]{24})$/.exec((req.url || "").split("?")[0] || "");
		const html = m ? this.pages.get(m[1]) : undefined;
		if (req.method !== "GET" || !html) {
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
