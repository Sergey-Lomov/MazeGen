import { LOCALE_MSDF_CHARSETS, type CharsetSpec } from "../../../i18n/localeCharsets";

/** The character set converted when a raster font's MSDF atlas is built (GitHub issue #966): the union of the
 *  base Latin letters, the symbols every label may use and the sets the locales declare
 *  (`LOCALE_MSDF_CHARSETS`). Anything else a label needs is generated on demand. */

const BASE_LATIN: CharsetSpec = { ranges: [[0x41, 0x5a], [0x61, 0x7a]] };

/** Digits, ASCII punctuation and symbols common in labels. */
const COMMON: CharsetSpec = { ranges: [[0x30, 0x39]], chars: " :;,.!?'\"()[]{}#+-=_*%@&/\|<>~^$№«»–—…°±×÷€•·§" };

/** Code points of `specs`, ascending and without duplicates; characters beyond the BMP count once. */
export function expandCharsets(specs: readonly CharsetSpec[]): number[] {
  const points = new Set<number>();
  for (const spec of specs) {
    for (const [from, to] of spec.ranges ?? []) for (let point = from; point <= to; point++) points.add(point);
    for (const char of spec.chars ?? "") points.add(char.codePointAt(0)!);
  }
  return [...points].sort((a, b) => a - b);
}

/** A short fingerprint of a code point list: part of the atlas cache identity, so a changed set is noticed. */
export function charsetVersion(points: readonly number[]): string {
  let hash = 0x811c9dc5;
  for (const point of points) hash = Math.imul(hash ^ point, 0x01000193) >>> 0;
  return `${points.length}:${hash.toString(16)}`;
}

export interface GlyphCharset {
  codepoints: number[];
  version: string;
}

let cached: GlyphCharset | null = null;

/** The set every atlas is built with: base Latin, common symbols and every locale's declaration. All locales
 *  count, not only the active one, so switching the interface language never rebuilds an atlas. */
export function currentCharset(): GlyphCharset {
  if (!cached) {
    const codepoints = expandCharsets([BASE_LATIN, COMMON, ...Object.values(LOCALE_MSDF_CHARSETS)]);
    cached = { codepoints, version: charsetVersion(codepoints) };
  }
  return cached;
}
