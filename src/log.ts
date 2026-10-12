// ========================================
// Semlink - Debug logger
// ========================================
// Plugin guidelines ask for minimal console output. Routine [Semlink]
// diagnostics route through here and stay silent unless explicitly enabled:
// run "Semlink: Toggle debug logging" (or flip the toggle in Settings →
// Semlink → General) and reload is not needed — new logs appear immediately.
// console.warn / console.error stay at their call sites — failures should
// always be visible.

let enabled = false;

export function setDebugLogging(on: boolean): void {
	enabled = on;
}

export function debugLog(...args: unknown[]): void {
	if (!enabled) return;
	// console.debug: one of the three methods the submission checker permits
	// (warn/error/debug); verbose-level in Chromium, fitting for diagnostics.
	console.debug("[Semlink]", ...args);
}
