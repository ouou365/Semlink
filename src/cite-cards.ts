// ========================================
// Semlink - Citation registry & source-card selection
// ========================================
// ONE numbering space per chat turn: every note the model can see (initial
// context blocks, search/grep hits, opened notes) gets a stable [n] from the
// registry; the model cites those numbers in thinking AND in the answer; the
// rendered source cards carry the SAME numbers. Pure functions — no Obsidian
// imports — so the contract is unit-testable outside the plugin.

export type CiteEntry = { path: string; n: number };

export interface CiteRegistry {
	/** Registered paths in first-appearance order — index n-1 is cited as [n]. */
	paths: string[];
	/** Register a path; returns its stable citation number (1-based). */
	register: (path: string) => number;
}

export function createCiteRegistry(): CiteRegistry {
	const paths: string[] = [];
	const register = (path: string): number => {
		const at = paths.indexOf(path);
		if (at >= 0) return at + 1;
		paths.push(path);
		return paths.length;
	};
	return { paths, register };
}

/**
 * Source cards for the answer's inline [n] citations: the TRUE registry
 * numbers, sorted ascending, gaps allowed — card [4] is exactly the note the
 * model cited as [4]; uncited notes get no card. Opened-but-uncited notes
 * (readNotes) keep their real numbers and stay visible, matching the old
 * "opened notes are shown" behavior.
 */
export function buildCitedCards(answer: string, citeRegistry: string[], readNotes: string[]): CiteEntry[] {
	const entries: CiteEntry[] = [];
	if (citeRegistry.length === 0) return entries;
	const seen = new Set<number>();
	for (const m of answer.matchAll(/\[(\d{1,3})\]/g)) {
		const n = Number(m[1]);
		if (seen.has(n)) continue;
		seen.add(n);
		const p = citeRegistry[n - 1];
		if (p) entries.push({ path: p, n });
	}
	for (const p of readNotes) {
		const n = citeRegistry.indexOf(p) + 1;
		if (n > 0 && !entries.some((e) => e.n === n)) entries.push({ path: p, n });
	}
	return entries.sort((a, b) => a.n - b.n);
}
