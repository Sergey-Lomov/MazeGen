import { describe, it, expect, vi } from "vitest";
import { TESSELLATION_UI } from "../pixi/geometry/tessellationUi";
import { getConnectorAxes } from "../pixi/renderers/teleportConnectorAxes";
import type { Graphics } from "pixi.js";
import { drawCellHighlightAt } from "../pixi/cellHighlightGeometry";
import { fieldOf } from "./fieldConfigFixtures";

/** Pixels per unit of core space: the underlying square's side. */
const UNIT = TESSELLATION_UI.curved_quadrilateral.pixelsPerUnit;

const { getCellPath, getCellCenter, getNeighborData, getSharedEdgeSegment, nearestCellCoord, pointInPolygon, getCellVertices } = await import("../pixi/tessellationGeometry");

const cfg = fieldOf("curved_quadrilateral", { shape: "rect", cols: 4, rows: 4 });
const CELLS: [number, number][] = [[0, 0], [1, 0], [0, 1], [-1, -1], [-2, 3]];

describe("curved quadrilateral registry", () => {
  it("is registered without orientations or params", () => {
    const ui = TESSELLATION_UI.curved_quadrilateral;
    expect(ui.orientations).toEqual([]);
    expect(ui.defaultParams).toEqual({});
    expect(ui.orientationSlot).toBeNull();
    expect(ui.originCell).toEqual([0, 0]);
  });

  it("bends connectors along the square axes", () => {
    expect(getConnectorAxes(cfg)).toHaveLength(2);
  });
});

describe("curved quadrilateral cell geometry", () => {
  it("draws every side as an arc, two convex and two concave", () => {
    for (const cell of CELLS) {
      const arcs = getCellPath(cell[0], cell[1], cfg).filter((command) => command.op === "arc_to");
      expect(arcs, `${cell}`).toHaveLength(4);
      const center = getCellCenter(cell[0], cell[1], cfg);
      // A convex side is an arc around the cell's own center.
      const own = arcs.filter((arc) => Math.hypot(arc.center[0] - center.x, arc.center[1] - center.y) < 1e-6);
      expect(own, `${cell}`).toHaveLength(2);
    }
  });

  it("gives every cell four neighbors", () => {
    for (const cell of CELLS) expect(getNeighborData(cfg, ...cell).offsets).toHaveLength(4);
  });

  it("shares each arc edge between neighbors with the same endpoints and contact point", () => {
    for (const cell of CELLS) {
      for (const [dx, dy] of getNeighborData(cfg, ...cell).offsets) {
        const other: [number, number] = [cell[0] + dx, cell[1] + dy];
        const forward = getSharedEdgeSegment(cell, other, cfg)!;
        const backward = getSharedEdgeSegment(other, cell, cfg)!;
        const ends = (e: typeof forward) => [e.v0, e.v1].map((p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`).sort();
        expect(ends(forward)).toEqual(ends(backward));
        expect(forward.contact).toEqual(backward.contact);
        expect(forward.path.some((command) => command.op === "arc_to")).toBe(true);
        const chord = Math.hypot(forward.v1.x - forward.v0.x, forward.v1.y - forward.v0.y);
        expect(chord).toBeCloseTo(UNIT, 6);
      }
    }
  });

  it("resolves every cell's own center back to itself, negative coordinates included", () => {
    for (let x = -6; x <= 6; x++) {
      for (let y = -6; y <= 6; y++) {
        const center = getCellCenter(x, y, cfg);
        expect(nearestCellCoord(center.x, center.y, cfg)).toEqual([x, y]);
      }
    }
  });

  it("hit-tests a point inside the bulge but outside the square to the bulging cell", () => {
    const vertices = getCellVertices(0, 0, cfg);
    const center = getCellCenter(0, 0, cfg);
    // Cell (0, 0) is even: its east side bulges, so a point just past the square's east edge is inside.
    expect(pointInPolygon({ x: center.x + UNIT * 0.6, y: center.y }, vertices)).toBe(true);
    expect(pointInPolygon({ x: center.x + UNIT * 0.75, y: center.y }, vertices)).toBe(false);
  });
});

describe("curved quadrilateral cell highlight", () => {
  function recorder() {
    const points: [number, number][] = [];
    const chain = { fill: vi.fn(() => chain), stroke: vi.fn(() => chain), closePath: vi.fn(() => chain) };
    const g = {
      ...chain,
      moveTo: (x: number, y: number) => { points.push([x, y]); return g; },
      lineTo: (x: number, y: number) => { points.push([x, y]); return g; },
      poly: vi.fn(() => chain),
    };
    return { g: g as unknown as Graphics, points, chain, poly: g.poly };
  }

  it("an uninset highlight follows the arcs: dense points, all within the tile's reach", () => {
    const { g, points, chain, poly } = recorder();
    drawCellHighlightAt(g, 0, 0, cfg, 0xffaa44, 0.5, 0, "round", 0);
    expect(poly).not.toHaveBeenCalled();
    expect(points.length).toBeGreaterThan(40);
    expect(chain.closePath).toHaveBeenCalledTimes(1);
    const center = getCellCenter(0, 0, cfg);
    for (const [x, y] of points) expect(Math.hypot(x - center.x, y - center.y)).toBeLessThanOrEqual(UNIT * Math.SQRT1_2 + 1e-6);
  });

  it("an inset highlight is a polygon strictly inside the cell", () => {
    const { g, poly } = recorder();
    drawCellHighlightAt(g, 0, 0, cfg, 0xffaa44, 0.5, 6, "sharp", 0);
    const [flat] = poly.mock.calls[0] as unknown as [number[]];
    const vertices = getCellVertices(0, 0, cfg);
    expect(flat.length / 2).toBe(vertices.length);
    for (let i = 0; i < flat.length; i += 2) {
      expect(pointInPolygon({ x: flat[i], y: flat[i + 1] }, vertices)).toBe(true);
    }
  });
});
