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

/** Strip Semlink's inline citation markers from rendered markdown text
 *  nodes (skipping code/links). Two forms exist: `[n]` and `[n:Lline]`.
 *  `stripPlain` controls whether bare `[n]` goes too — note shares keep
 *  those (a user's footnote may look exactly like that), while `[n:Lline]`
 *  is unambiguous plugin output and always goes. */
function stripCitationMarkers(wrap: HTMLElement, stripPlain: boolean): void {
	// `[n]` and `[n:Lline]` / `[n:Lline-Lline]` (ranges; the model sometimes
	// cites a span, with or without the second "L"). `(?:[\u2010\u2011-]L?\d+)*`
	// absorbs every span shape seen so far, incl. missing second "L" and
	// PDF-copy hyphens (U+2010/U+2011) — 2026-11-13.
	const re = stripPlain ? /\[\d{1,3}(?::L\d+(?:[\u2010\u2011-]L?\d+)*)?\]/ : /\[\d{1,3}:L\d+(?:[\u2010\u2011-]L?\d+)*\]/;
	const walker = document.createTreeWalker(wrap, NodeFilter.SHOW_TEXT, {
		acceptNode: (node) => {
			const parent = node.parentElement;
			if (!parent) return NodeFilter.FILTER_REJECT;
			const tag = parent.tagName;
			if (tag === "CODE" || tag === "PRE" || tag === "A") return NodeFilter.FILTER_REJECT;
			return re.test(node.nodeValue ?? "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
		},
	});
	const marked: Text[] = [];
	while (walker.nextNode()) marked.push(walker.currentNode as Text);
	// The replace eats one leading whitespace with the marker, so stripping
	// doesn't leave double spaces behind.
	const replaceRe = new RegExp("\\s?" + re.source, "g");
	for (const node of marked) {
		node.nodeValue = (node.nodeValue ?? "").replace(replaceRe, "");
	}
}

/**
 * Render a (possibly very long) markdown document in chunks, yielding to the
 * UI between chunks — a single MarkdownRenderer.render call on a multi-
 * thousand-line note blocks the main thread for seconds and freezes the
 * editor. Chunks split at blank lines outside code fences (a blank line is
 * always a block boundary, so lists/tables/code stay intact) and land in the
 * SAME bubble container, so the page shows one continuous document.
 */
export async function renderMarkdownChunked(
	app: App,
	markdown: string,
	component: Component,
	onProgress?: (done: number, total: number) => void,
): Promise<string> {
	const chunks = splitMarkdownChunks(markdown, 80);
	const holder = createDiv({ cls: "semlink-share-offscreen" });
	document.body.appendChild(holder);
	const htmls: string[] = [];
	try {
		for (let i = 0; i < chunks.length; i++) {
			const wrap = holder.createDiv({ cls: "answer markdown-rendered" });
			await MarkdownRenderer.render(app, chunks[i], wrap, "", component);
			// Note text may embed saved chat answers — always drop the
			// unambiguous [n:Lline] markers (bare [n] stays: footnotes).
			stripCitationMarkers(wrap, false);
			htmls.push(wrap.innerHTML);
			wrap.remove();
			onProgress?.(i + 1, chunks.length);
			// Let the editor breathe between chunks (time-slice, same pattern
			// as the sync-fallback vector scan).
			if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 0));
		}
	} finally {
		holder.remove();
	}
	return htmls.join("");
}

/** Split into ≤`targetLines` chunks at blank lines outside code fences. */
function splitMarkdownChunks(text: string, targetLines: number): string[] {
	const lines = text.split("\n");
	const out: string[] = [];
	let buf: string[] = [];
	let inFence = false;
	for (const line of lines) {
		if (/^\s*```/.test(line)) inFence = !inFence;
		buf.push(line);
		if (!inFence && line.trim() === "" && buf.length >= targetLines) {
			out.push(buf.join("\n"));
			buf = [];
		}
	}
	if (buf.length > 0) out.push(buf.join("\n"));
	return out.length > 0 ? out : [text];
}

export async function renderSharePage(
	app: App,
	messages: HistoryMessage[],
	title: string,
	component: Component,
	theme: ShareTheme = "light",
	/** When the user triggered the share (ms epoch) — the page timestamp is
	 *  the SHARE moment, not the moment a visitor re-opens it. */
	sharedAt: number = Date.now(),
	/** Pre-rendered markdown bubble for a SINGLE-assistant-message share
	 *  (note sharing): skips the render loop below — long notes come in
	 *  through renderMarkdownChunked so the editor never freezes. */
	preRenderedHtml?: string,
): Promise<string> {
	const esc = (s: string): string =>
		s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	const holder = createDiv({ cls: "semlink-share-offscreen" });
	document.body.appendChild(holder);
	const parts: string[] = [];
	try {
		if (preRenderedHtml !== undefined) {
			// Citation stripping does NOT apply to notes: [1] in a note is
			// footnote/link syntax the author wrote, not model output.
			parts.push(`<div class="msg assistant"><div class="bubble md">${preRenderedHtml}</div></div>`);
		} else {
			for (const m of messages) {
				if (m.role === "user") {
					parts.push(`<div class="msg user"><div class="bubble">${esc(m.content)}</div></div>`);
					continue;
				}
				const wrap = holder.createDiv({ cls: "answer markdown-rendered" });
				await MarkdownRenderer.render(app, m.content, wrap, "", component);
				// Shared pages stay clean: no thinking transcript, no inline
				// citation markers ([n] / [n:Lline] — the sources live in the
				// vault, not here).
				stripCitationMarkers(wrap, true);
				parts.push(`<div class="msg assistant"><div class="bubble md">${wrap.innerHTML}</div></div>`);
				wrap.remove();
			}
		}
	} finally {
		holder.remove();
	}
	const safeTitle = esc(title);
	const day = new Date(sharedAt);
	const pad = (n: number): string => String(n).padStart(2, "0");
	const dateLabel = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())} ${pad(day.getHours())}:${pad(day.getMinutes())}:${pad(day.getSeconds())}`;
	// The labels are embedded per-language so a ?lang=.. in the URL always
	// finds its strings, even after this plugin's own UI language changed.
	const ui = {
		cta: allLangs("shareDownloadCta"),
		meta: allLangs("shareFooter"),
		slogan: allLangs("shareBrandSub"),
		top: allLangs("shareBackTop"),
		toc: allLangs("shareToc"),
		fsMinus: allLangs("shareFontMinus"),
		fsPlus: allLangs("shareFontPlus"),
		ask: allLangs("shareAsk"),
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
	// 大纲显隐按钮图标（lucide list）
	const tocIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/></svg>';
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
/* 字号缩放（字号+/− 按钮）：只改字号不改卡片宽度——字号挂在 .thread 上
   （见 .thread 规则），pre 的 13px 同步换算成 em 跟随缩放；右侧大纲是
   fixed 定位在卡片外，不受影响 */
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
/* 大纲显隐 / 字号± 按钮复用 theme-btn 的圆钮外观；关闭态半透明示弱 */
.pc-head .theme-btn.is-off{opacity:.4}
.pc-head .fs-btn{font-weight:650;font-size:12px;letter-spacing:.5px}

/* ── 底部悬浮"向 Semlink 提问"：品牌渐变胶囊，水平居中于页面底部
   （用户拍板），点击跳插件安装页 ── */
.ask-fab{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:60;display:inline-flex;align-items:center;gap:8px;padding:11px 18px;border-radius:999px;background:linear-gradient(135deg,#8b6cef,#6745d9);color:#fff;text-decoration:none;font-size:13.5px;font-weight:600;box-shadow:0 6px 18px -6px rgba(103,69,217,.55);transition:transform .15s ease,box-shadow .15s ease}
.ask-fab:hover{transform:translateX(-50%) translateY(-2px);box-shadow:0 10px 24px -8px rgba(103,69,217,.65)}
.ask-fab svg{width:16px;height:16px;flex:none;color:#fff}
@media(max-width:620px){.ask-fab{bottom:14px;padding:10px 14px;font-size:13px}}

/* ── Card body: title, stamp, thread ── */
.pc-body{position:relative;padding:10px 36px 10px}
.head{margin:0 0 20px;padding:4px 0 18px;border-bottom:1px dashed var(--line)}
.head h1{font-size:23px;line-height:1.35;margin:0 0 8px;font-weight:700;color:var(--brand-ink)}
.head .meta{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted)}
.head .meta .dot{width:3px;height:3px;border-radius:50%;background:var(--faint)}



/* ── Thread ── */
/* 字号+/− 只缩放文字：字号挂 thread 根，气泡内 em 尺寸跟随；宽度不变 */
.thread{display:flex;flex-direction:column;gap:16px;font-size:calc(15px * var(--fs,1))}
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
.msg.assistant .bubble.md pre{background:var(--code-bg);padding:13px 15px;border-radius:10px;overflow:auto;font-size:.865em;border:1px solid var(--line-soft)}
html[data-theme="dark"] .msg.assistant .bubble.md pre{color:#c9cdd6}
.msg.assistant .bubble.md code{background:var(--code-bg);color:var(--code-ink);padding:1.5px 6px;border-radius:5px;font-size:.92em}
.msg.assistant .bubble.md pre code{background:none;color:inherit;padding:0}
.msg.assistant .bubble.md blockquote{margin:.6em 0;padding:.1em 0 .1em 12px;border-left:3px solid var(--quote-line);color:var(--quote-ink)}
.msg.assistant .bubble.md table{border-collapse:collapse;max-width:100%;font-size:.95em;margin:.7em 0}
.msg.assistant .bubble.md th{background:var(--table-head)}
.msg.assistant .bubble.md td,.msg.assistant .bubble.md th{border:1px solid var(--table-line);padding:6px 10px;text-align:left}
.msg.assistant .bubble.md hr{border:none;border-top:1px solid var(--line);margin:1.2em 0}
/* 图片不撑破卡片：限宽 + 自适应高度 + 圆角 */
.msg .bubble img{max-width:100%;height:auto;border-radius:8px}
.msg .bubble video,.msg .bubble iframe{max-width:100%}

/* ── Card foot: postcard sign-off above the dashed mid-line ── */
.pc-foot{display:flex;align-items:center;justify-content:center;gap:9px;margin:26px 36px 0;padding:16px 2px 22px;border-top:1px dashed var(--line);font-size:12.5px;color:var(--faint)}
.pc-foot .foot-logo{width:20px;height:20px;flex:none;color:var(--brand)}

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

/* ── Outline (TOC): fixed rail right of the postcard on wide screens ── */
.toc{display:none}
@media(min-width:1360px){
	.toc.has-toc{display:block;position:fixed;left:calc(50% + 440px);top:72px;width:240px;max-height:calc(100vh - 140px);overflow:auto;font-size:12.5px;line-height:1.5;padding:2px 0 2px 2px}
}
/* 大纲显隐按钮（访问者本地偏好，存 localStorage，不进分享 URL）：
   宽屏默认显示，toc-off 隐藏；窄屏（<1360px）大纲栏无常规落点，
   点按钮以右侧覆盖层强制显示（toc-force），不挤占卡片布局 */
html.toc-off .toc{display:none !important}
/* toc-force（窄屏点按钮强制显示）：不再一律悬浮压在卡片上——卡片两侧
   各有 (100vw-840)/2 的余量，目录宽度自适应缩进右缘余量（用户拍板
   "明明左边还有大量空白，右侧目录不要悬浮"）。余量 < ~150px（窗口
   <~1140）时 clamp 触底 120px，才真正覆盖卡片（极窄屏无解，保底可用）。 */
html.toc-force .toc.has-toc{display:block;position:fixed;right:16px;left:auto;top:72px;width:clamp(120px,calc((100% - 840px)/2 - 32px),240px);max-height:calc(100vh - 140px);overflow:auto;font-size:12.5px;line-height:1.5;padding:2px 8px;background:var(--card);border:1px solid var(--line);border-radius:12px;box-shadow:0 12px 32px -12px rgba(15,23,42,.25);z-index:50}
.toc-top{display:flex;align-items:center;gap:6px;padding:6px 10px 8px;margin-bottom:6px;border-bottom:1px dashed var(--line);color:var(--muted);text-decoration:none;cursor:pointer;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.toc-top svg{width:13px;height:13px;flex:none}
.toc-top:hover{color:var(--brand-ink)}
.toc-item{display:block;padding:4px 10px;color:var(--muted);text-decoration:none;border-left:2px solid var(--line);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-radius:0 6px 6px 0}
.toc-item:hover{color:var(--ink);background:var(--bubble)}
.toc-item.is-active{color:var(--brand-ink);border-left-color:var(--brand);font-weight:600;background:linear-gradient(90deg,rgba(139,108,239,.09),transparent)}
.toc-h1{font-weight:600;color:var(--ink)}
.toc-h2{padding-left:16px}
.toc-h3{padding-left:28px}
.toc-h4{padding-left:40px;font-size:12px}
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
<button class="theme-btn" id="tocToggle" data-ui-title="toc" aria-label="Outline" title="Outline" style="display:none">${tocIcon}</button>
<button class="theme-btn" id="fsMinus" data-ui-title="fsMinus" aria-label="Smaller text" title="Smaller text"><span class="fs-btn">A−</span></button>
<button class="theme-btn" id="fsPlus" data-ui-title="fsPlus" aria-label="Larger text" title="Larger text"><span class="fs-btn">A+</span></button>
<button class="theme-btn" id="themeToggle" aria-label="Toggle theme"><span id="themeIconMoon" style="display:inline-flex">${moonIcon}</span><span id="themeIconSun" style="display:inline-flex">${sunIcon}</span></button>
</nav>
</header>
<div class="pc-body">
<section class="head"><h1>${safeTitle}</h1><div class="meta"><span>${dateLabel}</span><span class="dot"></span><span data-ui="meta">${esc(t("shareFooter"))}</span></div></section>
<div class="thread">
${parts.join("\n")}
</div>
</div>
<footer class="pc-foot">${logoSvg.replace("<svg ", '<svg class="foot-logo" ')}<span data-ui="slogan">${esc(t("shareBrandSub"))}</span></footer>
</div>
<nav class="toc" id="toc" aria-label="Outline"></nav>
<a class="ask-fab" href="https://community.obsidian.md/plugins/semlink" target="_blank" rel="noreferrer" data-ui="ask">${logoSvg.replace("<svg ", '<svg class="ask-logo" ')}<span>Get Semlink</span></a>
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
		/* 无文字的图标钮：title/aria 走 data-ui-title */
		document.querySelectorAll("[data-ui-title]").forEach(function (el) {
			var v = d[el.getAttribute("data-ui-title")];
			if (v) { el.title = v; el.setAttribute("aria-label", v); }
		});
	}
	applyLang(lang || "en");

	/* ── 字号 +/−：zoom 整卡等比缩放，localStorage 记住访问者偏好 ── */
	function applyFs(z) {
		document.documentElement.style.setProperty("--fs", String(z));
		var t = Math.round(z * 100) + "%";
		document.getElementById("fsPlus").title = t;
		document.getElementById("fsMinus").title = t;
	}
	function currentFs() {
		var v = 1;
		try { v = parseFloat(localStorage.getItem("semlink-fszoom") || "1") || 1; } catch (e) {}
		return Math.min(1.5, Math.max(0.7, v));
	}
	var fs = currentFs();
	applyFs(fs);
	document.getElementById("fsPlus").addEventListener("click", function () {
		fs = Math.min(1.5, Math.round((fs + 0.1) * 10) / 10);
		applyFs(fs);
		try { localStorage.setItem("semlink-fszoom", String(fs)); } catch (e) {}
	});
	document.getElementById("fsMinus").addEventListener("click", function () {
		fs = Math.max(0.7, Math.round((fs - 0.1) * 10) / 10);
		applyFs(fs);
		try { localStorage.setItem("semlink-fszoom", String(fs)); } catch (e) {}
	});

	/* ── 大纲显隐按钮（用户拍板"窄屏点击也要能出大纲"）：
	   偏好三态 on/off/null(自动)：宽屏自动显示可关；窄屏默认隐藏，
	   点按钮以右侧覆盖层强制显示（toc-force）。存 localStorage ── */
	var tocWide = window.matchMedia("(min-width: 1360px)");
	var tocPref = null;
	try {
		var savedToc = localStorage.getItem("semlink-toc");
		if (savedToc === "on" || savedToc === "off") tocPref = savedToc;
		else if (localStorage.getItem("semlink-toc-off") === "1") tocPref = "off";
	} catch (e) {}
	function tocVisible() {
		return tocWide.matches ? tocPref !== "off" : tocPref === "on";
	}
	function applyToc() {
		var wide = tocWide.matches;
		document.documentElement.classList.toggle("toc-off", wide && tocPref === "off");
		document.documentElement.classList.toggle("toc-force", !wide && tocPref === "on");
		var b = document.getElementById("tocToggle");
		if (b) b.classList.toggle("is-off", !tocVisible());
	}
	tocWide.addEventListener ? tocWide.addEventListener("change", applyToc) : tocWide.addListener(applyToc);

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

	/* ── outline (TOC): build from the document's headings, click to jump ── */
	var thread = document.querySelector(".thread");
	var toc = document.getElementById("toc");
	if (thread && toc) {
		var hs = thread.querySelectorAll("h1,h2,h3,h4");
		if (hs.length >= 3) {
			var list = document.createElement("div");
			/* back-to-top pinned above the outline */
			var topLink = document.createElement("a");
			topLink.className = "toc-top";
			topLink.href = "#";
			topLink.innerHTML = '<span data-ui="top"></span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>';
			topLink.addEventListener("click", function (e) {
				e.preventDefault();
				window.scrollTo({ top: 0, behavior: "smooth" });
			});
			toc.appendChild(topLink);
			hs.forEach(function (h, i) {
				if (!h.id) h.id = "sec-" + i;
				var a = document.createElement("a");
				a.className = "toc-item toc-" + h.tagName.toLowerCase();
				a.textContent = h.textContent;
				a.href = "#" + h.id;
				a.addEventListener("click", function (e) {
					e.preventDefault();
					h.scrollIntoView({ behavior: "smooth", block: "start" });
				});
				list.appendChild(a);
			});
			toc.appendChild(list);
			toc.classList.add("has-toc");
			/* 大纲显隐按钮：仅有大纲（≥3 个标题）时出现，初始态读偏好 */
			var tocBtn = document.getElementById("tocToggle");
			if (tocBtn) {
				tocBtn.style.display = "";
				applyToc();
				tocBtn.addEventListener("click", function () {
					tocPref = tocVisible() ? "off" : "on";
					try { localStorage.setItem("semlink-toc", tocPref); } catch (e) {}
					applyToc();
				});
			}
			/* highlight the section currently in view (last heading above the line) */
			var items = list.querySelectorAll(".toc-item");
			var updateActive = function () {
				var cur = -1;
				for (var i = 0; i < hs.length; i++) {
					if (hs[i].getBoundingClientRect().top <= 120) cur = i;
					else break;
				}
				for (var j = 0; j < items.length; j++) {
					items[j].classList.toggle("is-active", j === cur);
				}
			};
			document.addEventListener("scroll", updateActive, { passive: true });
			updateActive();
		}
	}
})();
</script>
</body></html>`;
}
