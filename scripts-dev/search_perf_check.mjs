#!/usr/bin/env node
// ========================================
// 检索性能基线检查（提交 gitee 前门禁，2026-11-19 用户拍板）
// ========================================
// 对运行中的 Semlink 实例测 grep / keyword / search / semantic 的真实
// 端到端延迟（ToolCore.execute 计时），与 scripts-dev/perf-history.json
// 里上一次记录对照：
//   - grep / keyword（纯本地检索）：硬门禁——超过基线 2 倍即 FAIL，
//     阻止性能回归提交；
//   - search / semantic（含 embedding 网络请求）：只记录 + 提示，不作
//     FAIL 依据（网络抖动不可控，硬卡会误报）。
// 每次运行追加一条历史（保留最近 20 条），基线 = 上一次记录，方便对照。
//
// 用法：
//   node scripts-dev/search_perf_check.mjs [--url http://127.0.0.1:3002/mcp]
//        [--runs 3] [--fail-ratio 2]
// 退出码：0 = 通过；1 = 本地检索超阈值 2 倍（不要提交）。

import process from "node:process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const HISTORY_PATH = join(HERE, "perf-history.json");

// ── 参数 ──
const args = process.argv.slice(2);
const opt = (name, dflt) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : dflt;
};
const MCP_URL = opt("url", "http://127.0.0.1:3002/mcp");
const RUNS = Math.max(1, Number(opt("runs", "3")));
const FAIL_RATIO = Number(opt("fail-ratio", "2"));

// 固定查询集（写死保证历史可比；查询词来自真实高频用法）
const CASES = [
	{ name: "grep", args: { pattern: "海图", limit: 10 }, local: true },
	{ name: "keyword", args: { query: "海图 更新", limit: 10 }, local: true },
	{ name: "search", args: { query: "电子海图如何更新", limit: 10 }, local: false },
	{ name: "semantic", args: { query: "电子海图更新注意事项", limit: 10 }, local: false },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callTool(name, argsObj = {}, timeoutMs = 30000) {
	const res = await fetch(MCP_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: Math.floor(Math.random() * 1e9),
			method: "tools/call",
			params: { name, arguments: argsObj },
		}),
	});
	const data = await res.json();
	if (data.error) throw new Error(`MCP error: ${data.error.message ?? ""}`);
	return data.result?.content?.[0]?.text ?? "";
}

// 健康探针：库规模（对照用）+ ToolCore 可达
const SETUP_PROBE = `(() => {
	const core = plugin.mcpServer?.core;
	if (!core) return { fatal: "plugin.mcpServer.core 不可达（MCP server 未启动）" };
	return { ok: true };
})()`;

// 计时探针：单工具单次执行
const timedProbe = (name, args) => `(async () => {
	const core = plugin.mcpServer?.core;
	if (!core) return { err: "no core" };
	const t0 = performance.now();
	try {
		const out = await core.execute(${JSON.stringify(name)}, ${JSON.stringify(args)});
		return { ms: Math.round(performance.now() - t0), bytes: out.length };
	} catch (e) {
		return { err: String(e.message || e).slice(0, 100) };
	}
})()`;

function parseProbe(text) {
	try {
		const parsed = JSON.parse(text);
		return parsed?.result ?? parsed;
	} catch {
		return { err: "非 JSON 输出: " + String(text).slice(0, 100) };
	}
}

// ── 主流程 ──
// 0) ToolCore 可达性
let probe;
try {
	probe = parseProbe(await callTool("eval", { expr: SETUP_PROBE }));
} catch (e) {
	console.error(`FAIL：无法连接 semlink-debug（${String(e.message || e).slice(0, 80)}）`);
	process.exit(1);
}
if (probe.err || probe.fatal) {
	console.error(`FAIL：${probe.err ?? probe.fatal}`);
	process.exit(1);
}

// 1) 逐用例计时（RUNS 次取最小值——min 对缓存/抖动最稳）
const results = {};
for (const c of CASES) {
	const times = [];
	for (let i = 0; i < RUNS; i++) {
		const r = parseProbe(await callTool("eval", { expr: timedProbe(c.name, c.args) }));
		if (r.err) {
			console.error(`FAIL：${c.name} 执行出错: ${r.err}`);
			process.exit(1);
		}
		times.push(r.ms);
		if (i < RUNS - 1) await sleep(200);
	}
	results[c.name] = { min: Math.min(...times), all: times };
}

// 2) 读历史
let history = [];
if (existsSync(HISTORY_PATH)) {
	try {
		history = JSON.parse(readFileSync(HISTORY_PATH, "utf8"));
		if (!Array.isArray(history)) history = [];
	} catch {
		history = [];
	}
}
const prev = history[history.length - 1] ?? null;

// 3) 对照与判定
let fail = false;
const warns = [];
console.log(`检索性能检查（${RUNS} 次取最小值，单位 ms）`);
console.log("用例        本次   基线   比值   判定");
for (const c of CASES) {
	const cur = results[c.name].min;
	const base = prev?.perf?.[c.name]?.min ?? null;
	const ratio = base ? +(cur / base).toFixed(2) : null;
	let verdict = "首次记录";
	if (base != null) {
		if (!c.local) {
			verdict = ratio > FAIL_RATIO ? "WARN(网络项不卡提交)" : "OK";
			if (ratio > FAIL_RATIO) warns.push(`${c.name} 为 ${ratio}× 基线（含 embedding 网络请求，不作 FAIL 依据，关注趋势）`);
			else if (ratio > 1.5) warns.push(`${c.name} ${ratio}× 基线`);
		} else if (ratio > FAIL_RATIO) {
			verdict = "FAIL";
			fail = true;
		} else if (ratio > 1.5) {
			verdict = "WARN";
			warns.push(`${c.name} ${ratio}× 基线（本地检索变慢，关注）`);
		} else {
			verdict = "OK";
		}
	}
	console.log(
		`${c.name.padEnd(10)} ${String(cur).padStart(5)}  ${base != null ? String(base).padStart(5) : "  —  "}  ${
			ratio != null ? String(ratio).padStart(4) + "×" : "  —  "
		}   ${verdict}`,
	);
}

// 4) 库规模（notes/chunks——基线适用性对照：规模大变时耗时比值仅供参考）
let corpus = null;
try {
	const st = parseProbe(await callTool("stats", {}));
	corpus = {
		notes: st?.cells?.indexed ?? null,
		chunks: st?.chunks?.total ?? null,
	};
} catch {
	/* stats 不可得就不记 */
}

// 5) 追加历史（保留最近 20 条）
const entry = {
	at: new Date().toISOString(),
	machine: hostname(),
	corpus,
	perf: Object.fromEntries(CASES.map((c) => [c.name, results[c.name]])),
};
history.push(entry);
while (history.length > 20) history.shift();
writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 1) + "\n");
console.log(`\n历史已记录 → scripts-dev/perf-history.json（第 ${history.length} 条）`);

for (const w of warns) console.log(`WARN: ${w}`);
if (fail) {
	console.log("\n结果：FAIL——本地检索明显变慢，不要提交，先排查回归");
	process.exit(1);
}
console.log("\n结果：PASS");
