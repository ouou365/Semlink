// ========================================
// Semlink - Core Type Definitions
// ========================================

/** Embedding service provider */
export type EmbeddingProvider = "siliconflow" | "huggingface";

/** Chat completion API wire format */
export type ChatApiFormat = "openai" | "anthropic";

/** A single chat model definition */
export interface ChatModel {
	id: string;
	contextWindow: number;
}

/** A chat model provider configuration */
export interface ChatProvider {
	id: string;
	name: string;
	baseUrl: string;
	apiKey: string;
	apiFormat: ChatApiFormat;
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

/** Default DeepSeek chat providers (pre-configured for convenience) */
export const DEFAULT_CHAT_PROVIDERS: ChatProvider[] = [
	{
		id: "deepseek-openai",
		name: "DeepSeek",
		baseUrl: "https://api.deepseek.com",
		apiKey: "",
		apiFormat: "openai",
		models: [
			{ id: "deepseek-v4-flash", contextWindow: 200000 },
			{ id: "deepseek-v4-pro", contextWindow: 200000 },
		],
	},
];

/** Plugin settings persisted via Obsidian loadData/saveData */
export interface SmartVaultSettings {
	language: "auto" | "zh" | "en";
	provider: EmbeddingProvider;
	siliconFlowApiKey: string;
	huggingFaceApiKey: string;
	apiBase: string;
	embeddingModel: string;
	rerankerEnabled: boolean;
	rerankerModel: string;
	mcpPort: number;
	mcpApiKey: string;
	chunkSize: number;
	chunkOverlap: number;
	excludePaths: string;
	autoIndex: boolean;
	maxRetries: number;
	batchSize: number;
	requestDelayMs: number;
	/** Chat model providers for the conversational search feature */
	chatProviders: ChatProvider[];
	/** Feishu bots bound to Semlink */
	feishuBots: FeishuBotConfig[];
}

export const DEFAULT_SETTINGS: SmartVaultSettings = {
	language: "auto",
	provider: "siliconflow",
	siliconFlowApiKey: "",
	huggingFaceApiKey: "",
	apiBase: "https://api.siliconflow.cn",
	embeddingModel: "BAAI/bge-m3",
	rerankerEnabled: false,
	rerankerModel: "BAAI/bge-reranker-v2-m3",
	mcpPort: 3001,
	mcpApiKey: "",
	chunkSize: 800,
	chunkOverlap: 100,
	excludePaths: "templates/\n.git/\n.obsidian/\nnode_modules/",
	autoIndex: true,
	maxRetries: 3,
	batchSize: 64,
	requestDelayMs: 200,
	chatProviders: DEFAULT_CHAT_PROVIDERS,
	feishuBots: [],
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
	args?: any;
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
}
