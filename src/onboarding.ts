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
import { mountCoffeeCanvas, mountTicketDeck } from "./coffee-canvas";
import { AddModelModal, brandLogoOf, buildGuideProviderGroups, CHAT_CATALOG, fetchAvailableModels, fetchModelIds, formatContextWindow, providerLogo, setSvgIcon } from "./settings-models";
import type { FetchedModel } from "./settings-models";
import { t } from "./i18n";
import type SmartVaultPlugin from "../main";
import type { ChatApiFormat, ChatModel, ChatModelKind, ModelProvider } from "./types";

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
	"Moonshot AI CN": "https://platform.moonshot.cn/console/api-keys",
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

/** Model id → brand logo (lobehub/lobe-icons, same set as PROVIDER_LOGOS).
 *  First matching pattern wins; OpenRouter-style `vendor/model` ids match on
 *  the substring. Unmatched ids fall back to a generic glyph. */
const MODEL_BRANDS: Array<[RegExp, string]> = [
	[/deepseek/i, "deepseek"],
	[/glm|zhipu|chatglm/i, "zai"],
	[/qwen|qwq/i, "qwentokenplan"],
	[/kimi|moonshot/i, "moonshotaicn"],
	[/gpt|chatgpt|davinci|text-embedding|(^|\/)o[0-9]/i, "openai"],
	[/claude/i, "anthropic"],
	[/gemini|gemma/i, "google"],
	[/grok/i, "xai"],
	[/mimo/i, "xiaomi"],
	[/minimax|abab/i, "minimax"],
	[/mistral|codestral|devstral|pixtral/i, "mistral"],
	[/llama/i, "meta"],
	[/bge|baai/i, "baai"],
	[/hunyuan/i, "hunyuan"],
	[/nova/i, "amazonbedrock"],
	[/ernie/i, "baidu"],
	[/command/i, "cohere"],
	[/hermes/i, "nousresearch"],
	[/longcat/i, "meituan"],
	[/mercury/i, "inception"],
	[/kat-coder/i, "kwaipilot"],
	[/granite/i, "ibm"],
	[/lfm/i, "liquid"],
	[/palmyra/i, "writer"],
	[/laguna/i, "poolside"],
	[/aion/i, "aionlabs"],
	[/trinity/i, "arcee"],
	[/morph/i, "morph"],
];

/** Vendor segment (the part before "/" in `vendor/model` ids) → brand logo
 *  key — the fallback when no model-name pattern matches. Substring match. */
const VENDOR_BRANDS: Array<[string, string]> = [
	["bytedance", "bytedance"],
	["doubao", "doubao"],
	["deepseek", "deepseek"],
	["anthropic", "anthropic"],
	["openai", "openai"],
	["google", "google"],
	["meta", "meta"],
	["mistral", "mistral"],
	["qwen", "qwentokenplan"],
	["moonshot", "moonshotai"],
	["kimi", "moonshotaicn"],
	["minimax", "minimax"],
	["zhipu", "zai"],
	["thudm", "zai"],
	["zai", "zai"],
	["xiaomi", "xiaomi"],
	["mimo", "xiaomi"],
	["nvidia", "nvidia"],
	["together", "together"],
	["baai", "baai"],
	["inclusionai", "antling"],
	["microsoft", "microsoft"],
	["tencent", "hunyuan"],
	["hunyuan", "hunyuan"],
	["amazon", "amazonbedrock"],
	["baidu", "baidu"],
	["cohere", "cohere"],
	["stepfun", "stepfun"],
	["upstage", "upstage"],
	["liquid", "liquid"],
	["meituan", "meituan"],
	["nousresearch", "nousresearch"],
	["openrouter", "openrouter"],
	["relace", "relace"],
	["poolside", "poolside"],
	["kwaipilot", "kwaipilot"],
	["inception", "inception"],
	["ibm", "ibm"],
	["aionlabs", "aionlabs"],
	["arcee", "arcee"],
	["morph", "morph"],
];

/** Brand logo SVG for a model id — official `-color` variant when available,
 *  mono otherwise (same source as provider icons). */
function modelBrand(modelId: string): string | undefined {
	// The vendor segment (before "/") is the strongest signal — it names the
	// company actually serving the model, even when the model name mentions a
	// base family (e.g. aion-rp-llama-* → AionLabs, not Meta).
	if (modelId.includes("/")) {
		const vendor = modelId.split("/")[0]?.toLowerCase().replace(/[^a-z0-9]/g, "");
		for (const [suffix, key] of VENDOR_BRANDS) {
			if (vendor.includes(suffix)) return brandLogoOf(key).svg;
		}
	}
	// Fall back to the model-name patterns (gpt-*, claude-*, glm-* …).
	for (const [re, key] of MODEL_BRANDS) {
		if (re.test(modelId)) return brandLogoOf(key).svg;
	}
	return undefined;
}

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

		// 右上角设置入口：不走引导直接去插件设置页
		const settingsBtn = root.createDiv({
			cls: "semlink-guide-settings-btn",
			attr: { "aria-label": t("openSettings"), title: t("openSettings") },
		});
		setIcon(settingsBtn, "settings");
		settingsBtn.addEventListener("click", () => {
			const app = plugin.app as unknown as {
				setting: { open(): void; openTabById(id: string): void };
			};
			app.setting.open();
			app.setting.openTabById("semlink");
		});

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
		// 网格：全部目录条目（已配置 Key 置顶 → 市场排名），不再有 More /
		// Custom 入口，也不再做系列文件夹折叠。
		if (!provider) {
			const grid = body.createDiv({ cls: "semlink-guide-provider-grid" });
			const configuredOf = (name: string): boolean =>
				plugin.settings.providers.some((x) => x.name === name && !!x.apiKey.trim());
			const ordered = buildGuideProviderGroups(plugin).flatMap((g) => g.members ?? [g.name]);
			for (const name of ordered) {
				const providerCard = grid.createDiv({ cls: "semlink-guide-provider-card" });
				if (configuredOf(name)) {
					providerCard.createSpan({
						cls: "semlink-guide-provider-card-dot",
						attr: { title: t("credentialConfigured") },
					});
				}
				const logo = brandLogoOf(name).svg;
				if (logo) {
					const logoEl = providerCard.createDiv({ cls: "semlink-guide-provider-logo" });
					setSvgIcon(logoEl, logo);
				} else {
					providerCard.createDiv({
						cls: "semlink-guide-provider-fallback",
						text: name.charAt(0).toUpperCase(),
					});
				}
				providerCard.createDiv({ cls: "semlink-guide-provider-name", text: name });
				providerCard.addEventListener("click", () => {
					const p = ensureCatalogProvider(plugin, name);
					if (p) opts.onPickProvider(p);
				});
			}
			return;
		}

		// Sub-state B: confirm details + key; 下一步 validates the key by
		// fetching the model list, then advances to the picker.
		if (!opts.ready) {
			const form = body.createDiv({ cls: "semlink-guide-form" });
			const fieldLabel = (parent: HTMLElement, text: string): void => {
				parent.createDiv({ cls: "semlink-guide-fieldlabel", text });
			};

			// 标签带供应商名：用户明确知道要填哪家的 Key
			fieldLabel(form, `${provider.name} ${t("apiKey")}`);
			// SMS-code-style group: the "获取 Key" button sits inside the input's
			// right edge and opens the provider console (hidden for custom hosts
			// without a known console URL). The key prefills when one was
			// already validated, so 上一步 never forces a re-type.
			// 获取 Key 地址：优先内置目录的 keysUrl（与设置页编辑器同源），
			// 目录没有的（Xiaomi / Z.AI Coding 系）退回 PROVIDER_CONSOLE
			const consoleUrl = CHAT_CATALOG.find((e) => e.name === provider.name)?.keysUrl
				?? PROVIDER_CONSOLE[provider.name];
			const keyGroup = form.createDiv({ cls: "semlink-guide-keygroup" });
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

		// Sub-state C: pick the model from the validated provider — models
		// stream in step by step as classification advances; rows carry a
		// toggle (settings style), Confirm submits the enabled set. The whole
		// block (stepper + search + list) pins to the top of the panel.
		// Curated lists (edited in settings) render as-is — nothing streams in.
		let streaming = !provider.curated;
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

		// 计数 + 添加模型行（同设置页右栏："N models" 左，"+ Add" 右）
		const countRow = modelsHost.createDiv({ cls: "semlink-guide-model-count" });
		const countText = countRow.createSpan({ cls: "semlink-guide-model-count-text" });
		const addBtn = countRow.createEl("button", {
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

		// 模型行：logo + 模型 ID/上下文 + 开关（同设置页右栏样式）；点击行
		// 即切换开关。只展示前 10 个，更多模型可搜索。
		const renderList = (): void => {
			const models = provider.models.filter((m) => inScope(m))
				// Alphabetical, natural-number aware (qwen2 < qwen10).
				.sort((a, b) => a.id.localeCompare(b.id, undefined, { sensitivity: "base", numeric: true }))
				.slice(0, 10);
			countText.setText(t("mtShowing").replace("{total}", String(models.length)));
			const scroll = cards.scrollTop;
			cards.empty();
			for (const model of models) {
				const row = cards.createDiv({ cls: "semlink-guide-model-row" });
				const logoEl = row.createSpan({ cls: "semlink-guide-card-logo" });
				const brandSvg = modelBrand(model.id);
				if (brandSvg) setSvgIcon(logoEl, brandSvg);
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
					if ((e.target as HTMLElement).closest(".semlink-guide-model-toggle")) return;
					model.enabled = model.enabled !== true;
					renderList();
				});
			}
			if (models.length === 0 && !streaming) {
				cards.createDiv({
					cls: "semlink-guide-hint",
					text: filter ? t("guideSearchNoMatch") : isChat ? t("guideNoChatModel") : t("guideNoEmbed"),
				});
			}
			cards.scrollTop = scroll;
		};

		renderList();

		// Stream the classification: every newly identified model appears in
		// the list immediately — no need to wait for the full sweep. Known
		// kinds are cached, so repeat visits only re-probe unknowns.
		const upsert = (m: FetchedModel): boolean => {
			// ChatModelKind has no "unknown" — unclassifiable models fall back
			// to the chat label but stay disabled.
			const rawKind = m.kind ?? "chat";
			const kind: ChatModelKind = rawKind === "unknown" ? "chat" : rawKind;
			const enabled = rawKind === "chat" || rawKind === "embedding";
			const existing = provider.models.find((x) => x.id === m.id);
			if (existing) {
				existing.kind = kind;
				existing.enabled = enabled;
				if (m.contextWindow !== undefined) existing.contextWindow = m.contextWindow;
				return false;
			}
			provider.models.push({
				id: m.id,
				contextWindow: m.contextWindow ?? FALLBACK_CONTEXT,
				kind,
				enabled,
			});
			return inScope(provider.models[provider.models.length - 1]);
		};

		const stream = async (): Promise<void> => {
			try {
				await fetchAvailableModels(plugin, provider.apiBase, provider.apiKey, provider.apiFormat,
					(done, total, model) => {
						// 拉取进度走提示行（原 Fetch models 按钮已改为 Back）
						if (model && upsert(model)) renderList();
						else error.setText(`${t("guideFetchModels")} ${done}/${total}`);
					});
					streaming = false;
					// The list now mirrors the endpoint — mark it curated so later
					// guide runs don't refetch (which would resurrect models the
					// user removed in settings in the meantime).
					provider.curated = true;
					await plugin.saveSettings();
					renderList();
				} catch (e) {
					streaming = false;
					renderList();
					error.setText(t("guideFetchFailed").replace("{err}", e instanceof Error ? e.message : String(e)));
				}
			};
			// Auto-fetch only for providers the user never curated in settings —
			// refetching a curated list would silently resurrect models the user
			// deliberately removed there.
			if (!provider.curated) {
				void stream();
			}
		};

		redraw();
	}
