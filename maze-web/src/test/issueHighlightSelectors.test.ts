import { describe, it, expect, vi } from "vitest";
import type { NodeDto } from "../wasm/types";
import type { FieldConfig } from "../fieldConfig";
import { fieldOf } from "./fieldConfigFixtures";
import { insetPolygon } from "../pixi/cellHighlightGeometry";

// getCellCenter/getCellVertices (via cartesianCache's getCartesian) delegate to wasm, unavailable
// in this unit-test environment -- mock with the canonical projections used by the three
// tessellation families.
vi.mock("../wasm/mazeService", async (importActual) => ({
  getFieldPreset: (await importActual<typeof import("../wasm/mazeService")>()).getFieldPreset,
  getFieldCapabilities: (await importActual<typeof import("../wasm/mazeService")>()).getFieldCapabilities,
  translateFieldCells: (await importActual<typeof import("../wasm/mazeService")>()).translateFieldCells,
  reflectFieldCells: (await importActual<typeof import("../wasm/mazeService")>()).reflectFieldCells,
  getGeometrySnapshot: (await importActual<typeof import("../wasm/mazeService")>()).getGeometrySnapshot,
  getCellAt: (await importActual<typeof import("../wasm/mazeService")>()).getCellAt,
  getCellsInRegion: (await importActual<typeof import("../wasm/mazeService")>()).getCellsInRegion,
}));

const { buildRegionGeometry } = await import("../pixi/selectors/issueHighlightSelectors");
const { buildRegionContours } = await import("../pixi/renderers/RegionHighlightRenderer");
const { withRegionOnLeft } = await import("../pixi/renderers/regionContours");

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
    const { perimeterSegments, componentCount } = buildRegionGeometry([0, 1], nodes, cfg);
    // 4 sides each, minus the 2 shared sides (one per cell) that face each other inside the region.
    expect(perimeterSegments).toHaveLength(6);
    expect(buildRegionContours(perimeterSegments)).toHaveLength(1);
    expect(componentCount).toBe(1);
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
    const { perimeterSegments, componentCount } = buildRegionGeometry([0, 1], nodes, triangleCfg);
    const contours = buildRegionContours(perimeterSegments);
    expect(contours).toHaveLength(2);
    expect(contours[0]).toHaveLength(3);
    expect(contours[1]).toHaveLength(3);
    expect(componentCount).toBe(2);
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

  // The zone editor's region: (-1,3) and (0,2) close the indentation (-1,2),(-1,1) only diagonally.
  const diagonalIndentationSegments = () => {
    const cells: [number, number][] = [
      [-2, 4],
      [-2, 3], [-1, 3],
      [-2, 2], [0, 2],
      [-2, 1], [0, 1],
      [-2, 0], [-1, 0], [0, 0],
    ];
    const nodes = cells.map(([x, y], i) => node(i, x, y));
    return buildRegionGeometry(nodes.map(({ id }) => id), nodes, cfg).perimeterSegments;
  };

  it("traces the diagonal touch to the same single loop whichever side the trace starts from (GitHub issue #1050)", () => {
    const segments = diagonalIndentationSegments();
    for (let first = 0; first < segments.length; first++) {
      const rotated = [...segments.slice(first), ...segments.slice(0, first)];
      const contours = buildRegionContours(rotated);
      expect(contours).toHaveLength(1);
      expect(contours[0]).toHaveLength(12);
    }
  });

  it("gives the same loop for sides wound the other way once turned region-on-left (selection preview)", () => {
    const segments = diagonalIndentationSegments();
    // A y-flipped frame reverses every side, putting the region on the right.
    const flipped = segments.map((side) => ({ ...side, v0: side.v1, v1: side.v0, polyline: [...side.polyline].reverse() }));
    const keys = (contour: { x: number; y: number }[]) => contour.map(({ x, y }) => `${x},${y}`).sort();
    const expected = buildRegionContours(segments);
    const turned = buildRegionContours(withRegionOnLeft(flipped));
    expect(turned).toHaveLength(1);
    expect(keys(turned[0])).toEqual(keys(expected[0]));
  });

  it("still closes one loop for sides of unknown orientation (selection preview)", () => {
    // The selection preview passes sides without the region-on-left guarantee.
    const nodes = [node(0, 0, 0), node(1, 1, 0), node(2, 1, 1)];
    const { perimeterSegments } = buildRegionGeometry([0, 1, 2], nodes, cfg);
    const mixed = perimeterSegments.map((side, i) => i % 2 === 0 ? side : { ...side, v0: side.v1, v1: side.v0, polyline: [...side.polyline].reverse() });
    expect(buildRegionContours(mixed)).toHaveLength(1);
  });

  it("keeps the zone editor's diagonally open indentation unfilled (GitHub issue #1050)", () => {
    const [contour] = buildRegionContours(diagonalIndentationSegments());
    const insetContour = insetPolygon(contour, 5);
    const contains = (point: { x: number; y: number }) => insetContour.reduce((inside, a, i) => {
      const b = insetContour[(i + insetContour.length - 1) % insetContour.length];
      return (a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x ? !inside : inside;
    }, false);

    expect(contains({ x: -20, y: -60 })).toBe(false);
    expect(contains({ x: -20, y: -100 })).toBe(false);
    // One loop that visits the diagonal vertex twice, and is a simple polygon once inset.
    expect(contour).toHaveLength(12);
    const orientation = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) =>
      Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    const n = insetContour.length;
    for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const [a, b, c, d] = [insetContour[i], insetContour[(i + 1) % n], insetContour[j], insetContour[(j + 1) % n]];
      expect(orientation(a, b, c) !== orientation(a, b, d) && orientation(c, d, a) !== orientation(c, d, b)).toBe(false);
    }
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
