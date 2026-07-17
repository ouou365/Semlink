import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";

// Shared build options. We produce two bundles:
//   - main.js        : plugin entry, loaded by Obsidian on the main thread
//   - db-worker.js    : DB worker child, spawned via worker_threads from main.js
// Both sit next to each other in the plugin directory (same __dirname), and
// both inline sql-wasm.wasm as base64 so no extra files need to be shipped.
const buildOptions = {
	bundle: true,
	entryPoints: ["main.ts", "src/db-worker.ts"],
	outdir: ".",
	// Flatten entry paths so both bundles land in the plugin root alongside
	// each other: main.js + db-worker.js. (Without this, the src/db-worker.ts
	// entry would emit to src/db-worker.js, and worker loading by __dirname
	// would fail.)
	entryNames: "[name]",
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
	platform: "node",
	define: {
		"process.env.NODE_ENV": prod ? '"production"' : '"development"',
	},
	loader: {
		".wasm": "base64",
		".png": "dataurl",
		".svg": "text",
	},
};

if (prod) {
	esbuild.build({ ...buildOptions, minify: true });
} else {
	const ctx = await esbuild.context(buildOptions);
	await ctx.watch();
	console.log("Watching for changes...");
}
