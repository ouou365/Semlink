// ========================================
// Semlink - Question Bank Store
// ========================================
// Persists the welcome screen's AI-generated question pool to a standalone
// JSON file under the plugin's data directory. Each home-screen render draws
// 3 questions (FIFO); when the bank drops below a low-water mark, a
// background refill is triggered so the pool is never visibly empty.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

/** Refill the bank once it holds fewer than this many questions (2 batches),
 *  so the next home-screen visit never has to wait for the LLM. */
const LOW_WATER_MARK = 6;

export class QuestionBankStore {
	private filePath: string;
	private questions: string[] = [];
	private loaded = false;
	private refillInFlight = false;
	/** Background refill hook — the owner (search view) points this at the
	 *  LLM generation; must resolve once the bank has been topped up (or
	 *  given up), success or failure. */
	onRefillNeeded: (() => Promise<void>) | null = null;

	constructor(dataDir: string) {
		this.filePath = join(dataDir, "question-bank.json");
	}

	/** Load the bank from disk (once; subsequent calls return the cache). */
	load(): void {
		if (this.loaded) return;
		try {
			if (existsSync(this.filePath)) {
				const raw = readFileSync(this.filePath, "utf-8");
				const parsed = JSON.parse(raw);
				if (Array.isArray(parsed?.questions)) {
					this.questions = parsed.questions.filter(
						(q: any) => typeof q === "string" && q.trim() !== "",
					);
				}
			}
		} catch {
			this.questions = [];
		}
		this.loaded = true;
	}

	/** Persist the bank to disk (best-effort). */
	save(): void {
		try {
			const dir = join(this.filePath, "..");
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			writeFileSync(this.filePath, JSON.stringify({ questions: this.questions }, null, 2), "utf-8");
		} catch (e) {
			console.error("[Semlink] Failed to save question bank:", e);
		}
	}

	/** Pop up to `n` questions (FIFO). When the bank drops below the
	 *  low-water mark this also kicks off a background refill. */
	take(n: number): { questions: string[]; needRefill: boolean } {
		this.load();
		const taken = this.questions.splice(0, n);
		this.save();
		void this.refillIfLow();
		return { questions: taken, needRefill: taken.length < n };
	}

	/** Append a freshly generated batch to the bank. */
	refill(questions: string[]): void {
		this.load();
		const fresh = questions.filter((q) => typeof q === "string" && q.trim() !== "");
		if (fresh.length === 0) return;
		this.questions.push(...fresh);
		this.save();
	}

	/** Number of questions currently in the bank. */
	count(): number {
		this.load();
		return this.questions.length;
	}

	/** Fire the refill hook once the bank is below the low-water mark (and
	 *  no refill is already running). Always resets the in-flight flag,
	 *  success or failure, so the next take() can retry. */
	private async refillIfLow(): Promise<void> {
		if (this.refillInFlight) return;
		if (this.questions.length >= LOW_WATER_MARK) return;
		this.refillInFlight = true;
		try {
			await this.onRefillNeeded?.();
		} catch {
			// Refill failure is silent by design — the welcome screen has a
			// static fallback and the next take() will simply retry.
		}
		this.refillInFlight = false;
	}
}
