import { describe, it, expect, vi } from "vitest";
import type { NodeDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";

// getCellCenter/getCellVertices (via squareGeometry's getCartesian) delegate to wasm, unavailable
// in this unit-test environment -- mock with the canonical projections used by the three
// tessellation families.
vi.mock("../wasm/mazeService", () => ({
  getCartesianCoords: (cfg: { tessellation_type: "square" | "hex" | "tri"; points: [number, number][] }) => cfg.points.map(([x, y]) => {
    if (cfg.tessellation_type === "hex") return [x * 1.5, -(y * Math.sqrt(3) + x * Math.sqrt(3) / 2)];
    if (cfg.tessellation_type === "tri") {
      const h = Math.sqrt(3);
      return [x + 0.5, -((x + y) % 2 === 0 ? y * h + h / 3 : y * h + 2 * h / 3)];
    }
    return [x, y];
  }),
}));

const { buildRegionGeometry } = await import("../pixi/selectors/issueHighlightSelectors");
const { buildRegionContours } = await import("../pixi/renderers/RegionHighlightRenderer");

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
    expect(buildRegionContours(perimeterSegments)).toHaveLength(1);
  });

  it("merges adjacent hexagonal cells into one contour", () => {
    const hexCfg: TessellationConfig = { type: "hex_parallelogram", cols: 3, rows: 3 } as TessellationConfig;
    const nodes = [node(0, 0, 0), node(1, 1, 0)];
    const { perimeterSegments } = buildRegionGeometry([0, 1], nodes, hexCfg);
    expect(buildRegionContours(perimeterSegments)).toHaveLength(1);
  });

  it("merges adjacent triangular cells into one contour", () => {
    const triangleCfg: TessellationConfig = { type: "triangle_rect", cols: 3, rows: 3 };
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
