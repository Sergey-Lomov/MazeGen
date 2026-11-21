import { MSDF_FONTS, isMsdfFamily, type FontScript } from "../domain/renderers/fontChoice";
import { fontCoversSample } from "../pixi/renderers/labelFont";
import { ensureUploadedFace, storedUploadedCoverage, uploadedFamilies } from "../pixi/renderers/rasterFont/rasterFontStore";
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

/** Loads the uploaded fonts whose coverage of `script` was never measured, so the next `fontSupportsScript` can
 *  measure and remember it. A font measured before (in an earlier session too) is not read again. */
export function loadUnmeasuredUploadedFonts(script: FontScript): Promise<void> {
  const sample = SCRIPT_SAMPLES[script];
  return Promise.all(uploadedFamilies().filter((family) => storedUploadedCoverage(family, sample) === undefined).map((family) => ensureUploadedFace(family))).then(() => undefined);
}
