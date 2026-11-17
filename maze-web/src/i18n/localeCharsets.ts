import type { Locale } from "./localeStore";

/** Unicode characters of a set: explicit characters and inclusive code point ranges (GitHub issue #966). */
export interface CharsetSpec {
  chars?: string;
  ranges?: ReadonlyArray<readonly [from: number, to: number]>;
}

/** The characters each locale needs drawn by an MSDF atlas built from a user font, beyond the base Latin
 *  and the common symbols (`rasterFont/glyphCharset.ts`). Typed over `Locale`, so a locale added to the
 *  project settings does not compile until it declares its set here (like `LOCALE_FONT_SCRIPT`). The atlas
 *  generator knows no alphabet of its own: it unions whatever is declared. */
export const LOCALE_MSDF_CHARSETS: Record<Locale, CharsetSpec> = {
  en: {},
  ru: { ranges: [[0x0410, 0x044f]], chars: "Ёё" },
};
