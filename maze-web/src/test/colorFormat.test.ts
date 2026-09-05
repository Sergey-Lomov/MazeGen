import { describe, it, expect } from "vitest";
import { colorToRgb, rgbToColor, colorToHsl, hslToColor } from "../components/colorFormat";

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
