import { describe, it, expect } from "vitest";
import { colorToRgb, rgbToColor } from "../components/colorFormat";

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
