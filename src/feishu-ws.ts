// ========================================
// Semlink - Node-style WebSocket for the Lark SDK
// ========================================
// The Lark SDK's WSClient calls `new WebSocket(url, { agent })` and uses the
// Node `ws` API (`.on('message')` with Buffer payloads, `.terminate()`), which
// the native browser WebSocket in Obsidian's renderer does NOT provide — it
// throws on the options-arg and has no `.on()`. We install the `ws` package
// (bundled) as the global WebSocket; it exposes BOTH the Node API and the
// browser API (onopen/onmessage/addEventListener), so other plugins are
// unaffected. Falls back to a small wrapper shim if Node builtins are missing.

/** Fields this module installs on the renderer's global scope. */
interface FeishuWsGlobal {
	__semlinkWsInstalled?: boolean;
	WebSocket?: unknown;
}

/** Minimal shape of the events read off the native browser WebSocket. */
interface NativeWsEvent {
	data?: unknown;
	error?: unknown;
}

/** Browser-style event callback (onopen/onmessage/onerror/onclose). The
 * forwarded payload is the native event object where one exists — the open
 * event carries `{}` — so it stays unknown. */
type BrowserWsHandler = (ev: unknown) => void;

export function installFeishuWebSocket(): void {
	const g = window as unknown as FeishuWsGlobal;
	if (g.__semlinkWsInstalled) return;
	g.__semlinkWsInstalled = true;

	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports -- "ws" is an optional dependency; the lazy require keeps it out of the bundle
		const WS = require("ws") as unknown;
		g.WebSocket = WS;
		return;
	} catch {
		// Node builtins unavailable — fall back to the shim below.
	}

	interface NativeWs {
		binaryType?: string;
		onopen: (() => void) | null;
		onmessage: ((ev: NativeWsEvent) => void) | null;
		onerror: ((ev: NativeWsEvent) => void) | null;
		onclose: ((ev: CloseEvent) => void) | null;
		send(data: string | ArrayBuffer): void;
		close(): void;
		readonly readyState: number;
	}
	const Native = g.WebSocket as (new (url: string, protocols?: string | string[]) => NativeWs) | undefined;
	if (!Native) return;

	class FeishuWsShim {
		private native: NativeWs;
		private listeners: Record<string, Array<(data?: unknown) => void>> = {};
		private browserOnOpen: BrowserWsHandler | null = null;
		private browserOnMessage: BrowserWsHandler | null = null;
		private browserOnError: BrowserWsHandler | null = null;
		private browserOnClose: BrowserWsHandler | null = null;

		static CONNECTING = 0;
		static OPEN = 1;
		static CLOSING = 2;
		static CLOSED = 3;

		constructor(url: string, protocols?: unknown) {
			// The SDK passes `{ agent }` (Node-style options) — map to valid
			// browser protocols and drop the options.
			let p: string | string[] | undefined;
			if (typeof protocols === "string") p = protocols;
			else if (Array.isArray(protocols)) p = protocols as string[];

			this.native = new Native!(url, p);
			this.native.binaryType = "arraybuffer";

			this.native.onopen = () => {
				this.browserOnOpen?.({});
				this.emit("open");
			};
			this.native.onmessage = (ev) => {
				this.browserOnMessage?.(ev);
				this.emit("message", ev.data);
			};
			this.native.onerror = (ev) => {
				this.browserOnError?.(ev);
				this.emit("error", ev?.error || new Error("WebSocket error"));
			};
			this.native.onclose = (ev) => {
				this.browserOnClose?.(ev);
				this.emit("close");
			};
		}

		get readyState(): number {
			return Number(this.native.readyState);
		}

		// Node-style API.
		on(event: string, cb: (data?: unknown) => void): void {
			(this.listeners[event] ||= []).push(cb);
		}
		off(event: string, cb?: (data?: unknown) => void): void {
			const list = this.listeners[event];
			if (!list) return;
			if (!cb) {
				delete this.listeners[event];
				return;
			}
			this.listeners[event] = list.filter((f) => f !== cb);
		}
		terminate(): void {
			this.native.close();
		}

		// Browser-style API.
		addEventListener(event: string, cb: (data?: unknown) => void): void {
			this.on(event, cb);
		}
		removeEventListener(event: string, cb: (data?: unknown) => void): void {
			this.off(event, cb);
		}
		set onopen(v: BrowserWsHandler | null) { this.browserOnOpen = v; }
		get onopen() { return this.browserOnOpen; }
		set onmessage(v: BrowserWsHandler | null) { this.browserOnMessage = v; }
		get onmessage() { return this.browserOnMessage; }
		set onerror(v: BrowserWsHandler | null) { this.browserOnError = v; }
		get onerror() { return this.browserOnError; }
		set onclose(v: BrowserWsHandler | null) { this.browserOnClose = v; }
		get onclose() { return this.browserOnClose; }

		send(data: string | ArrayBuffer | Buffer): void {
			// Node Buffers → pass the underlying ArrayBuffer to the browser WS.
			if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) {
				this.native.send(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
			} else {
				this.native.send(data as string | ArrayBuffer);
			}
		}
		close(): void {
			this.native.close();
		}

		private emit(event: string, data?: unknown): void {
			let payload: unknown = data;
			if (event === "message" && data !== undefined && typeof Buffer !== "undefined") {
				if (data instanceof ArrayBuffer) payload = Buffer.from(data);
				else if (ArrayBuffer.isView(data)) payload = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
			}
			for (const cb of this.listeners[event] || []) {
				try { cb(payload); } catch { /* ignore listener errors */ }
			}
		}
	}

	g.WebSocket = FeishuWsShim;
}
