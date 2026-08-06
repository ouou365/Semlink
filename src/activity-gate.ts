// ========================================
// Semlink - Activity Gate
// ========================================
// Watches for user activity (clicks, typing, scrolling, dragging) at the
// document level. The index scheduler consults isIdle() before each batch so
// indexing pauses while the user is actively working and resumes once they've
// been idle for a while — keeping the UI smooth during heavy vault scans.

/** How long the user must be inactive before indexing may resume. */
const IDLE_MS = 5000;
/** Coalesce high-frequency scroll events (they fire per frame). */
const SCROLL_THROTTLE_MS = 200;

export class ActivityGate {
	private lastActivity = Date.now();
	private lastScrollAt = 0;
	private cleanup: Array<() => void> = [];

	constructor() {
		// Capture phase + passive so the listeners never block the UI and
		// clicks/keys anywhere in the app (including editor panels) count.
		const mark = () => {
			this.lastActivity = Date.now();
		};
		const markScroll = () => {
			const now = Date.now();
			if (now - this.lastScrollAt < SCROLL_THROTTLE_MS) return;
			this.lastScrollAt = now;
			this.lastActivity = now;
		};
		for (const type of ["pointerdown", "keydown", "wheel", "touchstart", "dragstart"]) {
			document.addEventListener(type, mark, { capture: true, passive: true });
			this.cleanup.push(() => document.removeEventListener(type, mark, { capture: true }));
		}
		// Programmatic / keyboard scrolling (PageDown, arrows, scrollIntoView)
		// doesn't fire wheel — track the scroll event itself too.
		document.addEventListener("scroll", markScroll, { capture: true, passive: true });
		this.cleanup.push(() => document.removeEventListener("scroll", markScroll, { capture: true }));
	}

	/** True when the user has been inactive for at least IDLE_MS. */
	isIdle(): boolean {
		return Date.now() - this.lastActivity >= IDLE_MS;
	}

	/** Stop listening (plugin unload). */
	dispose(): void {
		for (const fn of this.cleanup) fn();
		this.cleanup = [];
	}
}
