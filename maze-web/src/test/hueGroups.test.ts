import { describe, expect, it } from "vitest";
import { brightColor, colorToOklch, distributeHueGroups, hueGroupColors } from "../domain/colorMath";
import { AUTO_COLOR_COUNT, glueColor } from "../domain/glueColor";
import { AUTO_HUE_BASE_COLOR } from "../domain/renderConstants";

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

/** `distributeHueGroups` as it was before the zones work (GitHub issue #1031), for the base colour: the edge markers
 *  of the export take their colours from it, and extracting `hueGroupColors` must not move any of them. */
const DISTRIBUTION_BEFORE_ZONES: Record<string, number[]> = {
  "1": [2651069],
  "2": [2651069, 10183424],
  "3": [2651069, 11618652, 5406749],
  "5": [2651069, 9851550, 11685428, 7894272, 33651],
  "8": [2651069, 8019382, 10767495, 11750212, 10183424, 7174400, 34394, 32908],
  "9": [23680, 6765711, 9513783, 6902016, 25923, 7702241, 13723525, 11111424, 42390],
  "12": [23427, 6176662, 9120598, 8405248, 5331712, 25427, 6851297, 12152506, 13986400, 11634688, 5219418, 41392],
  "18": [16721, 3287421, 6557006, 6627584, 4340480, 17965, 2651069, 9131690, 11618652, 10183424, 5406749, 33407, 10527487, 15174086, 16092774, 12562232, 4900754, 835818],
  "25": [9773, 136032, 3539015, 4456472, 3479552, 2302720, 10520, 23427, 6176662, 9120598, 8405248, 5331712, 25427, 6851297, 12152506, 13986400, 11634688, 5219418, 41392, 13812479, 16757966, 16760205, 13097067, 5237451, 9819903],
  "9h": [29856, 8278953, 11224141, 8677120, 32597, 9281532, 15564957, 12821803, 49584]
};

describe("distributeHueGroups stays as it was", () => {
  it.each(Object.keys(DISTRIBUTION_BEFORE_ZONES))("case %s", (key) => {
    const hovered = key.endsWith("h");
    const count = Number.parseInt(key, 10);
    expect(distributeHueGroups(AUTO_HUE_BASE_COLOR, count, hovered ? 8 : 0)).toEqual(DISTRIBUTION_BEFORE_ZONES[key]);
  });
});

describe("glueColor", () => {
  it("is a fixed palette of AUTO_COLOR_COUNT colours whose later rounds are shifted groups", () => {
    const palette = Array.from({ length: AUTO_COLOR_COUNT }, (_, i) => glueColor(i));
    expect(palette).toEqual(distributeHueGroups(AUTO_HUE_BASE_COLOR, AUTO_COLOR_COUNT));
    // The next round is a group shifted in lightness and hue, so the 9th colour is not the 1st.
    expect(glueColor(AUTO_COLOR_COUNT)).not.toBe(palette[0]);
    expect(Array.from({ length: AUTO_COLOR_COUNT }, (_, i) => glueColor(i))).toEqual(hueGroupColors(AUTO_HUE_BASE_COLOR, AUTO_COLOR_COUNT, 0));
    expect(Array.from({ length: AUTO_COLOR_COUNT }, (_, i) => glueColor(AUTO_COLOR_COUNT + i))).toEqual(hueGroupColors(AUTO_HUE_BASE_COLOR, AUTO_COLOR_COUNT, 1));
    expect(new Set(Array.from({ length: 3 * AUTO_COLOR_COUNT }, (_, i) => glueColor(i))).size).toBe(3 * AUTO_COLOR_COUNT);
    expect(glueColor(0, true)).not.toBe(palette[0]);
    expect(Array.from({ length: AUTO_COLOR_COUNT }, (_, i) => glueColor(i))).toEqual(palette);
  });
});

describe("brightColor", () => {
  it("keeps the hue and is bright whatever the lightness of the source", () => {
    for (const source of [0x101820, 0x0a2f6b, AUTO_HUE_BASE_COLOR, 0xffe9a0]) {
      const before = colorToOklch(source);
      const after = colorToOklch(brightColor(source));
      expect(after.l).toBeGreaterThanOrEqual(Math.min(before.l, 80) - 1);
      expect(after.l).toBeGreaterThan(75);
      if (before.c > 0.02) expect(Math.abs(((after.h - before.h + 540) % 360) - 180)).toBeLessThan(8);
    }
  });
});
