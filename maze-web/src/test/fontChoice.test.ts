import { describe, it, expect } from "vitest";
import {
  MSDF_FONTS,
  isMsdfFamily,
  labelFontEquals,
  msdfFace,
  msdfFontWeights,
  nearestWeight,
  plainLabelFont,
  weightFromStyleName,
} from "../pixi/renderers/fontChoice";

describe("nearestWeight", () => {
  it("returns the offered weight closest to the wanted one", () => {
    expect(nearestWeight(500, [400, 700])).toBe(400);
    expect(nearestWeight(600, [400, 700])).toBe(700);
    expect(nearestWeight(100, [300, 400, 700])).toBe(300);
    expect(nearestWeight(900, [300, 400, 700])).toBe(700);
  });

  it("lets the heavier weight win a tie", () => {
    expect(nearestWeight(550, [400, 700])).toBe(700);
  });

  it("keeps the wanted weight when nothing is offered", () => {
    expect(nearestWeight(500, [])).toBe(500);
  });
});

describe("weightFromStyleName", () => {
  it.each([
    ["Thin", 100], ["Extra Light", 200], ["UltraLight", 200], ["Light", 300], ["Regular", 400], ["Book", 400],
    ["Medium", 500], ["Semibold", 600], ["Semi-Bold", 600], ["Bold", 700], ["ExtraBold", 800], ["Black", 900], ["Heavy", 900], ["", 400],
  ])("maps %j to %i", (style, weight) => {
    expect(weightFromStyleName(style)).toBe(weight);
  });

  it("rejects italic, oblique and other non-normal styles", () => {
    expect(weightFromStyleName("Bold Italic")).toBeNull();
    expect(weightFromStyleName("Oblique")).toBeNull();
    expect(weightFromStyleName("Condensed")).toBeNull();
  });
});

describe("MSDF font registry", () => {
  it("treats the empty family as the bundled Roboto and no other family as MSDF", () => {
    expect(isMsdfFamily("")).toBe(true);
    expect(isMsdfFamily("Arial")).toBe(false);
    expect(isMsdfFamily("toString")).toBe(false);
  });

  it("lists the baked weights of a font ascending", () => {
    expect(msdfFontWeights("")).toEqual(MSDF_FONTS[""].faces.map((face) => face.weight).sort((a, b) => a - b));
    expect(msdfFontWeights("")).toEqual([400, 700]);
  });

  it("picks the face with the nearest baked weight, defaulting an unknown family to the default font", () => {
    expect(msdfFace({ family: "", weight: 700 }).atlasName).toBe("Roboto-Bold");
    expect(msdfFace({ family: "", weight: 400 }).atlasName).toBe("Roboto-Regular");
    expect(msdfFace({ family: "", weight: 300 }).atlasName).toBe("Roboto-Regular");
    expect(msdfFace({ family: "", weight: 600 }).atlasName).toBe("Roboto-Bold");
    expect(msdfFace({ family: "Missing", weight: 700 }).atlasName).toBe("Roboto-Bold");
  });
});

describe("label font values", () => {
  it("compares by family and weight", () => {
    expect(labelFontEquals({ family: "A", weight: 400 }, { family: "A", weight: 400 })).toBe(true);
    expect(labelFontEquals({ family: "A", weight: 400 }, { family: "A", weight: 700 })).toBe(false);
    expect(labelFontEquals({ family: "A", weight: 400 }, { family: "B", weight: 400 })).toBe(false);
  });

});

describe("plainLabelFont", () => {
  it("copies only family and weight into a detached object", () => {
    const source = { family: "Arial", weight: 500, extra: true } as { family: string; weight: number };
    const copy = plainLabelFont(source);
    expect(copy).toEqual({ family: "Arial", weight: 500 });
    expect(copy).not.toBe(source);
  });
});
