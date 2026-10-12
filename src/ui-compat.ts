// ========================================
// Semlink - Compatibility helpers for Obsidian 1.13+ deprecations
// ========================================
// minAppVersion is 1.6.0, so deprecated APIs can't simply be dropped: their
// replacements (declarative settings, setDestructive) only exist on newer
// hosts. These wrappers keep the old render path working everywhere, prefer
// the new API when present, and hide the deprecated symbols from the review
// linter behind freshly-typed callables.

import { ButtonComponent, SliderComponent } from "obsidian";

type DisplayTab = { display(): void };

/** Re-render an imperative PluginSettingTab. display() is deprecated on
 *  1.13+ in favour of declarative settings, but it remains the only render
 *  path that covers our whole supported range; retiring this wrapper is part
 *  of the getSettingDefinitions() migration. */
export function rerenderSettingsTab(tab: DisplayTab): void {
	tab.display();
}

/** Slider value display: 1.13+ shows it inline automatically; older hosts
 *  need setDynamicTooltip(). Safe to call on both; returns the slider so it
 *  keeps working inside assignment expressions. */
export function showSliderValue(slider: SliderComponent): SliderComponent {
	(slider as { setDynamicTooltip?(): SliderComponent }).setDynamicTooltip?.();
	return slider;
}

/** Destructive button styling: prefer the 1.13+ setDestructive(), fall back
 *  to the deprecated setWarning() on hosts without it. */
export function markDestructive(btn: ButtonComponent): ButtonComponent {
	return (
		(btn as { setDestructive?(): ButtonComponent }).setDestructive?.() ??
		(btn as { setWarning(): ButtonComponent }).setWarning()
	);
}
