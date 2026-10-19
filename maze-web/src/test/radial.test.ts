import { describe, it, expect } from "vitest";
import { TESSELLATION_UI } from "../pixi/geometry/tessellationUi";
import { getConnectorAxes } from "../pixi/renderers/teleportConnectorAxes";
import { tessellationConfigOf, type FieldConfig } from "../fieldConfig";

const { getCellPath, getCellCenter, getNeighborData, getSharedEdgeSegment, nearestCellCoord, pointInPolygon, getCellVertices } = await import("../pixi/tessellationGeometry");

// 9 first-ring cells, classic layout: rings 1-4 hold 9, 18, 18 and 36 cells.
const cfg: FieldConfig = { tessellation: tessellationConfigOf("radial"), shape: { shape: "circle", radius: 4 } };
const CELLS: [number, number][] = [[0, 0], [1, 0], [1, 4], [2, 7], [3, 0], [3, 17], [4, 13]];

describe("radial registry", () => {
  it("is registered with an integer size param and no orientations", () => {
    const ui = TESSELLATION_UI.radial;
    expect(ui.orientations).toEqual([]);
    expect(ui.orientationSlot).toBeNull();
    expect(ui.paramSpecs.map((spec) => spec.name)).toEqual(["first_ring_cells", "ring_layout", "max_cells"]);
    expect(Object.keys(ui.defaultParams)).toEqual(ui.paramSpecs.map((spec) => spec.name));
    for (const spec of ui.paramSpecs) {
      const value = ui.defaultParams[spec.name];
      const valid =
        spec.type === "integer"
          ? Number.isInteger(value) && (value as number) >= spec.min && (value as number) <= spec.max
          : spec.options.includes(value as string);
      expect(valid, spec.name).toBe(true);
    }
  });

  it("has connector axes", () => {
    expect(getConnectorAxes(cfg).length).toBeGreaterThan(0);
  });
});

describe("radial cell geometry", () => {
  it("draws ring cells with arc sides and the center with arcs only", () => {
    for (const cell of CELLS) {
      const path = getCellPath(cell[0], cell[1], cfg);
      expect(path.some((command) => command.op === "arc_to"), `${cell}`).toBe(true);
    }
    expect(getCellPath(0, 0, cfg).every((command) => command.op !== "line_to")).toBe(true);
  });

  it("gives a cell as many neighbors as faces: nine around the center, five on the inner rings", () => {
    expect(getNeighborData(cfg, 0, 0).offsets).toHaveLength(9);
    // Ring 1 cell 0 touches two ring-2 cells, the center and its two sides.
    expect(getNeighborData(cfg, 1, 0).offsets).toHaveLength(5);
    // Rings 2 and 3 have the same count: one cell outside, one inside, two sides.
    expect(getNeighborData(cfg, 2, 1).offsets).toHaveLength(4);
    // Ring 3 touches two ring-4 cells.
    expect(getNeighborData(cfg, 3, 1).offsets).toHaveLength(5);
  });

  it("keeps neighbor links reciprocal", () => {
    for (const cell of CELLS) {
      for (const [dx, dy] of getNeighborData(cfg, ...cell).offsets) {
        const other: [number, number] = [cell[0] + dx, cell[1] + dy];
        const back = getNeighborData(cfg, ...other).offsets.map(([bx, by]) => [other[0] + bx, other[1] + by]);
        expect(back, `${cell} -> ${other}`).toContainEqual(cell);
      }
    }
  });

  it("shares each boundary between neighbors with the same endpoints and contact point", () => {
    for (const cell of CELLS) {
      for (const [dx, dy] of getNeighborData(cfg, ...cell).offsets) {
        const other: [number, number] = [cell[0] + dx, cell[1] + dy];
        const forward = getSharedEdgeSegment(cell, other, cfg)!;
        const backward = getSharedEdgeSegment(other, cell, cfg)!;
        const ends = (e: typeof forward) => [e.v0, e.v1].map((p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`).sort();
        expect(ends(forward), `${cell} | ${other}`).toEqual(ends(backward));
        expect(forward.contact).toEqual(backward.contact);
      }
    }
  });

  it("resolves every cell's own center back to itself", () => {
    for (const cell of CELLS) {
      const center = getCellCenter(cell[0], cell[1], cfg);
      expect(nearestCellCoord(center.x, center.y, cfg), `${cell}`).toEqual(cell);
    }
  });

  it("hit-tests a ring cell's center inside its polygon and a neighbor's outside", () => {
    const vertices = getCellVertices(2, 7, cfg);
    expect(pointInPolygon(getCellCenter(2, 7, cfg), vertices)).toBe(true);
    expect(pointInPolygon(getCellCenter(2, 2, cfg), vertices)).toBe(false);
  });
});
