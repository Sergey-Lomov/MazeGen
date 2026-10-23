import { describe, it, expect } from "vitest";
import { TILE_SIZE } from "../pixi/constants";
import { TESSELLATION_UI } from "../pixi/geometry/tessellationUi";
import { getConnectorAxes } from "../pixi/renderers/teleportConnectorAxes";
import { fieldOf } from "./fieldConfigFixtures";

const { getCellVertices, getCellCenter, getNeighborData, getSharedEdgeSegment, nearestCellCoord, anchorCanonicalFaces } = await import("../pixi/tessellationGeometry");

const cfg = fieldOf("rhombitrihexagonal", { shape: "rect", cols: 3, rows: 3 });
// Wire cells are `[6q + kind, r]` with kind 0 hexagon, 1..3 squares across hexagon faces 0..2, 4 and 5 triangles.
const HEXAGON: [number, number] = [0, 0];
const SQUARES: [number, number][] = [[1, 0], [2, 0], [3, 0]];
const TRIANGLES: [number, number][] = [[4, 0], [5, 0]];

const kindOf = (x: number) => ((x % 6) + 6) % 6;

describe("rhombitrihexagonal registry", () => {
  it("is registered without orientations or params", () => {
    const ui = TESSELLATION_UI.rhombitrihexagonal;
    expect(ui.orientations).toEqual([]);
    expect(ui.defaultParams).toEqual({});
    expect(ui.orientationSlot).toBeNull();
    expect(ui.originCell).toEqual([0, 0]);
  });

  it("offers six bend axes 30 degrees apart", () => {
    const axes = getConnectorAxes(cfg);
    expect(axes).toHaveLength(6);
    for (let i = 0; i < axes.length; i++) {
      const next = axes[(i + 1) % axes.length];
      expect(Math.abs(axes[i].ux * next.ux + axes[i].uy * next.uy)).toBeCloseTo(Math.cos(Math.PI / 6), 9);
    }
  });
});

describe("rhombitrihexagonal cell geometry", () => {
  it("draws hexagon, squares and triangles with sides of TILE_SIZE", () => {
    for (const [cell, count] of [[HEXAGON, 6], ...SQUARES.map((c) => [c, 4]), ...TRIANGLES.map((c) => [c, 3])] as [[number, number], number][]) {
      const vertices = getCellVertices(cell[0], cell[1], cfg)!;
      expect(vertices).toHaveLength(count);
      for (let i = 0; i < count; i++) {
        const a = vertices[i];
        const b = vertices[(i + 1) % count];
        expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(TILE_SIZE, 6);
      }
    }
  });

  it("gives every cell the 3.4.6.4 neighbors", () => {
    const kinds = (cell: [number, number]) =>
      getNeighborData(cfg, ...cell).offsets.map(([dx]) => kindOf(cell[0] + dx));
    expect(kinds(HEXAGON).sort((a, b) => a - b)).toEqual([1, 1, 2, 2, 3, 3]);
    for (const cell of [...SQUARES, [-6, 1], [-4, -1]] as [number, number][]) {
      const around = kinds(cell);
      if (kindOf(cell[0]) >= 1 && kindOf(cell[0]) <= 3) {
        expect(around.filter((k) => k === 0)).toHaveLength(2);
        expect(around.filter((k) => k >= 4)).toHaveLength(2);
      }
    }
    for (const cell of TRIANGLES) {
      const around = kinds(cell);
      expect(around).toHaveLength(3);
      expect(around.every((k) => k >= 1 && k <= 3)).toBe(true);
    }
  });

  it("shares each edge between neighbors with the same endpoints", () => {
    for (const cell of [HEXAGON, ...SQUARES, ...TRIANGLES, [-6, 2], [-2, -1]] as [number, number][]) {
      const { offsets } = getNeighborData(cfg, ...cell);
      for (const [dx, dy] of offsets) {
        const other: [number, number] = [cell[0] + dx, cell[1] + dy];
        const forward = getSharedEdgeSegment(cell, other, cfg)!;
        const backward = getSharedEdgeSegment(other, cell, cfg)!;
        expect(forward).not.toBeNull();
        const ends = (e: typeof forward) => [e.v0, e.v1].map((p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`).sort();
        expect(ends(forward)).toEqual(ends(backward));
        expect(Math.hypot(forward.v1.x - forward.v0.x, forward.v1.y - forward.v0.y)).toBeCloseTo(TILE_SIZE, 6);
      }
    }
  });

  it("resolves every cell's own center back to itself, negative coordinates included", () => {
    for (let x = -12; x <= 12; x++) {
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
