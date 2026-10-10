import { describe, it, expect } from "vitest";
import { colorToOklch, distributeOklchHues, oklchToColor } from "../store/colorMath";

describe("distributeOklchHues", () => {
  const base = oklchToColor({ l: 70, c: 0.1, h: 40 });

  it("returns empty for zero count", () => {
    expect(distributeOklchHues(base, 0)).toEqual([]);
  });

  it("first color is the base", () => {
    expect(distributeOklchHues(base, 4)[0]).toBe(base);
  });

  it("spreads hue evenly and keeps lightness/chroma", () => {
    const baseH = colorToOklch(base).h;
    const out = distributeOklchHues(base, 4).map(colorToOklch);
    out.forEach((o, i) => {
      const expected = (baseH + 90 * i) % 360;
      const diff = Math.abs(((o.h - expected + 540) % 360) - 180);
      expect(diff).toBeLessThan(3);
      expect(Math.abs(o.l - 70)).toBeLessThan(1.5);
      expect(Math.abs(o.c - 0.1)).toBeLessThan(0.02);
    });
  });

  it("keeps lightness and hue exact when a hue can't reach the base chroma in sRGB", () => {
    const vivid = oklchToColor({ l: 85, c: 0.18, h: 100 });
    const baseOklch = colorToOklch(vivid);
    const out = distributeOklchHues(vivid, 6).map(colorToOklch);
    out.forEach((o, i) => {
      const expected = (baseOklch.h + 60 * i) % 360;
      const diff = Math.abs(((o.h - expected + 540) % 360) - 180);
      expect(diff).toBeLessThan(3);
      expect(Math.abs(o.l - baseOklch.l)).toBeLessThan(1.5);
      expect(o.c).toBeLessThanOrEqual(baseOklch.c + 0.01);
    });
    expect(out.some((o) => o.c < baseOklch.c - 0.02)).toBe(true);
  });
});
