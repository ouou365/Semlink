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

/** Dashboard time scope: last 7 days / last 30 days / current month /
 *  everything on record. */
export type UsageRange = "7d" | "30d" | "month" | "all";

export interface UsageFilter {
	range: UsageRange;
	/** null = all models. */
	model: string | null;
}

/** Per-day (or per-week, for long spans) totals. */
export interface UsageDayTotals {
	reqs: number;
	in: number;
	out: number;
}

export interface UsageDayBucket {
	/** Bucket start timestamp (local midnight / week boundary). */
	ts: number;
	label: string;
	total: UsageDayTotals;
	perModel: Map<string, UsageDayTotals>;
}

export interface UsageModelSeries {
	model: string;
	reqs: number;
	inTok: number;
	outTok: number;
	/** Aligned 1:1 with summary().days. */
	days: UsageDayTotals[];
}

export interface UsageSummary {
	reqs: number;
	inTok: number;
	outTok: number;
	/** Oldest → newest, covering the whole filtered span (sparse days have
	 *  zero totals). */
	days: UsageDayBucket[];
	/** Filtered models, biggest token consumers first. */
	models: UsageModelSeries[];
	/** Every model seen in the time range (ignores the model filter) —
	 *  feeds the model filter menu. */
	allModels: string[];
}

/** Hard cap on stored records (drop oldest). ~5k requests is years of
 *  personal use; the file stays well under a megabyte. */
const MAX_RECORDS = 5000;

/** Beyond ~2 months of span, daily buckets get too dense to read — merge
 *  into 7-day chunks (first chunk carries the remainder). */
const DAILY_BUCKET_LIMIT = 62;

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

	static dayKey(ts: number): string {
		const d = new Date(ts);
		return `${d.getMonth() + 1}/${d.getDate()}`;
	}

	/** Local-midnight timestamp of `ts`'s day. */
	private static startOfDay(ts: number): number {
		const d = new Date(ts);
		return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	}

	/** Lower bound of a filter's time range (local-midnight aligned). */
	private static rangeStart(range: UsageRange, records: UsageRecord[]): number {
		const now = new Date();
		const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
		switch (range) {
			case "7d":
				return startOfToday - 6 * 24 * 3600 * 1000;
			case "30d":
				return startOfToday - 29 * 24 * 3600 * 1000;
			case "month":
				return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
			case "all":
				return records.length ? UsageStore.startOfDay(Math.min(...records.map((r) => r.ts))) : startOfToday;
		}
	}

	/** Raw records behind a dashboard view — the CSV export source. */
	async recordsFor(filter: UsageFilter): Promise<UsageRecord[]> {
		const records = await this.load();
		const from = UsageStore.rangeStart(filter.range, records);
		return records.filter((r) => r.ts >= from && (filter.model ? r.model === filter.model : true));
	}

	/** Day buckets covering [from, today]: local-midnight aligned, keyed by
	 *  local date string so DST shifts can't misplace a record. */
	private static buildBuckets(from: number): Array<UsageDayBucket & { key: string }> {
		const buckets: Array<UsageDayBucket & { key: string }> = [];
		const cursor = new Date(from);
		const today = new Date();
		while (cursor <= today) {
			const key = `${cursor.getFullYear()}-${cursor.getMonth()}-${cursor.getDate()}`;
			buckets.push({
				ts: cursor.getTime(),
				label: UsageStore.dayKey(cursor.getTime()),
				total: { reqs: 0, in: 0, out: 0 },
				perModel: new Map(),
				key,
			});
			cursor.setDate(cursor.getDate() + 1);
		}
		return buckets;
	}

	/** Long spans: merge daily buckets into consecutive 7-day chunks (the
	 *  first chunk carries the remainder, so the newest chunk always ends
	 *  today). Merged label = chunk start day. */
	private static mergeWeekly(daily: Array<UsageDayBucket & { key: string }>): UsageDayBucket[] {
		const groups: UsageDayBucket[] = [];
		for (let i = 0; i < daily.length;) {
			const size = groups.length === 0 && daily.length % 7 !== 0 ? daily.length % 7 : 7;
			const head = daily[i];
			const merged: UsageDayBucket = { ts: head.ts, label: head.label, total: head.total, perModel: head.perModel };
			for (let j = 1; j < size; j++) {
				const b = daily[i + j];
				merged.total.reqs += b.total.reqs;
				merged.total.in += b.total.in;
				merged.total.out += b.total.out;
				for (const [model, v] of b.perModel) {
					const cur = merged.perModel.get(model) ?? { reqs: 0, in: 0, out: 0 };
					cur.reqs += v.reqs; cur.in += v.in; cur.out += v.out;
					merged.perModel.set(model, cur);
				}
			}
			groups.push(merged);
			i += size;
		}
		return groups;
	}

	/** Everything the dashboard renders, scoped by range + model. */
	async summary(filter: UsageFilter): Promise<UsageSummary> {
		const records = await this.load();
		const from = UsageStore.rangeStart(filter.range, records);
		const inRange = records.filter((r) => r.ts >= from);
		const scoped = filter.model ? inRange.filter((r) => r.model === filter.model) : inRange;

		const daily = UsageStore.buildBuckets(from);
		const byKey = new Map(daily.map((b) => [b.key, b]));
		for (const r of scoped) {
			const d = new Date(r.ts);
			const b = byKey.get(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
			if (!b) continue;
			b.total.reqs++; b.total.in += r.inTok; b.total.out += r.outTok;
			const pm = b.perModel.get(r.model) ?? { reqs: 0, in: 0, out: 0 };
			pm.reqs++; pm.in += r.inTok; pm.out += r.outTok;
			b.perModel.set(r.model, pm);
		}
		const buckets: UsageDayBucket[] = daily.length > DAILY_BUCKET_LIMIT ? UsageStore.mergeWeekly(daily) : daily;

		const models: UsageModelSeries[] = [...new Set(scoped.map((r) => r.model))].map((model) => {
			const rs = scoped.filter((r) => r.model === model);
			const days = buckets.map((b) => b.perModel.get(model) ?? { reqs: 0, in: 0, out: 0 });
			return {
				model,
				reqs: rs.length,
				inTok: rs.reduce((n, r) => n + r.inTok, 0),
				outTok: rs.reduce((n, r) => n + r.outTok, 0),
				days,
			};
		}).sort((a, b) => (b.inTok + b.outTok) - (a.inTok + a.outTok) || b.reqs - a.reqs);

		return {
			reqs: scoped.length,
			inTok: scoped.reduce((n, r) => n + r.inTok, 0),
			outTok: scoped.reduce((n, r) => n + r.outTok, 0),
			days: buckets,
			models,
			allModels: [...new Set(inRange.map((r) => r.model))]
				.sort((a, b) => {
					const ta = inRange.filter((r) => r.model === a).reduce((n, r) => n + r.inTok + r.outTok, 0);
					const tb = inRange.filter((r) => r.model === b).reduce((n, r) => n + r.inTok + r.outTok, 0);
					return tb - ta;
				}),
		};
	}
}
