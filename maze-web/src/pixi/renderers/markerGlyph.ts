/** Glyphs a marker text badge (GitHub issue #697) may use — the baked MSDF charset
 *  (`tools/msdf/generate.mjs`'s `CHARSET`) minus space and the `:()`, ',' punctuation, which read
 *  oddly as a lone badge glyph. Uppercase Latin + uppercase Cyrillic + digits. */
const MARKER_GLYPH_CHARSET = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ");

/** Normalizes raw text-input into a valid marker glyph (GitHub issue #697): takes the first
 *  character, uppercases it, and keeps it only if it's in the baked MSDF charset — otherwise
 *  returns `""` (no label). Empty input returns `""` unchanged. Shared by the settings-panel input
 *  and project-file validation so both apply the exact same rule. */
export function sanitizeMarkerGlyph(raw: string): string {
  if (raw.length === 0) return "";
  const ch = raw[0].toUpperCase();
  return MARKER_GLYPH_CHARSET.has(ch) ? ch : "";
}

/** Whether `raw` is already a valid marker glyph as-is (no truncation/case-folding needed) — used
 *  by the settings-panel input to flag an out-of-charset keystroke as invalid rather than silently
 *  dropping it. */
export function isValidMarkerGlyph(raw: string): boolean {
  return raw.length <= 1 && (raw.length === 0 || MARKER_GLYPH_CHARSET.has(raw));
}

/** Silently reshapes a marker-glyph draft before the invalid-check: truncates multi-character
 *  paste/typeahead to its first character and uppercases it — the same transforms
 *  `sanitizeMarkerGlyph` applies, minus the charset check, so truncation/case-folding never
 *  flashes the field invalid on its own (see `TextInput`'s `normalize`/`isValid` split). An
 *  out-of-charset character passes through (uppercased) unchanged, so `isValidMarkerGlyph` alone
 *  can still catch it as invalid. */
export function normalizeMarkerGlyphInput(raw: string): string {
  if (raw.length === 0) return "";
  return raw[0].toUpperCase();
}
