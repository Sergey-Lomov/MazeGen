import { findTable, view } from "./sfnt";

/** Pair kerning of an sfnt font (GitHub issue #966): how far the second character of a pair moves toward
 *  the first one, e.g. "AV" or "To". The browser applies it to canvas text; an MSDF atlas must carry it too,
 *  or the same label would change width when the atlas replaces the canvas text. Reads the OpenType `GPOS`
 *  `kern` feature (pair adjustment lookups) and, for fonts without one, the legacy `kern` table. */

export interface Kerning {
  /** Horizontal adjustment between characters `first` and `second`, in em units (negative = closer). */
  pair(first: number, second: number): number;
}

type Table = { offset: number; length: number };

// --- cmap ---------------------------------------------------------------------------------------

/** Code point to glyph id, from the best Unicode subtable of `cmap` (format 12, else format 4). */
function readCmap(v: DataView, cmap: Table): (codepoint: number) => number {
  const count = v.getUint16(cmap.offset + 2);
  let best: { offset: number; rank: number } | null = null;
  for (let i = 0; i < count; i++) {
    const at = cmap.offset + 4 + i * 8;
    const platform = v.getUint16(at);
    const encoding = v.getUint16(at + 2);
    const offset = cmap.offset + v.getUint32(at + 4);
    const format = v.getUint16(offset);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode || (format !== 4 && format !== 12)) continue;
    const rank = format === 12 ? 2 : 1;
    if (!best || rank > best.rank) best = { offset, rank };
  }
  if (!best) return () => 0;
  const base = best.offset;
  if (best.rank === 2) {
    const groups = v.getUint32(base + 12);
    return (cp) => {
      let lo = 0;
      let hi = groups - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const at = base + 16 + mid * 12;
        const start = v.getUint32(at);
        const end = v.getUint32(at + 4);
        if (cp < start) hi = mid - 1;
        else if (cp > end) lo = mid + 1;
        else return v.getUint32(at + 8) + (cp - start);
      }
      return 0;
    };
  }
  const segCount = v.getUint16(base + 6) / 2;
  const endCodes = base + 14;
  const startCodes = endCodes + segCount * 2 + 2;
  const deltas = startCodes + segCount * 2;
  const rangeOffsets = deltas + segCount * 2;
  return (cp) => {
    if (cp > 0xffff) return 0;
    for (let i = 0; i < segCount; i++) {
      if (cp > v.getUint16(endCodes + i * 2)) continue;
      const start = v.getUint16(startCodes + i * 2);
      if (cp < start) return 0;
      const rangeOffset = v.getUint16(rangeOffsets + i * 2);
      if (rangeOffset === 0) return (cp + v.getInt16(deltas + i * 2)) & 0xffff;
      const glyphAt = rangeOffsets + i * 2 + rangeOffset + (cp - start) * 2;
      if (glyphAt + 2 > v.byteLength) return 0;
      const glyph = v.getUint16(glyphAt);
      return glyph === 0 ? 0 : (glyph + v.getInt16(deltas + i * 2)) & 0xffff;
    }
    return 0;
  };
}

// --- GPOS ---------------------------------------------------------------------------------------

/** Index of `glyph` in a Coverage table at `at`, or -1. */
function coverageIndex(v: DataView, at: number, glyph: number): number {
  const format = v.getUint16(at);
  const count = v.getUint16(at + 2);
  if (format === 1) {
    let lo = 0;
    let hi = count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const value = v.getUint16(at + 4 + mid * 2);
      if (glyph < value) hi = mid - 1;
      else if (glyph > value) lo = mid + 1;
      else return mid;
    }
    return -1;
  }
  let lo = 0;
  let hi = count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const record = at + 4 + mid * 6;
    const start = v.getUint16(record);
    const end = v.getUint16(record + 2);
    if (glyph < start) hi = mid - 1;
    else if (glyph > end) lo = mid + 1;
    else return v.getUint16(record + 4) + (glyph - start);
  }
  return -1;
}

/** Class of `glyph` in a ClassDef table at `at` (0 when unlisted). */
function glyphClass(v: DataView, at: number, glyph: number): number {
  const format = v.getUint16(at);
  if (format === 1) {
    const start = v.getUint16(at + 2);
    const count = v.getUint16(at + 4);
    return glyph >= start && glyph < start + count ? v.getUint16(at + 6 + (glyph - start) * 2) : 0;
  }
  const count = v.getUint16(at + 2);
  let lo = 0;
  let hi = count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const record = at + 4 + mid * 6;
    const start = v.getUint16(record);
    const end = v.getUint16(record + 2);
    if (glyph < start) hi = mid - 1;
    else if (glyph > end) lo = mid + 1;
    else return v.getUint16(record + 4);
  }
  return 0;
}

const popcount = (n: number) => { let c = 0; for (; n; n &= n - 1) c++; return c; };

/** Size in bytes of a ValueRecord with `format`, and the offset of its XAdvance field (`-1` when absent). */
function valueLayout(format: number): { size: number; xAdvanceAt: number } {
  return { size: popcount(format & 0xff) * 2, xAdvanceAt: format & 0x4 ? popcount(format & 0x3) * 2 : -1 };
}

/** XAdvance adjustment a PairPos subtable gives the pair, `null` when the subtable does not cover it. */
function pairAdjustment(v: DataView, at: number, first: number, second: number): number | null {
  const format = v.getUint16(at);
  const coverage = coverageIndex(v, at + v.getUint16(at + 2), first);
  if (coverage < 0) return null;
  const vf1 = v.getUint16(at + 4);
  const vf2 = v.getUint16(at + 6);
  const one = valueLayout(vf1);
  const two = valueLayout(vf2);
  const read = (record: number) => (one.xAdvanceAt < 0 ? 0 : v.getInt16(record + one.xAdvanceAt));
  if (format === 1) {
    const set = at + v.getUint16(at + 10 + coverage * 2);
    const count = v.getUint16(set);
    const stride = 2 + one.size + two.size;
    let lo = 0;
    let hi = count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const record = set + 2 + mid * stride;
      const glyph = v.getUint16(record);
      if (second < glyph) hi = mid - 1;
      else if (second > glyph) lo = mid + 1;
      else return read(record + 2);
    }
    return null;
  }
  if (format === 2) {
    const class1 = glyphClass(v, at + v.getUint16(at + 8), first);
    const class2 = glyphClass(v, at + v.getUint16(at + 10), second);
    const class2Count = v.getUint16(at + 14);
    const stride = one.size + two.size;
    return read(at + 16 + (class1 * class2Count + class2) * stride);
  }
  return null;
}

/** The PairPos subtables of every lookup a `kern` feature names, grouped by lookup (they apply in order). */
function gposKernLookups(v: DataView, gpos: Table): number[][] {
  const featureList = gpos.offset + v.getUint16(gpos.offset + 6);
  const lookupList = gpos.offset + v.getUint16(gpos.offset + 8);
  const lookups = new Set<number>();
  const featureCount = v.getUint16(featureList);
  for (let i = 0; i < featureCount; i++) {
    const record = featureList + 2 + i * 6;
    const tag = String.fromCharCode(v.getUint8(record), v.getUint8(record + 1), v.getUint8(record + 2), v.getUint8(record + 3));
    if (tag !== "kern") continue;
    const feature = featureList + v.getUint16(record + 4);
    const count = v.getUint16(feature + 2);
    for (let j = 0; j < count; j++) lookups.add(v.getUint16(feature + 4 + j * 2));
  }
  const result: number[][] = [];
  for (const index of [...lookups].sort((a, b) => a - b)) {
    const lookup = lookupList + v.getUint16(lookupList + 2 + index * 2);
    const type = v.getUint16(lookup);
    const subtableCount = v.getUint16(lookup + 4);
    const subtables: number[] = [];
    for (let k = 0; k < subtableCount; k++) {
      let at = lookup + v.getUint16(lookup + 6 + k * 2);
      if (type === 9) {
        if (v.getUint16(at + 2) !== 2) continue;
        at += v.getUint32(at + 4);
      } else if (type !== 2) continue;
      subtables.push(at);
    }
    if (subtables.length > 0) result.push(subtables);
  }
  return result;
}

// --- kern ---------------------------------------------------------------------------------------

/** Pairs of the legacy `kern` table (format 0 horizontal subtables), keyed `left << 16 | right`. */
function readKernTable(v: DataView, kern: Table): Map<number, number> {
  const pairs = new Map<number, number>();
  const count = v.getUint16(kern.offset + 2);
  let at = kern.offset + 4;
  for (let i = 0; i < count && at + 6 <= v.byteLength; i++) {
    const length = v.getUint16(at + 2);
    const coverage = v.getUint16(at + 4);
    if (coverage >> 8 === 0 && coverage & 0x1 && !(coverage & 0x4)) {
      const pairCount = v.getUint16(at + 6);
      for (let p = 0; p < pairCount; p++) {
        const record = at + 14 + p * 6;
        if (record + 6 > v.byteLength) break;
        const key = (v.getUint16(record) << 16 | v.getUint16(record + 2)) >>> 0;
        pairs.set(key, (pairs.get(key) ?? 0) + v.getInt16(record + 4));
      }
    }
    at += Math.max(length, 6);
  }
  return pairs;
}

/** The pair kerning of `sfnt`, or `null` when the font has none (or is not readable). Results are cached per
 *  pair, since an atlas asks for every pair of its characters. */
export function readKerning(sfnt: Uint8Array): Kerning | null {
  try {
    const v = view(sfnt);
    const head = findTable(v, "head");
    const cmapTable = findTable(v, "cmap");
    if (!head || !cmapTable) return null;
    const unitsPerEm = v.getUint16(head.offset + 18);
    if (unitsPerEm === 0) return null;
    const glyphOf = readCmap(v, cmapTable);
    const glyphs = new Map<number, number>();
    const glyph = (cp: number) => {
      let id = glyphs.get(cp);
      if (id === undefined) glyphs.set(cp, (id = glyphOf(cp)));
      return id;
    };
    const gpos = findTable(v, "GPOS");
    const lookups = gpos ? gposKernLookups(v, gpos) : [];
    const kernTable = lookups.length === 0 ? findTable(v, "kern") : null;
    const kernPairs = kernTable ? readKernTable(v, kernTable) : null;
    if (lookups.length === 0 && (!kernPairs || kernPairs.size === 0)) return null;
    const cache = new Map<number, number>();
    return {
      pair(first, second) {
        const left = glyph(first);
        const right = glyph(second);
        if (left === 0 || right === 0) return 0;
        const key = left * 65536 + right;
        let units = cache.get(key);
        if (units === undefined) {
          units = 0;
          if (kernPairs) units = kernPairs.get((left << 16 | right) >>> 0) ?? 0;
          else {
            for (const subtables of lookups) {
              for (const subtable of subtables) {
                const value = pairAdjustment(v, subtable, left, right);
                if (value !== null) { units += value; break; }
              }
            }
          }
          cache.set(key, units);
        }
        return units / unitsPerEm;
      },
    };
  } catch {
    return null;
  }
}
