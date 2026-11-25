// ========================================
// Semlink - Project create/edit modal
// ========================================
// Project（检索范围限定）的创建/编辑弹窗。2026-11-22 参考 ZCode 新建项目
// 弹窗重构：标签在上、输入框通栏；知识范围为虚线选择区；内联新建文件夹
// 行移除；主按钮深色。2026-11-23 三改（用户拍板，参考钉钉选人面板）：
// 文件夹选择改为**逐级下钻面板**——点文件夹名进入下一级（右侧「下级」
// 入口），「< 返回」+ 面包屑回上级；复选框就地勾选当前级；一级含「全选」。
// 保存回调交还宿主（search-view）：落 settings.projects + 推送视图。

import { App, Modal, setIcon, TFolder } from "obsidian";
import type { ProjectDef } from "./types";
import { t } from "./i18n";

export class ProjectModal extends Modal {
	private project: ProjectDef | undefined;
	private onSave: (p: ProjectDef) => void;
	private name = "";
	private readonly folders = new Set<string>();
	/** 面板全量文件夹清单（含尾 /，排序）。 */
	private all: string[] = [];
	/** 当前浏览的层级（"" = 根，含尾 /）。 */
	private at = "";
	private listEl: HTMLElement | null = null;
	private crumbEl: HTMLElement | null = null;

	constructor(app: App, project: ProjectDef | undefined, onSave: (p: ProjectDef) => void) {
		super(app);
		this.project = project;
		this.onSave = onSave;
		this.name = project?.name ?? "";
		for (const f of project?.folders ?? []) this.folders.add(f);
	}

	onOpen(): void {
		this.modalEl.addClass("smart-vault-settings");
		this.modalEl.addClass("semlink-project-modal");
		const { contentEl } = this;

		contentEl.createEl("h3", { text: this.project ? t("projectEditTitle") : t("projectModalTitle") });

		// ── 名称：标签在上、输入框通栏 ──
		const nameField = contentEl.createDiv({ cls: "semlink-project-field" });
		nameField.createDiv({ cls: "semlink-project-field-label", text: t("projectNameLabel") });
		const nameInput = nameField.createEl("input", {
			cls: "semlink-project-name-input",
			attr: { type: "text", placeholder: t("projectNamePlaceholder") },
		});
		nameInput.value = this.name;
		nameInput.addEventListener("input", () => (this.name = nameInput.value.trim()));

		// ── 知识范围（逐级下钻选择面板） ──
		const folderWrap = contentEl.createDiv({ cls: "semlink-project-folders" });
		folderWrap.createDiv({ cls: "semlink-project-folders-label", text: t("projectSourceFolders") });

		// vault 文件夹清单：递归 TFolder，剪 .obsidian 等点目录，按路径排序
		const walk = (f: TFolder, prefix: string): void => {
			for (const child of f.children) {
				if (!(child instanceof TFolder)) continue;
				const path = prefix + child.name;
				if (!path.startsWith(".")) {
					this.all.push(path + "/");
					walk(child, path + "/");
				}
			}
		};
		walk(this.app.vault.getRoot(), "");
		this.all.sort((a, b) => a.localeCompare(b));

		// 面包屑（根时占位保持行高）+ 行列表
		const panel = folderWrap.createDiv({ cls: "semlink-project-folder-panel" });
		this.crumbEl = panel.createDiv({ cls: "semlink-project-crumb" });
		this.listEl = panel.createDiv({ cls: "semlink-project-folder-list" });
		this.renderLevel();

		// 语义说明行已移除（2026-11-23 用户拍板「去掉这个」）

		// ── 底部：取消 / 创建 ──
		const footer = contentEl.createDiv({ cls: "semlink-editor-footer is-simple" });
		const cancelBtn = footer.createEl("button", { cls: "semlink-btn-ghost", text: t("projectCancel") });
		cancelBtn.addEventListener("click", () => this.close());
		const saveBtn = footer.createEl("button", { cls: "semlink-btn-primary", text: this.project ? t("projectSave") : t("projectCreate") });
		saveBtn.addEventListener("click", () => {
			const name = this.name;
			if (!name) return;
			if (this.folders.size === 0) return;
			this.onSave({
				id: this.project?.id ?? `p-${Date.now()}`,
				name,
				folders: [...this.folders].sort(),
			});
			this.close();
		});
	}

	/** 某层的直接子文件夹。 */
	private childrenOf(prefix: string): string[] {
		return this.all.filter((f) => f.startsWith(prefix) && f.slice(prefix.length) !== "" &&
			!f.slice(prefix.length).slice(0, -1).includes("/"));
	}

	/** 渲染当前层级（at）：面包屑 + 行（复选 + 名称 + 下级入口）。 */
	private renderLevel(): void {
		const list = this.listEl;
		const crumb = this.crumbEl;
		if (!list || !crumb) return;
		list.empty();
		crumb.empty();

		// 面包屑（2026-11-23 用户拍板「只高亮这个区域而不是整行」）：
		// < 返回 + 路径段包进 crumb-main chip，悬停灰底只盖这个小块。
		if (this.at !== "") {
			const main = crumb.createSpan({ cls: "semlink-project-crumb-main" });
			const back = main.createSpan({ cls: "semlink-project-crumb-back" });
			setIcon(back, "chevron-left");
			back.addEventListener("click", () => {
				const parent = this.at.slice(0, -1).split("/").slice(0, -1).join("/");
				this.at = parent ? parent + "/" : "";
				this.renderLevel();
			});
			// 路径段（前缀可点返回任意层级）+ 当前级灰显
			const segs = this.at.slice(0, -1).split("/").filter(Boolean);
			segs.forEach((seg, i) => {
				if (i > 0) main.createSpan({ cls: "semlink-project-crumb-sep", text: " / " });
				const prefix = segs.slice(0, i + 1).join("/") + "/";
				const isLast = i === segs.length - 1;
				const segEl = main.createSpan({ cls: "semlink-project-crumb-seg" + (isLast ? " is-current" : ""), text: seg });
				if (!isLast) {
					segEl.addEventListener("click", () => { this.at = prefix; this.renderLevel(); });
				}
			});
		}
		// 「全选」chip 居左（2026-11-23 用户拍板）：悬停灰底只盖 chip。
		if (this.at === "") {
			const top = this.childrenOf("");
			const allChecked = top.every((f) => this.folders.has(f));
			const sel = crumb.createSpan({ cls: "semlink-project-selectall" });
			const cb = sel.createEl("input", { type: "checkbox" });
			cb.checked = allChecked;
			sel.createSpan({ cls: "semlink-project-selectall-label", text: t("projectSelectAll") });
			cb.addEventListener("change", () => {
				for (const f of top) {
					if (cb.checked) this.folders.add(f);
					else this.folders.delete(f);
				}
				this.renderLevel();
			});
			sel.addEventListener("click", (e) => {
				if (e.target === cb) return;
				cb.checked = !cb.checked;
				cb.dispatchEvent(new Event("change"));
			});
		}

		for (const path of this.childrenOf(this.at)) {
			const row = list.createDiv({ cls: "semlink-project-folder-row" });
			row.dataset.path = path;
			// chip（2026-11-23 用户拍板「只高亮这个区域而不是整行」）：
			// 复选框 + 名称包进 main chip，悬停灰底只盖这个小块。
			const main = row.createSpan({ cls: "semlink-project-folder-main" });
			const cb = main.createEl("input", { type: "checkbox" });
			cb.checked = this.folders.has(path);
			cb.addEventListener("change", () => {
				if (cb.checked) this.folders.add(path);
				else this.folders.delete(path);
			});
			main.createSpan({
				cls: "semlink-project-folder-name",
				text: path.slice(0, -1).split("/").pop() || path,
			});
			const kids = this.childrenOf(path);
			let down: HTMLElement | null = null;
			if (kids.length > 0) {
				// 「下级」入口（钉钉式）：network 图标 + 文字，悬停整块灰底；
				// 点进下一级；行其余部分点击=勾选。
				down = row.createSpan({ cls: "semlink-project-folder-down" });
				setIcon(down, "network");
				down.createSpan({ text: t("projectDrillDown") });
				down.addEventListener("click", (e) => {
					e.stopPropagation();
					this.at = path;
					this.renderLevel();
				});
			}
			row.addEventListener("click", (e) => {
				const t = e.target as HTMLElement;
				if (t === cb || down?.contains(t)) return;
				cb.checked = !cb.checked;
				cb.dispatchEvent(new Event("change"));
			});
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
