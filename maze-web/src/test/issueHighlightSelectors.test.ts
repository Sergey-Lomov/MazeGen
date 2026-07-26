import { describe, it, expect, vi } from "vitest";
import type { NodeDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";

// getCellCenter/getCellVertices (via squareGeometry's getCartesian) delegate to wasm, unavailable
// in this unit-test environment -- mock with the canonical square formula (see
// `maze-core/src/space/square.rs`'s `cartesian`: `(x, y)`, no offset/flip applied here).
vi.mock("../wasm/mazeService", () => ({
  getCartesianCoords: (cfg: { points: [number, number][] }) => cfg.points.map(([x, y]) => [x, y]),
}));

const { buildRegionGeometry } = await import("../pixi/selectors/issueHighlightSelectors");

const cfg: TessellationConfig = { type: "square", width: 4, height: 1 };

function node(id: number, x: number, y: number): NodeDto {
  return { id, x, y, i: 0 };
}

describe("buildRegionGeometry", () => {
  it("returns one perimeter segment per exposed side of a single-cell region", () => {
    const nodes = [node(0, 0, 0), node(1, 1, 0)];
    const { cells, perimeterSegments } = buildRegionGeometry([0], nodes, cfg);
    expect(cells).toEqual([[0, 0]]);
    // Square cell has 4 neighbor offsets; only the [1,0] side touches another cell (id 1, not
    // in the region) -- still a perimeter side since the region itself only contains cell 0.
    expect(perimeterSegments).toHaveLength(4);
  });

  it("does not draw a perimeter segment on the shared interior wall between two cells of the same region", () => {
    const nodes = [node(0, 0, 0), node(1, 1, 0)];
    const { perimeterSegments } = buildRegionGeometry([0, 1], nodes, cfg);
    // 4 sides each, minus the 2 shared sides (one per cell) that face each other inside the region.
    expect(perimeterSegments).toHaveLength(6);
  });

  it("keeps two disjoint regions' geometry independent when computed separately", () => {
    const nodes = [node(0, 0, 0), node(1, 1, 0), node(2, 3, 0)];
    const regionA = buildRegionGeometry([0, 1], nodes, cfg);
    const regionB = buildRegionGeometry([2], nodes, cfg);
    expect(regionA.cells).toEqual([[0, 0], [1, 0]]);
    expect(regionB.cells).toEqual([[3, 0]]);
  });

  it("skips node ids absent from the nodes list instead of throwing", () => {
    const nodes = [node(0, 0, 0)];
    const { cells } = buildRegionGeometry([0, 999], nodes, cfg);
    expect(cells).toEqual([[0, 0]]);
  });

  it("returns empty geometry for an empty region", () => {
    const nodes = [node(0, 0, 0)];
    const { cells, perimeterSegments } = buildRegionGeometry([], nodes, cfg);
    expect(cells).toEqual([]);
    expect(perimeterSegments).toEqual([]);
  });
});
