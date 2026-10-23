// ========================================
// Semlink - Share page renderer
// ========================================
// Renders a conversation into a self-contained HTML page: user messages as
// text, assistant answers through Obsidian's markdown renderer (rendered
// off-screen), thinking steps folded into <details>. No external resources —
// the LAN page must open without internet access.
//
// The page is styled as a POSTCARD: one floating card on a warm paper
// background, a postage-stamp logo top-right, dashed mid-lines, and a
// sign-off footer.
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
			const wrap = holder.createDiv({ cls: "answer markdown-rendered" });
			await MarkdownRenderer.render(app, m.content, wrap, "", component);
			// Shared pages stay clean: no thinking transcript, no inline [n]
			// citation markers (the sources live in the vault, not here).
			const walker = document.createTreeWalker(wrap, NodeFilter.SHOW_TEXT, {
				acceptNode: (node) => {
					const parent = node.parentElement;
					if (!parent) return NodeFilter.FILTER_REJECT;
					const tag = parent.tagName;
					if (tag === "CODE" || tag === "PRE" || tag === "A") return NodeFilter.FILTER_REJECT;
					return /\[\d{1,3}\]/.test(node.nodeValue ?? "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
				},
			});
			const marked: Text[] = [];
			while (walker.nextNode()) marked.push(walker.currentNode as Text);
			for (const node of marked) {
				node.nodeValue = (node.nodeValue ?? "").replace(/\s?\[\d{1,3}\]/g, "");
			}
			parts.push(`<div class="msg assistant"><div class="bubble md">${wrap.innerHTML}</div></div>`);
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
		cta: allLangs("shareDownloadCta"),
		meta: allLangs("shareFooter"),
		footer: allLangs("shareFooter"),
	} as Partial<Record<string, Partial<Record<string, string>>>>;
	const uiJson = JSON.stringify(ui).replace(/</g, "\\u003c");
	// Inline SVG favicon (brand purple) — no external request, works on the
	// LAN; Safari ignores SVG favicons and simply shows its default icon.
	const favicon = "data:image/svg+xml," + encodeURIComponent(
		logoSvg.replace("<svg ", '<svg color="#8b6cef" '),
	);
	// Sun/moon toggle + download icons, inlined like everything else.
	const moonIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
	const sunIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
	const downloadIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
	const css = `
:root{color-scheme:light}
*{box-sizing:border-box}
:root{
	--page:#eae7e0;--card:#ffffff;--ink:#0f172a;--muted:#64748b;--faint:#94a3b8;
	--line:#e5e1d8;--line-soft:#eef1f6;--brand:#8b6cef;--brand-dark:#6745d9;--brand-ink:#6745d9;
	--code-bg:#f6f7fa;--code-ink:#4338ca;--quote-line:#d9d2f5;--quote-ink:#475569;
	--table-line:#e6e9f0;--table-head:#f8f9fc;--bubble:#f7f8fa;
}
html[data-theme="dark"]{
	color-scheme:dark;
	--page:#101014;--card:#232329;--ink:#e8e8ec;--muted:#8b8fa0;--faint:#6b6f7e;
	--line:#2c2c34;--line-soft:#26262d;--brand:#8b6cef;--brand-dark:#a98ef2;--brand-ink:#b3a0f5;
	--code-bg:#1d1d24;--code-ink:#c4b5fd;--quote-line:#3d3a52;--quote-ink:#a6a4b8;
	--table-line:#2c2c34;--table-head:#1d1d24;--bubble:#2a2a31;
}
body{margin:0;padding:40px 14px 60px;font:15px/1.7 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--ink);background:var(--page)}

/* ── The postcard: one floating card, generous radius, soft layered shadow ── */
.postcard{position:relative;max-width:840px;margin:0 auto;background:var(--card);border:1px solid var(--line);border-radius:22px;box-shadow:0 1px 2px rgba(15,23,42,.04),0 12px 28px -12px rgba(15,23,42,.10),0 32px 72px -32px rgba(15,23,42,.16)}

/* ── Card head: brand left, theme toggle + install right ── */
.pc-head{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:18px 36px 0}

.pc-head .brand-row{display:flex;align-items:center;gap:7px}
.pc-head .brand-logo{width:20px;height:20px;flex:none;color:var(--brand)}
.pc-head .brand-name{font-weight:700;font-size:13.5px;letter-spacing:.2px;color:var(--ink)}





.pc-head nav{display:flex;align-items:center;gap:.7rem;flex:none}
.pc-head .theme-btn{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;padding:0;border:none;cursor:pointer;border-radius:50%;background:transparent;color:var(--muted)}
.pc-head .theme-btn:hover{background:rgba(139,108,239,.14);color:var(--brand)}
html[data-theme="dark"] .pc-head .theme-btn{color:var(--faint)}
html[data-theme="dark"] .pc-head .theme-btn:hover{color:var(--brand);background:rgba(139,108,239,.18)}
.pc-head .theme-btn svg{width:17px;height:17px}
/* Install CTA: the APP ICON itself — brand-purple squircle with the white
   Semlink cube, reading as "the app you can get", not a file download. */
.pc-head .cta{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;padding:0;border:none;cursor:pointer;text-decoration:none;border-radius:50%;background:transparent;color:var(--muted);flex:none}
.pc-head .cta:hover{background:rgba(139,108,239,.14);color:var(--brand)}
.pc-head .cta svg{width:19px;height:19px}

/* ── Card body: title, stamp, thread ── */
.pc-body{position:relative;padding:10px 36px 10px}
.head{margin:0 0 20px;padding:4px 0 18px;border-bottom:1px dashed var(--line)}
.head h1{font-size:23px;line-height:1.35;margin:0 0 8px;font-weight:700;color:var(--brand-ink)}
.head .meta{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted)}
.head .meta .dot{width:3px;height:3px;border-radius:50%;background:var(--faint)}



/* ── Thread ── */
.thread{display:flex;flex-direction:column;gap:16px}
.msg{display:flex}
.msg.user{justify-content:flex-end}
.msg.user .bubble{background:linear-gradient(135deg,#8b6cef,#6745d9);color:#fff;border-radius:16px 16px 5px 16px;padding:11px 15px;max-width:82%;white-space:pre-wrap;word-break:break-word;font-weight:500;box-shadow:0 3px 12px rgba(103,69,217,.22)}
.msg.assistant{flex-direction:column}
.msg.assistant .bubble{background:var(--bubble);border:1px solid var(--line);border-radius:5px 16px 16px 16px;padding:18px 20px;overflow-wrap:break-word}

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

/* ── Card foot: postcard sign-off above the dashed mid-line ── */
.pc-foot{display:flex;align-items:center;justify-content:center;gap:9px;margin:26px 36px 0;padding:16px 2px 22px;border-top:1px dashed var(--line);font-size:12.5px;color:var(--faint)}
.pc-foot .foot-logo{width:20px;height:20px;flex:none;color:var(--brand)}
.pc-foot .foot-name{font-weight:700;font-size:13.5px;color:var(--ink)}
.pc-foot .foot-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

@media(max-width:620px){
	body{padding:16px 8px 40px}
	.postcard{border-radius:16px}
	.pc-head{padding:16px 18px 0}
	.pc-body{padding:24px 18px 6px}
	.pc-foot{margin:20px 18px 0}
	h1{font-size:17px}
	.head{padding-right:0}
	.msg.user .bubble{max-width:92%}
	.msg.assistant .bubble{padding:14px 15px}
}
`;
	return `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<link rel="icon" type="image/svg+xml" href="${favicon}">
<style>${css}</style></head><body data-theme="${theme}">
<div class="postcard">
<header class="pc-head">
<div class="brand-row">${logoSvg.replace("<svg ", '<svg class="brand-logo" ')}<span class="brand-name">Semlink</span></div>
<nav>
<button class="theme-btn" id="themeToggle" aria-label="Toggle theme"><span id="themeIconMoon" style="display:inline-flex">${moonIcon}</span><span id="themeIconSun" style="display:inline-flex">${sunIcon}</span></button>
<a class="cta" href="https://community.obsidian.md/plugins/semlink" target="_blank" rel="noreferrer" aria-label="${esc(t("shareDownloadCta"))}" title="${esc(t("shareDownloadCta"))}">${downloadIcon}</a>
</nav>
</header>
<div class="pc-body">
<section class="head"><h1>${safeTitle}</h1><div class="meta"><span>${dateLabel}</span><span class="dot"></span><span data-ui="meta">${esc(t("shareFooter"))}</span></div></section>
<div class="thread">
${parts.join("\n")}
</div>
</div>
<footer class="pc-foot">${logoSvg.replace("<svg ", '<svg class="foot-logo" ')}<span class="foot-name">Semlink</span><span class="foot-text" data-ui="footer">${esc(t("shareFooter"))}</span></footer>
</div>
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
