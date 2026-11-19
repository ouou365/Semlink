#!/usr/bin/env node
// ========================================
// Semlink - 弹窗样式审查页生成器
// ========================================
// 生成 scripts-dev/modal-review.html：把项目里全部 22 个 Modal（28 个渲染态，
// 含同一弹窗的多状态变体）放到一个独立 HTML 页面上，供人工审查样式一致性。
//
// 保真来源：
//   1. styles.css —— 插件样式原样内联；
//   2. _review_assets.json —— 从真实 Obsidian 运行时导出的基础 CSS（:root/body/
//      .theme-light/.theme-dark 变量 + modal/setting/button/input 等组件规则）、
//      lucide 图标与弹窗 DOM 骨架（由 semlink-debug eval 导出，见 skill 手册）；
//   3. 各弹窗的 onOpen 源码 —— DOM 结构逐节点对照手抄。
//
// 用法：node scripts-dev/gen_modal_review.mjs
// 依赖：src/locales/zh.ts（zh 文案）、src/semlink-logo.svg（品牌图标）、
//       src/settings-models.ts（PROVIDER_LOGOS 内的小体积 logo）、
//       _review_assets.json（Obsidian 实测样式资产，不入库）。

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

// ── 输入 ──
const zhSrc = readFileSync(join(ROOT, "src/locales/zh.ts"), "utf8");
const stylesCss = readFileSync(join(ROOT, "styles.css"), "utf8");
const logoSvg = readFileSync(join(ROOT, "src/semlink-logo.svg"), "utf8");
const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
const modelsTs = readFileSync(join(ROOT, "src/settings-models.ts"), "utf8");
// _review_assets.json = CSS 规则（v2 格式：{g: 所在 @media/@supports 前缀栈, t: 规则文本}）；
// _review_assets_extra.json = 图标 / 弹窗骨架（obsidian 运行时导出，见文件头注释）
const assets = JSON.parse(readFileSync(join(HERE, "_review_assets.json"), "utf8"));
const extra = JSON.parse(readFileSync(join(HERE, "_review_assets_extra.json"), "utf8"));

// ── zh 文案 ──
const zh = new Map();
for (const line of zhSrc.split("\n")) {
	const m = line.match(/^\t("?)([\w-]+)\1:\s*"(.*)",?\s*$/);
	if (!m) continue;
	zh.set(m[2], m[3].replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\"));
}
const t = (k) => {
	const v = zh.get(k);
	if (v == null) throw new Error(`zh locale missing key: ${k}`);
	return v;
};

// ── 品牌图标（只取小体积 SVG，base64 位图 logo 用首字母回退圈代替） ──
const LOGOS = {};
const logosBlock = modelsTs.slice(
	modelsTs.indexOf("const PROVIDER_LOGOS"),
	modelsTs.indexOf("};", modelsTs.indexOf("const PROVIDER_LOGOS")),
);
for (const m of logosBlock.matchAll(/"([a-z0-9]+)":\s*`([^`]*)`/g)) {
	if (m[2].length <= 3500) LOGOS[m[1]] = m[2];
}
const logoKey = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

// semlink-logo：与 main.ts addIcon 同款包装（1024 坐标系缩进 100 盒）
const SEMLINK_LOGO = (() => {
	const inner = logoSvg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
	return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" class="svg-icon" viewBox="0 0 100 100"><g transform="scale(0.09765625)">${inner}</g></svg>`;
})();

// ── lucide 图标 ──
const X_FALLBACK =
	'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon lucide-x"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>';
const ic = (n) => extra.icons[n] || (n === "x" ? X_FALLBACK : "");
const brandLogo = (name, cls) => {
	const svg = LOGOS[logoKey(name)];
	if (svg) return `<div class="${cls}">${svg}</div>`;
	const initial = (name || "").trim().charAt(0).toUpperCase() || "?";
	return `<div class="semlink-guide-provider-fallback">${initial}</div>`;
};

// ── DOM 构造辅助 ──
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// Setting 行：name/desc 缺省时不输出对应节点（真机 Setting 只有按钮时无 info 文本）
const setting = ({ name, desc = "", cls = "", controls = "" }) =>
	`<div class="setting-item${cls ? " " + cls : ""}"><div class="setting-item-info">${name ? `<div class="setting-item-name">${name}</div>` : ""}${
		desc ? `<div class="setting-item-description">${desc}</div>` : ""
	}</div><div class="setting-item-control">${controls}</div></div>`;
// 文本输入：与真机 TextComponent 一致的无类名裸 input（基础样式来自 Obsidian app.css）
const textIn = (placeholder, value = "", extra = "") =>
	`<input type="text" placeholder="${esc(placeholder)}"${value ? ` value="${esc(value)}"` : ""}${extra}>`;
const btn = (label, cls = "") => `<button${cls ? ` class="${cls}"` : ""}>${label}</button>`;
const extraBtn = (iconName, tip) =>
	`<div class="clickable-icon extra-setting-button" aria-label="${esc(tip)}">${ic(iconName)}</div>`;
const closeChrome = `<div class="modal-header-button mod-raised clickable-icon">${ic("x")}</div>`;
const titleHeader = (text) => `<div class="modal-header"><div class="modal-title">${text}</div></div>`;

// ── 假二维码（确定性伪随机矩阵 + 三个定位角，结构与 ShareQrModal 输出一致） ──
const qrSvg = () => {
	const N = 25;
	const rnd = (i) => {
		const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
		return x - Math.floor(x);
	};
	const inFinder = (x, y) =>
		(x < 7 && y < 7) || (x >= N - 7 && y < 7) || (x < 7 && y >= N - 7);
	const finderCell = (fx, fy, x, y) => {
		const dx = x - fx, dy = y - fy, r = Math.max(Math.abs(dx), Math.abs(dy));
		return r === 0 || r === 6 || (r >= 2 && r <= 4 && dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4) ? (r === 3 ? false : true) : false;
	};
	let d = "";
	for (let y = 0; y < N; y++)
		for (let x = 0; x < N; x++) {
			const on = inFinder(x, y)
				? finderCell(x < 7 ? 3 : N - 4, y < 7 ? 3 : N - 4, x, y)
				: rnd(y * 31 + x) > 0.52;
			if (on) d += `M${x} ${y}h1v1h-1z`;
		}
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" shape-rendering="crispEdges"><path d="${d}" fill="#111"></path></svg>`;
};

// 用量看板 30 天柱高（确定性）
const usageBars = Array.from({ length: 30 }, (_, i) =>
	Math.max(3, Math.round(18 + 78 * Math.abs(Math.sin(i * 1.73 + 0.6)))),
);

// ── 弹窗状态构建器：返回 .modal-content 的内部 HTML ──
const builders = {
	confirm: () => `
<p>${t("mcpDeleteBody")}</p>
<div class="semlink-confirm-row">${btn(t("confirmCancel"))}${btn(t("mcpDeleteAction"), "mod-warning")}</div>`,

	"save-note": () => `
<h3>${t("saveModalTitle")}</h3>
${setting({ name: t("saveModalPath"), desc: t("saveModalPathDesc"), controls: textIn("Semlink/回答-xxx.md", "Semlink/回答-20261119-153012.md") })}
${setting({ controls: btn(t("saveModalConfirm"), "mod-cta") + btn(t("saveModalCancel")) })}`,

	progress: () => `
<h2>${t("progressTitle")}</h2>
<p class="progress-phase">${t("phaseCurrent")}: ${t("phaseEmbedding")}</p>
<div class="progress-stats">731 / 842 (86.8%)</div>
<div class="detail-grid">
	<span class="label">${t("embeddedChunks")}</span><span class="value">1,284</span>
	<span class="label">${t("failedChunks")}</span><span class="value">3</span>
	<span class="label">${t("skippedChunks")}</span><span class="value">112</span>
	<span class="label">${t("currentFile")}</span><span class="value">projects/alpha/架构评审纪要.md</span>
	<span class="label">${t("avgResponse")}</span><span class="value">412ms</span>
	<span class="label">${t("chunkProgress")}</span><span class="value">18/24</span>
</div>
<div class="network-status">${t("networkLabel")} ${t("networkHealthy")}</div>
<div class="progress-error"></div>
<div class="btn-group">${setting({ controls: btn(t("btnResume"), "mod-cta") })}</div>`,

	"chat-models": () => `
<h2>${t("chatModels")} — DeepSeek</h2>
${setting({
		name: t("chatModelId"),
		controls: textIn("model-id", "deepseek-chat") + textIn("200000", "128K") + extraBtn("trash", t("chatDeleteModel")),
	})}
${setting({
		cls: "semlink-model-price-row",
		name: t("chatModelPrice"),
		desc: t("chatModelPriceDesc"),
		controls: textIn(t("chatModelPriceIn"), "0.27") + textIn(t("chatModelPriceOut"), "1.1"),
	})}
${setting({ controls: btn(t("chatAddModel"), "mod-cta") + btn(t("chatDone")) })}`,

	"add-model": () => `
<div class="semlink-editor-field-label">${t("chatModelId")}</div>
<input type="text" class="semlink-editor-input" placeholder="e.g. my-model-v1" value="deepseek-reasoner">
<div class="semlink-field-error semlink-hidden"></div>
<div class="semlink-editor-field-label">${t("chatContextWindow")}</div>
<input type="text" class="semlink-editor-input" placeholder="e.g. 128000" value="128000">
<div class="semlink-field-error semlink-hidden"></div>
<div class="semlink-editor-footer is-simple">
	<button class="semlink-editor-delete-link">${t("chatDeleteModel")}</button>
	<button class="semlink-editor-cancel-btn">${t("cancel")}</button>
	<button class="semlink-editor-save-btn">${t("confirm")}</button>
</div>`,

	"key-modal": (variant) => {
		const advOpen = variant === "adv";
		const statusHtml =
			variant === "adv"
				? `<div class="semlink-mt-config-status is-err">401 Unauthorized · 无效的 API Key，请检查后重试</div>`
				: `<div class="semlink-mt-config-status"></div>`;
		return `
<div class="semlink-mt-modal-keylabel">
	<div class="semlink-editor-field-label">${t("apiKey")}</div>
	<div class="semlink-mt-config-link is-clickable" aria-label="${esc(t("editorGetKey"))}" title="${esc(t("editorGetKey"))}">${ic("external-link")}</div>
</div>
<input type="password" class="semlink-editor-input" value="sk-9f3ka0d8s7f6a5s4d3f2g1h0j9k8l">
${statusHtml}
<div class="semlink-mt-config-advhead is-clickable" role="button" tabindex="0">
	<div class="semlink-mt-config-advchevron">${ic(advOpen ? "chevron-down" : "chevron-right")}</div>
	<div class="semlink-mt-config-advlabel">${t(advOpen ? "editorAdvancedHide" : "editorAdvancedShow")}</div>
</div>
<div class="semlink-mt-config-advbody${advOpen ? "" : " semlink-hidden"}">
	<div class="semlink-mt-config-fieldlabel">${t("chatApiFormat")}</div>
	<div class="semlink-mt-config-selectbtn is-clickable" role="button" tabindex="0">
		<span class="semlink-mt-config-selectbtn-label">OpenAI</span>
		<div class="semlink-mt-config-selectbtn-chevron">${ic("chevron-down")}</div>
	</div>
	<div class="semlink-mt-config-fieldlabel">${t("editorEndpoint")}</div>
	<input type="text" class="semlink-editor-input" placeholder="https://api.openai.com/v1/chat/completions" value="https://api.deepseek.com/v1/chat/completions">
</div>
<div class="semlink-editor-footer is-simple">
	<button class="semlink-editor-cancel-btn">${t("cancel")}</button>
	<button class="semlink-editor-save-btn"><span class="semlink-mt-key-save-icon">${ic("check")}</span><span>${t("mtKeyTestSave")}</span></button>
</div>`;
	},

	"series-pick": () => `
<div class="semlink-guide-provider-grid semlink-guide-provider-grid-vertical">
	${[
			{ name: "Qwen", cur: true },
			{ name: "Qwen CN" },
			{ name: "Qwen Token Plan" },
		]
			.map(
				(v) => `
	<div class="semlink-guide-provider-card${v.cur ? " is-current" : ""}" role="button" tabindex="0">
		${brandLogo(v.name, "semlink-guide-provider-logo")}
		<div class="semlink-guide-provider-name">${v.name}</div>
		<span class="semlink-guide-provider-endpoint" title="https://dashscope.aliyuncs.com/compatible-mode/v1">https://dashscope.aliyuncs.com/compatible-mode/v1</span>
	</div>`,
			)
			.join("")}
</div>`,

	"delete-provider": () => `
<div class="semlink-delete-desc">${t("deleteDescription")}</div>
${setting({ controls: btn(t("cancel")) + btn(t("deleteConfirm"), "mod-destructive") })}`,

	"add-provider-catalog": () => {
		const entries = [
			{ name: "Siliconflow", star: true, url: "https://api.siliconflow.cn/v1" },
			{ name: "OpenAI", url: "https://api.openai.com/v1" },
			{ name: "Anthropic", url: "https://api.anthropic.com" },
			{ name: "DeepSeek", url: "https://api.deepseek.com" },
			{ name: "Qwen", url: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
			{ name: "Google", url: "https://generativelanguage.googleapis.com" },
			{ name: "Moonshot", url: "https://api.moonshot.cn/v1" },
			{ name: "Z.AI", url: "https://api.z.ai/api/paas/v4" },
			{ name: "MiniMax", url: "https://api.minimax.chat/v1" },
		];
		return `
<div class="semlink-add-provider-grid">
	${entries
		.map(
			(e) => `
	<div class="semlink-add-provider-card">
		${e.star ? `<span class="semlink-add-provider-star">⭐</span>` : ""}
		${brandLogo(e.name, "semlink-add-provider-card-logo")}
		<div class="semlink-add-provider-card-name">${e.name}</div>
		<span class="semlink-add-provider-card-endpoint" title="${esc(e.url)}">${esc(e.url)}</span>
	</div>`,
		)
		.join("")}
	<div class="semlink-add-provider-card semlink-add-provider-card-custom">
		<div class="semlink-add-provider-card-fallback">＋</div>
		<div class="semlink-add-provider-card-name">${t("customProvider")}</div>
	</div>
</div>`;
	},

	"add-provider-custom": (variant) => {
		const iconsOpen = variant === "icons";
		const iconKeys = ["ollama", "openai", "anthropic", "google", "deepseek", "qwen", "moonshot", "zai"].filter(
			(k) => LOGOS[k],
		);
		return `
<div class="semlink-add-card"><div class="semlink-add-card-body">
<div class="semlink-draft-error semlink-hidden"></div>
<div class="semlink-icon-select-wrap">
	<button class="semlink-icon-box" type="button"><span class="semlink-icon-select-face">${LOGOS.ollama || ""}</span></button>
	<div class="semlink-icon-field-info">
		<span class="semlink-icon-field-name">${t("mtIcon")}</span>
		<span class="semlink-icon-field-key">ollama</span>
	</div>
	<div class="semlink-icon-dropdown${iconsOpen ? "" : " semlink-hidden"}">
		<div class="semlink-icon-picker">
			${iconKeys.map((k) => `<div class="semlink-icon-swatch${k === "ollama" ? " is-picked" : ""}" title="${k}">${LOGOS[k]}</div>`).join("")}
		</div>
	</div>
</div>
<div class="semlink-editor-field-label">${t("chatProviderName")}</div>
<input type="text" class="semlink-editor-input" placeholder="My Gateway">
<div class="semlink-editor-field-label">${t("chatApiFormat")}</div>
<select class="semlink-editor-select"><option value="openai">${t("mtApiTypeOpenAI")}</option><option value="anthropic">${t("mtApiTypeAnthropic")}</option></select>
<div class="semlink-editor-field-label">${t("editorEndpoint")}</div>
<input type="text" class="semlink-editor-input" placeholder="e.g., http://localhost:8080/v1/completions">
<div class="semlink-editor-field-label">${t("chatApiKey")}</div>
<select class="semlink-editor-select"><option value="header">${t("mtAuthHeader")}</option><option value="none">${t("mtAuthNone")}</option></select>
<div class="semlink-editor-field-label">${t("apiKey")}</div>
<input type="password" class="semlink-editor-input" placeholder="sk-...">
${setting({ controls: btn(t("cancel")) + btn(t("create"), "mod-cta") })}
</div></div>`;
	},

	usage: () => {
		const card = (v, l) => `<div class="semlink-usage-card"><div class="semlink-usage-card-value">${v}</div><div class="semlink-usage-card-label">${l}</div></div>`;
		return `
<h2>${t("usageTitle")}</h2>
<div class="semlink-usage-cards">
	${card("$4.21", t("usageThisMonth"))}
	${card("$18.60", t("usageTotal"))}
	${card("612", t("usageRequestsMonth"))}
	${card("2.4M → 890.5k", t("usageTokens"))}
</div>
<div class="semlink-usage-body semlink-usage-locked">
	<div class="semlink-usage-gate">
		<div class="semlink-usage-gate-title">${t("usageProTitle")}</div>
		<div class="semlink-usage-gate-desc">${t("usageProDesc")}</div>
		<button class="mod-cta">${t("unlockPro")}</button>
	</div>
	<div class="semlink-usage-section">
		<div class="semlink-usage-section-title">${t("usageLast30")}</div>
		<div class="semlink-usage-chart">${usageBars.map((h) => `<div class="semlink-usage-bar" style="height:${h}%"></div>`).join("")}</div>
	</div>
	<div class="semlink-usage-section">
		<div class="semlink-usage-section-title">${t("usageByModel")}</div>
		<table class="semlink-usage-table">
			<tr><th>${t("usageModel")}</th><th>${t("usageReqs")}</th><th>${t("usageTokensIn")}</th><th>${t("usageTokensOut")}</th><th>${t("usageCost")}</th></tr>
			<tr><td>deepseek-chat</td><td>214</td><td>980.2k</td><td>312.4k</td><td class="semlink-usage-cost">$1.42</td></tr>
			<tr><td>deepseek-reasoner</td><td>96</td><td>540.9k</td><td>187.1k</td><td class="semlink-usage-cost">$1.08</td></tr>
			<tr><td>qwen-max</td><td>58</td><td>212.3k</td><td>88.7k</td><td class="semlink-usage-cost">$0.94</td></tr>
		</table>
		<div class="semlink-usage-hint">${t("usageNoPrice")}</div>
	</div>
</div>`;
	},

	// 用量与统计详情屏（view 内全屏，非 Modal）：顶条（← 返回 + 居中
	// 页面名）+ 仪表盘宿主；DOM 与真实屏逐节点同构，样式全靠 styles.css。
	"usage-screen": () => `
<div class="semlink-search-header semlink-guide-corners semlink-settings-corners">
	<div class="semlink-search-header-side">
		<button class="semlink-search-icon-btn clickable-icon" aria-label="${esc(t("historyBack"))}">${ic("arrow-left")}</button>
	</div>
	<div class="semlink-search-brand-group"><span class="semlink-search-brand">${t("usageStatsEntry")}</span></div>
</div>
<div class="semlink-search-welcome semlink-usage-screen">
	${builders.usage().replace(/^<h2>[^<]*<\/h2>\n/, "")}
</div>`,

	license: () => `
${setting({ name: t("licenseStatusFree"), desc: t("licenseFreeDesc") })}
<div class="semlink-license-subhead">${t("upgradeBenefitsTitle")}</div>
<div class="semlink-license-benefits">
	${[t("upgradeBenefitHistory"), t("upgradeBenefitOrganize")]
		.map((l) => `<div class="semlink-license-benefit-row"><span class="semlink-license-check"></span><span>${l}</span></div>`)
		.join("")}
</div>
<div class="semlink-license-subhead">${t("upgradeBuyTitle")}</div>
<div class="semlink-license-buy">${btn(t("upgradeBuyEarly"), "mod-cta")}</div>
<div class="semlink-license-anchor">${t("upgradePriceAnchor")}</div>
<div class="semlink-license-subhead">${t("upgradeFreeListTitle")}</div>
<div class="semlink-license-benefits">
	${[t("upgradeFreeSearch"), t("upgradeFreeMcp"), t("upgradeFreeModels"), t("upgradeFreeDepth"), t("upgradeFreeLocal")]
		.map((l) => `<div class="semlink-license-benefit-row semlink-license-free-row"><span class="semlink-license-check"></span><span>${l}</span></div>`)
		.join("")}
</div>
<div class="semlink-license-subhead">${t("licenseKeyTitle")}</div>
${setting({
		name: t("licenseKeyLabel"),
		controls: textIn(t("licenseKeyPlaceholder")) + btn(t("licenseActivate"), "mod-cta"),
	})}
<div class="semlink-license-trust">${t("upgradeTrustNote")}</div>`,

	"license-about": () => {
		const row = (label, value, cls = "") =>
			`<div class="semlink-license-about-row"><span class="semlink-license-about-rowlabel">${label}</span><span class="semlink-license-about-rowvalue${cls ? " " + cls : ""}"${cls.includes("is-clickable") ? ` title="${esc(t("licenseCopyKey"))}"` : ""}>${value}</span></div>`;
		return `
<div class="semlink-license-about">
	<div class="semlink-license-about-icon">${SEMLINK_LOGO}</div>
	<div class="semlink-license-about-name">Semlink</div>
	<div class="semlink-license-about-tagline">${t("settingsTagline")}</div>
	<div class="semlink-license-about-version">${t("licenseAboutVersion").replace("{v}", manifest.version)}</div>
	<div class="semlink-license-about-rows">
		${row(t("licenseFieldStatus"), t("licenseStatusActive"), "is-green")}
		${row(t("licenseFieldPlan"), t("licenseLifetime"))}
		${row(t("licenseDevices"), "1 / 3")}
		${row(t("licenseKeyField"), "SK1A····9F3D", "is-clickable")}
	</div>
	<div class="semlink-license-about-actions">
		<button class="semlink-btn-ghost mod-danger semlink-license-deactivate">${t("licenseDeactivateShort")}</button>
	</div>
	<button class="semlink-btn-primary semlink-btn-block semlink-license-about-ok">${t("licenseAboutOk")}</button>
	<div class="semlink-license-about-copyright">${t("licenseCopyright")}</div>
</div>`;
	},

	"mcp-config": (variant) => {
		const jsonView = variant === "json";
		const field = (label, control, error = "", extraCls = "") =>
			`<div class="semlink-mcp-field${extraCls ? " " + extraCls : ""}"><div class="semlink-editor-field-label">${label}</div>${control}${error ? `<div class="semlink-mcp-field-error">${error}</div>` : ""}</div>`;
		const form = `
<div class="semlink-mcp-edit-form">
	${field(t("mcpServerName"), `<input type="text" class="semlink-editor-input" placeholder="my-mcp-server" spellcheck="false" value="docs-search">`)}
	${field(t("mcpServerType"), `<select class="semlink-editor-select"><option value="http">HTTP</option><option value="sse">SSE</option><option value="stdio">stdio</option></select>`)}
	${field(t("mcpTimeoutMs"), `<input type="text" class="semlink-editor-input" placeholder="30000" inputmode="numeric" value="30000">`)}
	${field(t("mcpProtocolVersion"), `<select class="semlink-editor-select"><option value="">${t("mcpProtocolAuto")}</option><option>2025-06-18</option><option>2025-03-26</option><option>2024-11-05</option></select>`)}
	<div class="semlink-mcp-edit-desc">${t("mcpProtocolHint")}</div>
	${field(t("mcpServerUrl"), `<input type="text" class="semlink-editor-input" placeholder="https://mcp.example.com/mcp" spellcheck="false" value="https://mcp.example.com/mcp">`)}
	${field(`${t("mcpServerHeaders")} (JSON)`, `<textarea class="semlink-editor-input semlink-monospace" rows="4" placeholder="{&#10;  &quot;Authorization&quot;: &quot;Bearer your-token&quot;&#10;}"></textarea>`)}
	${field(t("mcpServerCommand"), `<input type="text" class="semlink-editor-input" placeholder="npx -y @some/mcp" spellcheck="false">`, "", "semlink-hidden")}
	${field(t("mcpServerArgs"), `<input type="text" class="semlink-editor-input" placeholder="--port 8080 --verbose" spellcheck="false">`, "", "semlink-hidden")}
</div>`;
		const json = `
<div class="semlink-mcp-edit-json">
	<div class="semlink-editor-field-label">${t("mcpFullConfig")}</div>
	<textarea class="semlink-editor-input semlink-monospace" rows="12">{
  "docs-search": {
    "type": "http",
    "url": "https://mcp.example.com/mcp",
    "timeoutMs": 30000
  }
}</textarea>
	<div class="semlink-mcp-edit-desc">${t("mcpJsonPasteHint")}</div>
	<button class="semlink-btn-secondary semlink-mcp-json-copy">${t("mcpJsonCopy")}</button>
</div>`;
		return `
<div class="semlink-mcp-edit-segrow"><div class="semlink-mcp-edit-seg">
	<button class="${jsonView ? "" : "is-active"}">Form</button>
	<button class="${jsonView ? "is-active" : ""}">JSON</button>
</div></div>
${jsonView ? json : form}
<div class="semlink-guide-error semlink-hidden"></div>
<div class="semlink-editor-footer is-simple">
	<button class="semlink-editor-delete-link">${t("mcpDeleteAction")}</button>
	<button class="semlink-editor-cancel-btn">${t("cancel")}</button>
	<button class="semlink-editor-save-btn">${t("editorSave")}</button>
</div>`;
	},

	"mcp-share": () => {
		const mcpUrl = "http://127.0.0.1:18333/mcp";
		const section = (label, desc, code) => `
<div class="semlink-mcp-share-section">
	<div class="semlink-mcp-share-head">
		<div class="semlink-mcp-share-text">
			<div class="semlink-mcp-share-label">${label}</div>
			<div class="semlink-mcp-share-desc">${desc}</div>
		</div>
		<button class="semlink-mcp-icon-btn" aria-label="${esc(t("mcpShareCopy"))}">${ic("copy")}</button>
	</div>
	<pre class="semlink-mcp-share-code">${esc(code)}</pre>
</div>`;
		return (
			section(t("claudeCodeCmd"), t("claudeCodeDesc"), t("mcpConnectInstruction").replace("{url}", mcpUrl)) +
			section(
				t("claudeDesktopConfig"),
				t("claudeDesktopDesc"),
				JSON.stringify({ semlink: { type: "http", url: mcpUrl } }, null, 2),
			)
		);
	},

	"exclude-paths": () => `
<div class="semlink-mcp-edit-desc">${t("excludePathsDesc")}</div>
<textarea class="semlink-editor-input" rows="8" placeholder="${esc(t("excludePathsPlaceholder"))}">templates/
.Raw/
规范标准/
attachments/private/</textarea>
<div class="semlink-exclude-count">${t("excludePathCount").replace("{n}", "4")}</div>
<div class="semlink-editor-footer is-simple">
	<button class="semlink-btn-ghost">${t("cancel")}</button>
	<button class="semlink-btn-primary">${t("editorSave")}</button>
</div>`,

	project: () => {
		const rows = [
			{ path: "projects/", depth: 0, checked: true },
			{ path: "projects/alpha/", depth: 1, checked: true },
			{ path: "projects/beta/", depth: 1, checked: false },
			{ path: "docs/", depth: 0, checked: false },
		];
		return `
<h3>${t("projectEditTitle")}</h3>
${setting({ name: t("projectNameLabel"), controls: textIn(t("projectNamePlaceholder"), "知识库精选") })}
<div class="semlink-project-folders">
	<div class="semlink-project-folders-label">${t("projectSourceFolders")}</div>
	<div class="semlink-project-folder-list">
		${rows
			.map(
				(r) => `
		<div class="semlink-project-folder-row" style="padding-left:${8 + r.depth * 16}px">
			<input type="checkbox"${r.checked ? " checked" : ""}>
			<span class="semlink-project-folder-name">${r.path.split("/").filter(Boolean).pop()}</span>
		</div>`,
			)
			.join("")}
	</div>
	<div class="semlink-project-folders-hint"></div>
	<div class="semlink-project-newfolder-row">
		<input class="semlink-project-newfolder-input" type="text" placeholder="${esc(t("projectNewFolder"))}">
		<button class="semlink-btn-ghost">${t("projectCreateFolder")}</button>
	</div>
</div>
<div class="semlink-editor-footer is-simple">
	<button class="semlink-btn-ghost">${t("projectCancel")}</button>
	<button class="semlink-btn-primary">${t("projectSave")}</button>
</div>`;
	},

	"fetch-models": () => `
<div class="semlink-fetch-progress"><div class="semlink-fetch-progress-fill" style="width:40%"></div></div>
<div class="semlink-guide-error semlink-hidden"></div>
<div class="semlink-guide-fetch-list">
	${[
			{ id: "deepseek-chat", ctx: "128K", c: true },
			{ id: "deepseek-reasoner", ctx: "128K", c: false },
			{ id: "deepseek-v3", ctx: "64K", c: false },
			{ id: "deepseek-r1", ctx: "64K", c: false },
		]
			.map(
				(m) => `
	<div class="semlink-guide-fetch-row">
		<input type="checkbox"${m.c ? " checked" : ""}>
		<span class="semlink-guide-model-main"><span class="semlink-guide-model-id">${m.id}</span><span class="semlink-guide-model-ctx">${m.ctx}</span></span>
	</div>`,
			)
			.join("")}
</div>
<div class="semlink-editor-footer is-simple">
	<button class="semlink-editor-cancel-btn">${t("cancel")}</button>
	<button class="semlink-editor-save-btn" disabled>${t("confirm")}</button>
</div>`,

	"embed-brand": () => `
<div class="semlink-guide-provider-grid semlink-guide-provider-grid-vertical">
	<div class="semlink-guide-provider-card">
		${brandLogo("BAAI", "semlink-guide-provider-logo")}
		<div class="semlink-guide-provider-name">BAAI/bge-m3</div>
		<span class="semlink-guide-model-ctx semlink-guide-model-meta">8K</span>
		<div class="semlink-guide-model-chevron">${ic("chevron-down")}</div>
	</div>
	<div class="semlink-guide-provider-card semlink-guide-model-provider">
		${brandLogo("Siliconflow", "semlink-guide-provider-logo")}
		<div class="semlink-guide-provider-name">Siliconflow</div>
		<span class="semlink-guide-model-ctx semlink-guide-model-meta" title="https://api.siliconflow.cn/v1/embeddings">https://api.siliconflow.cn/v1/embeddings</span>
	</div>
	<div class="semlink-guide-provider-card">
		${brandLogo("BAAI", "semlink-guide-provider-logo")}
		<div class="semlink-guide-provider-name">BAAI/bge-large-zh-v1.5</div>
		<span class="semlink-guide-model-ctx semlink-guide-model-meta">512</span>
		<div class="semlink-guide-model-chevron">${ic("chevron-right")}</div>
	</div>
</div>`,

	"embed-variant": () => `
<div class="semlink-guide-provider-grid semlink-guide-provider-grid-vertical">
	${[
			{ id: "BAAI/bge-m3", ctx: "8K" },
			{ id: "Pro/BAAI/bge-m3", ctx: "8K" },
		]
			.map(
				(v) => `
	<div class="semlink-guide-provider-card">
		${brandLogo("Siliconflow", "semlink-guide-provider-logo")}
		<div class="semlink-guide-provider-name">${v.id}</div>
		<span class="semlink-guide-model-ctx semlink-guide-model-meta">${v.ctx}</span>
	</div>`,
			)
			.join("")}
</div>`,

	share: () => `
<h3>${t("shareTitle")}</h3>
<div class="semlink-share-hint">${t("shareHint")}</div>
<div class="semlink-share-row">
	<span class="semlink-share-url">http://192.168.1.20:18333/s/Kx7qZb2mNp</span>
	<button class="semlink-share-copy" aria-label="${esc(t("shareCopy"))}">${ic("copy")}</button>
	<button class="semlink-share-copy" aria-label="${esc(t("shareOpenBrowser"))}">${ic("external-link")}</button>
</div>
<div class="semlink-share-row">
	<span class="semlink-share-url">http://100.64.0.5:18333/s/Kx7qZb2mNp</span>
	<button class="semlink-share-copy" aria-label="${esc(t("shareCopy"))}">${ic("copy")}</button>
	<button class="semlink-share-copy" aria-label="${esc(t("shareOpenBrowser"))}">${ic("external-link")}</button>
</div>
<button class="semlink-share-revoke">${t("shareRevoke")}</button>`,

	"share-qr-progress": () => `
<h3>${t("shareTitle")}</h3>
<div class="semlink-share-progress">
	<div class="semlink-share-progress-icon">${ic("loader-2")}</div>
	<div class="semlink-share-progress-text">${t("shareNoteRendering")} 12/48</div>
</div>`,

	"share-qr": () => `
<div class="semlink-shareq-head">
	<div class="semlink-shareq-name">Semlink 产品评审会话</div>
	<div class="semlink-shareq-sub">${t("shareTabTitle")}</div>
</div>
<div class="semlink-share-qr"><div class="semlink-share-qr-img">${qrSvg()}</div></div>
<div class="semlink-shareq-urlrow">
	<div class="semlink-shareq-url" title="http://192.168.1.20:18333/s/Kx7qZb2mNp">http://192.168.1.20:18333/s/Kx7qZb2mNp</div>
	<button class="semlink-shareq-iconbtn" aria-label="${esc(t("shareCopy"))}">${ic("copy")}</button>
	<button class="semlink-shareq-iconbtn" aria-label="${esc(t("shareOpenBrowser"))}">${ic("external-link")}</button>
</div>
<div class="semlink-share-hint">${t("shareHint")}</div>
<button class="semlink-btn-block semlink-shareq-revoke">${t("shareRevoke")}</button>`,

	"feishu-bot": () => `
<h3>${t("botAddManual")}</h3>
${setting({ name: t("botName"), controls: textIn("Semlink", "产品知识库机器人") })}
${setting({ name: t("botAppId"), controls: textIn("cli_xxx", "cli_a58f2c91b7d84003") })}
${setting({ name: t("botAppSecret"), controls: textIn("xxx", "eJx9mZ4Kq2Rp7TwL") })}
<div class="feishu-prereq">${t("botPrereq")}</div>
${setting({ controls: btn(t("saveModalConfirm"), "mod-cta") + btn(t("saveModalCancel")) })}`,

	// ── 输入区锚定弹层（search-view.ts，body 懒创建 + 锚 chip 定位，非 Modal） ──
	"model-popup": () => {
		const row = (provider, model, ctx) => `
<div class="semlink-search-model-popup-row" draggable="true">
	<div class="semlink-search-model-popup-grip">${ic("grip-vertical")}</div>
	<span class="semlink-search-model-popup-logo">${LOGOS[logoKey(provider)] || ""}</span>
	<span class="semlink-search-model-popup-name">${model}</span>
	<span class="semlink-search-model-popup-ctx">${ctx}</span>
</div>`;
		return `
<div class="semlink-search-model-popup-header">
	<span class="semlink-search-model-popup-logo">${LOGOS.deepseek || ""}</span>
	<span class="semlink-search-model-popup-title">DeepSeek: deepseek-chat</span>
	<span class="semlink-search-model-popup-ctx">128K</span>
</div>
${row("DeepSeek", "deepseek-chat", "128K")}
${row("DeepSeek", "deepseek-reasoner", "128K")}
${row("Qwen", "qwen-max", "32K")}
<div class="semlink-search-model-popup-manage">
	<span class="semlink-search-model-popup-manage-icon">${ic("settings")}</span>
	<span class="semlink-search-model-popup-manage-label">${t("manageModels")}</span>
</div>`;
	},

	"project-popup": () => `
<div class="semlink-project-popup-row is-active">
	<span class="semlink-project-popup-name">${t("projectAllNotes")}</span>
</div>
<div class="semlink-project-popup-row">
	<span class="semlink-project-popup-name">知识库精选</span>
	<span class="semlink-project-popup-meta">2</span>
	<span class="semlink-project-popup-edit" aria-label="${esc(t("projectEditTitle"))}">${ic("pencil")}</span>
</div>
<div class="semlink-project-popup-row">
	<span class="semlink-project-popup-name">产品文档</span>
	<span class="semlink-project-popup-meta">1</span>
	<span class="semlink-project-popup-edit" aria-label="${esc(t("projectEditTitle"))}">${ic("pencil")}</span>
</div>
<div class="semlink-project-popup-row is-new">
	<span class="semlink-project-popup-name">${t("projectNew")}</span>
</div>`,
};

// ── 审查页分节定义 ──
const modalCls = (...c) => c.filter(Boolean).join(" ");
const sections = [
	{ id: "confirm", group: "通用", name: "确认弹窗 ConfirmModal", file: "confirm-modal.ts", entry: "各处破坏性操作二次确认（许可停用 / 删除 MCP 服务器）", mcls: "", header: [t("mcpDeleteTitle").replace("{name}", "docs-search")], b: () => builders.confirm() },
	{ id: "save-note", group: "通用", name: "回答存为笔记 SaveNoteModal", file: "save-note-modal.ts", entry: "聊天答案「保存为笔记」", mcls: "smart-vault-save-modal", header: null, b: builders["save-note"] },
	{ id: "progress", group: "通用", name: "索引进度 ProgressModal", file: "progress-modal.ts", entry: "设置页「查看进度」/ 首次索引；可拖拽移动", mcls: "smart-vault-progress-modal is-draggable", header: null, b: builders.progress },
	{ id: "model-popup", group: "输入区弹层", name: "选择模型弹层 modelPopup", file: "search-view.ts", entry: "输入卡底行模型选择器；锚触发钮上方展开（头部卡=当前模型，行可拖拽排序）", mcls: "semlink-search-depth-popup semlink-search-model-popup", header: null, b: builders["model-popup"], pop: true },
	{ id: "project-popup", group: "输入区弹层", name: "选择项目弹层 projectPopup", file: "search-view.ts", entry: "输入卡底行项目 chip；锚 chip 展开切换/编辑/新建（is-active=当前范围）", mcls: "semlink-search-depth-popup semlink-project-popup", header: null, b: builders["project-popup"], pop: true },
	{ id: "chat-models", group: "模型", name: "模型清单编辑 ChatModelsModal", file: "chat-models-modal.ts", entry: "设置→模型→供应商行「编辑模型」", mcls: "smart-vault-chat-models-modal", header: null, b: builders["chat-models"] },
	{ id: "add-model", group: "模型", name: "添加/编辑模型 AddModelModal", file: "settings-models.ts", entry: "模型页「＋ 添加」/ 引导第三步", mcls: modalCls("semlink-provider-editor-modal", "smart-vault-settings"), header: ["添加模型"], b: builders["add-model"] },
	{ id: "key-modal", group: "模型", name: "API Key 配置 KeyModal（默认态）", file: "settings-models.ts", entry: "供应商行 Key 添加 / 铅笔编辑", mcls: modalCls("semlink-provider-editor-modal", "smart-vault-settings", "semlink-key-modal"), header: ["DeepSeek"], b: () => builders["key-modal"]("base") },
	{ id: "key-modal-adv", group: "模型", name: "KeyModal（高级展开 + 校验错误态）", file: "settings-models.ts", entry: "同上；高级选项展开 / 测试失败反馈", mcls: modalCls("semlink-provider-editor-modal", "smart-vault-settings", "semlink-key-modal"), header: ["DeepSeek"], b: () => builders["key-modal"]("adv") },
	{ id: "series-pick", group: "模型", name: "系列供应商选成员 SeriesPickModal", file: "settings-models.ts", entry: "点击系列供应商（Qwen/Z.AI/MiniMax…）", mcls: "semlink-guide-series-modal", header: ["Qwen"], b: builders["series-pick"] },
	{ id: "delete-provider", group: "模型", name: "删除供应商确认 DeleteProviderModal", file: "settings-models.ts", entry: "供应商行菜单「删除」", mcls: "semlink-delete-modal", header: [t("deleteTitle").replace("{provider}", "DeepSeek")], b: builders["delete-provider"] },
	{ id: "add-provider-catalog", group: "模型", name: "添加供应商·目录 AddProviderModal(catalog)", file: "settings-models.ts", entry: "模型页「＋ 添加供应商」", mcls: modalCls("semlink-add-provider-modal", "smart-vault-settings"), header: [t("pickProvider")], b: builders["add-provider-catalog"] },
	{ id: "add-provider-custom", group: "模型", name: "添加自定义供应商 AddProviderModal(custom)", file: "settings-models.ts", entry: "目录尾部「自定义供应商」/ 引导复用", mcls: modalCls("semlink-add-provider-modal", "smart-vault-settings"), header: [t("customTitle")], b: () => builders["add-provider-custom"]("base") },
	{ id: "add-provider-icons", group: "模型", name: "自定义供应商（图标面板展开态）", file: "settings-models.ts", entry: "同上；点击图标块展开内置图标面板", mcls: modalCls("semlink-add-provider-modal", "smart-vault-settings"), header: [t("customTitle")], b: () => builders["add-provider-custom"]("icons") },
	{ id: "usage", group: "用量与许可", name: "用量看板（免费态） UsageModal", file: "usage-modal.ts", entry: "历史弹窗入口（当前已停用）；渲染本体与详情屏共用 usage-screen.ts", mcls: "semlink-usage-modal", header: null, b: builders.usage },
	{ id: "usage-screen", group: "用量与许可", name: "用量与统计详情屏（视图内全屏）", file: "search-view.ts + usage-screen.ts", entry: "抽屉「新对话」下方菜单行点击 → 对话区切换成统计屏；← 返回恢复对话/主页", mcls: "", header: null, b: builders["usage-screen"], pop: true },
	{ id: "license", group: "用量与许可", name: "升级 / 许可 LicenseModal（免费态）", file: "license-modal.ts", entry: "设置页 / 聊天头部 / 各锁定项「升级」", mcls: "semlink-license-modal", header: null, b: builders.license },
	{ id: "license-about", group: "用量与许可", name: "关于弹窗 LicenseInfoModal", file: "license-modal.ts", entry: "设置→基础→License 行（参考 Eagle 关于窗）", mcls: modalCls("semlink-license-modal", "semlink-license-about-modal"), header: null, b: builders["license-about"] },
	{ id: "mcp-config", group: "MCP", name: "外部 MCP 服务器配置 McpServerConfigModal（Form）", file: "settings.ts", entry: "设置→工具→「添加外部服务器」/ 编辑", mcls: modalCls("semlink-mcp-edit-modal", "semlink-mcp-client-modal", "smart-vault-settings"), header: [t("mcpNew")], b: () => builders["mcp-config"]("form") },
	{ id: "mcp-config-json", group: "MCP", name: "MCP 服务器配置（JSON 视图）", file: "settings.ts", entry: "同上；分段控件切到 JSON", mcls: modalCls("semlink-mcp-edit-modal", "semlink-mcp-client-modal", "smart-vault-settings"), header: [t("mcpNew")], b: () => builders["mcp-config"]("json") },
	{ id: "mcp-share", group: "MCP", name: "Semlink MCP 分享 McpShareModal", file: "settings.ts", entry: "工具页「接入其他客户端」", mcls: modalCls("semlink-mcp-edit-modal", "smart-vault-settings"), header: [t("mcpShareTitle")], b: builders["mcp-share"] },
	{ id: "exclude-paths", group: "知识库", name: "排除路径编辑 ExcludePathsModal", file: "settings.ts", entry: "设置→知识库→Index 面板「编辑」", mcls: modalCls("semlink-mcp-edit-modal", "smart-vault-settings"), header: [t("excludePaths")], b: builders["exclude-paths"] },
	{ id: "project", group: "知识库", name: "项目创建/编辑 ProjectModal", file: "project-modal.ts", entry: "搜索行「项目」下拉的新建/编辑", mcls: modalCls("smart-vault-settings", "semlink-project-modal"), header: null, b: builders.project },
	{ id: "fetch-models", group: "引导", name: "拉取模型清单 GuideFetchModelsModal", file: "onboarding.ts", entry: "引导第 2 步「获取模型」", mcls: modalCls("semlink-guide-series-modal", "smart-vault-settings"), header: [t("guideFetchModels")], b: builders["fetch-models"] },
	{ id: "embed-brand", group: "引导", name: "嵌入模型选择（品牌→模型） EmbedModelPickModal", file: "onboarding.ts", entry: "嵌入流第二级；行点击原地展开供应商", mcls: "semlink-guide-series-modal", header: ["BAAI"], b: builders["embed-brand"] },
	{ id: "embed-variant", group: "引导", name: "嵌入变体确认 EmbedVariantPickModal", file: "onboarding.ts", entry: "嵌入流第三级；同名模型变体选定", mcls: "semlink-guide-series-modal", header: ["Siliconflow"], b: builders["embed-variant"] },
	{ id: "share", group: "分享", name: "会话分享链接 ShareModal", file: "share-modal.ts", entry: "侧栏会话「分享」", mcls: "semlink-share-modal", header: null, b: builders.share },
	{ id: "share-qr-progress", group: "分享", name: "笔记分享·渲染中 ShareQrModal(progress)", file: "share-modal.ts", entry: "笔记分享点击后长渲染期间的进度态", mcls: modalCls("semlink-share-modal", "smart-vault-settings"), header: null, b: builders["share-qr-progress"] },
	{ id: "share-qr", group: "分享", name: "笔记分享·二维码详情 ShareQrModal", file: "share-modal.ts", entry: "渲染完成 / 已共享列表点入", mcls: modalCls("semlink-share-modal", "smart-vault-settings"), header: null, b: builders["share-qr"] },
	{ id: "feishu-bot", group: "机器人", name: "手动添加飞书机器人 AddFeishuBotModal", file: "feishu-bot-modal.ts", entry: "设置→机器人→「手动填写」", mcls: "smart-vault-feishu-modal", header: null, b: builders["feishu-bot"] },
];

// ── CSS 组装 ──
// 过滤策略（v3，2026-11-19 保真度修复）：按逗号拆分选择器、任一部分通过
// 即保留整条规则。旧版"整条选择器串匹配才保留"曾误杀关键规则：
//   - `select, .combobox-button, .dropdown { height: var(--input-height) }`
//     因列表里带 .combobox-button 被整条丢 → 页面 select 塌到 18px；
//   - 全局 `* { box-sizing: border-box }` 因 selector 是 `*` 不含 KEEP 词
//     被丢 → 页面 input/textarea 退回 content-box，高度 54px、JSON 视图
//     横向溢出（用户截图报的四个问题里三个都源于此）。
// APP_AREA 词表只在"该部分"里命中才丢，避免列表连坐。
const APP_AREA_PART =
	/annotationLayer|textLayer|xfaLayer|workspace|markdown|cm-|metadata-|bases|canvas|pdf|nav-|sync-|community|publish|graph|callout|prompt|suggestion|search-|mobile-|\.menu|tooltip|notice|status-bar|ribbon|titlebar|sidebar-toggle|drawer|flair|hotkey|internal-link|tree-item|view-header|lightbox|webviewer|combobox|multi-select|drag-ghost|loader-spinner|empty-state|messageBar|editorUndoBar|HyperMD|inline-title|is-floating|mobile-navbar|mobile-tab|vertical-tab|horizontal-tab|document-search|is-phone|is-tablet|is-mobile|popout|translucent|drag-reorder|file-tree|bases-|help-options|open-vault|slides|pele|\.dialog|combobox-button|multi-select-input|radioButton|choiceWidgetAnnotation|textWidgetAnnotation|buttonWidgetAnnotation|attachment/;
const COMP_KEEP_PART = /\.modal|setting-item|setting-title|text-input|textarea|dropdown|checkbox|clickable-icon|svg-icon|button|input|select/;
// 纯元素/通配锚定的选择器部分（input[type=…]:hover、select、*、h2、code…）
const ELEMENT_PART = /^(html|body|\*|h[1-6]|p|a|ul|ol|li|code|pre|table|thead|tbody|tr|th|td|img|kbd|hr|strong|em|b|i|small|span|label|blockquote|figure|figcaption|input|select|textarea|button|option)([.:[]|$)/;
const keepPart = (part) => {
	const p = part.trim();
	if (!p) return false;
	if (p.indexOf(".semlink-") !== -1 || p.indexOf(".smart-vault") !== -1) return false;
	// :root 与主题类（.theme-light/.theme-dark）是主题变量的主载体，
	// 必须保留（--background-modifier-border/--input-shadow 等都挂在这）。
	if (p.indexOf(":root") === 0 || /\.theme-(light|dark)\b/.test(p)) return true;
	if (APP_AREA_PART.test(p)) return false;
	if (p === "*" || p.indexOf("*") === 0) return true;
	if (ELEMENT_PART.test(p)) return true;
	return COMP_KEEP_PART.test(p);
};
const keepRule = (txt) => {
	const sel = txt.split("{")[0];
	return sel.split(",").some((part) => keepPart(part));
};
// html/body 整元素规则丢弃：真机 body 的 overflow:hidden、position 等布局
// 重属性会破坏审查页自身滚动（页面变量走 vars 段，不受影响）。
// 但含自定义属性的规则必须保留——--input-height / --background-modifier-border
// 等一大批关键变量恰恰定义在 body 上（丢了它们 plugin 规则的
// var() 声明整条失效，就是"边框变黑/高度不一致"的元凶）。
const dropPageLayout = (txt) => {
	if (/--[a-zA-Z][\w-]*\s*:/.test(txt)) return false;
	const sel = txt.split("{")[0];
	return sel.split(",").every((p) => { const t = p.trim(); return t === "html" || t === "body"; });
};
const filterRules = (arr) => {
	const seen = new Set();
	const out = [];
	for (const { g, t: txt } of arr) {
		if (!keepRule(txt) || seen.has(txt) || dropPageLayout(txt)) continue;
		seen.add(txt);
		// 还原所在 @media/@supports 上下文（逐层包裹；同条件重复包裹语义等价）
		let body = txt;
		for (let i = g.length - 1; i >= 0; i--) body = `${g[i]}${body}}`;
		out.push(body);
	}
	return out;
};
const baseVars = filterRules(assets.vars).join("\n");
const baseComp = filterRules(assets.comp).join("\n");

const reviewCss = `
/* ── 审查页自身（非插件样式） ── */
html, body { margin: 0; padding: 0; }
body.rv { background: var(--background-primary); color: var(--text-normal); font-family: var(--font-interface, -apple-system, "Segoe UI", system-ui, sans-serif); font-size: 14px; }
.rv-topbar { position: fixed; top: 0; left: 0; right: 0; height: 48px; z-index: 50; display: flex; align-items: center; gap: 12px; padding: 0 16px; background: var(--background-secondary); border-bottom: 1px solid var(--background-modifier-border); }
.rv-topbar strong { font-size: 15px; }
.rv-topbar .rv-gen-note { color: var(--text-faint); font-size: 12px; }
.rv-topbar button { margin-left: auto; }
.rv-sidebar { position: fixed; top: 48px; left: 0; bottom: 0; width: 235px; overflow: auto; padding: 12px 10px 40px; background: var(--background-secondary); border-right: 1px solid var(--background-modifier-border); }
.rv-sidebar .rv-group-title { font-size: 11px; font-weight: 600; color: var(--text-faint); text-transform: uppercase; letter-spacing: 0.05em; margin: 14px 8px 4px; }
.rv-sidebar a { display: block; padding: 4px 8px; border-radius: 6px; color: var(--text-muted); text-decoration: none; font-size: 12.5px; }
.rv-sidebar a:hover { background: var(--background-modifier-hover); color: var(--text-normal); }
.rv-main { margin: 48px 0 0 235px; padding: 20px 28px 80px; }
.rv-section { margin-bottom: 48px; }
.rv-sec-head h2 { margin: 0 0 4px; font-size: 17px; color: var(--text-normal); }
.rv-meta { color: var(--text-muted); font-size: 12px; display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; }
.rv-meta code { background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: 4px; padding: 1px 5px; font-size: 11px; }
.rv-note { color: var(--text-faint); font-size: 12px; margin: 6px 0 0; }
.rv-stage { position: relative; z-index: 0; margin-top: 12px; border: 1px solid var(--background-modifier-border); border-radius: 10px; overflow: hidden; background: var(--background-secondary); }
/* 静态化弹窗容器：去掉 fixed 全屏，改为流内卡片 */
.modal-container.rv-static { position: relative; inset: auto; display: block; overflow: visible; height: auto; min-height: 120px; padding: 26px 0; }
.modal-container.rv-static .modal { margin: 0 auto; }
/* 锚定弹层静态化：去 fixed/悬浮层级，改为流内卡片（基础规则 position:fixed + z-index:9999） */
.rv-stage .semlink-search-depth-popup { position: static; z-index: auto; width: max-content; max-width: 100%; margin: 0 auto; }
.rv-missing-icon { color: var(--text-error); font-weight: 600; }
`;

// ── 页面组装 ──
const groups = [...new Set(sections.map((s) => s.group))];
const navHtml = groups
	.map((g) => {
		const items = sections
			.filter((s) => s.group === g)
			.map((s) => `<a href="#${s.id}">${s.name.replace(/ /g, "&nbsp;")}</a>`)
			.join("\n");
		return `<div class="rv-group-title">${g}</div>\n${items}`;
	})
	.join("\n");

const sectionsHtml = sections
	.map((s) => {
		const body = s.b();
		const inner = s.pop
			? s.mcls
				? `<div class="${s.mcls}">${body}</div>`
				: body
			: `<div class="modal-container mod-dim rv-static">
			<div class="modal-bg" style="opacity: 0.85;"></div>
			<div class="modal${s.mcls ? " " + s.mcls : ""}">
				${closeChrome}${s.header ? titleHeader(s.header[0]) : ""}
				<div class="modal-content">${body}</div>
			</div>
		</div>`;
		return `
<section class="rv-section" id="${s.id}">
	<header class="rv-sec-head">
		<h2>${s.name}</h2>
		<div class="rv-meta">
			<code>${s.file}</code>
			<span>入口：${s.entry}</span>
			${s.mcls ? `<span>类：<code>${s.mcls}</code></span>` : `<span>modalEl 类：（无）</span>`}
		</div>
		<p class="rv-note">${s.pop ? "锚定弹层（fixed 定位挂 body，此处静态化展示）" : s.header ? "标题栏（titleEl）" : "无标题栏（正文自带 h2/h3 标题）"} · 生成器 gen_modal_review.mjs · 样式 = Obsidian 实测基础样式 + styles.css 原样内联</p>
	</header>
	<div class="rv-stage">
		${inner}
	</div>
</section>`;
	})
	.join("\n");

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Semlink 弹窗样式审查（${manifest.version}）</title>
<style>
/* ═══ 1. Obsidian 基础变量（:root/body/theme-light/theme-dark，运行时实测导出） ═══ */
${baseVars}
/* ═══ 2. Obsidian 基础组件样式（modal/setting/button/input/…，运行时实测导出） ═══ */
${baseComp}
/* ═══ 3. Semlink 插件 styles.css（原样内联） ═══ */
${stylesCss}
/* ═══ 4. 审查页自身 ═══ */
${reviewCss}
</style>
</head>
<body class="rv theme-light">
<div class="rv-topbar">
	<strong>Semlink 弹窗样式审查</strong>
	<span class="rv-gen-note">v${manifest.version} · ${sections.length} 个渲染态 · 生成于 ${new Date().toISOString().slice(0, 16).replace("T", " ")} · 样式保真：Obsidian 运行时导出 + styles.css 内联</span>
	<button id="rv-theme-toggle" onclick="rvToggleTheme()">🌙 深色</button>
</div>
<nav class="rv-sidebar">
${navHtml}
</nav>
<main class="rv-main">
<p style="color:var(--text-muted);max-width:70em">用途：逐个对照全项目弹窗的样式一致性（标题栏 / 内边距 / 按钮体系 / 字号层级 / 圆角 / 深浅色适配）。每个分节 = 一个 Modal 的一个渲染态；变体（同一弹窗的多状态）单独分节。<b>注意：深浅色适配以 Obsidian 真机为准，本页仅还原默认主题变量。</b></p>
${sectionsHtml}
</main>
<script>
function rvToggleTheme() {
	var dark = !document.body.classList.contains('theme-dark');
	document.body.classList.toggle('theme-dark', dark);
	document.body.classList.toggle('theme-light', !dark);
	try { localStorage.setItem('rv-theme', dark ? 'dark' : 'light'); } catch (e) {}
	var b = document.getElementById('rv-theme-toggle');
	if (b) b.textContent = dark ? '☀️ 浅色' : '🌙 深色';
}
try {
	if (localStorage.getItem('rv-theme') === 'dark') rvToggleTheme();
} catch (e) {}
</script>
</body>
</html>
`;

writeFileSync(join(HERE, "modal-review.html"), html);
console.log(
	`OK: scripts-dev/modal-review.html (${(html.length / 1024).toFixed(0)} KB, ${sections.length} sections, ${Object.keys(LOGOS).length} logos, zh keys ${zh.size})`,
);
