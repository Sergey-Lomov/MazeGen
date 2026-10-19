import { describe, it, expect } from "vitest";
import { TILE_SIZE } from "../pixi/constants";
import { TESSELLATION_UI } from "../pixi/geometry/tessellationUi";
import { getConnectorAxes } from "../pixi/renderers/teleportConnectorAxes";
import { fieldOf } from "./fieldConfigFixtures";

const { getCellVertices, getCellCenter, getNeighborData, getSharedEdgeSegment, nearestCellCoord, anchorCanonicalFaces } = await import("../pixi/tessellationGeometry");

const cfg = fieldOf("elongated_triangular", { shape: "rect", cols: 3, rows: 3 });
// Wire cells are `[3x + kind, y]` with kind 0 square, 1 triangle up, 2 triangle down.
const SQUARE: [number, number] = [0, 0];
const TRIANGLES: [number, number][] = [[1, 0], [2, 0]];

const kindOf = (x: number) => ((x % 3) + 3) % 3;

describe("elongated_triangular registry", () => {
  it("is registered without orientations or params", () => {
    const ui = TESSELLATION_UI.elongated_triangular;
    expect(ui.orientations).toEqual([]);
    expect(ui.defaultParams).toEqual({});
    expect(ui.orientationSlot).toBeNull();
    expect(ui.originCell).toEqual([0, 0]);
    expect(ui.cellSidePx).toBe(TILE_SIZE * 1.5);
  });

  it("offers three distinct axes and never the vertical one", () => {
    const axes = getConnectorAxes(cfg);
    expect(axes).toHaveLength(3);
    expect(axes.some((a) => Math.abs(a.ux) < 1e-9)).toBe(false);
  });

  it("never runs an axis line through a cell center along a cell edge", () => {
    const cells: [number, number][] = [];
    for (let x = -8; x <= 8; x++) for (let y = -3; y <= 3; y++) cells.push([x, y]);
    const polygons = cells.map(([x, y]) => getCellVertices(x, y, cfg)!);
    for (const axis of getConnectorAxes(cfg)) {
      for (const [x, y] of cells) {
        const c = getCellCenter(x, y, cfg);
        if (Math.hypot(c.x, c.y) > 200) continue;
        const offset = (p: { x: number; y: number }) => Math.abs((p.x - c.x) * axis.uy - (p.y - c.y) * axis.ux);
        for (const vertices of polygons) {
          for (let i = 0; i < vertices.length; i++) {
            const a = vertices[i];
            const b = vertices[(i + 1) % vertices.length];
            expect(offset(a) < 1e-4 && offset(b) < 1e-4).toBe(false);
          }
        }
      }
    }
  });
});

describe("elongated_triangular cell geometry", () => {
  it("draws squares and triangles with sides of 1.5 * TILE_SIZE", () => {
    for (const [cell, count] of [[SQUARE, 4], ...TRIANGLES.map((c) => [c, 3])] as [[number, number], number][]) {
      const vertices = getCellVertices(cell[0], cell[1], cfg)!;
      expect(vertices).toHaveLength(count);
      for (let i = 0; i < count; i++) {
        const a = vertices[i];
        const b = vertices[(i + 1) % count];
        expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(TILE_SIZE * 1.5, 6);
      }
    }
  });

  it("gives every cell the 3.3.3.4.4 neighbors", () => {
    const kinds = (cell: [number, number]) =>
      getNeighborData(cfg, ...cell).offsets.map(([dx]) => kindOf(cell[0] + dx));
    for (const cell of [SQUARE, [-3, 1], [6, -2]] as [number, number][]) {
      const around = kinds(cell);
      expect(around).toHaveLength(4);
      expect(around.filter((k) => k === 0)).toHaveLength(2);
    }
    for (const cell of [...TRIANGLES, [-5, 1], [-4, -1]] as [number, number][]) {
      const around = kinds(cell);
      expect(around).toHaveLength(3);
      expect(around.filter((k) => k === 0)).toHaveLength(1);
    }
  });

  it("shares each edge between neighbors with the same endpoints", () => {
    for (const cell of [SQUARE, ...TRIANGLES, [-3, 2], [-2, -1]] as [number, number][]) {
      const { offsets } = getNeighborData(cfg, ...cell);
      for (const [dx, dy] of offsets) {
        const other: [number, number] = [cell[0] + dx, cell[1] + dy];
        const forward = getSharedEdgeSegment(cell, other, cfg)!;
        const backward = getSharedEdgeSegment(other, cell, cfg)!;
        expect(forward).not.toBeNull();
        const ends = (e: typeof forward) => [e.v0, e.v1].map((p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`).sort();
        expect(ends(forward)).toEqual(ends(backward));
        expect(Math.hypot(forward.v1.x - forward.v0.x, forward.v1.y - forward.v0.y)).toBeCloseTo(TILE_SIZE * 1.5, 6);
      }
    }
  });

  it("resolves every cell's own center back to itself, negative coordinates included", () => {
    for (let x = -9; x <= 9; x++) {
      for (let y = -4; y <= 4; y++) {
        const center = getCellCenter(x, y, cfg);
        expect(nearestCellCoord(center.x, center.y, cfg)).toEqual([x, y]);
      }
    }
  });

  it("reads the anchor cell's faces as a permutation of the template's canonical faces", () => {
    const faces = anchorCanonicalFaces(cfg);
    expect([...faces].sort((a, b) => a - b)).toEqual(faces.map((_, i) => i));
  });
});
