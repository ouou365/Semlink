// ========================================
// Semlink - Usage Store (Pro usage dashboard)
// ========================================
// Append-only local log of per-request chat token usage, persisted to a
// standalone JSON file under the plugin's data directory (same pattern as
// chat-history.ts). Records are capped; aggregation happens on read.
// Recording runs for ALL users (it's the user's own local data) — only the
// dashboard VIEW is Pro-gated.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

export interface UsageRecord {
	ts: number;
	model: string;
	/** Input (prompt) tokens, summed across all rounds of the request. */
	inTok: number;
	/** Output (completion) tokens. */
	outTok: number;
}

/** Hard cap on stored records (drop oldest). ~5k requests is years of
 *  personal use; the file stays well under a megabyte. */
const MAX_RECORDS = 5000;

export class UsageStore {
	private filePath: string;
	private records: UsageRecord[] = [];
	private loaded = false;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(dataDir: string) {
		this.filePath = join(dataDir, "usage-stats.json");
	}

	/** Load from disk once; later calls return the cache. */
	async load(): Promise<UsageRecord[]> {
		if (this.loaded) return this.records;
		try {
			if (existsSync(this.filePath)) {
				this.records = (JSON.parse(readFileSync(this.filePath, "utf-8")) as UsageRecord[]) || [];
			}
		} catch {
			this.records = [];
		}
		this.loaded = true;
		return this.records;
	}

	/** Append one request's usage. Save is debounced (bursts of requests
	 *  coalesce into one disk write). */
	record(u: { model: string; promptTokens: number; completionTokens: number }): void {
		if (!u.model || (u.promptTokens <= 0 && u.completionTokens <= 0)) return;
		this.records.push({ ts: Date.now(), model: u.model, inTok: u.promptTokens, outTok: u.completionTokens });
		if (this.records.length > MAX_RECORDS) {
			this.records = this.records.slice(-MAX_RECORDS);
		}
		if (this.saveTimer) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => void this.save(), 2000);
	}

	async save(): Promise<void> {
		if (this.saveTimer) { window.clearTimeout(this.saveTimer); this.saveTimer = null; }
		try {
			const dir = join(this.filePath, "..");
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			writeFileSync(this.filePath, JSON.stringify(this.records), "utf-8");
		} catch (e) {
			console.error("[Semlink] Failed to save usage stats:", e);
		}
	}

	async clear(): Promise<void> {
		this.records = [];
		await this.save();
	}

	// ── Aggregations (all computed from the in-memory records) ──

	static monthKey(ts: number): string {
		const d = new Date(ts);
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
	}

	static dayKey(ts: number): string {
		const d = new Date(ts);
		return `${d.getMonth() + 1}/${d.getDate()}`;
	}

	/** Per-model totals over a set of records. */
	private static byModel(records: UsageRecord[]): Map<string, { reqs: number; inTok: number; outTok: number }> {
		const m = new Map<string, { reqs: number; inTok: number; outTok: number }>();
		for (const r of records) {
			const cur = m.get(r.model) ?? { reqs: 0, inTok: 0, outTok: 0 };
			cur.reqs++; cur.inTok += r.inTok; cur.outTok += r.outTok;
			m.set(r.model, cur);
		}
		return m;
	}

	/** Everything the dashboard renders. Prices (USD per 1M tokens) are
	 *  joined in by the caller from settings; cost is null when unknown. */
	async summary(priceOf: (model: string) => { in: number | null; out: number | null } | null): Promise<{
		totalCost: number | null;
		monthCost: number | null;
		totalReqs: number;
		monthReqs: number;
		totalIn: number;
		totalOut: number;
		hasAnyPrice: boolean;
		models: Array<{ model: string; reqs: number; inTok: number; outTok: number; cost: number | null }>;
		days: Array<{ label: string; cost: number | null; tokens: number }>;
	}> {
		const records = await this.load();
		const now = new Date();
		const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
		const monthRecords = records.filter((r) => r.ts >= monthStart);

		const cost = (rs: UsageRecord[]): number | null => {
			let sum = 0;
			let any = false;
			for (const r of rs) {
				const p = priceOf(r.model);
				if (!p) continue;
				// Partial pricing still counts what it can.
				sum += ((p.in ?? 0) * r.inTok + (p.out ?? 0) * r.outTok) / 1_000_000;
				if (p.in !== null || p.out !== null) any = true;
			}
			return any ? sum : null;
		};

		const hasAnyPrice = [...UsageStore.byModel(records).keys()].some((m) => {
			const p = priceOf(m);
			return p && (p.in !== null || p.out !== null);
		});

		// Last 30 days, day buckets, oldest → newest.
		const DAY = 24 * 3600 * 1000;
		const days: Array<{ label: string; cost: number | null; tokens: number }> = [];
		const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
		for (let i = 29; i >= 0; i--) {
			const from = startOfToday - i * DAY;
			const to = from + DAY;
			const rs = records.filter((r) => r.ts >= from && r.ts < to);
			days.push({
				label: UsageStore.dayKey(from),
				cost: rs.length ? cost(rs) : 0,
				tokens: rs.reduce((n, r) => n + r.inTok + r.outTok, 0),
			});
		}

		return {
			totalCost: records.length ? cost(records) : 0,
			monthCost: monthRecords.length ? cost(monthRecords) : 0,
			totalReqs: records.length,
			monthReqs: monthRecords.length,
			totalIn: records.reduce((n, r) => n + r.inTok, 0),
			totalOut: records.reduce((n, r) => n + r.outTok, 0),
			hasAnyPrice,
			models: [...UsageStore.byModel(records).entries()]
				.map(([model, v]) => ({ model, ...v, cost: cost(records.filter((r) => r.model === model)) }))
				.sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.reqs - a.reqs),
			days,
		};
	}
}
