import { describe, expect, it } from "vitest";
import { readKerning } from "../pixi/renderers/rasterFont/kerning";

/** Minimal hand-built sfnt files: only the tables the kerning reader looks at. */
function writer() {
  const bytes: number[] = [];
  const api = {
    u16: (...values: number[]) => { for (const v of values) bytes.push((v >> 8) & 0xff, v & 0xff); return api; },
    u32: (...values: number[]) => { for (const v of values) bytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff); return api; },
    done: () => Uint8Array.from(bytes),
  };
  return api;
}

function sfnt(tables: Record<string, Uint8Array>): Uint8Array {
  const tags = Object.keys(tables);
  const head = writer().u32(0x00010000).u16(tags.length, 0, 0, 0);
  let offset = 12 + tags.length * 16;
  const body: number[] = [];
  const out = [...head.done()];
  for (const tag of tags) {
    for (const c of tag) out.push(c.charCodeAt(0));
    out.push(...writer().u32(0, offset, tables[tag].length).done());
    body.push(...tables[tag]);
    offset += tables[tag].length;
  }
  return Uint8Array.from([...out, ...body]);
}

const headTable = (unitsPerEm: number) => { const t = new Uint8Array(54); t[18] = unitsPerEm >> 8; t[19] = unitsPerEm & 0xff; return t; };

/** `cmap` format 4 mapping 'A'..'V' to glyphs 1..22. */
const cmap4 = () => writer()
  .u16(0, 1, 3, 1).u32(12)
  .u16(4, 32, 0, 4, 4, 1, 0, 0x56, 0xffff, 0, 0x41, 0xffff, (1 - 0x41) & 0xffff, 1, 0, 0)
  .done();

/** `cmap` format 12 mapping 'A'..'Z' to glyphs 1..26. */
const cmap12 = () => writer()
  .u16(0, 1, 3, 10).u32(12)
  .u16(12, 0).u32(28, 0, 1, 0x41, 0x5a, 1)
  .done();

/** Legacy `kern` table, one format 0 subtable. */
const kern = (pairs: [number, number, number][], coverage = 0x0001) => {
  const w = writer().u16(0, 1, 0, 14 + pairs.length * 6, coverage, pairs.length, 0, 0, 0);
  for (const [left, right, value] of pairs) w.u16(left, right, value & 0xffff);
  return w.done();
};

describe("readKerning on hand-built fonts", () => {
  it("reads a legacy kern table through a format 4 cmap, scaled by units per em", () => {
    const font = sfnt({ head: headTable(1000), cmap: cmap4(), kern: kern([[1, 22, -100]]) });
    const kerning = readKerning(font)!;
    expect(kerning.pair(0x41, 0x56)).toBeCloseTo(-0.1, 6); // A V
    expect(kerning.pair(0x56, 0x41)).toBe(0); // order matters
    expect(kerning.pair(0x41, 0x42)).toBe(0); // no such pair
  });

  it("maps characters through a format 12 cmap", () => {
    const font = sfnt({ head: headTable(2000), cmap: cmap12(), kern: kern([[1, 26, -50]]) });
    expect(readKerning(font)!.pair(0x41, 0x5a)).toBeCloseTo(-0.025, 6);
  });

  it("gives no kerning for characters outside the cmap", () => {
    const font = sfnt({ head: headTable(1000), cmap: cmap4(), kern: kern([[1, 22, -100]]) });
    expect(readKerning(font)!.pair(0x41, 0x1f600)).toBe(0);
    expect(readKerning(font)!.pair(0x41, 0x7a)).toBe(0);
  });

  it("ignores a kern subtable that is vertical or minimum-only", () => {
    const vertical = sfnt({ head: headTable(1000), cmap: cmap4(), kern: kern([[1, 22, -100]], 0x0000) });
    expect(readKerning(vertical)).toBeNull();
  });

  it("is null without a cmap, a head table or any pair data", () => {
    expect(readKerning(sfnt({ head: headTable(1000), kern: kern([[1, 22, -100]]) }))).toBeNull();
    expect(readKerning(sfnt({ cmap: cmap4(), kern: kern([[1, 22, -100]]) }))).toBeNull();
    expect(readKerning(sfnt({ head: headTable(1000), cmap: cmap4() }))).toBeNull();
    expect(readKerning(sfnt({ head: headTable(0), cmap: cmap4(), kern: kern([[1, 22, -100]]) }))).toBeNull();
  });

  it("does not throw on a truncated table", () => {
    const font = sfnt({ head: headTable(1000), cmap: cmap4().slice(0, 10), kern: kern([[1, 22, -100]]) });
    expect(() => readKerning(font)?.pair(0x41, 0x56)).not.toThrow();
  });
});
