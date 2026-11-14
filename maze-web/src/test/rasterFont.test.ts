import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { resolve } from "node:path";
import { Cache, Texture } from "pixi.js";
import { createMsdfEngine, type GlyphBitmap, type MsdfEngine } from "../pixi/renderers/rasterFont/msdfEngine";
import { readKerning } from "../pixi/renderers/rasterFont/kerning";
import { FontFileFailure, readFontInfo, toSfnt } from "../pixi/renderers/rasterFont/sfnt";
import { ATLAS_PAGE_SIZE, DynamicMsdfFont, MAX_ATLAS_PAGES } from "../pixi/renderers/rasterFont/dynamicMsdfFont";
import { hasRasterFace, msdfFace } from "../pixi/renderers/fontChoice";
import {
  MAX_IDLE_RASTER_FONTS, isRasterFontReady, loadRasterFont, pruneRasterFonts, rasterCoversText, rasterFontCount,
} from "../pixi/renderers/rasterFont/rasterMsdf";
import {
  addUploadedFont, knownRasterWeights, registerLocalFaces, removeUploadedFont, uploadedFamilies,
} from "../pixi/renderers/rasterFont/rasterFontStore";
import { disposeRasterFamily } from "../pixi/renderers/rasterFont/rasterMsdf";
import { currentCharset } from "../pixi/renderers/rasterFont/glyphCharset";

const fontBytes = (name: string) => new Uint8Array(readFileSync(resolve(__dirname, "../../tools/msdf", name)));
const ROBOTO_REGULAR = fontBytes("Roboto-Regular.ttf");
const ROBOTO_BOLD = fontBytes("Roboto-Bold.ttf");
const asBlob = (bytes: Uint8Array) => new Blob([bytes as BlobPart]);

let engine: MsdfEngine;
beforeAll(async () => { engine = await createMsdfEngine(); });

describe("sfnt reading", () => {
  it("reads the family, weight and line metrics of a TTF", () => {
    const regular = readFontInfo(ROBOTO_REGULAR)!;
    expect(regular).toMatchObject({ family: "Roboto", weight: 400, italic: false });
    expect(regular.ascender).toBeGreaterThan(0.5);
    expect(regular.descender).toBeLessThan(0);
    expect(readFontInfo(ROBOTO_BOLD)).toMatchObject({ family: "Roboto", weight: 700 });
  });

  it("reads the same font out of a WOFF wrapper", async () => {
    const woff = toWoff(ROBOTO_BOLD);
    const sfnt = await toSfnt(woff);
    expect(readFontInfo(sfnt)).toMatchObject({ family: "Roboto", weight: 700 });
  });

  it("refuses WOFF2, font collections and arbitrary data", async () => {
    await expect(toSfnt(Uint8Array.from([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).rejects.toMatchObject({ reason: "unsupported-format" });
    await expect(toSfnt(Uint8Array.from([0x74, 0x74, 0x63, 0x66, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).rejects.toBeInstanceOf(FontFileFailure);
    await expect(toSfnt(new Uint8Array(40))).rejects.toMatchObject({ reason: "unsupported-format" });
    await expect(toSfnt(new Uint8Array(4))).rejects.toMatchObject({ reason: "corrupt" });
    expect(readFontInfo(new Uint8Array(64))).toBeNull();
  });
});

/** Wraps a TTF's tables into a WOFF 1.0 file (each table zlib-compressed). */
function toWoff(ttf: Uint8Array): Uint8Array {
  const v = new DataView(ttf.buffer, ttf.byteOffset, ttf.byteLength);
  const count = v.getUint16(4);
  const tables = Array.from({ length: count }, (_, i) => {
    const at = 12 + i * 16;
    const offset = v.getUint32(at + 8);
    const length = v.getUint32(at + 12);
    const raw = ttf.subarray(offset, offset + length);
    return { tag: v.getUint32(at), checksum: v.getUint32(at + 4), raw, packed: new Uint8Array(deflateSync(raw)) };
  });
  const headerSize = 44 + count * 20;
  const total = tables.reduce((sum, t) => sum + ((t.packed.length + 3) & ~3), headerSize);
  const out = new Uint8Array(total);
  const o = new DataView(out.buffer);
  o.setUint32(0, 0x774f4646);
  o.setUint32(4, v.getUint32(0));
  o.setUint32(8, total);
  o.setUint16(12, count);
  let cursor = headerSize;
  tables.forEach((t, i) => {
    const at = 44 + i * 20;
    o.setUint32(at, t.tag);
    o.setUint32(at + 4, cursor);
    o.setUint32(at + 8, t.packed.length);
    o.setUint32(at + 12, t.raw.length);
    o.setUint32(at + 16, t.checksum);
    out.set(t.packed, cursor);
    cursor += (t.packed.length + 3) & ~3;
  });
  return out;
}

describe("kerning reading", () => {
  it("reads Roboto's pair kerning in em units", () => {
    const kerning = readKerning(ROBOTO_REGULAR)!;
    expect(kerning).not.toBeNull();
    expect(kerning.pair(0x41, 0x56)).toBeLessThan(-0.02); // "AV" tucks in
    expect(kerning.pair(0x54, 0x6f)).toBeLessThan(-0.02); // "To"
    expect(kerning.pair(0x6c, 0x6c)).toBe(0); // "ll" has no pair
    expect(kerning.pair(0x4e2d, 0x41)).toBe(0); // a character the font lacks
  });

  it("is null for a font without a pair table", () => {
    expect(readKerning(new Uint8Array(40))).toBeNull();
  });
});

describe("MSDF engine", () => {
  it("crops a glyph to its ink plus padding, top-down, with em-based placement", () => {
    expect(engine.load("roboto", ROBOTO_REGULAR)).toBe(true);
    const [a] = engine.generate("roboto", [0x41]);
    expect(a).not.toBeNull();
    const glyph = a as GlyphBitmap;
    // 'A' is about 0.63 em wide and 0.71 em tall; at 54 px/em plus 4 px padding on each side.
    expect(glyph.width).toBeGreaterThan(36);
    expect(glyph.width).toBeLessThan(50);
    expect(glyph.height).toBeGreaterThan(40);
    expect(glyph.height).toBeLessThan(54);
    expect(glyph.rgba.length).toBe(glyph.width * glyph.height * 4);
    expect(glyph.advance).toBeCloseTo(0.652, 2);
    // The quad starts just left of the pen and rises above the baseline.
    expect(glyph.left).toBeLessThan(0.05);
    expect(glyph.top).toBeGreaterThan(0.7);
    // The stem of the letter is inside the field at the middle of its bottom row (top-down: last row).
    const median = (i: number) => Math.max(Math.min(glyph.rgba[i], glyph.rgba[i + 1]), Math.min(Math.max(glyph.rgba[i], glyph.rgba[i + 1]), glyph.rgba[i + 2]));
    // The padding row above the ink is outside the shape.
    const topRow = median(Math.floor(glyph.width / 2) * 4);
    const bottomLeftInk = median(((glyph.height - 6) * glyph.width + 8) * 4);
    expect(topRow).toBeLessThan(128);
    expect(bottomLeftInk).toBeGreaterThan(127);
  });

  it("gives a space an advance and no bitmap, and null for a glyph the font lacks", () => {
    engine.load("roboto", ROBOTO_REGULAR);
    const [space, han] = engine.generate("roboto", [0x20, 0x4e2d]);
    expect(space).toMatchObject({ width: 0, height: 0 });
    expect(space!.advance).toBeGreaterThan(0.2);
    expect(han).toBeNull();
  });

  it("rejects bytes that are not a font", () => {
    expect(engine.load("junk", new Uint8Array(100))).toBe(false);
    expect(engine.generate("junk", [0x41])).toEqual([null]);
  });
});

describe("DynamicMsdfFont", () => {
  const metrics = { ascender: 0.9, descender: -0.25, lineGap: 0.05 };
  const glyph = (codepoint: number, width: number, height: number): GlyphBitmap => ({
    codepoint, width, height, rgba: new Uint8ClampedArray(width * height * 4).fill(200), advance: 0.5, left: 0.05, top: 0.6,
  });
  const fonts: DynamicMsdfFont[] = [];
  const make = (name: string, fallback: ConstructorParameters<typeof DynamicMsdfFont>[2] = () => undefined, kerning: ConstructorParameters<typeof DynamicMsdfFont>[3] = null) => {
    const font = new DynamicMsdfFont(name, metrics, fallback, kerning);
    fonts.push(font);
    return font;
  };
  afterEach(() => { for (const font of fonts.splice(0)) font.destroy(); });

  it("installs under its name and lays glyphs out on the font's baseline", () => {
    const font = make("raster:test:400");
    const report = font.insert([0x41], [glyph(0x41, 40, 50)]);
    expect(report.added).toEqual(["A"]);
    expect(Cache.has("raster:test:400-bitmap")).toBe(true);
    const a = font.font.chars["A"]!;
    // Baseline = (ascender + gap / 2) em; the quad top sits `top` em above it.
    expect(a.yOffset).toBeCloseTo((0.9 + 0.025) * 54 - 0.6 * 54, 5);
    expect(a.xOffset).toBeCloseTo(0.05 * 54, 5);
    expect(a.xAdvance).toBeCloseTo(27, 5);
    expect(a.texture!.orig.width).toBe(40);
    expect(font.font.lineHeight).toBe(Math.round((0.9 + 0.25 + 0.05) * 54));
    expect(font.font.distanceField).toEqual({ type: "msdf", range: 8 });
  });

  it("shares one page between glyphs and writes their pixels at the frame", () => {
    const font = make("raster:test:pack");
    font.insert([0x41, 0x42], [glyph(0x41, 20, 20), glyph(0x42, 20, 20)]);
    expect(font.pageCount).toBe(1);
    const [a, b] = [font.font.chars["A"]!.texture!, font.font.chars["B"]!.texture!];
    expect(a.source).toBe(b.source);
    expect(b.frame.x).toBeGreaterThan(a.frame.x);
    const data = (a.source as unknown as { resource: Uint8Array }).resource;
    expect(data[(a.frame.y * ATLAS_PAGE_SIZE + a.frame.x) * 4]).toBe(200);
  });

  it("grows by pages, then stops at the page limit and draws the fallback instead", () => {
    const fallbackChar = { id: 0x5a, xOffset: 1, yOffset: 20, xAdvance: 30, kerning: {}, texture: new Texture({ source: new Texture().source }) };
    const fallback = { chars: { Z: fallbackChar }, lineHeight: 71, baseLineOffset: 14 } as never;
    const font = make("raster:test:pages", () => fallback);
    // Each glyph fills a quarter of a page, so MAX_ATLAS_PAGES * 4 fit and the next one overflows.
    const side = ATLAS_PAGE_SIZE / 2 - 1;
    const total = MAX_ATLAS_PAGES * 4 + 1;
    const codepoints = Array.from({ length: total - 1 }, (_, i) => 0x4e00 + i);
    const glyphs = codepoints.map((cp) => ({ ...glyph(cp, 4, 4), width: side, height: side, rgba: new Uint8ClampedArray(side * side * 4) }));
    const report = font.insert([...codepoints, 0x5a], [...glyphs, { ...glyph(0x5a, side, side), rgba: new Uint8ClampedArray(side * side * 4) }]);
    expect(font.pageCount).toBe(MAX_ATLAS_PAGES);
    expect(report.added.length).toBe(MAX_ATLAS_PAGES * 4);
    expect(report.overflowed).toEqual(["Z"]);
    // The overflowed character is drawn from the fallback, re-based onto this font's baseline.
    const z = font.font.chars["Z"];
    expect(z.xAdvance).toBe(30);
    expect(z.yOffset).toBeCloseTo(20 - (71 - 14) + (0.9 + 0.025) * 54, 5);
    expect(z.texture).not.toBe(fallbackChar.texture);
  });

  it("reports glyphs the font lacks and borrows the fallback's, leaving the fallback's texture alone", () => {
    const source = new Texture().source;
    const fallbackChar = { id: 0x416, xOffset: 0, yOffset: 15, xAdvance: 40, kerning: {}, texture: new Texture({ source }) };
    const font = make("raster:test:lack", () => ({ chars: { "Ж": fallbackChar }, lineHeight: 71, baseLineOffset: 14 } as never));
    const report = font.insert([0x416, 0x4e2d], [null, null]);
    expect(report.lacking).toEqual(["Ж", "中"]);
    expect(font.has("Ж")).toBe(true);
    expect(font.has("中")).toBe(false);
    font.destroy();
    expect(fallbackChar.texture.destroyed).toBe(false);
  });

  it("stores a pair's kerning on the second character keyed by the first, in atlas pixels", () => {
    const font = make("raster:test:kern", () => undefined, { pair: (a, b) => (a === 0x41 && b === 0x56 ? -0.1 : 0) });
    font.insert([0x41], [glyph(0x41, 10, 10)]);
    font.insert([0x56], [glyph(0x56, 10, 10)]); // arrives later: the pair still forms
    expect(font.font.chars["V"]!.kerning["A"]).toBeCloseTo(-5.4, 5);
    expect(font.font.chars["A"]!.kerning["V"]).toBeUndefined();
  });

  it("does not kern a character drawn from the fallback", () => {
    const fallbackChar = { id: 0x56, xOffset: 0, yOffset: 15, xAdvance: 40, kerning: {}, texture: new Texture({ source: new Texture().source }) };
    const font = make("raster:test:kernFallback", () => ({ chars: { V: fallbackChar }, lineHeight: 71, baseLineOffset: 14 } as never), { pair: () => -0.1 });
    font.insert([0x41, 0x56], [glyph(0x41, 10, 10), null]);
    expect(font.font.chars["V"]!.kerning).toEqual({});
    expect(font.font.chars["A"]!.kerning["V"]).toBeUndefined();
  });

  it("frees its pages and uninstalls on destroy", () => {
    const font = make("raster:test:destroy");
    font.insert([0x41], [glyph(0x41, 10, 10)]);
    const source = font.font.chars["A"]!.texture!.source;
    font.destroy();
    expect(Cache.has("raster:test:destroy-bitmap")).toBe(false);
    expect(source.destroyed).toBe(true);
    expect(() => font.destroy()).not.toThrow();
  });
});

describe("raster font pipeline", () => {
  const family = "Roboto";

  afterEach(async () => {
    pruneRasterFonts(new Set());
    for (const name of uploadedFamilies()) { disposeRasterFamily(name); await removeUploadedFont(name); }
    registerLocalFaces([]);
    // Idle atlases survive pruning up to the cap; dispose them explicitly.
    disposeRasterFamily(family);
  });

  const upload = async (bytes: Uint8Array) => {
    const result = await addUploadedFont(asBlob(bytes));
    expect(result.ok).toBe(true);
  };

  it("offers exactly the uploaded weights and builds a shared atlas for a picked one", async () => {
    await upload(ROBOTO_REGULAR);
    await upload(ROBOTO_BOLD);
    expect(knownRasterWeights(family)).toEqual([400, 700]);

    expect(hasRasterFace({ family, weight: 400 })).toBe(false);
    await expect(loadRasterFont({ family, weight: 400 })).resolves.toBe(true);
    expect(isRasterFontReady({ family, weight: 400 })).toBe(true);

    // Labels of this family and weight resolve to one atlas, which the pixi cache serves.
    const face = msdfFace({ family, weight: 400 });
    expect(face.atlasName).toBe("raster:Roboto:400");
    expect(Cache.has(`${face.atlasName}-bitmap`)).toBe(true);
    expect(msdfFace({ family, weight: 400 })).toBe(face);
    expect(rasterFontCount()).toBe(1);
    // The whole declared charset is in the atlas (Roboto draws Latin and Cyrillic).
    const atlas = Cache.get(`${face.atlasName}-bitmap`);
    for (const point of currentCharset().codepoints) expect(atlas.chars[String.fromCodePoint(point)]).toBeDefined();
  }, 30_000);

  it("maps a weight the font lacks to its nearest face and keeps one atlas", async () => {
    await upload(ROBOTO_REGULAR);
    await loadRasterFont({ family, weight: 400 });
    await expect(loadRasterFont({ family, weight: 500 })).resolves.toBe(true);
    expect(msdfFace({ family, weight: 500 }).atlasName).toBe("raster:Roboto:400");
    expect(rasterFontCount()).toBe(1);
  }, 30_000);

  it("adds a glyph outside the declared charset on demand and redraws once it lands", async () => {
    await upload(ROBOTO_REGULAR);
    await loadRasterFont({ family, weight: 400 });
    const font = { family, weight: 400 };
    const atlas = Cache.get(`${msdfFace(font).atlasName}-bitmap`);
    expect(atlas.chars["Ω"]).toBeUndefined();
    const landed = new Promise<void>((done) => window.addEventListener("mazegen:label-font-loaded", () => done(), { once: true }));
    // Not covered yet: the caller keeps its canvas text instead of dropping the character.
    expect(rasterCoversText(font, "ΩΩ A")).toBe(false);
    await landed;
    expect(atlas.chars["Ω"]).toBeDefined();
    expect(rasterCoversText(font, "ΩΩ A")).toBe(true);
  }, 30_000);

  it("counts a character the font cannot draw as covered, since Roboto draws it", async () => {
    await upload(ROBOTO_REGULAR);
    await loadRasterFont({ family, weight: 400 });
    const font = { family, weight: 400 };
    const settled = new Promise<void>((done) => window.addEventListener("mazegen:label-font-loaded", () => done(), { once: true }));
    expect(rasterCoversText(font, "中")).toBe(false);
    await settled;
    expect(rasterCoversText(font, "中")).toBe(true);
  }, 30_000);

  it("is not covered, and builds nothing, for a font without an atlas", () => {
    expect(rasterCoversText({ family: "Nowhere", weight: 400 }, "A")).toBe(false);
    expect(rasterFontCount()).toBe(0);
  });

  it("does not build a font that has no readable file", async () => {
    await expect(loadRasterFont({ family: "Nowhere", weight: 400 })).resolves.toBe(false);
    expect(msdfFace({ family: "Nowhere", weight: 400 }).atlasName).toBe("Roboto-Regular");
  });

  it("does not build an installed font whose file is not a font", async () => {
    registerLocalFaces([{ family: "Broken", style: "Regular", blob: () => Promise.resolve(asBlob(new Uint8Array(200))) }]);
    await expect(loadRasterFont({ family: "Broken", weight: 400 })).resolves.toBe(false);
    expect(isRasterFontReady({ family: "Broken", weight: 400 })).toBe(false);
  });

  it("frees an atlas whose uploaded file was replaced", async () => {
    await upload(ROBOTO_REGULAR);
    await loadRasterFont({ family, weight: 400 });
    expect(hasRasterFace({ family, weight: 400 })).toBe(true);
    const changed = ROBOTO_REGULAR.slice();
    const at = Math.floor((changed.length - 1) / 7) * 7;
    changed[at] ^= 0xff;
    await upload(changed);
    expect(hasRasterFace({ family, weight: 400 })).toBe(false);
    expect(rasterFontCount()).toBe(0);
  }, 30_000);

  it("reuses a built atlas and starts no second build for the same font", async () => {
    await upload(ROBOTO_REGULAR);
    const first = loadRasterFont({ family, weight: 400 });
    const second = loadRasterFont({ family, weight: 400 });
    expect(second).toBe(first);
    await first;
    await expect(loadRasterFont({ family, weight: 400 })).resolves.toBe(true);
    expect(rasterFontCount()).toBe(1);
  }, 30_000);

  it("builds an installed font from the file the machine reports", async () => {
    registerLocalFaces([{ family: "Installed Roboto", style: "Regular", blob: () => Promise.resolve(asBlob(ROBOTO_REGULAR)) }]);
    // The family name comes from the machine's list, not from the file.
    await expect(loadRasterFont({ family: "Installed Roboto", weight: 400 })).resolves.toBe(true);
    expect(msdfFace({ family: "Installed Roboto", weight: 400 }).atlasName).toBe("raster:Installed Roboto:400");
    disposeRasterFamily("Installed Roboto");
  }, 30_000);

  it("rejects an upload that is not a usable font", async () => {
    await expect(addUploadedFont(asBlob(new Uint8Array(100)))).resolves.toEqual({ ok: false, reason: "unsupported-format" });
    await expect(addUploadedFont(asBlob(Uint8Array.from([0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])))).resolves.toEqual({ ok: false, reason: "corrupt" });
    expect(uploadedFamilies()).toEqual([]);
  });

  it("frees idle atlases beyond the cap but never one the project uses", async () => {
    const names = Array.from({ length: MAX_IDLE_RASTER_FONTS + 2 }, (_, i) => `Copy ${i}`);
    registerLocalFaces(names.map((name) => ({ family: name, style: "Regular", blob: () => Promise.resolve(asBlob(ROBOTO_REGULAR)) })));
    for (const name of names) await loadRasterFont({ family: name, weight: 400 });
    expect(rasterFontCount()).toBe(names.length);

    pruneRasterFonts(new Set([`400|${names[0]}`]));
    // The used font plus the most recently used idle ones survive; the oldest idle ones are freed.
    expect(rasterFontCount()).toBe(MAX_IDLE_RASTER_FONTS + 1);
    expect(hasRasterFace({ family: names[0], weight: 400 })).toBe(true);
    expect(hasRasterFace({ family: names[1], weight: 400 })).toBe(false);
    expect(Cache.has(`raster:${names[1]}:400-bitmap`)).toBe(false);
    expect(hasRasterFace({ family: names[names.length - 1], weight: 400 })).toBe(true);
    for (const name of names) disposeRasterFamily(name);
  }, 60_000);
});
