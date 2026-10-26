// ========================================
// Semlink - Citation registry & source-card selection
// ========================================
// ONE numbering space per chat turn: every note the model can see (initial
// context blocks, search/grep hits, opened notes) gets a stable [n] from the
// registry; the model cites those numbers in thinking AND in the answer; the
// rendered source cards carry the SAME numbers. Pure functions — no Obsidian
// imports — so the contract is unit-testable outside the plugin.

export type CiteEntry = { path: string; n: number; line?: number };

export interface CiteRegistry {
	/** Registered paths in first-appearance order — index n-1 is cited as [n]. */
	paths: string[];
	/** Line anchors parallel to paths (1-based; undefined = never line-anchored).
	 *  Set when a read/grep registers the note — clicking [n] jumps to that line. */
	lines: Array<number | undefined>;
	/** Register a path (optionally with a line anchor); returns its stable
	 *  citation number (1-based). Anchor priority: READ beats GREP-HIT — grep
	 *  only locates ("where might it be", often a TOC/first-mention line),
	 *  a read's start line is where the model actually took the evidence
	 *  from. Among multiple reads of one note the FIRST one wins: it is the
	 *  model's entry point into the note, and segmented table reads walk
	 *  forward from there. */
	register: (path: string, line?: number, kind?: "read" | "hit") => number;
}

export function createCiteRegistry(): CiteRegistry {
	const paths: string[] = [];
	const lines: Array<number | undefined> = [];
	const anchoredByRead: boolean[] = [];
	const register = (path: string, line?: number, kind?: "read" | "hit"): number => {
		let at = paths.indexOf(path);
		if (at < 0) {
			paths.push(path);
			lines.push(undefined);
			anchoredByRead.push(false);
			at = paths.length - 1;
		}
		if (line === undefined) return at + 1;
		if (kind === "read") {
			if (!anchoredByRead[at]) {
				anchoredByRead[at] = true;
				lines[at] = line;
			}
		} else if (lines[at] === undefined) {
			lines[at] = line;
		}
		return at + 1;
	};
	return { paths, lines, register };
}

/**
 * Source cards for the answer's inline [n] citations: the TRUE registry
 * numbers, sorted ascending, gaps allowed — card [4] is exactly the note the
 * model cited as [4]; uncited notes get no card. Opened-but-uncited notes
 * (readNotes) keep their real numbers and stay visible, matching the old
 * "opened notes are shown" behavior.
 */
export function buildCitedCards(answer: string, citeRegistry: string[], readNotes: string[], citeLines?: Array<number | undefined>): CiteEntry[] {
	const entries: CiteEntry[] = [];
	if (citeRegistry.length === 0) return entries;
	const seen = new Set<number>();
	for (const m of answer.matchAll(/\[(\d{1,3})(?::L\d{1,5}(?:[-\u2011]L\d{1,5})?)?\]/g)) {
		const n = Number(m[1]);
		if (seen.has(n)) continue;
		seen.add(n);
		const p = citeRegistry[n - 1];
		if (p) entries.push({ path: p, n, line: citeLines?.[n - 1] });
	}
	for (const p of readNotes) {
		const n = citeRegistry.indexOf(p) + 1;
		if (n > 0 && !entries.some((e) => e.n === n)) entries.push({ path: p, n, line: citeLines?.[n - 1] });
	}
	return entries.sort((a, b) => a.n - b.n);
}
