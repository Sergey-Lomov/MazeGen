import { describe, it, expect } from "vitest";
import { TILE_SIZE } from "../pixi/constants";
import { TESSELLATION_UI } from "../pixi/geometry/tessellationUi";
import { getConnectorAxes } from "../pixi/renderers/teleportConnectorAxes";
import { fieldOf } from "./fieldConfigFixtures";

const { getCellVertices, getCellCenter, getNeighborData, getSharedEdgeSegment, nearestCellCoord, anchorCanonicalFaces } = await import("../pixi/tessellationGeometry");

const cfg = fieldOf("trihexagonal", { shape: "rect", cols: 3, rows: 3 });
// Wire cells are `[3q + kind, r]` with kind 0 hexagon, 1 up triangle, 2 down triangle.
const HEXAGON: [number, number] = [0, 0];
const UP: [number, number] = [1, 0];
const DOWN: [number, number] = [2, 0];

describe("trihexagonal registry", () => {
  it("is registered without orientations or params", () => {
    const ui = TESSELLATION_UI.trihexagonal;
    expect(ui.orientations).toEqual([]);
    expect(ui.defaultParams).toEqual({});
    expect(ui.orientationSlot).toBeNull();
    expect(ui.originCell).toEqual([0, 0]);
  });

  it("offers three bend axes 60 degrees apart", () => {
    const axes = getConnectorAxes(cfg);
    expect(axes).toHaveLength(3);
    for (let i = 0; i < axes.length; i++) {
      const next = axes[(i + 1) % axes.length];
      expect(Math.abs(axes[i].ux * next.ux + axes[i].uy * next.uy)).toBeCloseTo(0.5, 9);
    }
  });
});

describe("trihexagonal cell geometry", () => {
  it("draws a hexagon and both triangles with sides of TILE_SIZE", () => {
    for (const [cell, count] of [[HEXAGON, 6], [UP, 3], [DOWN, 3]] as const) {
      const vertices = getCellVertices(cell[0], cell[1], cfg)!;
      expect(vertices).toHaveLength(count);
      for (let i = 0; i < count; i++) {
        const a = vertices[i];
        const b = vertices[(i + 1) % count];
        expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(TILE_SIZE, 6);
      }
    }
  });

  it("gives a hexagon six triangle neighbors and a triangle three hexagon neighbors", () => {
    const hexagon = getNeighborData(cfg, ...HEXAGON).offsets;
    expect(hexagon).toHaveLength(6);
    expect(hexagon.every(([dx]) => ((HEXAGON[0] + dx) % 3 + 3) % 3 !== 0)).toBe(true);
    for (const cell of [UP, DOWN, [-2, -1], [-1, 2]] as [number, number][]) {
      const offsets = getNeighborData(cfg, ...cell).offsets;
      expect(offsets).toHaveLength(3);
      expect(offsets.every(([dx]) => ((cell[0] + dx) % 3 + 3) % 3 === 0)).toBe(true);
    }
  });

  it("shares each edge between neighbors with the same endpoints", () => {
    for (const cell of [HEXAGON, UP, DOWN, [-3, 2], [-2, -1]] as [number, number][]) {
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
    for (let x = -6; x <= 6; x++) {
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
