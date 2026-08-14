// ========================================
// Semlink - Markdown Chunker
// ========================================

export interface ChunkResult {
	id: string;
	heading: string;
	content: string;
	position: number;
}

const HEADING_RE = /^(#{1,6})\s+(.+)$/;

/**
 * Split a markdown document into chunks.
 * Strategy: split by headings first; if a section exceeds chunkSize,
 * split further by fixed-size with overlap.
 *
 * Sections are closed only by a heading of the SAME OR HIGHER level, so a
 * parent heading keeps its sub-sections (e.g. "# MIBT" keeps "## 长按触发").
 * Splitting on every heading level would otherwise orphan a parent heading
 * that is immediately followed by a sub-heading into a heading-only chunk
 * whose only content is "# MIBT" — polluting search results and starving the
 * chat model of real content.
 */
export function chunkMarkdown(
	text: string,
	notePath: string,
	chunkSize: number,
	chunkOverlap: number,
): ChunkResult[] {
	const lines = text.split("\n");

	// Group lines by heading sections
	const sections: { heading: string; level: number; lines: string[] }[] = [];
	let currentHeading = "";
	let currentLevel = 0;
	let currentLines: string[] = [];

	for (const line of lines) {
		const match = line.match(HEADING_RE);
		if (match) {
			const level = match[1].length;
			// A same-or-higher level heading closes the current section.
			if (currentLevel > 0 && level <= currentLevel) {
				sections.push({ heading: currentHeading, level: currentLevel, lines: [...currentLines] });
				currentLines = [];
				currentHeading = match[2].trim();
				currentLevel = level;
			} else if (currentLevel === 0) {
				// First heading in the doc (possibly after a preamble) opens
				// the first section.
				if (currentLines.length > 0) {
					sections.push({ heading: "", level: 0, lines: [...currentLines] });
					currentLines = [];
				}
				currentHeading = match[2].trim();
				currentLevel = level;
			}
			// Deeper sub-headings stay inside the current section — only the
			// line is appended; heading/level are unchanged.
			currentLines.push(line);
		} else {
			currentLines.push(line);
		}
	}
	// Flush last section
	if (currentLines.length > 0) {
		sections.push({ heading: currentHeading, level: currentLevel, lines: [...currentLines] });
	}

	// If no sections found (no headings), treat entire doc as one section
	if (sections.length === 0) {
		sections.push({ heading: "", level: 0, lines: lines });
	}

	// Now chunk each section
	const chunks: ChunkResult[] = [];
	let position = 0;

	for (const section of sections) {
		const sectionText = section.lines.join("\n").trim();
		if (!sectionText) continue;

		// If section fits in one chunk, keep it as-is
		if (sectionText.length <= chunkSize) {
			chunks.push({
				id: makeChunkId(notePath, position),
				heading: section.heading,
				content: sectionText,
				position,
			});
			position++;
			continue;
		}

		// Split large sections by fixed-size with overlap
		const fixedChunks = splitFixedSize(sectionText, chunkSize, chunkOverlap);
		for (let i = 0; i < fixedChunks.length; i++) {
			const suffix = fixedChunks.length > 1 ? ` [${i + 1}/${fixedChunks.length}]` : "";
			chunks.push({
				id: makeChunkId(notePath, position),
				heading: section.heading + suffix,
				content: fixedChunks[i],
				position,
			});
			position++;
		}
	}

	return chunks;
}

/**
 * Split text into fixed-size chunks with overlap.
 * Tries to break at sentence/paragraph boundaries when possible.
 */
function splitFixedSize(text: string, size: number, overlap: number): string[] {
	const chunks: string[] = [];
	let start = 0;

	while (start < text.length) {
		let end = Math.min(start + size, text.length);

		// Try to break at a newline or period near the end
		if (end < text.length) {
			const lastNewline = text.lastIndexOf("\n", end);
			const lastPeriod = text.lastIndexOf("。", end);
			const lastEnPeriod = text.lastIndexOf(". ", end - 1);
			const breakPoint = Math.max(lastNewline, lastPeriod, lastEnPeriod);

			if (breakPoint > start + size * 0.5) {
				end = breakPoint + 1;
			}
		}

		const chunk = text.slice(start, end).trim();
		if (chunk) {
			chunks.push(chunk);
		}

		start = end - overlap;
		if (start < end) {
			start = end; // Prevent infinite loop
		}
		if (start >= text.length) break;
	}

	return chunks;
}

function makeChunkId(notePath: string, position: number): string {
	// Simple hash from path + position
	const raw = `${notePath}::${position}`;
	let hash = 0;
	for (let i = 0; i < raw.length; i++) {
		const ch = raw.charCodeAt(i);
		hash = ((hash << 5) - hash + ch) | 0;
	}
	return `c_${Math.abs(hash).toString(36)}_${position}`;
}

/** Extract a short preview from content */
export function makePreview(content: string, maxLen = 200): string {
	const clean = content.replace(/\n+/g, " ").trim();
	if (clean.length <= maxLen) return clean;
	return clean.slice(0, maxLen) + "...";
}

/** Whether a chunk is too sparse to embed meaningfully. Chunks that are only
 *  markdown table separators (| | |), dashes (---), or whitespace collapse to
 *  the SAME embedding vector and produce false-positive ~1.0 similarity
 *  between totally unrelated documents. We strip structural / punctuation
 *  chars and require a minimum of "effective" characters (CJK + alphanumerics). */
export function isSparseContent(content: string, minChars = 20): boolean {
	const effective = content.replace(/[\s|\-=:_*#>`~\[\](){}<>"'.,;:!?/\\]+/g, "").length;
	return effective < minChars;
}
