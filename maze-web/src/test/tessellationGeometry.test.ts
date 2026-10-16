import { describe, it, expect, vi } from "vitest";
import type { FieldConfig } from "../fieldConfig";
import type { SplitPattern } from "../wasm/types";
import { TILE_SIZE } from "../pixi/constants";
import { fieldOf } from "./fieldConfigFixtures";
import { fakeCellCenter } from "./cellCentersFake";

// `getCartesian` (cartesianCache.ts) delegates to wasm, unavailable in this unit-test environment
// — same mock `hexGeometry.test.ts` uses, the world-unit centers of `maze-core::space`'s
// Tessellation impls.
vi.mock("../pixi/cartesianCache", () => ({
  getCartesian: (x: number, y: number, cfg: { tessellation: { kind: string } }): [number, number] =>
    fakeCellCenter(x, y, cfg.tessellation.kind),
}));

const { getTileDiagram, getSharedEdgeSegment, getCellCenter, getCellVertices, getNeighborData, getSplitCircleRotationDeg, rotateFaceIndex, splitHubPoint, specialSplitNodePoint, splitPointFaceKindsByNode, buildNodePositions, splitFaceIndexToCore, splitFaceIndexToWeb, splitPatternsToCore, splitPatternsToWeb, nearestCellCoord } = await import("../pixi/tessellationGeometry");
const { cairoCanonicalFaceOrder } = await import("../pixi/cairoGeometry");

// Canonical (counter-clockwise) face order of `maze-core`'s shape templates (`Specs/space.md`,
// GitHub issue #758) — used here only to name expected indices by face, not to duplicate the
// mapping under test.
const SQUARE_CORE_ORDER = ["E", "N", "W", "S"];
const HEX_CORE_ORDER = ["E", "NE", "NW", "W", "SW", "SE"];

// A face's `v0 -> v1` direction must agree with `getSharedEdgeSegment`'s own choice for that same
// shared edge — both the split-node dialog's tile diagram (`TileFaceEditor`, via `getTileDiagram`)
// and the post-generation canvas (`SplitJunctionRenderer`, via `getSharedEdgeSegment`) feed the
// same `computeSplitFaceLayouts`, which divides a multi-node face along `v0 -> v1` in node order —
// a disagreement here mirrors the split order between the dialog and the canvas for identical data
// (GitHub issue #235 follow-up). Checked from the *higher*-coordinate cell's own diagram, since
// `getTileDiagram` used its own `edgeVerts` unconditionally before the fix — a bug only visible
// when the diagram's own cell isn't the canonical-lower one for a given shared edge.
function expectSideMatchesShared(cfg: FieldConfig, x: number, y: number) {
  const diagram = getTileDiagram(x, y, cfg);
  expect(diagram).not.toBeNull();
  const center = getCellCenter(x, y, cfg);
  const { offsets } = getNeighborData(cfg, x, y);

  diagram!.sides.forEach((side, i) => {
    const [dx, dy] = offsets[i];
    const nx = x + dx, ny = y + dy;
    const shared = getSharedEdgeSegment([x, y], [nx, ny], cfg);
    expect(shared).not.toBeNull();
    const expectedV0 = { x: shared!.v0.x - center.x, y: shared!.v0.y - center.y };
    const expectedV1 = { x: shared!.v1.x - center.x, y: shared!.v1.y - center.y };
    expect(side.v0.x).toBeCloseTo(expectedV0.x);
    expect(side.v0.y).toBeCloseTo(expectedV0.y);
    expect(side.v1.x).toBeCloseTo(expectedV1.x);
    expect(side.v1.y).toBeCloseTo(expectedV1.y);
  });
}

describe("getTileDiagram side direction matches getSharedEdgeSegment", () => {
  it("agrees for a hex cell that is the canonical-lower cell on every shared edge", () => {
    expectSideMatchesShared(fieldOf("hex", { shape: "hexagon", radius: 3 }, "flat_top"), -1, -1);
  });

  it("agrees for a hex cell that is the canonical-higher cell on some shared edges", () => {
    // (1, 1) has neighbors with both lower and higher coordinates — exercises both branches.
    expectSideMatchesShared(fieldOf("hex", { shape: "hexagon", radius: 3 }, "flat_top"), 1, 1);
  });

  it("agrees for a triangle 'up' cell ((x+y) even)", () => {
    expectSideMatchesShared(fieldOf("tri", { shape: "hexagon", radius: 3 }), 2, 2);
  });

  it("agrees for a triangle 'down' cell ((x+y) odd)", () => {
    expectSideMatchesShared(fieldOf("tri", { shape: "hexagon", radius: 3 }), 3, 2);
  });

  it("agrees for a square cell (sanity check — square never disagreed even before the fix)", () => {
    expectSideMatchesShared(fieldOf("square", { shape: "rect", cols: 5, rows: 5 }), 1, 1);
  });
});

describe("getSharedEdgeSegment returns null for a non-neighbor offset", () => {
  // `getSharedEdgeSegment` looks up `dx,dy` in the lower cell's own `offsets`/`edgeVerts` tables
  // (`getNeighborData`); an offset that isn't one of that tessellation's real neighbor directions
  // has no entry and must return null rather than throw or return a bogus segment. This guards
  // callers like `issueHighlightSelectors.buildRegionGeometry`, which skips a null segment — a
  // newly added tessellation whose `offsets`/`edgeVerts` tables fall out of sync would otherwise
  // surface as a silent missing perimeter side instead of a caught test failure here.
  it("square: a two-step offset is not a real neighbor direction", () => {
    expect(getSharedEdgeSegment([0, 0], [2, 0], fieldOf("square", { shape: "rect", cols: 5, rows: 5 }))).toBeNull();
  });

  it("hex: a diagonal offset outside the 6 neighbor directions", () => {
    expect(getSharedEdgeSegment([0, 0], [1, 1], fieldOf("hex", { shape: "hexagon", radius: 3 }, "flat_top"))).toBeNull();
  });

  it("triangle: cells that only touch at a corner, not a real neighbor direction", () => {
    expect(getSharedEdgeSegment([0, 0], [1, 1], fieldOf("tri", { shape: "hexagon", radius: 3 }))).toBeNull();
  });
});

describe("getSplitCircleRotationDeg", () => {
  it("returns 45 for square tessellations (halfway between its 4 edge directions)", () => {
    expect(getSplitCircleRotationDeg(fieldOf("square", { shape: "rect", cols: 5, rows: 5 }))).toBe(45);
    expect(getSplitCircleRotationDeg(fieldOf("square", { shape: "custom", points: [] }))).toBe(45);
  });

  it("returns 30 for hex tessellations (halfway between its 6 edge directions)", () => {
    expect(getSplitCircleRotationDeg(fieldOf("hex", { shape: "hexagon", radius: 3 }))).toBe(30);
    expect(getSplitCircleRotationDeg(fieldOf("hex", { shape: "parallelogram", cols: 3, rows: 3 }))).toBe(30);
    expect(getSplitCircleRotationDeg(fieldOf("hex", { shape: "custom", points: [] }))).toBe(30);
  });

  it("returns 60 for triangle tessellations (halfway between its 3 edge directions)", () => {
    expect(getSplitCircleRotationDeg(fieldOf("tri", { shape: "hexagon", radius: 3 }))).toBe(60);
    expect(getSplitCircleRotationDeg(fieldOf("tri", { shape: "rect", cols: 3, rows: 3 }))).toBe(60);
    expect(getSplitCircleRotationDeg(fieldOf("tri", { shape: "triangle", side: 3 }))).toBe(60);
    expect(getSplitCircleRotationDeg(fieldOf("tri", { shape: "custom", points: [] }))).toBe(60);
  });

  it("returns 36 for Cairo's five evenly distributed split-node slots", () => {
    expect(getSplitCircleRotationDeg(fieldOf("cairo", { shape: "rect", cols: 3, rows: 3 }))).toBe(36);
  });
});

describe("rotateFaceIndex", () => {
  it("follows Cairo's physical perimeter instead of its stable core slot order", () => {
    const cfg = fieldOf("cairo", { shape: "rect", cols: 3, rows: 3 });

    // At the D tile [2, 1], the stable slots 1 and 4 are adjacent in space while
    // slot 2 is the next numeric slot. This is the skipped-edge regression.
    expect(rotateFaceIndex(cfg, 2, 1, 1, 1)).toBe(4);
    expect(rotateFaceIndex(cfg, 2, 1, 1, -1)).toBe(0);
  });

  it("keeps the established cyclic index behavior for square", () => {
    const cfg = fieldOf("square", { shape: "rect", cols: 3, rows: 3 });
    expect(rotateFaceIndex(cfg, 0, 0, 0, 1)).toBe(1);
    expect(rotateFaceIndex(cfg, 0, 0, 0, -1)).toBe(3);
  });
});

describe("Cairo special split node anchors", () => {
  it("places Cor1 at 1/4 and Cor2 at 3/4 from corner 2/3 toward face-0 midpoint", () => {
    const cfg = fieldOf("cairo", { shape: "rect", cols: 3, rows: 3 });
    const point: [number, number] = [2, 1];
    const order = cairoCanonicalFaceOrder(...point);
    const vertices = getCellVertices(...point, cfg)!;
    const { edgeVerts } = getNeighborData(cfg, ...point);
    const shared = (a: number, b: number) => {
      const [a0, a1] = edgeVerts[a], [b0, b1] = edgeVerts[b];
      const index = a0 === b0 || a0 === b1 ? a0 : a1 === b0 || a1 === b1 ? a1 : -1;
      return vertices[index];
    };
    const from = shared(order[2], order[3]);
    const edge0 = edgeVerts[order[0]];
    const to = { x: (vertices[edge0[0]].x + vertices[edge0[1]].x) / 2, y: (vertices[edge0[0]].y + vertices[edge0[1]].y) / 2 };
    const pointAt = (t: number) => ({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
    const center = getCellCenter(...point, cfg);
    expect(specialSplitNodePoint(cfg, center, "cairo_diagonal_divider", [order[2], order[3]], 0, [], point)).toEqual(pointAt(1 / 4));
    expect(specialSplitNodePoint(cfg, center, "cairo_diagonal_divider", [order[1], order[4]], 1, [], point)).toEqual(pointAt(3 / 4));
  });

  it("places adjacent-divider markers between the divider center and edge 1/4 centers", () => {
    const cfg = fieldOf("cairo", { shape: "rect", cols: 3, rows: 3 });
    const point: [number, number] = [2, 1];
    const order = cairoCanonicalFaceOrder(...point);
    const vertices = getCellVertices(...point, cfg)!;
    const { edgeVerts } = getNeighborData(cfg, ...point);
    const shared = (a: number, b: number) => {
      const [a0, a1] = edgeVerts[a], [b0, b1] = edgeVerts[b];
      const index = a0 === b0 || a0 === b1 ? a0 : a1 === b0 || a1 === b1 ? a1 : -1;
      return vertices[index];
    };
    const corner23 = shared(order[2], order[3]);
    const edge0 = edgeVerts[order[0]];
    const dividerCenter = {
      x: (corner23.x + (vertices[edge0[0]].x + vertices[edge0[1]].x) / 2) / 2,
      y: (corner23.y + (vertices[edge0[0]].y + vertices[edge0[1]].y) / 2) / 2,
    };
    const edgeCenter = (face: number) => {
      const [a, b] = edgeVerts[face];
      return { x: (vertices[a].x + vertices[b].x) / 2, y: (vertices[a].y + vertices[b].y) / 2 };
    };
    const midpoint = (from: typeof dividerCenter, to: ReturnType<typeof edgeCenter>) => ({
      x: (from.x + to.x) / 2, y: (from.y + to.y) / 2,
    });
    const center = getCellCenter(...point, cfg);
    expect(specialSplitNodePoint(cfg, center, "cairo_adjacent_divider", [order[1], order[2]], 0, [], point))
      .toEqual(midpoint(dividerCenter, edgeCenter(order[1])));
    expect(specialSplitNodePoint(cfg, center, "cairo_adjacent_divider", [order[3], order[4]], 1, [], point))
      .toEqual(midpoint(dividerCenter, edgeCenter(order[4])));
  });

  it("places Cairo 2x3 bridge at the edge-1/edge-4 midpoint and fork at 1/3", () => {
    const cfg = fieldOf("cairo", { shape: "rect", cols: 3, rows: 3 });
    const point: [number, number] = [2, 1];
    const order = cairoCanonicalFaceOrder(...point);
    const vertices = getCellVertices(...point, cfg)!;
    const { edgeVerts } = getNeighborData(cfg, ...point);
    const shared = (a: number, b: number) => {
      const [a0, a1] = edgeVerts[a], [b0, b1] = edgeVerts[b];
      const index = a0 === b0 || a0 === b1 ? a0 : a1 === b0 || a1 === b1 ? a1 : -1;
      return vertices[index];
    };
    const corner23 = shared(order[2], order[3]);
    const edgeCenter = (face: number) => {
      const [a, b] = edgeVerts[face];
      return { x: (vertices[a].x + vertices[b].x) / 2, y: (vertices[a].y + vertices[b].y) / 2 };
    };
    const edge0Center = edgeCenter(order[0]);
    const forkAnchor = {
      x: corner23.x + (edge0Center.x - corner23.x) / 3,
      y: corner23.y + (edge0Center.y - corner23.y) / 3,
    };
    const bridgeAnchor = {
      x: (edgeCenter(order[1]).x + edgeCenter(order[4]).x) / 2,
      y: (edgeCenter(order[1]).y + edgeCenter(order[4]).y) / 2,
    };
    const center = getCellCenter(...point, cfg);
    expect(specialSplitNodePoint(cfg, center, "cairo_bridge_2x3", [order[0], order[2], order[3]], 0, [], point)).toEqual(forkAnchor);
    expect(specialSplitNodePoint(cfg, center, "cairo_bridge_2x3", [order[1], order[4]], 1, [], point)).toEqual(bridgeAnchor);
  });
});

describe("splitHubPoint", () => {
  it("distributes slots evenly around the center starting at the tessellation's own rotation", () => {
    const cfg: FieldConfig = fieldOf("square", { shape: "rect", cols: 5, rows: 5 });
    const center = { x: 0, y: 0 };
    const p0 = splitHubPoint(center, 0, 4, cfg);
    const p1 = splitHubPoint(center, 1, 4, cfg);
    // slot 0 sits exactly at the 45° rotation angle.
    const angle0 = Math.atan2(p0.y, p0.x);
    expect(angle0).toBeCloseTo((45 * Math.PI) / 180);
    // consecutive slots are 90° apart for a 4-slot split.
    const angle1 = Math.atan2(p1.y, p1.x);
    expect(angle1 - angle0).toBeCloseTo(Math.PI / 2);
  });

  it("places every slot at the same distance from center", () => {
    const cfg: FieldConfig = fieldOf("hex", { shape: "hexagon", radius: 3 });
    const center = { x: 10, y: -5 };
    const distances = [0, 1, 2].map((i) => {
      const p = splitHubPoint(center, i, 3, cfg);
      return Math.hypot(p.x - center.x, p.y - center.y);
    });
    expect(distances[1]).toBeCloseTo(distances[0]);
    expect(distances[2]).toBeCloseTo(distances[0]);
  });
});

describe("specialSplitNodePoint", () => {
  const cfg: FieldConfig = fieldOf("square", { shape: "rect", cols: 10, rows: 10 });
  const center = { x: 0, y: 0 };

  it("returns null for a hex special shape that has no dedicated anchor", () => {
    const hexCfg: FieldConfig = fieldOf("hex", { shape: "hexagon", radius: 3 });
    expect(specialSplitNodePoint(hexCfg, center, "diagonal", [0, 1], 0)).toBeNull();
    expect(specialSplitNodePoint(hexCfg, center, "bridge", [0, 2], 0)).toBeNull();
  });

  it.each([
    ["adjacent", [0, 1] as [number, number]],
    ["skip-face", [0, 2] as [number, number]],
  ])("hex diagonal %s pair anchors on its face-center bisector at the skip-pair radius", (_name, faces) => {
    const hexCfg: FieldConfig = fieldOf("hex", { shape: "hexagon", radius: 3 });
    const hexCenter = getCellCenter(0, 0, hexCfg);
    const vertices = getCellVertices(0, 0, hexCfg)!;
    const { edgeVerts } = getNeighborData(hexCfg, 0, 0);
    const centers = faces.map((face) => {
      const [a, b] = edgeVerts[face];
      return { x: (vertices[a].x + vertices[b].x) / 2, y: (vertices[a].y + vertices[b].y) / 2 };
    });
    const midpoint = { x: (centers[0].x + centers[1].x) / 2, y: (centers[0].y + centers[1].y) / 2 };
    const point = specialSplitNodePoint(hexCfg, hexCenter, "hex_diagonal", faces, 0)!;
    const skipPoint = specialSplitNodePoint(hexCfg, hexCenter, "hex_diagonal", [0, 2], 0)!;
    expect(Math.atan2(point.y - hexCenter.y, point.x - hexCenter.x))
      .toBeCloseTo(Math.atan2(midpoint.y - hexCenter.y, midpoint.x - hexCenter.x));
    expect(Math.hypot(point.x - hexCenter.x, point.y - hexCenter.y))
      .toBeCloseTo(Math.hypot(skipPoint.x - hexCenter.x, skipPoint.y - hexCenter.y));
  });

  it("hex bridge keeps the rendered upper node centered and offsets the lower node 2/3 toward the vertex between the bridge sides", () => {
    const hexCfg: FieldConfig = fieldOf("hex", { shape: "hexagon", radius: 3 });
    const hexCenter = getCellCenter(0, 0, hexCfg);
    const allFaces: [number, number][] = [[0, 3], [1, 4]];
    expect(specialSplitNodePoint(hexCfg, hexCenter, "hex_bridge", allFaces[1], 1, allFaces)).toEqual(hexCenter);

    const lower = specialSplitNodePoint(hexCfg, hexCenter, "hex_bridge", allFaces[0], 0, allFaces)!;
    const vertices = getCellVertices(0, 0, hexCfg)!;
    expect(lower.x).toBeCloseTo(hexCenter.x + (vertices[0].x - hexCenter.x) * 2 / 3);
    expect(lower.y).toBeCloseTo(hexCenter.y + (vertices[0].y - hexCenter.y) * 2 / 3);
  });

  it("hex triple corridor puts slots between the corners belonging to its two side corridors", () => {
    const hexCfg: FieldConfig = fieldOf("hex", { shape: "hexagon", radius: 3 });
    const hexCenter = getCellCenter(0, 0, hexCfg);
    const vertices = getCellVertices(0, 0, hexCfg)!;
    const from = vertices[2], to = vertices[5]; // shared corners of side pairs [1,2] and [4,5]
    const expectedAt = (t: number) => ({
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
    });
    const faces: [number, number][] = [[0, 3], [1, 2], [4, 5]];
    [1 / 2, 1 / 6, 5 / 6].forEach((t, slot) => {
      expect(specialSplitNodePoint(hexCfg, hexCenter, "hex_triple_corridor", faces[slot], slot, faces))
        .toEqual(expectedAt(t));
    });
  });

  it("hex triple bridge puts every node at 5/6 of its axis and reverses the bottom/top node directions", () => {
    const hexCfg: FieldConfig = fieldOf("hex", { shape: "hexagon", radius: 3 });
    const hexCenter = getCellCenter(0, 0, hexCfg);
    const vertices = getCellVertices(0, 0, hexCfg)!;
    const { edgeVerts } = getNeighborData(hexCfg, 0, 0);
    const faces: [number, number][] = [[0, 3], [1, 4], [2, 5]];
    faces.forEach((pair, slot) => {
      const centerOf = (face: number) => {
        const [a, b] = edgeVerts[face];
        return { x: (vertices[a].x + vertices[b].x) / 2, y: (vertices[a].y + vertices[b].y) / 2 };
      };
      const reversed = slot === 0 || slot === 2;
      const from = centerOf(pair[reversed ? 1 : 0]), to = centerOf(pair[reversed ? 0 : 1]);
      const t = 5 / 6;
      expect(specialSplitNodePoint(hexCfg, hexCenter, "hex_triple_bridge", pair, slot, faces)).toEqual({
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
      });
    });
  });

  it("hex diagonal divider uses the same anchors as the equivalent 0-2 / 3-5 double passage", () => {
    const hexCfg: FieldConfig = fieldOf("hex", { shape: "hexagon", radius: 3 });
    const hexCenter = getCellCenter(0, 0, hexCfg);
    const faces = [[0, 1, 2], [3, 4, 5]];
    const equivalentPairs = [[0, 2], [3, 5]];
    faces.forEach((nodeFaces, slot) => {
      expect(specialSplitNodePoint(hexCfg, hexCenter, "hex_diagonal_divider", nodeFaces, slot, faces))
        .toEqual(specialSplitNodePoint(hexCfg, hexCenter, "hex_diagonal", equivalentPairs[slot], slot, equivalentPairs));
    });
  });

  it("returns null for a diagonal face pair with no dedicated table entry", () => {
    // Only adjacent pairs (0,1)/(1,2)/(2,3)/(3,0) have entries — an opposite pair like (0,2)
    // shouldn't reach this function via detectSplitSpecialShapeKind's own "diagonal" classification
    // in practice, but the function itself stays total (returns null, not a throw/garbage value).
    expect(specialSplitNodePoint(cfg, center, "diagonal", [0, 2], 0)).toBeNull();
  });

  it("bridge slot 1 always sits at plain center regardless of its own face pair", () => {
    expect(specialSplitNodePoint(cfg, center, "bridge", [1, 3], 1)).toEqual(center);
    expect(specialSplitNodePoint(cfg, center, "bridge", [0, 2], 1)).toEqual(center);
  });

  it("bridge slot 0 offsets toward its own first face", () => {
    const east = specialSplitNodePoint(cfg, center, "bridge", [0, 2], 0)!; // faces[0] = E
    expect(east.x).toBeCloseTo(TILE_SIZE * 0.25);
    expect(east.y).toBeCloseTo(0);

    const north = specialSplitNodePoint(cfg, center, "bridge", [1, 3], 0)!; // faces[0] = N
    expect(north.x).toBeCloseTo(0);
    expect(north.y).toBeCloseTo(-TILE_SIZE * 0.25);
  });
});

describe("buildNodePositions", () => {
  const cfg: FieldConfig = fieldOf("square", { shape: "rect", cols: 10, rows: 10 });

  it("matches getCellCenter/splitHubPoint exactly, the same formula the canvas uses for split passages", () => {
    const nodes = [
      { id: 20, x: 2, y: 2 },
      { id: 21, x: 2, y: 2 },
    ];
    const nodePos = buildNodePositions(nodes, cfg);
    const center = getCellCenter(2, 2, cfg);
    expect(nodePos.get(20)).toEqual(splitHubPoint(center, 0, 2, cfg));
    expect(nodePos.get(21)).toEqual(splitHubPoint(center, 1, 2, cfg));
  });

  it("spreads split-tile siblings sharing the same (x, y) into distinct positions", () => {
    const nodes = [
      { id: 10, x: 4, y: 4 },
      { id: 11, x: 4, y: 4 },
      { id: 12, x: 4, y: 4 },
    ];
    const nodePos = buildNodePositions(nodes, cfg);
    const positions = [nodePos.get(10)!, nodePos.get(11)!, nodePos.get(12)!];
    for (const p of positions) expect(p).toBeDefined();
    expect(new Set(positions.map(p => `${p.x}:${p.y}`)).size).toBe(3);
  });

  it("does not offset nodes on different tiles", () => {
    const nodes = [
      { id: 1, x: 0, y: 0 },
      { id: 2, x: 1, y: 0 },
    ];
    const nodePos = buildNodePositions(nodes, cfg);
    const solo = buildNodePositions([nodes[0]], cfg);
    expect(nodePos.get(1)).toEqual(solo.get(1));
  });

  it("leaves an unsplit node exactly at its cell center", () => {
    const nodes = [{ id: 5, x: 3, y: 3 }];
    const nodePos = buildNodePositions(nodes, cfg);
    expect(nodePos.get(5)).toEqual(getCellCenter(3, 3, cfg));
  });

  // GitHub issue #318 — a degree-4 split point recognized as a "diagonal"/"bridge" special shape
  // gets a dedicated point instead of the generic hub circle, once `directedPairs` are supplied.
  describe("shape-aware positioning for a recognized bridge/diagonal split point", () => {
    // A special shape is only recognized for two-way passages (GitHub issue #477), so every
    // directed pair below must be mirrored to represent a bidirectional connection.
    const bidi = <T extends { from: number | string; to: number | string }>(pairs: T[]) =>
      pairs.flatMap((p) => [p, { ...p, from: p.to, to: p.from }]);

    // Split point at (2,2); neighbors at E(3,2), N(2,3), W(1,2), S(2,1) — face order per
    // `getNeighborData`: 0=E, 1=N, 2=W, 3=S (confirmed by `splitFaceIndexToCore`'s own tests above).
    const east = { id: 100, x: 3, y: 2 };
    const north = { id: 101, x: 2, y: 3 };
    const west = { id: 102, x: 1, y: 2 };
    const south = { id: 103, x: 2, y: 1 };

    it("diagonal: each node's point sits at the centroid of its own half (adjacent-face pair), not the hub circle", () => {
      const node0 = { id: 0, x: 2, y: 2 }; // connects E, N
      const node1 = { id: 1, x: 2, y: 2 }; // connects W, S
      const nodes = [node0, node1, east, north, west, south];
      const directedPairs = [
        { from: node0.id, to: east.id }, { from: node0.id, to: north.id },
        { from: node1.id, to: west.id }, { from: node1.id, to: south.id },
      ];
      const nodePos = buildNodePositions(nodes, cfg, bidi(directedPairs));
      const center = getCellCenter(2, 2, cfg);

      // node0 (E,N) — half-centroid direction, scaled to 1/4 tile (GitHub issue #318 follow-up:
      // 1/3 sat too close to the corner, 1/6 and 1/5 overcorrected, 1/4 is the final value).
      const p0 = nodePos.get(0)!;
      expect(p0.x).toBeCloseTo(center.x + TILE_SIZE / 4);
      expect(p0.y).toBeCloseTo(center.y - TILE_SIZE / 4);

      // node1 (W,S) — the opposite half, offset (-1/4, 1/4) tile.
      const p1 = nodePos.get(1)!;
      expect(p1.x).toBeCloseTo(center.x - TILE_SIZE / 4);
      expect(p1.y).toBeCloseTo(center.y + TILE_SIZE / 4);

      // Neither point sits on the generic hub circle (radius SPLIT_HUB_RADIUS from center).
      const hubDist0 = Math.hypot(p0.x - center.x, p0.y - center.y);
      expect(hubDist0).not.toBeCloseTo(TILE_SIZE / 4);
    });

    it("bridge: slot 1 sits at tile center, slot 0 offsets toward its own first face (GitHub issue #318 follow-up: keyed by slot, and the offset axis is slot 0's own face pair, not slot 1's)", () => {
      const node0 = { id: 0, x: 2, y: 2 }; // slot 0 — connects E, W (opposite)
      const node1 = { id: 1, x: 2, y: 2 }; // slot 1 — connects N, S (opposite)
      const nodes = [node0, node1, east, north, west, south];
      const directedPairs = [
        { from: node0.id, to: east.id }, { from: node0.id, to: west.id },
        { from: node1.id, to: north.id }, { from: node1.id, to: south.id },
      ];
      const nodePos = buildNodePositions(nodes, cfg, bidi(directedPairs));
      const center = getCellCenter(2, 2, cfg);

      // Slot 1 (node1) sits at plain center.
      expect(nodePos.get(1)).toEqual(center);

      // Slot 0 (node0) offsets 0.25 tile toward its own first face (E).
      const p0 = nodePos.get(0)!;
      expect(p0.x).toBeCloseTo(center.x + TILE_SIZE * 0.25);
      expect(p0.y).toBeCloseTo(center.y);
    });

    it("falls back to the generic hub circle when no directedPairs are given", () => {
      const node0 = { id: 0, x: 2, y: 2 };
      const node1 = { id: 1, x: 2, y: 2 };
      const nodePos = buildNodePositions([node0, node1], cfg);
      const center = getCellCenter(2, 2, cfg);
      expect(nodePos.get(0)).toEqual(splitHubPoint(center, 0, 2, cfg));
      expect(nodePos.get(1)).toEqual(splitHubPoint(center, 1, 2, cfg));
    });

    it("positions a recognized hex diagonal node midway between its connected face centers", () => {
      const hexCfg: FieldConfig = fieldOf("hex", { shape: "hexagon", radius: 3 });
      const node0 = { id: 0, x: 0, y: 0 };
      const node1 = { id: 1, x: 0, y: 0 };
      const { offsets } = getNeighborData(hexCfg, 0, 0);
      const neighbors = offsets.map(([x, y], i) => ({ id: 200 + i, x, y }));
      const directedPairs = [
        { from: node0.id, to: neighbors[0].id }, { from: node0.id, to: neighbors[1].id },
        { from: node1.id, to: neighbors[3].id }, { from: node1.id, to: neighbors[4].id },
      ];
      const nodePos = buildNodePositions([node0, node1, ...neighbors], hexCfg, bidi(directedPairs));
      const center = getCellCenter(0, 0, hexCfg);
      expect(nodePos.get(0)).toEqual(specialSplitNodePoint(hexCfg, center, "hex_diagonal", [0, 1], 0));
      expect(nodePos.get(1)).toEqual(specialSplitNodePoint(hexCfg, center, "hex_diagonal", [3, 4], 1));
    });

    it("detects a three-node hex triple corridor and applies its three dedicated anchors", () => {
      const hexCfg: FieldConfig = fieldOf("hex", { shape: "hexagon", radius: 3 });
      const pointNodes = [0, 1, 2].map((id) => ({ id, x: 0, y: 0 }));
      const { offsets } = getNeighborData(hexCfg, 0, 0);
      const neighbors = offsets.map(([x, y], i) => ({ id: 200 + i, x, y }));
      const faces: [number, number][] = [[0, 3], [1, 2], [4, 5]];
      const directedPairs = faces.flatMap((pair, nodeIndex) =>
        pair.map((face) => ({ from: pointNodes[nodeIndex].id, to: neighbors[face].id })),
      );
      const nodePos = buildNodePositions([...pointNodes, ...neighbors], hexCfg, bidi(directedPairs));
      const center = getCellCenter(0, 0, hexCfg);
      pointNodes.forEach((node, slot) => {
        expect(nodePos.get(node.id)).toEqual(
          specialSplitNodePoint(hexCfg, center, "hex_triple_corridor", faces[slot], slot, faces),
        );
      });
    });

    it("uses the hex diagonal divider anchors for graph and marker positioning", () => {
      const hexCfg: FieldConfig = fieldOf("hex", { shape: "hexagon", radius: 3 });
      const pointNodes = [0, 1].map((id) => ({ id, x: 0, y: 0 }));
      const { offsets } = getNeighborData(hexCfg, 0, 0);
      const neighbors = offsets.map(([x, y], i) => ({ id: 200 + i, x, y }));
      const faces = [[0, 1, 2], [3, 4, 5]];
      const directedPairs = faces.flatMap((nodeFaces, nodeIndex) =>
        nodeFaces.map((face) => ({ from: pointNodes[nodeIndex].id, to: neighbors[face].id })),
      );
      const nodePos = buildNodePositions([...pointNodes, ...neighbors], hexCfg, bidi(directedPairs));
      const center = getCellCenter(0, 0, hexCfg);
      pointNodes.forEach((node, slot) => {
        expect(nodePos.get(node.id)).toEqual(
          specialSplitNodePoint(hexCfg, center, "hex_diagonal_divider", faces[slot], slot, faces),
        );
      });
    });
  });
});

describe("splitPointFaceKindsByNode", () => {
  const cfg: FieldConfig = fieldOf("square", { shape: "rect", cols: 5, rows: 5 });
  // Split point at (2,2); face order per getNeighborData: 0=E, 1=N, 2=W, 3=S.
  const node0 = { id: 0, x: 2, y: 2 };
  const node1 = { id: 1, x: 2, y: 2 };
  const east = { id: 100, x: 3, y: 2 };
  const north = { id: 101, x: 2, y: 3 };
  const byTile = new Map<string, { id: number; x: number; y: number }[]>([
    ["2:2", [node0, node1]],
    ["3:2", [east]],
    ["2:3", [north]],
  ]);

  it("marks a face `passage` only when directed edges exist both ways", () => {
    const directed = new Set([`${node0.id}->${east.id}`, `${east.id}->${node0.id}`]);
    const kinds = splitPointFaceKindsByNode([node0, node1], byTile, directed, cfg);
    expect(kinds[0][0]).toBe("passage"); // node0, face E
    expect(kinds[0][1]).toBe("wall"); // node0, face N — no edge
  });

  it("distinguishes one_way_out (node -> neighbor) from one_way_in (neighbor -> node)", () => {
    const directed = new Set([`${node0.id}->${east.id}`, `${north.id}->${node0.id}`]);
    const kinds = splitPointFaceKindsByNode([node0, node1], byTile, directed, cfg);
    expect(kinds[0][0]).toBe("one_way_out"); // face E: only node0 -> east
    expect(kinds[0][1]).toBe("one_way_in"); // face N: only north -> node0
  });

  it("never emits `undefined` — an unconnected face is `wall`", () => {
    const kinds = splitPointFaceKindsByNode([node0, node1], byTile, new Set(), cfg);
    expect(kinds.flat().every((k) => k === "wall")).toBe(true);
  });
});

// Web-authored `face_index` (per `getNeighborData`'s offset order) must land on the same physical
// face in `maze-core`'s own `Tessellation::faces()` order once converted — GitHub issue #273.
// Named by axial/cartesian delta (E/N/W/S, E/NE/NW/W/SW/SE) so this test fails if either side's
// face-name-to-delta mapping ever changes, not just the permutation table.
describe("splitFaceIndexToCore", () => {
  it("maps every square web offset to its same-direction core index", () => {
    const cfg: FieldConfig = fieldOf("square", { shape: "rect", cols: 3, rows: 3 });
    const { offsets } = getNeighborData(cfg, 1, 1);
    const deltaToName: Record<string, string> = { "1,0": "E", "0,1": "N", "-1,0": "W", "0,-1": "S" };
    offsets.forEach(([dx, dy], webIndex) => {
      const name = deltaToName[`${dx},${dy}`];
      expect(SQUARE_CORE_ORDER[splitFaceIndexToCore(cfg, webIndex)]).toBe(name);
    });
  });

  it("maps every hex flat_top web offset to its same-direction core index", () => {
    const cfg: FieldConfig = fieldOf("hex", { shape: "parallelogram", cols: 3, rows: 3 }, "flat_top");
    const { offsets } = getNeighborData(cfg, 1, 1);
    const deltaToName: Record<string, string> = { "1,0": "E", "0,1": "SE", "-1,1": "SW", "-1,0": "W", "0,-1": "NW", "1,-1": "NE" };
    offsets.forEach(([dx, dy], webIndex) => {
      const name = deltaToName[`${dx},${dy}`];
      expect(HEX_CORE_ORDER[splitFaceIndexToCore(cfg, webIndex)]).toBe(name);
    });
  });

  it("maps every hex pointy_top web offset to its same-direction core index", () => {
    const cfg: FieldConfig = fieldOf("hex", { shape: "parallelogram", cols: 3, rows: 3 }, "pointy_top");
    const { offsets } = getNeighborData(cfg, 1, 1);
    const deltaToName: Record<string, string> = { "1,0": "E", "0,1": "SE", "-1,1": "SW", "-1,0": "W", "0,-1": "NW", "1,-1": "NE" };
    offsets.forEach(([dx, dy], webIndex) => {
      const name = deltaToName[`${dx},${dy}`];
      expect(HEX_CORE_ORDER[splitFaceIndexToCore(cfg, webIndex)]).toBe(name);
    });
  });

  it("maps triangle web faces [Left, Right, Base] through the anchor cell's template binding", () => {
    const cfg: FieldConfig = fieldOf("tri", { shape: "rect", cols: 3, rows: 3 });
    expect([0, 1, 2].map((i) => splitFaceIndexToCore(cfg, i))).toEqual([1, 2, 0]);
  });
});

// `splitFaceIndexToWeb`/`splitPatternsToWeb` must invert `splitFaceIndexToCore`/`splitPatternsToCore`
// exactly — a repair/check strategy's `pattern_list`/`split_generation_config` param stores patterns
// in core ordering (GitHub issue #273's `ParamFields.tsx` fix) but re-opening the editor converts
// back to web ordering for `TileFaceEditor`; a round-trip must reproduce the original web indices.
describe("splitFaceIndexToWeb / splitPatternsToWeb (round-trip with *ToCore)", () => {
  const cfgs: [string, FieldConfig][] = [
    ["square", fieldOf("square", { shape: "rect", cols: 3, rows: 3 })],
    ["hex flat_top", fieldOf("hex", { shape: "parallelogram", cols: 3, rows: 3 }, "flat_top")],
    ["hex pointy_top", fieldOf("hex", { shape: "parallelogram", cols: 3, rows: 3 }, "pointy_top")],
    ["triangle", fieldOf("tri", { shape: "rect", cols: 3, rows: 3 })],
  ];

  it.each(cfgs)("round-trips every face index for %s", (_label, cfg) => {
    const degree = getNeighborData(cfg, 1, 1).offsets.length;
    for (let webIndex = 0; webIndex < degree; webIndex++) {
      const core = splitFaceIndexToCore(cfg, webIndex);
      expect(splitFaceIndexToWeb(cfg, core)).toBe(webIndex);
    }
  });

});

describe("nearestCellCoord (GitHub issue #337 follow-up)", () => {
  const cfgs: [string, FieldConfig][] = [
    ["square", fieldOf("square", { shape: "rect", cols: 9, rows: 9 })],
    ["hex flat_top", fieldOf("hex", { shape: "parallelogram", cols: 9, rows: 9 }, "flat_top")],
    ["hex pointy_top", fieldOf("hex", { shape: "parallelogram", cols: 9, rows: 9 }, "pointy_top")],
    ["triangle r0", fieldOf("tri", { shape: "rect", cols: 9, rows: 9 }, "r0")],
    ["triangle r90", fieldOf("tri", { shape: "rect", cols: 9, rows: 9 }, "r90")],
    ["triangle r180", fieldOf("tri", { shape: "rect", cols: 9, rows: 9 }, "r180")],
    ["triangle r270", fieldOf("tri", { shape: "rect", cols: 9, rows: 9 }, "r270")],
  ];

  it.each(cfgs)("round-trips every cell's own center back to itself for %s", (_label, cfg) => {
    for (let x = -3; x <= 3; x++) {
      for (let y = -3; y <= 3; y++) {
        const center = getCellCenter(x, y, cfg);
        expect(nearestCellCoord(center.x, center.y, cfg)).toEqual([x, y]);
      }
    }
  });

  it.each(cfgs)("snaps a point exactly midway between two cell centers to one of them, not a third cell, for %s", (_label, cfg) => {
    const a = getCellCenter(0, 0, cfg);
    const b = getCellCenter(1, 0, cfg);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const [sx, sy] = nearestCellCoord(mid.x, mid.y, cfg);
    const snapped = getCellCenter(sx, sy, cfg);
    const distToA = Math.hypot(snapped.x - a.x, snapped.y - a.y);
    const distToB = Math.hypot(snapped.x - b.x, snapped.y - b.y);
    expect(Math.min(distToA, distToB)).toBeLessThan(1e-6);
  });

  it("resolves a coordinate outside any real field the same way regardless of caller (deterministic, not clamped to a field)", () => {
    const cfg: FieldConfig = fieldOf("square", { shape: "rect", cols: 3, rows: 3 });
    const farCenter = getCellCenter(50, 50, cfg);
    expect(nearestCellCoord(farCenter.x, farCenter.y, cfg)).toEqual([50, 50]);
  });
});

describe("splitPatternsToWeb round-trip", () => {
  it("splitPatternsToWeb undoes splitPatternsToCore for a full pattern", () => {
    const cfg: FieldConfig = fieldOf("hex", { shape: "parallelogram", cols: 3, rows: 3 }, "flat_top");
    const original: SplitPattern[] = [
      {
        shape: "regular:4",
        node_count: 2,
        faces: [
          [{ face_index: 0, requirement: { kind: "passage" } }, { face_index: 3, requirement: { kind: "wall" } }],
          [{ face_index: 5, requirement: { kind: "one_way", direction: "forward" }, sibling_target: 0 }],
        ],
        weight: 1.0,
      },
    ];
    const roundTripped = splitPatternsToWeb(splitPatternsToCore(original, cfg), cfg);
    expect(roundTripped).toEqual(original);
  });
});
