// ========================================
// Semlink - Local Git integration
// ========================================
// Automatic vault snapshots through the system git binary. Design contract:
//
//  - LOCAL IS FREE: init, auto-snapshot commits and history tools never ask
//    the user anything — Semlink edits (and the user's own edits) always
//    leave a reversible trail.
//  - REMOTE IS PRO: pushing to GitHub/Gitee is gated behind `isPro()`.
//  - RESTORE IS SELF-REVERSIBLE: every restore first takes an automatic
//    "before restore" snapshot, so a wrong rollback can be rolled back.
//
// The git binary is spawned (desktop-only plugin); no bundling of isomorphic
// git — vault repos are small and the CLI is always faster and correct.
// The auth token is never written to git config: the push URL is composed
// per-invocation from settings.

import { execFile } from "child_process";
import { chmodSync, existsSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { GitSettings } from "./types";

/** Default .gitignore written on repo init (only when none exists). */
const DEFAULT_GITIGNORE = [
	"# Semlink: 点开头的目录（.obsidian、AI 工具目录等）一律不入库",
	".*/",
	"# Windows 保留设备名文件（nul/con/prn...）git 无法索引",
	"**/nul",
	"",
].join("\n");

export class GitService {
	private stageTimer: ReturnType<typeof setTimeout> | null = null;
	private commitTimer: ReturnType<typeof setTimeout> | null = null;
	/** Serialized ops: git index locks break under concurrent commits. */
	private chain: Promise<unknown> = Promise.resolve();

	constructor(
		private repoDir: string,
		private getSettings: () => GitSettings,
		private isPro: () => boolean,
	) {}

	/** Whether the integration can run at all (settings toggle + git binary). */
	async available(): Promise<boolean> {
		if (!this.getSettings().enabled) return false;
		try {
			await this.run(["--version"]);
			return true;
		} catch {
			return false;
		}
	}

	isRepo(): boolean {
		return existsSync(join(this.repoDir, ".git"));
	}

	/** 删除本地仓库：只移除 .git（版本历史），vault 里的文件一个都不动。
	 *  Windows 下 git objects 是只读文件，先整树解锁再删。 */
	async removeRepo(): Promise<void> {
		await this.enqueue(async () => {
			const gitDir = join(this.repoDir, ".git");
			if (!existsSync(gitDir)) return;
			const unlock = (dir: string): void => {
				for (const entry of readdirSync(dir, { withFileTypes: true })) {
					const p = join(dir, entry.name);
					if (entry.isDirectory()) unlock(p);
					else {
						try { chmodSync(p, 0o666); } catch { /* best-effort */ }
					}
				}
				try { chmodSync(dir, 0o777); } catch { /* best-effort */ }
			};
			unlock(gitDir);
			rmSync(gitDir, { recursive: true, force: true });
		});
	}

	/** git init + default .gitignore + local identity fallback. */
	async ensureRepo(): Promise<string> {
		if (!this.isRepo()) {
			await this.run(["init"]);
		}
		const ignorePath = join(this.repoDir, ".gitignore");
		if (!existsSync(ignorePath)) {
			writeFileSync(ignorePath, DEFAULT_GITIGNORE, "utf-8");
		}
		// Commits fail without an identity; only set LOCAL config when the
		// user has none (never touch their global config).
		const email = await this.run(["config", "user.email"]).catch(() => "");
		if (!email.trim()) {
			await this.run(["config", "user.name", "Semlink"]);
			await this.run(["config", "user.email", "semlink@local"]);
		}
		// 知识库文件保持原样入库：关掉全局 autocrlf 造成的换行改写
		//（否则 Windows 上每次 add 刷屏 LF/CRLF 警告且 diff 被污染）。
		await this.run(["config", "core.autocrlf", "false"]);
		return "ok";
	}

	/** Vault file event fan-in — TWO independent clocks:
	 *  1. STAGE (fast, ~10s debounce): `git add -A` the moment the index
	 *     detected a change — staging is cheap and keeps the pending set
	 *     always current.
	 *  2. COMMIT (slow, autoCommitMinutes): fix the staged state as a
	 *     snapshot once the vault goes quiet — no prompts, ever.
	 *  Content-modifying operations (restore, future Semlink edits) call
	 *  `snapshot()` first, turning the staged work into a real restore
	 *  point right before anything changes. */
	schedule(): void {
		const s = this.getSettings();
		if (!s.enabled) return;
		if (this.stageTimer) clearTimeout(this.stageTimer);
		this.stageTimer = setTimeout(() => {
			this.stageTimer = null;
			void this.stage().catch((e) => console.warn("[Semlink] git stage failed:", e));
		}, 10_000);
		if (this.commitTimer) clearTimeout(this.commitTimer);
		const delay = Math.max(1, s.autoCommitMinutes ?? 1) * 60_000;
		this.commitTimer = setTimeout(() => {
			this.commitTimer = null;
			void this.snapshot().catch((e) => console.warn("[Semlink] git snapshot failed:", e));
		}, delay);
	}

	/** Stage everything (cheap, no commit). */
	async stage(): Promise<string> {
		if (!this.getSettings().enabled) return "disabled";
		return this.enqueue(async () => {
			if (!this.isRepo()) return "not a repo";
			await this.run(["add", "-A"]);
			return "staged";
		});
	}

	/** Auto snapshot: stage everything + commit. No prompts, by design.
	 *  force=true（「初始化并快照」按钮）：跳过总开关——显式点击即明确
	 *  意图，开关只控制自动快照，不应阻止用户主动建仓库。 */
	async snapshot(message?: string, force = false, onProgress?: (done: number, total: number) => void): Promise<string> {
		const s = this.getSettings();
		if (!s.enabled && !force) return "disabled";
		return this.enqueue(async () => {
			await this.ensureRepo();
			// 待处理清单：未跟踪（排除 ignored）+ 已修改 + 已删除
			const untracked = (await this.run(["ls-files", "-o", "--exclude-standard"])).split("\n").filter(Boolean);
			const modified = (await this.run(["ls-files", "-m"])).split("\n").filter(Boolean);
			const deleted = (await this.run(["ls-files", "-d"])).split("\n").filter(Boolean);
			const all = [...new Set([...untracked, ...modified, ...deleted])];
			if (all.length === 0) return "nothing to commit";
			// 分批 add：git add -A 没有进度输出，分批计数换来真实进度条。
			// execFile 无 shell（路径含空格/中文安全）；批 20 控制参数长度。
			const BATCH = 20;
			const total = all.length;
			for (let i = 0; i < total; i += BATCH) {
				await this.run(["add", "--", ...all.slice(i, i + BATCH)]);
				onProgress?.(Math.min(total, i + BATCH), total);
			}
			const prefix = (s.messagePrefix || "Semlink snapshot").trim();
			const msg = message || `${prefix}: ${new Date().toLocaleString()}`;
			await this.run(["commit", "-m", msg]);
			if (s.autoPush) await this.push().catch((e) => console.warn("[Semlink] git push failed:", e));
			return msg;
		});
	}

	/** All tracked files (git ls-files) for the repository browser. */
	async listFiles(): Promise<string[]> {
		// core.quotepath=false：中文/非 ASCII 路径输出原始 UTF-8（默认会把
			// 非 ASCII 转成 äº 八进制转义，弹窗里全是乱码）。
			const out = await this.enqueue(() => this.run(["-c", "core.quotepath=false", "ls-files"]));
		return out.split("\n").map((s) => s.trim()).filter(Boolean);
	}

	status(): Promise<string> {
		return this.enqueue(async () => {
			await this.ensureRepo();
			const st = await this.run(["status", "--porcelain=v1", "-b"]);
			const last = await this.run(["log", "-1", "--pretty=format:%h %ad %s", "--date=iso"]).catch(() => "no commits yet");
			const lines = st.trim().split("\n").filter(Boolean);
			return `branch: ${st.split("\n")[0]?.replace(/^##\s*/, "") || "?"}\nchanged files: ${Math.max(0, lines.length - 1)}\nlast commit: ${last}`;
		});
	}

	log(count = 10): Promise<string> {
		const n = Math.min(Math.max(1, count), 100);
		return this.enqueue(async () => {
			await this.ensureRepo();
			return (await this.run(["log", `-${n}`, "--date=iso", "--pretty=format:%h | %ad | %s"])).trim();
		});
	}

	diff(path: string): Promise<string> {
		return this.enqueue(async () => {
			await this.ensureRepo();
			return (await this.run(["diff", "HEAD", "--", path])).trim() || "(no changes vs HEAD)";
		});
	}

	/** Manual commit of the current state (MCP/chat `git_commit`). */
	commit(message?: string, force = false, onProgress?: (done: number, total: number) => void): Promise<string> {
		return this.enqueue(() => this.snapshot(message || `Semlink: manual commit ${new Date().toLocaleString()}`, force, onProgress));
	}

	/** Restore a file to a ref. ALWAYS takes a "before restore" snapshot
	 *  first — the rollback itself must stay reversible. */
	async restore(path: string, ref = "HEAD"): Promise<string> {
		return this.enqueue(async () => {
			await this.ensureRepo();
			await this.snapshot(`Semlink: auto snapshot before restore of ${path}`);
			await this.run(["checkout", ref, "--", path]);
			return `restored "${path}" from ${ref} (a pre-restore snapshot was committed first)`;
		});
	}

	/** Push to the configured remote. PRO-GATED: local history is free,
	 *  pushing to GitHub/Gitee is the paid tier. The token is composed
	 *  into the URL per-call and never stored in git config. */
	async push(): Promise<string> {
		const s = this.getSettings();
		if (!s.remoteUrl?.trim()) return "Error: no remote URL configured (Settings → Git)";
		if (!this.isPro()) {
			return "Error: pushing to GitHub/Gitee is a Pro feature. Local snapshots stay free — upgrade to Pro to sync to a remote.";
		}
		return this.enqueue(async () => {
			await this.ensureRepo();
			let url = s.remoteUrl.trim();
			if (s.token?.trim()) {
				if (url.startsWith("https://")) url = url.replace("https://", `https://semlink:${encodeURIComponent(s.token.trim())}@`);
				else return "Error: token auth needs an HTTPS remote URL (ssh remotes are not supported)";
			} else if (url.startsWith("https://")) {
				// HTTPS without a token hangs on a credential prompt (there is
				// no terminal here) — fail fast with the exact fix instead.
				return "Error: HTTPS remote needs an access token (Settings → Git → Access token)";
			}
			const branch = s.remoteBranch?.trim() || "master";
			await this.run(["push", url, branch]);
			return `pushed to remote (${branch})`;
		});
	}

	/** Serialize git operations (index lock is not concurrent-safe). */
	private enqueue<T>(job: () => Promise<T>): Promise<T> {
		const run = this.chain.then(job, job);
		this.chain = run.catch(() => undefined);
		return run;
	}

	private run(args: string[]): Promise<string> {
		return new Promise((resolve, reject) => {
			// 60s hard timeout: a hung git (credential prompt on push, dead
			// remote) used to pin the operation chain forever.
			execFile("git", args, { cwd: this.repoDir, maxBuffer: 16 * 1024 * 1024, timeout: 60_000, windowsHide: true }, (err, stdout, stderr) => {
				if (err) reject(new Error((stderr || err.message || "").trim()));
				else resolve(String(stdout));
			});
		});
	}
}
