import svg1f303 from "./emoji/1f303.svg";
import svg1f305 from "./emoji/1f305.svg";
import svg1f307 from "./emoji/1f307.svg";
import svg1f319 from "./emoji/1f319.svg";
import svg1f31e from "./emoji/1f31e.svg";
import svg1f369 from "./emoji/1f369.svg";
import svg1f371 from "./emoji/1f371.svg";
import svg1f389 from "./emoji/1f389.svg";
import svg1f3c3 from "./emoji/1f3c3.svg";
import svg1f60e from "./emoji/1f60e.svg";
import svg1f62a from "./emoji/1f62a.svg";
import svg1f917 from "./emoji/1f917.svg";
import svg1f973 from "./emoji/1f973.svg";

/** Fluent UI Emoji flat 风格 SVG（MIT — microsoft/fluentui-emoji）。键 =
 *  emoji 字符。flat 单色描边风格比苹果原生 emoji 的立体阴影轻盈，用于
 *  大字号展示位（欢迎语徽章 / 引导 hub 徽标）；映射表外的 emoji 回退
 *  系统字形。 */
const FLAT_EMOJI: Record<string, string> = {
	"🌙": svg1f319, // crescent moon
	"🌅": svg1f305, // sunrise
	"🌇": svg1f307, // sunset
	"🌃": svg1f303, // night with stars
	"🌞": svg1f31e, // sun with face
	"🍩": svg1f369, // doughnut
	"🍱": svg1f371, // bento box
	"🎉": svg1f389, // party popper
	"🏃": svg1f3c3, // person running
	"😎": svg1f60e, // smiling face with sunglasses
	"😪": svg1f62a, // sleepy face
	"🤗": svg1f917, // hugging face
	"🥳": svg1f973, // partying face
};

/** emoji 字符 → Fluent flat SVG 字符串；未收录返回 undefined（调用方回退
 *  系统字形）。多码位输入按首个已收录码点解析。 */
export function fluentEmojiSvg(emoji: string): string | undefined {
	if (FLAT_EMOJI[emoji]) return FLAT_EMOJI[emoji];
	for (const ch of emoji) {
		if (FLAT_EMOJI[ch]) return FLAT_EMOJI[ch];
	}
	return undefined;
}
