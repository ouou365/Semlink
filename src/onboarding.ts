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

import { Modal } from "obsidian";
import { mountCoffeeCanvas, mountTicketDeck } from "./coffee-canvas";
import { AddProviderModal, brandLogoOf, buildGuideProviderGroups, CHAT_CATALOG, fetchAvailableModels, fetchModelIds, providerLogo, validateModelId, setSvgIcon } from "./settings-models";
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
				// An already-keyed provider jumps straight to the model
				// picker — no need to re-enter the key.
				const ready = !!p.apiKey.trim();
				plugin.settings.onboarding = { ...(plugin.settings.onboarding ?? {}), providerId: p.id, chatReady: ready };
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

		// Sub-state A: pick a provider — 分组与排序同设置页（系列文件夹 +
		// 已配置 Key 置顶 + 市场排名），文件夹点击展开成员。
		if (!provider) {
			const list = body.createDiv({ cls: "semlink-guide-options" });
			let expanded: string | null = null;
			const redrawList = (): void => {
				list.empty();
				for (const item of buildGuideProviderGroups(plugin)) {
					const pick = (name: string): void => {
						const p = ensureCatalogProvider(plugin, name);
						if (p) opts.onPickProvider(p);
					};
					if (item.members) {
						const isOpen = expanded === item.name;
						card(list, {
							logo: brandLogoOf(item.members[0]).svg,
							text: item.name,
							meta: `${item.members.length} ${isOpen ? "▴" : "▾"}`,
							dot: item.configured ? "configured" : undefined,
							onClick: () => {
								expanded = isOpen ? null : item.name;
								redrawList();
							},
						});
						if (isOpen) {
							for (const member of item.members) {
								const configured = plugin.settings.providers.some(
									(x) => x.name === member && !!x.apiKey.trim(),
								);
								const memberCard = card(list, {
									logo: brandLogoOf(member).svg,
									text: member,
									dot: configured ? "configured" : undefined,
									onClick: () => pick(member),
								});
								memberCard.addClass("semlink-guide-card-member");
							}
						}
					} else {
						card(list, {
							logo: brandLogoOf(item.name).svg,
							text: item.name,
							dot: item.configured ? "configured" : undefined,
							onClick: () => pick(item.name),
						});
					}
				}
			};
			redrawList();
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
			formatSelect.value = provider.wirePath === "/" ? "bare" : provider.apiFormat;

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
			if (m.enabled !== true || (isChat ? kind !== "chat" : kind !== "embedding")) return false;
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
		if (fetchHint) error.setText(fetchHint);
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