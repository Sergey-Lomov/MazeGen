import { describe, it, expect, vi } from "vitest";

// Synthetic font at base size 100: every glyph advances 50, its quad is 58x48 with 4px padding per
// side, so the ink is 50 wide (x 4..54) and 40 tall (y 14..54). At size S: one glyph is 0.5*S x
// 0.4*S, two glyphs 1.0*S x 0.4*S.
const glyph = { xAdvance: 50, xOffset: 0, yOffset: 10, texture: { orig: { width: 58, height: 48 } } };
// "I" carries atlas pixels (read through a stubbed canvas below): a 3x3 ink dot at the quad's centre.
const inkGlyph = {
  ...glyph,
  texture: { orig: { width: 58, height: 48 }, frame: { x: 0, y: 0, width: 58, height: 48 }, source: { resource: { width: 58, height: 48 } } },
};
const FAKE_FONT = { baseMeasurementFontSize: 100, chars: { "1": glyph, "8": glyph, I: inkGlyph } as Record<string, unknown> };

vi.mock("pixi.js", () => ({
  Cache: { get: (key: string) => (key.endsWith("-bitmap") ? FAKE_FONT : undefined) },
}));

const { measureText, textOverflows, maxFittingFontSize, inkBoundaryPoints } = await import("../pixi/textFit");

const item = (text: string, shape: "circle" | "square" | "star" | "cross", plateSize: number) => ({ text, fontWeight: "bold" as const, shape, plateSize });

describe("textFit", () => {
  it("measures padding-trimmed ink extent linearly in font size", () => {
    expect(measureText("1", "bold", 100)).toEqual({ width: 50, height: 40 });
    expect(measureText("18", "bold", 20)).toEqual({ width: 20, height: 8 });
    expect(measureText("", "bold", 40)).toEqual({ width: 0, height: 0 });
  });

  it("circle: fits while the ink rectangle's corners stay inside the circle", () => {
    // "1" ink 0.5S x 0.4S -> half diagonal 0.32S; plate 20 less the 1 px margin -> r 9.5 -> S <= ~29.7.
    expect(textOverflows(item("1", "circle", 20), 29)).toBe(false);
    expect(textOverflows(item("1", "circle", 20), 30)).toBe(true);
  });

  it("allowed size depends on the shape", () => {
    const circle = maxFittingFontSize([item("1", "circle", 20)])!;
    const star = maxFittingFontSize([item("1", "star", 20)])!;
    const cross = maxFittingFontSize([item("1", "cross", 20)])!;
    expect(star).toBeLessThan(circle);
    expect(cross).toBeLessThan(star);
  });

  it("max fitting size is the largest snapped size with no overflow", () => {
    for (const shape of ["circle", "square", "star", "cross"] as const) {
      const it1 = item("18", shape, 20);
      const size = maxFittingFontSize([it1])!;
      expect(textOverflows(it1, size)).toBe(false);
      expect(textOverflows(it1, size + 0.5)).toBe(true);
    }
  });

  it("takes the tightest item and clamps to the size range", () => {
    const wide = item("18", "circle", 20);
    const narrow = item("1", "circle", 20);
    expect(maxFittingFontSize([wide, narrow])).toBe(maxFittingFontSize([wide]));
    expect(maxFittingFontSize([item("1", "circle", 5000)])).toBe(32);
    expect(maxFittingFontSize([item("18", "circle", 1)])).toBe(6);
    expect(maxFittingFontSize([])).toBeNull();
    expect(textOverflows(item("", "circle", 20), 100)).toBe(false);
  });

  it("extracts only the boundary pixels of the ink from an MSDF page", () => {
    // 5x5 page, 3x3 solid block at (1,1)..(3,3) in all channels; frame covers the whole page.
    const w = 5;
    const rgba = new Uint8ClampedArray(w * w * 4);
    for (let y = 1; y <= 3; y++) for (let x = 1; x <= 3; x++) rgba.fill(255, (y * w + x) * 4, (y * w + x) * 4 + 3);
    const pts = inkBoundaryPoints(rgba, w, { x: 0, y: 0, width: w, height: w });
    // 8 ring pixels; the centre (2,2) is interior.
    expect(pts).toHaveLength(16);
    expect(pts.join(",")).not.toContain("2.5,2.5");
    // Median rule: one bright channel alone is not ink.
    const lone = new Uint8ClampedArray(4 * 4);
    lone[0] = 255;
    expect(inkBoundaryPoints(lone, 2, { x: 0, y: 0, width: 2, height: 2 })).toEqual([]);
  });
  it("uses the real glyph ink from the atlas instead of the bounding rectangle when pixels are readable", () => {
    const data = new Uint8ClampedArray(58 * 48 * 4);
    for (let y = 23; y <= 25; y++) for (let x = 28; x <= 30; x++) data.fill(255, (y * 58 + x) * 4, (y * 58 + x) * 4 + 3);
    const ctx = { drawImage: () => {}, getImageData: () => ({ data }) };
    const spy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
    try {
      // Same plate: the dot (ink) fits at the range maximum while the "1" bounding rectangle does not.
      expect(maxFittingFontSize([item("I", "circle", 10)])).toBe(32);
      expect(maxFittingFontSize([item("1", "circle", 10)])!).toBeLessThan(32);
      expect(textOverflows(item("I", "star", 10), 32)).toBe(false);
      expect(textOverflows(item("I", "circle", 1), 32)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
