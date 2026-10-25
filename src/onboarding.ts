// ========================================
// Semlink - First-run onboarding guide
// ========================================
// Conversational setup guide rendered on the search welcome screen.
// CHAT-FIRST and embedding-free: a single screen walks the user through
// Provider → Key → Model (the stepper mirrors that sub-progress). Embedding
// and data indexing are an EXTENSION, configured later in Settings when
// needed — the agent answers without vectors and can ground itself via
// grep/read, which need no embeddings. Each key is validated by
// fetching the provider's model list before the model picker shows. All
// state lives in `settings.onboarding`, so the guide survives re-renders
// (time-slot refresh, language switch) and restarts.

import { Modal, ToggleComponent, setIcon } from "obsidian";
import { AddModelModal, AddProviderModal, brandLogoOf, buildGuideProviderGroups, catalogEndpoint, CHAT_CATALOG, EMBEDDING_CATALOG, fetchAvailableModels, fetchModelIds, formatContextWindow, mergeEmbeddingCatalogModels, modelBrandOf, setSvgIcon } from "./settings-models";
import type { FetchedModel, CatalogEntry } from "./settings-models";
import { mountCoffeeCanvas } from "./coffee-canvas";
import { t } from "./i18n";
import type SmartVaultPlugin from "../main";
import type { ChatApiFormat, ChatModel, IndexProgress, ModelProvider } from "./types";

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

/** 嵌入模型列表的品牌组顺序（海外用户视角）：美系主流 → 专业嵌入厂商 →
 *  欧系/企业开源 → 多语言 API → 开源权重（bge/qwen 全球通用）→ 本地运行时
 *  品牌 → 低价/免费路由 → 大陆区域端点殿后。未列出的品牌按字母序殿后。 */
const MODEL_BRAND_ORDER = [
	"openai", "google", "cohere", "voyageai", "mistral", "microsoft", "jina",
	"baai", "qwen", "nomic", "mixedbread", "perplexity", "nvidia", "minimax",
];

/** 品牌 key → 显示名（modelBrandOf 的返回值 → 组头文案）。 */
const MODEL_BRAND_LABELS: Record<string, string> = {
	openai: "OpenAI",
	google: "Google",
	voyageai: "Voyage AI",
	cohere: "Cohere",
	qwen: "Qwen",
	baai: "BAAI",
	mistral: "Mistral",
	minimax: "MiniMax",
	microsoft: "Microsoft",
	jina: "Jina",
	perplexity: "Perplexity",
	nvidia: "NVIDIA",
	nomic: "Nomic",
	mixedbread: "Mixedbread",
};


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
	mode: "chat" | "embed" = "chat",
): void {
	const root = container.createDiv({ cls: "semlink-guide" });

	const ob = (): NonNullable<SmartVaultPlugin["settings"]["onboarding"]> => plugin.settings.onboarding ?? {};
	const byId = (id?: string): ModelProvider | undefined =>
		id ? plugin.settings.providers.find((p) => p.id === id) : undefined;

	// 「重新配置」开始时快照的嵌入模型键：Key 重新验证通过后与新键比较，
	// 不一致说明换了嵌入模型（向量空间不兼容），触发全量重新索引。
	// 声明在下方恢复逻辑之前——恢复逻辑需要读取它判断是否处于重配流程。
	let reconfigFromKey: string | null = null;

	// 嵌入模型已配置（经模型页/旧版流程配置，或 openSetupGuide 每次打开
	// 都会清空引导进度）但引导状态未标记时，直接恢复为已完成——RAG 页
	// 「配置」点击后直达嵌入页，不必重走模型/密钥两步。重新配置流程除外：
	// reconfigFromKey 非空表示刚点了重新配置，必须从模型页开始。
	if (mode === "embed" && reconfigFromKey === null && !ob().embedModelPicked) {
		const key = plugin.settings.embeddingModelKey || "";
		const pid = key.split("::")[0] ?? "";
		const mid = key.split("::").slice(1).join("::");
		const prov = byId(pid);
		const configured = !!key && !!prov && !!prov.apiKey.trim()
			&& prov.models.some((m) => (m.kind ?? "chat") === "embedding" && m.id === mid);
		if (configured) {
			plugin.settings.onboarding = {
				...(plugin.settings.onboarding ?? {}),
				embedProviderId: pid,
				embedModelId: mid,
				embedReady: true,
				embedModelPicked: true,
			};
			void plugin.saveSettings();
		}
	}

	const onRestart = (): void => {
		plugin.settings.onboarding = { done: false };
		void plugin.saveSettings();
		rerender();
	};

	/** 嵌入引导的最后一步：白色面板、文档名在品牌 logo 上方，百分比与
	 *  数值按「已嵌入文档 / 总需嵌入文档」口径。进入本步即已自动开始嵌入，
	 *  按钮（面板内底部）= 状态机：暂停索引 ⇄ 开始索引 → 全部索引完成后
	 *  自动变为「完成」，点击回主页（主页触发彩带庆祝）。
	 *  进度订阅随 canvas 离开 DOM 自行解除。 */
	const renderEmbedIndexStep = (host: HTMLElement): void => {
		host.empty();
		const panel = host.createDiv({ cls: "semlink-guide-indexstats" });
		const hero = panel.createDiv({ cls: "semlink-guide-index-hero" });
		const cupHost = hero.createDiv();
		const modelId = (plugin.settings.embeddingModelKey.split("::")[1] ?? "").trim();
		const coffee = mountCoffeeCanvas(cupHost, {
			modelName: modelId,
			modelLogoSvg: brandLogoOf(modelBrandOf(modelId) ?? "").svg,
		});
		const statnum = hero.createDiv({ cls: "semlink-guide-index-statnum", text: "0%" });
		const statlabel = hero.createDiv({ cls: "semlink-guide-index-statlabel" });
		// 文档名 + 该文档的分片进展（数值下方）。名字与进度分属两个元素：
		// 名字可截断省略，进度永不挤压——长文件名不会把分片进度顶出视野。
		const fileEl = hero.createDiv({ cls: "semlink-guide-index-file" });
		const fileNameEl = fileEl.createSpan({ cls: "semlink-guide-index-file-name" });
		const fileProgEl = fileEl.createSpan({ cls: "semlink-guide-index-file-prog" });
		const timerow = hero.createDiv({ cls: "semlink-guide-index-timerow" });
		const doneBtn = hero.createEl("button", {
			cls: "semlink-guide-save semlink-guide-primary semlink-guide-index-done",
			text: t("guideIndexPause"),
		});
		// 重新配置：快照当前嵌入模型键，停掉进行中的索引（换模型后旧嵌入
		// 没有意义，且 reindexAll 需要调度器空闲），回到第一步（选模型）。
		const reconfigBtn = hero.createEl("button", {
			cls: "semlink-guide-save semlink-guide-secondary semlink-guide-index-reconfig",
			text: t("guideReconfig"),
		});
		reconfigBtn.addEventListener("click", () => {
			reconfigFromKey = plugin.settings.embeddingModelKey || "";
			plugin.scheduler.pause();
			plugin.settings.onboarding = {
				...(plugin.settings.onboarding ?? {}),
				embedProviderId: undefined,
				embedReady: false,
				embedModelPicked: false,
				embedModelId: undefined,
			};
			void plugin.saveSettings();
			rerender();
		});

		const fmtDur = (sec: number): string => {
			if (!Number.isFinite(sec) || sec <= 0) return "";
			const h = Math.floor(sec / 3600);
			const m = Math.floor((sec % 3600) / 60);
			const s = Math.max(0, Math.round(sec % 60));
			if (h > 0) return t("guideDurHourMin").replace("{h}", String(h)).replace("{m}", String(m));
			if (m > 0) return t("guideDurMinSec").replace("{m}", String(m)).replace("{s}", String(s));
			return t("guideDurSec").replace("{s}", String(s));
		};

		let lastFile = "";
		// 已嵌入文档数（chunks 表中至少一个分块带向量的笔记数），节流查库校正。
		// 不读 note_doc_vectors——该表会被算法迁移/换模型清空重建，迁移期会
		// 恒为 0；chunk 向量与笔记嵌入同事务落库，进度只增不减。
		let lastEmbedded = 0;
		let lastStatsAt = 0;
		const refreshEmbedded = async (): Promise<void> => {
			try {
				lastEmbedded = await plugin.store.getEmbeddedNoteCount();
				applyProgress(plugin.progress.current);
			} catch {
				/* worker 未就绪：下一拍重试 */
			}
		};
		// 意图状态机（只由按钮点击改变）：running ⇄ paused → done。
		// 暂停/恢复经 scheduler 异步生效，进度事件里的 isPaused 可能滞后
		// 若干拍——事件绝不回改用户意图，否则暂停按钮会立刻被翻回运行态。
		let state: "running" | "paused" | "done" = "running";
		let sawBusy = false; // 本步是否见过运行中的进度（进入时可能残留旧 completed）
		const setBtnAction = (text: string, onClick: () => void): void => {
			doneBtn.setText(text);
			doneBtn.onclick = onClick;
		};
		// 注意：setBtn 必须声明在 applyProgress 与下方首次调用之前——
		// applyProgress 末尾会调用 setBtn()，声明顺序不对会触发 TDZ
		// （"Cannot access before initialization"），按钮点击事件永远绑不上。
		const setBtn = (): void => {
			if (state === "paused") {
				setBtnAction(t("guideIndexResume"), () => {
					state = "running";
					plugin.scheduler.resume();
					plugin.app.workspace.trigger("smart-vault:resume");
					applyProgress(plugin.progress.current);
				});
			} else if (state === "done") {
				setBtnAction(t("guideFinishIndex"), () => {
					unsub();
					coffee.destroy();
					plugin.settings.onboarding = { ...(plugin.settings.onboarding ?? {}), done: true };
					void plugin.saveSettings();
					onFinish();
				});
			} else {
				setBtnAction(t("guideIndexPause"), () => {
					state = "paused";
					plugin.scheduler.pause();
					plugin.app.workspace.trigger("smart-vault:pause");
					applyProgress(plugin.progress.current);
				});
			}
		};
		const applyProgress = (p: IndexProgress): void => {
			const busy = p.phase === "scanning" || p.phase === "chunking"
				|| p.phase === "embedding" || p.phase === "building_index";
			if (busy) sawBusy = true;
			const total = Math.max(p.totalNotes, 0);
			if (sawBusy && total > 0 && p.phase === "completed") state = "done";
			// 文档口径：已嵌入文档 / 总笔记数（嵌入步只汇报向量化进度）
			const pct = total > 0 ? Math.min(100, Math.round((lastEmbedded / total) * 100)) : 0;
			coffee.setLevel(pct, state === "running" && p.phase === "embedding");
			// 分片在动（fileChunkProgress 在跳动）时保持水柱持续流淌——
			// 不只是换文件时倒一次；分片停下后水柱自行淡出。
			coffee.stream(state === "running" && !!p.fileChunkProgress);
			statnum.setText(`${pct}%`);
			statlabel.setText(total > 0
				? `${lastEmbedded.toLocaleString()} / ${total.toLocaleString()}`
				: `${lastEmbedded.toLocaleString()}`);
			// 底部：当前文档名 + 该文档的分片进展（长文档分多片嵌入）。
			// 名字截断时进度仍完整可见；hover 整行可见全名。
			const base = (p.currentFile || "").split("/").pop() || "";
			if (base) {
				if (base !== lastFile) {
					lastFile = base;
					coffee.pour(base);
				}
				fileNameEl.setText(`📄 ${base}`);
				fileProgEl.setText(p.fileChunkProgress ? `· ${p.fileChunkProgress}` : "");
				fileEl.setAttr("title", p.currentFile || base);
			} else {
				fileNameEl.setText("");
				fileProgEl.setText("");
				fileEl.removeAttribute("title");
			}
			if (state === "done") {
				// 礼花留给主页：点击「完成」回主页后由 showWelcomeConfetti 触发。
				timerow.setText(t("guideIndexDone"));
			} else {
				const eta = fmtDur(p.estimatedRemainingSec);
				timerow.setText(eta ? t("guideEta").replace("{dur}", eta) : "");
			}
			setBtn();
		};

		const unsub = plugin.progress.onProgress((event) => {
			// Canvas 离开 DOM（引导关闭/视图重建）后自我清理
			if (!cupHost.isConnected) {
				unsub();
				return;
			}
			if (event.type === "progress") {
				applyProgress(event.progress);
				const now = Date.now();
				if (now - lastStatsAt >= 1000) {
					lastStatsAt = now;
					void refreshEmbedded();
				}
			}
		});
		void refreshEmbedded();
		applyProgress(plugin.progress.current);
	};

	const rerender = (): void => {
		root.empty();

		renderIntro(root, mode);

		// ONE step per mode: the model screen walks Provider → Key → Model.
		// Chat mode is the first-run setup; embed mode (RAG tab's 开始配置)
		// configures the embedding provider/model off EMBEDDING_CATALOG.
		const isEmbed = mode === "embed";
		const providerPicked = !!(isEmbed ? ob().embedProviderId : ob().providerId);
		const active: 1 | 2 | 3 = !providerPicked ? 1
			: !(isEmbed ? ob().embedReady : ob().chatReady) ? 2 : 3;
		const sticky = root.createDiv({ cls: "semlink-guide-sticky-top" });
		// 嵌入流的步骤语义：① Model ② Key ③ Embed；嵌入步整条打勾
		const stepLabels = isEmbed
			? [t("guideStep3"), t("guideStep2"), t("guideStepEmbedding")] as [string, string, string]
			: undefined;
		const onIndexStep = isEmbed && !!ob().embedModelPicked;
		renderStepper(sticky, onIndexStep ? 3 : active, onIndexStep, undefined, undefined, stepLabels);
		const modelsHost = sticky.createDiv({ cls: "semlink-guide-models" });

		if (isEmbed) {
			// ── 最后一步：咖啡杯随嵌入进度上涨（含 开始/暂停/完成 状态机） ──
			if (onIndexStep) {
				renderEmbedIndexStep(modelsHost);
				return;
			}
			// ── 嵌入模型（RAG 页签「开始配置」入口）── 配完即触发增量索引。
			renderModelStep(root, plugin, {
				kind: "embed",
				providerId: ob().embedProviderId,
				ready: ob().embedReady,
				modelsHost,
				onPickProvider: (p) => {
					plugin.settings.onboarding = { ...(plugin.settings.onboarding ?? {}), embedProviderId: p.id, embedReady: false };
					void plugin.saveSettings();
					rerender();
				},
				onValidated: () => {
					// Model-first：Key 验证通过即落定嵌入模型（供应商 + 第一步
					// 选的 embedModelId），直接进咖啡杯索引步骤。自定义供应商
					// 没有预选模型 → 走旧的模型选择（第三步）。
					const p = byId(ob().embedProviderId);
					const mid = ob().embedModelId;
					if (p && mid) {
						const model = p.models.find((m) => m.id === mid);
						if (model) {
							model.kind = "embedding";
							model.enabled = true;
						} else {
							p.models.push({
								id: mid,
								contextWindow: catalogContextWindow(mid) ?? FALLBACK_CONTEXT,
								kind: "embedding",
								enabled: true,
							});
						}
						// 重新配置且换了模型（新键 ≠ 快照键）→ 向量空间不兼容，
						// 触发全量重新索引；首次配置或模型未变 → 普通增量索引。
						const newKey = `${p.id}::${mid}`;
						const modelChanged = reconfigFromKey !== null && newKey !== reconfigFromKey;
						reconfigFromKey = null;
						plugin.settings.embeddingModelKey = newKey;
						plugin.settings.onboarding = { ...(plugin.settings.onboarding ?? {}), embedReady: true, embedModelPicked: true };
						void plugin.saveSettings();
						if (modelChanged) {
							// reindexAll 在调度器运行中会静默跳过——重新配置时已
							// pause，这里等运行真正收尾后再发起全量重建。
							const kick = (): void => {
								if (plugin.scheduler.isRunning) {
									window.setTimeout(kick, 500);
									return;
								}
								void plugin.reindexAll();
							};
							kick();
						} else {
							// 配置完成即可开始语义搜索：触发一次增量索引
							plugin.startFullIndex();
						}
						rerender();
						return;
					}
					plugin.settings.onboarding = { ...(plugin.settings.onboarding ?? {}), embedReady: true };
					void plugin.saveSettings();
					rerender();
				},
				onModelPicked: (p, models) => {
					// Curate: picked embedding models stay enabled on this
					// provider; the first pick becomes embeddingModelKey.
					const pickedIds = new Set(models.map((m) => m.id));
					for (const m of p.models) {
						if ((m.kind ?? "chat") !== "embedding") continue;
						m.enabled = pickedIds.has(m.id);
					}
					plugin.settings.embeddingModelKey = `${p.id}::${models[0].id}`;
					// 不置 done：进入咖啡杯步骤；进入即自动开始嵌入
					plugin.settings.onboarding = { ...(plugin.settings.onboarding ?? {}), embedModelPicked: true };
					void plugin.saveSettings();
					plugin.startFullIndex();
					rerender();
				},
				onBackToKey: () => {
					plugin.settings.onboarding = { ...(plugin.settings.onboarding ?? {}), embedReady: false };
					void plugin.saveSettings();
					rerender();
				},
				onReselect: () => {
					const p = byId(ob().embedProviderId);
					if (p && !p.apiKey.trim()) {
						plugin.settings.providers = plugin.settings.providers.filter((x) => x.id !== p.id);
					}
					// 返回第一步（选模型）：清掉供应商与预选模型
					plugin.settings.onboarding = { ...(plugin.settings.onboarding ?? {}), embedProviderId: undefined, embedReady: false, embedModelId: undefined };
					void plugin.saveSettings();
					rerender();
				},
				onRestart,
			});
			return;
		}

		// ── 对话模型（默认模式）── picking completes the guide.
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
				// 对话模型就绪即建索引：无嵌入模型时调度器退化为纯分块索引
				//（BM25/关键词检索立即可用）；有嵌入模型时就是完整索引。
				plugin.startFullIndex();
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
	/** 覆盖步骤标签：嵌入流为 Model / Key / Index。 */
	labels?: [string, string, string],
): void {
	const steps = labels ?? [t("guideStep1"), t("guideStep2"), t("guideStep3")];
	const stepsEl = root.createDiv({ cls: "semlink-guide-stepper" });
	for (let i = 1; i <= 3; i++) {
		const target = i as 1 | 2 | 3;
		const isPast = i < active || done;
		const jumpable = !!onJump && i !== active && !!canJump?.(target);
		const step = stepsEl.createDiv({
			cls: `semlink-guide-step${isPast ? " is-done" : i === active ? " is-active" : ""}${jumpable ? " is-clickable" : ""}`,
		});
		step.createDiv({ cls: "semlink-guide-step-dot", text: isPast ? "✓" : String(i) });
		step.createDiv({ cls: "semlink-guide-step-label", text: steps[i - 1] });
		if (jumpable) {
			step.addEventListener("click", () => onJump?.(target));
		}
	}
}

// ──── Shared fragments ────

/** Step hero above the stepper — same visual language as the plain welcome:
 *  floating emoji badge, bold greeting, muted sub line (reuses the
 *  semlink-search-welcome-* classes). */
function renderIntro(root: HTMLElement, mode: "chat" | "embed" = "chat"): void {
	const intro = root.createDiv({ cls: "semlink-guide-intro" });
	// 嵌入流（RAG 开始配置）有自己的提示语：讲的是选嵌入模型，不是开始问答
	const title = t(mode === "embed" ? "guideEmbedIntroTitle" : "guideIntroTitle");
	const m = title.match(/^(\p{Extended_Pictographic})\s*(.*)$/u);
	const emoji = m ? m[1] : "";
	const greeting = m ? m[2] : title;
	if (emoji) {
		intro.createDiv({ cls: "semlink-search-welcome-emoji", text: emoji });
	}
	intro.createDiv({ cls: "semlink-search-welcome-greeting", text: greeting });
	intro.createDiv({
		cls: "semlink-search-welcome-sub",
		text: t(mode === "embed" ? "guideEmbedIntroSub" : "guideIntroSub"),
	});
}

/** Create (or reuse) a provider from its catalog entry — keyed by name to
 *  avoid duplicates from repeated guide runs. Returns undefined when the
 *  name is not in the catalog. The embed flow draws from the dedicated
 *  EMBEDDING_CATALOG (chat-only providers never appear there). */
function ensureCatalogProvider(plugin: SmartVaultPlugin, name: string, kind: "chat" | "embed"): ModelProvider | undefined {
	const existing = plugin.settings.providers.find((p) => p.name === name);
	if (existing) return existing;
	const entry = (kind === "embed" ? EMBEDDING_CATALOG : CHAT_CATALOG)
		.find((e) => e.name === name);
	if (!entry) return undefined;
	const provider: ModelProvider = {
		id: `provider-${Date.now()}`,
		name: entry.name,
		apiBase: entry.baseUrl,
		apiKey: "",
		apiFormat: entry.apiFormat,
		...(entry.wirePath ? { wirePath: entry.wirePath } : {}),
		...(entry.embedPath ? { embedPath: entry.embedPath } : {}),
		models: entry.models.map((m) => ({ ...m })),
	};
	plugin.settings.providers.push(provider);
	return provider;
}

/** 内置目录里已知模型的上下文长度：端点的 /models 一般不报 context，
 *  目录里登记过的模型（如 deepseek-v4-flash → 1M）用它兜底，未知的再退
 *  回通用默认值。 */
function catalogContextWindow(modelId: string): number | undefined {
	for (const entry of [...CHAT_CATALOG, ...EMBEDDING_CATALOG]) {
		for (const m of entry.models) {
			if (m.id === modelId) return m.contextWindow;
		}
	}
	return undefined;
}

/** 嵌入流第三级弹窗：同一供应商下同名模型的变体确认（如硅基流动的
 *  BAAI/bge-m3 与 Pro/BAAI/bge-m3），点选确认最终写入的模型 id。 */
class EmbedVariantPickModal extends Modal {
	constructor(
		private plugin: SmartVaultPlugin,
		private providerName: string,
		private variants: Array<{ id: string; ctx: number; price: number | undefined }>,
		private onPick: (modelId: string) => void,
	) {
		super(plugin.app);
		this.modalEl.addClass("semlink-guide-series-modal");
	}

	onOpen(): void {
		this.titleEl.setText(this.providerName);
		const grid = this.contentEl.createDiv({ cls: "semlink-guide-provider-grid semlink-guide-provider-grid-vertical" });
		const logo = brandLogoOf(this.providerName).svg;
		for (const v of this.variants) {
			const card = grid.createDiv({ cls: "semlink-guide-provider-card" });
			if (logo) {
				const logoEl = card.createDiv({ cls: "semlink-guide-provider-logo" });
				setSvgIcon(logoEl, logo);
			} else {
				card.createDiv({
					cls: "semlink-guide-provider-fallback",
					text: v.id.charAt(0).toUpperCase(),
				});
			}
			card.createDiv({ cls: "semlink-guide-provider-name", text: v.id });
			if (v.ctx > 0) {
				const ctxText = v.ctx % 1024 === 0 ? `${v.ctx / 1024}K` : `${v.ctx}`;
				card.createSpan({ cls: "semlink-guide-model-ctx semlink-guide-model-meta", text: ctxText });
			}
			card.addEventListener("click", () => {
				this.close();
				this.onPick(v.id);
			});
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** 嵌入流第二级弹窗：品牌 → 模型列表。点模型行原地展开（同设置页
 *  Model 页签的折叠交互），下方内联列出可用的供应商行，点供应商即生效。 */
class EmbedModelPickModal extends Modal {
	private expandedId: string | null = null;
	private host: HTMLElement | null = null;

	constructor(
		private plugin: SmartVaultPlugin,
		private brand: string,
		private models: Array<{ displayId: string; providers: Array<{ provider: string; id: string; ctx: number; price: number | undefined }> }>,
		private onPick: (modelId: string, providerName: string) => void,
	) {
		super(plugin.app);
		this.modalEl.addClass("semlink-guide-series-modal");
		// 品牌只有一个模型：直接展开它的供应商列表，省一次点击
		if (models.length === 1) this.expandedId = models[0].displayId;
	}

	onOpen(): void {
		this.titleEl.setText(MODEL_BRAND_LABELS[this.brand] ?? this.brand);
		this.host = this.contentEl.createDiv({ cls: "semlink-guide-provider-grid semlink-guide-provider-grid-vertical" });
		this.render();
	}

	private render(): void {
		const host = this.host!;
		const scroll = host.scrollTop;
		host.empty();
		const brandLogo = brandLogoOf(this.brand).svg;
		for (const model of this.models) {
			const expanded = this.expandedId === model.displayId;
			const card = host.createDiv({ cls: "semlink-guide-provider-card" });
			if (brandLogo) {
				const logoEl = card.createDiv({ cls: "semlink-guide-provider-logo" });
				setSvgIcon(logoEl, brandLogo);
			} else {
				card.createDiv({
					cls: "semlink-guide-provider-fallback",
					text: model.displayId.charAt(0).toUpperCase(),
				});
			}
			card.createDiv({ cls: "semlink-guide-provider-name", text: model.displayId });
			const ctx0 = model.providers[0]?.ctx ?? 0;
			if (ctx0 > 0) {
				// 上下文按 1024 基显示：8192 → 8K（而非 8.2K）
				const ctxText = ctx0 % 1024 === 0 ? `${ctx0 / 1024}K` : formatContextWindow(ctx0);
				card.createSpan({ cls: "semlink-guide-model-ctx semlink-guide-model-meta", text: ctxText });
			}
			const chev = card.createDiv({ cls: "semlink-guide-model-chevron" });
			setIcon(chev, expanded ? "chevron-down" : "chevron-right");
			card.addEventListener("click", () => {
				this.expandedId = expanded ? null : model.displayId;
				this.render();
			});
			// 展开区：内联供应商行（logo + 名称）。同供应商存在同名变体
			// （如硅基流动的 BAAI/bge-m3 与 Pro/BAAI/bge-m3）时，点行弹
			// 确认框选定最终模型；单一模型直接生效。
			if (expanded) {
				const byProvider = new Map<string, Array<{ id: string; ctx: number; price: number | undefined }>>();
				for (const p of model.providers) {
					const variants = byProvider.get(p.provider) ?? [];
					variants.push({ id: p.id, ctx: p.ctx, price: p.price });
					byProvider.set(p.provider, variants);
				}
				for (const [providerName, variants] of byProvider) {
					const prow = host.createDiv({
						cls: "semlink-guide-provider-card semlink-guide-model-provider",
					});
					const plogo = brandLogoOf(providerName).svg;
					if (plogo) {
						const logoEl = prow.createDiv({ cls: "semlink-guide-provider-logo" });
						setSvgIcon(logoEl, plogo);
					} else {
						prow.createDiv({
							cls: "semlink-guide-provider-fallback",
							text: providerName.charAt(0).toUpperCase(),
						});
					}
					prow.createDiv({ cls: "semlink-guide-provider-name", text: providerName });
					// 右侧：完整嵌入端点（Base URL + embedPath，缺省 /v1/embeddings）
					const entry = EMBEDDING_CATALOG.find((e) => e.name === providerName);
					if (entry) {
						const endpoint = `${entry.baseUrl}${entry.embedPath ?? "/v1/embeddings"}`;
						prow.createSpan({
							cls: "semlink-guide-model-ctx semlink-guide-model-meta",
							text: endpoint,
							attr: { title: endpoint },
						});
					}
					prow.addEventListener("click", () => {
						if (variants.length === 1) {
							this.close();
							this.onPick(variants[0].id, providerName);
							return;
						}
						new EmbedVariantPickModal(this.plugin, providerName, variants, (modelId) => {
							this.close();
							this.onPick(modelId, providerName);
						}).open();
					});
				}
			}
		}
		host.scrollTop = scroll;
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** 系列合并卡的二次确认窗口：标题为系列名，列出该系列的成员供应商
 *  （同网格卡片样式、带配置绿点），点选其中一个才真正创建/进入。 */
class SeriesPickModal extends Modal {
	constructor(
		private plugin: SmartVaultPlugin,
		private seriesName: string,
		private members: string[],
		private onPick: (name: string) => void,
		/** 成员条目来源：对话目录（系列选择）或嵌入目录（Model-first 的
		 *  供应商选择），决定卡片右侧展示的端点。 */
		private catalog: CatalogEntry[] = CHAT_CATALOG,
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
			const entry = this.catalog.find((e) => e.name === member);
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
			// 嵌入流（Model-first）：第一步按模型聚合展示——点击模型弹出
			// 提供该模型的供应商弹窗，选定后进入 Key 步骤；Key 验证通过
			// 直接落定嵌入模型、进咖啡杯索引步骤。
			if (opts.kind === "embed") {
				// 品牌网格：只显示品牌 logo + 名称；点品牌 → 选模型弹窗
				// → 选供应商弹窗 → Key 步骤。
				const grid = body.createDiv({ cls: "semlink-guide-provider-grid" });
				// 按模型聚合（取 id 最后一段、大小写不敏感）：`Pro/`、
				// `openai/` 这类档位/路由前缀不算不同模型——bge-m3 与
				// Pro/BAAI/bge-m3 是同一个模型，OpenRouter 的
				// openai/text-embedding-3-small 与 OpenAI 的同名款也是。
				// 每个供应商各自记住真实路由 id——选定后写入 embeddingModelKey。
				const byModel = new Map<string, Array<{ provider: string; id: string; ctx: number; price: number | undefined }>>();
				for (const entry of EMBEDDING_CATALOG) {
					for (const m of entry.models) {
						const key = (m.id.split("/").pop() ?? m.id).toLowerCase();
						const providers = byModel.get(key) ?? [];
						// 同一供应商的同名变体（如 Pro/BAAI/bge-m3）也保留，
						// 供应商行点击后弹确认框选定最终模型
						providers.push({ provider: entry.name, id: m.id, ctx: m.contextWindow, price: m.priceIn });
						byModel.set(key, providers);
					}
				}
				const pick = (modelId: string, name: string): void => {
					const p = ensureCatalogProvider(plugin, name, "embed");
					if (!p) return;
					plugin.settings.onboarding = { ...(plugin.settings.onboarding ?? {}), embedModelId: modelId, embedProviderId: p.id, embedReady: false };
					void plugin.saveSettings();
					opts.onPickProvider(p);
				};
				const ordered = [...byModel.values()]
					.sort((a, b) => a[0].id.localeCompare(b[0].id, undefined, { sensitivity: "base", numeric: true }));
				// 按品牌聚合：列表只显示品牌 logo + 名称；点品牌 → 选模型弹窗
				// → 选供应商弹窗 → Key 步骤。
				const byBrand = new Map<string, Array<{ providers: Array<{ provider: string; id: string; ctx: number; price: number | undefined }>; displayId: string }>>();
				for (const providers of ordered) {
					const displayId = providers[0].id.split("/").pop() ?? providers[0].id;
					const brand = modelBrandOf(providers[0].id) ?? displayId.toLowerCase();
					const models = byBrand.get(brand) ?? [];
					models.push({ providers, displayId });
					byBrand.set(brand, models);
				}
				const brandRank = (key: string): number => {
					const at = MODEL_BRAND_ORDER.indexOf(key);
					return at < 0 ? MODEL_BRAND_ORDER.length : at;
				};
				for (const brand of [...byBrand.keys()].sort((a, b) =>
					brandRank(a) - brandRank(b) || a.localeCompare(b))) {
					const models = byBrand.get(brand)!;
					const card = grid.createDiv({ cls: "semlink-guide-provider-card" });
					const brandLogo = brandLogoOf(brand).svg;
					if (brandLogo) {
						const logoEl = card.createDiv({ cls: "semlink-guide-provider-logo" });
						setSvgIcon(logoEl, brandLogo);
					} else {
						card.createDiv({
							cls: "semlink-guide-provider-fallback",
							text: brand.charAt(0).toUpperCase(),
						});
					}
					card.createDiv({
						cls: "semlink-guide-provider-name",
						text: MODEL_BRAND_LABELS[brand] ?? brand,
					});
					card.addEventListener("click", () => {
						new EmbedModelPickModal(plugin, brand, models, (modelId, providerName) => {
							pick(modelId, providerName);
						}).open();
					});
				}
				// 自定义供应商：没有预选模型，Key 验证后进模型选择（旧第三步）
				const customCard = grid.createDiv({
					cls: "semlink-guide-provider-card semlink-guide-provider-card-custom",
				});
				customCard.createDiv({ cls: "semlink-guide-provider-fallback", text: "＋" });
				customCard.createDiv({ cls: "semlink-guide-provider-name", text: t("customProvider") });
				customCard.addEventListener("click", () => {
					new AddProviderModal(plugin.app, plugin, "custom", (p) => {
						// 表单里填了模型名称 → 直接作为选定的嵌入模型，
						// Key 验证后跳过模型选择直进索引步骤
						const m = p.models.find((x) => (x.kind ?? "chat") === "embedding");
						if (m) {
							plugin.settings.onboarding = { ...(plugin.settings.onboarding ?? {}), embedModelId: m.id };
							void plugin.saveSettings();
						}
						opts.onPickProvider(p);
					}, "embed").open();
				});

				// 联系入口（同对话流第一步）：品牌/模型目录缺的可以联系我们补充
				const contact = body.createDiv({ cls: "semlink-guide-contact" });
				contact.createSpan({ text: `${t("guideContactHint")} ` });
				contact.createEl("a", {
					cls: "semlink-guide-contact-link",
					text: t("guideContactLink"),
					attr: { href: "mailto:support@getsemlink.com" },
				});
				return;
			}
			const grid = body.createDiv({ cls: "semlink-guide-provider-grid" });
			// 对话流：对话目录（系列合并、已配置置顶）。
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
						const p = ensureCatalogProvider(plugin, name, opts.kind);
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
			// 获取 Key 地址：按流取各自目录的 keysUrl（嵌入流 = EMBEDDING_CATALOG），
			// 目录没有的（Xiaomi / Z.AI Coding 系）退回 PROVIDER_CONSOLE
			const consoleUrl = (opts.kind === "embed" ? EMBEDDING_CATALOG : CHAT_CATALOG)
				.find((e) => e.name === provider.name)?.keysUrl
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

			// API Format 只服务对话请求（嵌入客户端固定 OpenAI 形状，
			// anthropic/bare 对嵌入毫无意义），只在对话流出现。
			let formatSelect: HTMLSelectElement | undefined;
			if (opts.kind === "chat") {
				fieldLabel(advBody, t("chatApiFormat"));
				// "bare" = POST to the base URL verbatim (stored as wirePath "/",
				// which chatEndpoint understands); payload format is untouched.
				formatSelect = advBody.createEl("select", { cls: "semlink-guide-keyinput semlink-guide-select" });
				for (const [value, label] of [
					["anthropic", t("chatFormatAnthropic")],
					["openai", t("chatFormatOpenAI")],
					["bare", t("chatFormatBare")],
				] as const) {
					formatSelect.createEl("option", { value, text: label });
				}
				formatSelect.value = provider.wirePath === "/" ? "bare" : provider.apiFormat;
				formatSelect.addEventListener("change", () => {
					baseInput.value = provider.apiBase + pathSuffix();
				});
			} else {
				// 嵌入流：模型名称可改（预填第一步选中的模型 id）
				fieldLabel(advBody, t("embeddingModel"));
				const modelInput = advBody.createEl("input", {
					cls: "semlink-guide-keyinput",
					type: "text",
					value: plugin.settings.onboarding?.embedModelId ?? "",
				});
				modelInput.addEventListener("input", () => {
					plugin.settings.onboarding = { ...(plugin.settings.onboarding ?? {}), embedModelId: modelInput.value.trim() };
					void plugin.saveSettings();
				});
			}

			// 完整端点的路径尾巴：嵌入流 = 嵌入端点（embedPath，缺省
			// /v1/embeddings）；对话流 = 所选协议的对话端点；bare = 无尾巴。
			const pathSuffix = (): string => {
				if (provider.wirePath === "/") return "";
				if (provider.wirePath) return provider.wirePath;
				if (opts.kind === "embed") return provider.embedPath ?? "/v1/embeddings";
				const fmt = formatSelect?.value ?? "openai";
				return fmt === "anthropic" ? "/v1/messages" : fmt === "bare" ? "" : "/v1/chat/completions";
			};
			// Endpoint 字段显示完整请求地址（apiBase + 路径尾巴）
			baseInput.value = provider.apiBase + pathSuffix();

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
			formatSelect?.addEventListener("change", clearError);
			keyInput.addEventListener("input", clearError);

			// 下一步 = validate the key with a single cheap models-list
			// request; the (slow) per-model classification streams in inside
			// the picker. Form values are persisted only after the key
			// checks out.
			const validate = async (): Promise<void> => {
				const raw = baseInput.value.trim();
				const key = keyInput.value.trim();
				if (!raw) {
					error.setText(t("customNeedsBaseUrl"));
					baseInput.addClass("is-invalid");
					return;
				}
				// 输入口径是完整端点：剥掉路径尾巴回存 apiBase（存储口径不变）
				const suffix = pathSuffix();
				let apiBase = raw;
				if (suffix && raw.toLowerCase().endsWith(suffix.toLowerCase())) {
					apiBase = raw.slice(0, raw.length - suffix.length);
				}
				apiBase = apiBase.replace(/\/+$/, "");
				if (!apiBase) {
					error.setText(t("customNeedsBaseUrl"));
					baseInput.addClass("is-invalid");
					return;
				}
				// 本地运行时（Ollama 等 keyOptional 目录项）不需要 Key
				const keyOptional = [...CHAT_CATALOG, ...EMBEDDING_CATALOG]
					.some((e) => e.name === provider.name && e.keyOptional === true);
				if (!key && !keyOptional) {
					error.setText(t("guideKeyRequired"));
					keyInput.addClass("is-invalid");
					return;
				}
				nextBtn.disabled = true;
				nextBtn.setText(t("editorTesting"));
				provider.name = nameInput.value.trim() || provider.name;
				provider.apiBase = apiBase;
				if (opts.kind === "chat") {
					if (formatSelect?.value === "bare") {
						// Bare: the address IS the endpoint — payload format stays
						// whatever this provider already uses.
						provider.wirePath = "/";
					} else {
						provider.apiFormat = (formatSelect?.value ?? "openai") as ChatApiFormat;
						if (provider.wirePath === "/") provider.wirePath = undefined;
					}
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
		// 嵌入流：实例可能是先配过对话的同名供应商（如 OpenAI），清单里
		// 只有对话模型——先并入嵌入目录的内置模型，保证永远有得选
		//（不再出现 "This provider serves no embedding models"）。
		if (!isChat) {
			mergeEmbeddingCatalogModels(provider);
			void plugin.saveSettings();
		}
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
				const grip = row.createDiv({ cls: "semlink-guide-model-grip" });
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
				const embedLike = /embed|bge|gte|e5|nomic|voyage|jina/i;
				this.models = fetched.filter((m) =>
					this.kindWanted === "embedding"
						? (m.kind ?? (embedLike.test(m.id) ? "embedding" : "chat")) === "embedding"
						: (m.kind ?? "chat") === "chat",
				);
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
