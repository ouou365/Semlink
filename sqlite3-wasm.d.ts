// @sqlite.org/sqlite-wasm 的 wasm 资产以 base64 字符串内联进 bundle
// （esbuild loader ".wasm": "base64"），与 sql-wasm.wasm 的用法一致。
declare module "@sqlite.org/sqlite-wasm/sqlite3.wasm" {
	const content: string;
	export default content;
}
