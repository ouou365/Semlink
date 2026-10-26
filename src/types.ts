// ========================================
// Semlink - Core Type Definitions
// ========================================

/** Embedding provider family (determines the embedding endpoint shape:
 *  SiliconFlow-style OpenAI-compatible `/v1/embeddings`, or Hugging Face's
 *  inference endpoint). Defaults to OpenAI-compatible when absent. */
export type EmbeddingProvider = "siliconflow" | "huggingface";

/** One provider — embedding and chat are NOT distinct provider kinds. Every
 *  provider is a model provider: a single endpoint whose kind-tagged model
 *  list holds embedding / chat / rerank / … models alike. */
export interface ModelProvider {
	/** Stable id (e.g. "siliconflow-cn", "deepseek"). */
	id: string;
	/** Display name. */
	name: string;
	/** Embedding family (drives the embedding request shape). */
	family?: EmbeddingProvider;
	/** API base URL. */
	apiBase: string;
	/** API key. */
	apiKey: string;
	/** 自定义图标键（PROVIDER_LOGOS 的键）；未设置时按名称取内置图标。 */
	icon?: string;
	/** Wire format for chat requests / model-list fetch. */
	apiFormat: ChatApiFormat;
	/** Explicit chat path appended to apiBase, for endpoints whose real path
	 *  deviates from the default wire convention (openai → "/v1/chat/
	 *  completions", anthropic → "/v1/messages"), e.g. GLM coding plans
	 *  ("/chat/completions") or Gemini's OpenAI-compat base. Absent = default. */
	wirePath?: string;
	/** Explicit embeddings path appended to apiBase, for providers whose
	 *  embeddings endpoint deviates from "/v1/embeddings" — e.g. Google's
	 *  OpenAI-compat layer ("/embeddings" on the .../v1beta/openai base).
	 *  Absent = the default "/v1/embeddings". */
	embedPath?: string;
	/** Kind-tagged model list (embedding / chat / …). */
	models: ChatModel[];
	/** Model-tab folder this provider is filed under (user-created folders;
	 *  built-in series folders are name-derived and need no field). */
	folder?: string;
	/** Set once the model list was edited in settings (editor confirmed /
	 *  create card submitted). The onboarding guide then no longer auto-
	 *  fetches the endpoint's full model list for this provider — refetching
	 *  would silently resurrect models the user deliberately removed. */
	curated?: boolean;
	/** Custom provider created with "no authentication" (e.g. a local
	 *  endpoint): it legitimately has no API key, so the model tab must not
	 *  nag it with the "configure the API" hint. */
	noAuth?: boolean;
}

/** Default providers. Order matters: the first entry is the fallback when no
 *  active embedding selection resolves. */
export const DEFAULT_PROVIDERS: ModelProvider[] = [
	{
		id: "siliconflow-cn",
		name: "SiliconFlow",
		family: "siliconflow",
		apiBase: "https://api.siliconflow.cn",
		apiKey: "",
		apiFormat: "openai",
		models: [
			{ id: "BAAI/bge-m3", contextWindow: 8192, kind: "embedding" },
			{ id: "deepseek-ai/DeepSeek-V3.2", contextWindow: 163840, kind: "chat" },
		],
	},
	{
		id: "huggingface",
		name: "Hugging Face",
		family: "huggingface",
		// Router domain: the legacy api-inference.huggingface.co host was
		// sunset; the OpenAI-compatible embeddings endpoint lives at
		// router.huggingface.co/v1/embeddings.
		apiBase: "https://router.huggingface.co",
		apiKey: "",
		apiFormat: "openai",
		models: [
			{ id: "BAAI/bge-m3", contextWindow: 8192, kind: "embedding" },
		],
	},
	{
		id: "deepseek",
		name: "DeepSeek",
		apiBase: "https://api.deepseek.com",
		apiKey: "",
		apiFormat: "openai",
		models: [
			{ id: "deepseek-v4-flash", contextWindow: 1000000, kind: "chat" },
			{ id: "deepseek-v4-pro", contextWindow: 1000000, kind: "chat" },
		],
	},
];

/** Resolve the active embedding configuration: the provider + model named by
 *  `embeddingModelKey` (`${providerId}::${modelId}`), with the first provider
 *  / first embedding model as fallback. */
export function activeEmbeddingProvider(s: SmartVaultSettings): ModelProvider & { model: string } {
	const key = s.embeddingModelKey || "";
	const sep = key.indexOf("::");
	const pid = sep > 0 ? key.slice(0, sep) : key;
	const mid = sep > 0 ? key.slice(sep + 2) : "";
	const p = s.providers.find((x) => x.id === pid) ?? s.providers[0] ?? DEFAULT_PROVIDERS[0];
	// A selected model that was disabled falls back to the first enabled
	// embedding model (then any enabled model) of the provider.
	let model = mid;
	if (model) {
		const target = p?.models.find((m) => m.id === mid);
		if (!target || target.enabled !== true) model = "";
	}
	if (!model) {
		model = p?.models.find((m) => m.enabled === true && (m.kind ?? "chat") === "embedding")?.id
			?? p?.models.find((m) => m.enabled === true)?.id
			?? "";
	}
	return { ...p, model };
}

/** Migrate legacy settings (flat embedding fields + the old
 *  embeddingProviders/chatProviders split) into the unified `providers` list.
 *  Runs once on load; no-op when `providers` already exists. */
export function migrateEmbeddingSettings(s: SmartVaultSettings): void {
	if (Array.isArray(s.providers) && s.providers.length > 0) return;
	const legacy = s as unknown as Record<string, unknown>;
	const oldEmbedding = legacy.embeddingProviders as Array<{
		id: string;
		name: string;
		kind: EmbeddingProvider;
		apiBase: string;
		apiKey: string;
		apiFormat?: ChatApiFormat;
		model: string;
		models?: ChatModel[];
	}> | undefined;
	const oldChat = legacy.chatProviders as ChatProvider[] | undefined;
	const out: ModelProvider[] = [];

	for (const p of oldEmbedding ?? []) {
		out.push({
			id: p.id,
			name: p.name,
			family: p.kind,
			apiBase: p.apiBase,
			apiKey: p.apiKey,
			apiFormat: p.apiFormat ?? "openai",
			models: p.models && p.models.length > 0
				? p.models.map((m) => ({ ...m }))
				: [{ id: p.model || "BAAI/bge-m3", contextWindow: 8192, kind: "embedding" }],
		});
	}
	for (const p of oldChat ?? []) {
		out.push({
			id: p.id,
			name: p.name,
			apiBase: p.baseUrl,
			apiKey: p.apiKey,
			apiFormat: p.apiFormat,
			models: p.models.map((m) => ({ ...m, kind: (m as { kind?: ChatModelKind }).kind ?? "chat" })),
		});
	}
	s.providers = out.length > 0 ? out : DEFAULT_PROVIDERS.map((p) => ({ ...p, models: p.models.map((m) => ({ ...m })) }));

	// Embedding model selection: reuse the old embeddingProviderId key when it
	// exists, else derive from the legacy flat provider/apiBase fields.
	const oldKey = (legacy.embeddingProviderId as string | undefined) || "";
	const legacyPid = oldKey.split("::")[0]
		|| (legacy.provider === "huggingface" ? "huggingface"
			: (legacy.apiBase as string || "").includes(".com") ? "siliconflow-global" : "siliconflow-cn");
	const legacyMid = oldKey.includes("::") ? oldKey.split("::")[1] : "";
	const legacyEmb = (oldEmbedding ?? []).find((p) => p.id === legacyPid);
	const mid = legacyMid
		|| legacyEmb?.model
		|| (legacy.embeddingModel as string | undefined)
		|| "";
	s.embeddingModelKey = mid ? `${legacyPid}::${mid}` : "";
}

/** Chat completion API wire format */
export type ChatApiFormat = "openai" | "anthropic";

/** Model category tag shown on model rows (chat = the default for the chat
 *  provider list; the rest mark models fetched from a mixed catalog like
 *  SiliconFlow's, which also serves speech/image/video/translation models). */
export type ChatModelKind = "embedding" | "chat" | "rerank" | "tts" | "asr" | "image" | "video" | "translate";

/** A single model definition (embedding / chat / … share one shape). */
export interface ChatModel {
	id: string;
	contextWindow: number;
	/** Optional pricing for the Pro usage dashboard: USD per 1M tokens.
	 *  Missing/null → the dashboard shows tokens without a cost figure. */
	priceIn?: number;
	priceOut?: number;
	/** Model category tag (defaults to "chat"). */
	kind?: ChatModelKind;
	/** Whether the model is usable. Disabled models are hidden from the
	 *  pickers and the runtime (defaults to enabled). */
	enabled?: boolean;
}

/** A chat model provider configuration */
export interface ChatProvider {
	id: string;
	name: string;
	baseUrl: string;
	apiKey: string;
	apiFormat: ChatApiFormat;
	/** Explicit chat path suffix overriding the default wire convention
	 *  (bridged from ModelProvider.wirePath). */
	wirePath?: string;
	models: ChatModel[];
}

/** A Feishu bot bound to Semlink (created via QR scan or manual entry). */
export interface FeishuBotConfig {
	id: string;
	name: string;
	appId: string;
	appSecret: string;
	/** open_id of the Feishu user who bound this bot (QR scan). */
	userOpenId?: string;
	/** One-time code the user sends to the bot as `/bind <code>` to confirm. */
	bindCode?: string;
	/** Whether the binding has been confirmed via `/bind` in Feishu. */
	bound?: boolean;
	enabled: boolean;
	/** Runtime connection state (not persisted meaningfully). */
	connected: boolean;
	lastError?: string;
}

/** Plugin settings persisted via Obsidian loadData/saveData */
import type { LangSetting } from "./i18n";

export interface SmartVaultSettings {
	language: LangSetting;
	/** Unified model-provider list — embedding and chat are not distinct
	 *  provider kinds; each provider's models carry a kind tag. */
	providers: ModelProvider[];
	/** Active embedding model, keyed `${providerId}::${modelId}`. */
	embeddingModelKey: string;
	/** Persisted active chat model, keyed `${providerId}/${modelId}` ("" = auto
	 *  → first chat model of the first usable provider). */
	activeChatModel: string;
	/** Persisted model-kind cache (endpoint baseUrl → modelId → kind), so the
	 *  probe-based classification survives Obsidian restarts. */
	modelKindCache?: Record<string, Record<string, string>>;
	mcpPort: number;
	/** LAN share page port; persisted so share URLs survive
	 *  restarts (bumped automatically when the port is taken). */
	sharePort: number;
	mcpApiKey: string;
	/** MCP 服务总开关：默认开启；用户手动关闭后重启保持关闭。 */
	mcpEnabled?: boolean;
	/** 调试问答服务（semlink-debug，ask 单工具）：供 ZCode 等 agent 端到端
	 *  测试问答管线；仅监听 127.0.0.1，能触发真实 LLM API 调用。 */
	debugMcpEnabled?: boolean;
	debugMcpPort?: number;
	/** 用户在 MCP 标签接入的外部 MCP 服务器（可增删改；内置 semlink 不在此列）。 */
	mcpClientServers?: McpClientServer[];
	/** 嵌入模型指纹（providerId::modelId）：变化时清向量并全量重嵌。 */
	embeddingModelFingerprint?: string;
	chunkSize: number;
	chunkOverlap: number;
	excludePaths: string;
	autoIndex: boolean;
	/** 自动嵌入开关（RAG 页嵌入面板标题右侧）：关闭后索引只做分块、不再调
	 *  嵌入 API；调度器实时读取，转换立即对后续笔记生效。 */
	autoEmbed?: boolean;
	maxRetries: number;
	batchSize: number;
	requestDelayMs: number;
	/** Notes embedded in parallel (1 = serial). */
	embedConcurrency: number;
	/** Verbose console diagnostics (Settings → General, or the toggle command). */
	debugLogging?: boolean;
	/** Feishu bots bound to Semlink */
	feishuBots: FeishuBotConfig[];
	/** First-run guide state. Steps: ① chat model ② embedding model ③ data
	 *  index. `providerId`/`embedProviderId` record the chosen hosts,
	 *  `chatReady`/`embedReady` mark "key validated + models fetched",
	 *  `chatModelPicked`/`embedModelPicked` mark the model selection done
	 *  (they drive the current step), `done` suppresses the guide. */
	/** Model-tab user folders（内置系列分组之外的用户自建文件夹）。 */
	providerFolders?: string[];
	/** Model-tab manual provider order（拖动滑块后的展示顺序，按名称登记；
	 *  未登记的供应商按市场排名殿后）。 */
	providerOrder?: string[];
	onboarding?: {
		done?: boolean;
		providerId?: string;
		embedProviderId?: string;
		/** Model-first 嵌入流：第一步选中的嵌入模型 id——Key 验证通过后
		 *  直接落定 embeddingModelKey 并进入索引步骤（自定义供应商无此值）。 */
		embedModelId?: string;
		chatReady?: boolean;
		embedReady?: boolean;
		chatModelPicked?: boolean;
		embedModelPicked?: boolean;
		/** 设置页"重新嵌入"直接跳到数据索引环节 */
		jumpToIndex?: boolean;
	};
	/** Pro license state (docs/freemium-design.md). The token is an
	 *  Ed25519-signed activation receipt from the license backend; cleared
	 *  entirely on deactivation/revocation. */
	license?: LicenseState;
}

/** Client-side license state persisted in data.json. */
export interface LicenseState {
	/** The Creem license key (plaintext — data.json is local and private). */
	key?: string;
	/** Creem activation instance id bound to this device. */
	instanceId?: string;
	/** Ed25519-signed activation token (see src/license.ts). */
	token?: string;
	/** Token expiry (ms epoch), mirrors the token payload. */
	tokenExp?: number;
	/** Activations used / allowed on this key (from the last validation). */
	activation?: number;
	activationLimit?: number | null;
	lastValidatedAt?: number;
	/** Local override of the free-tier history limit (reserved; defaults to
	 *  the value from license-config.ts). */
	freeLimit?: number;
}

/** 用户在 MCP 标签接入的外部 MCP 服务器（可增删改；内置 semlink 不在此列）。
 *  http/sse 走 URL，stdio 走命令行；enabled 只是本地启用位。 */
export interface McpClientServer {
	id: string;
	name: string;
	type: "http" | "sse" | "stdio";
	url?: string;
	command?: string;
	/** stdio 专用：命令行参数（按空格切分，运行时接입 시使用）。 */
	args?: string;
	/** http/sse 专用：随请求发送的头（如 Authorization）。 */
	headers?: Record<string, string>;
	/** 请求/会话超时（毫秒），缺省 30000。 */
	timeoutMs?: number;
	/** MCP 协议版本（缺省自动协商）。 */
	protocolVersion?: string;
	enabled: boolean;
}

export const DEFAULT_SETTINGS: SmartVaultSettings = {
	language: "auto",
	providers: DEFAULT_PROVIDERS.map((p) => ({ ...p, models: p.models.map((m) => ({ ...m })) })),
	embeddingModelKey: "siliconflow-cn::BAAI/bge-m3",
	activeChatModel: "",
	mcpPort: 3001,
	sharePort: 43900,
	mcpApiKey: "",
	mcpEnabled: true,
	debugMcpEnabled: false,
	debugMcpPort: 3002,
	mcpClientServers: [],
	chunkSize: 800,
	chunkOverlap: 100,
	excludePaths: "templates/\n.git/\nnode_modules/",
	autoIndex: true,
	autoEmbed: true,
	maxRetries: 3,
	batchSize: 64,
	requestDelayMs: 200,
	embedConcurrency: 2,
	/** Verbose console diagnostics (Settings → General, or the toggle command). */
	debugLogging: false,
	feishuBots: [],
	onboarding: {},
};

/** Chunk status in the lifecycle */
export type ChunkStatus = "active" | "stale" | "pending_embed" | "embedding" | "failed";

/** A single text chunk from a note */
export interface NoteChunk {
	id: string;
	notePath: string;
	heading: string;
	content: string;
	contentPreview: string;
	mtime: number;
	status: ChunkStatus;
	embedding: number[] | null;
	createdAt: number;
}

/** Index queue item */
export type QueueAction = "add" | "update" | "delete";
export type QueueItemStatus = "pending" | "processing" | "completed" | "failed";

export interface QueueItem {
	id?: number;
	notePath: string;
	action: QueueAction;
	priority: number;
	status: QueueItemStatus;
	retries: number;
	error: string | null;
	createdAt: number;
}

/** Indexing phases */
export type IndexPhase =
	| "idle"
	| "scanning"
	| "chunking"
	| "embedding"
	| "building_index"
	| "completed";

/** Network health status */
export type NetworkStatus = "healthy" | "degraded" | "paused";

/** Full progress snapshot */
export interface IndexProgress {
	phase: IndexPhase;
	totalNotes: number;
	processedNotes: number;
	totalChunks: number;
	embeddedChunks: number;
	failedChunks: number;
	skippedChunks: number;
	currentFile: string;
	networkStatus: NetworkStatus;
	avgResponseMs: number;
	consecutiveFailures: number;
	backoffRemainingSec: number;
	startedAt: number;
	estimatedRemainingSec: number;
	isPaused: boolean;
	isAutoPaused: boolean;
	hnswNodeCount: number;
	dbSizeMb: number;
	lastError: string;
	fileChunkProgress: string;
	/** Concurrently indexing notes, each with its own chunk progress. */
	activeFiles: Array<{ path: string; progress: string }>;
}

export const EMPTY_PROGRESS: IndexProgress = {
	phase: "idle",
	totalNotes: 0,
	processedNotes: 0,
	totalChunks: 0,
	embeddedChunks: 0,
	failedChunks: 0,
	skippedChunks: 0,
	currentFile: "",
	networkStatus: "healthy",
	avgResponseMs: 0,
	consecutiveFailures: 0,
	backoffRemainingSec: 0,
	startedAt: 0,
	estimatedRemainingSec: 0,
	isPaused: false,
	isAutoPaused: false,
	hnswNodeCount: 0,
	dbSizeMb: 0,
	lastError: "",
	fileChunkProgress: "",
	activeFiles: [],
};

/** SiliconFlow Embedding API types */
export interface EmbeddingResponse {
	object: string;
	model: string;
	data: EmbeddingDataItem[];
	usage: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
	};
}

export interface EmbeddingDataItem {
	object: string;
	embedding: number[];
	index: number;
}

/** Semantic search result */
export interface SearchResult {
	chunkId: string;
	notePath: string;
	heading: string;
	contentPreview: string;
	score: number;
}

/** Event types emitted by the progress tracker */
export type ProgressEvent =
	| { type: "progress"; progress: IndexProgress }
	| { type: "phase_change"; phase: IndexPhase }
	| { type: "network_change"; status: NetworkStatus }
	| { type: "pause" }
	| { type: "resume" }
	| { type: "error"; error: string }
	| { type: "complete" };

export type ProgressCallback = (event: ProgressEvent) => void;

// ──── Chat History ────

/** A thinking step serialized into history (mirrors ChatClient's ThinkingStep). */
export interface HistoryThinkingStep {
	type: "thought" | "tool";
	text?: string;
	name?: string;
	args?: unknown;
	result?: string;
}

/** One composed input run: plain text or a dropped-note chip. */
export interface HistorySegment {
	type: "text" | "file";
	value: string;
}

/** One context category's token share (messages / system_tools / …). */
export interface ContextCategory {
	key: string; // "messages" | "system_tools" | "mcp_tools" | "skills" | "system_prompt" | "other"
	tokens: number;
}

/** Context usage breakdown of a chat turn (capacity + per-category tokens). */
export interface ContextBreakdown {
	capacity: number;
	used: number;
	categories: ContextCategory[];
}

/** One message in a persisted chat session. */
export interface HistoryMessage {
	role: "user" | "assistant";
	content: string;
	/** User messages only — ordered text/chip runs that reproduce the composed
	 * input faithfully when the session is re-opened from history. */
	segments?: HistorySegment[];
	thinking?: HistoryThinkingStep[];
	sources?: string[];
	/** True citation number per entry of `sources` (per-turn registry
	 *  numbers the model cited) — restored cards keep the real [n]. */
	sourceNumbers?: number[];
	elapsedSec?: number;
	/** Context usage of this turn, so the ring + tooltip can be restored
	 * when the session is re-opened from history. */
	contextTokens?: number;
	contextBreakdown?: ContextBreakdown;
	cacheHitRate?: number | null;
	timestamp: number;
}

/** A full chat session (one "conversation thread"). */
export interface ChatSession {
	id: string;
	title: string;
	messages: HistoryMessage[];
	createdAt: number;
	updatedAt: number;
	/** Pro history management: folder path, "/"-nested ("工作/复盘"). */
	folder?: string;
	/** Manually archived from the drawer — hidden from the main tabs,
	 *  manageable (restore/delete) in the archive view. */
	archived?: boolean;
	/** Pro: pinned chats float above "Today" in the Time tab and are never
	 *  evicted by the MAX_SESSIONS cap. */
	pinned?: boolean;
}
