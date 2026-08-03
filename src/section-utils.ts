// ========================================
// Semlink - Section Extraction Helpers
// ========================================
// Shared markdown section utilities used by both the MCP server and the chat
// tool registry (get_section).

const HEADING_RE = /^(#{1,6})\s+(.+)$/;

/**
 * Extract the content under `heading` (from that heading up to the next
 * same-or-higher level heading). If `maxDepth` is given, deeper sub-headings
 * (and their content) are skipped. Returns null when the heading is missing.
 */
export function extractSection(content: string, heading: string, maxDepth?: number): string | null {
	const lines = content.split("\n");
	let targetLevel = -1;
	let startIdx = -1;

	// Find the target heading
	for (let i = 0; i < lines.length; i++) {
		const match = lines[i].match(HEADING_RE);
		if (match && match[2].trim() === heading.trim()) {
			targetLevel = match[1].length;
			startIdx = i;
			break;
		}
	}

	if (startIdx === -1) return null;

	// Collect lines until the next heading of same or higher level
	const collected: string[] = [];
	for (let i = startIdx; i < lines.length; i++) {
		const match = lines[i].match(HEADING_RE);
		if (i > startIdx && match) {
			const level = match[1].length;
			// Stop at same or higher level heading
			if (level <= targetLevel) break;
		}
		// If maxDepth specified, skip headings and their content that are too deep
		if (maxDepth !== undefined && match && match[1].length > maxDepth) {
			continue;
		}
		collected.push(lines[i]);
	}

	return collected.join("\n");
}

/** List all headings in a document, e.g. ["# A", "## B"]. */
export function extractHeadings(content: string): string[] {
	const headings: string[] = [];
	for (const line of content.split("\n")) {
		const match = line.match(HEADING_RE);
		if (match) {
			headings.push("#".repeat(match[1].length) + " " + match[2].trim());
		}
	}
	return headings;
}
