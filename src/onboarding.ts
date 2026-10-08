// ========================================
// Semlink - First-run onboarding guide
// ========================================
// Conversational setup guide rendered on the search welcome screen for users
// who have not configured any provider yet. Three steps, chat-first:
//   ① 对话模型 — pick a chat host → validate key → pick a chat model
//   ② 嵌入模型 — pick an embedding host → validate key → pick the model
//   ③ 数据索引 — estimated time → start → live progress bar
// Each key is validated by fetching the provider's model list before the
// model picker shows. All state lives in `settings.onboarding`, so the guide
// survives re-renders (time-slot refresh, language switch) and restarts.

import { Modal } from "obsidian";
import { mountCoffeeCanvas, mountTicketDeck } from "./coffee-canvas";
import { AddProviderModal, brandLogoOf, CHAT_CATALOG, fetchAvailableModels, fetchModelIds, providerLogo, validateModelId, setSvgIcon } from "./settings-models";
import type { FetchedModel } from "./settings-models";
import { t } from "./i18n";
import type SmartVaultPlugin from "../main";
import { activeEmbeddingProvider } from "./types";
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
	/** Rough full-index estimate for the final step. */
	getIndexEstimate(): { notes: number; seconds: number };
	/** Whether an index run is currently in flight. */
	isIndexing(): boolean;
	/** Whether the in-flight run is currently paused by the user. */
	isIndexPaused(): boolean;
	/** Start a full index and stream live stats. */
	startIndexing(onProgress: (stats: IndexStatsView) => void, onDone: () => void): void;
	/** Attach to an already-running index without starting a new one. */
	watchIndexing(onProgress: (stats: IndexStatsView) => void, onDone: () => void): void;
	/** Pause / resume the in-flight run. */
	pauseIndexing(): void;
	resumeIndexing(): void;
}

/** Curated provider names for the chat-model step — all present in
 *  CHAT_CATALOG and all carrying a brand logo. Alphabetical order. */
const CHAT_PROVIDERS = [
	"Anthropic",
	"DeepSeek",
	"Google",
	"Hugging Face",
	"Kimi For Coding",
	"MiniMax CN",
	"OpenAI",
	"OpenRouter",
	"SiliconFlow",
	"Z.AI Coding CN",
];

/** Curated providers whose endpoints serve BAAI/BGE embedding models — the
 *  embedding step only offers these (plus the custom escapes below). */
const EMBED_PROVIDERS = ["SiliconFlow", "OpenRouter"];

/** Console URLs where each curated provider's API key can be created. */
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
	host: OnboardingViewHost,
	onFinish: () => void,
): void {
	const root = container.createDiv({ cls: "semlink-guide" });

	// Cross-step back navigation: returning to an earlier step that is already
	// complete (e.g. step 2 → step 1 to re-pick the chat model). Cleared when
	// a step advances forward again.
	let stepOverride: 1 | 2 | 3 | null = null;

	const ob = (): NonNullable<SmartVaultPlugin["settings"]["onboarding"]> => plugin.settings.onboarding ?? {};
	const byId = (id?: string): ModelProvider | undefined =>
		id ? plugin.settings.providers.find((p) => p.id === id) : undefined;

	const setLanguage = async (lang: "zh" | "en"): Promise<void> => {
		plugin.settings.language = lang;
		await plugin.saveSettings();
	};

	const onRestart = (): void => {
		stepOverride = null;
		plugin.settings.onboarding = { done: false };
		void plugin.saveSettings();
		rerender();
	};

	const rerender = (): void => {
		root.empty();

		renderIntro(root);

		// Current step: ① until an embedding model is picked, then ② the
		// data index — ③ only via the index step's 下一步 (stepOverride) or
		// navigating back. 设置页"重新嵌入"直接跳到数据索引环节（jumpToIndex 优先）。
		const step: 1 | 2 | 3 = ob().jumpToIndex
			? 2
			: stepOverride
				?? (!ob().embedModelPicked ? 1 : 2);
		// Steps ①/②: stepper + models block share one sticky wrapper so the
		// whole unit pins to the top without overlapping each other.
		const sticky = root.createDiv({ cls: "semlink-guide-sticky-top" });
		renderStepper(
			sticky,
			step,
			false,
			(target) => {
				// Tap a passed step in the stepper → jump back to that node.
				stepOverride = target;
				rerender();
			},
			(target) => target === 1 || (target === 2 && !!ob().embedModelPicked),
		);
		const modelsHost = sticky.createDiv({ cls: "semlink-guide-models" });

		if (step === 1) {
			// ── ① 嵌入模型 ──
			renderModelStep(root, plugin, {
				kind: "embed",
				names: EMBED_PROVIDERS,
				providerId: ob().embedProviderId,
				ready: ob().embedReady,
				modelsHost,
				onPickProvider: (p) => {
					// An already-keyed provider jumps straight to the model
					// picker — no need to re-enter the key.
					const ready = !!p.apiKey.trim();
					plugin.settings.onboarding = { ...(plugin.settings.onboarding ?? {}), embedProviderId: p.id, embedReady: ready };
					void plugin.saveSettings();
					rerender();
				},
				onValidated: () => {
					plugin.settings.onboarding = { ...(plugin.settings.onboarding ?? {}), embedReady: true };
					void plugin.saveSettings();
					rerender();
				},
				onModelPicked: (p, models) => {
					stepOverride = null;
					const m = models[0];
					m.enabled = true;
					plugin.settings.embeddingModelKey = `${p.id}::${m.id}`;
					plugin.settings.onboarding = { ...(plugin.settings.onboarding ?? {}), embedModelPicked: true };
					void plugin.saveSettings();
					rerender();
				},
				onReselect: () => {
					const p = byId(ob().embedProviderId);
					if (p && !p.apiKey.trim()) {
						plugin.settings.providers = plugin.settings.providers.filter((x) => x.id !== p.id);
					}
					plugin.settings.onboarding = { ...(plugin.settings.onboarding ?? {}), embedProviderId: undefined, embedReady: false };
					void plugin.saveSettings();
					rerender();
				},
				onRestart,
			});
		} else if (step === 2) {
			// ── ② 数据索引 ── 下一步 advances to ③; the run keeps going in
			// the background (the scheduler is independent of this view).
			renderIndexStep(root, plugin, host,
				() => { // 下一步 → ③ 对话模型
					stepOverride = 3;
					rerender();
				},
				() => { // 上一步 → ① 嵌入模型
					stepOverride = 1;
					rerender();
				},
				onRestart);
		} else {
			// ── ③ 对话模型（最后一步）── picking completes the guide.
			renderModelStep(root, plugin, {
				kind: "chat",
				names: CHAT_PROVIDERS,
				providerId: ob().providerId,
				ready: ob().chatReady,
				modelsHost,
				onPickProvider: (p) => {
					plugin.settings.onboarding = { ...(plugin.settings.onboarding ?? {}), providerId: p.id };
					void plugin.saveSettings();
					rerender();
				},
				onValidated: () => {
					plugin.settings.onboarding = { ...(plugin.settings.onboarding ?? {}), chatReady: true };
					void plugin.saveSettings();
					rerender();
				},
				onModelPicked: (p, models) => {
					stepOverride = null;
					// Curate: the picked models stay enabled, every other chat
					// model of this provider is disabled; the first picked is
					// the default chat model. Picking completes the guide.
					const pickedIds = new Set(models.map((m) => m.id));
					for (const m of p.models) {
						if ((m.kind ?? "chat") !== "chat") continue;
						m.enabled = pickedIds.has(m.id);
					}
					plugin.settings.activeChatModel = `${p.id}/${models[0].id}`;
					plugin.settings.onboarding = { ...(plugin.settings.onboarding ?? {}), chatModelPicked: true, done: true };
					void plugin.saveSettings();
					onFinish();
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
		}

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

/** A clickable sug-style card; `logo` may be undefined → fallback initial.
 *  `meta` renders as a right-aligned trailing label (e.g. context size).
 *  `dot` is the settings-list credential dot (green configured / red missing). */
function card(parent: HTMLElement, opts: { logo?: string; icon?: string; text: string; meta?: string; dot?: "configured" | "missing"; star?: boolean; onClick: () => void }): HTMLElement {
	const el = parent.createDiv({ cls: "semlink-search-welcome-sug semlink-guide-card" });
	if (opts.logo) {
		const logoEl = el.createSpan({ cls: "semlink-guide-card-logo" });
		setSvgIcon(logoEl, opts.logo);
	} else {
		el.createSpan({ cls: "semlink-search-welcome-sug-icon", text: opts.icon ?? "›" });
	}
	el.createSpan({ cls: "semlink-search-welcome-sug-text", text: opts.text });
	if (opts.meta) {
		el.createSpan({ cls: "semlink-guide-card-meta", text: opts.meta });
	}
	if (opts.dot) {
		el.createSpan({
			cls: `semlink-provider-dot ${opts.dot === "configured" ? "is-configured" : "is-missing"}`,
			attr: {
				title: opts.dot === "configured" ? t("credentialConfigured") : t("credentialMissing"),
				"aria-label": opts.dot === "configured" ? t("credentialConfigured") : t("credentialMissing"),
			},
		});
	}
	if (opts.star) {
		el.createSpan({ cls: "semlink-guide-card-star", text: "⭐" });
	}
	el.addEventListener("click", opts.onClick);
	return el;
}

/** Quiet text link row (reselect / skip / manual-setup escapes). */
function linkRow(root: HTMLElement, entries: Array<{ text: string; onClick: () => void }>): void {
	const row = root.createDiv({ cls: "semlink-guide-links" });
	for (const e of entries) {
		row.createEl("a", { text: e.text }).addEventListener("click", (evt) => {
			evt.preventDefault();
			e.onClick();
		});
	}
}

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

/** Single-select highlight within one pick list. */
function markPicked(list: HTMLElement, el: HTMLElement): void {
	for (const child of Array.from(list.children)) {
		(child as HTMLElement).removeClass("is-picked");
	}
	el.addClass("is-picked");
}

// ──── Steps 1 & 2: provider → validate key → pick a model ────

interface ModelStepOptions {
	kind: "chat" | "embed";
	names: string[];
	providerId?: string;
	ready?: boolean;
	/** Model-step host container (search + progress/error + cards live here,
	 *  inside the shared sticky wrapper). */
	modelsHost: HTMLElement;
	onPickProvider: (provider: ModelProvider) => void;
	onValidated: () => void;
	onModelPicked: (provider: ModelProvider, models: ChatModel[]) => void;
	onReselect: () => void;
	onRestart: () => void;
}

function renderModelStep(root: HTMLElement, plugin: SmartVaultPlugin, opts: ModelStepOptions): void {
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

		// Sub-state A: pick a provider.
		if (!provider) {
			const list = body.createDiv({ cls: "semlink-guide-options" });
			// Configured providers (key filled) float to the top, each
			// group alphabetical.
			const isConfigured = (name: string): boolean =>
				plugin.settings.providers.some((x) => x.name === name && !!x.apiKey.trim());
			const names = [...opts.names].sort((a, b) => {
				const ca = isConfigured(a) ? 0 : 1;
				const cb = isConfigured(b) ? 0 : 1;
				return ca - cb || a.localeCompare(b);
			});
			for (const name of names) {
				card(list, {
					logo: brandLogoOf(name).svg,
					text: name,
					dot: isConfigured(name) ? "configured" : undefined,
					onClick: () => {
						const p = ensureCatalogProvider(plugin, name);
						if (p) opts.onPickProvider(p);
					},
				});
			}
			const more = body.createDiv({ cls: "semlink-guide-options semlink-guide-options-row" });
			card(more, {
				icon: "⊞",
				text: t("guideMoreProviders"),
				onClick: () => {
					new AddProviderModal(plugin.app, plugin, "catalog", (p) => opts.onPickProvider(p)).open();
				},
			});
			card(more, {
				icon: "＋",
				text: t("customProvider"),
				onClick: () => {
					new AddProviderModal(plugin.app, plugin, "custom", (p) => opts.onPickProvider(p)).open();
				},
			});
				return;
		}

		// Sub-state B: confirm details + key; 下一步 validates the key by
		// fetching the model list, then advances to the picker.
		if (!opts.ready) {
			const form = body.createDiv({ cls: "semlink-guide-form" });
			const fieldLabel = (parent: HTMLElement, text: string): void => {
				parent.createDiv({ cls: "semlink-guide-fieldlabel", text });
			};

			fieldLabel(form, t("chatProviderName"));
			const nameInput = form.createEl("input", {
				cls: "semlink-guide-keyinput",
				type: "text",
				value: provider.name,
			});

			fieldLabel(form, t("chatBaseUrl"));
			const baseInput = form.createEl("input", {
				cls: "semlink-guide-keyinput",
				type: "text",
				value: provider.apiBase,
				placeholder: "https://…",
			});

			fieldLabel(form, t("chatApiFormat"));
			// "bare" = POST to the base URL verbatim (stored as wirePath "/",
			// which chatEndpoint understands); payload format is untouched.
			const formatSelect = form.createEl("select", { cls: "semlink-guide-keyinput semlink-guide-select" });
			for (const [value, label] of [
				["anthropic", t("chatFormatAnthropic")],
				["openai", t("chatFormatOpenAI")],
				["bare", t("chatFormatBare")],
			] as const) {
				formatSelect.createEl("option", { value, text: label });
			}
			(formatSelect as HTMLSelectElement).value = provider.wirePath === "/" ? "bare" : provider.apiFormat;

			fieldLabel(form, t("apiKey"));
			// SMS-code-style group: the "获取 Key" button sits inside the input's
			// right edge and opens the provider console (hidden for custom hosts
			// without a known console URL). The key prefills when one was
			// already validated, so 上一步 never forces a re-type.
			const consoleUrl = PROVIDER_CONSOLE[provider.name];
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

			// Wizard footer: 上一步 (back to the provider list) | 下一步 (validate).
			const footer = body.createDiv({ cls: "semlink-guide-footer" });
			const backBtn = footer.createEl("button", {
				cls: "semlink-guide-save semlink-guide-secondary",
				text: t("guidePrev"),
			});
		backBtn.addEventListener("click", opts.onReselect);
			const nextBtn = footer.createEl("button", {
				cls: "semlink-guide-save semlink-guide-primary",
				text: t("guideNext"),
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
				nextBtn.setText(t("guideValidating"));
				provider.name = nameInput.value.trim() || provider.name;
				provider.apiBase = apiBase;
				if ((formatSelect as HTMLSelectElement).value === "bare") {
					// Bare: the address IS the endpoint — payload format stays
					// whatever this provider already uses.
					provider.wirePath = "/";
				} else {
					provider.apiFormat = (formatSelect as HTMLSelectElement).value as ChatApiFormat;
					if (provider.wirePath === "/") provider.wirePath = undefined;
				}
				provider.apiKey = key;
				try {
					const ids = await fetchModelIds(apiBase, key, provider.apiFormat);
					if (ids.length === 0) {
						error.setText(t("guideNoChatModel"));
						return;
					}
					// Single persist — onValidated saves (chatReady) and the
					// model picker streams the classification step by step.
					opts.onValidated();
				} catch (e) {
					error.setText(t("guideFetchFailed").replace("{err}", e instanceof Error ? e.message : String(e)));
				} finally {
					nextBtn.disabled = false;
					nextBtn.setText(t("guideNext"));
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
		// stream in step by step as classification advances; selection
		// highlights the card, 下一步 confirms and advances. The whole block
		// (stepper + search + list) pins to the top of the panel.
		// Curated lists (edited in settings) render as-is — nothing streams in.
		let streaming = !provider.curated;
		let filter = "";
		let fetchDone = 0;
		let fetchTotal = 0;

		const wanted = (m: ChatModel): boolean => {
			const kind = m.kind ?? "chat";
			if (m.enabled === false || (isChat ? kind !== "chat" : kind !== "embedding")) return false;
			if (filter && !m.id.toLowerCase().includes(filter)) return false;
			return true;
		};

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
		const error = modelsHost.createDiv({ cls: "semlink-guide-error" });
		const cards = modelsHost.createDiv({ cls: "semlink-guide-models-cards" });
		// Fixed action row BELOW the scrollable list — always visible,
		// created once (renderList only rebuilds the model cards above).
		const actions = modelsHost.createDiv({ cls: "semlink-guide-model-actions" });
		const fetchCard = card(actions, { icon: "⇣", text: t("guideFetchModels"), onClick: () => {} });
		const fetchTextEl = (fetchCard.querySelector(".semlink-search-welcome-sug-text") as HTMLElement) ?? fetchCard;
		fetchCard.addEventListener("click", () => {
			if (streaming) return;
			streaming = true;
			fetchDone = 0;
			fetchTotal = 0;
			fetchCard.addClass("is-loading");
			error.setText("");
			void stream();
		});
		card(actions, {
			icon: "＋",
			text: t("customModel"),
			onClick: () => {
				new AddModelModal(plugin, provider, isChat ? "chat" : "embedding", (id) => {
					let model = provider.models.find((x) => x.id === id);
					if (!model) {
						model = {
							id,
							contextWindow: FALLBACK_CONTEXT,
							kind: isChat ? "chat" : "embedding",
							enabled: true,
						};
						provider.models.push(model);
					} else {
						model.enabled = true;
					}
					opts.onModelPicked(provider, [model]);
				}).open();
			},
		});

		// Sub-state C: models stream in step by step as classification
		// advances; clicking a card picks it and immediately advances to the
		// next step. 添加模型 opens a dialog for manual model-ID entry.
		const renderList = (): void => {
			const models = provider.models.filter((m) => wanted(m))
				// Alphabetical, natural-number aware (qwen2 < qwen10).
				.sort((a, b) => a.id.localeCompare(b.id, undefined, { sensitivity: "base", numeric: true }));
			const scroll = cards.scrollTop;
			cards.empty();
			for (const model of models) {
				// Recommended pick: the free, high-quality BGE-M3 embedding.
				const recommended = !isChat && /bge-m3/i.test(model.id);
				const el = card(cards, {
					logo: modelBrand(model.id),
					icon: isChat ? "✦" : "◈",
					text: model.id,
					star: recommended,
					onClick: () => opts.onModelPicked(provider, [model]),
				});
				el.addClass("semlink-guide-model-card");
				el.dataset.modelId = model.id;
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
			return wanted(provider.models[provider.models.length - 1]);
		};

		const stream = async (): Promise<void> => {
			try {
				await fetchAvailableModels(plugin, provider.apiBase, provider.apiKey, provider.apiFormat,
					(done, total, model) => {
						const countersChanged = fetchDone !== done || fetchTotal !== total;
						fetchDone = done;
						fetchTotal = total;
						if (model && upsert(model)) renderList();
						else fetchTextEl.setText(`${t("guideFetchModels")} ${fetchDone}/${fetchTotal}`);
					});
					streaming = false;
					fetchCard.removeClass("is-loading");
					// The list now mirrors the endpoint — mark it curated so later
					// guide runs don't refetch (which would resurrect models the
					// user removed in settings in the meantime).
					provider.curated = true;
					await plugin.saveSettings();
					renderList();
				} catch (e) {
					streaming = false;
					fetchCard.removeClass("is-loading");
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

// ──── Step 3: data index (estimate → start → progress bar) ────

function renderIndexStep(
	root: HTMLElement,
	plugin: SmartVaultPlugin,
	host: OnboardingViewHost,
	onNext: () => void,
	onBack: () => void,
	onRestart: () => void,
): void {
	// Panel: hero estimate card, progress bar + live counters, then the
	// provider→model recipe pills at the bottom — all inside one bordered card.
	const active = activeEmbeddingProvider(plugin.settings);
	const est = host.getIndexEstimate();

	const panel = root.createDiv({ cls: "semlink-guide-indexstats" });

	// Coffee-break hero: the WHOLE coffee scene is one canvas — cup, liquid
	// with waves/bubbles, the model's latte-art chip, the pour stream with
	// the file-name tag, steam. The readout stays DOM.
	const hero = panel.createDiv({ cls: "semlink-guide-index-hero" });
	const coffee = hero.createDiv({ cls: "semlink-guide-index-coffee" });
	const coffeeFx = mountCoffeeCanvas(coffee, {
		modelLogoSvg: modelBrand(active.model),
		modelName: active.model,
	});
	// Barista status line — driven by applyButton: idle/paused/stopped =
	// preparing, running = extracting, done = served.
	const stamp = coffee.createDiv({ cls: "semlink-guide-index-stamp", text: t("guideStampPreparing") });

	const readout = hero.createDiv({ cls: "semlink-guide-index-readout" });
	const heroNum = readout.createDiv({ cls: "semlink-guide-index-statnum", text: String(est.notes) });
	// Sub-label: what the number refers to — "笔记总数" while idle, "共 n 篇"
	// once the run starts (kept in sync in applyStats).
	const heroSub = readout.createDiv({ cls: "semlink-guide-index-statlabel", text: t("guideStatTotalNotes") });
	// Which provider + model this extraction uses — a quiet capsule under
	// the readout.
	const recipe = hero.createDiv({ cls: "semlink-guide-index-recipe" });
	const providerSvg = providerLogo(active.name);
	if (providerSvg) {
		const providerIconEl = recipe.createSpan({ cls: "semlink-guide-index-recipe-icon" });
		setSvgIcon(providerIconEl, providerSvg);
	}
	recipe.createSpan({ cls: "semlink-guide-index-recipe-name", text: active.name });
	recipe.createSpan({ cls: "semlink-guide-index-recipe-sep", text: "·" });
	const modelSvg = modelBrand(active.model);
	if (modelSvg) {
		const modelIconEl = recipe.createSpan({ cls: "semlink-guide-index-recipe-icon" });
		setSvgIcon(modelIconEl, modelSvg);
	}
	recipe.createSpan({ cls: "semlink-guide-index-recipe-model", text: active.model });

	// Order-ticket deck: the receipt stack hangs right under the printer,
	// EXACTLY as wide as the recipe capsule (measured, any sidebar width).
	const deckHost = hero.createDiv({ cls: "semlink-guide-index-ticketdeck" });
	const deckWidth = Math.max(60, Math.min((recipe.clientWidth || 184) + 16, 200));
	deckHost.style.width = `${deckWidth}px`;
	const deckFx = mountTicketDeck(deckHost, deckWidth);

	// Remaining-time line.
	const timerow = panel.createDiv({ cls: "semlink-guide-index-timerow semlink-hidden" });
	const vEta = timerow.createSpan({ cls: "semlink-guide-index-timeitem" });

	// Footer: just the run control (开始 ▶ primary → ⏸️ 暂停 ⇄ ▶️ 继续,
	// secondary while running). 下一步 to the chat-model step only appears
	// once the run completes.
	const footer = root.createDiv({ cls: "semlink-guide-footer semlink-guide-footer-index" });
	const startBtn = footer.createEl("button", { cls: "semlink-guide-save semlink-guide-primary", text: t("guideStartIndex") });
	const nextBtn = footer.createEl("button", { cls: "semlink-guide-save semlink-guide-secondary semlink-hidden", text: t("guideNext") });
	nextBtn.addEventListener("click", () => onNext());

	let running = host.isIndexing();
	let paused = host.isIndexPaused();
	let done = false;
	let prevActive = new Set<string>(); // concurrently brewing notes
	let prevProgress = ""; // last chunk-batch label (pour bursts on change)
	let lastTotal = 0; // last seen total note count (kept on the label when done)

	const applyStamp = (): void => {
		if (done) stamp.setText(t("guideCoffeeReady"));
		else stamp.setText(t(running && !paused ? "guideStampExtract" : "guideStampPreparing"));
	};

	const applyButton = (): void => {
		if (done) {
			startBtn.addClass("semlink-hidden");
			nextBtn.removeClass("semlink-hidden");
			nextBtn.addClass("semlink-guide-primary");
		} else if (paused) {
			startBtn.setText(`▶️ ${t("guideResumeIndex")}`);
			startBtn.removeClass("semlink-guide-primary");
		} else if (running) {
			startBtn.setText(`⏸️ ${t("guidePauseIndex")}`);
			startBtn.removeClass("semlink-guide-primary");
		} else {
			startBtn.setText(`▶️ ${t("guideStartIndex")}`);
			startBtn.addClass("semlink-guide-primary");
		}
		applyStamp();
	};

	startBtn.addEventListener("click", () => {
		if (!running) {
			host.startIndexing(applyStats, onDone);
			running = true;
			paused = false;
		} else if (!paused) {
			host.pauseIndexing();
			paused = true;
			coffeeFx.setBrewing(false);
		} else {
			host.resumeIndexing();
			paused = false;
			coffeeFx.setBrewing(true);
		}
		applyButton();
	});

	// Live progress handlers (referenced by the button handlers below).
	const durText = (sec: number): string => {
		if (!sec || sec <= 0) return "";
		if (sec < 60) return t("guideDurSec").replace("{s}", String(Math.round(sec)));
		const m = Math.floor(sec / 60);
		const s = Math.round(sec % 60);
		if (m < 60) return t("guideDurMinSec").replace("{m}", String(m)).replace("{s}", String(s));
		return t("guideDurHourMin").replace("{h}", String(Math.floor(m / 60))).replace("{m}", String(m % 60));
	};
	// DOM writes only when the text actually changed — progress events can
	// fire far faster than the eye needs, and redundant writes force layout.
	const setIfChanged = (el: HTMLElement, text: string): void => {
		if (el.textContent !== text) el.setText(text);
	};
	const setHidden = (el: HTMLElement, hidden: boolean): void => {
		el.toggleClass("semlink-hidden", hidden);
	};

	const applyStatsRaw = (s: IndexStatsView): void => {
		panel.addClass("is-running");
		timerow.removeClass("semlink-hidden");
		const pct = s.total > 0 ? (s.processed / s.total) * 100 : 0;
		// The hero readout morphs into the live percentage…
		setIfChanged(heroNum, `${pct.toFixed(1)}%`);
		setIfChanged(heroSub, `${s.processed}/${s.total}`);
		lastTotal = s.total;
		coffeeFx.setLevel(pct, true);
		// Concurrent indexing: every in-flight note (with its own chunk
		// progress) goes to the cup; a newcomer triggers the pour splash.
		for (const f of s.activeFiles) {
			if (!prevActive.has(f.path)) {
				coffeeFx.pour(f.path.split("/").pop() || f.path);
			}
		}
		prevActive = new Set(s.activeFiles.map((f) => f.path));
		deckFx.setFiles(s.activeFiles.map((f) => ({
			name: f.path.split("/").pop() || f.path,
			progress: f.progress,
		})));
		// A fresh chunk batch (1/4 → 2/4 …) fires a pour-stream burst.
		if (s.fileChunkProgress && s.fileChunkProgress !== prevProgress) {
			prevProgress = s.fileChunkProgress;
			const newest = s.activeFiles[s.activeFiles.length - 1];
			coffeeFx.pour(newest ? newest.path.split("/").pop() || newest.path : "");
		}
		const eta = durText(s.estimatedRemainingSec);
		setIfChanged(vEta, eta ? t("guideEta").replace("{dur}", eta) : "");
		setHidden(vEta, !eta);
	};

	// Throttle the view to ~5 fps: the scheduler can emit progress far more
	// often; the eye (and the canvas) needs a fraction of that.
	const APPLY_MIN_MS = 200;
	let lastApply = 0;
	let pendingStats: IndexStatsView | null = null;
	let applyTimer = 0;
	const applyStats = (s: IndexStatsView): void => {
		pendingStats = s;
		const now = Date.now();
		const wait = APPLY_MIN_MS - (now - lastApply);
		if (wait <= 0) {
			lastApply = now;
			if (applyTimer) {
				window.clearTimeout(applyTimer);
				applyTimer = 0;
			}
			applyStatsRaw(s);
		} else if (!applyTimer) {
			applyTimer = window.setTimeout(() => {
				applyTimer = 0;
				lastApply = Date.now();
				if (pendingStats) applyStatsRaw(pendingStats);
			}, wait);
		}
	};
	const onDone = (): void => {
		// Flush any throttled stats so the finals reflect the true end state.
		if (applyTimer) {
			window.clearTimeout(applyTimer);
			applyTimer = 0;
		}
		if (pendingStats) applyStatsRaw(pendingStats);
		// The brew is served — stop the barista chatter (applyStamp sets it).
		panel.removeClass("is-running");
		panel.addClass("is-done");
		coffeeFx.setLevel(100, true);
		coffeeFx.celebrate();
		coffeeFx.setBrewing(false);
		heroNum.setText("100%");
		// The sub-label keeps the note count (not a slogan) — the stamp is
		// where "你的知识特调已备好" lives once the run is done.
		heroSub.setText(t("guideNotesTotal").replace("{n}", String(lastTotal || est.notes)));
		timerow.addClass("semlink-hidden");
		running = false;
		paused = false;
		done = true;
		applyButton();
	};

	// Already indexing (autoIndex kicked in) → attach live, show the pause state.
	if (running) {
		host.watchIndexing(applyStats, onDone);
	}
	applyButton();
}




// ──── Manual model-ID entry dialog ────

/** "添加模型" dialog: enter a model ID, it is validated against the
 *  provider endpoint (chat or embedding probe) before being added and
 *  selected. */
class AddModelModal extends Modal {
	constructor(
		plugin: SmartVaultPlugin,
		private provider: ModelProvider,
		private kind: "chat" | "embedding",
		private onConfirm: (id: string) => void,
	) {
		super(plugin.app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: t("addModelTitle") });
		const input = contentEl.createEl("input", {
			cls: "semlink-guide-keyinput semlink-guide-fullwidth",
			type: "text",
			placeholder: t("addModelPlaceholder"),
		});
		const error = contentEl.createDiv({ cls: "semlink-guide-error" });
		const confirmBtn = contentEl.createEl("button", {
			cls: "semlink-guide-save semlink-guide-primary semlink-guide-fullwidth semlink-guide-gap-top",
			text: t("confirm"),
		});

		const confirm = async (): Promise<void> => {
			const id = input.value.trim();
			if (!id) {
				error.setText(t("addModelPlaceholder"));
				return;
			}
			confirmBtn.disabled = true;
			confirmBtn.setText(t("guideValidating"));
			try {
				const ok = await validateModelId(this.provider.apiBase, this.provider.apiKey, this.provider.apiFormat, id, this.kind);
				if (!ok) {
					error.setText(t("addModelInvalid"));
					return;
				}
				this.onConfirm(id);
				this.close();
			} catch (e) {
				error.setText(t("guideFetchFailed").replace("{err}", e instanceof Error ? e.message : String(e)));
			} finally {
				confirmBtn.disabled = false;
				confirmBtn.setText(t("confirm"));
			}
		};
		confirmBtn.addEventListener("click", () => void confirm());
		input.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter") {
				evt.preventDefault();
				void confirm();
			}
		});
		window.setTimeout(() => input.focus());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}