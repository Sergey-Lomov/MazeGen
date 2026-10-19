import { describe, it, expect } from "vitest";
import { TILE_SIZE } from "../pixi/constants";
import { TESSELLATION_UI } from "../pixi/geometry/tessellationUi";
import { getConnectorAxes } from "../pixi/renderers/teleportConnectorAxes";
import { fieldOf } from "./fieldConfigFixtures";

const { getCellVertices, getCellCenter, getNeighborData, getSharedEdgeSegment, nearestCellCoord, anchorCanonicalFaces } = await import("../pixi/tessellationGeometry");

const cfg = fieldOf("truncated_trihexagonal", { shape: "rect", cols: 3, rows: 3 });
// Wire cells are `[6q + kind, r]` with kind 0 dodecagon, 1-3 squares (three orientations) and
// 4-5 hexagons.
const DODECAGON: [number, number] = [0, 0];
const SQUARES: [number, number][] = [[1, 0], [2, 0], [3, 0]];
const HEXAGONS: [number, number][] = [[4, 0], [5, 0]];

const kindOf = (x: number) => ((x % 6) + 6) % 6;

describe("truncated_trihexagonal registry", () => {
  it("is registered without orientations or params", () => {
    const ui = TESSELLATION_UI.truncated_trihexagonal;
    expect(ui.orientations).toEqual([]);
    expect(ui.defaultParams).toEqual({});
    expect(ui.orientationSlot).toBeNull();
    expect(ui.originCell).toEqual([0, 0]);
    expect(ui.cellSidePx).toBe(TILE_SIZE);
  });

  it("offers the three lattice axes 60 degrees apart", () => {
    const axes = getConnectorAxes(cfg);
    expect(axes).toHaveLength(3);
    for (let i = 0; i < axes.length; i++) {
      const next = axes[(i + 1) % axes.length];
      expect(Math.abs(axes[i].ux * next.ux + axes[i].uy * next.uy)).toBeCloseTo(0.5, 9);
    }
  });

  it("never runs an axis line through a cell center along a cell edge", () => {
    const cells: [number, number][] = [];
    for (let x = -12; x <= 12; x++) for (let y = -4; y <= 4; y++) cells.push([x, y]);
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

describe("truncated_trihexagonal cell geometry", () => {
  it("draws dodecagons, squares and hexagons with sides of TILE_SIZE", () => {
    for (const [cell, count] of [[DODECAGON, 12], ...SQUARES.map((c) => [c, 4]), ...HEXAGONS.map((c) => [c, 6])] as [[number, number], number][]) {
      const vertices = getCellVertices(cell[0], cell[1], cfg)!;
      expect(vertices).toHaveLength(count);
      for (let i = 0; i < count; i++) {
        const a = vertices[i];
        const b = vertices[(i + 1) % count];
        expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(TILE_SIZE, 6);
      }
    }
  });

  it("gives every cell the 4.6.12 neighbors", () => {
    const kinds = (cell: [number, number]) =>
      getNeighborData(cfg, ...cell).offsets.map(([dx]) => kindOf(cell[0] + dx));
    const count = (list: number[], pred: (k: number) => boolean) => list.filter(pred).length;
    const around = kinds(DODECAGON);
    expect(around).toHaveLength(12);
    expect(count(around, (k) => k >= 1 && k <= 3)).toBe(6);
    expect(count(around, (k) => k >= 4)).toBe(6);
    for (const cell of [...SQUARES, [-11, 1], [-10, -1]] as [number, number][]) {
      const squareAround = kinds(cell);
      expect(squareAround).toHaveLength(4);
      expect(count(squareAround, (k) => k === 0)).toBe(2);
      expect(count(squareAround, (k) => k >= 4)).toBe(2);
    }
    for (const cell of [...HEXAGONS, [-7, 1], [-2, -1]] as [number, number][]) {
      const hexagonAround = kinds(cell);
      expect(hexagonAround).toHaveLength(6);
      expect(count(hexagonAround, (k) => k === 0)).toBe(3);
      expect(count(hexagonAround, (k) => k >= 1 && k <= 3)).toBe(3);
    }
  });

  it("shares each edge between neighbors with the same endpoints", () => {
    for (const cell of [DODECAGON, ...SQUARES, ...HEXAGONS, [-3, 2], [-2, -1]] as [number, number][]) {
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
