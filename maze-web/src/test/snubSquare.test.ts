import { describe, it, expect } from "vitest";
import { TESSELLATION_UI } from "../pixi/geometry/tessellationUi";
import { getConnectorAxes } from "../pixi/renderers/teleportConnectorAxes";
import { fieldOf } from "./fieldConfigFixtures";

const { getCellVertices, getCellCenter, getNeighborData, getSharedEdgeSegment, nearestCellCoord, anchorCanonicalFaces } = await import("../pixi/tessellationGeometry");

// Pixels per world unit: a side is drawn 60 px long.
const SIDE_PX = 60;

const cfg = fieldOf("snub_square", { shape: "rect", cols: 3, rows: 3 });
// Wire cells are `[6q + kind, r]` with kind 0 and 1 squares, 2-5 triangles.
const SQUARES: [number, number][] = [[0, 0], [1, 0]];
const TRIANGLES: [number, number][] = [[2, 0], [3, 0], [4, 0], [5, 0]];

const kindOf = (x: number) => ((x % 6) + 6) % 6;

describe("snub_square registry", () => {
  it("is registered without orientations or params", () => {
    const ui = TESSELLATION_UI.snub_square;
    expect(ui.orientations).toEqual([]);
    expect(ui.defaultParams).toEqual({});
    expect(ui.orientationSlot).toBeNull();
    expect(ui.originCell).toEqual([0, 0]);
    expect(ui.cellSidePx).toBe(SIDE_PX);
  });

  it("offers six axes 30 degrees apart", () => {
    const axes = getConnectorAxes(cfg);
    expect(axes).toHaveLength(6);
    for (let i = 0; i < axes.length; i++) {
      const next = axes[(i + 1) % axes.length];
      expect(Math.abs(axes[i].ux * next.ux + axes[i].uy * next.uy)).toBeCloseTo(Math.cos(Math.PI / 6), 9);
    }
  });

  it("never runs an axis line through a cell center along a cell edge", () => {
    const cells: [number, number][] = [];
    for (let x = -12; x <= 12; x++) for (let y = -4; y <= 4; y++) cells.push([x, y]);
    const polygons = cells.map(([x, y]) => getCellVertices(x, y, cfg)!);
    // The tiling repeats under the lattice, so the centers of one lattice cell and its neighbors suffice.
    const centers = cells.filter(([x, y]) => x >= 0 && x < 12 && y >= 0 && y <= 1);
    for (const axis of getConnectorAxes(cfg)) {
      for (const [x, y] of centers) {
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

describe("snub_square cell geometry", () => {
  it("draws squares and triangles with sides of SIDE_PX", () => {
    for (const [cell, count] of [...SQUARES.map((c) => [c, 4]), ...TRIANGLES.map((c) => [c, 3])] as [[number, number], number][]) {
      const vertices = getCellVertices(cell[0], cell[1], cfg)!;
      expect(vertices).toHaveLength(count);
      for (let i = 0; i < count; i++) {
        const a = vertices[i];
        const b = vertices[(i + 1) % count];
        expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(SIDE_PX, 6);
      }
    }
  });

  it("gives every cell the 3.3.4.3.4 neighbors", () => {
    const kinds = (cell: [number, number]) =>
      getNeighborData(cfg, ...cell).offsets.map(([dx]) => kindOf(cell[0] + dx));
    const squaresAmong = (list: number[]) => list.filter((k) => k <= 1).length;
    for (const cell of [...SQUARES, [-6, 1], [-5, -1]] as [number, number][]) {
      const around = kinds(cell);
      expect(around).toHaveLength(4);
      expect(squaresAmong(around)).toBe(0);
    }
    for (const cell of [...TRIANGLES, [-4, 1], [-1, -1]] as [number, number][]) {
      const around = kinds(cell);
      expect(around).toHaveLength(3);
      expect(squaresAmong(around)).toBe(2);
    }
  });

  it("shares each edge between neighbors with the same endpoints", () => {
    for (const cell of [...SQUARES, ...TRIANGLES, [-3, 2], [-2, -1]] as [number, number][]) {
      const { offsets } = getNeighborData(cfg, ...cell);
      for (const [dx, dy] of offsets) {
        const other: [number, number] = [cell[0] + dx, cell[1] + dy];
        const forward = getSharedEdgeSegment(cell, other, cfg)!;
        const backward = getSharedEdgeSegment(other, cell, cfg)!;
        expect(forward).not.toBeNull();
        const ends = (e: typeof forward) => [e.v0, e.v1].map((p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`).sort();
        expect(ends(forward)).toEqual(ends(backward));
        expect(Math.hypot(forward.v1.x - forward.v0.x, forward.v1.y - forward.v0.y)).toBeCloseTo(SIDE_PX, 6);
      }
    }
  });

  it("resolves every cell's own center back to itself, negative coordinates included", () => {
    for (let x = -18; x <= 18; x++) {
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
