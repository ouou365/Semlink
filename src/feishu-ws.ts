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

export function installFeishuWebSocket(): void {
	const g = globalThis as any;
	if (g.__semlinkWsInstalled) return;
	g.__semlinkWsInstalled = true;

	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const WS = require("ws");
		g.WebSocket = WS;
		return;
	} catch {
		// Node builtins unavailable — fall back to the shim below.
	}

	const Native = g.WebSocket;
	if (!Native) return;

	class FeishuWsShim {
		private native: any;
		private listeners: Record<string, Array<(data?: any) => void>> = {};
		private browserOnOpen: ((ev: any) => void) | null = null;
		private browserOnMessage: ((ev: any) => void) | null = null;
		private browserOnError: ((ev: any) => void) | null = null;
		private browserOnClose: ((ev: any) => void) | null = null;

		static CONNECTING = 0;
		static OPEN = 1;
		static CLOSING = 2;
		static CLOSED = 3;

		constructor(url: string, protocols?: any) {
			// The SDK passes `{ agent }` (Node-style options) — map to valid
			// browser protocols and drop the options.
			let p: string | string[] | undefined;
			if (typeof protocols === "string") p = protocols;
			else if (Array.isArray(protocols)) p = protocols as string[];

			this.native = new Native(url, p);
			this.native.binaryType = "arraybuffer";

			this.native.onopen = () => {
				this.browserOnOpen?.({});
				this.emit("open");
			};
			this.native.onmessage = (ev: any) => {
				this.browserOnMessage?.(ev);
				this.emit("message", ev.data);
			};
			this.native.onerror = (ev: any) => {
				this.browserOnError?.(ev);
				this.emit("error", ev?.error || new Error("WebSocket error"));
			};
			this.native.onclose = (ev: any) => {
				this.browserOnClose?.(ev);
				this.emit("close");
			};
		}

		get readyState(): number {
			return this.native.readyState;
		}

		// Node-style API.
		on(event: string, cb: (data?: any) => void): void {
			(this.listeners[event] ||= []).push(cb);
		}
		off(event: string, cb?: (data?: any) => void): void {
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
		addEventListener(event: string, cb: any): void {
			this.on(event, cb);
		}
		removeEventListener(event: string, cb: any): void {
			this.off(event, cb);
		}
		set onopen(v: ((ev: any) => void) | null) { this.browserOnOpen = v; }
		get onopen() { return this.browserOnOpen; }
		set onmessage(v: ((ev: any) => void) | null) { this.browserOnMessage = v; }
		get onmessage() { return this.browserOnMessage; }
		set onerror(v: ((ev: any) => void) | null) { this.browserOnError = v; }
		get onerror() { return this.browserOnError; }
		set onclose(v: ((ev: any) => void) | null) { this.browserOnClose = v; }
		get onclose() { return this.browserOnClose; }

		send(data: any): void {
			// Node Buffers → pass the underlying ArrayBuffer to the browser WS.
			if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) {
				this.native.send(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
			} else {
				this.native.send(data);
			}
		}
		close(): void {
			this.native.close();
		}

		private emit(event: string, data?: any): void {
			let payload = data;
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
