// ========================================
// Semlink - License Manager
// ========================================
// Client side of the freemium licensing system (docs/license-backend-design.md).
// The cloud function is the only party talking to Creem; this module
// activates/validates through it and verifies the Ed25519-signed activation
// token fully offline between validations.
//
// Token wire format: base64url(JSON payload) + "." + base64url(signature).
// Payload: { kh: keyHash, fp: deviceFingerprint, plan: "pro", iat, exp }.

import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "crypto";
import type * as Crypto from "crypto";
import { hostname, platform, userInfo } from "os";
import { requestUrl } from "obsidian";
import type SmartVaultPlugin from "../main";
import { LICENSE_API_BASES, LICENSE_PUBLIC_KEY_B64, REVALIDATE_INTERVAL_MS, TOKEN_TTL_MS, FREE_HISTORY_LIMIT } from "./license-config";
import type { LicenseState } from "./types";
import { t } from "./i18n";

/** Stable per-machine id (no hardware ids — hostname/platform/user plus the
 *  vault's Obsidian app id is enough to distinguish devices in practice). */
export function deviceFingerprint(extra: string): string {
	const parts = [
		extra,
		hostname(),
		platform(),
		userInfo().username,
	];
	return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);
}

/** Fields read off the decoded activation-token payload. */
interface TokenPayload {
	plan?: unknown;
	exp?: number;
	fp?: unknown;
}

/** Verify a token string against the embedded public key. Pure + synchronous.
 *  `now` is ms epoch; the payload's exp/iat are SECONDS (compact wire form). */
export function verifyToken(token: string, fp: string, nowMs = Date.now()): boolean {
	const dot = token.indexOf(".");
	if (dot <= 0) return false;
	// The signature covers the DECODED payload bytes — decode once and use
	// that buffer for both the JSON parse and the signature check.
	const payloadBytes = Buffer.from(token.slice(0, dot), "base64url");
	let payload: TokenPayload | null;
	try {
		payload = JSON.parse(payloadBytes.toString("utf-8")) as TokenPayload | null;
	} catch {
		return false;
	}
	if (!payload || payload.plan !== "pro") return false;
	if (typeof payload.exp !== "number" || Math.floor(nowMs / 1000) >= payload.exp) return false;
	if (payload.fp !== fp) return false;
	const sig = Buffer.from(token.slice(dot + 1), "base64url");
	if (sig.length !== 64) return false;
	let key: Crypto.KeyObject;
	try {
		key = createPublicKey({ key: Buffer.from(LICENSE_PUBLIC_KEY_B64, "base64"), format: "der", type: "spki" });
	} catch {
		return false;
	}
	return cryptoVerify(null, payloadBytes, key, sig);
}

/** Human-readable reason a license operation failed, mapped from the
 *  backend/Creem status codes the UI actually needs to distinguish. */
export type LicenseErrorCode = "invalid" | "limit" | "revoked" | "network" | "notConfigured";

/** Thrown by license calls. Carries a stable code (the former string
 *  union, now an Error object per lint/type-safety rules). */
export class LicenseError extends Error {
	constructor(public code: LicenseErrorCode) {
		super(code);
	}
}

/** JSON envelope returned by the license endpoints — each endpoint returns
 *  a different subset, so every field is optional. Cast once off the wire
 *  JSON in call(). */
interface LicenseResponse {
	key?: string;
	instanceId?: string;
	token?: string;
	exp?: number;
	activation?: number;
	activationLimit?: number;
	url?: string;
}

/** Subset of the requestUrl response the license client reads. */
interface LicenseHttpResult {
	status: number;
	json: unknown;
}

export class LicenseManager {
	private plugin: SmartVaultPlugin;

	constructor(plugin: SmartVaultPlugin) {
		this.plugin = plugin;
	}

	private get state(): LicenseState {
		if (!this.plugin.settings.license) this.plugin.settings.license = {};
		return this.plugin.settings.license;
	}

	private get fp(): string {
		if (!this._fp) {
			let appId = "";
			try { appId = String((this.plugin.app as { appId?: string }).appId ?? ""); } catch { /* ok */ }
			this._fp = deviceFingerprint(appId);
		}
		return this._fp;
	}
	private _fp = "";

	/** Whether the backend is reachable at all (deployment gated). */
	get configured(): boolean {
		return LICENSE_API_BASES.length > 0;
	}

	/** Pro entitlement. Synchronous + offline: token signature + expiry +
	 *  fingerprint check only. Kick a background re-validation when the token
	 *  approaches expiry so the user never notices the refresh. */
	isPro(): boolean {
		const s = this.state;
		if (!s.key || !s.token) return false;
		if (!verifyToken(s.token, this.fp)) return false;
		// Token valid but stale → refresh in the background (fire and forget;
		// failures fall through to the offline grace of the current token).
		if (Date.now() - (s.lastValidatedAt ?? 0) > REVALIDATE_INTERVAL_MS) {
			void this.validate().catch(() => { /* grace covers us */ });
		}
		return true;
	}

	/** Free-tier view of the chat sessions: indices [0, limit) stay active. */
	freeHistoryLimit(): number | null {
		// Server-pushed value (state.freeLimit) wins when present; the
		// shipped config constant is the offline default.
		return this.isPro() ? null : this.state.freeLimit ?? FREE_HISTORY_LIMIT;
	}

	/** Activate a license key on this device. Throws LicenseError codes. */
	async activate(key: string): Promise<void> {
		if (!this.configured) throw new LicenseError("notConfigured");
		const res = await this.call("POST", "/activate", { key: key.trim(), fp: this.fp, deviceName: this.deviceName() });
		this.applyValidation(res);
		await this.plugin.saveSettings();
	}

	/** Refresh the activation token (also used for the daily background
	 *  re-validation). A revoked/expired key clears local state. */
	async validate(): Promise<void> {
		const s = this.state;
		if (!this.configured || !s.key || !s.instanceId) return;
		try {
			const res = await this.call("POST", "/validate", { key: s.key, instanceId: s.instanceId, fp: this.fp });
			this.applyValidation(res);
			await this.plugin.saveSettings();
		} catch (e) {
			if (e === "revoked") {
				// Key refunded/disabled server-side → drop the local credential.
				this.plugin.settings.license = {};
				await this.plugin.saveSettings();
				return;
			}
			throw e;
		}
	}

	/** Release this device's activation slot (self-service device swap). */
	async deactivate(): Promise<void> {
		const s = this.state;
		if (!this.configured || !s.key || !s.instanceId) return;
		await this.call("POST", "/deactivate", { key: s.key, instanceId: s.instanceId, fp: this.fp });
		this.plugin.settings.license = {};
		await this.plugin.saveSettings();
	}

	/** One-line status for settings/modal display, e.g. "已激活 · 2/3 设备". */
	statusLine(): string {
		const s = this.state;
		if (!this.isPro()) return t("licenseStatusFree");
		const used = s.activation ?? 0;
		const limit = s.activationLimit;
		return t("licenseStatusPro") + (limit ? ` · ${used}/${limit}` : "");
	}

	// ── internals ──

	private deviceName(): string {
		try { return `${hostname()} · Obsidian`; } catch { return "Obsidian device"; }
	}

	private applyValidation(res: LicenseResponse): void {
		const s = this.state;
		s.key = res.key ?? s.key;
		s.instanceId = res.instanceId ?? s.instanceId;
		s.token = res.token;
		s.tokenExp = res.exp;
		s.activation = res.activation;
		s.activationLimit = res.activationLimit;
		s.lastValidatedAt = Date.now();
	}

	/** Ask the license backend for a checkout URL (the server picks the
	 *  payment provider) for the browser to open. Throws "network" when no
	 *  endpoint can create a session — callers surface a retry notice. */
	async openCheckout(): Promise<string> {
		const res = await this.call("POST", "/checkout", {});
		if (!res?.url) throw new LicenseError("network");
		return String(res.url);
	}

	/** requestUrl-based JSON call against the license endpoints. Endpoints
	 *  are tried in order, each up to ATTEMPTS_PER_ENDPOINT times; ONLY
	 *  network errors and timeouts retry/fail over (a semantic 4xx comes
	 *  from whichever endpoint answered and is final). requestUrl has no
	 *  timeout of its own — a cold mainland→Cloudflare connection can hang
	 *  for minutes, so each attempt is raced against REQUEST_TIMEOUT_MS.
	 *  Maps HTTP status codes onto the LicenseError vocabulary. */
	private static readonly REQUEST_TIMEOUT_MS = 12_000;
	private static readonly ATTEMPTS_PER_ENDPOINT = 2;
	private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<LicenseResponse> {
		for (let attempt = 0; attempt < LicenseManager.ATTEMPTS_PER_ENDPOINT; attempt++) {
			for (const base of LICENSE_API_BASES) {
				let res: LicenseHttpResult;
				try {
					res = await Promise.race([
						requestUrl({
							method,
							url: base + path,
							headers: { "Content-Type": "application/json" },
							body: body === undefined ? undefined : JSON.stringify(body),
							throw: false,
						}),
						new Promise((_, reject) =>
							window.setTimeout(() => reject(new Error("license request timeout")), LicenseManager.REQUEST_TIMEOUT_MS)),
					]) as LicenseHttpResult;
				} catch {
					continue;
				}
				if (res.status >= 200 && res.status < 300) {
					try { return res.json as LicenseResponse; } catch { continue; }
				}
				// Map the meaningful failures: 403 = activation limit, 410 = revoked.
				if (res.status === 403) throw new LicenseError("limit");
				if (res.status === 410) throw new LicenseError("revoked");
				if (res.status === 401 || res.status === 404) throw new LicenseError("invalid");
				throw new LicenseError("network");
			}
		}
		throw new LicenseError("network");
	}
}

/** Shared error → user message mapping (used by modal + settings UI). */
export function licenseErrorMessage(e: unknown): string {
	const code = e instanceof LicenseError ? e.code : null;
	switch (code) {
		case "notConfigured": return t("licenseNotConfigured");
		case "invalid": return t("licenseInvalidKey");
		case "limit": return t("licenseDeviceLimit");
		case "revoked": return t("licenseRevoked");
		case "network": return t("licenseNetworkError");
		default: return e instanceof Error ? e.message : String(e);
	}
}

/** Sign a token the way the backend does — DEV/TEST ONLY (used by the
 *  roundtrip test script; never imported by plugin runtime paths). */
export function __devSignToken(payload: Record<string, unknown>, privateKeyB64: string): string {
	const data = Buffer.from(JSON.stringify(payload), "utf-8");
	const key = createPrivateKey({ key: Buffer.from(privateKeyB64, "base64"), format: "der", type: "pkcs8" });
	const sig = cryptoSign(null, data, key);
	return `${data.toString("base64url")}.${Buffer.from(sig).toString("base64url")}`;
}

// Keep TOKEN_TTL referenced so the config constant documents the backend
// contract even though only the server enforces issuance expiry.
export const TOKEN_TTL_DOCUMENTATION = TOKEN_TTL_MS;
