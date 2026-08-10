import { describe, it, expect } from "vitest";
import { resolveContentBoundsBasis, resolveBackgroundColor } from "../pixi/imageExport/exportMargins";
import { DEFAULT_VECTOR_BY_WALLS_SETTINGS, DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS } from "../store/slices/imageExportSlice";

describe("resolveContentBoundsBasis", () => {
  it("'vector_by_walls' measures against the cell's own polygon boundary", () => {
    expect(resolveContentBoundsBasis("vector_by_walls")).toBe("cell");
  });

  it("'vector_by_corridors' measures against the cell center — its content stops there, GitHub issue #324", () => {
    expect(resolveContentBoundsBasis("vector_by_corridors")).toBe("center");
  });
});

describe("resolveBackgroundColor", () => {
  const state = { vectorByWallsSettings: DEFAULT_VECTOR_BY_WALLS_SETTINGS, vectorByCorridorsSettings: DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS };

  it("resolves 'vector_by_walls' to its own background field", () => {
    expect(resolveBackgroundColor("vector_by_walls", state)).toBe(DEFAULT_VECTOR_BY_WALLS_SETTINGS.background);
  });

  it("resolves 'vector_by_corridors' to its own background field", () => {
    expect(resolveBackgroundColor("vector_by_corridors", state)).toBe(DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS.background);
  });
});
