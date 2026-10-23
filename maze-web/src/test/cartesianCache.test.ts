import { describe, expect, it, vi } from "vitest";
import * as mazeService from "../wasm/mazeService";
import {
  cellAtWorldPoint,
  cellId,
  cellsInWorldRegion,
  getCartesian,
  getCellGeometry,
  getFieldVersion,
  getFieldWorldBounds,
  DEFAULT_MAX_OUTSIDE_CELLS,
  setMaxOutsideCells,
  warmCartesianCache,
} from "../pixi/cartesianCache";
import { fieldOf } from "./fieldConfigFixtures";

// Runs against the real `maze-core` module loaded by `setup.ts`.
describe("geometry access layer", () => {
  it("serves prewarmed cells from one snapshot call", () => {
    const spy = vi.spyOn(mazeService, "getGeometrySnapshot");
    const square = fieldOf("square", { shape: "custom", points: [[0, 0], [2, 1]] });
    warmCartesianCache(square);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(getCartesian(2, 1, square)).toEqual([2.5, 1.5]);
    expect(getCellGeometry(0, 0, square).polyline).toHaveLength(4);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("bumps the field version only when the instance or the cell set changes", () => {
    const square = fieldOf("square", { shape: "custom", points: [[0, 0]] });
    warmCartesianCache(square);
    const version = getFieldVersion();
    warmCartesianCache({ ...square });
    expect(getFieldVersion()).toBe(version);
    warmCartesianCache(fieldOf("square", { shape: "custom", points: [[0, 0], [1, 0]] }));
    expect(getFieldVersion()).toBe(version + 1);
    warmCartesianCache(fieldOf("hex", { shape: "custom", points: [[0, 0], [1, 0]] }));
    expect(getFieldVersion()).toBe(version + 2);
  });

  it("re-projects when the tessellation instance changes, even with the same cells", () => {
    const square = fieldOf("square", { shape: "custom", points: [[1, 0]] });
    warmCartesianCache(square);
    const squareCenter = getCartesian(1, 0, square);
    const hex = fieldOf("hex", { shape: "custom", points: [[1, 0]] });
    expect(getCartesian(1, 0, hex)).not.toEqual(squareCenter);
  });

  it("fetches a cell outside the field once and caches it", () => {
    const square = fieldOf("square", { shape: "custom", points: [[0, 0]] });
    warmCartesianCache(square);
    const spy = vi.spyOn(mazeService, "getGeometrySnapshot");
    expect(getCartesian(5, 5, square)).toEqual([5.5, 5.5]);
    getCartesian(5, 5, square);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("evicts the least recently used outside cell and never a field cell", () => {
    const square = fieldOf("square", { shape: "custom", points: [[0, 0]] });
    warmCartesianCache(square);
    setMaxOutsideCells(2);
    try {
      getCartesian(5, 5, square);
      getCartesian(6, 6, square);
      getCartesian(5, 5, square); // refresh: (6, 6) is now the oldest
      getCartesian(7, 7, square); // evicts (6, 6)
      const spy = vi.spyOn(mazeService, "getGeometrySnapshot");
      getCartesian(5, 5, square);
      getCartesian(7, 7, square);
      getCartesian(0, 0, square);
      expect(spy).not.toHaveBeenCalled();
      getCartesian(6, 6, square);
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    } finally {
      setMaxOutsideCells(DEFAULT_MAX_OUTSIDE_CELLS);
    }
    // The field cell survived every eviction.
    const spy = vi.spyOn(mazeService, "getGeometrySnapshot");
    getCartesian(0, 0, square);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("finds cells by point and region within the field only", () => {
    const square = fieldOf("square", { shape: "custom", points: [[0, 0], [1, 0], [2, 0]] });
    expect(cellAtWorldPoint([1.5, 0.5], square)).toEqual(cellId(1, 0));
    expect(cellAtWorldPoint([1.5, 4.5], square)).toBeNull();
    const huge: [number, number][] = [[-1e6, -1e6], [1e6, -1e6], [1e6, 1e6], [-1e6, 1e6]];
    expect(cellsInWorldRegion(huge, "intersects", square)).toEqual([cellId(0, 0), cellId(1, 0), cellId(2, 0)]);
    expect(cellsInWorldRegion(huge, "intersects", square, [cellId(2, 0)])).toEqual([cellId(2, 0)]);
  });

  it("reports the field's world bounds", () => {
    const square = fieldOf("square", { shape: "custom", points: [[0, 0], [2, 1]] });
    expect(getFieldWorldBounds(square)).toEqual({ minX: 0, minY: 0, maxX: 3, maxY: 2 });
    expect(getFieldWorldBounds(fieldOf("square", { shape: "custom", points: [] }))).toBeNull();
  });
});
