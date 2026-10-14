// ========================================
// Semlink - Internationalization
// ========================================

import { getLanguage, moment, requireApiVersion } from "obsidian";

export type Lang =
	| "en"
	| "zh"
	| "zh-Hant"
	| "ja"
	| "ko"
	| "de"
	| "fr"
	| "es"
	| "pt"
	| "it"
	| "ru";
export type LangSetting = "auto" | Lang;

/** All supported languages with their native names (never translated — a
 *  language switcher always shows each language in its own script). */
export const LANGUAGES: Array<{ value: Lang; label: string }> = [
	{ value: "en", label: "English" },
	{ value: "zh", label: "简体中文" },
	{ value: "zh-Hant", label: "繁體中文" },
	{ value: "ja", label: "日本語" },
	{ value: "ko", label: "한국어" },
	{ value: "de", label: "Deutsch" },
	{ value: "fr", label: "Français" },
	{ value: "es", label: "Español" },
	{ value: "pt", label: "Português" },
	{ value: "it", label: "Italiano" },
	{ value: "ru", label: "Русский" },
];

let currentLang: Lang = "en";

/** Obsidian's UI language, e.g. "en", "zh", "zh-TW". getLanguage() needs
 *  Obsidian 1.8.7+ (minAppVersion is older); pre-1.8.7 hosts fall back to
 *  the bundled moment locale. zh-TW/HK/MO/Hant map to Traditional Chinese,
 *  other zh-* to Simplified; anything unsupported falls back to English. */
function detectObsidianLang(): Lang {
	const raw = (requireApiVersion("1.8.7") ? getLanguage() : moment.locale())
		.toLowerCase()
		.replace("_", "-");
	if (raw.startsWith("zh")) {
		return /zh-(tw|hk|mo|hant)/.test(raw) ? "zh-Hant" : "zh";
	}
	const short = raw.split("-")[0];
	return (LANGUAGES.some((l) => l.value === short) ? short : "en") as Lang;
}

export function setLang(lang: LangSetting) {
	currentLang = lang === "auto" ? detectObsidianLang() : lang;
}

export function getLang(): Lang {
	return currentLang;
}

import en from "./locales/en";
import zh from "./locales/zh";
import zhHant from "./locales/zh-Hant";
import ja from "./locales/ja";
import ko from "./locales/ko";
import de from "./locales/de";
import fr from "./locales/fr";
import es from "./locales/es";
import pt from "./locales/pt";
import it from "./locales/it";
import ru from "./locales/ru";

/** Per-language tables. en is the key authority; every other locale is
 *  type-checked against it (Record<keyof typeof en, string>) and may hold
 *  fewer keys at runtime — t() falls back to English for gaps. */
const TABLES: Record<Lang, Record<string, string>> = {
	en,
	zh,
	"zh-Hant": zhHant,
	ja,
	ko,
	de,
	fr,
	es,
	pt,
	it,
	ru,
};

const enStrings: Record<string, string> = en;

// 键 → 各语言 的查找表；某语言缺键时 t() 回退英文。
const S: Record<string, Record<Lang, string>> = Object.fromEntries(
	Object.keys(enStrings).map((key) => [
		key,
		Object.fromEntries(
			(Object.keys(TABLES) as Lang[]).map((lang) => [lang, TABLES[lang][key] ?? ""]),
		) as Record<Lang, string>,
	]),
);

export function t(key: string): string {
	const entry = S[key];
	if (!entry) return key;
	return entry[currentLang] || entry.en || key;
}
