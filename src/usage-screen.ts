// ========================================
// Semlink - Usage dashboard rendering (弹窗与详情屏共用)
// ========================================
// DeepSeek 风格用量看板：筛选条（时间维度 × 模型）+ 三张大数字统计卡 +
// Tokens 主图（按模型 / 输入·输出两种堆叠维度）+ 按模型分区（请求次数
// 面积图 + tokens 堆叠柱）。UsageModal（弹窗）与抽屉「用量与统计」详情
// 屏共用同一渲染函数，避免 UI 双份漂移。图表本体在 usage-charts.ts
// （手写 SVG，无新依赖）。Pro 门控（模糊 + gate 升级按钮开 LicenseModal）
// 沿用弹窗时代的既定行为；免费用户的数据本就一直在本地累计，升级后
// 重渲即见全量。

import { Menu, Notice, setIcon, type MenuItem } from "obsidian";
import { writeFileSync } from "fs";
import type SmartVaultPlugin from "../main";
import { LicenseModal } from "./license-modal";
import { t } from "./i18n";
import {
	renderStackedBars,
	renderAreaChart,
	USAGE_MODEL_COLORS,
	USAGE_IN_COLOR,
	USAGE_OUT_COLOR,
	type StackBar,
} from "./usage-charts";
import type { UsageFilter, UsageRange, UsageSummary } from "./usage-store";

/** 筛选与主图堆叠维度在模块级留存：弹窗/详情屏、清除后的重渲之间保持，
 *  插件重载后回到默认（近 30 天 × 全部模型）。 */
const DEFAULT_FILTER: UsageFilter = { range: "30d", model: null };
let filter: UsageFilter = { ...DEFAULT_FILTER };
let stackMode: "model" | "inout" = "model";

function fmtNum(n: number): string {
	return n.toLocaleString("en-US");
}

function rangeLabel(range: UsageRange): string {
	switch (range) {
		case "7d": return t("usageLast7");
		case "30d": return t("usageLast30");
		case "month": return t("usageMonth");
		case "all": return t("usageAll");
	}
}

/** Obsidian Menu 锚定到 chip（沿用 openLanguageMenu 的定位 + 视口钳制，
 *  setUseNativeMenu(false) 保证 DOM 菜单行为跨平台一致）。 */
function openMenuAt(menu: Menu, anchor: HTMLElement): void {
	menu.setUseNativeMenu(false);
	const rect = anchor.getBoundingClientRect();
	menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
	const win = anchor.ownerDocument.defaultView;
	const menuEl = (menu as unknown as { menuEl?: HTMLElement }).menuEl;
	if (menuEl && win) {
		menuEl.style.left =
			`${Math.max(8, Math.min(rect.left, win.innerWidth - menuEl.offsetWidth - 8))}px`;
	}
}

function markActive(item: MenuItem): void {
	// 复用语言菜单的激活样式（accent 色 + 加粗），语义一致。
	(item as unknown as { titleEl: HTMLElement }).titleEl.addClass("semlink-lang-active");
}

/** 柱 hover tooltip：body 挂载 + fixed 定位（transform 祖先免疫），跟
 *  context-tooltip 同一思路，显示日期 + 分段明细（色点/名称/数值）。 */
function makeTipHandler(doc: Document): (bar: StackBar | null, ev: MouseEvent) => void {
	const tip = doc.body.createDiv({ cls: "semlink-usage-tip semlink-hidden" });
	return (bar, ev) => {
		if (!bar || bar.segs.every((seg) => seg.value <= 0)) {
			tip.addClass("semlink-hidden");
			return;
		}
		const win = doc.defaultView;
		if (!win) return;
		tip.removeClass("semlink-hidden");
		tip.empty();
		tip.createDiv({ cls: "semlink-usage-tip-title", text: bar.label });
		for (const seg of bar.segs) {
			if (seg.value <= 0) continue;
			const row = tip.createDiv({ cls: "semlink-usage-tip-row" });
			const dot = row.createDiv({ cls: "semlink-usage-tip-dot" });
			dot.style.backgroundColor = seg.color;
			row.createSpan({ cls: "semlink-usage-tip-name", text: seg.name });
			row.createSpan({ cls: "semlink-usage-tip-val", text: fmtNum(seg.value) });
		}
		tip.style.left =
			`${Math.max(8, Math.min(ev.clientX + 14, win.innerWidth - tip.offsetWidth - 8))}px`;
		tip.style.top =
			`${Math.max(8, Math.min(ev.clientY + 16, win.innerHeight - tip.offsetHeight - 8))}px`;
	};
}

function mainBars(s: UsageSummary, mode: "model" | "inout"): StackBar[] {
	if (mode === "inout") {
		return s.days.map((d) => ({
			label: d.label,
			segs: [
				{ name: t("usageTokensIn"), value: d.total.in, color: USAGE_IN_COLOR },
				{ name: t("usageTokensOut"), value: d.total.out, color: USAGE_OUT_COLOR },
			],
		}));
	}
	return s.days.map((d, di) => ({
		label: d.label,
		segs: s.models.map((m, mi) => ({
			name: m.model,
			value: (m.days[di]?.in ?? 0) + (m.days[di]?.out ?? 0),
			color: USAGE_MODEL_COLORS[mi % USAGE_MODEL_COLORS.length],
		})),
	}));
}

/** 保存对话框只用到这几个字段（避免为 electron 增加类型依赖）。 */
interface ElectronSaveDialog {
	showSaveDialog(options: {
		title?: string;
		defaultPath?: string;
		filters?: Array<{ name: string; extensions: string[] }>;
	}): Promise<{ canceled: boolean; filePath?: string }>;
}

async function exportCsv(plugin: SmartVaultPlugin): Promise<void> {
	const rows = await plugin.usageStore.recordsFor(filter);
	const lines = ["date,model,input_tokens,output_tokens"];
	for (const r of rows) {
		lines.push(`${new Date(r.ts).toISOString()},${r.model},${r.inTok},${r.outTok}`);
	}
	const content = "\uFEFF" + lines.join("\r\n");
	const stamp = new Date();
	const name =
		`semlink-usage-${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, "0")}` +
		`${String(stamp.getDate()).padStart(2, "0")}.csv`;

	// 桌面端首选：系统保存对话框 + Node fs 落盘（blob 下载在 Obsidian 的
	// Electron 会话里会被静默吞掉）。
	try {
		const req = (window as unknown as { require?: (id: string) => unknown }).require ?? require;
		const dialog = (req("electron") as { remote?: { dialog?: ElectronSaveDialog } }).remote?.dialog;
		if (dialog) {
			const ret = await dialog.showSaveDialog({
				title: t("usageExport"),
				defaultPath: name,
				filters: [{ name: "CSV", extensions: ["csv"] }],
			});
			if (ret.canceled || !ret.filePath) return;
			writeFileSync(ret.filePath, content, "utf-8");
			new Notice(`${t("usageExportDone")} ${ret.filePath}`);
			return;
		}
	} catch (e) {
		console.warn("[Semlink] CSV save dialog unavailable, falling back to blob download:", e);
	}

	// 兜底（无 remote 的环境）：blob 下载。
	const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
	const a = document.body.createEl("a");
	a.href = url;
	a.download = name;
	a.click();
	a.remove();
	window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export interface UsageDashboardOptions {
	/** 弹窗语境带 <h2> 标题；详情屏由顶条表达标题，缺省省略。 */
	withHeading?: boolean;
}

/** 把用量仪表盘渲染进 host：筛选条 + 统计卡 + Tokens 主图 + 按模型分区；
 *  免费态模糊内容区并盖 Pro gate。异步取数（usageStore 读盘），先 empty
 *  再画，与原渲染同时序语义。 */
export function renderUsageDashboard(
	host: HTMLElement,
	plugin: SmartVaultPlugin,
	opts: UsageDashboardOptions = {},
): void {
	host.empty();
	// 内部重渲钩子：筛选切换、清除记录后、许可弹窗关闭后原地重建。
	const rerender = (): void => renderUsageDashboard(host, plugin, opts);
	// 上一轮渲染可能遗留在 body 上的 tooltip（宿主被移除时没有 leave 事件）。
	for (const el of Array.from(host.ownerDocument.body.querySelectorAll(".semlink-usage-tip"))) el.remove();

	void (async () => {
		const pro = plugin.licenseManager.isPro();
		const s = await plugin.usageStore.summary(filter);
		if (!host.isConnected) return;
		const doc = host.ownerDocument;

		if (opts.withHeading) {
			host.createEl("h2", { text: t("usageTitle") });
		}

		// ── Filter toolbar ──
		const bar = host.createDiv({ cls: "semlink-usage-toolbar" });
		const timeChip = bar.createEl("button", { cls: "semlink-usage-chip" });
		timeChip.createSpan({ cls: "semlink-usage-chip-label", text: t("usageFilterTime") });
		timeChip.createSpan({ cls: "semlink-usage-chip-divider" });
		timeChip.createSpan({ cls: "semlink-usage-chip-value", text: rangeLabel(filter.range) });
		setIcon(timeChip.createSpan({ cls: "semlink-usage-chip-icon" }), "chevron-down");
		timeChip.addEventListener("click", () => {
			const menu = new Menu();
			for (const range of ["7d", "30d", "month", "all"] as UsageRange[]) {
				menu.addItem((item) => {
					item.setTitle(rangeLabel(range));
					item.onClick(() => {
						if (filter.range !== range) { filter.range = range; rerender(); }
					});
					if (range === filter.range) markActive(item);
				});
			}
			openMenuAt(menu, timeChip);
		});

		const modelChip = bar.createEl("button", { cls: "semlink-usage-chip" });
		modelChip.createSpan({ cls: "semlink-usage-chip-label", text: t("usageFilterModel") });
		modelChip.createSpan({ cls: "semlink-usage-chip-divider" });
		modelChip.createSpan({ cls: "semlink-usage-chip-value", text: filter.model ?? t("usageAll") });
		setIcon(modelChip.createSpan({ cls: "semlink-usage-chip-icon" }), "chevron-down");
		modelChip.addEventListener("click", () => {
			const menu = new Menu();
			menu.addItem((item) => {
				item.setTitle(t("usageAll"));
				item.onClick(() => {
					if (filter.model !== null) { filter.model = null; rerender(); }
				});
				if (filter.model === null) markActive(item);
			});
			for (const model of s.allModels) {
				menu.addItem((item) => {
					item.setTitle(model);
					item.onClick(() => {
						if (filter.model !== model) { filter.model = model; rerender(); }
					});
					if (filter.model === model) markActive(item);
				});
			}
			openMenuAt(menu, modelChip);
		});

		if (filter.range !== DEFAULT_FILTER.range || filter.model !== null) {
			const clearBtn = bar.createEl("button", { cls: "semlink-usage-clear", text: t("usageClearFilters") });
			clearBtn.addEventListener("click", () => {
				filter = { ...DEFAULT_FILTER };
				stackMode = "model";
				rerender();
			});
		}

		const exportBtn = bar.createEl("button", { cls: "semlink-usage-export", text: t("usageExport") });
		exportBtn.addEventListener("click", () => void exportCsv(plugin));

		// ── Empty state (no records at all, or filter matches nothing) ──
		if (s.reqs === 0) {
			host.createDiv({ cls: "semlink-usage-empty", text: t("usageEmpty") });
			return;
		}

		// ── Stat cards ──
		const cards = host.createDiv({ cls: "semlink-usage-cards" });
		const card = (label: string, value: string, unit?: string) => {
			const c = cards.createDiv({ cls: "semlink-usage-card" });
			c.createDiv({ cls: "semlink-usage-card-label", text: label });
			const v = c.createDiv({ cls: "semlink-usage-card-value" });
			v.createSpan({ text: value });
			if (unit) v.createSpan({ cls: "semlink-usage-card-unit", text: unit });
		};
		card(t("usageRequestsTotal"), fmtNum(s.reqs), t("usageRequestsUnit"));
		card(t("usageTokensIn"), fmtNum(s.inTok));
		card(t("usageTokensOut"), fmtNum(s.outTok));

		// ── Pro gate: blur the detail area for free users ──
		const body = host.createDiv({ cls: pro ? "semlink-usage-body" : "semlink-usage-body semlink-usage-locked" });
		if (!pro) {
			const gate = body.createDiv({ cls: "semlink-usage-gate" });
			gate.createDiv({ cls: "semlink-usage-gate-title", text: t("usageProTitle") });
			gate.createDiv({ cls: "semlink-usage-gate-desc", text: t("usageProDesc") });
			const btn = gate.createEl("button", { cls: "mod-cta", text: t("unlockPro") });
			btn.addEventListener("click", () => {
				// Keep this screen mounted; when the license modal closes,
				// re-render with the fresh license state (blur drops away).
				new LicenseModal(plugin.app, plugin, () => rerender()).open();
			});
		}

		// ── Tokens main chart (stack by model / by in·out) ──
		const main = body.createDiv({ cls: "semlink-usage-chartcard" });
		const head = main.createDiv({ cls: "semlink-usage-chartcard-head" });
		const title = head.createDiv({ cls: "semlink-usage-chartcard-title" });
		title.createSpan({ cls: "semlink-usage-chartcard-name", text: "Tokens" });
		title.createSpan({ cls: "semlink-usage-chartcard-value", text: fmtNum(s.inTok + s.outTok) });
		const seg = head.createDiv({ cls: "semlink-usage-seg" });
		for (const mode of ["model", "inout"] as const) {
			const segBtn = seg.createEl("button", { cls: "semlink-usage-seg-btn", text: mode === "model" ? t("usageStackByModel") : t("usageStackByInOut") });
			if (stackMode === mode) segBtn.addClass("is-active");
			segBtn.addEventListener("click", () => {
				if (stackMode !== mode) { stackMode = mode; rerender(); }
			});
		}
		renderStackedBars(main.createDiv({ cls: "semlink-usage-chart" }), mainBars(s, stackMode), {
			height: 220,
			onHover: makeTipHandler(doc),
		});

		// ── Per-model sections: requests area + tokens stacked bars ──
		for (const m of s.models) {
			const section = body.createDiv({ cls: "semlink-usage-section" });
			section.createDiv({ cls: "semlink-usage-modeltitle", text: m.model });
			const grid = section.createDiv({ cls: "semlink-usage-modelgrid" });

			const reqCard = grid.createDiv({ cls: "semlink-usage-chartcard" });
			const reqHead = reqCard.createDiv({ cls: "semlink-usage-chartcard-head" });
			const reqTitle = reqHead.createDiv({ cls: "semlink-usage-chartcard-title" });
			reqTitle.createSpan({ cls: "semlink-usage-chartcard-name", text: t("usageRequestsTotal") });
			reqTitle.createSpan({ cls: "semlink-usage-chartcard-value", text: fmtNum(m.reqs) });
			renderAreaChart(
				reqCard.createDiv({ cls: "semlink-usage-chart" }),
				m.days.map((d) => d.reqs),
				s.days.map((d) => d.label),
				{ height: 160 },
			);

			const tokCard = grid.createDiv({ cls: "semlink-usage-chartcard" });
			const tokHead = tokCard.createDiv({ cls: "semlink-usage-chartcard-head" });
			const tokTitle = tokHead.createDiv({ cls: "semlink-usage-chartcard-title" });
			tokTitle.createSpan({ cls: "semlink-usage-chartcard-name", text: "Tokens" });
			tokTitle.createSpan({ cls: "semlink-usage-chartcard-value", text: fmtNum(m.inTok + m.outTok) });
			renderStackedBars(
				tokCard.createDiv({ cls: "semlink-usage-chart" }),
				s.days.map((d, di) => ({
					label: d.label,
					segs: [
						{ name: t("usageTokensIn"), value: m.days[di]?.in ?? 0, color: USAGE_IN_COLOR },
						{ name: t("usageTokensOut"), value: m.days[di]?.out ?? 0, color: USAGE_OUT_COLOR },
					],
				})),
				{ height: 160, onHover: makeTipHandler(doc) },
			);
		}
	})();
}
