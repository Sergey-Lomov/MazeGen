import { describe, expect, it } from "vitest";
import { formatTargetLabel } from "../pixi/targetLabel";

describe("formatTargetLabel", () => {
  it("formats plain coordinates when floor and split suffix are both omitted", () => {
    expect(formatTargetLabel([3, 5], 0, false, undefined)).toBe("3:5");
  });

  it("prefixes the 1-based floor with a plain space when includeFloor is set", () => {
    expect(formatTargetLabel([4, 5], 1, true, undefined)).toBe("L2 4:5");
  });

  it("appends the split-node suffix in parens when given", () => {
    expect(formatTargetLabel([3, 5], 0, false, "Node2")).toBe("3:5 (Node2)");
  });

  it("combines floor prefix and split-node suffix", () => {
    expect(formatTargetLabel([-4, 3], 1, true, "Node2")).toBe("L2 -4:3 (Node2)");
  });

  it("keeps the floor/coordinate space separator distinct from a negative coordinate's minus sign", () => {
    // The motivating case for the plain-space floor separator (GitHub issue #602 follow-up): a
    // `:`-only separator here would have read as `L2:-4:3`, blurring the floor prefix into the
    // coordinates once either number went negative.
    expect(formatTargetLabel([-4, 3], 1, true, undefined)).toBe("L2 -4:3");
  });

  it("omits the suffix parens for an empty-string split label", () => {
    expect(formatTargetLabel([3, 5], 0, false, "")).toBe("3:5");
  });
});
