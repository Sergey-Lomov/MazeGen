import { describe, it, expect } from "vitest";
import { TILE_SIZE } from "../pixi/constants";
import { TESSELLATION_UI } from "../pixi/geometry/tessellationUi";
import { getConnectorAxes } from "../pixi/renderers/teleportConnectorAxes";
import { fieldOf } from "./fieldConfigFixtures";

const { getCellVertices, getCellCenter, getNeighborData, getSharedEdgeSegment, nearestCellCoord, anchorCanonicalFaces } = await import("../pixi/tessellationGeometry");

const cfg = fieldOf("truncated_hexagonal", { shape: "rect", cols: 3, rows: 3 });
// Wire cells are `[3q + kind, r]` with kind 0 dodecagon, 1 triangle up, 2 triangle down.
const DODECAGON: [number, number] = [0, 0];
const TRIANGLES: [number, number][] = [[1, 0], [2, 0]];

const kindOf = (x: number) => ((x % 3) + 3) % 3;

describe("truncated_hexagonal registry", () => {
  it("is registered without orientations or params", () => {
    const ui = TESSELLATION_UI.truncated_hexagonal;
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

describe("truncated_hexagonal cell geometry", () => {
  it("draws dodecagons and triangles with sides of TILE_SIZE", () => {
    for (const [cell, count] of [[DODECAGON, 12], ...TRIANGLES.map((c) => [c, 3])] as [[number, number], number][]) {
      const vertices = getCellVertices(cell[0], cell[1], cfg)!;
      expect(vertices).toHaveLength(count);
      for (let i = 0; i < count; i++) {
        const a = vertices[i];
        const b = vertices[(i + 1) % count];
        expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(TILE_SIZE, 6);
      }
    }
  });

  it("gives every cell the 3.12.12 neighbors", () => {
    const kinds = (cell: [number, number]) =>
      getNeighborData(cfg, ...cell).offsets.map(([dx]) => kindOf(cell[0] + dx));
    const around = kinds(DODECAGON);
    expect(around).toHaveLength(12);
    expect(around.filter((k) => k === 0)).toHaveLength(6);
    expect(around.filter((k) => k !== 0)).toHaveLength(6);
    for (const cell of [...TRIANGLES, [-5, 1], [-4, -1]] as [number, number][]) {
      if (kindOf(cell[0]) === 0) continue;
      const triangleAround = kinds(cell);
      expect(triangleAround).toHaveLength(3);
      expect(triangleAround.every((k) => k === 0)).toBe(true);
    }
  });

  it("shares each edge between neighbors with the same endpoints", () => {
    for (const cell of [DODECAGON, ...TRIANGLES, [-3, 2], [-2, -1]] as [number, number][]) {
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
