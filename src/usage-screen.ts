// ========================================
// Semlink - Usage dashboard rendering (弹窗与详情屏共用)
// ========================================
// 用量看板的唯一渲染实现：UsageModal（弹窗，历史入口）与抽屉菜单
// 「用量与统计」详情屏（search-view 渲染进 messagesEl）共用同一函数，
// 避免 UI 双份漂移。Pro 门控（模糊 + gate 升级按钮开 LicenseModal）
// 沿用弹窗时代的既定行为；免费用户的数据本就一直在本地累计，升级后
// 重渲即见全量。

import type SmartVaultPlugin from "../main";
import { LicenseModal } from "./license-modal";
import { t } from "./i18n";

/** 同一模型 id 可能挂在多个供应商下——首个带价格的命中生效（原
 *  UsageModal.priceOf 逻辑，随渲染一起搬进来）。 */
function priceOf(plugin: SmartVaultPlugin, model: string): { in: number | null; out: number | null } | null {
	for (const p of plugin.settings.providers || []) {
		for (const m of p.models || []) {
			if (m.id === model && (m.priceIn != null || m.priceOut != null)) {
				return { in: m.priceIn ?? null, out: m.priceOut ?? null };
			}
		}
	}
	return null;
}

function fmtCost(v: number | null): string {
	if (v == null) return "—";
	return v >= 100 ? `$${v.toFixed(0)}` : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`;
}

function fmtTok(n: number): string {
	return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export interface UsageDashboardOptions {
	/** 弹窗语境带 <h2> 标题；详情屏由顶条表达标题，缺省省略。 */
	withHeading?: boolean;
}

/** 把用量仪表盘渲染进 host：统计卡 + 30 天柱状图 + 按模型明细表 +
 *  清除记录入口；免费态模糊内容区并盖 Pro gate。异步取数（usageStore
 *  读盘），先 empty 再画，与原 UsageModal.render 同时序语义。 */
export function renderUsageDashboard(
	host: HTMLElement,
	plugin: SmartVaultPlugin,
	opts: UsageDashboardOptions = {},
): void {
	host.empty();
	// 内部重渲钩子：清除记录后、许可弹窗关闭后原地重建。
	const rerender = (): void => renderUsageDashboard(host, plugin, opts);

	void (async () => {
		const pro = plugin.licenseManager.isPro();
		const s = await plugin.usageStore.summary((m) => priceOf(plugin, m));
		if (!host.isConnected) return;

		if (opts.withHeading) {
			host.createEl("h2", { text: t("usageTitle") });
		}

		// ── Stat cards ──
		const cards = host.createDiv({ cls: "semlink-usage-cards" });
		const card = (value: string, label: string) => {
			const c = cards.createDiv({ cls: "semlink-usage-card" });
			c.createDiv({ cls: "semlink-usage-card-value", text: value });
			c.createDiv({ cls: "semlink-usage-card-label", text: label });
		};
		card(fmtCost(s.monthCost), t("usageThisMonth"));
		card(fmtCost(s.totalCost), t("usageTotal"));
		card(String(s.monthReqs), t("usageRequestsMonth"));
		card(`${fmtTok(s.totalIn)} → ${fmtTok(s.totalOut)}`, t("usageTokens"));

		// ── Pro gate: blur the detail area for free users ──
		const body = host.createDiv({ cls: pro ? "semlink-usage-body" : "semlink-usage-body semlink-usage-locked" });
		if (!pro) {
			const gate = body.createDiv({ cls: "semlink-usage-gate" });
			gate.createDiv({ cls: "semlink-usage-gate-title", text: t("usageProTitle") });
			gate.createDiv({ cls: "semlink-usage-gate-desc", text: t("usageProDesc") });
			const btn = gate.createEl("button", { cls: "mod-cta", text: t("unlockPro") });
			btn.addEventListener("click", () => {
				// Keep this modal mounted; when the license modal closes,
				// re-render with the fresh license state (blur drops away).
				new LicenseModal(plugin.app, plugin, () => rerender()).open();
			});
		}

		// ── 30-day chart ──
		const chartCard = body.createDiv({ cls: "semlink-usage-section" });
		chartCard.createDiv({ cls: "semlink-usage-section-title", text: t("usageLast30") });
		const chart = chartCard.createDiv({ cls: "semlink-usage-chart" });
		const useCost = s.hasAnyPrice && s.days.some((d) => (d.cost ?? 0) > 0);
		const maxVal = Math.max(1, ...s.days.map((d) => (useCost ? d.cost ?? 0 : d.tokens)));
		for (const d of s.days) {
			const v = useCost ? d.cost ?? 0 : d.tokens;
			const bar = chart.createDiv({ cls: "semlink-usage-bar" });
			bar.style.height = `${Math.max(2, Math.round((v / maxVal) * 100))}%`;
			bar.setAttribute("aria-label", `${d.label}: ${useCost ? fmtCost(d.cost) : fmtTok(d.tokens)}`);
		}

		// ── Per-model table ──
		const tableCard = body.createDiv({ cls: "semlink-usage-section" });
		tableCard.createDiv({ cls: "semlink-usage-section-title", text: t("usageByModel") });
		if (s.models.length === 0) {
			tableCard.createDiv({ cls: "semlink-usage-empty", text: t("usageEmpty") });
		} else {
			const table = tableCard.createEl("table", { cls: "semlink-usage-table" });
			const head = table.createEl("tr");
			for (const h of [t("usageModel"), t("usageReqs"), t("usageTokensIn"), t("usageTokensOut"), t("usageCost")]) {
				head.createEl("th", { text: h });
			}
			for (const m of s.models) {
				const row = table.createEl("tr");
				row.createEl("td", { text: m.model });
				row.createEl("td", { text: String(m.reqs) });
				row.createEl("td", { text: fmtTok(m.inTok) });
				row.createEl("td", { text: fmtTok(m.outTok) });
				row.createEl("td", { cls: "semlink-usage-cost", text: fmtCost(m.cost) });
			}
		}
		if (!s.hasAnyPrice && s.models.length > 0) {
			tableCard.createDiv({ cls: "semlink-usage-hint", text: t("usageNoPrice") });
		}
	})();
}
