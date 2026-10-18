import { describe, expect, it } from "vitest";
import { controlLineWidth } from "../pixi/controlLineWidth";

describe("controlLineWidth", () => {
  it("preserves normal-width strokes and clamps zoomed-out strokes in screen space", () => {
    expect(controlLineWidth(2, 1)).toBe(2);
    expect(controlLineWidth(1.25, 0.18)).toBeCloseTo(1.25 / 0.18);
  });
});
