// ========================================
// Semlink - Settings: Models tab (provider list)
// ========================================
// DSH-style provider management: a vertical list of provider rows (fixed
// embedding providers + user-managed chat providers), one editor card open at
// a time, plus "Add provider" (catalog) and "Add a custom provider" flows.
// Chat providers support fetching the model list from their own endpoint.

import { App, Modal, Setting, requestUrl, setIcon } from "obsidian";
import type SmartVaultPlugin from "../main";
import type { ChatApiFormat, ChatModel, ChatProvider, EmbeddingProvider, EmbeddingProviderConfig } from "./types";
import { t } from "./i18n";

// ──── Tab state (owned by SmartVaultSettingTab, survives re-renders) ────

export interface ModelsTabState {
	/** Which provider's editor card is expanded, if any. */
	editing: { kind: "embedding" | "chat"; id: string } | null;
	/** Which add-card is open below the list. */
	adding: "catalog" | "custom" | null;
}

export const EMPTY_MODELS_TAB_STATE: ModelsTabState = {
	editing: null,
	adding: null,
};

// ──── Provider catalog (chat) ────

/** Embedding model choices for a provider family (used by the embedding
 *  provider editors and the General tab's combined service/model dropdown). */
export function embeddingModelChoices(kind: EmbeddingProvider): Record<string, string> {
	if (kind === "huggingface") {
		return {
			"BAAI/bge-m3": `BAAI/bge-m3 (${t("modelRecommended")})`,
			"BAAI/bge-large-zh-v1.5": `BAAI/bge-large-zh-v1.5 (${t("modelZhOptimized")})`,
			"BAAI/bge-large-en-v1.5": `BAAI/bge-large-en-v1.5 (${t("modelEnOptimized")})`,
			"intfloat/multilingual-e5-large": `intfloat/multilingual-e5-large (${t("modelZhOptimized")})`,
		};
	}
	return {
		"BAAI/bge-m3": `BAAI/bge-m3 (${t("modelRecommended")})`,
		"Pro/BAAI/bge-m3": `Pro/BAAI/bge-m3 (${t("modelEnhanced")})`,
		"BAAI/bge-large-zh-v1.5": `BAAI/bge-large-zh-v1.5 (${t("modelZhOptimized")})`,
		"BAAI/bge-large-en-v1.5": `BAAI/bge-large-en-v1.5 (${t("modelEnOptimized")})`,
	};
}

interface CatalogEntry {
	name: string;
	baseUrl: string;
	apiFormat: ChatApiFormat;
	models: ChatModel[];
}

const CHAT_CATALOG: CatalogEntry[] = [
	{
		name: "DeepSeek",
		baseUrl: "https://api.deepseek.com",
		apiFormat: "openai",
		models: [
			{ id: "deepseek-v4-flash", contextWindow: 200000 },
			{ id: "deepseek-v4-pro", contextWindow: 200000 },
		],
	},
	{
		name: t("catalogOpenAI"),
		baseUrl: "https://api.openai.com/v1",
		apiFormat: "openai",
		models: [
			{ id: "gpt-4o", contextWindow: 128000 },
			{ id: "gpt-4o-mini", contextWindow: 128000 },
		],
	},
	{
		name: t("catalogAnthropic"),
		baseUrl: "https://api.anthropic.com",
		apiFormat: "anthropic",
		models: [
			{ id: "claude-sonnet-4-5", contextWindow: 200000 },
			{ id: "claude-haiku-4-5", contextWindow: 200000 },
		],
	},
	{
		name: t("catalogMoonshot"),
		baseUrl: "https://api.moonshot.cn/v1",
		apiFormat: "openai",
		models: [{ id: "kimi-k2", contextWindow: 128000 }],
	},
	{
		name: t("catalogZhipu"),
		baseUrl: "https://open.bigmodel.cn/api/paas/v4",
		apiFormat: "openai",
		models: [{ id: "glm-4.5", contextWindow: 128000 }],
	},
	{
		name: t("catalogQwen"),
		baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		apiFormat: "openai",
		models: [
			{ id: "qwen-max", contextWindow: 32000 },
			{ id: "qwen-plus", contextWindow: 128000 },
		],
	},
];

// ──── Fetch available models ────

/** Query an OpenAI/Anthropic-compatible endpoint for its model ids. */
async function fetchAvailableModels(
	baseUrl: string,
	apiKey: string,
	apiFormat: ChatApiFormat,
): Promise<string[]> {
	const base = (baseUrl || "").trim().replace(/\/+$/, "");
	if (!base) throw new Error(t("fetchNeedsBaseUrl"));
	const url = apiFormat === "anthropic" ? `${base}/v1/models` : `${base}/models`;
	const headers: Record<string, string> = apiFormat === "anthropic"
		? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
		: { Authorization: `Bearer ${apiKey}` };
	const resp = await requestUrl({ url, method: "GET", headers, throw: false });
	if (resp.status !== 200) {
		throw new Error(`${t("fetchFailed")} (HTTP ${resp.status})`);
	}
	const data = (resp.json as { data?: unknown })?.data;
	if (!Array.isArray(data)) return [];
	return data
		.map((m: unknown) => (typeof (m as { id?: unknown })?.id === "string" ? (m as { id: string }).id : ""))
		.filter((id: string) => id.length > 0);
}

/** Candidate-picker modal (checkbox list); adopts the checked ids. */
class FetchModelsModal extends Modal {
	private picked = new Set<string>();

	constructor(
		app: App,
		private ids: string[],
		private existing: ReadonlySet<string>,
		private onAdopt: (ids: string[]) => void,
	) {
		super(app);
		this.modalEl.addClass("semlink-fetch-modal");
	}

	onOpen() {
		this.titleEl.setText(t("fetchTitle"));
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createDiv({ cls: "semlink-fetch-desc", text: t("fetchDescription") });

		const listEl = contentEl.createDiv({ cls: "semlink-fetch-list" });
		for (const id of this.ids) {
			const label = listEl.createEl("label", { cls: "semlink-fetch-item" });
			const cb = label.createEl("input", { attr: { type: "checkbox" } });
			// Everything already configured starts unchecked, so adopting a
			// selection never silently rewrites a tuned context window.
			if (!this.existing.has(id)) {
				cb.checked = true;
				this.picked.add(id);
			}
			cb.addEventListener("change", () => {
				if (cb.checked) this.picked.add(id);
				else this.picked.delete(id);
			});
			label.createSpan({ text: id });
			if (this.existing.has(id)) {
				label.createSpan({ cls: "semlink-fetch-existing", text: "✓" });
			}
		}

		new Setting(contentEl)
			.addButton((btn) => btn.setButtonText(t("cancel")).onClick(() => this.close()))
			.addButton((btn) =>
				btn
					.setButtonText(t("fetchAdopt"))
					.setClass("mod-cta")
					.onClick(() => {
						this.onAdopt([...this.picked]);
						this.close();
					})
			);
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** Delete-confirmation modal for a chat provider. */
class DeleteProviderModal extends Modal {
	constructor(
		app: App,
		private displayName: string,
		private onConfirm: () => void,
	) {
		super(app);
		this.modalEl.addClass("semlink-delete-modal");
	}

	onOpen() {
		this.titleEl.setText(t("deleteTitle").replace("{provider}", this.displayName));
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createDiv({ cls: "semlink-delete-desc", text: t("deleteDescription") });
		new Setting(contentEl)
			.addButton((btn) => btn.setButtonText(t("cancel")).onClick(() => this.close()))
			.addButton((btn) =>
				btn
					.setButtonText(t("deleteConfirm"))
					.setWarning()
					.onClick(() => {
						this.close();
						this.onConfirm();
					})
			);
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ──── Model list editor (shared by chat editors and create cards) ────

export interface ModelProbe {
	baseUrl: string;
	apiKey: string;
	apiFormat: ChatApiFormat;
}

interface ModelListOptions {
	app: App;
	/** Read the current model rows (may be replaced after each change). */
	getModels: () => ChatModel[];
	/** Persist a (possibly new) model list. */
	onChange: (models: ChatModel[]) => void;
	/** Current endpoint facts for the fetch action. */
	probe: () => ModelProbe;
}

interface ModelListHandle {
	/** Re-evaluate the fetch button's disabled state (call after the probe
	 *  fields — baseUrl / apiKey — change in the surrounding editor). */
	updateProbeState: () => void;
}

/** Render the model rows of one chat provider with add/fetch/remove actions. */
function renderModelList(containerEl: HTMLElement, opts: ModelListOptions): ModelListHandle {
	const section = containerEl.createDiv({ cls: "semlink-model-list" });
	const headEl = section.createDiv({ cls: "semlink-model-list-head" });
	headEl.createSpan({ cls: "semlink-model-list-title", text: t("chatModels") });
	// Model-level type marker: these are chat models (providers carry no
	// embedding/chat label).
	headEl.createSpan({ cls: "semlink-provider-tag", text: t("modelTagChat") });
	const countEl = headEl.createSpan({ cls: "semlink-model-list-count" });
	const fetchBtn = headEl.createEl("button", { cls: "semlink-link-btn", text: t("fetchModels") });
	const rowsEl = section.createDiv({ cls: "semlink-model-rows" });
	const errorEl = section.createDiv({ cls: "semlink-model-error" });
	errorEl.style.display = "none";
	const addBtn = section.createEl("button", { cls: "semlink-add-model-btn", text: `＋ ${t("chatAddModel")}` });

	let fetching = false;

	const updateProbeState = () => {
		const { baseUrl, apiKey } = opts.probe();
		const ok = baseUrl.trim().length > 0 && apiKey.trim().length > 0;
		(fetchBtn as HTMLButtonElement).disabled = !ok || fetching;
		fetchBtn.setAttr("title", ok ? "" : t("fetchNeedsBaseUrl"));
	};

	const rerender = () => {
		const models = opts.getModels();
		countEl.setText(`(${String(models.length)})`);
		rowsEl.empty();
		models.forEach((model, mi) => {
			const rowEl = rowsEl.createDiv({ cls: "semlink-model-row" });
			const idInput = rowEl.createEl("input", {
				cls: "semlink-input",
				attr: { placeholder: t("chatModelId") },
			});
			idInput.value = model.id;
			idInput.addEventListener("input", () => {
				model.id = idInput.value;
				opts.onChange(models);
			});
			const ctxInput = rowEl.createEl("input", {
				cls: "semlink-input semlink-input-ctx",
				attr: { placeholder: t("chatContextWindow"), type: "number", min: "1" },
			});
			ctxInput.value = String(model.contextWindow);
			ctxInput.addEventListener("input", () => {
				const n = parseInt(ctxInput.value, 10);
				if (!isNaN(n) && n > 0) {
					model.contextWindow = n;
					opts.onChange(models);
				}
			});
			const rmBtn = rowEl.createEl("button", {
				cls: "semlink-icon-btn semlink-icon-btn-danger",
				attr: { "aria-label": `${t("chatDeleteModel")} ${mi + 1}` },
			});
			setIcon(rmBtn, "trash");
			rmBtn.addEventListener("click", () => {
				models.splice(mi, 1);
				opts.onChange(models);
				rerender();
			});
		});
		updateProbeState();
	};

	addBtn.addEventListener("click", () => {
		opts.getModels().push({ id: "", contextWindow: 128000 });
		opts.onChange(opts.getModels());
		rerender();
	});

	fetchBtn.addEventListener("click", async () => {
		const { baseUrl, apiKey, apiFormat } = opts.probe();
		fetching = true;
		fetchBtn.setText(t("fetching"));
		updateProbeState();
		errorEl.style.display = "none";
		try {
			const ids = await fetchAvailableModels(baseUrl, apiKey, apiFormat);
			if (ids.length === 0) {
				errorEl.setText(t("fetchEmpty"));
				errorEl.style.display = "block";
				return;
			}
			const current = opts.getModels();
			const known = new Set(current.map((m) => m.id).filter((id) => id.length > 0));
			new FetchModelsModal(opts.app, ids, known, (picked) => {
				const byId = new Map(opts.getModels().map((m) => [m.id, m]));
				for (const id of picked) {
					if (!byId.has(id)) byId.set(id, { id, contextWindow: 128000 });
				}
				opts.onChange([...byId.values()]);
				rerender();
			}).open();
		} catch (e) {
			errorEl.setText(e instanceof Error ? e.message : String(e));
			errorEl.style.display = "block";
		} finally {
			fetching = false;
			fetchBtn.setText(t("fetchModels"));
			updateProbeState();
		}
	});

	rerender();
	return { updateProbeState };
}

// ──── Provider rows ────

interface RowOptions {
	name: string;
	/** Optional kind marker — providers themselves are NOT distinguished as
	 *  embedding/chat; the distinction lives on the models inside each editor. */
	tag?: string;
	dot?: "configured" | "missing";
	badge?: string;
	editing: boolean;
	onEdit: () => void;
	onDelete?: () => void;
}

/** Create one provider row; returns the editor slot below the row head. */
function createProviderRow(listEl: HTMLElement, opts: RowOptions): HTMLElement {
	const row = listEl.createDiv({ cls: `semlink-provider-row${opts.editing ? " is-open" : ""}` });
	const head = row.createDiv({ cls: "semlink-provider-row-head" });
	const identity = head.createDiv({ cls: "semlink-provider-identity" });
	identity.createSpan({ cls: "semlink-provider-name", text: opts.name });
	if (opts.tag) identity.createSpan({ cls: "semlink-provider-tag", text: opts.tag });
	if (opts.dot) {
		identity.createSpan({
			cls: `semlink-provider-dot ${opts.dot === "configured" ? "is-configured" : "is-missing"}`,
			attr: {
				title: opts.dot === "configured" ? t("credentialConfigured") : t("credentialMissing"),
				"aria-label": opts.dot === "configured" ? t("credentialConfigured") : t("credentialMissing"),
			},
		});
	}
	if (opts.badge) identity.createSpan({ cls: "semlink-provider-badge", text: opts.badge });
	const actions = head.createDiv({ cls: "semlink-provider-actions" });
	actions.createEl("button", { cls: "semlink-btn", text: t("edit") })
		.addEventListener("click", opts.onEdit);
	if (opts.onDelete) {
		actions.createEl("button", { cls: "semlink-btn semlink-btn-danger", text: t("remove") })
			.addEventListener("click", opts.onDelete);
	}
	return row.createDiv({ cls: "semlink-provider-editor" });
}

// ──── Editors ────

/** Editor for one fixed embedding provider (region + key + embedding model).
 *  The reranker stays on the General tab. */
function renderEmbeddingProviderEditor(slot: HTMLElement, plugin: SmartVaultPlugin, p: EmbeddingProviderConfig): void {
	new Setting(slot)
		.setName(p.kind === "huggingface" ? t("chatBaseUrl") : t("apiBase"))
		.addText((text) =>
			text
				.setPlaceholder("https://api.siliconflow.cn")
				.setValue(p.apiBase)
				.onChange(async (value) => {
					p.apiBase = value;
					await plugin.saveSettings();
				})
		);

	// Embedding model — the model-level type marker (嵌入) lives here, since
	// the provider itself carries no embedding/chat label.
	new Setting(slot)
		.setName(t("embeddingModel"))
		.addDropdown((dropdown) => {
			const options: Record<string, string> = {};
			for (const model of Object.keys(embeddingModelChoices(p.kind))) {
				options[model] = model;
			}
			if (!(p.model in options)) options[p.model] = p.model;
			dropdown
				.addOptions(options)
				.setValue(p.model)
				.onChange(async (value) => {
					p.model = value;
					await plugin.saveSettings();
				});
		})
		.then((setting) => {
			setting.nameEl.createSpan({ cls: "semlink-provider-tag semlink-inline-tag", text: t("modelTagEmbedding") });
		});

	new Setting(slot)
		.setName(t("apiKey"))
		.setDesc(p.kind === "huggingface"
			? t("huggingFaceApiKeyDesc")
			: t("apiKeyDesc").replace("{site}", p.apiBase.includes("siliconflow.com") ? "siliconflow.com" : "siliconflow.cn"))
		.addText((text) =>
			text
				.setPlaceholder("sk-...")
				.setValue(p.apiKey)
				.onChange(async (value) => {
					p.apiKey = value;
					await plugin.saveSettings();
				})
		)
		.then((setting) => {
			const input = setting.controlEl.querySelector("input") as HTMLInputElement | null;
			if (input) input.type = "password";
		});

	slot.createDiv({ cls: "semlink-hint", text: t("embedModelHint") });
}

/** Editor for one existing chat provider (saves on change). */
function renderChatProviderEditor(
	slot: HTMLElement,
	plugin: SmartVaultPlugin,
	provider: ChatProvider,
): void {
	const modelHandle = renderModelList(slot, {
		app: plugin.app,
		getModels: () => provider.models,
		onChange: (models) => {
			provider.models = models;
			void plugin.saveSettings();
		},
		probe: () => ({ baseUrl: provider.baseUrl, apiKey: provider.apiKey, apiFormat: provider.apiFormat }),
	});

	new Setting(slot)
		.setName(t("chatProviderName"))
		.addText((text) =>
			text
				.setPlaceholder("DeepSeek")
				.setValue(provider.name)
				.onChange(async (value) => {
					provider.name = value;
					await plugin.saveSettings();
				})
		);

	new Setting(slot)
		.setName(t("chatBaseUrl"))
		.addText((text) =>
			text
				.setPlaceholder("https://api.example.com")
				.setValue(provider.baseUrl)
				.onChange(async (value) => {
					provider.baseUrl = value;
					await plugin.saveSettings();
					modelHandle.updateProbeState();
				})
		);

	new Setting(slot)
		.setName(t("chatApiKey"))
		.addText((text) =>
			text
				.setPlaceholder("sk-...")
				.setValue(provider.apiKey)
				.onChange(async (value) => {
					provider.apiKey = value;
					await plugin.saveSettings();
					modelHandle.updateProbeState();
				})
		)
		.then((setting) => {
			const input = setting.controlEl.querySelector("input") as HTMLInputElement | null;
			if (input) input.type = "password";
		});

	new Setting(slot)
		.setName(t("chatApiFormat"))
		.addDropdown((dropdown) =>
			dropdown
				.addOptions({
					"openai": t("chatFormatOpenAI"),
					"anthropic": t("chatFormatAnthropic"),
				})
				.setValue(provider.apiFormat)
				.onChange(async (value) => {
					provider.apiFormat = value as ChatApiFormat;
					await plugin.saveSettings();
					modelHandle.updateProbeState();
				})
		);
}

// ──── Create cards (add provider / add custom provider) ────

interface ChatProviderDraft {
	name: string;
	baseUrl: string;
	apiKey: string;
	apiFormat: ChatApiFormat;
	models: ChatModel[];
}

const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

interface DraftEditorOptions {
	submitLabel: string;
	submitBusyLabel: string;
	/** Present on the custom-provider card: the route-id field. */
	route?: {
		/** Live route-id value (read at submit time). */
		getValue: () => string;
		onChange: (v: string) => void;
	};
	onCancel: () => void;
	onCreated: (provider: ChatProvider) => void;
}

/** Field set shared by the catalog-add and custom-provider create cards. */
function renderDraftEditor(
	slot: HTMLElement,
	plugin: SmartVaultPlugin,
	draft: ChatProviderDraft,
	opts: DraftEditorOptions,
): void {
	const errorEl = slot.createDiv({ cls: "semlink-draft-error" });
	errorEl.style.display = "none";
	let busy = false;

	const modelHandle = renderModelList(slot, {
		app: plugin.app,
		getModels: () => draft.models,
		onChange: (models) => {
			draft.models = models;
		},
		probe: () => ({ baseUrl: draft.baseUrl, apiKey: draft.apiKey, apiFormat: draft.apiFormat }),
	});

	if (opts.route) {
		new Setting(slot)
			.setName(t("customRoute"))
			.setDesc(t("customRouteHint"))
			.addText((text) =>
				text
					.setPlaceholder("acme-gateway")
					.setValue(opts.route!.getValue())
					.onChange((value) => opts.route!.onChange(value))
			)
			.then((setting) => {
				const input = setting.controlEl.querySelector("input") as HTMLInputElement | null;
				const updateHint = () => {
					const v = (input?.value ?? "").trim();
					if (v.length > 0 && !ROUTE_PATTERN.test(v)) {
						setting.descEl.setText(t("customRouteInvalid"));
						setting.descEl.addClass("is-error");
					} else if (plugin.settings.chatProviders.some((p) => p.id === v)) {
						setting.descEl.setText(t("customRouteTaken"));
						setting.descEl.addClass("is-error");
					} else {
						setting.descEl.setText(t("customRouteHint"));
						setting.descEl.removeClass("is-error");
					}
				};
				input?.addEventListener("input", updateHint);
				updateHint();
			});
	}

	new Setting(slot)
		.setName(t("chatProviderName"))
		.addText((text) =>
			text
				.setPlaceholder("My Gateway")
				.setValue(draft.name)
				.onChange((value) => {
					draft.name = value;
				})
		);

	new Setting(slot)
		.setName(t("chatBaseUrl"))
		.addText((text) =>
			text
				.setPlaceholder("https://api.example.com")
				.setValue(draft.baseUrl)
				.onChange((value) => {
					draft.baseUrl = value;
					modelHandle.updateProbeState();
				})
		);

	new Setting(slot)
		.setName(t("chatApiKey"))
		.addText((text) =>
			text
				.setPlaceholder("sk-...")
				.setValue(draft.apiKey)
				.onChange((value) => {
					draft.apiKey = value;
					modelHandle.updateProbeState();
				})
		)
		.then((setting) => {
			const input = setting.controlEl.querySelector("input") as HTMLInputElement | null;
			if (input) input.type = "password";
		});

	new Setting(slot)
		.setName(t("chatApiFormat"))
		.addDropdown((dropdown) =>
			dropdown
				.addOptions({
					"openai": t("chatFormatOpenAI"),
					"anthropic": t("chatFormatAnthropic"),
				})
				.setValue(draft.apiFormat)
				.onChange((value) => {
					draft.apiFormat = value as ChatApiFormat;
					modelHandle.updateProbeState();
				})
		);

	new Setting(slot)
		.addButton((btn) => btn.setButtonText(t("cancel")).onClick(() => opts.onCancel()))
		.addButton((btn) => {
			btn.setButtonText(opts.submitLabel).setClass("mod-cta").onClick(async () => {
				if (busy) return;
				errorEl.style.display = "none";
				const routeValue = opts.route ? opts.route.getValue().trim() : "";
				const routeInvalid = routeValue.length > 0 && !ROUTE_PATTERN.test(routeValue);
				const routeTaken = routeValue.length > 0
					&& plugin.settings.chatProviders.some((p) => p.id === routeValue);
				if (opts.route && (routeInvalid || routeTaken)) {
					errorEl.setText(routeInvalid ? t("customRouteInvalid") : t("customRouteTaken"));
					errorEl.style.display = "block";
					return;
				}
				if (!draft.baseUrl.trim()) {
					errorEl.setText(t("customNeedsBaseUrl"));
					errorEl.style.display = "block";
					return;
				}
				if (draft.models.length === 0 || draft.models.some((m) => !m.id.trim())) {
					errorEl.setText(t("customNeedsModels"));
					errorEl.style.display = "block";
					return;
				}
				busy = true;
				btn.setButtonText(opts.submitBusyLabel).setDisabled(true);
				const provider: ChatProvider = {
					id: opts.route ? routeValue : `provider-${Date.now()}`,
					name: draft.name.trim() || draft.baseUrl.trim(),
					baseUrl: draft.baseUrl.trim(),
					apiKey: draft.apiKey,
					apiFormat: draft.apiFormat,
					models: draft.models.map((m) => ({ ...m })),
				};
				plugin.settings.chatProviders.push(provider);
				await plugin.saveSettings();
				opts.onCreated(provider);
			});
		});
}

/** "Add provider" card: pick a catalog entry, then fill in the details. */
function renderAddCatalogCard(
	containerEl: HTMLElement,
	plugin: SmartVaultPlugin,
	state: ModelsTabState,
	refresh: () => void,
): void {
	const card = containerEl.createDiv({ cls: "semlink-add-card" });
	card.createDiv({ cls: "semlink-add-card-title", text: t("addProvider") });

	let draft: ChatProviderDraft = draftFromCatalog(CHAT_CATALOG[0]);
	const bodyEl = card.createDiv({ cls: "semlink-add-card-body" });

	const rerenderDraft = () => {
		bodyEl.empty();
		renderDraftEditor(bodyEl, plugin, draft, {
			submitLabel: t("create"),
			submitBusyLabel: t("creating"),
			onCancel: () => {
				state.adding = null;
				refresh();
			},
			onCreated: (provider) => {
				state.adding = null;
				state.editing = { kind: "chat", id: provider.id };
				refresh();
			},
		});
	};

	new Setting(card)
		.setName(t("catalogLabel"))
		.addDropdown((dropdown) =>
			dropdown
				.addOptions(Object.fromEntries(CHAT_CATALOG.map((c, i) => [String(i), c.name])))
				.setValue("0")
				.onChange((value) => {
					draft = draftFromCatalog(CHAT_CATALOG[parseInt(value, 10)]);
					rerenderDraft();
				})
		);

	rerenderDraft();
}

function draftFromCatalog(entry: CatalogEntry): ChatProviderDraft {
	return {
		name: entry.name,
		baseUrl: entry.baseUrl,
		apiKey: "",
		apiFormat: entry.apiFormat,
		models: entry.models.map((m) => ({ ...m })),
	};
}

/** "Add a custom provider" card: route id + full details. */
function renderCustomCard(
	containerEl: HTMLElement,
	plugin: SmartVaultPlugin,
	state: ModelsTabState,
	refresh: () => void,
): void {
	const card = containerEl.createDiv({ cls: "semlink-add-card" });
	card.createDiv({ cls: "semlink-add-card-title", text: t("customTitle") });

	const routeState = { value: "" };
	const draft: ChatProviderDraft = {
		name: "",
		baseUrl: "",
		apiKey: "",
		apiFormat: "openai",
		models: [],
	};

	const bodyEl = card.createDiv({ cls: "semlink-add-card-body" });
	renderDraftEditor(bodyEl, plugin, draft, {
		submitLabel: t("create"),
		submitBusyLabel: t("creating"),
		route: {
			getValue: () => routeState.value,
			onChange: (v) => {
				routeState.value = v;
			},
		},
		onCancel: () => {
			state.adding = null;
			refresh();
		},
		onCreated: (provider) => {
			state.adding = null;
			state.editing = { kind: "chat", id: provider.id };
			refresh();
		},
	});
}

// ──── Main render ────

export function renderModelsTab(
	plugin: SmartVaultPlugin,
	containerEl: HTMLElement,
	state: ModelsTabState,
	refresh: () => void,
): void {
	new Setting(containerEl).setName(t("sectionModel")).setHeading();

	// One unified provider list: fixed embedding providers (SiliconFlow
	// CN/Global, Hugging Face) first, then the user-managed chat providers.
	// The per-row tag (嵌入 / 对话) tells the kinds apart — no group headers.
	const listEl = containerEl.createDiv({ cls: "semlink-provider-rows" });

	for (const p of plugin.settings.embeddingProviders) {
		const editing = state.editing?.kind === "embedding" && state.editing.id === p.id;
		const active = p.id === plugin.settings.embeddingProviderId;
		const slot = createProviderRow(listEl, {
			name: p.name,
			// No embedding/chat tag on the provider — the distinction lives on
			// the models inside each editor. The badge just marks the provider
			// currently used as the embedding service.
			dot: p.apiKey ? "configured" : "missing",
			badge: active ? t("embedInUse") : undefined,
			editing,
			onEdit: () => {
				state.editing = editing ? null : { kind: "embedding", id: p.id };
				state.adding = null;
				refresh();
			},
		});
		if (editing) renderEmbeddingProviderEditor(slot, plugin, p);
	}

	for (const provider of plugin.settings.chatProviders) {
		const editing = state.editing?.kind === "chat" && state.editing.id === provider.id;
		const slot = createProviderRow(listEl, {
			name: provider.name || provider.id,
			dot: provider.apiKey ? "configured" : "missing",
			editing,
			onEdit: () => {
				state.editing = editing ? null : { kind: "chat", id: provider.id };
				state.adding = null;
				refresh();
			},
			onDelete: () => {
				new DeleteProviderModal(plugin.app, provider.name || provider.id, () => {
					plugin.settings.chatProviders = plugin.settings.chatProviders.filter(
						(p) => p.id !== provider.id,
					);
					if (state.editing?.kind === "chat" && state.editing.id === provider.id) {
						state.editing = null;
					}
					void plugin.saveSettings().then(() => refresh());
				}).open();
			},
		});
		if (editing) renderChatProviderEditor(slot, plugin, provider);
	}

	// ── Add actions / create cards ──
	const addBlock = containerEl.createDiv({ cls: "semlink-provider-add" });
	if (state.adding === "catalog") {
		renderAddCatalogCard(addBlock, plugin, state, refresh);
	} else if (state.adding === "custom") {
		renderCustomCard(addBlock, plugin, state, refresh);
	} else {
		const actions = addBlock.createDiv({ cls: "semlink-provider-add-actions" });
		actions.createEl("button", { cls: "semlink-btn semlink-btn-cta", text: `＋ ${t("addProvider")}` })
			.addEventListener("click", () => {
				state.adding = "catalog";
				state.editing = null;
				refresh();
			});
		actions.createEl("button", { cls: "semlink-btn", text: `＋ ${t("addCustomProvider")}` })
			.addEventListener("click", () => {
				state.adding = "custom";
				state.editing = null;
				refresh();
			});
	}
}
