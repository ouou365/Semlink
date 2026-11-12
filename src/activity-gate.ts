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
		// 插件自身 UI（盯进度弹窗/开设置/滚侧栏/聊天输入）不算「用户忙」：
		// 让路是为了不与用户的笔记工作抢资源，而「看着进度等索引」是正当
		// 场景——把插件 UI 算活跃会让索引无限让路，剩 1 个文件也永远
		// 99.9%（2026-11-12 用户拍板「操作插件不要触发等待」）。笔记编辑
		// 器、Obsidian 本体、其它插件的界面照常计时。
		const isPluginUi = (e: Event): boolean =>
			e.target instanceof Element &&
			e.target.closest('[class*="semlink-"], .smart-vault-progress-modal, .smart-vault-status-bar') !== null;
		const mark = (e: Event) => {
			if (isPluginUi(e)) return;
			this.lastActivity = Date.now();
		};
		const markScroll = (e: Event) => {
			if (isPluginUi(e)) return;
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

	/** 距离「空闲」还差多少 ms（IDLE_MS − 已静默时长），等待倒计时显示用。 */
	remainingMs(): number {
		return Math.max(0, IDLE_MS - (Date.now() - this.lastActivity));
	}

	/** Stop listening (plugin unload). */
	dispose(): void {
		for (const fn of this.cleanup) fn();
		this.cleanup = [];
	}
}
