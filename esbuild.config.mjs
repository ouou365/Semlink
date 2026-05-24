import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import { cpSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const prod = process.argv[2] === "production";

const buildOptions = {
	bundle: true,
	entryPoints: ["main.ts"],
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		...builtins,
	],
	format: "cjs",
	target: "es2022",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
	platform: "node",
	define: {
		"process.env.NODE_ENV": prod ? '"production"' : '"development"',
	},
};

// Copy sql-wasm.wasm after build
function copyWasm() {
	try {
		const src = join(__dirname, "node_modules", "sql.js", "dist", "sql-wasm.wasm");
		const dest = join(__dirname, "sql-wasm.wasm");
		cpSync(src, dest);
		console.log("Copied sql-wasm.wasm");
	} catch (e) {
		console.warn("Warning: Could not copy sql-wasm.wasm:", e.message);
	}
}

if (prod) {
	esbuild.build({ ...buildOptions, minify: true }).then(() => copyWasm());
} else {
	const ctx = await esbuild.context(buildOptions);
	await ctx.watch();
	copyWasm();
	console.log("Watching for changes...");
}
