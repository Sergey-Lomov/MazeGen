import { describe, it, expect } from "vitest";
import {
  colorToRgb,
  rgbToColor,
  colorToHsl,
  hslToColor,
  colorToOklch,
  oklchToColor,
  oklchInSrgb,
  oklchMaxChroma,
  oklchToSrgbSample,
  OKLCH_MAX_CHROMA,
} from "../components/colorFormat";

describe("colorFormat RGB", () => {
  it("unpacks a packed color into channels", () => {
    expect(colorToRgb(0x336699)).toEqual({ r: 0x33, g: 0x66, b: 0x99 });
    expect(colorToRgb(0x000000)).toEqual({ r: 0, g: 0, b: 0 });
    expect(colorToRgb(0xffffff)).toEqual({ r: 255, g: 255, b: 255 });
  });

  it("packs channels back into a color", () => {
    expect(rgbToColor({ r: 0x33, g: 0x66, b: 0x99 })).toBe(0x336699);
  });

  it("clamps and rounds out-of-range channels", () => {
    expect(rgbToColor({ r: -5, g: 300, b: 12.6 })).toBe((0 << 16) | (255 << 8) | 13);
  });

  it("round-trips every corner", () => {
    for (const c of [0x000000, 0xffffff, 0xff00aa, 0x123456]) {
      expect(rgbToColor(colorToRgb(c))).toBe(c);
    }
  });
});

describe("colorFormat HSL", () => {
  const close = (a: number, b: number, eps = 0.5) => Math.abs(a - b) <= eps;

  it("converts primaries to HSL", () => {
    expect(colorToHsl(0xff0000)).toMatchObject({ h: 0, s: 100, l: 50 });
    expect(colorToHsl(0x00ff00)).toMatchObject({ h: 120, s: 100, l: 50 });
    expect(colorToHsl(0x0000ff)).toMatchObject({ h: 240, s: 100, l: 50 });
  });

  it("wraps a negative raw hue into 0-360 (red-to-magenta, max = red, blue > green)", () => {
    // 0xff0080 -> hue 330; the `(g - b) / delta` term is negative before the +360 wrap.
    const { h } = colorToHsl(0xff0080);
    expect(close(h, 330)).toBe(true);
  });

  it("reports achromatic colors with zero hue and saturation", () => {
    expect(colorToHsl(0x000000)).toEqual({ h: 0, s: 0, l: 0 });
    expect(colorToHsl(0xffffff)).toEqual({ h: 0, s: 0, l: 100 });
    const grey = colorToHsl(0x808080);
    expect(grey.h).toBe(0);
    expect(grey.s).toBe(0);
    expect(close(grey.l, 50.2)).toBe(true);
  });

  it("builds a color from an HSL triple", () => {
    expect(hslToColor({ h: 0, s: 100, l: 50 })).toBe(0xff0000);
    expect(hslToColor({ h: 210, s: 50, l: 40 })).toBe(hslToColor({ h: 210, s: 50, l: 40 }));
  });

  it("wraps hue and clamps s / l", () => {
    expect(hslToColor({ h: 360, s: 100, l: 50 })).toBe(hslToColor({ h: 0, s: 100, l: 50 }));
    expect(hslToColor({ h: -120, s: 100, l: 50 })).toBe(hslToColor({ h: 240, s: 100, l: 50 }));
    expect(hslToColor({ h: 0, s: 200, l: 50 })).toBe(hslToColor({ h: 0, s: 100, l: 50 }));
    expect(hslToColor({ h: 0, s: 100, l: -10 })).toBe(0x000000);
  });

  it("round-trips packed colors through HSL", () => {
    for (const c of [0x000000, 0xffffff, 0xff00aa, 0x123456, 0x336699, 0x808080, 0x7f3d1c]) {
      expect(hslToColor(colorToHsl(c))).toBe(c);
    }
  });
});

describe("colorFormat OKLCH", () => {
  const close = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps;

  it("maps black and white to L 0 / L 100 with no chroma", () => {
    const black = colorToOklch(0x000000);
    expect(close(black.l, 0, 0.1)).toBe(true);
    expect(close(black.c, 0, 1e-3)).toBe(true);
    const white = colorToOklch(0xffffff);
    expect(close(white.l, 100, 0.1)).toBe(true);
    expect(close(white.c, 0, 1e-3)).toBe(true);
    expect(white.h).toBe(0);
  });

  it("gives a non-zero chroma and a hue for a saturated color", () => {
    const red = colorToOklch(0xff0000);
    expect(red.c).toBeGreaterThan(0.1);
    expect(red.h).toBeGreaterThan(0);
    expect(red.h).toBeLessThan(360);
  });

  it("round-trips in-gamut packed colors through OKLCH", () => {
    for (const c of [0x000000, 0xffffff, 0x336699, 0x123456, 0x7f3d1c, 0x808080]) {
      expect(oklchToColor(colorToOklch(c))).toBe(c);
    }
  });

  it("clamps L and wraps H on pack", () => {
    expect(oklchToColor({ l: -10, c: 0, h: 0 })).toBe(0x000000);
    expect(oklchToColor({ l: 200, c: 0, h: 0 })).toBe(0xffffff);
    const a = oklchToColor({ l: 50, c: 0.1, h: 30 });
    const b = oklchToColor({ l: 50, c: 0.1, h: 390 });
    expect(a).toBe(b);
  });

  it("flags an out-of-sRGB-gamut OKLCH color and clamps it on pack", () => {
    const wild = { l: 60, c: OKLCH_MAX_CHROMA, h: 150 };
    expect(oklchInSrgb(wild)).toBe(false);
    // Packing still yields a valid 24-bit color.
    const packed = oklchToColor(wild);
    expect(packed).toBeGreaterThanOrEqual(0);
    expect(packed).toBeLessThanOrEqual(0xffffff);
  });

  it("in-gamut colors report inside the gamut", () => {
    expect(oklchInSrgb(colorToOklch(0x336699))).toBe(true);
    expect(oklchInSrgb(colorToOklch(0xffffff))).toBe(true);
  });

  it("oklchMaxChroma bounds the in-gamut chroma for an L/H pair", () => {
    const limit = oklchMaxChroma(60, 150);
    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThanOrEqual(OKLCH_MAX_CHROMA);
    expect(oklchInSrgb({ l: 60, c: limit - 0.005, h: 150 })).toBe(true);
    expect(oklchInSrgb({ l: 60, c: limit + 0.01, h: 150 })).toBe(false);
  });

  it("oklchToSrgbSample returns clamped 0-255 bytes matching oklchToColor", () => {
    for (const t of [
      { l: 50, c: 0.1, h: 30 },
      { l: 90, c: 0.05, h: 200 },
      { l: 60, c: OKLCH_MAX_CHROMA, h: 150 }, // out of gamut — still clamped into range
    ]) {
      const s = oklchToSrgbSample(t);
      for (const v of [s.r, s.g, s.b]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(255);
        expect(Number.isInteger(v)).toBe(true);
      }
      const packed = oklchToColor(t);
      expect((packed >> 16) & 0xff).toBe(s.r);
      expect((packed >> 8) & 0xff).toBe(s.g);
      expect(packed & 0xff).toBe(s.b);
    }
  });
});
