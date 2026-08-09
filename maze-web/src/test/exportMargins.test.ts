import { describe, it, expect } from "vitest";
import { computeVectorByWallsExportMargin, computeVectorByWallsWallMargin, computeVectorByCorridorsExportMargin, resolveExportMargin, resolveWallExportMargin } from "../pixi/imageExport/exportMargins";
import { DEFAULT_VECTOR_BY_WALLS_SETTINGS, DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS } from "../store/slices/imageExportSlice";

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

describe("computeVectorByCorridorsExportMargin", () => {
  it("equals half the corridor thickness on every side, by default", () => {
    const margin = computeVectorByCorridorsExportMargin(DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS);
    expect(margin).toEqual({
      left: DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS.thickness / 2,
      right: DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS.thickness / 2,
      top: DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS.thickness / 2,
      bottom: DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS.thickness / 2,
    });
  });

  it("grows to fit a teleport marker/connector footprint that exceeds the corridor's own half-width (GitHub issue #313)", () => {
    const base = computeVectorByCorridorsExportMargin(DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS);
    const biggerTeleport = computeVectorByCorridorsExportMargin({
      ...DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS,
      teleportEdgeBorderWidth: DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS.teleportEdgeBorderWidth + 100,
    });
    expect(biggerTeleport.left).toBeGreaterThan(base.left);
  });
});

describe("resolveExportMargin", () => {
  const state = { vectorByWallsSettings: DEFAULT_VECTOR_BY_WALLS_SETTINGS, vectorByCorridorsSettings: DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS };

  it("resolves 'vector_by_walls' without constructing a Pixi renderer", () => {
    const margin = resolveExportMargin("vector_by_walls", state);
    expect(margin).toEqual(computeVectorByWallsExportMargin(DEFAULT_VECTOR_BY_WALLS_SETTINGS));
  });

  it("resolves 'vector_by_corridors' without constructing a Pixi renderer", () => {
    const margin = resolveExportMargin("vector_by_corridors", state);
    expect(margin).toEqual(computeVectorByCorridorsExportMargin(DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS));
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
  const state = { vectorByWallsSettings: DEFAULT_VECTOR_BY_WALLS_SETTINGS, vectorByCorridorsSettings: DEFAULT_VECTOR_BY_CORRIDORS_SETTINGS };

  it("resolves 'vector_by_walls' to the wall-only margin, not the full one", () => {
    const margin = resolveWallExportMargin("vector_by_walls", state);
    expect(margin).toEqual(computeVectorByWallsWallMargin(DEFAULT_VECTOR_BY_WALLS_SETTINGS));
  });
});
