// ========================================
// Semlink - Usage & Cost Dashboard (Pro)
// ========================================
// 用量看板弹窗。渲染本体已抽到 usage-screen.ts（与抽屉「用量与统计」
// 详情屏共用同一实现，避免双份漂移）——本类只是 Modal 薄包装：开窗
// 画一次，许可状态变化由 dashboard 内部的重渲钩子处理。

import { App, Modal } from "obsidian";
import type SmartVaultPlugin from "../main";
import { renderUsageDashboard } from "./usage-screen";

export class UsageModal extends Modal {
	private plugin: SmartVaultPlugin;

	constructor(app: App, plugin: SmartVaultPlugin) {
		super(app);
		this.plugin = plugin;
		this.modalEl.addClass("semlink-usage-modal");
	}

	onOpen() {
		void this.render();
	}

	onClose() {
		this.contentEl.empty();
	}

	private async render(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		renderUsageDashboard(contentEl, this.plugin, { withHeading: true });
	}
}
