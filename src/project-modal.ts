// ========================================
// Semlink - Project create/edit modal
// ========================================
// Project（检索范围限定）的创建/编辑弹窗：名称 + 知识库文件夹多选 +
// 内联新建文件夹。仿 ExcludePathsModal 的设置弹窗骨架（复用设置样式）；
// 文件夹树为全新 UI（vault.getRoot() 递归 TFolder，缩进 + 复选）。
// 保存回调交还宿主（search-view）：落 settings.projects + 推送视图。

import { App, Modal, Setting, TFolder } from "obsidian";
import type { ProjectDef } from "./types";
import { t } from "./i18n";

export class ProjectModal extends Modal {
	private project: ProjectDef | undefined;
	private onSave: (p: ProjectDef) => void;
	private name = "";
	private readonly folders = new Set<string>();
	private readonly folderInput: string[] = [];

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

		// ── 名称 ──
		new Setting(contentEl)
			.setName(t("projectNameLabel"))
			.addText((text) => {
				text.setPlaceholder(t("projectNamePlaceholder")).setValue(this.name);
				text.inputEl.style.width = "100%";
				text.onChange((v) => (this.name = v.trim()));
			});

		// ── 知识范围（文件夹多选） ──
		const folderWrap = contentEl.createDiv({ cls: "semlink-project-folders" });
		folderWrap.createDiv({ cls: "semlink-project-folders-label", text: t("projectSourceFolders") });
		const listBox = folderWrap.createDiv({ cls: "semlink-project-folder-list" });
		const hint = folderWrap.createDiv({
			cls: "semlink-project-folders-hint",
			text: this.folders.size > 0 ? "" : t("projectChooseFolderHint"),
		});
		const refreshHint = (): void => {
			hint.setText(this.folders.size > 0 ? "" : t("projectChooseFolderHint"));
		};

		// vault 文件夹清单：递归 TFolder，剪 .obsidian 等点目录，按路径排序
		const folders: string[] = [];
		const walk = (f: TFolder, prefix: string): void => {
			for (const child of f.children) {
				if (!(child instanceof TFolder)) continue;
				const path = prefix + child.name;
				if (!path.startsWith(".")) {
					folders.push(path + "/");
					walk(child, path + "/");
				}
			}
		};
		walk(this.app.vault.getRoot(), "");
		folders.sort((a, b) => a.localeCompare(b));

		for (const path of folders) {
			const depth = path.slice(0, -1).split("/").length - 1;
			const row = listBox.createDiv({ cls: "semlink-project-folder-row" });
			row.style.paddingLeft = `${8 + depth * 16}px`;
			const cb = row.createEl("input", { type: "checkbox" });
			cb.checked = this.folders.has(path);
			cb.addEventListener("change", () => {
				if (cb.checked) this.folders.add(path);
				else this.folders.delete(path);
				refreshHint();
			});
			row.createSpan({ cls: "semlink-project-folder-name", text: path.slice(0, -1).split("/").pop() || path });
			row.addEventListener("click", (e) => {
				if (e.target === cb) return;
				cb.checked = !cb.checked;
				cb.dispatchEvent(new Event("change"));
			});
		}

		// ── 内联新建文件夹 ──
		const newFolderRow = folderWrap.createDiv({ cls: "semlink-project-newfolder-row" });
		const nfInput = newFolderRow.createEl("input", {
			cls: "semlink-project-newfolder-input",
			attr: { type: "text", placeholder: t("projectNewFolder") },
		});
		const nfBtn = newFolderRow.createEl("button", { cls: "semlink-btn-ghost", text: t("projectCreateFolder") });
		nfBtn.addEventListener("click", async () => {
			const raw = nfInput.value.trim().replace(/^\/+|\/+$/g, "");
			if (!raw) return;
			// 逐级创建（父目录必须先存在；已存在抛错→忽略，仿 save-note-modal）
			try {
				let cur = "";
				for (const seg of raw.split("/")) {
					cur = cur ? `${cur}/${seg}` : seg;
					await this.app.vault.createFolder(cur).catch(() => {});
				}
			} catch {
				/* 已存在等错误忽略 */
			}
			nfInput.value = "";
			// 重建清单（新文件夹入列并勾选）
			this.folders.add(raw + "/");
			listBox.empty();
			this.rerenderFolderList(listBox, refreshHint);
			refreshHint();
		});

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

	/** 文件夹清单重渲（新建文件夹后调用）：复用 onOpen 的渲染逻辑。 */
	private rerenderFolderList(listBox: HTMLElement, refreshHint: () => void): void {
		// 简化实现：整面板重开代价高，这里仅重画复选列表。
		// （与 onOpen 内联渲染保持同一结构——提取公共方法反而增加状态同步面。）
		const folders: string[] = [];
		const walk = (f: TFolder, prefix: string): void => {
			for (const child of f.children) {
				if (!(child instanceof TFolder)) continue;
				const path = prefix + child.name;
				if (!path.startsWith(".")) {
					folders.push(path + "/");
					walk(child, path + "/");
				}
			}
		};
		walk(this.app.vault.getRoot(), "");
		folders.sort((a, b) => a.localeCompare(b));
		for (const path of folders) {
			const depth = path.slice(0, -1).split("/").length - 1;
			const row = listBox.createDiv({ cls: "semlink-project-folder-row" });
			row.style.paddingLeft = `${8 + depth * 16}px`;
			const cb = row.createEl("input", { type: "checkbox" });
			cb.checked = this.folders.has(path);
			cb.addEventListener("change", () => {
				if (cb.checked) this.folders.add(path);
				else this.folders.delete(path);
				refreshHint();
			});
			row.createSpan({ cls: "semlink-project-folder-name", text: path.slice(0, -1).split("/").pop() || path });
			row.addEventListener("click", (e) => {
				if (e.target === cb) return;
				cb.checked = !cb.checked;
				cb.dispatchEvent(new Event("change"));
			});
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
