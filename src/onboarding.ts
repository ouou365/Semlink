// ========================================
// Semlink - First-run onboarding guide
// ========================================
// Conversational setup guide rendered on the search welcome screen.
// CHAT-FIRST and embedding-free: a single screen walks the user through
// Provider → Key → Model (the stepper mirrors that sub-progress). Embedding
// and data indexing are an EXTENSION, configured later in Settings when
// needed — the agent answers without vectors and can ground itself via
// grep_notes/get_note, which need no embeddings. Each key is validated by
// fetching the provider's model list before the model picker shows. All
// state lives in `settings.onboarding`, so the guide survives re-renders
// (time-slot refresh, language switch) and restarts.

import { Modal, ToggleComponent, setIcon } from "obsidian";
import { AddModelModal, AddProviderModal, brandLogoOf, buildGuideProviderGroups, catalogEndpoint, CHAT_CATALOG, fetchAvailableModels, fetchModelIds, formatContextWindow, providerLogo, setSvgIcon } from "./settings-models";
import type { FetchedModel } from "./settings-models";
import { t } from "./i18n";
import type SmartVaultPlugin from "../main";
import type { ChatApiFormat, ChatModel, ModelProvider } from "./types";

/** Live index stats for the guide's final step (mapped from IndexProgress). */
export interface IndexStatsView {
	processed: number;
	total: number;
	embeddedChunks: number;
	failedChunks: number;
	skippedChunks: number;
	totalChunks: number;
	currentFile: string;
	avgResponseMs: number;
	fileChunkProgress: string;
	activeFiles: Array<{ path: string; progress: string }>;
	estimatedRemainingSec: number;
}

export interface OnboardingViewHost {
	/** Show/hide the composer while the guide owns the welcome screen. */
	setGuideChrome(active: boolean): void;
}

/** Console URLs where a provider's API key can be created — fallback only
 *  for catalog entries without keysUrl (e.g. Xiaomi / Z.AI Coding). */
const PROVIDER_CONSOLE: Record<string, string> = {
	"SiliconFlow": "https://cloud.siliconflow.cn/i/9BDh114N",
	"DeepSeek": "https://platform.deepseek.com/api_keys",
	"Moonshot CN": "https://platform.moonshot.cn/console/api-keys",
	"Z.AI CN": "https://open.bigmodel.cn/usercenter/apikeys",
	"Kimi For Coding": "https://www.kimi.com/code",
	"OpenAI": "https://platform.openai.com/api-keys",
	"Anthropic": "https://console.anthropic.com/settings/keys",
	"OpenRouter": "https://openrouter.ai/settings/keys",
	"MiniMax CN": "https://platform.minimaxi.com/user-center/basic-information/interface-key",
	"Xiaomi": "https://platform.xiaomimimo.com",
};

/** Fallback context window for fetched models without a reported one —
 *  mirrors the settings page's generic default. */
const FALLBACK_CONTEXT = 128000;


/** The guide only shows for genuinely-new setups: never finished and no
 *  provider carries a key yet (existing users are never bothered). */
export function onboardingActive(plugin: SmartVaultPlugin): boolean {
	if (plugin.settings.onboarding?.done) return false;
	return !plugin.settings.providers.some((p) => p.apiKey.trim());
}

/** True while a guide run is mid-flight — a provider has been picked but the
 *  guide isn't finished yet. Keeps the guide on screen across settings-save
 *  re-renders even after the first key makes onboardingActive() false. */
export function guideInProgress(plugin: SmartVaultPlugin): boolean {
	const ob = plugin.settings.onboarding;
	return !ob?.done && !!(ob?.providerId || ob?.embedProviderId);
}

// ──── Guide root ────

/** Render the guide into `container` (the welcome block). `onFinish` closes
 *  the guide (skip) and lets the view re-render the plain welcome screen. */
export function renderOnboarding(
	container: HTMLElement,
	plugin: SmartVaultPlugin,
	onFinish: () => void,
): void {
	const root = container.createDiv({ cls: "semlink-guide" });

	const ob = (): NonNullable<SmartVaultPlugin["settings"]["onboarding"]> => plugin.settings.onboarding ?? {};
	const byId = (id?: string): ModelProvider | undefined =>
		id ? plugin.settings.providers.find((p) => p.id === id) : undefined;

	const onRestart = (): void => {
		plugin.settings.onboarding = { done: false };
		void plugin.saveSettings();
		rerender();
	};

	const rerender = (): void => {
		root.empty();

		renderIntro(root);

		// ONE step, chat-first: the model screen walks Provider → Key →
		// Model. The stepper mirrors that sub-progress from state. Embedding
		// and data indexing are intentionally not part of the guide — the
		// Embedding tab configures them and Auto Index keeps it fresh.
		const providerPicked = !!ob().providerId;
		const active: 1 | 2 | 3 = !providerPicked ? 1 : !ob().chatReady ? 2 : 3;
		const sticky = root.createDiv({ cls: "semlink-guide-sticky-top" });
		renderStepper(sticky, active, false);
		const modelsHost = sticky.createDiv({ cls: "semlink-guide-models" });

		// ── 对话模型（唯一步骤）── picking completes the guide.
		renderModelStep(root, plugin, {
			kind: "chat",
			providerId: ob().providerId,
			ready: ob().chatReady,
			modelsHost,
			onPickProvider: (p) => {
				// 始终经过第二步的 Key 配置（已填的 Key 会预填，用户确认后
				// Test & Save 再进模型步骤），即使该供应商早已有 Key。
				plugin.settings.onboarding = { ...(plugin.settings.onboarding ?? {}), providerId: p.id, chatReady: false };
				void plugin.saveSettings();
				rerender();
			},
			onValidated: () => {
				plugin.settings.onboarding = { ...(plugin.settings.onboarding ?? {}), chatReady: true };
				void plugin.saveSettings();
				rerender();
			},
			onModelPicked: (p, models) => {
				// Curate: the picked models stay enabled, every other chat
				// model of this provider is disabled; the first picked is
				// the default chat model. Picking completes the guide.
				const pickedIds = new Set(models.map((m) => m.id));
				for (const m of p.models) {
					if ((m.kind ?? "chat") !== "chat") continue;
					m.enabled = pickedIds.has(m.id);
				}
				// 通过 chatClient 选中：内存态 activeModelKey 与设置同步，
				// 视图里的模型标签立即生效（直接写 settings 不会刷新视图）。
				plugin.chatClient.setActiveModel(p.id, models[0].id);
				plugin.settings.onboarding = { ...(plugin.settings.onboarding ?? {}), chatModelPicked: true, done: true };
				void plugin.saveSettings();
				onFinish();
			},
			onBackToKey: () => {
				// 回到 Key 配置：保留供应商，仅清除已校验标记（第二步会预填 Key）
				plugin.settings.onboarding = { ...(plugin.settings.onboarding ?? {}), chatReady: false };
				void plugin.saveSettings();
				rerender();
			},
			onReselect: () => {
				const p = byId(ob().providerId);
				if (p && !p.apiKey.trim()) {
					plugin.settings.providers = plugin.settings.providers.filter((x) => x.id !== p.id);
				}
				plugin.settings.onboarding = { ...(plugin.settings.onboarding ?? {}), providerId: undefined, chatReady: false };
				void plugin.saveSettings();
				rerender();
			},
			onRestart,
		});

	};

	rerender();
}

// ──── Stepper ────

/** Overall progress: three labeled dots pinned to the top of the panel
 *  (✓ when passed, accent when active). Steps the user has already earned
 *  are clickable — `onJump(i)` fires for a tap on an unlocked, non-active
 *  step (backwards navigation only; never forward past the flow). */
function renderStepper(
	root: HTMLElement,
	active: 1 | 2 | 3,
	done: boolean,
	onJump?: (target: 1 | 2 | 3) => void,
	canJump?: (target: 1 | 2 | 3) => boolean,
): void {
	const labels = [t("guideStep1"), t("guideStep2"), t("guideStep3")];
	const stepsEl = root.createDiv({ cls: "semlink-guide-stepper" });
	for (let i = 1; i <= 3; i++) {
		const target = i as 1 | 2 | 3;
		const isPast = i < active || done;
		const jumpable = !!onJump && i !== active && !!canJump?.(target);
		const step = stepsEl.createDiv({
			cls: `semlink-guide-step${isPast ? " is-done" : i === active ? " is-active" : ""}${jumpable ? " is-clickable" : ""}`,
		});
		step.createDiv({ cls: "semlink-guide-step-dot", text: isPast ? "✓" : String(i) });
		step.createDiv({ cls: "semlink-guide-step-label", text: labels[i - 1] });
		if (jumpable) {
			step.addEventListener("click", () => onJump?.(target));
		}
	}
}

// ──── Shared fragments ────

/** Step hero above the stepper — same visual language as the plain welcome:
 *  floating emoji badge, bold greeting, muted sub line (reuses the
 *  semlink-search-welcome-* classes). */
function renderIntro(root: HTMLElement): void {
	const intro = root.createDiv({ cls: "semlink-guide-intro" });
	const title = t("guideIntroTitle");
	const m = title.match(/^(\p{Extended_Pictographic})\s*(.*)$/u);
	const emoji = m ? m[1] : "";
	const greeting = m ? m[2] : title;
	if (emoji) {
		intro.createDiv({ cls: "semlink-search-welcome-emoji", text: emoji });
	}
	intro.createDiv({ cls: "semlink-search-welcome-greeting", text: greeting });
	intro.createDiv({ cls: "semlink-search-welcome-sub", text: t("guideIntroSub") });
}

/** Create (or reuse) a provider from its catalog entry — keyed by name to
 *  avoid duplicates from repeated guide runs. Returns undefined when the
 *  name is not in the catalog. */
function ensureCatalogProvider(plugin: SmartVaultPlugin, name: string): ModelProvider | undefined {
	const existing = plugin.settings.providers.find((p) => p.name === name);
	if (existing) return existing;
	const entry = CHAT_CATALOG.find((e) => e.name === name);
	if (!entry) return undefined;
	const provider: ModelProvider = {
		id: `provider-${Date.now()}`,
		name: entry.name,
		apiBase: entry.baseUrl,
		apiKey: "",
		apiFormat: entry.apiFormat,
		...(entry.wirePath ? { wirePath: entry.wirePath } : {}),
		models: entry.models.map((m) => ({ ...m })),
	};
	plugin.settings.providers.push(provider);
	return provider;
}

/** 内置目录里已知模型的上下文长度：端点的 /models 一般不报 context，
 *  目录里登记过的模型（如 deepseek-v4-flash → 1M）用它兜底，未知的再退
 *  回通用默认值。 */
function catalogContextWindow(modelId: string): number | undefined {
	for (const entry of CHAT_CATALOG) {
		for (const m of entry.models) {
			if (m.id === modelId) return m.contextWindow;
		}
	}
	return undefined;
}

/** 系列合并卡的二次确认窗口：标题为系列名，列出该系列的成员供应商
 *  （同网格卡片样式、带配置绿点），点选其中一个才真正创建/进入。 */
class SeriesPickModal extends Modal {
	constructor(
		private plugin: SmartVaultPlugin,
		private seriesName: string,
		private members: string[],
		private onPick: (name: string) => void,
	) {
		super(plugin.app);
		this.modalEl.addClass("semlink-guide-series-modal");
	}

	onOpen(): void {
		this.titleEl.setText(this.seriesName);
		const { contentEl } = this;
		const grid = contentEl.createDiv({ cls: "semlink-guide-provider-grid semlink-guide-provider-grid-vertical" });
		for (const member of this.members) {
			const card = grid.createDiv({ cls: "semlink-guide-provider-card" });
			const logo = brandLogoOf(member).svg;
			if (logo) {
				const logoEl = card.createDiv({ cls: "semlink-guide-provider-logo" });
				setSvgIcon(logoEl, logo);
			} else {
				card.createDiv({ cls: "semlink-guide-provider-fallback", text: member.charAt(0).toUpperCase() });
			}
			card.createDiv({ cls: "semlink-guide-provider-name", text: member });
			// 右侧显示完整请求端点（Base URL + 协议路径）
			const entry = CHAT_CATALOG.find((e) => e.name === member);
			if (entry) {
				const endpoint = catalogEndpoint(entry);
				card.createSpan({
					cls: "semlink-guide-provider-endpoint",
					text: endpoint,
					attr: { title: endpoint },
				});
			}
			card.addEventListener("click", () => {
				this.close();
				this.onPick(member);
			});
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// ──── Steps 1 & 2: provider → validate key → pick a model ────

interface ModelStepOptions {
	kind: "chat" | "embed";
	providerId?: string;
	ready?: boolean;
	/** Model-step host container (search + progress/error + cards live here,
	 *  inside the shared sticky wrapper). */
	modelsHost: HTMLElement;
	onPickProvider: (provider: ModelProvider) => void;
	onValidated: () => void;
	onModelPicked: (provider: ModelProvider, models: ChatModel[]) => void;
	/** 模型步骤的"返回"：回到第二步的 Key 配置（保留供应商，仅清除已校验标记）。 */
	onBackToKey: () => void;
	onReselect: () => void;
	onRestart: () => void;
}

function renderModelStep(root: HTMLElement, plugin: SmartVaultPlugin, opts: ModelStepOptions): void {
	// Carried from the key form to the model step when the list fetch fails.
	let fetchHint = "";
	const isChat = opts.kind === "chat";
	const provider = opts.providerId
		? plugin.settings.providers.find((p) => p.id === opts.providerId)
		: undefined;

	// The step owns a private body so step content re-renders without
	// touching the intro/stepper above.
	const body = root.createDiv({ cls: "semlink-guide-body" });
	const modelsHost = opts.modelsHost;

	const redraw = (): void => {
		body.empty();
		// Sub-state C renders its search/list into modelsHost — clear it on
		// every redraw so the old model list never lingers above the form.
		modelsHost.empty();

		// Sub-state A: pick a provider — "Select a provider" 目录弹窗同款卡片
		// 网格；系列文件夹（Z.AI / MiniMax / Xiaomi 系）按设置页的合并规则
		// 合并为一张卡（显示系列名，点击落到最热成员），已配置 Key 置顶。
		if (!provider) {
			const grid = body.createDiv({ cls: "semlink-guide-provider-grid" });
			const ordered = buildGuideProviderGroups(plugin);
			for (const item of ordered) {
				const pickName = item.members?.[0] ?? item.name;
				const providerCard = grid.createDiv({ cls: "semlink-guide-provider-card" });
				const logo = brandLogoOf(pickName).svg;
				if (logo) {
					const logoEl = providerCard.createDiv({ cls: "semlink-guide-provider-logo" });
					setSvgIcon(logoEl, logo);
				} else {
					providerCard.createDiv({
						cls: "semlink-guide-provider-fallback",
						text: item.name.charAt(0).toUpperCase(),
					});
				}
				providerCard.createDiv({ cls: "semlink-guide-provider-name", text: item.name });
				providerCard.addEventListener("click", () => {
					const pick = (name: string): void => {
						const p = ensureCatalogProvider(plugin, name);
						if (p) opts.onPickProvider(p);
					};
					// 系列合并卡：二次确认窗口里选择具体变体；单供应商直接选
					if (item.members) {
						new SeriesPickModal(plugin, item.name, item.members, pick).open();
					} else {
						pick(item.name);
					}
				});
			}

			// 最后一行：自定义供应商（虚线卡，打开自定义供应商表单）
			const customCard = grid.createDiv({
				cls: "semlink-guide-provider-card semlink-guide-provider-card-custom",
			});
			customCard.createDiv({ cls: "semlink-guide-provider-fallback", text: "＋" });
			customCard.createDiv({ cls: "semlink-guide-provider-name", text: t("customProvider") });
			customCard.addEventListener("click", () => {
				new AddProviderModal(plugin.app, plugin, "custom", (p) => opts.onPickProvider(p)).open();
			});

			// 联系链接：点"Contact me/请联系我"唤起邮件客户端
			const contact = body.createDiv({ cls: "semlink-guide-contact" });
			contact.createSpan({ text: `${t("guideContactHint")} ` });
			contact.createEl("a", {
				cls: "semlink-guide-contact-link",
				text: t("guideContactLink"),
				attr: { href: "mailto:support@getsemlink.com" },
			});
			return;
		}

		// Sub-state B: confirm details + key; 下一步 validates the key by
		// fetching the model list, then advances to the picker.
		if (!opts.ready) {
			const form = body.createDiv({ cls: "semlink-guide-form" });
			const fieldLabel = (parent: HTMLElement, text: string): void => {
				parent.createDiv({ cls: "semlink-guide-fieldlabel", text: text });
			};

			fieldLabel(form, t("apiKey"));
			// SMS-code-style group: the "获取 Key" button sits inside the input's
			// right edge and opens the provider console (hidden for custom hosts
			// without a known console URL). The key prefills when one was
			// already validated, so 上一步 never forces a re-type.
			// 获取 Key 地址：优先内置目录的 keysUrl（与设置页编辑器同源），
			// 目录没有的（Xiaomi / Z.AI Coding 系）退回 PROVIDER_CONSOLE
			const consoleUrl = CHAT_CATALOG.find((e) => e.name === provider.name)?.keysUrl
				?? PROVIDER_CONSOLE[provider.name];
			const keyGroup = form.createDiv({ cls: "semlink-guide-keygroup" });
			// Key 输入框内嵌供应商 logo：低调标识正在配置哪家，不做独立标题区
			const keyBrand = brandLogoOf(provider.name).svg;
			if (keyBrand) {
				const keyLogo = keyGroup.createSpan({ cls: "semlink-guide-keylogo" });
				setSvgIcon(keyLogo, keyBrand);
			}
			const keyInput = keyGroup.createEl("input", {
				cls: "semlink-guide-keyinput",
				type: "password",
				placeholder: t("guideKeyPlaceholder"),
				value: provider.apiKey,
			});
			if (consoleUrl) {
				const getKeyBtn = keyGroup.createEl("button", {
					cls: "semlink-guide-keybtn",
					text: t("guideGetKey"),
				});
				getKeyBtn.addEventListener("click", () => {
					const link = window.open(consoleUrl, "_blank", "noopener");
					link?.focus();
				});
			}

			// ── 高级选项（默认收起，同供应商配置弹窗）：名称 / Endpoint / 协议 ──
			const advHead = form.createDiv({ cls: "semlink-guide-adv-head" });
			const chev = advHead.createSpan({ cls: "semlink-guide-adv-chevron" });
			setIcon(chev, "chevron-right");
			const advLabel = advHead.createSpan({ cls: "semlink-guide-adv-label", text: t("editorAdvancedShow") });
			const advBody = form.createDiv({ cls: "semlink-guide-adv-body semlink-hidden" });
			advHead.addEventListener("click", () => {
				const open = !advBody.hasClass("semlink-hidden");
				advBody.toggleClass("semlink-hidden", open);
				setIcon(chev, open ? "chevron-right" : "chevron-down");
				advLabel.setText(t(open ? "editorAdvancedShow" : "editorAdvancedHide"));
			});

			fieldLabel(advBody, t("chatProviderName"));
			const nameInput = advBody.createEl("input", {
				cls: "semlink-guide-keyinput",
				type: "text",
				value: provider.name,
			});

			fieldLabel(advBody, t("editorEndpoint"));
			const baseInput = advBody.createEl("input", {
				cls: "semlink-guide-keyinput",
				type: "text",
				value: provider.apiBase,
				placeholder: "https://…",
			});

			fieldLabel(advBody, t("chatApiFormat"));
			// "bare" = POST to the base URL verbatim (stored as wirePath "/",
			// which chatEndpoint understands); payload format is untouched.
			const formatSelect = advBody.createEl("select", { cls: "semlink-guide-keyinput semlink-guide-select" });
			for (const [value, label] of [
				["anthropic", t("chatFormatAnthropic")],
				["openai", t("chatFormatOpenAI")],
				["bare", t("chatFormatBare")],
			] as const) {
				formatSelect.createEl("option", { value, text: label });
			}
			formatSelect.value = provider.wirePath === "/" ? "bare" : provider.apiFormat;

			// Wizard footer: 上一步 (back to the provider list) | 下一步 (validate).
			const footer = body.createDiv({ cls: "semlink-guide-footer" });
			const backBtn = footer.createEl("button", {
				cls: "semlink-guide-save semlink-guide-secondary",
				text: t("guidePrev"),
			});
		backBtn.addEventListener("click", opts.onReselect);
			const nextBtn = footer.createEl("button", {
				cls: "semlink-guide-save semlink-guide-primary",
				// 与供应商配置弹窗一致：校验并保存（ Testing… 为进行中文案）
				text: t("editorTestSave"),
			});

			const error = body.createDiv({ cls: "semlink-guide-error" });

			const clearError = (): void => {
				error.setText("");
				nameInput.removeClass("is-invalid");
				baseInput.removeClass("is-invalid");
				keyInput.removeClass("is-invalid");
			};
			nameInput.addEventListener("input", clearError);
			baseInput.addEventListener("input", clearError);
			formatSelect.addEventListener("change", clearError);
			keyInput.addEventListener("input", clearError);

			// 下一步 = validate the key with a single cheap models-list
			// request; the (slow) per-model classification streams in inside
			// the picker. Form values are persisted only after the key
			// checks out.
			const validate = async (): Promise<void> => {
				const apiBase = baseInput.value.trim();
				const key = keyInput.value.trim();
				if (!apiBase) {
					error.setText(t("customNeedsBaseUrl"));
					baseInput.addClass("is-invalid");
					return;
				}
				if (!key) {
					error.setText(t("guideKeyRequired"));
					keyInput.addClass("is-invalid");
					return;
				}
				nextBtn.disabled = true;
				nextBtn.setText(t("editorTesting"));
				provider.name = nameInput.value.trim() || provider.name;
				provider.apiBase = apiBase;
				if (formatSelect.value === "bare") {
					// Bare: the address IS the endpoint — payload format stays
					// whatever this provider already uses.
					provider.wirePath = "/";
				} else {
					provider.apiFormat = formatSelect.value as ChatApiFormat;
					if (provider.wirePath === "/") provider.wirePath = undefined;
				}
				provider.apiKey = key;
				try {
					await fetchModelIds(apiBase, key, provider.apiFormat);
					// 200 但空列表也放行：模型步骤里可手动补、可重试。
					opts.onValidated();
				} catch (e) {
					// 部分网关（如智谱 coding 路由）不提供 /models 列表，
					// 404 不代表配置错误 — 放行到模型步骤手动补。
					fetchHint = t("guideFetchFailed").replace("{err}", e instanceof Error ? e.message : String(e))
						+ " · " + t("guideFetchManualHint");
					opts.onValidated();
				} finally {
					nextBtn.disabled = false;
					nextBtn.setText(t("editorTestSave"));
				}
			};
			nextBtn.addEventListener("click", () => void validate());
			keyInput.addEventListener("keydown", (evt) => {
				if (evt.key === "Enter") {
					evt.preventDefault();
					void validate();
				}
			});
			return;
		}

		// Sub-state C: pick the model from the validated provider — rows carry
		// a toggle (settings style), Confirm submits the enabled set. Fetch
		// pulls the endpoint's list into a check-off dialog. The whole block
		// (stepper + search + list) pins to the top of the panel.
		let filter = "";
		const kindWanted = isChat ? "chat" : "embedding";
		const inScope = (m: ChatModel): boolean =>
			(m.kind ?? "chat") === kindWanted
			&& (!filter || m.id.toLowerCase().includes(filter));

		// The classification progress doubles as the search input's
		// placeholder while models stream in.
		const search = modelsHost.createDiv({ cls: "semlink-guide-search" });
		const searchInput = search.createEl("input", {
			cls: "semlink-guide-keyinput",
			type: "text",
			placeholder: t("guideSearchModel"),
		});
		searchInput.addEventListener("input", () => {
			filter = searchInput.value.trim().toLowerCase();
			renderList();
		});

		// 计数 + 按钮行（同设置页右栏："N models" 左，"+ Add / Fetch" 右）
		const countRow = modelsHost.createDiv({ cls: "semlink-guide-model-count" });
		const countText = countRow.createSpan({ cls: "semlink-guide-model-count-text" });
		const countBtns = countRow.createSpan({ cls: "semlink-guide-model-count-btns" });
		const addBtn = countBtns.createEl("button", {
			cls: "semlink-guide-model-add",
			text: "＋ " + t("mtAddModel"),
		});
		addBtn.addEventListener("click", () => {
			// 复用设置页的添加模型弹窗（Model ID + Context Window）
			new AddModelModal(plugin.app, {
				title: t("mtAddModel"),
				onSubmit: (id, contextWindow) => {
					let model = provider.models.find((x) => x.id === id);
					if (!model) {
						model = {
							id,
							contextWindow: contextWindow > 0 ? contextWindow : FALLBACK_CONTEXT,
							kind: kindWanted,
							enabled: true,
						};
						provider.models.push(model);
					} else {
						model.enabled = true;
					}
					void plugin.saveSettings();
					renderList();
				},
			}).open();
		});
		const fetchBtn = countBtns.createEl("button", {
			cls: "semlink-guide-model-add",
			text: "Fetch",
		});
		fetchBtn.addEventListener("click", () => {
			new GuideFetchModelsModal(plugin, provider, kindWanted, () => {
				void plugin.saveSettings();
				renderList();
			}).open();
		});

		const error = modelsHost.createDiv({ cls: "semlink-guide-error" });
		if (fetchHint) error.setText(fetchHint);
		const cards = modelsHost.createDiv({ cls: "semlink-guide-models-cards" });

		// 底部操作栏（同第二步样式）：左返回、右确认
		const footer = body.createDiv({ cls: "semlink-guide-footer" });
		const backBtn = footer.createEl("button", {
			cls: "semlink-guide-save semlink-guide-secondary",
			text: t("guidePrev"),
		});
		backBtn.addEventListener("click", () => opts.onBackToKey());
		const confirmBtn = footer.createEl("button", {
			cls: "semlink-guide-save semlink-guide-primary",
			text: t("confirm"),
		});
		confirmBtn.addEventListener("click", () => {
			const picked = provider.models
				.filter((m) => (m.kind ?? "chat") === kindWanted && m.enabled === true)
				.sort((a, b) => a.id.localeCompare(b.id, undefined, { sensitivity: "base", numeric: true }));
			if (picked.length === 0) {
				error.setText(t("guidePickOneModel"));
				return;
			}
			opts.onModelPicked(provider, picked);
		});

		// 模型行：滑块 + logo + 模型 ID/上下文 + 开关（同设置页右栏样式）。
		// 左侧滑块拖动排序（写入 provider.models）；点击行打开编辑弹窗
		// （复用设置页的模型编辑弹窗，含删除）。只展示前 10 个，可搜索。
		const renderList = (): void => {
			const models = provider.models.filter((m) => inScope(m))
				.slice(0, 10);
			countText.setText(t("mtShowing").replace("{total}", String(models.length)));
			const scroll = cards.scrollTop;
			cards.empty();
			// 行图标统一用供应商品牌图标（不再按模型 ID 逐个匹配）
			const providerSvg = brandLogoOf(provider.name).svg;
			for (const model of models) {
				const row = cards.createDiv({ cls: "semlink-guide-model-row" });
				// 左侧移动滑块：拖动调整顺序（顺序持久化在 provider.models）
				const grip = row.createDiv({
					cls: "semlink-guide-model-grip",
					attr: { title: t("modelDrag") },
				});
				setIcon(grip, "grip-vertical");
				grip.addEventListener("click", (e) => e.stopPropagation());
				row.draggable = true;
				row.addEventListener("dragstart", (e) => {
					e.dataTransfer?.setData("text/semlink-guide-model", String(provider.models.indexOf(model)));
					if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
				});
				row.addEventListener("dragover", (e) => {
					e.preventDefault();
					if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
				});
				row.addEventListener("drop", (e) => {
					e.preventDefault();
					const raw = e.dataTransfer?.getData("text/semlink-guide-model");
					const from = raw === undefined ? -1 : parseInt(raw, 10);
					if (!Number.isFinite(from) || from < 0 || provider.models[from] === model) return;
					const src = provider.models[from];
					if (!src) return;
					provider.models.splice(from, 1);
					provider.models.splice(provider.models.indexOf(model), 0, src);
					void plugin.saveSettings();
					renderList();
				});
				const logoEl = row.createSpan({ cls: "semlink-guide-card-logo" });
				if (providerSvg) setSvgIcon(logoEl, providerSvg);
				const main = row.createSpan({ cls: "semlink-guide-model-main" });
				main.createSpan({ cls: "semlink-guide-model-id", text: model.id });
				if (model.contextWindow > 0) {
					main.createSpan({ cls: "semlink-guide-model-ctx", text: formatContextWindow(model.contextWindow) });
				}
				const toggleWrap = row.createSpan({ cls: "semlink-guide-model-toggle" });
				new ToggleComponent(toggleWrap).setValue(model.enabled === true)
					.onChange((v) => {
						model.enabled = v;
					});
				row.addEventListener("click", (e) => {
					// 开关与滑块的点击不触发行编辑
					if ((e.target as HTMLElement).closest(".semlink-guide-model-toggle")) return;
					if ((e.target as HTMLElement).closest(".semlink-guide-model-grip")) return;
					// 编辑弹窗复用设置页模型列表的（含删除）
					new AddModelModal(plugin.app, {
						title: t("mtModelEdit"),
						initial: { id: model.id, contextWindow: model.contextWindow },
						onSubmit: (id, contextWindow) => {
							model.id = id;
							model.contextWindow = contextWindow;
							void plugin.saveSettings();
							renderList();
						},
						onDelete: () => {
							const idx = provider.models.indexOf(model);
							if (idx !== -1) provider.models.splice(idx, 1);
							void plugin.saveSettings();
							renderList();
						},
					}).open();
				});
			}
			if (models.length === 0) {
				cards.createDiv({
					cls: "semlink-guide-hint",
					text: filter ? t("guideSearchNoMatch") : isChat ? t("guideNoChatModel") : t("guideNoEmbed"),
				});
			}
			cards.scrollTop = scroll;
		};

		renderList();
	};

	redraw();
}

/** 引导第三步的"获取模型"弹窗：拉取端点的模型清单（带进度），勾选后加入
 *  本地列表并启用；确认后标记 curated，之后不再重复拉取。 */
class GuideFetchModelsModal extends Modal {
	private models: FetchedModel[] = [];
	private checked = new Set<string>();

	constructor(
		private plugin: SmartVaultPlugin,
		private provider: ModelProvider,
		private kindWanted: "chat" | "embedding",
		private onAdopt: () => void,
	) {
		super(plugin.app);
		this.modalEl.addClass("semlink-guide-series-modal");
		// 复用供应商编辑弹窗的样式域（footer 与按钮的观感与编辑模型一致）
		this.modalEl.addClass("smart-vault-settings");
	}

	onOpen(): void {
		this.titleEl.setText(t("guideFetchModels"));
		const { contentEl } = this;
		// 进度条：拉取中显示填充比例，完成后隐藏
		const progress = contentEl.createDiv({ cls: "semlink-fetch-progress" });
		const progressFill = progress.createDiv({ cls: "semlink-fetch-progress-fill" });
		const error = contentEl.createDiv({ cls: "semlink-guide-error semlink-hidden" });
		const list = contentEl.createDiv({ cls: "semlink-guide-fetch-list" });
		// 底部按钮与编辑模型弹窗一致：右侧 Cancel / Confirm
		const footer = contentEl.createDiv({ cls: "semlink-editor-footer is-simple" });
		const cancelBtn = footer.createEl("button", {
			cls: "semlink-editor-cancel-btn",
			text: t("cancel"),
		});
		cancelBtn.addEventListener("click", () => this.close());
		const confirmBtn = footer.createEl("button", {
			cls: "semlink-editor-save-btn",
			text: t("confirm"),
		});
		confirmBtn.disabled = true;

		const renderItems = (): void => {
			list.empty();
			const sorted = [...this.models].sort((a, b) =>
				a.id.localeCompare(b.id, undefined, { sensitivity: "base", numeric: true }));
			for (const m of sorted) {
				const row = list.createDiv({ cls: "semlink-guide-fetch-row" });
				const cb = row.createEl("input", { type: "checkbox" });
				cb.checked = this.checked.has(m.id);
				const sync = (): void => {
					if (cb.checked) this.checked.add(m.id);
					else this.checked.delete(m.id);
				};
				cb.addEventListener("change", sync);
				row.addEventListener("click", (e) => {
					if ((e.target as HTMLElement).isSameNode(cb)) return;
					cb.checked = !cb.checked;
					sync();
				});
				const main = row.createSpan({ cls: "semlink-guide-model-main" });
				main.createSpan({ cls: "semlink-guide-model-id", text: m.id });
				const ctx = m.contextWindow ?? catalogContextWindow(m.id) ?? 0;
				if (ctx > 0) {
					main.createSpan({ cls: "semlink-guide-model-ctx", text: formatContextWindow(ctx) });
				}
			}
			confirmBtn.disabled = this.models.length === 0;
		};

		void (async () => {
			try {
				const fetched = await fetchAvailableModels(
					this.plugin,
					this.provider.apiBase,
					this.provider.apiKey,
					this.provider.apiFormat,
					(done, total) => {
						const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
						progressFill.style.width = `${pct}%`;
					},
				);
				// 拉取完成：进度条隐藏，清单浮现（默认全部不勾选）
				progress.addClass("semlink-hidden");
				this.models = fetched.filter((m) => (m.kind ?? "chat") === this.kindWanted);
				this.checked.clear();
				if (this.models.length === 0) {
					error.setText(t("fetchEmpty"));
					error.removeClass("semlink-hidden");
				}
				renderItems();
			} catch (e) {
				progress.addClass("semlink-hidden");
				error.setText(t("guideFetchFailed").replace("{err}", e instanceof Error ? e.message : String(e)));
				error.removeClass("semlink-hidden");
			}
		})();

		confirmBtn.addEventListener("click", () => {
			for (const m of this.models) {
				if (!this.checked.has(m.id)) continue;
				const existing = this.provider.models.find((x) => x.id === m.id);
				if (existing) {
					existing.enabled = true;
				} else {
					this.provider.models.push({
						id: m.id,
						// 端点没报上下文时查内置目录，再退回 128K 兜底
						contextWindow: m.contextWindow ?? catalogContextWindow(m.id) ?? FALLBACK_CONTEXT,
						kind: this.kindWanted,
						enabled: true,
					});
				}
			}
			// 清单已按端点镜像——标记 curated，之后不再自动拉取。
			this.provider.curated = true;
			this.close();
			this.onAdopt();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
