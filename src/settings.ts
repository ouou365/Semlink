// ========================================
// Semlink - Settings Tab
// ========================================

import { App, DropdownComponent, Modal, Notice, PluginSettingTab, Setting, SliderComponent, ToggleComponent, moment, setIcon } from "obsidian";
import * as QRCode from "qrcode";
import type SmartVaultPlugin from "../main";
import type { IndexProgress, McpClientServer, SmartVaultSettings } from "./types";
import { AddFeishuBotModal } from "./feishu-bot-modal";
import { startFeishuRegister, type FeishuScanHandle } from "./feishu-auth";
import { EMPTY_MODELS_TAB_STATE, renderModelsTab, type ModelsTabState } from "./settings-models";
import { LicenseModal, LicenseInfoModal } from "./license-modal";
import { licenseErrorMessage } from "./license";
import { LANGUAGES, t } from "./i18n";
import { ConfirmModal } from "./confirm-modal";
import { rerenderSettingsTab, showSliderValue } from "./ui-compat";
import { ShareQrModal } from "./share-modal";
import { debugLog } from "./log";

type SettingsTab = "general" | "model" | "mcp" | "embedding" | "share" | "bot";
export type { SettingsTab };

/** 索引「进行中」的判定口径：RAG 状态块的 is-running 高亮与重新索引
 *  按钮的「索引中…」运行态共用（idle/completed 之外的写阶段）。 */
const RAG_RUNNING_PHASES: ReadonlySet<string> = new Set(["scanning", "chunking", "embedding", "building_index"]);

/** 折叠体展开后把新增内容滚进可视区：头行刚被点击必然可见，用户看到
 *  「没反应」往往是因为内容全在折叠线以下——只补滚溢出滚动容器底缘的
 *  部分（内容不足一屏时贴合底缘，远超一屏时钉住头行露出首屏）。
 *  滚动层从头行向上找最近的 overflow auto/scroll（设置屏是
 *  .semlink-settings-panel，原生设置弹窗是 Obsidian 的内容列）。 */
function revealCollapsedBody(head: HTMLElement, body: HTMLElement): void {
	for (let p = head.parentElement; p; p = p.parentElement) {
		const oy = getComputedStyle(p).overflowY;
		if (oy !== "auto" && oy !== "scroll") continue;
		// 第一处滚动层即裁剪边界：它没溢出说明内容本来就全可见，直接收工
		const overflow = body.getBoundingClientRect().bottom - p.getBoundingClientRect().bottom;
		if (overflow <= 0) return;
		const headTop = head.getBoundingClientRect().top - p.getBoundingClientRect().top + p.scrollTop;
		const target = Math.min(p.scrollTop + overflow, headTop);
		const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		p.scrollTo({ top: target, behavior: smooth ? "smooth" : "auto" });
		return;
	}
}

export class SmartVaultSettingTab extends PluginSettingTab {
	plugin: SmartVaultPlugin;
	// 默认落第一项 Basic（菜单顺序用户拍板：Basic 第一）。每次打开设置
	// 都回到 Basic——display() 的 resetTab 默认为真（Obsidian 打开设置
	// 即此路径），所有内部/外部重渲一律显式传 false 保留当前 tab。
	private activeTab: SettingsTab = "general";
	/** 嵌入式设置屏（displayInto 进入）标记：跳过标题/标语/语言下拉块。 */
	private embeddedHost = false;
	/** Provider-list state (models management, embedded in the General tab):
	 *  which provider's editor is expanded / which add card is open. */
	private modelsState: ModelsTabState = { ...EMPTY_MODELS_TAB_STATE };
	private feishuScanHandle: FeishuScanHandle | null = null;
	private indexCardUnsub: (() => void) | null = null;
	constructor(app: App, plugin: SmartVaultPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/** 嵌入视图的设置屏（semlink-settings-screen）：把整套设置渲染进给定
	 *  容器（替代设置弹窗）。可指定起始 tab；返回的 destroy 断开进度
	 *  订阅等长生命周期资源并清空 DOM。 */
	displayInto(container: HTMLElement, opts?: { tab?: SettingsTab }): void {
		this.containerEl = container;
		// 嵌入式设置屏（聊天视图内）省略标题/标语块：品牌在屏幕顶部
		// corners 已有，语言切换挪到右上角图标——这里只剩 tab 栏 + 面板。
		this.embeddedHost = true;
		if (opts?.tab) this.activeTab = opts.tab;
		this.display(false);
	}

	/** 嵌入态退出：display() 只在“下一次 display”时清理订阅，嵌入屏退出
	 *  后不会再 display——这里显式断开进度订阅与进行中的飞书扫码。 */
	destroy(): void {
		this.feishuScanHandle?.abort();
		this.feishuScanHandle = null;
		this.indexCardUnsub?.();
		this.indexCardUnsub = null;
		this.containerEl.empty();
	}

	/** Deep-link from the chat view's "Manage models" popup entry: reveal the
	 *  settings with the Model tab active. */
	openModelTab(): void {
		this.activeTab = "model";
		this.display(false);
	}

	/** Re-render the current tab while keeping the scroll position — row
	 *  expand/collapse, provider create/delete and model add/remove/reorder
	 *  all re-render the whole page, which would otherwise jump back to the
	 *  top. Every scrollable ancestor's offset is recorded and restored
	 *  synchronously, on the next frame, and after a macrotask, so no layout
	 *  pass in between can reset it. */
	private refreshPreservingScroll(): void {
		const scrollers: HTMLElement[] = [];
		let el: HTMLElement | null = this.containerEl.parentElement;
		while (el) {
			const style = getComputedStyle(el);
			if (style.overflowY === "auto" || style.overflowY === "scroll"
				|| style.overflow === "auto" || style.overflow === "scroll") {
				scrollers.push(el);
			}
			el = el.parentElement;
		}
		const tops = scrollers.map((s) => s.scrollTop);
		// Fallback for layouts that scroll the window itself (short settings
		// panel inside a small window) rather than an inner container.
		const winTop = window.scrollY;
		rerenderSettingsTab(this);
		// rAF 绑宿主文档的窗口：嵌入屏在弹窗里时主窗 rAF 会被遮挡节流。
		const viewWin = this.containerEl.ownerDocument?.defaultView ?? window;
		const restore = () => {
			scrollers.forEach((s, i) => { s.scrollTop = tops[i]; });
			if (winTop > 0) viewWin.scrollTo(0, winTop);
		};
		restore();
		viewWin.requestAnimationFrame(restore);
		viewWin.setTimeout(restore, 0);
	}

	/** resetTab=true（默认）：Obsidian 打开设置的入口——回到 Basic 首页。
	 *  内部重渲（setTab 兜底 / displayInto / openModelTab）与外部重渲
	 *  （rerenderSettingsTab、导航深链）一律传 false，保留当前 tab。 */
	display(resetTab = true): void {
		if (resetTab) this.activeTab = "general";
		// 打开设置即触发一次总笔记数检查：reset 后（换嵌入模型/重索引/重嵌入）
		// 若尚未跑全量扫描，总数会停在 0，RAG 卡片整体显示 0。
		this.ensureTotalNotesSeeded();
		// Abort any in-flight Feishu scan before re-rendering (a fresh QR
		// session is started by the bot tab).
		this.feishuScanHandle?.abort();
		this.feishuScanHandle = null;
		this.indexCardUnsub?.();
		this.indexCardUnsub = null;

		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("smart-vault-settings");
		// 弹窗（编辑供应商等）也会挂 smart-vault-settings 来复用内部样式，
		// "撑满 Tab 容器"的 flex 布局只能作用于设置 Tab 根节点本身——
		// 用这个专属类做作用域，避免把弹窗撑出一大截空白。
		containerEl.addClass("semlink-settings-root");
		// 宿主形态：CSS 据此微调内嵌屏专属的留白/动画（弹窗宿主略不同）。
		containerEl.toggleClass("semlink-settings-embedded", this.embeddedHost);

		// Title heading row: brand text · version（顶条右上的语言下拉曾两度
		// 反复：先因"双入口冗余"移入偏好组，后收回原生设置顶条，最终用户
		// 拍板"去掉这个语言选择"——语言切换只留在 Base 页偏好组一处）。
		// Everything rides in the NAME element: heading-mode settings may hide
		// the control area depending on host CSS — the name always renders.
		// 嵌入式设置屏跳过：标题/标语与顶部品牌重复。
		if (!this.embeddedHost) {
			const title = new Setting(containerEl).setName(t("settingsTitle")).setHeading();
			title.nameEl.addClass("semlink-settings-heading-row");
			// setName already wrote the text into nameEl — clear it before adding
			// the structured children, or the title renders twice. Layout: title
			// with the version stacked under it (left).
			title.nameEl.empty();
			const titleLeft = title.nameEl.createDiv({ cls: "semlink-settings-heading-left" });
			titleLeft.createSpan({ cls: "semlink-settings-heading-text", text: t("settingsTitle") });
			titleLeft.createSpan({ cls: "semlink-settings-tagline", text: t("settingsTagline") });
		}

		// 横向 tab 栏（iOS 分段控件式）在上、内容面板在下：任何宽度都
		// 同构（不再有窄幅列表↔详情互斥的层级），tab 归属由分段高亮表达。
		const layout = containerEl.createDiv({ cls: "semlink-settings-layout" });
		const menuCol = layout.createDiv({ cls: "semlink-settings-menu-col" });
		this.renderSettingsMenu(menuCol.createDiv({ cls: "semlink-settings-menu" }));
		const detail = layout.createDiv({ cls: "semlink-settings-detail" });
		const panelEl = detail.createDiv({ cls: "semlink-settings-panel" });
		this.renderPanel(panelEl);
	}

	/** 渲染当前详情页内容（display 与 setTab 共用的分发）。 */
	private renderPanel(panelEl: HTMLElement): void {
		panelEl.empty();
		// 宽幅切 tab 的防生硬淡入（120ms 纯 opacity，见 .is-swapping）。
		// 窄幅不加：钻入态已有右滑入场动画，叠一层淡入反而糊。先摘 class
		// 再强制 reflow——连点换 tab 时动画每次都重触发。
		if ((this.containerEl.offsetWidth ?? 0) > 480) {
			panelEl.removeClass("is-swapping");
			void panelEl.offsetWidth;
			panelEl.addClass("is-swapping");
		}
		// 页头大标题已移除（用户拍板）：窄幅顶条品牌位已是页面名、宽幅由
		// 左侧菜单胶囊高亮表达归属——面板内再放同名大标题纯属重复。
		switch (this.activeTab) {
			case "general":
				this.renderGeneralTab(panelEl);
				break;
			case "model":
				renderModelsTab(this.plugin, panelEl, this.modelsState, () => this.refreshPreservingScroll());
				break;
			case "mcp":
				this.renderMcpTab(panelEl);
				break;
			case "share":
				this.renderShareTab(panelEl);
				break;
			case "embedding":
				this.renderEmbeddingTab(panelEl);
				break;
			case "bot":
				this.renderBotTab(panelEl);
				break;
		}
	}

	/** 总笔记数补数：换嵌入模型（saveSettings 指纹联动）、重新索引、重新嵌入
	 *  都会 progress.reset()，而换模型只清向量不触发扫库，reset 后
	 *  progress.totalNotes 停在 0 —— 设置页 RAG 卡片的 笔记总数/待索引 与
	 *  两个百分比就全显示 0。与 onload 的种子逻辑同源：只枚举文件清单
	 *  （不入队、不比对 mtime），代价极低；之后的真实扫描会用权威值覆盖。
	 *  totalNotes 非零时零开销，display() 的每次重渲染都可安全重复调用。 */
	private ensureTotalNotesSeeded(): void {
		if (this.plugin.progress.current.totalNotes !== 0) return;
		const seeded = this.plugin.scheduler.countIndexableNotes();
		if (seeded > 0) {
			this.plugin.progress.setTotalNotes(seeded);
			debugLog(`[Semlink] Settings opened: reseeded total notes to ${seeded}`);
		}
	}

	/** 横向 tab 栏（iOS 分段控件风格）：lucide 单色图标 + 名称。点击仅
	 *  切换下方面板——任何宽度同构，无钻入层级。 */
	private renderSettingsMenu(menuEl: HTMLElement): void {
		const tabs: Array<{ id: SettingsTab; icon: string; label: string }> = [
			// 用户拍板的菜单顺序：Base（偏好 + 快速开始 + 许可证）第一，
			// 其余任务 tab 依序跟随。图标 settings-2：tab 已从 Pro（gem
			// 宝石=付费身份）改名 Base，图标随之换基础设置语义（用户反馈
			// "base 的图标是不是换一个"）。
			{ id: "general", icon: "settings-2", label: t("tabGeneral") },
			{ id: "model", icon: "bot", label: t("tabModel") },
			{ id: "embedding", icon: "search", label: t("tabEmbedding") },
			{ id: "mcp", icon: "plug-zap", label: t("tabMcp") },
			{ id: "share", icon: "share-2", label: t("tabShare") },
			// Bot tab deliberately not listed: the Feishu bot is unpublished
			// (freemium-design v3.6). renderBotTab stays available for re-enable.
		];
		for (const tab of tabs) {
			const item = menuEl.createEl("button", { cls: "semlink-settings-menu-item" });
			// data-tab：setTab 的选中态原地翻转用（不再整表重建，防 hover 闪烁）
			item.setAttr("data-tab", tab.id);
			if (tab.id === this.activeTab) item.addClass("is-active");
			const iconEl = item.createSpan({ cls: "semlink-settings-menu-icon" });
			setIcon(iconEl, tab.icon);
			item.createSpan({ cls: "semlink-settings-menu-label", text: tab.label });
			item.addEventListener("click", () => {
				if (this.activeTab !== tab.id) this.setTab(tab.id);
			});
		}
	}

	/** 切换 tab：只重渲面板与分段选中态，不整屏重建——无闪烁，滚动位置
	 *  天然保留。模型页窄幅可能残留钻入态（供应商配置直开），切走再切回
	 *  时统一回到列表层，入口语义一致。 */
	setTab(tab: SettingsTab): void {
		if (this.activeTab === tab) return;
		this.activeTab = tab;
		this.modelsState.drilled = false;
		const panelEl = this.containerEl.querySelector<HTMLElement>(
			":scope > .semlink-settings-layout > .semlink-settings-detail > .semlink-settings-panel",
		);
		if (!panelEl) { this.display(false); return; }
		this.renderPanel(panelEl);
		const menuEl = this.containerEl.querySelector<HTMLElement>(".semlink-settings-menu");
		if (menuEl) {
			// 选中态原地翻转：整表重建会让悬停段的 hover 底瞬间消失（连点
			// 时的可见闪烁），这里一段都不动。
			menuEl.querySelectorAll<HTMLElement>(".semlink-settings-menu-item").forEach((el) => {
				el.toggleClass("is-active", el.dataset.tab === tab);
			});
		}
	}

	/** 通用页的上手清单：对话模型 / 嵌入模型 / 首次问答 / 解锁，四项状态
	 *  均由实时设置与历史推导（无需用户手动打勾）；每项带直达动作。 */
	/** 通用详情页：偏好（语言）→ 上手 → 许可/激活收尾（用户拍板"激活
	 *  放在快速上手下面"）；语言与上手行带前导图标。 */
	private renderGeneralTab(panelEl: HTMLElement): void {
		// 组标题 Preferences / Quick start 已去掉（用户拍板"这两个可以
		// 去掉"）——卡自明，无需组头。
		this.renderPrefsSection(panelEl);
		const guideCard = panelEl.createDiv({ cls: "semlink-card semlink-guide-row-card" });
		const guideRow = guideCard.createDiv({ cls: "semlink-row is-clickable" });
		const gGlyph = guideRow.createSpan({ cls: "semlink-row-glyph" });
		setIcon(gGlyph, "rocket");
		const gLabel = guideRow.createDiv({ cls: "semlink-row-label" });
		gLabel.createDiv({ cls: "semlink-row-title", text: t("guideRowTitle") });
		const guideBtn = guideRow.createDiv({ cls: "semlink-row-control" }).createEl("button", {
			cls: "semlink-btn-ghost semlink-btn-white",
			text: t("guideRowOpen"),
		});
		const openGuideHub = (): void => {
			(this.app as unknown as { setting: { close(): void } }).setting.close();
			void this.plugin.openGuideHub();
		};
		guideBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			openGuideHub();
		});
		guideRow.addEventListener("click", openGuideHub);
		this.renderLicenseSection(panelEl);
	}

	/** General 偏好组：语言切换。saveSettings 重跑 setLang 刷新语言相关
	 *  视图；display() 整页重渲，设置界面自身即刻跟随新语言。 */
	private renderPrefsSection(panelEl: HTMLElement): void {
		// 组标题已去掉（用户拍板）——卡自明；与下方 Guide 卡留组间距
		// （原组标题撑开的空隙随之消失，由本类补回）
		const card = panelEl.createDiv({ cls: "semlink-card semlink-prefs-card" });
		const row = card.createDiv({ cls: "semlink-row" });
		const glyph = row.createSpan({ cls: "semlink-row-glyph" });
		setIcon(glyph, "languages");
		row.createDiv({ cls: "semlink-row-label" }).createSpan({
			cls: "semlink-row-title",
			text: t("settingsLanguage"),
		});
		const ctl = row.createDiv({ cls: "semlink-row-control" });
		new DropdownComponent(ctl)
			.addOptions({
				auto: t("langAuto"),
				...Object.fromEntries(LANGUAGES.map((l) => [l.value, l.label])),
			})
			.setValue(this.plugin.settings.language)
			.onChange(async (value) => {
				this.plugin.settings.language = value as SmartVaultSettings["language"];
				await this.plugin.saveSettings();
				rerenderSettingsTab(this);
			});
	}

	private renderChecklistSection(containerEl: HTMLElement): void {
		const providers = this.plugin.settings.providers;
		const chatReady = providers.some(
			(p) => !!p.apiKey.trim() && p.models.some((m) => (m.kind ?? "chat") === "chat" && m.enabled === true),
		);
		const embeddingProviders = providers.filter(
			(p) => !!p.apiKey.trim() && p.models.some((m) => (m.kind ?? "chat") === "embedding"),
		);
		const embedKey = this.plugin.settings.embeddingModelKey;
		const embedPid = embedKey.split("::")[0] ?? "";
		const embedReady = embeddingProviders.some(
			(p) => p.id === embedPid && p.models.some((m) => (m.kind ?? "chat") === "embedding" && `${p.id}::${m.id}` === embedKey),
		);
		let firstChatDone = false;

		// 标题 + 分段计量出卡（卡外组标题，契约 3.1）；3 步 = 3 段离散填充。
		const head = containerEl.createDiv({ cls: "semlink-checklist-head" });
		head.createSpan({ cls: "semlink-card-title", text: t("checklistTitle") });
		const meter = head.createDiv({ cls: "semlink-checklist-meter" });
		const meterSegs: HTMLElement[] = [];
		for (let i = 0; i < 3; i++) {
			const seg = meter.createDiv({ cls: "semlink-checklist-meter-seg" });
			meterSegs.push(seg.createDiv({ cls: "semlink-checklist-meter-fill" }));
		}
		const progressEl = meter.createSpan({ cls: "semlink-checklist-meter-count" });
		const card = containerEl.createDiv({ cls: "semlink-card semlink-checklist" });
		const rowsEl = card.createDiv({ cls: "semlink-checklist-rows" });

		const rows: Array<{
			label: string;
			action: string;
			onAction: () => void;
			check: () => boolean;
			rowEl: HTMLElement;
			actionEl: HTMLElement;
			iconEl: HTMLElement;
		}> = [];

		const addRow = (emoji: string, label: string, actionLabel: string, onAction: () => void, check: () => boolean): void => {
			const rowEl = rowsEl.createDiv({ cls: "semlink-checklist-row" });
			const iconEl = rowEl.createSpan({ cls: "semlink-checklist-icon" });
			rowEl.createSpan({ cls: "semlink-checklist-label", text: emoji ? `${emoji} ${label}` : label });
			const actionEl = rowEl.createEl("button", { cls: "semlink-btn-secondary semlink-checklist-action", text: actionLabel });
			actionEl.addEventListener("click", onAction);
			rows.push({ label: emoji ? `${emoji} ${label}` : label, action: actionLabel, onAction, check, rowEl, actionEl, iconEl });
		};

		// 前两行「开始配置」：打开右侧面板并触发对应引导（对话/嵌入目录）
		addRow("", t("checklistChat"), t("ragSetupBtn"), () => {
			(this.app as unknown as { setting: { close(): void } }).setting.close();
			void this.plugin.openSetupGuide("chat");
		}, () => chatReady);
		addRow("", t("checklistEmbedding"), t("ragSetupBtn"), () => {
			(this.app as unknown as { setting: { close(): void } }).setting.close();
			void this.plugin.openSetupGuide("embed");
		}, () => embedReady);
		addRow("", t("checklistFirstChat"), t("checklistStartChat"), () => {
			(this.app as unknown as { setting: { close(): void } }).setting.close();
			void this.plugin.activateSearchView();
		}, () => firstChatDone);

		// 完成庆祝仅在「面板存活期间的实时跃迁」触发：首渲后 2s 内（历史
		// 异步补齐窗口）一律静默——打开页面连弹两个"全部就绪"是噪音。
		let celebrateArmed = false;
		window.setTimeout(() => { celebrateArmed = true; }, 2000);
		const refresh = (): void => {
			const prevDone = rows.filter((r) => r.rowEl.hasClass("is-done")).length;
			let done = 0;
			for (const r of rows) {
				const d = r.check();
				if (d) done++;
				r.rowEl.toggleClass("is-done", d);
				// 已完成动作降权：secondary → ghost（视觉退出竞争）。
				r.actionEl.toggleClass("semlink-btn-secondary", !d);
				r.actionEl.toggleClass("semlink-btn-ghost", d);
				setIcon(r.iconEl, d ? "check" : "circle");
			}
			for (let i = 0; i < meterSegs.length; i++) {
				// scaleX 替代 width：只动合成层属性，0.2s 过渡不触发布局
				meterSegs[i].style.transform = i < done ? "scaleX(1)" : "scaleX(0)";
			}
			// 计数恒为 n/n：完成态由 meter 三段全满 + 分段变 accent 表达，
			// 不再叠"✓ 全部就绪"文字（meter/count/文字三重冗余）。
			progressEl.setText(`${done}/${rows.length}`);
			const complete = done === rows.length;
			const wasComplete = card.hasClass("is-complete");
			card.toggleClass("is-complete", complete);
			// 完成跃迁：一次 Notice + 收起为摘要行。
			if (celebrateArmed && complete && !wasComplete && prevDone === done - 1) {
				new Notice(t("checklistDone"));
			}
		};

		// 完成收起态：整卡折为单行摘要（点按可展开回看步骤）。
		const summary = card.createEl("button", {
			cls: "semlink-checklist-summary",
			attr: { "aria-expanded": "false", "aria-label": t("checklistExpandAria") },
		});
		const sumIcon = summary.createSpan({ cls: "semlink-checklist-summary-icon" });
		setIcon(sumIcon, "check-circle");
		summary.createSpan({ cls: "semlink-checklist-summary-text", text: t("checklistDone") });
		// 头部 meter 右侧已有 "3/3"（评审 P1 双写）：摘要行不再重复计数，只留 chevron。
		const sumChevron = summary.createSpan({ cls: "semlink-checklist-summary-chevron" });
		setIcon(sumChevron, "chevron-down");
		summary.addEventListener("click", () => {
			const expanded = !card.hasClass("is-expanded");
			card.toggleClass("is-expanded", expanded);
			summary.setAttr("aria-expanded", String(expanded));
		});
		refresh();

		// 首次问答：历史会话里出现真实消息即视为完成（异步补齐该行）
		void this.plugin.historyStore
			.load()
			.then((sessions) => {
				if (sessions.some((s) => s.messages.some((m) => m.role === "user" || m.role === "assistant"))) {
					firstChatDone = true;
					refresh();
				}
			})
			.catch(() => { /* 历史不可用时保持未完成态 */ });
	}

	/** License section, iOS 分层：营销（白卡，badge/CTA 两处 accent）与
	 *  功能（中性白卡：密钥激活 / Pro 状态行）同材质同节奏——层次靠
	 *  信息密度而非配色区分，紫色不再整卡渲染。 */
	private renderLicenseSection(containerEl: HTMLElement): void {
		const lm = this.plugin.licenseManager;
		const pro = lm.isPro();

		if (pro) {
			// Pro 态（用户拍板）：一行卡片同 Onboard——gem 图标 + License +
			// 右侧普通样式 About 钮；点击弹激活信息弹窗（状态/方案/设备/
			// 密钥/停用）。
			const card = containerEl.createDiv({ cls: "semlink-card semlink-guide-row-card" });
			const row = card.createDiv({ cls: "semlink-row is-clickable" });
			const glyph = row.createSpan({ cls: "semlink-row-glyph" });
			setIcon(glyph, "gem");
			row.createDiv({ cls: "semlink-row-label" }).createDiv({
				cls: "semlink-row-title",
				text: t("licenseRowTitle"),
			});
			const openInfo = (): void => {
				new LicenseInfoModal(this.app, this.plugin, () => rerenderSettingsTab(this)).open();
			};
			const aboutBtn = row.createDiv({ cls: "semlink-row-control" }).createEl("button", {
				cls: "semlink-btn-ghost semlink-btn-white",
				text: t("licenseAbout"),
			});
			aboutBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				openInfo();
			});
			row.addEventListener("click", openInfo);
			return;
		}

		// ── 自由态：营销卡（白卡材质，与功能卡同一节奏；紫色只留给 badge 与 CTA） ──
		const card = containerEl.createDiv({ cls: "semlink-license-card" });
		const head = card.createDiv({ cls: "semlink-license-card-head" });
		const logo = head.createSpan({ cls: "semlink-license-card-logo" });
		setIcon(logo, "semlink-logo");
		head.createSpan({ cls: "semlink-license-card-title", text: "Semlink Pro" });
		head.createSpan({ cls: "semlink-license-card-badge", text: t("licenseBadge") });

		card.createDiv({ cls: "semlink-license-headline", text: t("licenseCardHeadline") });
		card.createDiv({ cls: "semlink-license-sub", text: t("licenseCardFreeLine") });

		// 价格行直接落卡内（不再嵌"卡中卡"），CTA 全宽止于卡底。
		const priceRow = card.createDiv({ cls: "semlink-license-pricerow" });
		priceRow.createSpan({ cls: "semlink-license-price", text: "$3" });
		priceRow.createSpan({ cls: "semlink-license-was", text: "$19.9" });
		priceRow.createSpan({ cls: "semlink-license-lifetime", text: t("licenseCardLifetime") });

		if (!lm.configured) {
			card.createSpan({ cls: "semlink-license-note", text: t("licenseNotConfigured") });
		} else {
			const buyBtn = card.createEl("button", { cls: "semlink-btn-primary semlink-btn-block semlink-license-cta", text: t("licenseCardCta") });
			buyBtn.addEventListener("click", () => void (async () => {
				if (buyBtn.dataset.busy === "1") return;
				buyBtn.dataset.busy = "1";
				buyBtn.addClass("is-busy");
				try {
					window.open(await lm.openCheckout(), "_blank");
				} catch {
					new Notice(t("upgradeCheckoutUnavailable"));
				} finally {
					buyBtn.dataset.busy = "";
					buyBtn.removeClass("is-busy");
				}
			})());
		}

		// ── 密钥激活：中性设置卡（未配置许可时不渲染——激活必失败） ──
		if (!lm.configured) return;
		// 激活块收进营销卡（用户拍板"把这两个放在一个卡片"）：卡内下半段，
		// 顶部 hairline 分隔、左右贴卡缘（负 margin 抵消卡内衬）*/
		const keycard = card.createDiv({ cls: "semlink-license-keycard semlink-license-keycard-inset" });
		keycard.createDiv({ cls: "semlink-license-keylabel", text: t("licenseKeyLabel") });
		const keyRow = keycard.createDiv({ cls: "semlink-license-keyrow" });
		const input = keyRow.createEl("input", {
			cls: "semlink-license-keyinput",
			attr: { type: "text", placeholder: t("licenseKeyPlaceholder"), spellcheck: "false", autocomplete: "off" },
		});
		const apply = keyRow.createEl("button", { cls: "semlink-btn-ghost semlink-btn-white semlink-license-apply", text: t("licenseActivate") });
		const keyError = keycard.createDiv({ cls: "semlink-license-keyerror" });
		keyError.setAttr("role", "alert");
		const clearError = (): void => {
			keycard.removeClass("has-error");
			input.removeClass("is-error");
			keyError.setText("");
		};
		// 输入即宽恕：非空恢复按钮，清既有错误；空值置灰（不批评）。
		input.addEventListener("input", () => {
			const has = input.value.trim().length > 0;
			if (has) apply.removeAttribute("disabled");
			else apply.setAttr("disabled", "true");
			clearError();
		});
		apply.setAttr("disabled", "true");
		const activate = () => void (async () => {
			const key = input.value.trim();
			if (!key || apply.dataset.busy === "1") return;
			apply.dataset.busy = "1";
			apply.setAttr("disabled", "true");
			input.setAttr("disabled", "true");
			apply.addClass("is-busy");
			try {
				await lm.activate(key);
				new Notice(t("licenseActivated"));
				rerenderSettingsTab(this);
			} catch (e) {
				// 行内错误：紧邻输入框（role=alert 即时播报），不再发 Notice。
				keycard.addClass("has-error");
				input.addClass("is-error");
				keyError.setText(licenseErrorMessage(e));
			} finally {
				apply.dataset.busy = "";
				apply.removeClass("is-busy");
				apply.removeAttribute("disabled");
				input.removeAttribute("disabled");
				if (!input.value.trim()) apply.setAttr("disabled", "true");
			}
		})();
		apply.addEventListener("click", activate);
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				activate();
			}
		});
	}

	// ══════════════════════════════════════
	// Tab: Embedding (RAG) — 状态 / 配置 / 维护 三组
	// ══════════════════════════════════════
	/** RAG 页组「状态」：单张卡（hero 大数字 + 总数副行 + 进度条 +
	 *  横排统计条 Indexed/Embedded/Skipped + Auto Index 开关）。
	 *  数据由进度事件与数据库统计双路刷新。reindexRef 由调用方传入：
	 *  重新索引按钮在「维护」组创建后回填引用，进度订阅据此把按钮切成
	 *  运行态三态（暂停索引/继续索引，用户拍板"索引中应该显示暂停索引
	 *  按钮"），空闲时恢复「重新索引」。 */
	private renderIndexCard(containerEl: HTMLElement, reindexRef?: { btn?: HTMLButtonElement; running?: boolean; apply?: () => void }): void {
		const totalNotes = (): number => Math.max(0, this.plugin.progress.current.totalNotes);
		// 活总数：refreshStats 时同步一次 vault 实际可索引数（countIndexable
		// Notes 与调度器扫描同口径：md + 非空 + 排除规则）——拷文件期间
		// hero 副行与百分比即时跟上，不等下一轮扫描（用户反馈"共 980 篇
		// 也应该更新呀"）。同步失败保持旧值（快照兜底）。
		let liveTotal = totalNotes();

		// 状态 = 单张卡（用户拍板"两个卡片可以合并"：索引/嵌入同源同节奏，
		// 双卡双 hero 是冗余）：hero（含总数副行）+ 进度条 + 横排统计条
		// + 自动索引开关。组标题已去（用户拍板"去掉小标题"）。

		// ── 块骨架：hero（标题 + spinner + 总数副行 + 大数字）→ 进度条（统计条/开关由调用处按序追加） ──
		interface RagBlock {
			block: HTMLElement;
			valueEl: HTMLElement;
			fillEl: HTMLElement;
			spinEl: HTMLElement;
			heroSub: HTMLElement;
		}
		const makeBlock = (title: string): RagBlock => {
			const block = containerEl.createDiv({ cls: "semlink-card semlink-rag-status" }).createDiv({ cls: "semlink-rag-block" });
			const hero = block.createDiv({ cls: "semlink-rag-hero" });
			const heroLeft = hero.createDiv({ cls: "semlink-rag-hero-left" });
			const heroTop = heroLeft.createDiv({ cls: "semlink-rag-hero-top" });
			heroTop.createSpan({ cls: "semlink-rag-hero-title", text: title });
			const spinEl = heroTop.createSpan({ cls: "semlink-rag-hero-spin" });
			setIcon(spinEl, "loader-2");
			const heroSub = heroLeft.createDiv({ cls: "semlink-rag-hero-sub" });
			const valueEl = hero.createSpan({ cls: "semlink-rag-hero-value is-empty", text: "—" });
			const fillEl = block.createDiv({ cls: "semlink-rag-bar" }).createDiv({ cls: "semlink-rag-bar-fill" });
			return { block, valueEl, fillEl, spinEl, heroSub };
		};
		// 末行自动开关行（单行：仅标题 + 开关）
		const toggleRow = (host: HTMLElement, label: string, initial: boolean, onChange: (v: boolean) => Promise<void>): void => {
			const row = host.createDiv({ cls: "semlink-row semlink-rag-toggle-row" });
			row.createDiv({ cls: "semlink-row-label semlink-rag-toggle-label" }).createDiv({ cls: "semlink-row-title", text: label });
			new ToggleComponent(row.createDiv({ cls: "semlink-row-control" }))
				.setValue(initial)
				.onChange((v) => onChange(v));
		};

		const indexBlock = makeBlock(t("indexProgressTitle"));
		// 横排统计条（用户拍板"横排统计条（推荐）"）：笔记总数进 hero 副行
		// （分母/基准），三个结果量——已索引/已嵌入/已跳过——横排一行，
		// 数字在上、标签在下。扫读层次：进度 → 结果 → 开关。
		const statsGrid = indexBlock.block.createDiv({ cls: "semlink-rag-stats" });
		const statCell = (label: string): HTMLElement => {
			const cell = statsGrid.createDiv({ cls: "semlink-rag-stat" });
			const num = cell.createSpan({ cls: "semlink-rag-stat-num", text: "—" });
			cell.createSpan({ cls: "semlink-rag-stat-label", text: label });
			return num;
		};
		const chunkedEl = statCell(t("chunkedNotes"));
		// 已嵌入：至少一个 chunk 带向量的笔记数
		const vectorizedEl = statCell(t("vectorizedChunks"));
		// 已跳过（用户拍板"嵌入进度要包含已跳过"）：空文件/全稀疏笔记，
		// 永远不会产生向量
		const embedSkippedEl = statCell(t("embedSkipped"));
		// 更新时间（第 4 格，用户拍板"改成更新时间"）：MAX(chunk.mtime)
		// ——最近一次索引写入的时刻；今天显示 HH:mm，更早显示 MM-dd HH:mm
		const updatedEl = statCell(t("ragUpdated"));
		// 索引总开关：关 = 停止文件监听并暂停当前索引；开 = 恢复监听并继续索引。
		toggleRow(indexBlock.block, t("autoIndex"), this.plugin.settings.autoIndex, async (v) => {
			this.plugin.settings.autoIndex = v;
			this.plugin.watcher.setAutoIndex(v);
			await this.plugin.saveSettings();
			if (v) this.plugin.scheduler.resume();
			else this.plugin.scheduler.pause();
			this.refreshPreservingScroll();
		});
		// Auto-embed 开关已撤（用户拍板"去掉"）：嵌入始终跟随索引进行，
		// settings.autoEmbed 保留默认 true 的底层语义（调度器仍读它）。

		// hero 大数字 = 百分比（封顶 100%）；总数未知（totalNotes=0）→「—」淡化。
		// hero 徽章三态（用户拍板"索引完成则旋转图标改成完成✅"）：
		// 运行中 = loader-2 旋转；完成（非运行且 100%）= check-circle 圆形✅；
		// 全新空库（从未索引）= 无图标。heroDone 由 setHero 按分子==总数更新。
		let heroDone = false;
		let runningNow = RAG_RUNNING_PHASES.has(this.plugin.progress.current.phase);
		const updateBadge = (): void => {
			indexBlock.block.toggleClass("is-running", runningNow);
			indexBlock.block.toggleClass("is-done", !runningNow && heroDone);
			// spinEl 在 makeBlock 闭包里，本作用域不可见（拉取代码引用裸名
			// spinEl → ReferenceError，RAG 页整页崩）——用 indexBlock 徽章。
			setIcon(indexBlock.spinEl, runningNow || !heroDone ? "loader-2" : "check-circle");
		};
		const setHero = (b: RagBlock, num: number): void => {
			const total = liveTotal;
			if (total === 0) {
				b.valueEl.setText("—");
				b.valueEl.addClass("is-empty");
				b.fillEl.style.transform = "scaleX(0)";
				heroDone = false;
				updateBadge();
				return;
			}
			const pct = Math.min(100, (num / total) * 100);
			b.valueEl.setText(`${pct.toFixed(1)}%`);
			b.valueEl.removeClass("is-empty");
			b.fillEl.style.transform = `scaleX(${pct / 100})`;
			heroDone = num >= total;
			updateBadge();
		};
		// 运行态三态按钮：运行中 = 暂停索引；运行中已暂停（手动或网络自动
		// 暂停）= 继续索引；空闲 = 重新索引。红字危险态只属于破坏性的
		// 重新索引——暂停/继续是无损操作，恢复白钮。
		const applyReindexBtn = (): void => {
			const btn = reindexRef?.btn;
			if (!btn) return;
			const running = reindexRef?.running ?? false;
			const paused = this.plugin.progress.current.isPaused;
			btn.removeAttribute("disabled");
			btn.toggleClass("mod-danger", !running);
			btn.setText(running ? (paused ? t("resumeIndex") : t("pauseIndex")) : t("reindexAll"));
		};
		const setRunning = (running: boolean): void => {
			runningNow = running;
			updateBadge();
			if (reindexRef) {
				reindexRef.running = running;
				reindexRef.apply = applyReindexBtn;
			}
			applyReindexBtn();
		};

		// 数值行取数据库真实状态（笔记数），hero 百分比 = 已索引（已嵌入） / 总笔记数。
		// 已嵌入口径 = 至少一个 chunk 带向量的笔记数（getEmbeddedNoteCount），
		// 不读 note_doc_vectors——该表会被算法迁移/换模型清空重建，迁移期恒
		// 为 0；chunk 向量与笔记嵌入同事务落库，进度只增不减。
		// 首查常见于插件刚加载、DB worker 尚在初始化——失败不能静默吞掉
		// （空闲时没有进度事件来重试），退避重试直到 worker 就绪补上数值。
		let statsRetryTimer: number | null = null;
		// 总数副行独立刷新：不依赖 DB 往返——重索引期间 worker 繁忙，
		// getStats 可能连续失败走退避重试，总数若挂在它后面会冻结在旧值
		// （真机复现：状态栏 1016 而副行恒 980）。vault 文件遍历轻量
		// （~千文件 <1ms），失败静默保持旧值。
		const updateHeroSub = (): void => {
			try {
				liveTotal = Math.max(0, this.plugin.scheduler.countIndexableNotes());
			} catch { /* vault 不可用时保持快照 */ }
			indexBlock.heroSub.setText(t("ragTotalSub").replace("{n}", liveTotal.toLocaleString()));
		};
		const refreshStats = async (attempt = 0): Promise<void> => {
			try {
				const [s, embeddedNotes, skippedNotes] = await Promise.all([
					this.plugin.store.getStats(),
					this.plugin.store.getEmbeddedNoteCount(),
					this.plugin.store.getEmbedSkippedNoteCount(),
				]);
				chunkedEl.setText(s.indexedNotes.toLocaleString());
				vectorizedEl.setText(embeddedNotes.toLocaleString());
				embedSkippedEl.setText(skippedNotes.toLocaleString());
				const idxTime = await this.plugin.store.lastIndexTime();
				if (idxTime) {
					const d = new Date(idxTime);
					const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
					updatedEl.setText(
						d.toDateString() === new Date().toDateString()
							? hm
							: `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`,
					);
				}
				// 总数副行：hero 的分母口径（用户拍板"横排统计条"——总数不再
				// 与三个结果量平铺），用活总数（拷文件期间即时增长）
				indexBlock.heroSub.setText(t("ragTotalSub").replace("{n}", liveTotal.toLocaleString()));
				// 单 hero 分子 = Embedded + Skipped（用户拍板）：跳过的笔记
				// （空文件/全稀疏）永远不会产生向量，但已被处理完——两者
				// 相加恰为处理完成数，索引收尾时 hero 精确到 100%
				setHero(indexBlock, embeddedNotes + skippedNotes);
				// 写透快照：这次查询的值就是下次打开设置页的首帧缓存
				Object.assign(this.plugin.ragStatsCache, {
					indexedNotes: s.indexedNotes,
					embeddedNotes,
					skippedNotes,
					ready: true,
				});
			} catch (e) {
				if (attempt >= 8) {
					console.warn("[Semlink] index stats unavailable:", e);
					return;
				}
				statsRetryTimer = window.setTimeout(() => void refreshStats(attempt + 1), 1000 * (attempt + 1));
			}
		};
		setRunning(RAG_RUNNING_PHASES.has(this.plugin.progress.current.phase));
		updateHeroSub();
		// 首帧先用快照直出（plugin 启动播种/上次查询写透的 ragStatsCache）：
		// 打开 RAG tab 不再空「—」等 DB 往返；下方 refreshStats 照跑纠偏。
		const seed = this.plugin.ragStatsCache;
		if (seed.ready) {
			chunkedEl.setText(seed.indexedNotes.toLocaleString());
			vectorizedEl.setText(seed.embeddedNotes.toLocaleString());
			embedSkippedEl.setText(seed.skippedNotes.toLocaleString());
			setHero(indexBlock, seed.embeddedNotes + seed.skippedNotes);
		}
		void refreshStats();

		// 单一合并订阅：进度事件实时刷新运行态 + 总数（不依赖 DB）+ 数值行节流查库（≤1s 一次）
		let lastEmbedRefresh = 0;
		const unIndex = this.plugin.progress.onProgress((e) => {
			if (e.type === "progress") {
				setRunning(RAG_RUNNING_PHASES.has(e.progress.phase));
				const now = Date.now();
				if (now - lastEmbedRefresh >= 1000) {
					lastEmbedRefresh = now;
					updateHeroSub();
					void refreshStats();
				}
				return;
			}
			// 暂停/恢复：phase 不变（仍处运行相位），按钮要在这两个事件瞬间
			// 翻转——等下一个 progress 事件会卡在旧文案（暂停后循环退出，
			// 事件流也停了）。
			if (e.type === "pause" || e.type === "resume") {
				setRunning(RAG_RUNNING_PHASES.has(this.plugin.progress.current.phase));
			}
		});
		this.indexCardUnsub = () => {
			unIndex();
			if (statsRetryTimer != null) window.clearTimeout(statsRetryTimer);
		};
	}

	private renderEmbeddingTab(containerEl: HTMLElement): void {
		// reindex 按钮引用前传给状态组的进度订阅（状态组先渲染，维护组后创建）
		const reindexRef: { btn?: HTMLButtonElement; running?: boolean; apply?: () => void } = {};
		this.renderIndexCard(containerEl, reindexRef);

		// ── 组「配置」：嵌入模型 + 排除路径（组标题已去，用户拍板） ──
		const configCard = containerEl.createDiv({ cls: "semlink-card semlink-rag-card" });

		// 配置了 Key 且带有嵌入模型的供应商 → 当前生效的模型/供应商
		const embeddingProviders = this.plugin.settings.providers.filter(
			(p) => !!p.apiKey.trim() && p.models.some((m) => (m.kind ?? "chat") === "embedding"),
		);
		const currentKey = this.plugin.settings.embeddingModelKey;
		const keyPid = currentKey.split("::")[0] ?? "";
		const keyMid = currentKey.split("::").slice(1).join("::");
		const configuredProvider = embeddingProviders.find((p) => p.id === keyPid);
		const configuredModel = configuredProvider?.models.find(
			(m) => (m.kind ?? "chat") === "embedding" && m.id === keyMid,
		);

		const modelRow = configCard.createDiv({ cls: "semlink-row" });
		const modelLabel = modelRow.createDiv({ cls: "semlink-row-label" });
		modelLabel.createDiv({ cls: "semlink-row-title", text: t("ragSemantic") });
		modelLabel.createDiv({
			cls: "semlink-row-desc",
			text: configuredProvider && configuredModel
				? `${configuredModel.id} · ${configuredProvider.name}`
				: t("ragSemanticHint"),
		});
		const modelBtn = modelRow.createDiv({ cls: "semlink-row-control" }).createEl("button", {
			// 白色普通钮（用户拍板）：不再按配置态切换 primary/secondary
			cls: "semlink-btn-ghost semlink-btn-white",
			// 文案统一用「Setup」（用户拍板"Configure 改成 Setup"）——与
			// 相邻排除路径行的按钮同键（ragSetup）。
			text: t("ragSetup"),
		});
		modelBtn.addEventListener("click", () => {
			// 关闭设置页，打开侧边栏的向量检索配置引导
			// （选嵌入供应商、嵌入模型，然后是咖啡杯嵌入进度）。
			(this.app as unknown as { setting: { close(): void } }).setting.close();
			void this.plugin.openSetupGuide("embed");
		});

		const excludeRow = configCard.createDiv({ cls: "semlink-row" });
		const excludeLabel = excludeRow.createDiv({ cls: "semlink-row-label" });
		excludeLabel.createDiv({ cls: "semlink-row-title", text: t("excludePaths") });
		excludeLabel.createDiv({ cls: "semlink-row-desc", text: t("excludePathsShort") });
		const excludeBtn = excludeRow.createDiv({ cls: "semlink-row-control" }).createEl("button", {
			cls: "semlink-btn-ghost semlink-btn-white",
			text: t("ragSetup"),
		});
		excludeBtn.addEventListener("click", () => new ExcludePathsModal(this.app, this.plugin).open());

		// ── 组「维护」：重新索引（清空全部索引从 0 重建，破坏性带确认；
		//    组标题已去，用户拍板） ──
		const maintainCard = containerEl.createDiv({ cls: "semlink-card semlink-rag-card" });
		const reindexRow = maintainCard.createDiv({ cls: "semlink-row" });
		const reindexLabel = reindexRow.createDiv({ cls: "semlink-row-label" });
		reindexLabel.createDiv({ cls: "semlink-row-title", text: t("reindexAll") });
		reindexLabel.createDiv({ cls: "semlink-row-desc", text: t("reindexAllDesc") });
		const reindexBtn = reindexRow.createDiv({ cls: "semlink-row-control" }).createEl("button", {
			cls: "semlink-btn-ghost mod-danger",
			text: t("reindexAll"),
		});
		// 数据文件夹行已撤（用户拍板"去掉 Data folder"）：OPFS 位置对普通
		// 用户不可达，文件名+体积无操作价值。
		// 三态文案切换器（renderIndexCard 的进度订阅回填 apply）：
		// 运行 = 暂停/继续，空闲 = 重新索引。
		const applyReindexState = (): void => reindexRef.apply?.();
		reindexBtn.addEventListener("click", () => {
			// 运行态 = 暂停/继续开关（无损，免确认）；空闲才走重索引确认流。
			// 暂停后事件流停了，这里主动刷一次按钮文案。
			if (reindexRef.running) {
				if (this.plugin.progress.current.isPaused) this.plugin.scheduler.resume();
				else this.plugin.scheduler.pause();
				applyReindexState();
				return;
			}
			new ConfirmModal(this.app, t("reindexAll"), t("reindexConfirm"), () => {
				void this.plugin.reindexAll();
			}).open();
		});
		reindexRef.btn = reindexBtn;
		// 打开页面时索引已在进行 → 按钮直接进入暂停/继续运行态
		// （进度订阅只在事件到来时更新，空闲时没有事件可依赖）。
		applyReindexState();

		// ── 高级选项（默认收起）：分块 / 批量 / 延迟 / 并发 ──
		// chevron 只 setIcon 一次，开合用 CSS rotate(90deg)；body 展开瞬间
		// 播 reveal 动画（animationend 自移除，面板重渲不动画）。
		const advHead = containerEl.createEl("button", { cls: "semlink-collapse-head", attr: { type: "button", "aria-expanded": "false" } });
		const chev = advHead.createSpan({ cls: "semlink-collapse-chevron" });
		setIcon(chev, "chevron-right");
		advHead.createSpan({ cls: "semlink-collapse-label", text: t("editorAdvancedShow") });
		// -card 修饰：白卡化（背景/圆角/内衬/边距）只归 RAG 高级选项滑块
		// 体——通用 .semlink-collapse-body 不带（MCP Debug 折叠体卡里套卡，
		// 白卡内衬会多出四周空隙）
		const advBody = containerEl.createDiv({ cls: "semlink-collapse-body semlink-collapse-body-card semlink-hidden" });
		advHead.addEventListener("click", () => {
			const open = !advBody.hasClass("semlink-hidden");
			advBody.toggleClass("semlink-hidden", open);
			advHead.toggleClass("is-open", !open);
			advHead.setAttr("aria-expanded", String(!open));
			if (!open) {
				advBody.addClass("semlink-anim");
				advBody.addEventListener("animationend", () => advBody.removeClass("semlink-anim"), { once: true });
				revealCollapsedBody(advHead, advBody);
			}
		});

		// 切块参数（改动后需重建索引）
		new Setting(advBody)
			.setName(t("chunkSize"))
			.addSlider((slider) => {
				showSliderValue(slider.setLimits(200, 2000, 100).setValue(this.plugin.settings.chunkSize));
				return slider.onChange(async (value) => {
					this.plugin.settings.chunkSize = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(advBody)
			.setName(t("chunkOverlap"))
			.addSlider((slider) => {
				showSliderValue(slider.setLimits(0, 500, 50).setValue(this.plugin.settings.chunkOverlap));
				return slider.onChange(async (value) => {
					this.plugin.settings.chunkOverlap = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(advBody)
			.setName(t("batchSize"))
			.addSlider((slider) => {
				showSliderValue(slider.setLimits(1, 128, 1).setValue(this.plugin.settings.batchSize));
				return slider.onChange(async (value) => {
					this.plugin.settings.batchSize = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(advBody)
			.setName(t("requestDelay"))
			.addSlider((slider) => {
				showSliderValue(slider.setLimits(0, 1000, 50).setValue(this.plugin.settings.requestDelayMs));
				return slider.onChange(async (value) => {
					this.plugin.settings.requestDelayMs = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(advBody)
			.setName(t("embedConcurrency"))
			.addSlider((slider) => {
				showSliderValue(slider.setLimits(1, 5, 1).setValue(this.plugin.settings.embedConcurrency ?? 2));
				return slider.onChange(async (value) => {
					this.plugin.settings.embedConcurrency = value;
					await this.plugin.saveSettings();
				});
			});
	}

	// ══════════════════════════════════════
	// Tab: MCP — single semlink server card with a run toggle
	// ══════════════════════════════════════
	private renderMcpTab(containerEl: HTMLElement): void {
		const running = !!this.plugin.mcpServer;
		const lastError = this.plugin.mcpLastError;
		// 三态：运行中（绿呼吸）/ 已停止（灰）/ 连接失败（红）。失败 =
		// 设置里仍启用、服务未在跑、且留有最近一次启动错误。
		const errored = !running && this.plugin.settings.mcpEnabled === true && !!lastError;
		const mcpUrl = `http://127.0.0.1:${this.plugin.settings.mcpPort}/mcp`;
		const clientServers = this.plugin.settings.mcpClientServers ?? [];

		// 键盘可达：role=button 的行支持 Enter/Space 触发。
		const press = (el: HTMLElement, action: () => void): void => {
			el.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					action();
				}
			});
		};


		// ── 组「内置服务」：semlink 一张卡四行 ──
		containerEl.createDiv({ cls: "semlink-card-title", text: t("mcpGroupBuiltIn") });
		const card = containerEl.createDiv({ cls: "semlink-card semlink-mcp-card" });

		// 1) 主行：图标槽（accent 淡染底）+ 右下角状态点 + 名称 + 状态 pill
		//    + desc（失败时展示 mcpLastError 原因）+ 启停开关。
		const mainRow = card.createDiv({ cls: "semlink-row semlink-mcp-row-main" });
		const iconSlot = mainRow.createDiv({
			cls: `semlink-mcp-icon ${running ? "is-running" : errored ? "is-error" : "is-stopped"}`,
		});
		setIcon(iconSlot.createSpan({ cls: "semlink-mcp-icon-img" }), "semlink-logo");
		iconSlot.createSpan({ cls: "semlink-mcp-dot" });
		const mainLabel = mainRow.createDiv({ cls: "semlink-row-label" });
		const nameLine = mainLabel.createDiv({ cls: "semlink-mcp-name-line" });
		nameLine.createSpan({ cls: "semlink-row-title semlink-mcp-name", text: "semlink" });
		nameLine.createSpan({
			cls: `semlink-mcp-pill ${running ? "is-running" : errored ? "is-error" : "is-stopped"}`,
			text: running ? t("mcpRunning") : errored ? t("mcpStatusError") : t("mcpStopped"),
		});
		// desc 即地址（用户拍板"参照 semlink-debug 只留名称、地址、开关"；
		// 失败时仍优先展示原因）
		mainLabel.createDiv({
			cls: "semlink-row-desc semlink-mcp-url",
			text: errored && lastError ? lastError : mcpUrl,
		});
		// 控制区：分享钮（用户拍板"增加分享按钮"——原 Connect a client 行
		// 的内容收进这里，打开 McpShareModal 复制 Claude/ZCode 接入配置）
		// + 启停开关
		const mainControl = mainRow.createDiv({ cls: "semlink-row-control semlink-mcp-control" });
		const shareBtn = mainControl.createEl("button", {
			cls: "semlink-mcp-share-btn clickable-icon",
			attr: { "aria-label": t("mcpRowShare"), title: t("mcpRowShare") },
		});
		setIcon(shareBtn, "share-2");
		shareBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			new McpShareModal(this.app, this.plugin).open();
		});
		new ToggleComponent(mainControl)
			.setValue(running)
			.onChange(async (v) => {
				// 开关状态持久化：重启 Obsidian 后保持用户选择
				this.plugin.settings.mcpEnabled = v;
				await this.plugin.saveSettings();
				if (v) await this.plugin.startMcpServer();
				else await this.plugin.stopMcpServer();
				rerenderSettingsTab(this);
			});

		// ── 组「外部服务」：可增删改的管理层（点行进配置弹窗） ──
		// 分组恒渲染：此前空态整组消失，配置弹窗的"新建"分支永不可达
		// （评审 P0 功能断链）——空态给一行 "Add server" 直达弹窗。
		containerEl.createDiv({ cls: "semlink-card-title", text: t("mcpGroupExternal") });
		{
			const extCard = containerEl.createDiv({ cls: "semlink-card semlink-mcp-card" });
			if (clientServers.length === 0) {
				const addRow = extCard.createDiv({
					cls: "semlink-row is-clickable semlink-mcp-ext-row",
					attr: { role: "button", tabindex: "0" },
				});
				const addIcon = addRow.createDiv({ cls: "semlink-mcp-icon is-neutral" });
				setIcon(addIcon.createSpan({ cls: "semlink-mcp-icon-img" }), "plus");
				addRow.createDiv({ cls: "semlink-row-label" }).createSpan({
					cls: "semlink-row-title",
					text: t("mcpAddServer"),
				});
				const openAdd = (): void => new McpServerConfigModal(this.app, this.plugin, null, () => rerenderSettingsTab(this)).open();
				addRow.addEventListener("click", openAdd);
				press(addRow, openAdd);
			}
			for (const s of clientServers) {
				const row = extCard.createDiv({
					cls: "semlink-row is-clickable semlink-mcp-ext-row",
					attr: { role: "button", tabindex: "0" },
				});
				const extIcon = row.createDiv({ cls: "semlink-mcp-icon is-neutral" });
				setIcon(extIcon.createSpan({ cls: "semlink-mcp-icon-img" }), "plug-zap");
				const extLabel = row.createDiv({ cls: "semlink-row-label" });
				const extNameLine = extLabel.createDiv({ cls: "semlink-mcp-name-line" });
				extNameLine.createSpan({ cls: "semlink-row-title semlink-mcp-name", text: s.name });
				const extPill = extNameLine.createSpan({
					cls: `semlink-mcp-pill ${s.enabled ? "is-on" : "is-off"}`,
					text: t(s.enabled ? "mcpStatusEnabled" : "mcpStatusDisabled"),
				});
				extLabel.createDiv({
					cls: "semlink-row-desc",
					text: s.type === "stdio" ? `${t("mcpTypeLocal")} · ${s.command}` : (s.url ?? ""),
				});
				new ToggleComponent(row.createDiv({ cls: "semlink-row-control" }))
					.setValue(s.enabled)
					.onChange((v) => {
						s.enabled = v;
						// pill 就地更新：开关翻转不整页重渲，状态词/配色即时跟随。
						extPill.setText(t(v ? "mcpStatusEnabled" : "mcpStatusDisabled"));
						extPill.toggleClass("is-on", v);
						extPill.toggleClass("is-off", !v);
						void this.plugin.saveSettings();
					});
				const openExt = (): void => new McpServerConfigModal(this.app, this.plugin, s, () => rerenderSettingsTab(this)).open();
				row.addEventListener("click", (e) => {
					// 避开开关：点 toggle 只翻转，不进配置弹窗。
					if ((e.target as HTMLElement).closest(".checkbox-container")) return;
					openExt();
				});
				press(row, openExt);
			}
		}

		// ── 调试折叠：semlink-debug 服务器（ask 单工具，问答端到端测试）。
		//    默认关闭（严格 opt-in）——只面向开发者，不占普通用户视线。
		//    交互同 RAG 高级折叠：chevron setIcon 一次，开合用 CSS 旋转。 ──
		const debugHead = containerEl.createEl("button", {
			cls: "semlink-collapse-head semlink-mcp-debug-head",
			attr: { type: "button", "aria-expanded": "false" },
		});
		setIcon(debugHead.createSpan({ cls: "semlink-collapse-chevron" }), "chevron-right");
		const debugLabels = debugHead.createDiv({ cls: "semlink-collapse-labels" });
		// 只留标题（用户拍板"developer tool"，desc 去掉）
		debugLabels.createSpan({ cls: "semlink-collapse-label", text: t("mcpDebugGroup") });
		const debugBody = containerEl.createDiv({ cls: "semlink-collapse-body semlink-hidden" });
		debugHead.addEventListener("click", () => {
			const open = !debugBody.hasClass("semlink-hidden");
			debugBody.toggleClass("semlink-hidden", open);
			debugHead.toggleClass("is-open", !open);
			debugHead.setAttr("aria-expanded", String(!open));
			if (!open) {
				debugBody.addClass("semlink-anim");
				debugBody.addEventListener("animationend", () => debugBody.removeClass("semlink-anim"), { once: true });
				revealCollapsedBody(debugHead, debugBody);
			}
		});

		const debugRunning = !!this.plugin.debugMcpServer;
		const debugCard = debugBody.createDiv({ cls: "semlink-card semlink-mcp-card" });
		const dRow = debugCard.createDiv({ cls: "semlink-row semlink-mcp-row-main" });
		// 图标/结构完全对齐内置 semlink 卡（用户拍板"semlink-debug 的样式
		// 也修复回来"）：accent 淡染底（去 is-neutral）+ 名称/pill + desc
		// 即地址（去掉 ask·reload 尾巴，窄栏不再折行）
		const dIcon = dRow.createDiv({ cls: `semlink-mcp-icon ${debugRunning ? "is-running" : "is-stopped"}` });
		setIcon(dIcon.createSpan({ cls: "semlink-mcp-icon-img" }), "bug");
		dIcon.createSpan({ cls: "semlink-mcp-dot" });
		const dLabel = dRow.createDiv({ cls: "semlink-row-label" });
		const dNameLine = dLabel.createDiv({ cls: "semlink-mcp-name-line" });
		dNameLine.createSpan({ cls: "semlink-row-title semlink-mcp-name", text: "semlink-debug" });
		dNameLine.createSpan({
			cls: `semlink-mcp-pill ${debugRunning ? "is-running" : "is-stopped"}`,
			text: debugRunning ? t("mcpRunning") : t("mcpStopped"),
		});
		dLabel.createDiv({
			cls: "semlink-row-desc semlink-mcp-url",
			text: `http://127.0.0.1:${this.plugin.settings.debugMcpPort ?? 3002}/mcp`,
		});
		new ToggleComponent(dRow.createDiv({ cls: "semlink-row-control" }))
			.setValue(this.plugin.settings.debugMcpEnabled === true)
			.onChange(async (v) => {
				this.plugin.settings.debugMcpEnabled = v;
				await this.plugin.saveSettings();
				if (v) await this.plugin.startDebugMcpServer();
				else await this.plugin.stopDebugMcpServer();
				rerenderSettingsTab(this);
			});
	}

	// ══════════════════════════════════════
	// Tab: Share — 局域网共享管理
	// ══════════════════════════════════════
	/** Tab: Share — 已共享条目列表：标题 + 相对时间 + URL（悬停全显），
	 *  行尾复制/删除；点行进「分享详情」（二维码 + 全显地址 + 停止共享）。 */
	private renderShareTab(containerEl: HTMLElement): void {
		const server = this.plugin.shareServer;
		// 按共享时间倒序（最新的在最上面）。
		const shares = [...server.listShares()].sort((a, b) => b.sharedAt - a.sharedAt);

		if (shares.length === 0) {
			// 空状态（契约 §3.6）：图标 + 一句话，纵向居中于卡内。
			const empty = containerEl.createDiv({ cls: "semlink-card semlink-share-empty" });
			const icon = empty.createDiv({ cls: "semlink-share-empty-icon" });
			setIcon(icon, "share-2");
			empty.createDiv({ cls: "semlink-share-empty-text", text: t("shareEmpty") });
			return;
		}

		containerEl.createDiv({
			cls: "semlink-card-title",
			text: t("shareGroupTitle"),
		});
		const list = containerEl.createDiv({ cls: "semlink-card semlink-share-list" });
		void (async () => {
			const sessions = await this.plugin.historyStore.load();
			const titleOf = (sessionId: string): string => {
				// Note shares (`note:<path>` keys) title by the note's file name.
				if (sessionId.startsWith("note:")) {
					const p = sessionId.slice("note:".length);
					const f = this.plugin.app.vault.getAbstractFileByPath(p);
					return f ? f.name : p.split("/").pop() || p;
				}
				const st = sessions.find((x) => x.id === sessionId);
				return st?.title || st?.messages.find((m) => m.role === "user")?.content || t("shareUntitled");
			};
			list.empty();
			for (const entry of shares) {
				const title = titleOf(entry.sessionId);
				const url = server.urls(entry.token)[0];
				const item = list.createDiv({
					cls: "semlink-row is-clickable semlink-share-row",
					attr: { role: "button", tabindex: "0" },
				});

				// Revoke + drop the row; both the trash button and the detail
				// dialog's "Stop sharing" go through here. The list re-renders
				// to the empty card once the last row is gone.
				const removeRow = (): void => {
					server.revokeToken(entry.token);
					item.remove();
					if (list.children.length === 0) rerenderSettingsTab(this);
				};
				const openDetail = (): void => {
					// 与聊天分享按钮同一个详情弹窗：二维码 + 复制 + 浏览器打开
					// + 停止共享（那里的停止会同步移除本行）。
					new ShareQrModal(this.app, {
						url,
						name: title,
						onRevoke: removeRow,
					}).open();
				};
				item.addEventListener("click", openDetail);
				item.addEventListener("keydown", (e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						openDetail();
					}
				});

				// 图标槽 28px：笔记共享 = file-text，对话共享 = message-square
				// （用户拍板"图标改成对话图标"——原 share-2 网络图标语义含混）
				const icon = item.createSpan({ cls: "semlink-share-icon" });
				setIcon(icon, entry.sessionId.startsWith("note:") ? "file-text" : "message-square");

				// main 列：标题 + 时间（用户拍板"日期移到链接的位置"：次行不再
				// 显示 URL，改显相对时间/日期）
				const main = item.createDiv({ cls: "semlink-share-main" });
				const line1 = main.createDiv({ cls: "semlink-share-line1" });
				line1.createSpan({ cls: "semlink-share-title", text: title });
				main.createSpan({
					cls: "semlink-share-url",
					text: Date.now() - entry.sharedAt > 30 * 24 * 60 * 60 * 1000
						? moment(entry.sharedAt).format("YYYY-MM-DD")
						: moment(entry.sharedAt).fromNow(),
				});

				// 行尾不再放按钮（用户拍板"去掉这个图标"）：行尾转发钮与整行
				// 点击打开的是同一个详情弹窗（二维码/URL 复制/浏览器打开/停止
				// 共享），纯冗余——删掉后行点击即达，键盘路径不变。
			}
		})();
	}
	private renderBotTab(containerEl: HTMLElement): void {
		new Setting(containerEl).setName(t("botSection")).setHeading();

		// Pro gate (docs/freemium-design.md §3D): the bot surface stays
		// visible-but-locked on the free tier — one badge row + upgrade entry,
		// no bots are started at runtime (syncFeishuBots checks isPro).
		if (!this.plugin.licenseManager.isPro()) {
			const gate = containerEl.createDiv({ cls: "semlink-pro-gate" });
			gate.createSpan({ cls: "semlink-pro-badge", text: "Pro" });
			gate.createSpan({ cls: "semlink-pro-gate-text", text: t("botProDesc") });
			const btn = gate.createEl("button", { cls: "mod-cta", text: t("unlockPro") });
			btn.addEventListener("click", () => {
				new LicenseModal(this.app, this.plugin).open();
			});
			return;
		}

		containerEl.createDiv({ cls: "feishu-prereq", text: t("botPrereq") });

		const bots = this.plugin.settings.feishuBots;
		if (bots.length === 0) {
			containerEl.createDiv({ cls: "feishu-empty", text: t("botEmpty") });
		}

		for (let i = 0; i < bots.length; i++) {
			const bot = bots[i];
			const status = bot.connected ? t("botStatusConnected") : t("botStatusDisconnected");
			let desc = `${t("botAppId")}: ${bot.appId} · ${t("botStatus")}: ${status}`;
			if (bot.bound) {
				desc += ` · ${t("botBound")}`;
			} else if (bot.bindCode) {
				desc += ` · ${t("botBindPending")}（${t("botBindHint").replace("{code}", bot.bindCode)}）`;
			}
			if (bot.lastError) desc += ` · ${bot.lastError}`;

			new Setting(containerEl)
				.setName(bot.name || bot.appId)
				.setDesc(desc)
				.addToggle((toggle) =>
					toggle
						.setValue(bot.enabled)
						.onChange(async (value) => {
							bot.enabled = value;
							await this.plugin.saveSettings();
							rerenderSettingsTab(this);
						})
				)
				.addExtraButton((btn) => {
					btn.setIcon("trash").setTooltip(t("botDelete")).onClick(async () => {
						bots.splice(i, 1);
						await this.plugin.saveSettings();
						rerenderSettingsTab(this);
					});
				});
		}

		// Inline scan-to-add section: the QR appears directly in the settings
		// page and the user scans it with the Feishu app.
		new Setting(containerEl).setName(t("botAddScan")).setHeading();
		this.renderFeishuScan(containerEl);

		// Manual entry as an alternative.
		new Setting(containerEl).addButton((btn) => {
			btn.setButtonText(t("botAddManual")).onClick(() => {
				new AddFeishuBotModal(this.app, this.plugin, () => rerenderSettingsTab(this)).open();
			});
		});
	}

	/** Show the scan QR inline and bind the created app when scanned. */
	private renderFeishuScan(container: HTMLElement): void {
		const box = container.createDiv({ cls: "feishu-scan-box" });
		const statusEl = box.createDiv({ cls: "feishu-scan-status", text: t("botScanWaiting") });

		this.feishuScanHandle?.abort();
		this.feishuScanHandle = startFeishuRegister(
			"Semlink",
			(url) => {
				void QRCode.toDataURL(url, { width: 200, margin: 1 }).then((dataUrl) => {
					if (!box.isConnected) return;
					box.createEl("img", { cls: "feishu-qr", attr: { src: dataUrl, alt: "QR" } });
					statusEl.setText(t("botScanHint"));
				}).catch(() => {
					statusEl.setText(t("botScanError"));
				});
			},
			(status) => {
				statusEl.setText(`${t("botScanWaiting")} (${status})`);
			},
		);

		this.feishuScanHandle.promise
			.then(async (res) => {
				// One-time bind code: the user confirms the binding in Feishu by
				// sending `/bind <code>` to the bot (ZCode-style flow).
				const bindCode = Math.random().toString(36).slice(2, 8).toUpperCase();
				this.plugin.settings.feishuBots.push({
					id: `bot-${Date.now()}`,
					name: res.userName || "Feishu Bot",
					appId: res.appId,
					appSecret: res.appSecret,
					userOpenId: res.userOpenId,
					bindCode,
					bound: false,
					enabled: true,
					connected: false,
				});
				await this.plugin.saveSettings();
				new Notice(`${t("botSaved")} · ${t("botBindHint").replace("{code}", bindCode)}`);
				rerenderSettingsTab(this);
			})
			.catch((e) => {
				if (!box.isConnected) return;
				const msg = e instanceof Error ? e.message : String(e);
				statusEl.setText(`${t("botScanError")}: ${msg}`);
			});
	}
}


/** "Edit MCP server" 配置弹窗（参照 Cherry Studio）：Form/JSON 双视图。
 *  Form 视图可编辑端口与访问 Key；JSON 视图为生成的客户端接入配置。
 *  保存后若服务正在运行则自动重启使新配置生效。 */
class EditMcpServerModal extends Modal {
	constructor(
		app: App,
		private plugin: SmartVaultPlugin,
		private onSaved: () => void,
	) {
		super(app);
		this.modalEl.addClass("semlink-mcp-edit-modal");
		this.modalEl.addClass("smart-vault-settings");
	}

	onOpen(): void {
		this.titleEl.setText(t("editMcpServer"));
		const { contentEl } = this;
		contentEl.createDiv({ cls: "semlink-mcp-edit-desc", text: t("editMcpServerDesc") });

		let port = this.plugin.settings.mcpPort;
		let apiKey = this.plugin.settings.mcpApiKey;
		const buildJson = (): string => {
			const url = `http://127.0.0.1:${port}/mcp`;
			return JSON.stringify(
				{
					semlink: {
						type: "http",
						url,
						...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
					},
				},
				null,
				2,
			);
		};

		// ── Form / JSON 切换（分段控件居左，按钮自带按压缩放） ──
		const segRow = contentEl.createDiv({ cls: "semlink-mcp-edit-segrow" });
		const seg = segRow.createDiv({ cls: "semlink-mcp-edit-seg" });
		const formBtn = seg.createEl("button", { cls: "is-active", text: "Form" });
		const jsonBtn = seg.createEl("button", { text: "JSON" });

		const formView = contentEl.createDiv({ cls: "semlink-mcp-edit-form" });
		const jsonView = contentEl.createDiv({ cls: "semlink-mcp-edit-json semlink-hidden" });
		const jsonArea = jsonView.createEl("textarea", { cls: "semlink-monospace" });
		jsonArea.rows = 12;
		jsonArea.readOnly = true;
		jsonArea.value = buildJson();
		// JSON 视图是生成的接入配置：一键复制，粘进客户端即可。
		const jsonCopyBtn = jsonView.createEl("button", {
			cls: "semlink-btn-secondary semlink-mcp-json-copy",
			text: t("mcpJsonCopy"),
		});
		jsonCopyBtn.addEventListener("click", () => {
			void navigator.clipboard.writeText(jsonArea.value)
				.then(() => new Notice(t("mcpCopied")))
				.catch(() => new Notice(t("mcpCopyFailed")));
		});

		const syncJson = (): void => {
			jsonArea.value = buildJson();
		};

		// ── 行内校验的表单字段包：label + input + 错误行（12.5px 红），
		//    blur 展示校验、input 即时宽恕/复查；保存时聚焦第一个错误字段。 ──
		const attachError = (field: HTMLElement): ((msg: string) => void) => {
			const errorEl = field.createDiv({ cls: "semlink-mcp-field-error" });
			return (msg: string): void => {
				field.toggleClass("has-error", !!msg);
				errorEl.setText(msg);
			};
		};
		const focusField = (input: HTMLElement): void => {
			input.scrollIntoView({ block: "center", behavior: "smooth" });
			input.focus();
		};

		// 端口字段：必填 1-65535（非法不再静默回退，保存被行内错误拦下）。
		const portField = formView.createDiv({ cls: "semlink-mcp-field" });
		portField.createDiv({ cls: "semlink-editor-field-label", text: t("mcpPort") });
		const portInput = portField.createEl("input", {
			cls: "semlink-editor-input",
			attr: { type: "text", placeholder: "3001", spellcheck: "false", inputmode: "numeric" },
		});
		portInput.value = String(port);
		const setPortError = attachError(portField);
		const portMsg = (): string => {
			const n = Number(portInput.value.trim());
			return Number.isInteger(n) && n >= 1 && n <= 65535 ? "" : t("mcpPortInvalid");
		};
		portInput.addEventListener("input", () => {
			const msg = portMsg();
			setPortError(msg);
			if (!msg) {
				port = Number(portInput.value.trim());
				syncJson();
			}
		});
		portInput.addEventListener("blur", () => setPortError(portMsg()));

		// 访问 Key：可空，无校验。
		const keyField = formView.createDiv({ cls: "semlink-mcp-field" });
		keyField.createDiv({ cls: "semlink-editor-field-label", text: t("mcpAccessKey") });
		const keyInput = keyField.createEl("input", {
			cls: "semlink-editor-input",
			attr: { type: "text", spellcheck: "false", autocomplete: "off" },
		});
		keyInput.value = apiKey;
		keyInput.addEventListener("input", () => {
			apiKey = keyInput.value;
			syncJson();
		});

		const setView = (json: boolean): void => {
			formView.toggleClass("semlink-hidden", json);
			jsonView.toggleClass("semlink-hidden", !json);
			formBtn.toggleClass("is-active", !json);
			jsonBtn.toggleClass("is-active", json);
		};
		formBtn.addEventListener("click", () => setView(false));
		jsonBtn.addEventListener("click", () => setView(true));

		// ── Footer：右侧 Save / Cancel ──
		const footer = contentEl.createDiv({ cls: "semlink-editor-footer is-simple" });
		const cancelBtn = footer.createEl("button", { cls: "semlink-editor-cancel-btn", text: t("cancel") });
		cancelBtn.addEventListener("click", () => this.close());
		const saveBtn = footer.createEl("button", { cls: "semlink-editor-save-btn", text: t("editorSave") });

		saveBtn.addEventListener("click", () => {
			const msg = portMsg();
			if (msg) {
				// 有错不提交：行内报错 + 滚动聚焦第一个错误字段。
				setPortError(msg);
				focusField(portInput);
				return;
			}
			const persist = async (): Promise<void> => {
				this.plugin.settings.mcpPort = port;
				this.plugin.settings.mcpApiKey = keyInput.value;
				await this.plugin.saveSettings();
				// 端口/Key 变更需要重启才生效；没在运行则不主动拉起
				if (this.plugin.mcpServer) await this.plugin.restartMcpServer();
				this.close();
				this.onSaved();
			};
			void persist();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** 外部 MCP 服务器的增/改弹窗：Name + Type（http/sse/stdio）+ URL/Command。
 *  编辑态带 Delete（删除走确认）。内置 semlink 不走这个弹窗。 */
class McpServerConfigModal extends Modal {
	constructor(
		app: App,
		private plugin: SmartVaultPlugin,
		/** null = 新增；否则为被编辑的条目。 */
		private server: McpClientServer | null,
		private onDone: () => void,
	) {
		super(app);
		this.modalEl.addClass("semlink-mcp-edit-modal");
		this.modalEl.addClass("semlink-mcp-client-modal");
		// editor-input/select/footer 的样式都挂在 .smart-vault-settings 下
		this.modalEl.addClass("smart-vault-settings");
	}

	onOpen(): void {
		const editing = this.server !== null;
		this.titleEl.setText(editing ? t("editMcpServer") : t("mcpNew"));
		const { contentEl } = this;

		// ── 行内校验基建：字段包（label + input + 错误行）；blur 展示校验、
		//    input 即时宽恕/复查；保存时聚焦第一个错误字段，不提交。 ──
		const makeField = (host: HTMLElement, label: string): { field: HTMLElement } => {
			const field = host.createDiv({ cls: "semlink-mcp-field" });
			field.createDiv({ cls: "semlink-editor-field-label", text: label });
			return { field };
		};
		const attachError = (field: HTMLElement): ((msg: string) => void) => {
			const errorEl = field.createDiv({ cls: "semlink-mcp-field-error" });
			return (msg: string): void => {
				field.toggleClass("has-error", !!msg);
				errorEl.setText(msg);
			};
		};
		const bindLive = (input: HTMLElement, set: (msg: string) => void, validate: () => string): void => {
			input.addEventListener("input", () => set(validate()));
			input.addEventListener("blur", () => set(validate()));
		};
		const focusField = (input: HTMLElement): void => {
			input.scrollIntoView({ block: "center", behavior: "smooth" });
			input.focus();
		};

		// ── Form / JSON 切换（分段控件居左，同内置服务配置弹窗） ──
		const segRow = contentEl.createDiv({ cls: "semlink-mcp-edit-segrow" });
		const seg = segRow.createDiv({ cls: "semlink-mcp-edit-seg" });
		const formBtn = seg.createEl("button", { cls: "is-active", text: "Form" });
		const jsonBtn = seg.createEl("button", { text: "JSON" });
		const formView = contentEl.createDiv({ cls: "semlink-mcp-edit-form" });
		const jsonView = contentEl.createDiv({ cls: "semlink-mcp-edit-json semlink-hidden" });

		// ── Form：Name / Type / Timeout / Protocol / URL|Command+Args / Headers ──
		const nameFieldInfo = makeField(formView, t("mcpServerName"));
		const nameInput = nameFieldInfo.field.createEl("input", {
			cls: "semlink-editor-input",
			attr: { type: "text", placeholder: "my-mcp-server", spellcheck: "false" },
		});
		nameInput.value = this.server?.name ?? "";
		const setNameError = attachError(nameFieldInfo.field);
		const nameMsg = (): string => (nameInput.value.trim() ? "" : t("mcpNameRequired"));
		bindLive(nameInput, setNameError, nameMsg);

		const typeFieldInfo = makeField(formView, t("mcpServerType"));
		const typeSel = typeFieldInfo.field.createEl("select", { cls: "semlink-editor-select" });
		for (const [value, label] of [["http", "HTTP"], ["sse", "SSE"], ["stdio", "stdio"]] as const) {
			typeSel.createEl("option", { value, text: label });
		}
		typeSel.value = this.server?.type ?? "http";

		const timeoutFieldInfo = makeField(formView, t("mcpTimeoutMs"));
		const timeoutInput = timeoutFieldInfo.field.createEl("input", {
			cls: "semlink-editor-input",
			attr: { type: "text", placeholder: "30000", spellcheck: "false", inputmode: "numeric" },
		});
		timeoutInput.value = this.server?.timeoutMs ? String(this.server.timeoutMs) : "";
		const setTimeoutError = attachError(timeoutFieldInfo.field);
		const timeoutMsg = (): string => {
			const raw = timeoutInput.value.trim();
			if (!raw) return "";
			const n = Number(raw);
			return Number.isInteger(n) && n > 0 ? "" : t("mcpErrTimeout");
		};
		bindLive(timeoutInput, setTimeoutError, timeoutMsg);

		const protoFieldInfo = makeField(formView, t("mcpProtocolVersion"));
		const protoSel = protoFieldInfo.field.createEl("select", { cls: "semlink-editor-select" });
		for (const [value, label] of [
			["", t("mcpProtocolAuto")],
			["2025-06-18", "2025-06-18"],
			["2025-03-26", "2025-03-26"],
			["2024-11-05", "2024-11-05"],
		] as const) {
			protoSel.createEl("option", { value, text: label });
		}
		protoSel.value = this.server?.protocolVersion ?? "";
		protoFieldInfo.field.createDiv({ cls: "semlink-mcp-edit-desc", text: t("mcpProtocolHint") });

		const urlFieldInfo = makeField(formView, t("mcpServerUrl"));
		const urlInput = urlFieldInfo.field.createEl("input", {
			cls: "semlink-editor-input",
			attr: { type: "text", placeholder: "https://mcp.example.com/mcp", spellcheck: "false" },
		});
		urlInput.value = this.server?.url ?? "";
		const setUrlError = attachError(urlFieldInfo.field);
		const urlMsg = (): string => {
			if (typeSel.value === "stdio") return "";
			return /^https?:\/\//.test(urlInput.value.trim()) ? "" : t("mcpErrUrl");
		};
		bindLive(urlInput, setUrlError, urlMsg);

		const headersFieldInfo = makeField(formView, `${t("mcpServerHeaders")} (JSON)`);
		const headersInput = headersFieldInfo.field.createEl("textarea", {
			cls: "semlink-editor-input semlink-monospace",
		});
		headersInput.rows = 4;
		headersInput.placeholder = "{" + "\n" + '  "Authorization": "Bearer your-token"' + "\n" + "}";
		const serverHeaders = this.server?.headers ?? {};
		headersInput.value = Object.keys(serverHeaders).length > 0 ? JSON.stringify(serverHeaders, null, 2) : "";

		const cmdFieldInfo = makeField(formView, t("mcpServerCommand"));
		const cmdInput = cmdFieldInfo.field.createEl("input", {
			cls: "semlink-editor-input",
			attr: { type: "text", placeholder: "npx -y @some/mcp", spellcheck: "false" },
		});
		cmdInput.value = this.server?.command ?? "";
		const setCmdError = attachError(cmdFieldInfo.field);
		const cmdMsg = (): string => {
			if (typeSel.value !== "stdio") return "";
			return cmdInput.value.trim() ? "" : t("mcpErrCommand");
		};
		bindLive(cmdInput, setCmdError, cmdMsg);

		const argsFieldInfo = makeField(formView, t("mcpServerArgs"));
		const argsInput = argsFieldInfo.field.createEl("input", {
			cls: "semlink-editor-input",
			attr: { type: "text", placeholder: "--port 8080 --verbose", spellcheck: "false" },
		});
		argsInput.value = this.server?.args ?? "";

		// http/sse ↔ stdio 互斥显隐（整字段包切换）
		const syncType = (): void => {
			const isStdio = typeSel.value === "stdio";
			urlFieldInfo.field.toggleClass("semlink-hidden", isStdio);
			headersFieldInfo.field.toggleClass("semlink-hidden", isStdio);
			cmdFieldInfo.field.toggleClass("semlink-hidden", !isStdio);
			argsFieldInfo.field.toggleClass("semlink-hidden", !isStdio);
		};
		typeSel.addEventListener("change", () => {
			syncType();
			// 切类型即时复查两端的校验态（隐藏端清错）。
			setUrlError(urlMsg());
			setCmdError(cmdMsg());
		});
		syncType();

		// ── JSON 视图：完整配置（可粘贴 {"name":{…}} / {"mcpServers":{…}} 回填） ──
		jsonView.createDiv({ cls: "semlink-editor-field-label", text: t("mcpFullConfig") });
		const jsonArea = jsonView.createEl("textarea", { cls: "semlink-editor-input semlink-monospace" });
		jsonArea.rows = 12;
		jsonView.createDiv({ cls: "semlink-mcp-edit-desc", text: t("mcpJsonPasteHint") });
		const jsonCopyBtn = jsonView.createEl("button", {
			cls: "semlink-btn-secondary semlink-mcp-json-copy",
			text: t("mcpJsonCopy"),
		});
		jsonCopyBtn.addEventListener("click", () => {
			void navigator.clipboard.writeText(jsonArea.value)
				.then(() => new Notice(t("mcpCopied")))
				.catch(() => new Notice(t("mcpCopyFailed")));
		});

		const headersOfForm = (): Record<string, string> => {
			const raw = headersInput.value.trim();
			if (!raw) return {};
			const out: Record<string, string> = {};
			try {
				const obj = JSON.parse(raw) as Record<string, unknown>;
				for (const [k, v] of Object.entries(obj)) out[k] = String(v);
			} catch {
				return {};
			}
			return out;
		};
		const buildJson = (): string => {
			const isStdio = typeSel.value === "stdio";
			const name = nameInput.value.trim() || "my-mcp-server";
			const timeout = parseInt(timeoutInput.value, 10);
			const server: Record<string, unknown> = { type: typeSel.value };
			if (isStdio) {
				server.command = cmdInput.value.trim();
				server.args = argsInput.value.trim() ? argsInput.value.trim().split(/\s+/) : [];
			} else {
				server.url = urlInput.value.trim();
				const headers = headersOfForm();
				if (Object.keys(headers).length > 0) server.headers = headers;
			}
			if (!isNaN(timeout) && timeout > 0) server.timeoutMs = timeout;
			if (protoSel.value) server.protocolVersion = protoSel.value;
			return JSON.stringify({ [name]: server }, null, 2);
		};

		const setView = (json: boolean): void => {
			formView.toggleClass("semlink-hidden", json);
			jsonView.toggleClass("semlink-hidden", !json);
			formBtn.toggleClass("is-active", !json);
			jsonBtn.toggleClass("is-active", json);
			if (json) jsonArea.value = buildJson();
		};
		formBtn.addEventListener("click", () => setView(false));
		jsonBtn.addEventListener("click", () => setView(true));
		// 表单变化时同步 JSON 视图（切到 JSON 视图也会重建一次）
		for (const el of [nameInput, typeSel, timeoutInput, protoSel, urlInput, cmdInput, argsInput, headersInput]) {
			const sync = (): void => {
				if (!jsonView.hasClass("semlink-hidden")) jsonArea.value = buildJson();
			};
			el.addEventListener("input", sync);
			el.addEventListener("change", sync);
		}

		const error = contentEl.createDiv({ cls: "semlink-guide-error semlink-hidden" });

		// ── Footer：编辑态带 Delete（确认框说后果），右侧 Save / Cancel ──
		const footer = contentEl.createDiv({ cls: "semlink-editor-footer is-simple" });
		if (editing) {
			const delBtn = footer.createEl("button", { cls: "semlink-editor-delete-link", text: t("mcpDeleteAction") });
			delBtn.addEventListener("click", () => {
				const targetName = this.server?.name ?? "";
				new ConfirmModal(
					this.app,
					t("mcpDeleteTitle").replace("{name}", targetName),
					t("mcpDeleteBody"),
					() => {
						this.plugin.settings.mcpClientServers = (this.plugin.settings.mcpClientServers ?? []).filter((x) => x.id !== this.server!.id);
						void this.plugin.saveSettings();
						this.close();
						this.onDone();
					},
					t("mcpDeleteAction"),
				).open();
			});
		}
		const cancelBtn = footer.createEl("button", { cls: "semlink-editor-cancel-btn", text: t("cancel") });
		cancelBtn.addEventListener("click", () => this.close());
		const saveBtn = footer.createEl("button", { cls: "semlink-editor-save-btn", text: t("editorSave") });

		saveBtn.addEventListener("click", () => {
			// JSON 视图激活时：解析粘贴的完整配置（{"name":{…}} / {"mcpServers":{…}}）
			// 回填表单，然后走同一条行内校验路径。
			if (!jsonView.hasClass("semlink-hidden")) {
				try {
					const parsed = JSON.parse(jsonArea.value) as Record<string, unknown>;
					const servers = (parsed.mcpServers ?? parsed) as Record<string, Record<string, unknown>>;
					const firstKey = Object.keys(servers)[0];
					if (!firstKey || typeof servers[firstKey] !== "object" || servers[firstKey] === null) {
						throw new Error("empty");
					}
					const s = servers[firstKey];
					nameInput.value = firstKey;
					typeSel.value = typeof s.type === "string" ? s.type : (s.command ? "stdio" : "http");
					urlInput.value = typeof s.url === "string" ? s.url : "";
					cmdInput.value = typeof s.command === "string" ? s.command : "";
					argsInput.value = Array.isArray(s.args) ? (s.args as unknown[]).map(String).join(" ")
						: typeof s.args === "string" ? s.args : "";
					headersInput.value = s.headers && typeof s.headers === "object"
						? JSON.stringify(s.headers, null, 2)
						: "";
				} catch {
					error.setText(t("mcpJsonInvalid"));
					error.removeClass("semlink-hidden");
					return;
				}
				syncType();
			}
			// 行内校验：名称必填 / Timeout 正整数 / URL http 开头 / stdio 命令必填。
			setNameError(nameMsg());
			setTimeoutError(timeoutMsg());
			setUrlError(urlMsg());
			setCmdError(cmdMsg());
			for (const [input, msg] of [
				[nameInput, nameMsg()],
				[timeoutInput, timeoutMsg()],
				[urlInput, urlMsg()],
				[cmdInput, cmdMsg()],
			] as Array<[HTMLInputElement, string]>) {
				if (msg) {
					focusField(input);
					return;
				}
			}
			const name = nameInput.value.trim();
			const isStdio = typeSel.value === "stdio";
			const url = urlInput.value.trim();
			const command = cmdInput.value.trim();
			const args = argsInput.value.trim();
			const headersRaw = headersInput.value.trim();
			const protocol = protoSel.value;
			let headers: Record<string, string> | undefined;
			if (!isStdio && headersRaw) {
				try {
					const obj = JSON.parse(headersRaw) as Record<string, unknown>;
					headers = {};
					for (const [k, v] of Object.entries(obj)) headers[k] = String(v);
				} catch {
					error.setText(t("mcpJsonInvalid"));
					error.removeClass("semlink-hidden");
					return;
				}
			}
			const timeout = parseInt(timeoutInput.value.trim(), 10);
			const shared = {
				name,
				type: typeSel.value as McpClientServer["type"],
				...(isStdio
					? { command, args: args || undefined }
					: { url, ...(headers && Object.keys(headers).length > 0 ? { headers } : {}) }),
				...(isNaN(timeout) || timeout <= 0 ? {} : { timeoutMs: timeout }),
				...(protocol ? { protocolVersion: protocol } : {}),
			};
			const list = this.plugin.settings.mcpClientServers ??= [];
			if (editing && this.server) {
				Object.assign(this.server, shared);
				if (isStdio) { delete this.server.url; delete this.server.headers; }
				else { delete this.server.command; delete this.server.args; }
			} else {
				list.push({ id: `mcp-${Date.now()}`, ...shared, enabled: true });
			}
			void this.plugin.saveSettings();
			this.close();
			this.onDone();
		});
	}
	onClose(): void {
		this.contentEl.empty();
	}
}

/** 分享弹窗：把 semlink MCP 集成到第三方客户端（Claude Code 命令 +
 *  通用 mcpServers JSON），每段带一键复制。 */
class McpShareModal extends Modal {
	constructor(app: App, private plugin: SmartVaultPlugin) {
		super(app);
		this.modalEl.addClass("semlink-mcp-edit-modal");
		this.modalEl.addClass("smart-vault-settings");
	}

	onOpen(): void {
		this.titleEl.setText(t("mcpShareTitle"));
		const { contentEl } = this;
		const mcpUrl = `http://127.0.0.1:${this.plugin.settings.mcpPort}/mcp`;
		const key = this.plugin.settings.mcpApiKey;

		const copy = (text: string): void => {
			void navigator.clipboard.writeText(text).then(() => new Notice(t("mcpCopied")));
		};

		const section = (label: string, desc: string, code: string): HTMLElement => {
			const wrap = contentEl.createDiv({ cls: "semlink-mcp-share-section" });
			const head = wrap.createDiv({ cls: "semlink-mcp-share-head" });
			const textCol = head.createDiv({ cls: "semlink-mcp-share-text" });
			textCol.createDiv({ cls: "semlink-mcp-share-label", text: label });
			textCol.createDiv({ cls: "semlink-mcp-share-desc", text: desc });
			const copyBtn = head.createEl("button", {
				cls: "semlink-mcp-icon-btn",
				attr: { "aria-label": t("mcpShareCopy") },
			});
			setIcon(copyBtn, "copy");
			copyBtn.addEventListener("click", () => copy(code));
			wrap.createEl("pre", { cls: "semlink-mcp-share-code", text: code });
			return wrap;
		};

		section(
			t("claudeCodeCmd"),
			t("claudeCodeDesc"),
			t("mcpConnectInstruction").replace("{url}", mcpUrl),
		);

		section(
			t("claudeDesktopConfig"),
			t("claudeDesktopDesc"),
			JSON.stringify(
				{ semlink: { type: "http", url: mcpUrl, ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}) } },
				null,
				2,
			),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** 排除路径编辑弹窗：Index 面板的「编辑」按钮打开，每行一个前缀。 */
class ExcludePathsModal extends Modal {
	constructor(app: App, private plugin: SmartVaultPlugin) {
		super(app);
		this.modalEl.addClass("semlink-mcp-edit-modal");
		this.modalEl.addClass("smart-vault-settings");
	}

	onOpen(): void {
		this.titleEl.setText(t("excludePaths"));
		const { contentEl } = this;
		contentEl.createDiv({ cls: "semlink-mcp-edit-desc", text: t("excludePathsDesc") });
		const textarea = contentEl.createEl("textarea", { cls: "semlink-editor-input" });
		textarea.rows = 8;
		textarea.placeholder = t("excludePathsPlaceholder");
		textarea.value = this.plugin.settings.excludePaths;
		// 右对齐实时计数：trim 后非空的行数（空行不计入排除规则）。
		const countEl = contentEl.createDiv({ cls: "semlink-exclude-count" });
		const syncCount = (): void => {
			const n = textarea.value.split("\n").map((l) => l.trim()).filter(Boolean).length;
			countEl.setText(t("excludePathCount").replace("{n}", String(n)));
		};
		textarea.addEventListener("input", syncCount);
		syncCount();
		const footer = contentEl.createDiv({ cls: "semlink-editor-footer is-simple" });
		const cancelBtn = footer.createEl("button", { cls: "semlink-btn-ghost", text: t("cancel") });
		cancelBtn.addEventListener("click", () => this.close());
		const saveBtn = footer.createEl("button", { cls: "semlink-btn-primary", text: t("editorSave") });
		saveBtn.addEventListener("click", () => {
			this.plugin.settings.excludePaths = textarea.value;
			void this.plugin.saveSettings().then(() => this.close());
		});
		textarea.focus();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** 视图内嵌设置屏入口（search-view 的设置按钮/管理模型入口共用）：
 *  实例化设置 Tab 并渲染进给定容器，返回 destroy 句柄供退出时清理。 */
export function renderSettingsTabInto(
	container: HTMLElement,
	plugin: SmartVaultPlugin,
	tab?: SettingsTab,
): { destroy(): void; tab: SmartVaultSettingTab } {
	const view = new SmartVaultSettingTab(plugin.app, plugin);
	view.displayInto(container, { tab });
	return {
		destroy: () => view.destroy(),
		tab: view,
	};
}
