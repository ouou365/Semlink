// ========================================
// Semlink - Debug logger
// ========================================
// Plugin guidelines ask for minimal console output. Routine [Semlink]
// diagnostics route through here and stay silent unless explicitly enabled:
// set localStorage "semlink-debug" to "1" and reload Obsidian.
// console.warn / console.error stay at their call sites — failures should
// always be visible.

let enabled = false;
try { enabled = window.localStorage.getItem("semlink-debug") === "1"; } catch { /* storage unavailable */ }

export function debugLog(...args: unknown[]): void {
	if (!enabled) return;
	// console.debug: one of the three methods the submission checker permits
	// (warn/error/debug); verbose-level in Chromium, fitting for diagnostics.
	console.debug("[Semlink]", ...args);
}
