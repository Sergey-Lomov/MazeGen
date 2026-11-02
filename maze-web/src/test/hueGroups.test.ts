import { describe, expect, it } from "vitest";
import { colorToOklch, distributeHueGroups } from "../store/colorMath";
import { glueColor } from "../pixi/renderers/SeamArrowRenderer";
import { AUTO_HUE_BASE_COLOR } from "../pixi/renderConstants";

const lightness = (color: number) => colorToOklch(color).l;

describe("distributeHueGroups", () => {
  it("is one group at the base lightness and hue up to 8 colours, and empty for none", () => {
    const colors = distributeHueGroups(AUTO_HUE_BASE_COLOR, 5);
    expect(colors).toHaveLength(5);
    expect(colors[0]).toBe(AUTO_HUE_BASE_COLOR);
    colors.forEach((c) => expect(lightness(c)).toBeCloseTo(lightness(AUTO_HUE_BASE_COLOR), 0));
    expect(distributeHueGroups(AUTO_HUE_BASE_COLOR, 0)).toEqual([]);
  });

  it("splits 13 colours into 7 + 6, the larger group first", () => {
    const colors = distributeHueGroups(AUTO_HUE_BASE_COLOR, 13);
    const base = lightness(AUTO_HUE_BASE_COLOR);
    expect(colors).toHaveLength(13);
    colors.slice(0, 7).forEach((c) => expect(lightness(c)).toBeCloseTo(base - 10, 0));
    colors.slice(7).forEach((c) => expect(lightness(c)).toBeCloseTo(base + 10, 0));
  });

  it("adds the lightness offset to every group and keeps lightness within 0-100", () => {
    const base = lightness(AUTO_HUE_BASE_COLOR);
    expect(lightness(distributeHueGroups(AUTO_HUE_BASE_COLOR, 3, 10)[0])).toBeCloseTo(base + 10, 0);
    distributeHueGroups(0xffffff, 30, 50).forEach((c) => expect(lightness(c)).toBeLessThanOrEqual(100.5));
  });

  it("splits 9..16 colours into two equal groups shifted by -10 and +10 L", () => {
    const base = lightness(AUTO_HUE_BASE_COLOR);
    const colors = distributeHueGroups(AUTO_HUE_BASE_COLOR, 10);
    expect(colors).toHaveLength(10);
    colors.slice(0, 5).forEach((c) => expect(lightness(c)).toBeCloseTo(base - 10, 0));
    colors.slice(5).forEach((c) => expect(lightness(c)).toBeCloseTo(base + 10, 0));
  });

  it("shifts the hues of two groups by -15 and +15 degrees when each has 6 colours", () => {
    const { h } = colorToOklch(AUTO_HUE_BASE_COLOR);
    const colors = distributeHueGroups(AUTO_HUE_BASE_COLOR, 12);
    const diff = (a: number, b: number) => ((a - b + 540) % 360) - 180;
    expect(diff(colorToOklch(colors[0]).h, h)).toBeCloseTo(-15, 0);
    expect(diff(colorToOklch(colors[6]).h, h)).toBeCloseTo(15, 0);
  });

  it("shifts three groups by -20, 0 and +20 L", () => {
    const base = lightness(AUTO_HUE_BASE_COLOR);
    const colors = distributeHueGroups(AUTO_HUE_BASE_COLOR, 18);
    expect(lightness(colors[0])).toBeCloseTo(base - 20, 0);
    expect(lightness(colors[6])).toBeCloseTo(base, 0);
    expect(lightness(colors[12])).toBeCloseTo(base + 20, 0);
  });
});

describe("glueColor", () => {
  it("serves the right distribution after the glue count or the hover state changes", () => {
    const four = [0, 1, 2, 3].map((i) => glueColor(i, 4, false));
    const hoveredFour = glueColor(0, 4, true);
    const two = glueColor(0, 2, false);
    expect(hoveredFour).not.toBe(four[0]);
    expect(two).toBe(distributeHueGroups(AUTO_HUE_BASE_COLOR, 2)[0]);
    expect([0, 1, 2, 3].map((i) => glueColor(i, 4, false))).toEqual(four);
  });

  it("is the hue distribution from the shared base colour", () => {
    const colors = distributeHueGroups(AUTO_HUE_BASE_COLOR, 3);
    expect([0, 1, 2].map((i) => glueColor(i, 3, false))).toEqual(colors);
  });
});
