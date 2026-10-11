// ========================================
// Semlink - Upgrade / License Modal
// ========================================
// The single upgrade surface (docs/freemium-design.md §6): status + benefits
// + price anchor + the permanent-free promise, plus license key activation
// and device management. Reached from the settings page, the chat panel
// header and every locked item.

import { App, Modal, Notice, Setting } from "obsidian";
import type SmartVaultPlugin from "../main";
import { licenseErrorMessage } from "./license";
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
			for (const line of [t("upgradeBenefitHistory"), t("upgradeBenefitOrganize"), t("upgradeBenefitFeishu")]) {
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
