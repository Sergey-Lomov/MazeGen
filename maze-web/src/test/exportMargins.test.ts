import { describe, it, expect } from "vitest";
import { computeVectorByWallsExportMargin, computeVectorByWallsWallMargin, resolveExportMargin, resolveWallExportMargin } from "../pixi/imageExport/exportMargins";
import { DEFAULT_VECTOR_BY_WALLS_SETTINGS } from "../store/slices/imageExportSlice";

describe("computeVectorByWallsExportMargin", () => {
  it("returns a uniform margin on all four sides", () => {
    const margin = computeVectorByWallsExportMargin(DEFAULT_VECTOR_BY_WALLS_SETTINGS);
    expect(margin.left).toBe(margin.right);
    expect(margin.top).toBe(margin.bottom);
    expect(margin.left).toBe(margin.top);
  });

  it("grows when wallThickness grows", () => {
    const base = computeVectorByWallsExportMargin(DEFAULT_VECTOR_BY_WALLS_SETTINGS);
    const thicker = computeVectorByWallsExportMargin({ ...DEFAULT_VECTOR_BY_WALLS_SETTINGS, wallThickness: DEFAULT_VECTOR_BY_WALLS_SETTINGS.wallThickness + 100 });
    expect(thicker.left).toBeGreaterThan(base.left);
  });

  it("grows when a marker's border/gap width grows", () => {
    const base = computeVectorByWallsExportMargin(DEFAULT_VECTOR_BY_WALLS_SETTINGS);
    const biggerMarker = computeVectorByWallsExportMargin({
      ...DEFAULT_VECTOR_BY_WALLS_SETTINGS,
      startMarker: { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.startMarker, borderWidth: 50, gapWidth: 50 },
    });
    expect(biggerMarker.left).toBeGreaterThan(base.left);
  });

  it("is never negative", () => {
    const margin = computeVectorByWallsExportMargin({ ...DEFAULT_VECTOR_BY_WALLS_SETTINGS, wallThickness: 0, oneWayGapWidth: 0, oneWaySize: 0, oneWayThickness: 0 });
    expect(margin.left).toBeGreaterThanOrEqual(0);
  });
});

describe("resolveExportMargin", () => {
  it("resolves 'vector_by_walls' without constructing a Pixi renderer", () => {
    const margin = resolveExportMargin("vector_by_walls", { vectorByWallsSettings: DEFAULT_VECTOR_BY_WALLS_SETTINGS });
    expect(margin).toEqual(computeVectorByWallsExportMargin(DEFAULT_VECTOR_BY_WALLS_SETTINGS));
  });
});

describe("computeVectorByWallsWallMargin", () => {
  it("equals half the wall thickness on every side", () => {
    const margin = computeVectorByWallsWallMargin(DEFAULT_VECTOR_BY_WALLS_SETTINGS);
    expect(margin).toEqual({
      left: DEFAULT_VECTOR_BY_WALLS_SETTINGS.wallThickness / 2,
      right: DEFAULT_VECTOR_BY_WALLS_SETTINGS.wallThickness / 2,
      top: DEFAULT_VECTOR_BY_WALLS_SETTINGS.wallThickness / 2,
      bottom: DEFAULT_VECTOR_BY_WALLS_SETTINGS.wallThickness / 2,
    });
  });

  it("ignores marker/one-way/teleport sizing entirely, unlike computeVectorByWallsExportMargin", () => {
    const settingsWithHugeMarkers = {
      ...DEFAULT_VECTOR_BY_WALLS_SETTINGS,
      oneWayGapWidth: 500,
      startMarker: { ...DEFAULT_VECTOR_BY_WALLS_SETTINGS.startMarker, borderWidth: 500, gapWidth: 500 },
    };
    const wallMargin = computeVectorByWallsWallMargin(settingsWithHugeMarkers);
    expect(wallMargin.left).toBe(settingsWithHugeMarkers.wallThickness / 2);
    expect(computeVectorByWallsExportMargin(settingsWithHugeMarkers).left).toBeGreaterThan(wallMargin.left);
  });
});

describe("resolveWallExportMargin", () => {
  it("resolves 'vector_by_walls' to the wall-only margin, not the full one", () => {
    const margin = resolveWallExportMargin("vector_by_walls", { vectorByWallsSettings: DEFAULT_VECTOR_BY_WALLS_SETTINGS });
    expect(margin).toEqual(computeVectorByWallsWallMargin(DEFAULT_VECTOR_BY_WALLS_SETTINGS));
  });
});
