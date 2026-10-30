import { describe, expect, it, vi } from "vitest";
import * as mazeService from "../wasm/mazeService";
import {
  cellAtWorldPoint,
  cellId,
  cellsInWorldRegion,
  getCartesian,
  getCellGeometry,
  getFieldVersion,
  getCellOutline,
  prefetchCellGeometries,
  getFieldWorldBounds,
  prefetchCellOutlines,
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

  it("prefetches many outside cell outlines with one outline call and no snapshot", () => {
    const square = fieldOf("square", { shape: "custom", points: [[0, 0]] });
    warmCartesianCache(square);
    const outlines = vi.spyOn(mazeService, "getCellOutlines");
    const snapshot = vi.spyOn(mazeService, "getGeometrySnapshot");
    prefetchCellOutlines([[0, 0], [5, 5], [6, 5], [7, 5]], square);
    expect(outlines).toHaveBeenCalledTimes(1);
    expect(outlines.mock.calls[0][1]).toEqual([[5, 5], [6, 5], [7, 5]]);
    expect(getCellOutline(6, 5, square)).toEqual(getCellGeometry(6, 5, square).boundary.commands);
    prefetchCellOutlines([[5, 5], [6, 5]], square);
    expect(outlines).toHaveBeenCalledTimes(1);
    outlines.mockRestore();
    snapshot.mockRestore();
  });

  it("rebuilds the path boundary from the faces exactly as core's outline", () => {
    for (const kind of ["square", "hex", "tri", "curved_quadrilateral"] as const) {
      const cfg = fieldOf(kind, { shape: "custom", points: [[0, 0], [2, 2]] });
      const cells: [number, number][] = [[0, 0], [1, 0], [0, 1], [2, 2]];
      const snapshot = mazeService.getGeometrySnapshot({ tessellation: cfg.tessellation, cells, boundary: { kind: "path" }, fieldVersion: 1 });
      const outlines = mazeService.getCellOutlines(cfg.tessellation, cells);
      expect(snapshot.cells.map((cell) => cell.boundary.commands), kind).toEqual(outlines.map((outline) => outline.commands));
    }
  });

  it("shares one allowed group between cells of the same shape", () => {
    const cfg = fieldOf("square", { shape: "custom", points: [[0, 0], [2, 2]] });
    const snapshot = mazeService.getGeometrySnapshot({ tessellation: cfg.tessellation, cells: [[0, 0], [1, 0]], boundary: { kind: "path" }, fieldVersion: 1 });
    expect(snapshot.cells[0].allowed_group).toBe(snapshot.cells[1].allowed_group);
    expect(snapshot.cells[0].allowed_group?.[0]).toEqual([0, 1, 2, 3]);
  });

  it("prefetches cells outside the field in chunked snapshot calls, once each", () => {
    const square = fieldOf("square", { shape: "custom", points: [[0, 0]] });
    warmCartesianCache(square);
    const spy = vi.spyOn(mazeService, "getGeometrySnapshot");
    const outside: [number, number][] = Array.from({ length: 1500 }, (_, i) => [100 + i, 100]);
    prefetchCellGeometries([[0, 0], ...outside, outside[0]], square);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls.map(([request]) => request.cells.length)).toEqual([1000, 500]);
    expect(spy.mock.calls.flatMap(([request]) => request.cells)).not.toContainEqual([0, 0]);
    getCellGeometry(100, 100, square);
    getCellGeometry(1599, 100, square);
    prefetchCellGeometries(outside, square);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it("builds a path from face segments: a move to the first start, then one command per segment", () => {
    const face = (segments: mazeService.SegmentDto[]) => ({ neighbor: null, canonical_face: null, contact_point: [0, 0] as [number, number], segments });
    expect(mazeService.pathCommandsOfFaces([])).toEqual([]);
    expect(
      mazeService.pathCommandsOfFaces([
        face([{ kind: "line", from: [0, 0], to: [1, 0] }]),
        face([{ kind: "arc", from: [1, 0], to: [0, 1], center: [0, 0], radius: 1, start_angle: 0, sweep: -Math.PI / 2 }]),
        face([]),
      ]),
    ).toEqual([
      { op: "move_to", to: [0, 0] },
      { op: "line_to", to: [1, 0] },
      { op: "arc_to", center: [0, 0], radius: 1, start_angle: 0, end_angle: -Math.PI / 2, ccw: false },
    ]);
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
