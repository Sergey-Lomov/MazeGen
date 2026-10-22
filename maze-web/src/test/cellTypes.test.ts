import { describe, it, expect } from "vitest";
import { resolveCellTypeLabel } from "../components/features/qualityI18n/cellTypes";

describe("resolveCellTypeLabel", () => {
  it("localizes every cell type key a tessellation defines", () => {
    for (const key of ["cell", "triangle", "square", "hexagon", "octagon", "dodecagon"]) {
      expect(resolveCellTypeLabel(key).length).toBeGreaterThan(0);
    }
  });

  it("falls back to the raw key for an unknown type", () => {
    expect(resolveCellTypeLabel("pentagon")).toBe("pentagon");
  });
});
