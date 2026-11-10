// ========================================
// Semlink - Upgrade / License Modal
// ========================================
// The single upgrade surface (docs/freemium-design.md §6): status + benefits
// + price anchor + the permanent-free promise, plus license key activation
// and device management. Reached from the settings page, the chat panel
// header and every locked item.

import { App, Modal, Notice, setIcon } from "obsidian";
import type SmartVaultPlugin from "../main";
import { licenseErrorMessage } from "./license";
import { ConfirmModal } from "./confirm-modal";
import { t } from "./i18n";

export class LicenseModal extends Modal {
	private plugin: SmartVaultPlugin;
	/** Optional: runs after the modal closes (e.g. re-open the surface the
	 *  user activated from, so it re-renders with the new license state). */
	private onClosed?: () => void;

	constructor(app: App, plugin: SmartVaultPlugin, onClosed?: () => void) {
		super(app);
		this.plugin = plugin;
		this.onClosed = onClosed;
		this.modalEl.addClass("semlink-license-modal");
	}

	onOpen(): void {
		this.render();
	}

	onClose(): void {
		this.onClosed?.();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		const lm = this.plugin.licenseManager;
		const pro = lm.isPro();

		// ── Status ──
		new Setting(contentEl)
			.setName(pro ? t("licenseStatusPro") : t("licenseStatusFree"))
			.setDesc(pro ? lm.statusLine() : t("licenseFreeDesc"));

		if (!pro) {
			// ── Pro benefits ──
			contentEl.createDiv({ cls: "semlink-license-subhead", text: t("upgradeBenefitsTitle") });
			const benefits = contentEl.createDiv({ cls: "semlink-license-benefits" });
			for (const line of [t("upgradeBenefitHistory"), t("upgradeBenefitOrganize")]) {
				const row = benefits.createDiv({ cls: "semlink-license-benefit-row" });
				row.createSpan({ cls: "semlink-license-check" });
				row.createSpan({ text: line });
			}

			// ── Price / buy ──
			contentEl.createDiv({ cls: "semlink-license-subhead", text: t("upgradeBuyTitle") });
			if (!lm.configured) {
				contentEl.createDiv({ cls: "semlink-license-note", text: t("licenseNotConfigured") });
			} else {
				const buy = contentEl.createDiv({ cls: "semlink-license-buy" });
				// Single checkout path: the backend creates the session and
				// picks the payment provider. No static payment link exists —
				// if no endpoint is reachable we say so instead of routing
				// the buyer somewhere stale.
				const buyBtn = buy.createEl("button", { cls: "mod-cta", text: t("upgradeBuyEarly") });
				buyBtn.addEventListener("click", () => void (async () => {
					if (buyBtn.dataset.busy === "1") return;
					buyBtn.dataset.busy = "1";
					try {
						window.open(await lm.openCheckout(), "_blank");
					} catch {
						new Notice(t("upgradeCheckoutUnavailable"));
					} finally {
						buyBtn.dataset.busy = "";
					}
				})());
				contentEl.createDiv({ cls: "semlink-license-anchor", text: t("upgradePriceAnchor") });
			}

			// ── Permanent free promise ──
			contentEl.createDiv({ cls: "semlink-license-subhead", text: t("upgradeFreeListTitle") });
			const freeList = contentEl.createDiv({ cls: "semlink-license-benefits" });
			for (const line of [
				t("upgradeFreeSearch"),
				t("upgradeFreeMcp"),
				t("upgradeFreeModels"),
				t("upgradeFreeDepth"),
				t("upgradeFreeLocal"),
			]) {
				const row = freeList.createDiv({ cls: "semlink-license-benefit-row semlink-license-free-row" });
				row.createSpan({ cls: "semlink-license-check" });
				row.createSpan({ text: line });
			}
		}

		// ── License key management (both states) ──
		contentEl.createDiv({ cls: "semlink-license-subhead", text: t("licenseKeyTitle") });
		const keySetting = new Setting(contentEl).setName(t("licenseKeyLabel"));
		if (!pro) {
			keySetting.addText((text) =>
				text
					.setPlaceholder(t("licenseKeyPlaceholder"))
					.onChange((v) => { this.pendingKey = v.trim(); })
			);
			keySetting.addButton((btn) =>
				btn
					.setButtonText(t("licenseActivate"))
					.setCta()
					.onClick(async () => {
						if (!this.pendingKey) return;
						btn.setDisabled(true);
						try {
							await lm.activate(this.pendingKey);
							new Notice(t("licenseActivated"));
							this.render();
						} catch (e) {
							new Notice(licenseErrorMessage(e));
						} finally {
							btn.setDisabled(false);
						}
					})
			);
		} else {
			keySetting
				.setDesc(t("licenseKeyMasked").replace("{key}", this.plugin.settings.license?.key?.slice(0, 10) + "…"))
				.addButton((btn) =>
					btn
						.setButtonText(t("licenseDeactivate"))
						.onClick(async () => {
							btn.setDisabled(true);
							try {
								await lm.deactivate();
								new Notice(t("licenseDeactivated"));
								this.render();
							} catch (e) {
								new Notice(licenseErrorMessage(e));
							} finally {
								btn.setDisabled(false);
							}
						})
				);
		}

		// ── Trust note ──
		contentEl.createDiv({ cls: "semlink-license-trust", text: t("upgradeTrustNote") });
	}

	private pendingKey = "";
}

/** About 弹窗（Basic 页 License 行点开，用户参考 Eagle.app 的关于窗）：
 *  居中贺卡——大图标 → 名称 → 标语 → 版本 → hairline → 许可只读行
 *  （状态/方案/设备/密钥掩码点击复制）→ 停用 → OK 全宽 → 版权。
 *  停用成功后关窗并回调重渲设置页。 */
export class LicenseInfoModal extends Modal {
	private plugin: SmartVaultPlugin;
	private onClosed?: () => void;

	constructor(app: App, plugin: SmartVaultPlugin, onClosed?: () => void) {
		super(app);
		this.plugin = plugin;
		this.onClosed = onClosed;
		this.modalEl.addClass("semlink-license-modal");
	}

	onOpen(): void {
		this.render();
	}

	onClose(): void {
		this.onClosed?.();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("semlink-license-about");
		const lm = this.plugin.licenseManager;
		const info = lm.proInfo();

		// ── 头部：图标 → 名称 → 标语 → 版本 ──
		const icon = contentEl.createDiv({ cls: "semlink-license-about-icon" });
		setIcon(icon, "semlink-logo");
		contentEl.createDiv({ cls: "semlink-license-about-name", text: "Semlink" });
		contentEl.createDiv({ cls: "semlink-license-about-tagline", text: t("settingsTagline") });
		contentEl.createDiv({
			cls: "semlink-license-about-version",
			text: t("licenseAboutVersion").replace("{v}", this.plugin.manifest.version),
		});

		// ── 许可只读行（内嵌信息卡）：label 左、value 右 ──
		const rows = contentEl.createDiv({ cls: "semlink-license-about-rows" });
		const row = (label: string): HTMLElement => {
			const r = rows.createDiv({ cls: "semlink-license-about-row" });
			r.createSpan({ cls: "semlink-license-about-rowlabel", text: label });
			return r.createSpan({ cls: "semlink-license-about-rowvalue" });
		};
		const status = row(t("licenseFieldStatus"));
		status.addClass("is-green");
		status.setText(t("licenseStatusActive"));
		row(t("licenseFieldPlan")).setText(t("licenseLifetime"));
		const used = info?.used ?? 0;
		const limit = info?.limit ?? 0;
		row(t("licenseDevices")).setText(limit ? `${used} / ${limit}` : String(used));

		// 密钥：掩码展示，点击复制全文
		const rawKey = info?.key ?? "";
		const keyVal = row(t("licenseKeyField"));
		keyVal.setText(rawKey.length > 8 ? `${rawKey.slice(0, 4)}····${rawKey.slice(-4)}` : rawKey || "—");
		if (rawKey) {
			keyVal.addClass("is-clickable");
			keyVal.setAttr("title", t("licenseCopyKey"));
			keyVal.addEventListener("click", () => {
				void navigator.clipboard.writeText(rawKey).then(() => new Notice(t("licenseCopied")));
			});
		}

		// 停用：小字危险钮，确认流与设置页同款；成功关窗 → onClosed 重渲
		const actions = contentEl.createDiv({ cls: "semlink-license-about-actions" });
		const de = actions.createEl("button", {
			cls: "semlink-btn-ghost mod-danger semlink-license-deactivate",
			text: t("licenseDeactivateShort"),
		});
		de.addEventListener("click", () => {
			new ConfirmModal(this.app, t("licenseDeactivate"), t("licenseDeactivateConfirmBody"), () => void (async () => {
				if (de.dataset.busy === "1") return;
				de.dataset.busy = "1";
				de.setAttr("disabled", "true");
				de.addClass("is-busy");
				try {
					await lm.deactivate();
					new Notice(t("licenseDeactivated"));
					this.close();
				} catch (e) {
					new Notice(licenseErrorMessage(e));
				} finally {
					de.dataset.busy = "";
					de.removeClass("is-busy");
					de.removeAttribute("disabled");
				}
			})()).open();
		});

		// OK 全宽 + 版权脚
		const ok = contentEl.createEl("button", {
			cls: "semlink-btn-primary semlink-btn-block semlink-license-about-ok",
			text: t("licenseAboutOk"),
		});
		ok.addEventListener("click", () => this.close());
		contentEl.createDiv({ cls: "semlink-license-about-copyright", text: t("licenseCopyright") });
	}
}
