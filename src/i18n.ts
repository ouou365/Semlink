// ========================================
// Semlink - Internationalization
// ========================================

export type Lang = "zh" | "en";

let currentLang: Lang = "zh";

export function setLang(lang: Lang) {
	currentLang = lang;
}

export function getLang(): Lang {
	return currentLang;
}

type Strings = Record<string, Record<Lang, string>>;

const S: Strings = {
	// ──── Settings Tab ────
	settingsTitle: { zh: "Semlink 设置", en: "Semlink Settings" },
	language: { zh: "语言", en: "Language" },
	languageDesc: { zh: "界面显示语言", en: "Interface language" },
	provider: { zh: "嵌入服务", en: "Embedding Provider" },
	providerDesc: { zh: "选择嵌入向量生成服务", en: "Choose embedding vector generation service" },
	providerSiliconFlow: { zh: "SiliconFlow", en: "SiliconFlow" },
	providerHuggingFace: { zh: "Hugging Face", en: "Hugging Face" },
	apiKey: { zh: "SiliconFlow API Key", en: "SiliconFlow API Key" },
	apiKeyDesc: { zh: "在 {site} 获取的 API 密钥", en: "API key from {site}" },
	huggingFaceApiKey: { zh: "Hugging Face API Key", en: "Hugging Face API Key" },
	huggingFaceApiKeyDesc: { zh: "在 huggingface.co/settings/tokens 获取的 Access Token", en: "Access Token from huggingface.co/settings/tokens" },
	apiBase: { zh: "API 区域", en: "API Region" },
	apiBaseDesc: { zh: "SiliconFlow API 服务区域", en: "SiliconFlow API service region" },
	apiBaseCN: { zh: "中国大陆 (siliconflow.cn)", en: "China (siliconflow.cn)" },
	apiBaseGlobal: { zh: "全球 (siliconflow.com)", en: "Global (siliconflow.com)" },
	embeddingModel: { zh: "嵌入模型", en: "Embedding Model" },
	embeddingModelDesc: { zh: "嵌入服务支持的嵌入模型", en: "Embedding model supported by the provider" },
	modelRecommended: { zh: "推荐, 8192 tokens", en: "Recommended, 8192 tokens" },
	modelEnhanced: { zh: "增强版", en: "Enhanced" },
	modelZhOptimized: { zh: "中文优化, 512 tokens", en: "Chinese optimized, 512 tokens" },
	modelEnOptimized: { zh: "英文优化, 512 tokens", en: "English optimized, 512 tokens" },
	mcpPort: { zh: "MCP 服务端口", en: "MCP Port" },
	mcpPortDesc: { zh: "HTTP MCP 服务监听端口", en: "HTTP MCP server listening port" },
	mcpAccessKey: { zh: "MCP 访问密钥", en: "MCP Access Key" },
	mcpAccessKeyDesc: { zh: "MCP 客户端连接时需要提供的 API Key（留空则不验证）", en: "API key for MCP client authentication (leave empty to disable)" },
	mcpAccessKeyPlaceholder: { zh: "可选认证密钥", en: "Optional auth key" },
	chunkSize: { zh: "分块大小", en: "Chunk Size" },
	chunkSizeDesc: { zh: "每个文本块的最大字符数（建议 500-1000）", en: "Max characters per text chunk (recommended 500-1000)" },
	chunkOverlap: { zh: "分块重叠", en: "Chunk Overlap" },
	chunkOverlapDesc: { zh: "相邻块之间的重叠字符数", en: "Overlap characters between adjacent chunks" },
	batchSize: { zh: "批量嵌入大小", en: "Batch Size" },
	batchSizeDesc: { zh: "每次 API 调用包含的文本数量（1-128）", en: "Number of texts per API call (1-128)" },
	requestDelay: { zh: "请求间隔 (ms)", en: "Request Delay (ms)" },
	requestDelayDesc: { zh: "API 请求之间的延迟毫秒数（防止限流）", en: "Delay between API requests in ms (prevent rate limiting)" },
	excludePaths: { zh: "排除路径", en: "Exclude Paths" },
	excludePathsDesc: { zh: "每行一个路径前缀，匹配的文件不会被索引", en: "Path prefixes to exclude from indexing (one per line)" },
	autoIndex: { zh: "自动索引", en: "Auto Index" },
	autoIndexDesc: { zh: "文件变更时自动更新向量索引", en: "Automatically update vector index on file changes" },
	actions: { zh: "操作", en: "Actions" },
	sectionModel: { zh: "模型设置", en: "Model Settings" },
	sectionMcp: { zh: "MCP 服务", en: "MCP Service" },
	sectionEmbedding: { zh: "嵌入参数", en: "Embedding Parameters" },
	sectionIndex: { zh: "索引管理", en: "Index Management" },
	mcpService: { zh: "MCP 服务", en: "MCP Service" },
	mcpRunning: { zh: "运行中", en: "Running" },
	mcpStopped: { zh: "未启动", en: "Stopped" },
	restartService: { zh: "重启服务", en: "Restart" },
	startService: { zh: "启动服务", en: "Start" },
	fullReindex: { zh: "全量重建索引", en: "Full Reindex" },
	fullReindexDesc: { zh: "重新扫描所有文件并生成向量（耗时较长）", en: "Re-scan all files and rebuild vectors (may take a while)" },
	startFullIndex: { zh: "▶ 开始索引", en: "▶ Start Index" },
	clientConfig: { zh: "客户端配置", en: "Client Configuration" },
	claudeDesktopConfig: { zh: "Claude Desktop / Cursor 配置", en: "Claude Desktop / Cursor Config" },
	claudeDesktopDesc: { zh: "复制以下 JSON 到 MCP 客户端配置文件中", en: "Copy the JSON below to your MCP client config file" },
	claudeCodeCmd: { zh: "Claude Code 命令", en: "Claude Code Command" },
	claudeCodeDesc: { zh: "在终端运行以下命令连接", en: "Run the command below in terminal to connect" },

	// ──── Status Bar ────
	statusInit: { zh: "Semlink: 初始化中...", en: "Semlink: Initializing..." },
	statusReady: { zh: "Semlink: 就绪", en: "Semlink: Ready" },
	statusCompleted: { zh: "Semlink: 索引完成 ✓", en: "Semlink: Index complete ✓" },
	statusIndexed: { zh: "笔记已索引", en: "notes indexed" },
	statusFilesCount: { zh: "个文件", en: "files" },

	// ──── Notices ────
	noticeMcpStarted: { zh: "服务已启动", en: "Service started" },
	noticeMcpFailed: { zh: "启动失败", en: "Start failed" },
	noticeMcpStopped: { zh: "服务已停止", en: "Service stopped" },
	noticeIndexRunning: { zh: "索引正在进行中", en: "Indexing in progress" },
	noticeNoApiKey: { zh: "请先配置 SiliconFlow API Key", en: "Please configure SiliconFlow API Key first" },
	noticeStartIndex: { zh: "开始索引...", en: "Starting index..." },
	noticeIndexPaused: { zh: "索引已暂停", en: "Index paused" },
	noticeIndexResumed: { zh: "索引已恢复", en: "Index resumed" },
	noticeAuthFailed: { zh: "API Key 无效或未配置，请在设置中填写有效的 SiliconFlow API Key", en: "API Key is invalid or not configured. Please set a valid SiliconFlow API Key in Settings" },
	noticeAuthFailedShort: { zh: "API Key 认证失败，索引已暂停", en: "API Key authentication failed, indexing paused" },

	// ──── Commands ────
	cmdFullReindex: { zh: "全量重建索引", en: "Full Reindex" },
	cmdToggleMcp: { zh: "启动/停止 MCP 服务", en: "Start/Stop MCP Service" },
	cmdShowProgress: { zh: "查看索引进度", en: "View Index Progress" },
	cmdResumeIndex: { zh: "开始索引", en: "Start Index" },
	cmdPauseIndex: { zh: "暂停索引", en: "Pause Index" },

	// ──── Progress Modal ────
	progressTitle: { zh: "Semlink 索引进度", en: "Semlink Index Progress" },
	phaseCurrent: { zh: "当前阶段", en: "Current Phase" },
	phaseIdle: { zh: "空闲", en: "Idle" },
	phaseScanning: { zh: "扫描文件", en: "Scanning files" },
	phaseChunking: { zh: "文本分块", en: "Chunking text" },
	phaseEmbedding: { zh: "嵌入向量", en: "Embedding vectors" },
	phaseBuilding: { zh: "构建索引", en: "Building index" },
	phaseCompleted: { zh: "完成", en: "Completed" },
	etaRemaining: { zh: "预计剩余", en: "ETA" },
	embeddedChunks: { zh: "已嵌入 chunks:", en: "Embedded chunks:" },
	failedChunks: { zh: "失败:", en: "Failed:" },
	skippedChunks: { zh: "跳过(未变更):", en: "Skipped (unchanged):" },
	currentFile: { zh: "当前文件:", en: "Current file:" },
	avgResponse: { zh: "平均响应:", en: "Avg response:" },
	chunkProgress: { zh: "文件分片:", en: "File batches:" },
	networkLabel: { zh: "网络:", en: "Network:" },
	networkHealthy: { zh: "🟢 正常", en: "🟢 Healthy" },
	networkDegraded: { zh: "🟡 降速", en: "🟡 Degraded" },
	networkPaused: { zh: "🔴 已暂停", en: "🔴 Paused" },
	autoPaused: { zh: "(自动暂停)", en: "(Auto paused)" },
	manualPaused: { zh: "(手动暂停)", en: "(Manually paused)" },
	consecutiveFailures: { zh: "连续失败:", en: "Consecutive failures:" },
	backoffRemaining: { zh: "退避剩余:", en: "Backoff remaining:" },
	btnResume: { zh: "▶ 开始索引", en: "▶ Start Index" },
	btnPause: { zh: "⏸ 暂停索引", en: "⏸ Pause Index" },
	btnLoading: { zh: "启动中...", en: "Starting..." },
	btnPausing: { zh: "暂停中...", en: "Pausing..." },
	reportBug: { zh: "报告 Bug", en: "Report Bug" },
	errorAuthFailed: { zh: "⚠ API Key 无效或未配置，请前往插件设置填写 API Key", en: "⚠ API Key invalid or missing. Please configure it in plugin Settings" },

	// ──── Semantic Search View ────
	searchViewTitle:   { zh: "语义搜索",          en: "Semantic Search" },
	searchPlaceholder: { zh: "输入自然语言查询…",   en: "Type a natural-language query…" },
	searchButton:      { zh: "搜索",              en: "Search" },
	searchSearching:   { zh: "搜索中…",           en: "Searching…" },
	searchNoQuery:     { zh: "请输入查询内容",      en: "Enter a query to search" },
	searchNoResults:   { zh: "没有找到相关笔记",    en: "No matching notes found" },
	searchError:       { zh: "搜索失败：",         en: "Search failed:" },
	searchScoreLabel:  { zh: "相似度",            en: "Similarity" },
	searchNeedApiKey:  { zh: "请先在插件设置中配置 API Key 并完成索引", en: "Configure an API Key in Settings and run an index first" },
	cmdOpenSearch:     { zh: "打开语义搜索侧边栏",  en: "Open Semantic Search sidebar" },
};

export function t(key: string): string {
	const entry = S[key];
	if (!entry) return key;
	return entry[currentLang] || entry.zh || key;
}
