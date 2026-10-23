// ========================================
// Semlink - Share page renderer
// ========================================
// Renders a conversation into a self-contained HTML page: user messages as
// text, assistant answers through Obsidian's markdown renderer (rendered
// off-screen), thinking steps folded into <details>. No external resources —
// the LAN page must open without internet access.
//
// Display language and color theme are LOCKED INTO the share URL
// (?lang=..&theme=..): the page embeds every language's UI labels and both
// themes, and a tiny script applies the query on load — the visitor sees
// exactly what the sharer saw. A sun/moon toggle lets the visitor flip the
// theme (updating the URL in place). No language switcher: the share is a
// snapshot of one conversation, shown in the language it was shared in.
//
// Used from two entry points: the live share button (current messages) and
// request-driven re-rendering of a persisted share URL after a restart
// (messages loaded from chat history).

import { App, Component, MarkdownRenderer } from "obsidian";
import { allLangs, t } from "./i18n";
import type { HistoryMessage } from "./types";
import logoSvg from "./semlink-logo.svg";

export type ShareTheme = "light" | "dark";

export async function renderSharePage(
	app: App,
	messages: HistoryMessage[],
	title: string,
	component: Component,
	theme: ShareTheme = "light",
): Promise<string> {
	const esc = (s: string): string =>
		s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	const holder = createDiv({ cls: "semlink-share-offscreen" });
	document.body.appendChild(holder);
	const parts: string[] = [];
	try {
		for (const m of messages) {
			if (m.role === "user") {
				parts.push(`<div class="msg user"><div class="bubble">${esc(m.content)}</div></div>`);
				continue;
			}
			let thinkHtml = "";
			if (m.thinking && m.thinking.length > 0) {
				const steps = m.thinking.map((s) => {
					if (s.type === "tool") {
						const a = (s.args ?? {}) as Record<string, unknown>;
						const briefRaw = [a.query, a.pattern, a.path, a.files]
							.find((v): v is string => typeof v === "string" && v.length > 0);
						const brief = (briefRaw ?? "").slice(0, 120);
						return `<div class="step">🔧 ${esc(s.name ?? "")}${brief ? ` — ${esc(brief)}` : ""}</div>`;
					}
					const text = (s.text ?? "").trim();
					return text ? `<div class="step">${esc(text.slice(0, 500))}</div>` : "";
				}).join("");
				thinkHtml = steps
					? `<details class="thinking"><summary data-ui="thinking">${esc(t("shareThinking"))}</summary>${steps}</details>`
					: "";
			}
			const wrap = holder.createDiv({ cls: "answer markdown-rendered" });
			await MarkdownRenderer.render(app, m.content, wrap, "", component);
			parts.push(`<div class="msg assistant">${thinkHtml}<div class="bubble md">${wrap.innerHTML}</div></div>`);
			wrap.remove();
		}
	} finally {
		holder.remove();
	}
	const safeTitle = esc(title);
	const day = new Date();
	const dateLabel = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
	// The labels are embedded per-language so a ?lang=.. in the URL always
	// finds its strings, even after this plugin's own UI language changed.
	const ui = {
		slogan: allLangs("shareBrandSub"),
		cta: allLangs("shareDownloadCta"),
		thinking: allLangs("shareThinking"),
	} as Partial<Record<string, Partial<Record<string, string>>>>;
	const uiJson = JSON.stringify(ui).replace(/</g, "\\u003c");
	// Inline SVG favicon (brand purple) — no external request, works on the
	// LAN; Safari ignores SVG favicons and simply shows its default icon.
	const favicon = "data:image/svg+xml," + encodeURIComponent(
		logoSvg.replace("<svg ", '<svg color="#8b6cef" '),
	);
	// Sun/moon toggle icons, inlined like everything else.
	const moonIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
	const sunIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
	return `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<link rel="icon" type="image/svg+xml" href="${favicon}">
<style>
:root{color-scheme:light}
*{box-sizing:border-box}
:root{
	--bg:#f6f5f2;--card:#ffffff;--ink:#0f172a;--muted:#64748b;--faint:#94a3b8;
	--line:#e8edf3;--line-soft:#eef1f6;--brand:#8b6cef;--brand-dark:#6745d9;
	--code-bg:#f1f5f9;--code-ink:#4338ca;--quote-line:#d9d2f5;--quote-ink:#475569;
	--table-line:#e2e8f0;--table-head:#f8fafc;--step-line:#e5eaf1;
}
html[data-theme="dark"]{
	color-scheme:dark;
	--bg:#17171c;--card:#232329;--ink:#e8e8ec;--muted:#8b8fa0;--faint:#6b6f7e;
	--line:#2c2c34;--line-soft:#26262d;--code-bg:#1d1d24;--code-ink:#c4b5fd;
	--quote-line:#3d3a52;--quote-ink:#a6a4b8;--table-line:#2c2c34;--table-head:#1d1d24;--step-line:#2c2c34;
}
body{margin:0;font:15px/1.7 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--ink);background:var(--bg)}
/* Warm paper background; the brand row shares it — no separate bar. */
.wrap{max-width:780px;margin:0 auto;padding:0 16px}
main{max-width:780px;margin:0 auto;padding:0 16px 48px}

/* ── Brand row: transparent, fused with the title block below ── */
header.brand{padding:18px 0 0}
header.brand .wrap{display:flex;align-items:center;gap:10px;flex-wrap:wrap;row-gap:10px}
header.brand svg{width:28px;height:28px;flex:none;color:var(--brand)}
header.brand .name{font-weight:700;font-size:19px;letter-spacing:.2px;color:var(--ink)}
header.brand .sub{font-size:12.5px;color:var(--faint);margin-left:4px;padding-left:11px;border-left:1px solid var(--line);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:1;min-width:0}
header.brand nav{margin-left:auto;display:flex;align-items:center;gap:.7rem;flex:none}
/* Day/night toggle: quiet round ghost button next to the install CTA. */
header.brand .theme-btn{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;padding:0;border:none;cursor:pointer;border-radius:50%;background:transparent;color:var(--muted)}
header.brand .theme-btn:hover{background:rgba(139,108,239,.14);color:var(--brand)}
html[data-theme="dark"] header.brand .theme-btn{color:var(--faint)}
html[data-theme="dark"] header.brand .theme-btn:hover{color:var(--brand);background:rgba(139,108,239,.18)}
header.brand .theme-btn svg{width:17px;height:17px}
/* Install CTA — the one loud element on the page. */
header.brand .cta{display:inline-flex;align-items:center;gap:.5rem;border:none;cursor:pointer;text-decoration:none;font-weight:600;font-size:.92rem;padding:.58rem 1.1rem;border-radius:.8rem;background:linear-gradient(135deg,var(--brand),var(--brand-dark));color:#fff;box-shadow:0 2px 10px rgba(103,69,217,.28);flex:none}
header.brand .cta:hover{filter:brightness(1.06)}

/* ── Conversation title block ── */
.head{margin:34px 0 22px}
h1{font-size:23px;line-height:1.35;margin:0 0 8px;font-weight:700;color:var(--ink)}
.head .meta{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted)}
.head .meta .dot{width:3px;height:3px;border-radius:50%;background:var(--faint)}

/* ── Thread ── */
.thread{display:flex;flex-direction:column;gap:16px}
.msg{display:flex}
.msg.user{justify-content:flex-end}
.msg.user .bubble{background:linear-gradient(135deg,#8b6cef,#6745d9);color:#fff;border-radius:16px 16px 5px 16px;padding:11px 15px;max-width:82%;white-space:pre-wrap;word-break:break-word;font-weight:500;box-shadow:0 3px 12px rgba(103,69,217,.22)}
.msg.assistant{flex-direction:column}
.msg.assistant .bubble{background:var(--card);border:1px solid var(--line);border-radius:5px 16px 16px 16px;padding:18px 20px;overflow-wrap:break-word;box-shadow:0 1px 3px rgba(15,23,42,.05),0 8px 24px -18px rgba(15,23,42,.12)}

/* Markdown inside an assistant bubble */
.msg.assistant .bubble.md h1,.msg.assistant .bubble.md h2{font-size:1.08em;margin:1.1em 0 .45em;color:var(--ink)}
.msg.assistant .bubble.md h3,.msg.assistant .bubble.md h4{font-size:1em;margin:1em 0 .4em;color:var(--ink)}
.msg.assistant .bubble.md p{margin:.55em 0}
.msg.assistant .bubble.md ul,.msg.assistant .bubble.md ol{margin:.55em 0;padding-left:1.4em}
.msg.assistant .bubble.md li{margin:.3em 0}
.msg.assistant .bubble.md li::marker{color:var(--brand)}
.msg.assistant .bubble.md strong{color:var(--ink)}
.msg.assistant .bubble.md a{color:var(--brand-dark)}
html[data-theme="dark"] .msg.assistant .bubble.md a{color:#b3a0f5}
.msg.assistant .bubble.md pre{background:var(--code-bg);padding:13px 15px;border-radius:10px;overflow:auto;font-size:13px;border:1px solid var(--line-soft)}
html[data-theme="dark"] .msg.assistant .bubble.md pre{color:#c9cdd6}
.msg.assistant .bubble.md code{background:var(--code-bg);color:var(--code-ink);padding:1.5px 6px;border-radius:5px;font-size:.92em}
.msg.assistant .bubble.md pre code{background:none;color:inherit;padding:0}
.msg.assistant .bubble.md blockquote{margin:.6em 0;padding:.1em 0 .1em 12px;border-left:3px solid var(--quote-line);color:var(--quote-ink)}
.msg.assistant .bubble.md table{border-collapse:collapse;max-width:100%;font-size:.95em;margin:.7em 0}
.msg.assistant .bubble.md th{background:var(--table-head)}
.msg.assistant .bubble.md td,.msg.assistant .bubble.md th{border:1px solid var(--table-line);padding:6px 10px;text-align:left}
.msg.assistant .bubble.md hr{border:none;border-top:1px solid var(--line);margin:1.2em 0}

/* Thinking steps folded inside the assistant card */
details.thinking{background:var(--code-bg);border:1px solid var(--line-soft);border-radius:10px;padding:8px 13px;margin:0 0 12px;font-size:13px;color:var(--muted)}
details.thinking summary{cursor:pointer;user-select:none;font-weight:600;color:var(--muted);list-style-position:inside}
details.thinking[open] summary{margin-bottom:2px}
details.thinking .step{padding:5px 0;border-top:1px dashed var(--step-line);line-height:1.55}

footer{max-width:780px;margin:34px auto 0;padding:16px 16px 0;text-align:center;font-size:12.5px;color:var(--faint);border-top:1px solid var(--line-soft)}

@media(max-width:620px){
	header.brand .sub{display:none}
	h1{font-size:19px}
	.msg.user .bubble{max-width:92%}
	.msg.assistant .bubble{padding:14px 15px}
}
</style></head><body data-theme="${theme}">
<header class="brand"><div class="wrap">
${logoSvg}<span class="name">Semlink</span><span class="sub" data-ui="slogan">${esc(t("shareBrandSub"))}</span>
<nav>
<button class="theme-btn" id="themeToggle" aria-label="Toggle theme"><span id="themeIconMoon" style="display:inline-flex">${moonIcon}</span><span id="themeIconSun" style="display:inline-flex">${sunIcon}</span></button>
<a class="cta" href="https://getsemlink.com/" target="_blank" rel="noreferrer" data-ui="cta">${esc(t("shareDownloadCta"))}</a>
</nav>
</div></header>
<div class="wrap">
<section class="head"><h1>${safeTitle}</h1><div class="meta"><span>${dateLabel}</span><span class="dot"></span><span>Semlink</span></div></section>
</div>
<main><div class="thread">
${parts.join("\n")}
</div></main>
<footer><span data-ui="slogan">${esc(t("shareBrandSub"))}</span> · Semlink</footer>
<script>
(function(){
	var UI = ${uiJson};
	/* ── locked display language from the share URL (?lang=..) ── */
	var params = new URLSearchParams(location.search);
	var lang = params.get("lang");
	function applyLang(l) {
		var d = l && UI[l]; if (!d) return;
		document.querySelectorAll("[data-ui]").forEach(function (el) {
			var v = d[el.getAttribute("data-ui")];
			if (v) el.textContent = v;
		});
	}
	applyLang(lang || "en");

	/* ── theme from the URL (?theme=dark), toggle flips it in place ── */
	function setTheme(t) {
		document.documentElement.setAttribute("data-theme", t);
		document.getElementById("themeIconMoon").style.display = t === "dark" ? "none" : "";
		document.getElementById("themeIconSun").style.display = t === "dark" ? "" : "none";
		params.set("theme", t);
		try { history.replaceState(null, "", location.pathname + "?" + params.toString()); } catch (e) {}
	}
	setTheme(params.get("theme") === "dark" ? "dark" : "light");
	document.getElementById("themeToggle").addEventListener("click", function () {
		setTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");
	});
})();
</script>
</body></html>`;
}
