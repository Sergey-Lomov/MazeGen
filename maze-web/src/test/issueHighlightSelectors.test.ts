import { describe, it, expect, vi } from "vitest";
import type { NodeDto } from "../wasm/types";
import type { FieldConfig } from "../fieldConfig";
import { fieldOf } from "./fieldConfigFixtures";
import { fakeCellCenters } from "./cellCentersFake";

// getCellCenter/getCellVertices (via squareGeometry's getCartesian) delegate to wasm, unavailable
// in this unit-test environment -- mock with the canonical projections used by the three
// tessellation families.
vi.mock("../wasm/mazeService", async (importActual) => ({
  getFieldPreset: (await importActual<typeof import("../wasm/mazeService")>()).getFieldPreset,
  getCellCenters: (config: Parameters<typeof fakeCellCenters>[0]) => fakeCellCenters(config),
}));

const { buildRegionGeometry } = await import("../pixi/selectors/issueHighlightSelectors");
const { buildRegionContours } = await import("../pixi/renderers/RegionHighlightRenderer");

const cfg: FieldConfig = fieldOf("square", { shape: "rect", cols: 4, rows: 1 });

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
    expect(buildRegionContours(perimeterSegments)).toHaveLength(1);
  });

  it("merges adjacent hexagonal cells into one contour", () => {
    const hexCfg: FieldConfig = fieldOf("hex", { shape: "parallelogram", cols: 3, rows: 3 }) as FieldConfig;
    const nodes = [node(0, 0, 0), node(1, 1, 0)];
    const { perimeterSegments } = buildRegionGeometry([0, 1], nodes, hexCfg);
    expect(buildRegionContours(perimeterSegments)).toHaveLength(1);
  });

  it("merges adjacent triangular cells into one contour", () => {
    const triangleCfg: FieldConfig = fieldOf("tri", { shape: "rect", cols: 3, rows: 3 });
    const nodes = [node(0, 0, 0), node(1, 1, 0)];
    const { perimeterSegments } = buildRegionGeometry([0, 1], nodes, triangleCfg);
    expect(buildRegionContours(perimeterSegments)).toHaveLength(1);
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

  it("keeps corner-touching triangles as two separate contours instead of one self-intersecting shape (GitHub issue #618)", () => {
    const triangleCfg: FieldConfig = fieldOf("tri", { shape: "rect", cols: 5, rows: 5 });
    // (0,0) and (1,1) are both "up" triangles (parity even) that touch only at one apex vertex --
    // not tessellation neighbors, so they must trace as independent contours.
    const nodes = [node(0, 0, 0), node(1, 1, 1)];
    const { perimeterSegments } = buildRegionGeometry([0, 1], nodes, triangleCfg);
    const contours = buildRegionContours(perimeterSegments);
    expect(contours).toHaveLength(2);
    expect(contours[0]).toHaveLength(3);
    expect(contours[1]).toHaveLength(3);
  });

  it("keeps a ring's hole nested while a separate corner-touching cell stays its own contour", () => {
    // A 3x3 ring (center cell excluded) is one edge-connected component with an outer + inner
    // contour (a hole); a 4th cell diagonally adjacent to one ring corner only touches at a point,
    // so it must land in a second component and render as its own single contour, not merge into
    // the ring's hole-nesting pair.
    const ringCells: [number, number][] = [[0, 0], [1, 0], [2, 0], [0, 1], [2, 1], [0, 2], [1, 2], [2, 2]];
    const nodes = ringCells.map(([x, y], i) => node(i, x, y));
    nodes.push(node(100, 3, 3));
    const { perimeterSegments } = buildRegionGeometry([...ringCells.map((_, i) => i), 100], nodes, cfg);
    const contours = buildRegionContours(perimeterSegments);
    expect(contours).toHaveLength(3);
  });

  it("dedups cells sharing one coordinate -- e.g. a split tile's several node ids -- to one fill+perimeter", () => {
    // Ids 10 and 11 both sit at (0, 0), like a split tile's slot-0 and an extra node -- must
    // collapse to a single cell/perimeter, not double-draw (GitHub issue #249 regression: the
    // frontend used to pass split tile node ids that could share a cell without deduping first).
    const nodes = [node(10, 0, 0), node(11, 0, 0), node(1, 1, 0)];
    const { cells, perimeterSegments } = buildRegionGeometry([10, 11], nodes, cfg);
    expect(cells).toEqual([[0, 0]]);
    expect(perimeterSegments).toHaveLength(4);
  });
});
