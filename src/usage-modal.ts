// ========================================
// Semlink - Usage & Cost Dashboard (Pro)
// ========================================
// TypingMind-style usage overview: totals, per-model breakdown and a 30-day
// chart, computed from the local UsageStore. Token recording runs for ALL
// users (their own local data); the dashboard view is Pro-gated — free users
// see a blurred teaser + upgrade entry, and their data is already accruing
// for the day they upgrade.

import { App, Modal, Setting } from "obsidian";
import type SmartVaultPlugin from "../main";
import { t } from "./i18n";
import { LicenseModal } from "./license-modal";

export class UsageModal extends Modal {
	private plugin: SmartVaultPlugin;

	constructor(app: App, plugin: SmartVaultPlugin) {
		super(app);
		this.plugin = plugin;
		this.modalEl.addClass("semlink-usage-modal");
	}

	onOpen() {
		void this.render();
	}

	onClose() {
		this.contentEl.empty();
	}

	private priceOf(model: string): { in: number | null; out: number | null } | null {
		// The same model id may exist under several providers — first hit wins.
		for (const p of this.plugin.settings.providers || []) {
			for (const m of p.models || []) {
				if (m.id === model && (m.priceIn != null || m.priceOut != null)) {
					return { in: m.priceIn ?? null, out: m.priceOut ?? null };
				}
			}
		}
		return null;
	}

	private fmtCost(v: number | null): string {
		if (v == null) return "—";
		return v >= 100 ? `$${v.toFixed(0)}` : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`;
	}

	private fmtTok(n: number): string {
		return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
	}

	private async render(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		const pro = this.plugin.licenseManager.isPro();
		const s = await this.plugin.usageStore.summary((m) => this.priceOf(m));

		contentEl.createEl("h2", { text: t("usageTitle") });

		// ── Stat cards ──
		const cards = contentEl.createDiv({ cls: "semlink-usage-cards" });
		const card = (value: string, label: string) => {
			const c = cards.createDiv({ cls: "semlink-usage-card" });
			c.createDiv({ cls: "semlink-usage-card-value", text: value });
			c.createDiv({ cls: "semlink-usage-card-label", text: label });
		};
		card(this.fmtCost(s.monthCost), t("usageThisMonth"));
		card(this.fmtCost(s.totalCost), t("usageTotal"));
		card(String(s.monthReqs), t("usageRequestsMonth"));
		card(`${this.fmtTok(s.totalIn)} → ${this.fmtTok(s.totalOut)}`, t("usageTokens"));

		// ── Pro gate: blur the detail area for free users ──
		const body = contentEl.createDiv({ cls: pro ? "semlink-usage-body" : "semlink-usage-body semlink-usage-locked" });
		if (!pro) {
			const gate = body.createDiv({ cls: "semlink-usage-gate" });
			gate.createDiv({ cls: "semlink-usage-gate-title", text: t("usageProTitle") });
			gate.createDiv({ cls: "semlink-usage-gate-desc", text: t("usageProDesc") });
			const btn = gate.createEl("button", { cls: "mod-cta", text: t("unlockPro") });
			btn.addEventListener("click", () => {
				// Keep this modal mounted; when the license modal closes,
				// re-render with the fresh license state (blur drops away).
				new LicenseModal(this.app, this.plugin, () => void this.render()).open();
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
			bar.setAttribute("aria-label", `${d.label}: ${useCost ? this.fmtCost(d.cost) : this.fmtTok(d.tokens)}`);
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
				row.createEl("td", { text: this.fmtTok(m.inTok) });
				row.createEl("td", { text: this.fmtTok(m.outTok) });
				row.createEl("td", { cls: "semlink-usage-cost", text: this.fmtCost(m.cost) });
			}
		}
		if (!s.hasAnyPrice && s.models.length > 0) {
			tableCard.createDiv({ cls: "semlink-usage-hint", text: t("usageNoPrice") });
		}

		// ── Footer ──
		new Setting(contentEl)
			.setName(t("usageClear"))
			.addButton((btn) =>
				btn.setButtonText(t("usageClearBtn")).onClick(async () => {
					await this.plugin.usageStore.clear();
					this.render();
				})
			);
	}
}
