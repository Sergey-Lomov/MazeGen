import { describe, expect, it } from "vitest";
import { withUnicodeCmap } from "../pixi/renderers/rasterFont/unicodeCmap";
import { readCmap } from "../pixi/renderers/rasterFont/kerning";
import { findTable, view } from "../pixi/renderers/rasterFont/sfnt";

/** A font file of only a `cmap` table with the given encoding records (GitHub issue #985). */
function fontWith(records: Array<{ platform: number; encoding: number; subtable: Uint8Array }>): Uint8Array {
  const headerSize = 4 + records.length * 8;
  const cmapLength = headerSize + records.reduce((sum, r) => sum + r.subtable.length, 0);
  const out = new Uint8Array(28 + cmapLength);
  const o = view(out);
  o.setUint32(0, 0x00010000);
  o.setUint16(4, 1);
  out.set([0x63, 0x6d, 0x61, 0x70], 12); // 'cmap'
  o.setUint32(20, 28);
  o.setUint32(24, cmapLength);
  o.setUint16(30, records.length);
  let cursor = headerSize;
  records.forEach((record, i) => {
    o.setUint16(32 + i * 8, record.platform);
    o.setUint16(34 + i * 8, record.encoding);
    o.setUint32(36 + i * 8, cursor);
    out.set(record.subtable, 28 + cursor);
    cursor += record.subtable.length;
  });
  return out;
}

/** Format 4 subtable mapping each `[code, glyph]` on its own segment. */
function format4(pairs: Array<[number, number]>): Uint8Array {
  const count = pairs.length + 1;
  const out = new Uint8Array(16 + count * 8);
  const o = view(out);
  o.setUint16(0, 4);
  o.setUint16(2, out.length);
  o.setUint16(6, count * 2);
  const ends = 14;
  const starts = ends + count * 2 + 2;
  const deltas = starts + count * 2;
  [...pairs, [0xffff, 0] as [number, number]].forEach(([code, glyph], i) => {
    o.setUint16(ends + i * 2, code);
    o.setUint16(starts + i * 2, code);
    o.setUint16(deltas + i * 2, code === 0xffff ? 1 : (glyph - code) & 0xffff);
  });
  return out;
}

/** Format 0 subtable: byte to glyph id. */
function format0(glyphs: Record<number, number>): Uint8Array {
  const out = new Uint8Array(262);
  view(out).setUint16(0, 0);
  view(out).setUint16(2, 262);
  for (const [byte, glyph] of Object.entries(glyphs)) out[6 + Number(byte)] = glyph;
  return out;
}

const lookup = (font: Uint8Array) => readCmap(view(font), findTable(view(font), "cmap")!);

describe("withUnicodeCmap", () => {
  it("maps the private-range characters of a symbol font to their plain Unicode characters", () => {
    const font = withUnicodeCmap(fontWith([{ platform: 3, encoding: 0, subtable: format4([[0xf046, 7], [0xf047, 8], [0xf061, 20]]) }]));
    const glyphOf = lookup(font);
    expect(glyphOf(0x46)).toBe(7);
    expect(glyphOf(0x47)).toBe(8);
    expect(glyphOf(0x61)).toBe(20);
    expect(glyphOf(0x48)).toBe(0);
  });

  it("maps a Mac Roman only font by its bytes", () => {
    const font = withUnicodeCmap(fontWith([{ platform: 1, encoding: 0, subtable: format0({ 0x46: 5, 0x20: 1 }) }]));
    const glyphOf = lookup(font);
    expect(glyphOf(0x46)).toBe(5);
    expect(glyphOf(0x20)).toBe(1);
    expect(glyphOf(0x47)).toBe(0);
  });

  it("prefers the symbol table over the Mac one when a font has both", () => {
    const font = withUnicodeCmap(fontWith([
      { platform: 1, encoding: 0, subtable: format0({ 0x46: 5 }) },
      { platform: 3, encoding: 0, subtable: format4([[0xf046, 9]]) },
    ]));
    expect(lookup(font)(0x46)).toBe(9);
  });

  it("reads glyph ids stored through idRangeOffset", () => {
    // Two segments: [F046..F047] reading its ids from the glyph array (7, 8), then the 0xFFFF terminator.
    const sub = new Uint8Array(16 + 2 * 8 + 4);
    const o = view(sub);
    o.setUint16(0, 4);
    o.setUint16(2, sub.length);
    o.setUint16(6, 4);
    o.setUint16(14, 0xf047); o.setUint16(16, 0xffff);
    o.setUint16(20, 0xf046); o.setUint16(22, 0xffff);
    o.setUint16(26, 1);
    o.setUint16(28, 4); o.setUint16(30, 0);
    o.setUint16(32, 7); o.setUint16(34, 8);
    const glyphOf = lookup(withUnicodeCmap(fontWith([{ platform: 3, encoding: 0, subtable: sub }])));
    expect(glyphOf(0x46)).toBe(7);
    expect(glyphOf(0x47)).toBe(8);
  });

  it("leaves a font that already has a Unicode cmap untouched", () => {
    const font = fontWith([{ platform: 3, encoding: 1, subtable: format4([[0x46, 3]]) }]);
    expect(withUnicodeCmap(font)).toBe(font);
    const other = fontWith([{ platform: 0, encoding: 3, subtable: format0({ 0x46: 3 }) }, { platform: 1, encoding: 0, subtable: format0({ 0x47: 4 }) }]);
    expect(withUnicodeCmap(other)).toBe(other);
  });

  it("leaves a font with nothing to build from, or without a cmap, untouched", () => {
    const empty = fontWith([{ platform: 1, encoding: 0, subtable: format0({}) }]);
    expect(withUnicodeCmap(empty)).toBe(empty);
    const noTables = new Uint8Array(12);
    view(noTables).setUint32(0, 0x00010000);
    expect(withUnicodeCmap(noTables)).toBe(noTables);
  });
});
