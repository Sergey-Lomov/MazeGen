import { describe, it, expect } from "vitest";
import { TILE_SIZE } from "../pixi/constants";
import { TESSELLATION_UI } from "../pixi/geometry/tessellationUi";
import { getConnectorAxes } from "../pixi/renderers/teleportConnectorAxes";
import { buildCorridorContour } from "../pixi/imageExport/vectorByCorridorsContour";
import { fieldOf } from "./fieldConfigFixtures";

const { getCellVertices, getCellCenter, getNeighborData, getSharedEdgeSegment, nearestCellCoord, anchorCanonicalFaces } = await import("../pixi/tessellationGeometry");

const cfg = fieldOf("square_octagon", { shape: "rect", cols: 3, rows: 3 });
const OCTAGON: [number, number] = [0, 0];
const SQUARE: [number, number] = [1, 1];

describe("square-octagon registry", () => {
  it("is registered without orientations or params", () => {
    const ui = TESSELLATION_UI.square_octagon;
    expect(ui.orientations).toEqual([]);
    expect(ui.defaultParams).toEqual({});
    expect(ui.orientationSlot).toBeNull();
    expect(ui.originCell).toEqual([0, 0]);
  });

  it("offers four bend axes 45 degrees apart", () => {
    const axes = getConnectorAxes(cfg);
    expect(axes).toHaveLength(4);
    for (let i = 0; i < axes.length; i++) {
      const next = axes[(i + 1) % axes.length];
      expect(Math.abs(axes[i].ux * next.ux + axes[i].uy * next.uy)).toBeCloseTo(Math.SQRT1_2, 9);
    }
  });
});

describe("square-octagon cell geometry", () => {
  it("draws an octagon and a square with sides of TILE_SIZE", () => {
    for (const [cell, count] of [[OCTAGON, 8], [SQUARE, 4]] as const) {
      const vertices = getCellVertices(cell[0], cell[1], cfg)!;
      expect(vertices).toHaveLength(count);
      for (let i = 0; i < count; i++) {
        const a = vertices[i];
        const b = vertices[(i + 1) % count];
        expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(TILE_SIZE, 6);
      }
    }
  });

  it("gives an octagon 4 octagon and 4 square neighbors, and a square only octagons", () => {
    const octagon = getNeighborData(cfg, ...OCTAGON).offsets;
    expect(octagon).toHaveLength(8);
    const kinds = octagon.map(([dx, dy]) => (Math.abs(dx) === 2 || Math.abs(dy) === 2 ? "octagon" : "square"));
    expect(kinds.filter((k) => k === "octagon")).toHaveLength(4);
    expect(kinds.filter((k) => k === "square")).toHaveLength(4);
    const square = getNeighborData(cfg, ...SQUARE).offsets;
    expect(square).toHaveLength(4);
    expect(square.every(([dx, dy]) => Math.abs(dx) === 1 && Math.abs(dy) === 1)).toBe(true);
  });

  it("shares each edge between neighbors with the same endpoints", () => {
    for (const cell of [OCTAGON, SQUARE, [-2, 2], [-1, -1]] as [number, number][]) {
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

  it("resolves every tile's own center back to itself, negative coordinates included", () => {
    for (let x = -4; x <= 4; x++) {
      for (let y = -4; y <= 4; y++) {
        if (Math.abs(x % 2) !== Math.abs(y % 2)) continue;
        const center = getCellCenter(x, y, cfg);
        expect(nearestCellCoord(center.x, center.y, cfg)).toEqual([x, y]);
      }
    }
  });

  it("answers nearest-cell lookups far outside the field with a tile", () => {
    for (const [px, py] of [[37, -91], [-250, 400], [1234, 56]]) {
      const [x, y] = nearestCellCoord(px, py, cfg);
      expect(Math.abs(x % 2)).toBe(Math.abs(y % 2));
    }
  });

  it("reads the anchor tile's faces as a permutation of the template's canonical faces", () => {
    const faces = anchorCanonicalFaces(cfg);
    expect([...faces].sort((a, b) => a - b)).toEqual(faces.map((_, i) => i));
  });
});

describe("square-octagon corridor contour", () => {
  it("builds a closed contour through an octagon and a square", () => {
    const octagon = getCellVertices(...OCTAGON, cfg)!;
    const square = getCellVertices(...SQUARE, cfg)!;
    const edge = getSharedEdgeSegment(OCTAGON, SQUARE, cfg)!;
    const paths = buildCorridorContour(
      [{ v0: edge.v0, v1: edge.v1, cellVertices0: octagon, cellVertices1: square }],
      TILE_SIZE / 4,
    );
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((path) => path.cmds.length > 2)).toBe(true);
  });
});
