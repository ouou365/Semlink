// ========================================
// Semlink - Internationalization
// ========================================

import { getLanguage, moment, requireApiVersion } from "obsidian";

export type Lang = "zh" | "en";
export type LangSetting = "auto" | Lang;

let currentLang: Lang = "zh";

/** Obsidian's UI language, e.g. "en", "zh", "zh-TW". getLanguage() needs
 *  Obsidian 1.8.7+ (minAppVersion is older); pre-1.8.7 hosts fall back to
 *  the bundled moment locale. Any zh-* prefix maps to zh, everything else
 *  falls back to English. */
function detectObsidianLang(): Lang {
	const raw = requireApiVersion("1.8.7")
		? getLanguage()
		: moment.locale();
	return raw.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function setLang(lang: LangSetting) {
	currentLang = lang === "auto" ? detectObsidianLang() : lang;
}

export function getLang(): Lang {
	return currentLang;
}


import en from "./locales/en";
import zh from "./locales/zh";

// 键 → { zh, en } 的查找表。en 是键集的权威来源（zh 由类型约束保持一致）。
const enStrings: Record<string, string> = en;
const zhStrings: Record<string, string> = zh;
const S: Record<string, Record<Lang, string>> = Object.fromEntries(
	Object.keys(enStrings).map((key) => [key, { en: enStrings[key], zh: zhStrings[key] ?? "" }]),
);

export function t(key: string): string {
	const entry = S[key];
	if (!entry) return key;
	return entry[currentLang] || entry.zh || key;
}
