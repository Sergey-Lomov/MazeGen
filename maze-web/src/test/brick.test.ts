import { describe, it, expect } from "vitest";
import { TILE_SIZE } from "../pixi/constants";
import { TESSELLATION_UI } from "../pixi/geometry/tessellationUi";
import { getConnectorAxes } from "../pixi/renderers/teleportConnectorAxes";
import { fieldOf } from "./fieldConfigFixtures";

const { getCellVertices, getCellCenter, getNeighborData, getSharedEdgeSegment, nearestCellCoord, anchorCanonicalFaces } = await import("../pixi/tessellationGeometry");

const cfg = fieldOf("brick", { shape: "rect", cols: 3, rows: 3 });
const EVEN_ROW: [number, number] = [0, 0];
const ODD_ROW: [number, number] = [0, 1];

describe("brick registry", () => {
  it("is registered without orientations or params", () => {
    const ui = TESSELLATION_UI.brick;
    expect(ui.orientations).toEqual([]);
    expect(ui.defaultParams).toEqual({});
    expect(ui.orientationSlot).toBeNull();
    expect(ui.originCell).toEqual([0, 0]);
  });

  it("offers the horizontal and vertical bend axes", () => {
    const axes = getConnectorAxes(cfg);
    expect(axes).toHaveLength(2);
    expect(Math.abs(axes[0].ux * axes[1].ux + axes[0].uy * axes[1].uy)).toBeCloseTo(0, 9);
  });
});

describe("brick cell geometry", () => {
  it("draws every brick as a TILE_SIZE square", () => {
    for (const cell of [EVEN_ROW, ODD_ROW]) {
      const vertices = getCellVertices(cell[0], cell[1], cfg)!;
      const xs = vertices.map((v) => v.x);
      const ys = vertices.map((v) => v.y);
      expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(TILE_SIZE, 6);
      expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(TILE_SIZE, 6);
    }
  });

  it("shifts odd rows by half a cell", () => {
    const even = getCellCenter(0, 0, cfg);
    const odd = getCellCenter(0, 1, cfg);
    expect(Math.abs(odd.x - even.x)).toBeCloseTo(TILE_SIZE / 2, 6);
  });

  it("gives every brick six neighbors, two per adjacent row", () => {
    for (const cell of [EVEN_ROW, ODD_ROW, [-3, -2], [-2, -3]] as [number, number][]) {
      const { offsets } = getNeighborData(cfg, ...cell);
      expect(offsets).toHaveLength(6);
      expect(offsets.filter(([, dy]) => dy === 1)).toHaveLength(2);
      expect(offsets.filter(([, dy]) => dy === -1)).toHaveLength(2);
      expect(offsets.filter(([, dy]) => dy === 0)).toHaveLength(2);
    }
  });

  it("shares half an edge with a neighbor in an adjacent row and a whole edge within the row", () => {
    for (const cell of [EVEN_ROW, ODD_ROW, [-2, -3]] as [number, number][]) {
      const { offsets } = getNeighborData(cfg, ...cell);
      for (const [dx, dy] of offsets) {
        const other: [number, number] = [cell[0] + dx, cell[1] + dy];
        const forward = getSharedEdgeSegment(cell, other, cfg)!;
        const backward = getSharedEdgeSegment(other, cell, cfg)!;
        expect(forward).not.toBeNull();
        const ends = (e: typeof forward) => [e.v0, e.v1].map((p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`).sort();
        expect(ends(forward)).toEqual(ends(backward));
        const length = Math.hypot(forward.v1.x - forward.v0.x, forward.v1.y - forward.v0.y);
        expect(length).toBeCloseTo(dy === 0 ? TILE_SIZE : TILE_SIZE / 2, 6);
      }
    }
  });

  it("resolves every brick's own center back to itself, negative coordinates included", () => {
    for (let x = -4; x <= 4; x++) {
      for (let y = -4; y <= 4; y++) {
        const center = getCellCenter(x, y, cfg);
        expect(nearestCellCoord(center.x, center.y, cfg)).toEqual([x, y]);
      }
    }
  });

  it("reads the anchor brick's faces as a permutation of the template's canonical faces", () => {
    const faces = anchorCanonicalFaces(cfg);
    expect(faces).toHaveLength(6);
    expect([...faces].sort((a, b) => a - b)).toEqual(faces.map((_, i) => i));
  });
});
