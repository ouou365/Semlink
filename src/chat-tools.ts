// ========================================
// Semlink - Chat Tool Registry
// ========================================
// Exposes Semlink's read/search capabilities as tools the chat model can call
// while answering (function calling). Definitions and implementations come
// from the shared tools-core (single source of truth with the MCP server);
// the chat surface hides admin tools (reindex) and caps result size tighter.

import type { Vault } from "obsidian";
import type { VectorStore } from "./vector-store";
import type { EmbeddingClient } from "./embedding-client";
import { EMPTY_PROGRESS } from "./types";
import { TOOL_SPECS, GIT_TOOL_NAMES, ToolCore, parseExcludePaths } from "./tools-core";
import type { GitService } from "./git-service";

/** Tool schema in a neutral form; ChatClient adapts it per API format. */
export interface ChatTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export class SemlinkTools {
	private store: VectorStore;
	private client: EmbeddingClient;
	private vault: Vault;
	/** Returns the vault path of the note currently open in Obsidian (or
	 *  null when none). Injected by the plugin so tools can answer
	 *  "当前笔记" questions without the user naming the file. */
	private getActiveNote: () => string | null;
	/** 设置里的全局排除路径（excludePaths），每次调用现读——设置修改即时生效。 */
	private getExcludedPaths: () => string[];
	/** Git 集成（null = 未启用，git_* 工具不注册）。 */
	private git: GitService | null;

	/** Upper bound on a single tool result; adjustable per search depth. */
	maxResultChars = 4000;

	/** Per-turn citation numberer, injected by chat-client before the rounds
	 *  start. When set, search hits carry their global `n`, and opened notes
	 *  announce theirs in a header line — one numbering space across the
	 *  initial context, tool results, thinking, and the final answer. */
	citeNumberer: ((path: string, line?: number, kind?: "read" | "hit") => number) | null = null;

	/** Shared implementation core. */
	private core: ToolCore;

	constructor(store: VectorStore, client: EmbeddingClient, vault: Vault, getActiveNote: () => string | null = () => null, excludePathsSource: () => string = () => "", git: GitService | null = null) {
		this.store = store;
		this.client = client;
		this.vault = vault;
		this.getActiveNote = getActiveNote;
		this.getExcludedPaths = () => parseExcludePaths(excludePathsSource());
		this.git = git;
		this.core = new ToolCore({
			store,
			client,
			vault,
			getActiveNote,
			excludedPaths: () => this.getExcludedPaths(),
			git,
			progress: () => EMPTY_PROGRESS,
			// 聊天侧不开放管理工具：list() 已过滤 reindex，这里兜底报错
			reindex: async () => {
				throw new Error("reindex is not available in chat (admin tool)");
			},
		});
	}

	/** Read-only tools the chat model may call（管理类 reindex 不暴露；
	 *  git_* 仅在 Git 集成启用时注册）。 */
	list(): ChatTool[] {
		return TOOL_SPECS.filter((t) => t.name !== "reindex" && (this.git || !GIT_TOOL_NAMES.has(t.name))).map((t) => ({
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		}));
	}

	/** Execute a tool by name; always returns a text result (errors included). */
	async execute(name: string, args: Record<string, unknown>): Promise<string> {
		this.core.maxChars = this.maxResultChars;
		this.core.cite = (path, line, kind) => this.citeNumberer?.(path, line, kind) ?? null;
		return await this.core.execute(name, args);
	}
}
