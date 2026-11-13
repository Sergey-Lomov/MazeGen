import { MSDF_FONTS, isMsdfFamily, type FontScript } from "../pixi/renderers/fontChoice";
import { fontCoversSample } from "../pixi/renderers/labelFont";
import type { Locale } from "../i18n/localeStore";

/** The script besides Latin each locale needs its text drawn in (GitHub issue #984), or `null` when
 *  Latin is enough (every font has it, so there is nothing to check or show). Typed over `Locale`, so a
 *  locale added to the project settings does not compile until it declares its support here. */
export const LOCALE_FONT_SCRIPT: Record<Locale, FontScript | null> = {
  en: null,
  ru: "cyrillic",
};

/** Characters a browser font must draw itself, not through a fallback, to count as covering the script. */
const SCRIPT_SAMPLES: Record<FontScript, string> = {
  cyrillic: "ЖЩшюЯ",
};

/** Whether the font `family` covers `script`: the baked fonts declare it in the catalog, a browser font
 *  is probed through its glyph metrics. */
export function fontSupportsScript(family: string, script: FontScript): boolean {
  return isMsdfFamily(family) ? MSDF_FONTS[family].scripts.includes(script) : fontCoversSample(family, SCRIPT_SAMPLES[script]);
}
