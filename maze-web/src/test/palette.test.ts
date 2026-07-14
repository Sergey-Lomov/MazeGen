import { describe, it, expect, vi } from "vitest";

vi.mock("pixi.js", () => ({
  Container: class {},
  Graphics: class { clear() { return this; } rect() { return this; } fill() { return this; } circle() { return this; } },
}));

vi.mock("../store/mazeStore", () => ({
  useMazeStore: { getState: () => ({ nodes: [], graphAnalytics: null }), subscribe: () => () => {} },
}));

import { hslToRgb, buildPalette, buildDebugValuePalette } from "../pixi/colorUtils";

describe("hslToRgb", () => {
  it("red: hsl(0, 1, 0.5) = 0xff0000", () => {
    expect(hslToRgb(0, 1, 0.5)).toBe(0xff0000);
  });

  it("green: hsl(120, 1, 0.5) = 0x00ff00", () => {
    expect(hslToRgb(120, 1, 0.5)).toBe(0x00ff00);
  });

  it("blue: hsl(240, 1, 0.5) = 0x0000ff", () => {
    expect(hslToRgb(240, 1, 0.5)).toBe(0x0000ff);
  });

  it("white: hsl(0, 0, 1) = 0xffffff", () => {
    expect(hslToRgb(0, 0, 1)).toBe(0xffffff);
  });

  it("black: hsl(0, 0, 0) = 0x000000", () => {
    expect(hslToRgb(0, 0, 0)).toBe(0x000000);
  });
});

describe("buildPalette", () => {
  it("returns empty array for count=0", () => {
    expect(buildPalette(0)).toEqual([]);
  });

  it("returns correct length", () => {
    expect(buildPalette(5)).toHaveLength(5);
    expect(buildPalette(12)).toHaveLength(12);
    expect(buildPalette(13)).toHaveLength(13);
    expect(buildPalette(36)).toHaveLength(36);
  });

  it("first 12 entries are all unique colors", () => {
    const palette = buildPalette(12);
    const unique = new Set(palette);
    expect(unique.size).toBe(12);
  });

  it("pass 1 (indices 12-23) entries are all unique colors", () => {
    const palette = buildPalette(24);
    const second = palette.slice(12, 24);
    const unique = new Set(second);
    expect(unique.size).toBe(12);
  });

  it("pass 0 and pass 1 have no color duplicates (different L)", () => {
    const palette = buildPalette(24);
    const first = new Set(palette.slice(0, 12));
    for (const c of palette.slice(12, 24)) {
      expect(first.has(c)).toBe(false);
    }
  });

  it("pass 1 and pass 2 have no color duplicates (different L)", () => {
    const palette = buildPalette(36);
    const pass1 = new Set(palette.slice(12, 24));
    for (const c of palette.slice(24, 36)) {
      expect(pass1.has(c)).toBe(false);
    }
  });

  it("pass 0 and pass 2 have no color duplicates (different L)", () => {
    const palette = buildPalette(36);
    const pass0 = new Set(palette.slice(0, 12));
    for (const c of palette.slice(24, 36)) {
      expect(pass0.has(c)).toBe(false);
    }
  });

  it("does not throw for large count", () => {
    expect(() => buildPalette(100)).not.toThrow();
    expect(buildPalette(100)).toHaveLength(100);
  });
});

describe("buildDebugValuePalette", () => {
  it("returns empty array for count=0", () => {
    expect(buildDebugValuePalette(0)).toEqual([]);
  });

  it("returns correct length", () => {
    expect(buildDebugValuePalette(1)).toHaveLength(1);
    expect(buildDebugValuePalette(3)).toHaveLength(3);
    expect(buildDebugValuePalette(4)).toHaveLength(4);
    expect(buildDebugValuePalette(10)).toHaveLength(10);
  });

  it("is deterministic — same count always yields the same colors in the same order", () => {
    expect(buildDebugValuePalette(5)).toEqual(buildDebugValuePalette(5));
  });

  it("first pass (indices 0-2) entries are all distinct colors", () => {
    const palette = buildDebugValuePalette(3);
    expect(new Set(palette).size).toBe(3);
  });

  it("wraps hues across passes (index 3 reuses the first hue at a different lightness than index 0)", () => {
    const palette = buildDebugValuePalette(4);
    // Same hue (index 0 and index 3 share DEBUG_VALUE_HUES[0]) but different lightness passes,
    // so the two colors must differ — this is exactly the wraparound arithmetic a future edit to
    // the hue/lightness tables or the modulo indexing could silently break.
    expect(palette[3]).not.toBe(palette[0]);
  });

  it("does not throw for a count larger than the hue table", () => {
    expect(() => buildDebugValuePalette(20)).not.toThrow();
    expect(buildDebugValuePalette(20)).toHaveLength(20);
  });
});
