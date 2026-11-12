import { describe, it, expect } from "vitest";
import { fontWeightName, formatLabelFont } from "../store/fontLabels";
import { CSS_FONT_WEIGHTS } from "../pixi/renderers/fontChoice";

describe("fontWeightName", () => {
  it("names every CSS weight with its own non-empty label", () => {
    const names = CSS_FONT_WEIGHTS.map((weight) => fontWeightName(weight));
    expect(names.every((name) => name !== "" && !/^\d+$/.test(name))).toBe(true);
    expect(new Set(names).size).toBe(CSS_FONT_WEIGHTS.length);
  });

  it("falls back to the bare number for a weight off the 100..900 scale", () => {
    expect(fontWeightName(450)).toBe("450");
  });
});

describe("formatLabelFont", () => {
  it("joins the family name and the weight name", () => {
    expect(formatLabelFont({ family: "", weight: 700 })).toBe(`Roboto, ${fontWeightName(700)}`);
    expect(formatLabelFont({ family: "Fira Sans", weight: 300 })).toBe(`Fira Sans, ${fontWeightName(300)}`);
  });
});
