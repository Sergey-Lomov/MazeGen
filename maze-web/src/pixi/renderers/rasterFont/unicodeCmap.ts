import { findTable, view } from "./sfnt";

/** Gives a font that has no Unicode `cmap` one (GitHub issue #985). Old and decorative fonts (e.g. an old Windows
 *  display face) map their letters only in a Microsoft Symbol subtable (platform 3, encoding 0: "F" sits at U+F046)
 *  or a Mac Roman one (platform 1, encoding 0). A browser reads those for plain text; msdfgen (FreeType) looks
 *  glyphs up by Unicode, so it would draw nothing for most characters and Roboto would stand in for them. */

interface Subtable { platform: number; encoding: number; offset: number; format: number }

/** Any format counts: a font with a Unicode subtable of an unusual format is the browser's and msdfgen's to read. */
const hasUnicodeSubtable = (subtables: Subtable[]) => subtables.some(({ platform, encoding }) =>
  platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10)));

/** Code to glyph id of a format 4 subtable, glyph 0 (missing) left out. */
function readFormat4(v: DataView, base: number): Map<number, number> {
  const map = new Map<number, number>();
  const segCount = v.getUint16(base + 6) / 2;
  const endCodes = base + 14;
  const startCodes = endCodes + segCount * 2 + 2;
  const deltas = startCodes + segCount * 2;
  const rangeOffsets = deltas + segCount * 2;
  for (let i = 0; i < segCount; i++) {
    const start = v.getUint16(startCodes + i * 2);
    const end = v.getUint16(endCodes + i * 2);
    const delta = v.getUint16(deltas + i * 2);
    const rangeOffset = v.getUint16(rangeOffsets + i * 2);
    for (let code = start; code <= end && code < 0xffff; code++) {
      let glyph = code + delta;
      if (rangeOffset !== 0) {
        const at = rangeOffsets + i * 2 + rangeOffset + (code - start) * 2;
        if (at + 2 > v.byteLength) continue;
        glyph = v.getUint16(at);
        if (glyph === 0) continue;
        glyph += delta;
      }
      glyph &= 0xffff;
      if (glyph !== 0) map.set(code, glyph);
    }
  }
  return map;
}

/** Unicode character of one Mac Roman byte, `null` when the platform cannot decode it. */
function macRomanChar(byte: number): number | null {
  if (byte < 0x80) return byte;
  try {
    const text = new TextDecoder("macintosh").decode(new Uint8Array([byte]));
    return text.length === 1 && text !== "�" ? text.charCodeAt(0) : null;
  } catch {
    return null;
  }
}

/** Unicode to glyph id read from a Symbol or a Mac Roman subtable, empty when the font has neither. */
function legacyMapping(v: DataView, subtables: Subtable[]): Map<number, number> {
  const mapping = new Map<number, number>();
  const symbol = subtables.find((table) => table.platform === 3 && table.encoding === 0 && table.format === 4);
  if (symbol) {
    for (const [code, glyph] of readFormat4(v, symbol.offset)) {
      // A symbol font keeps its plain characters in the private range U+F000..U+F0FF.
      const character = code >= 0xf000 && code <= 0xf0ff ? code - 0xf000 : code;
      if (!mapping.has(character)) mapping.set(character, glyph);
    }
    if (mapping.size > 0) return mapping;
  }
  const mac = subtables.find((table) => table.platform === 1 && table.encoding === 0 && table.format === 0);
  if (mac) {
    for (let byte = 0; byte < 256; byte++) {
      const glyph = v.getUint8(mac.offset + 6 + byte);
      const character = glyph === 0 ? null : macRomanChar(byte);
      if (character !== null && !mapping.has(character)) mapping.set(character, glyph);
    }
  }
  return mapping;
}

/** A `cmap` table holding one format 4 subtable (Windows, Unicode BMP) for `mapping`. */
function buildCmap(mapping: Map<number, number>): Uint8Array {
  const codes = [...mapping.keys()].filter((code) => code < 0xffff).sort((a, b) => a - b);
  const segments: Array<{ start: number; end: number; delta: number }> = [];
  for (const code of codes) {
    const delta = (mapping.get(code)! - code) & 0xffff;
    const last = segments[segments.length - 1];
    if (last && last.end + 1 === code && last.delta === delta) last.end = code;
    else segments.push({ start: code, end: code, delta });
  }
  segments.push({ start: 0xffff, end: 0xffff, delta: 1 });
  const count = segments.length;
  const subtableLength = 16 + count * 8;
  const out = new Uint8Array(12 + subtableLength);
  const o = view(out);
  o.setUint16(2, 1); // one encoding record
  o.setUint16(4, 3); // Windows
  o.setUint16(6, 1); // Unicode BMP
  o.setUint32(8, 12);
  const base = 12;
  const entrySelector = Math.floor(Math.log2(count));
  const searchRange = 2 * 2 ** entrySelector;
  o.setUint16(base, 4);
  o.setUint16(base + 2, subtableLength);
  o.setUint16(base + 6, count * 2);
  o.setUint16(base + 8, searchRange);
  o.setUint16(base + 10, entrySelector);
  o.setUint16(base + 12, count * 2 - searchRange);
  const endCodes = base + 14;
  const startCodes = endCodes + count * 2 + 2;
  const deltas = startCodes + count * 2;
  segments.forEach((segment, i) => {
    o.setUint16(endCodes + i * 2, segment.end);
    o.setUint16(startCodes + i * 2, segment.start);
    o.setUint16(deltas + i * 2, segment.delta);
  });
  return out;
}

/** `sfnt` with a Unicode `cmap` built from its Symbol or Mac Roman one when it has none; the same bytes when it
 *  already has a Unicode one, has no `cmap`, or has nothing to build from. */
export function withUnicodeCmap(sfnt: Uint8Array): Uint8Array {
  try {
    const v = view(sfnt);
    const cmap = findTable(v, "cmap");
    if (!cmap) return sfnt;
    const count = v.getUint16(cmap.offset + 2);
    const subtables: Subtable[] = [];
    for (let i = 0; i < count; i++) {
      const at = cmap.offset + 4 + i * 8;
      const offset = cmap.offset + v.getUint32(at + 4);
      subtables.push({ platform: v.getUint16(at), encoding: v.getUint16(at + 2), offset, format: v.getUint16(offset) });
    }
    if (hasUnicodeSubtable(subtables)) return sfnt;
    const mapping = legacyMapping(v, subtables);
    if (mapping.size === 0) return sfnt;
    const table = buildCmap(mapping);
    const start = (sfnt.length + 3) & ~3;
    const out = new Uint8Array(start + table.length);
    out.set(sfnt);
    out.set(table, start);
    const o = view(out);
    for (let i = 0; i < v.getUint16(4); i++) {
      const at = 12 + i * 16;
      if (String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3)) !== "cmap") continue;
      o.setUint32(at + 8, start);
      o.setUint32(at + 12, table.length);
    }
    return out;
  } catch {
    return sfnt;
  }
}
