import { describe, it, expect } from "vitest";
import { TESSELLATION_UI } from "../pixi/geometry/tessellationUi";
import { getConnectorAxes } from "../pixi/renderers/teleportConnectorAxes";
import { buildSplitPassages } from "../pixi/selectors/mazeSelectors";
import { tessellationConfigOf, type FieldConfig } from "../fieldConfig";
import type { EdgeDto, NodeDto } from "../wasm/types";

const { getCellPath, getCellCenter, getNeighborData, getSharedEdgeSegment, nearestCellCoord, pointInPolygon, getCellVertices } = await import("../pixi/tessellationGeometry");

// 9 first-ring cells, classic layout: rings 1-4 hold 9, 18, 18 and 36 cells.
const cfg: FieldConfig = { tessellation: tessellationConfigOf("radial"), shape: { shape: "circle", radius: 4 } };
const CELLS: [number, number][] = [[0, 0], [1, 0], [1, 4], [2, 7], [3, 0], [3, 17], [4, 13]];
const node = (id: number, x: number, y: number): NodeDto => ({ id, x, y, i: 0 });
const edge = (from: number, to: number): EdgeDto => ({ from, to, kind: "basic" });

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
        spec.type === "choice"
          ? spec.options.includes(value as string)
          : Number.isInteger(value) && (value as number) >= spec.min && (value as number) <= spec.max;
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

describe("radial split special shapes", () => {
  // Ring 2 cell 7 has one outer and one inner neighbor, plus its two ring neighbors: the
  // four-face radial template that has the same opposite/adjacent topology as a square.
  const point: [number, number] = [2, 7];

  function splitInput(facePairs: [number[], number[]]) {
    const { offsets } = getNeighborData(cfg, ...point);
    const neighbors = offsets.map(([dx, dy], face) => node(face + 2, point[0] + dx, point[1] + dy));
    const edges = facePairs.flatMap((faces, nodeIndex) => faces.flatMap((face) => [
      edge(nodeIndex, face + 2), edge(face + 2, nodeIndex),
    ]));
    return { nodes: [node(0, ...point), node(1, ...point), ...neighbors], edges };
  }

  it("renders a bridge for the two radial opposite-face pairs", () => {
    const { nodes, edges } = splitInput([[0, 2], [1, 3]]);
    const shapes = buildSplitPassages(nodes, edges, cfg).specialShapes;

    expect(shapes).toHaveLength(1);
    expect(shapes[0]).toMatchObject({ kind: "bridge", pointKey: "2,7" });
    if (shapes[0].kind !== "bridge") throw new Error("unreachable");
    expect(shapes[0].edge0).toHaveLength(4);
    expect(shapes[0].edge1).toHaveLength(4);
  });

  it("renders a diagonal divider for the two radial adjacent-face pairs", () => {
    const { nodes, edges } = splitInput([[0, 1], [2, 3]]);
    const shapes = buildSplitPassages(nodes, edges, cfg).specialShapes;

    expect(shapes).toHaveLength(1);
    expect(shapes[0]).toMatchObject({ kind: "diagonal", pointKey: "2,7" });
    if (shapes[0].kind !== "diagonal") throw new Error("unreachable");
    const vertices = getCellVertices(...point, cfg);
    expect(vertices).toContainEqual(shapes[0].corner0);
    expect(vertices).toContainEqual(shapes[0].corner1);
    expect(shapes[0].corner0).not.toEqual(shapes[0].corner1);
  });
});
