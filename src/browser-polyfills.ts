// ========================================
// Semlink - Node API shims for the browser worker bundle
// ========================================
// Aliased for "path" and "buffer" imports in the browser build, and provides
// a global Buffer for engines that reference the global directly.

const b64ToBytes = (b64: string): Uint8Array => {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
};

const make = (input: unknown, encOrOffset?: unknown, length?: unknown): Uint8Array => {
	if (typeof input === "string") {
		if (encOrOffset === "base64") return b64ToBytes(input);
		return new TextEncoder().encode(input);
	}
	if (input instanceof ArrayBuffer) {
		const off = (encOrOffset as number) ?? 0;
		return new Uint8Array(input, off, (length as number) ?? input.byteLength - off);
	}
	if (ArrayBuffer.isView(input)) {
		return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
	}
	if (Array.isArray(input)) return new Uint8Array(input);
	return new Uint8Array(0);
};

export const Buffer = Object.assign(make, {
	from: make,
	alloc: (size: number): Uint8Array => new Uint8Array(size),
	allocUnsafe: (size: number): Uint8Array => new Uint8Array(size),
	isBuffer: (x: unknown): boolean => x instanceof Uint8Array,
	isEncoding: (enc: string): boolean => enc === "utf8" || enc === "base64" || enc === "binary",
});

export function join(...parts: string[]): string {
	return parts
		.filter((p) => p && p !== "." && p !== "/")
		.map((p, i) => (i === 0 ? p.replace(/\/+$/, "") : p.replace(/^\/+|\/+$/g, "")))
		.join("/");
}

export const resolve = join;
export const sep = "/";

// Also expose as globals — the engine references the global Buffer directly.
const g = globalThis as unknown as { Buffer?: unknown; path?: unknown };
if (!g.Buffer) g.Buffer = Buffer;
if (!g.path) g.path = { join, resolve, sep };
