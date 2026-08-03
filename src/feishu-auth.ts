// ========================================
// Semlink - Feishu Bot Auth
// ========================================
// Binding a Feishu bot to Semlink. Primary flow: scan-to-create-app via the
// RFC 8628 device flow — the plugin shows a QR, the user scans it in the
// Feishu app, and the flow returns the created app's credentials.
//
// NOTE: we implement this with Obsidian's `requestUrl` (native HTTP) instead
// of the official SDK's `registerApp`, because the SDK's axios instance is
// blocked by CORS inside Obsidian's renderer ("Network Error"). The endpoints
// below mirror the SDK's `/oauth/v1/app/registration` flow exactly.

import { requestUrl } from "obsidian";
import { gzip } from "pako";

// Pre-filled permissions + event subscriptions carried by the QR scan.
// When the user confirms app creation in Feishu, the confirm page pre-applies
// these (same `addons` mechanism as the official SDK), so the created app
// already subscribes to im.message.receive_v1 and holds the required scopes —
// no manual Feishu admin configuration needed (the ZCode-style flow).
const FEISHU_ADDONS = {
	preset: true,
	scopes: {
		tenant: [
			"im:message",
			"im:message:send_as_bot",
			"im:message.p2p_msg:readonly",
			"im:message.group_at_msg:readonly",
			"contact:user.base:readonly",
			"cardkit:card:write",
		],
		user: [],
	},
	events: {
		items: {
			tenant: ["im.message.receive_v1"],
			user: [],
		},
	},
};

/**
 * Encode the addons payload the way the platform's confirm page decodes it:
 * `JSON.stringify → gzip → base64 → URL-safe ('+'→'-', '/'→'_') → strip '='`.
 * gzip is done with pako (pure JS) since Node's zlib is unreliable inside
 * Obsidian's renderer.
 */
function encodeAddons(): string {
	const json = JSON.stringify(FEISHU_ADDONS);
	const bytes = gzip(new TextEncoder().encode(json));
	let bin = "";
	bytes.forEach((b) => {
		bin += String.fromCharCode(b);
	});
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface FeishuScanResult {
	appId: string;
	appSecret: string;
	userOpenId?: string;
	userName?: string;
}

export interface FeishuScanHandle {
	promise: Promise<FeishuScanResult>;
	abort: () => void;
}

// NOTE: this device-registration endpoint lives on the accounts domain, not
// the standard open.feishu.cn API domain (verified against the SDK defaults).
const REG_ENDPOINT = "https://accounts.feishu.cn/oauth/v1/app/registration";

/** POST the registration endpoint (form-urlencoded) and return the JSON body. */
async function registrationRequest(action: string, extra: Record<string, string>): Promise<any> {
	const params = new URLSearchParams({ action, ...extra });
	const resp = await requestUrl({
		url: REG_ENDPOINT,
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params.toString(),
		throw: false,
	});
	let data: any = {};
	try {
		data = typeof resp.json === "object" && resp.json ? resp.json : JSON.parse(resp.text);
	} catch {
		// not JSON
	}
	return data;
}

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/**
 * Build an HTTP instance backed by Obsidian's `requestUrl` (native HTTP,
 * bypasses the renderer's CORS). The Lark SDK accepts this as `httpInstance`
 * on `Client` / `WSClient`. It must return the RESPONSE BODY directly — the
 * SDK consumes it that way (verified against the token API; standard API
 * responses carry their own `{ code, msg, data }` wrapper).
 */
export function makeFeishuHttp(): any {
	const call = async (opts: any) => {
		const url = opts.url;
		const method = (opts.method || "GET").toUpperCase();
		const headers: Record<string, string> = { ...(opts.headers || {}) };
		let body: string | undefined;
		if (opts.data !== undefined && opts.data !== null) {
			body = typeof opts.data === "string" ? opts.data : JSON.stringify(opts.data);
			if (typeof opts.data !== "string" && !headers["Content-Type"]) {
				headers["Content-Type"] = "application/json";
			}
		}
		let finalUrl = url;
		if (opts.params) {
			const qs = new URLSearchParams(opts.params as any).toString();
			finalUrl += (finalUrl.includes("?") ? "&" : "?") + qs;
		}

		const resp = await requestUrl({
			url: finalUrl,
			method,
			headers,
			body,
			throw: false,
		});

		let data: any = null;
		try {
			data = typeof resp.json === "object" && resp.json ? resp.json : JSON.parse(resp.text);
		} catch {
			data = resp.text || null;
		}

		// Mirror axios's default behavior: throw on 4xx/5xx so the SDK's
		// error handling sees an axios-like error.
		if (resp.status >= 400) {
			const err: any = new Error(`Request failed with status code ${resp.status}`);
			err.response = { status: resp.status, data, headers: {}, config: {}, request: {} };
			err.isAxiosError = true;
			throw err;
		}

		return data;
	};

	return {
		request: call,
		get: (url: string, o?: any) => call({ ...o, url, method: "GET" }),
		delete: (url: string, o?: any) => call({ ...o, url, method: "DELETE" }),
		head: (url: string, o?: any) => call({ ...o, url, method: "HEAD" }),
		options: (url: string, o?: any) => call({ ...o, url, method: "OPTIONS" }),
		post: (url: string, d?: any, o?: any) => call({ ...o, url, method: "POST", data: d }),
		put: (url: string, d?: any, o?: any) => call({ ...o, url, method: "PUT", data: d }),
		patch: (url: string, d?: any, o?: any) => call({ ...o, url, method: "PATCH", data: d }),
	};
}

/**
 * Start the scan-to-create-app flow.
 * - `onQRCode(url, expireIn)` is called once with the QR payload to render.
 * - `onStatus(status)` reports polling progress (polling / slow_down / ...).
 * Resolves with the created app's credentials after the user confirms in Feishu.
 */
export function startFeishuRegister(
	name: string,
	onQRCode: (url: string, expireIn: number) => void,
	onStatus?: (status: string) => void,
): FeishuScanHandle {
	const controller = new AbortController();

	const promise = (async () => {
		// 1. Begin: get the device code + QR verification URL.
		const begin = await registrationRequest("begin", {
			archetype: "PersonalAgent",
			auth_method: "client_secret",
			request_user_info: "open_id",
		});
		if (!begin?.verification_uri_complete || !begin?.device_code) {
			throw new Error(begin?.error || "begin failed");
		}

		// 2. Build the QR URL (mirrors the SDK: from/tp/source + app preset).
		const qr = new URL(begin.verification_uri_complete);
		qr.searchParams.set("from", "sdk");
		qr.searchParams.set("tp", "sdk");
		if (name) qr.searchParams.set("name", name);
		// Pre-fill permissions + event subscription so the confirmed app works
		// out of the box (no manual Feishu admin configuration).
		qr.searchParams.set("addons", encodeAddons());
		onQRCode(qr.toString(), begin.expires_in ?? 600);

		// 3. Poll until the user scans & confirms (or times out / aborts).
		const interval = (begin.interval ?? 5) * 1000;
		const expireIn = (begin.expires_in ?? 600) * 1000;
		const start = Date.now();

		while (Date.now() - start < expireIn) {
			if (controller.signal.aborted) throw new Error("abort");
			await sleep(interval);
			if (controller.signal.aborted) throw new Error("abort");

			const res = await registrationRequest("poll", { device_code: begin.device_code });
			if (res?.client_id && res?.client_secret) {
				return {
					appId: res.client_id,
					appSecret: res.client_secret,
					userOpenId: res.user_info?.open_id,
					userName: res.user_info?.name,
				};
			}
			if (res?.error === "access_denied") throw new Error("access_denied");
			onStatus?.(res?.error || "polling");
		}
		throw new Error("expired_token");
	})();

	return { promise, abort: () => controller.abort() };
}

/**
 * Validate an appId/appSecret pair by requesting a tenant_access_token.
 * The bot needs this credential to start its long connection.
 */
export async function verifyFeishuApp(appId: string, appSecret: string): Promise<boolean> {
	try {
		const resp = await requestUrl({
			url: "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
			throw: false,
		});
		const data: any = typeof resp.json === "object" ? resp.json : {};
		return !!data?.tenant_access_token;
	} catch {
		return false;
	}
}
