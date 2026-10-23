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
import { t } from "./i18n";
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
					? `<details class="thinking"><summary>${esc(t("shareThinking"))}</summary>${steps}</details>`
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
	return `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;padding:24px 12px 48px;font:15px/1.65 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#f6f5f2;color:#26221c}
main{max-width:760px;margin:0 auto}
header.brand{display:flex;align-items:center;gap:10px;margin-bottom:18px}
/* Mirrors the getsemlink.com header: purple logo mark (#8b6cef, --blue on
   the site) + dark bold wordmark — the logo strokes use currentColor. */
header.brand svg{width:30px;height:30px;flex:none;color:#8b6cef}
header.brand .name{font-weight:700;font-size:20px;letter-spacing:.2px;color:#0f172a}
header.brand .sub{font-size:12.5px;color:#a39c8e;margin-left:2px;padding-left:10px;border-left:1px solid #ddd8cd}
h1{font-size:19px;line-height:1.4;margin:0 0 20px;color:#5b3fa8}
.msg{margin:0 0 14px}
.msg.user{display:flex;justify-content:flex-end}
.msg.user .bubble{background:#7c5cd6;color:#fff;border-radius:14px 14px 4px 14px;padding:9px 13px;max-width:85%;white-space:pre-wrap;word-break:break-word}
.msg.assistant .bubble{background:#fff;border:1px solid #e7e2d8;border-radius:4px 14px 14px 14px;padding:12px 15px;overflow-wrap:break-word}
.msg.assistant .bubble.md h1,.msg.assistant .bubble.md h2,.msg.assistant .bubble.md h3{font-size:1.05em;margin:1em 0 .4em}
.msg.assistant .bubble.md p{margin:.5em 0}
.msg.assistant .bubble.md pre{background:#f2efe9;padding:10px;border-radius:8px;overflow:auto}
.msg.assistant .bubble.md code{background:#f2efe9;padding:1px 5px;border-radius:4px}
.msg.assistant .bubble.md pre code{background:none;padding:0}
.msg.assistant .bubble.md table{border-collapse:collapse;max-width:100%}
.msg.assistant .bubble.md td,.msg.assistant .bubble.md th{border:1px solid #ddd;padding:4px 8px}
details.thinking{margin-bottom:8px;font-size:13px;color:#7a7365}
details.thinking summary{cursor:pointer;user-select:none}
details.thinking .step{padding:3px 0;border-top:1px dashed #eee}
footer{margin-top:28px;text-align:center;font-size:12px;color:#a39c8e}
</style></head><body><main>
<header class="brand">${logoSvg}<span class="name">Semlink</span><span class="sub">${esc(t("shareBrandSub"))}</span></header>
<h1>${safeTitle}</h1>
${parts.join("\n")}
<footer>Shared from Semlink</footer>
</main></body></html>`;
}
