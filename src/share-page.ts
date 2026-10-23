// ========================================
// Semlink - Share page renderer
// ========================================
// Renders a conversation into a self-contained HTML page: user messages as
// text, assistant answers through Obsidian's markdown renderer (rendered
// off-screen), thinking steps folded into <details>. No external resources —
// the LAN page must open without internet access.
//
// Used from two entry points: the live share button (current messages) and
// request-driven re-rendering of a persisted share URL after a restart
// (messages loaded from chat history).

import { App, Component, MarkdownRenderer } from "obsidian";
import { allLangs, getLang, LANGUAGES, t, type Lang } from "./i18n";
import type { HistoryMessage } from "./types";
import logoSvg from "./semlink-logo.svg";

export async function renderSharePage(
	app: App,
	messages: HistoryMessage[],
	title: string,
	component: Component,
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
	// The visitor can switch the page's OWN labels (slogan / CTA / thinking
	// summary) between all plugin languages — the conversation itself stays
	// in the language it was held in.
	const ui = {
		slogan: allLangs("shareBrandSub"),
		cta: allLangs("shareDownloadCta"),
		thinking: allLangs("shareThinking"),
	} as Partial<Record<string, Partial<Record<Lang, string>>>>;
	const uiJson = JSON.stringify(ui).replace(/</g, "\\u003c");
	const langOptions = LANGUAGES.map(
		(l) => `<option value="${l.value}"${l.value === getLang() ? " selected" : ""}>${l.label}</option>`,
	).join("");
	// Inline SVG favicon (brand purple) — no external request, works on the
	// LAN; Safari ignores SVG favicons and simply shows its default icon.
	const favicon = "data:image/svg+xml," + encodeURIComponent(
		logoSvg.replace("<svg ", '<svg color="#8b6cef" '),
	);
	return `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<link rel="icon" type="image/svg+xml" href="${favicon}">
<style>
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;font:15px/1.7 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#0f172a;background:#fff}
/* Hero band (site: linear-gradient #eff6ff→#fff) confined to the top so the
   long thread below reads on clean white. */
.hero{background:linear-gradient(180deg,#eff6ff 0%,rgba(239,246,255,0) 100%);padding:6px 16px 30px}
.wrap{max-width:780px;margin:0 auto}
main{max-width:780px;margin:0 auto;padding:6px 16px 48px}

/* ── Header bar (mirrors the getsemlink.com header): white, hairline
   bottom border, brand left; language switcher + install CTA right.
   The logo strokes use currentColor. ── */
header.brand{background:#fff;border-bottom:1px solid #e2e8f0;padding:13px 16px}
header.brand .wrap{max-width:780px;margin:0 auto;display:flex;align-items:center;gap:10px}
header.brand svg{width:30px;height:30px;flex:none;color:#8b6cef}
header.brand .name{font-weight:700;font-size:20px;letter-spacing:.2px;color:#0f172a}
header.brand .sub{font-size:12.5px;color:#94a3b8;margin-left:4px;padding-left:11px;border-left:1px solid #d7dfeb;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:1;min-width:0}
header.brand nav{margin-left:auto;display:flex;align-items:center;gap:.9rem;flex:none}
header.brand .lang-btn{border:1px solid #e2e8f0;background:#fff;color:#64748b;border-radius:999px;padding:.32rem .8rem;font-size:.85rem;cursor:pointer;font-weight:600}
header.brand .lang-btn:hover{border-color:#8b6cef;color:#8b6cef}
header.brand .cta{display:inline-flex;align-items:center;gap:.5rem;border:none;cursor:pointer;text-decoration:none;font-weight:600;font-size:.95rem;padding:.6rem 1.15rem;border-radius:.8rem;background:#8b6cef;color:#fff}
header.brand .cta:hover{background:#6745d9}

/* ── Conversation title block ── */
.head{margin:34px 0 22px}
h1{font-size:23px;line-height:1.35;margin:0 0 8px;font-weight:700;color:#0f172a}
.head .meta{display:flex;align-items:center;gap:8px;font-size:13px;color:#64748b}
.head .meta .dot{width:3px;height:3px;border-radius:50%;background:#cbd5e1}

/* ── Thread ── */
.thread{display:flex;flex-direction:column;gap:16px}
.msg{display:flex}
.msg.user{justify-content:flex-end}
.msg.user .bubble{background:linear-gradient(135deg,#8b6cef,#6745d9);color:#fff;border-radius:16px 16px 5px 16px;padding:11px 15px;max-width:82%;white-space:pre-wrap;word-break:break-word;font-weight:500;box-shadow:0 3px 12px rgba(103,69,217,.22)}
.msg.assistant{flex-direction:column}
.msg.assistant .bubble{background:#fff;border:1px solid #e8edf3;border-radius:5px 16px 16px 16px;padding:18px 20px;overflow-wrap:break-word;box-shadow:0 1px 3px rgba(15,23,42,.05),0 8px 24px -18px rgba(15,23,42,.12)}

/* Markdown inside an assistant bubble */
.msg.assistant .bubble.md h1,.msg.assistant .bubble.md h2{font-size:1.08em;margin:1.1em 0 .45em;color:#0f172a}
.msg.assistant .bubble.md h3,.msg.assistant .bubble.md h4{font-size:1em;margin:1em 0 .4em;color:#0f172a}
.msg.assistant .bubble.md p{margin:.55em 0}
.msg.assistant .bubble.md ul,.msg.assistant .bubble.md ol{margin:.55em 0;padding-left:1.4em}
.msg.assistant .bubble.md li{margin:.3em 0}
.msg.assistant .bubble.md li::marker{color:#8b6cef}
.msg.assistant .bubble.md strong{color:#0f172a}
.msg.assistant .bubble.md a{color:#6745d9}
.msg.assistant .bubble.md pre{background:#0f172a;color:#e2e8f0;padding:13px 15px;border-radius:10px;overflow:auto;font-size:13px}
.msg.assistant .bubble.md code{background:#f1f5f9;color:#4338ca;padding:1.5px 6px;border-radius:5px;font-size:.92em}
.msg.assistant .bubble.md pre code{background:none;color:inherit;padding:0}
.msg.assistant .bubble.md blockquote{margin:.6em 0;padding:.1em 0 .1em 12px;border-left:3px solid #d9d2f5;color:#475569}
.msg.assistant .bubble.md table{border-collapse:collapse;max-width:100%;font-size:.95em;margin:.7em 0}
.msg.assistant .bubble.md th{background:#f8fafc}
.msg.assistant .bubble.md td,.msg.assistant .bubble.md th{border:1px solid #e2e8f0;padding:6px 10px;text-align:left}
.msg.assistant .bubble.md hr{border:none;border-top:1px solid #e8edf3;margin:1.2em 0}

/* Thinking steps folded inside the assistant card */
details.thinking{background:#f6f8fb;border:1px solid #eef1f6;border-radius:10px;padding:8px 13px;margin:0 0 12px;font-size:13px;color:#64748b}
details.thinking summary{cursor:pointer;user-select:none;font-weight:600;color:#475569;list-style-position:inside}
details.thinking[open] summary{margin-bottom:2px}
details.thinking .step{padding:5px 0;border-top:1px dashed #e5eaf1;line-height:1.55}

footer{max-width:780px;margin:34px auto 0;padding:16px 16px 0;text-align:center;font-size:12.5px;color:#94a3b8;border-top:1px solid #eef1f6}

@media(max-width:620px){
	.hero{padding:14px 12px 22px}
	main{padding:4px 12px 40px}
	header.brand .sub{display:none}
	h1{font-size:19px}
	.msg.user .bubble{max-width:92%}
	.msg.assistant .bubble{padding:14px 15px}
}
</style></head><body>
<header class="brand"><div class="wrap">
${logoSvg}<span class="name">Semlink</span><span class="sub" data-ui="slogan">${esc(t("shareBrandSub"))}</span>
<nav><select class="lang-btn" id="langSelect" aria-label="Language">${langOptions}</select><a class="cta" href="https://getsemlink.com/" target="_blank" rel="noreferrer" data-ui="cta">${esc(t("shareDownloadCta"))}</a></nav>
</div></header>
<div class="hero"><div class="wrap">
<section class="head"><h1>${safeTitle}</h1><div class="meta"><span>${dateLabel}</span><span class="dot"></span><span>Semlink</span></div></section>
</div></div>
<main><div class="thread">
${parts.join("\n")}
</div></main>
<footer><span data-ui="slogan">${esc(t("shareBrandSub"))}</span> · Semlink</footer>
<script>
(function(){
	var UI = ${uiJson};
	var sel = document.getElementById("langSelect");
	var saved = null;
	try { saved = localStorage.getItem("semlink-share-lang"); } catch (e) {}
	function apply(lang) {
		// UI is keyed [uiElement][lang] (slogan/cta/thinking → translations).
		document.querySelectorAll("[data-ui]").forEach(function (el) {
			var table = UI[el.getAttribute("data-ui")];
			var v = table ? table[lang] : null;
			if (v) el.textContent = v;
		});
		try { localStorage.setItem("semlink-share-lang", lang); } catch (e) {}
	}
	if (saved && sel.value !== saved) { apply(saved); sel.value = saved; }
	sel.addEventListener("change", function () { apply(sel.value); });
})();
</script>
</body></html>`;
	}
