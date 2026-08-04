import { describe, it, expect, vi } from "vitest";
import { postEditEdgesToDto, buildClosedCells, buildTeleportEdges, buildMazeWalls, buildSplitPassages, buildMazeMarkers, buildLinkHoverHighlight, maxSplitNodeCount } from "../pixi/selectors/mazeSelectors";
import { nodeEndpoint, splitEndpoint } from "../pixi/postEditEndpoint";
import { splitSlotColor } from "../pixi/colorUtils";
import { canvas } from "../pixi/colorTokens";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { PostEditEdge } from "../store/mazeStore";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";

vi.mock("pixi.js", () => ({
  Container: vi.fn(() => ({ addChild: vi.fn(), destroy: vi.fn() })),
  Graphics: vi.fn(() => ({ rect: vi.fn(), fill: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), poly: vi.fn() })),
}));

vi.mock("../store/mazeStore", () => ({
  useMazeStore: { getState: vi.fn(() => ({})), subscribe: vi.fn(() => () => {}) },
}));

// getCellCenter (via squareGeometry's getCartesian) delegates to wasm, unavailable in this
// unit-test environment -- mock with the canonical square formula (see
// `maze-core/src/space/square.rs`'s `cartesian`: `(x, y)`, no offset/flip applied here).
vi.mock("../wasm/mazeService", () => ({
  getCartesianCoords: (cfg: { points: [number, number][] }) => cfg.points.map(([x, y]) => [x, y]),
}));

// --- postEditEdgesToDto ---

const pe = (from: number, to: number, kind: PostEditEdge["kind"]): PostEditEdge =>
  ({ from: nodeEndpoint(from), to: nodeEndpoint(to), kind });
const noSplits = () => undefined;

describe("postEditEdgesToDto", () => {
  it("null input returns empty array", () => {
    expect(postEditEdgesToDto(null, noSplits)).toEqual([]);
  });

  it("filters out wall edges", () => {
    const input = {
      "0-1": pe(0, 1, "wall"),
      "1-2": pe(1, 2, "basic"),
    };
    const result = postEditEdgesToDto(input, noSplits);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ from: 1, to: 2, kind: "basic" });
  });

  it("includes basic and one_way edges", () => {
    const input = {
      "0-1": pe(0, 1, "basic"),
      "1-0": pe(1, 0, "basic"),
      "2-3": pe(2, 3, "one_way_forward"),
      "3-4": pe(3, 4, "one_way_backward"),
    };
    const result = postEditEdgesToDto(input, noSplits);
    expect(result).toHaveLength(4);
  });

  it("returns from/to plus a basic kind, dropping the post-edit tool kind", () => {
    const input = { "5-6": pe(5, 6, "basic") };
    const result = postEditEdgesToDto(input, noSplits);
    expect(result[0]).toEqual({ from: 5, to: 6, kind: "basic" });
    expect(Object.keys(result[0]).sort()).toEqual(["from", "kind", "to"]);
  });

  it("empty record returns empty array", () => {
    expect(postEditEdgesToDto({}, noSplits)).toEqual([]);
  });

  it("all walls returns empty array", () => {
    const input = {
      "0-1": pe(0, 1, "wall"),
      "1-2": pe(1, 2, "wall"),
    };
    expect(postEditEdgesToDto(input, noSplits)).toEqual([]);
  });

  it("drops an entry whose split endpoint doesn't resolve yet", () => {
    const input = { "s-1": { from: { kind: "split" as const, point: [1, 2] as [number, number], slotId: 0 }, to: nodeEndpoint(1), kind: "basic" as const } };
    expect(postEditEdgesToDto(input, noSplits)).toEqual([]);
  });

  it("resolves a split endpoint via resolveSplit", () => {
    const input = { "s-1": { from: { kind: "split" as const, point: [1, 2] as [number, number], slotId: 0 }, to: nodeEndpoint(1), kind: "basic" as const } };
    expect(postEditEdgesToDto(input, () => 42)).toEqual([{ from: 42, to: 1, kind: "basic" }]);
  });
});

// --- buildClosedCells ---

const n = (id: number, x: number, y: number): NodeDto => ({ id, x, y, i: 0 });
const e = (from: number, to: number): EdgeDto => ({ from, to, kind: "basic" });

describe("buildClosedCells", () => {
  it("no edges — all nodes are closed", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const result = buildClosedCells(nodes, []);
    expect(result).toHaveLength(2);
    expect(result).toContainEqual([0, 0]);
    expect(result).toContainEqual([1, 0]);
  });

  it("connected node not in result", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 2, 0)];
    const result = buildClosedCells(nodes, [e(0, 1)]);
    expect(result).not.toContainEqual([0, 0]);
    expect(result).not.toContainEqual([1, 0]);
    expect(result).toContainEqual([2, 0]);
  });

  it("all connected — empty result", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const result = buildClosedCells(nodes, [e(0, 1), e(1, 0)]);
    expect(result).toEqual([]);
  });

  it("empty nodes returns empty", () => {
    expect(buildClosedCells([], [])).toEqual([]);
  });

  it("single node with no edges is closed", () => {
    const result = buildClosedCells([n(0, 3, 5)], []);
    expect(result).toEqual([[3, 5]]);
  });

  it("edge referencing unknown node id still marks known node as connected", () => {
    const nodes = [n(0, 0, 0)];
    const result = buildClosedCells(nodes, [e(0, 99)]);
    expect(result).toEqual([]);
  });

  it("teleport-only edge counts as a connection — cell is not closed even with no geometric passage", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const teleportEdge: EdgeDto = { from: 0, to: 1, kind: "teleport" };
    const result = buildClosedCells(nodes, [teleportEdge]);
    expect(result).not.toContainEqual([0, 0]);
    expect(result).not.toContainEqual([1, 0]);
  });

  it("a split point's cell is not closed when only its non-original node has a connection", () => {
    // Two nodes at the same cell (0,0) — a split point (GitHub issue #221): node 0 is the
    // original (walled off, no edges), node 2 is an extra split node with a passage to node 1.
    // The cell as a whole is open via node 2, even though node 0 alone has none.
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0)];
    const result = buildClosedCells(nodes, [e(2, 1)]);
    expect(result).not.toContainEqual([0, 0]);
    expect(result).not.toContainEqual([1, 0]);
  });

  it("a split point's cell IS closed when none of its nodes have any connection", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0)];
    const result = buildClosedCells(nodes, []);
    expect(result).toContainEqual([0, 0]);
    expect(result).toContainEqual([1, 0]);
  });
});

// --- buildMazeWalls ---

describe("buildMazeWalls", () => {
  it("unsplit pair renders exactly as before", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const walls = buildMazeWalls(nodes, [], squareCfg);
    expect(walls.some(w => w.a[0] === 0 && w.a[1] === 0 && w.b[0] === 1 && w.b[1] === 0 && w.kind === "none")).toBe(true);
  });

  it("a split point's shared-with-neighbor face renders no WallEdge (GitHub issue #223), but its field-boundary faces still do (bug fix)", () => {
    // Point (0,0) split into node 0 (original) and node 2 (extra split node, wired to node 1).
    // The face shared with (1,0) is rendered exclusively via buildSplitPassages, so it must be
    // absent here -- but (0,0)'s other faces have no field neighbor at all, so buildSplitPassages
    // never draws them either; buildMazeWalls must still supply their outer wall.
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0)];
    const edges: EdgeDto[] = [e(2, 1), e(1, 2)];
    const walls = buildMazeWalls(nodes, edges, squareCfg);
    const touchingSplitPoint = walls.filter(w =>
      (w.a[0] === 0 && w.a[1] === 0) || (w.b[0] === 0 && w.b[1] === 0));
    expect(touchingSplitPoint.some(w => w.b[0] === 1 && w.b[1] === 0)).toBe(false);
    expect(touchingSplitPoint.every(w => w.kind === "none")).toBe(true);
    expect(touchingSplitPoint.length).toBe(3);
  });

  it("a split point's neighbor still renders its own boundary walls on faces not shared with the split point", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0)];
    const walls = buildMazeWalls(nodes, [], squareCfg);
    // Node 1 at (1,0) has a boundary wall to (2,0) (not in the field) — unaffected by (0,0) being split.
    expect(walls.some(w => w.a[0] === 1 && w.a[1] === 0 && w.b[0] === 2 && w.b[1] === 0)).toBe(true);
  });
});

// --- buildSplitPassages ---

describe("buildSplitPassages", () => {
  it("unsplit point produces no passages", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    expect(buildSplitPassages(nodes, [e(0, 1), e(1, 0)], squareCfg).passages).toEqual([]);
  });

  it("each connected split node gets one passage entry, in a distinct color", () => {
    // Point (0,0) split into node 0 (-> node 1 east) and node 2 (-> node 3 north).
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0), n(3, 0, 1)];
    const edges: EdgeDto[] = [e(0, 1), e(1, 0), e(2, 3), e(3, 2)];
    const { passages } = buildSplitPassages(nodes, edges, squareCfg);
    expect(passages).toHaveLength(2);
    expect(passages[0].color).not.toBe(passages[1].color);
    expect(passages[0].wallSegments).toHaveLength(1);
    expect(passages[1].wallSegments).toHaveLength(1);
  });

  it("a node with no connections produces no passage entry", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0)];
    const { passages } = buildSplitPassages(nodes, [], squareCfg);
    expect(passages).toEqual([]);
  });

  it("activeSplitNode picks which node of a point draws last (on top), overriding the default (first/original) node", () => {
    // Point (0,0) split into node 0 (original, slot index 0) and node 2 (slot index 1), both
    // connected east/north respectively so both produce a passage entry. `splitSlotColor` keys
    // off slot index (node 0 -> index 0, node 2 -> index 1), so the resulting color identifies
    // which node ended up in which array position regardless of active-last reordering.
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0), n(3, 0, 1)];
    const edges: EdgeDto[] = [e(0, 1), e(1, 0), e(2, 3), e(3, 2)];
    const withoutActive = buildSplitPassages(nodes, edges, squareCfg).passages;
    // Default (no activeSplitNode entry) keeps node-index order: node 0 (slot index 0) first.
    expect(withoutActive[0].color).toBe(splitSlotColor(0, canvas.node.splitSlots));
    expect(withoutActive[1].color).toBe(splitSlotColor(1, canvas.node.splitSlots));

    const withActive = buildSplitPassages(nodes, edges, squareCfg, new Set(), { "0,0": nodeEndpoint(0) }).passages;
    // node 0 (slot index 0) is now explicitly active -- it must be sorted last instead.
    expect(withActive[0].color).toBe(splitSlotColor(1, canvas.node.splitSlots));
    expect(withActive[1].color).toBe(splitSlotColor(0, canvas.node.splitSlots));
  });

  it("several edges from one node to different nodes of the same neighboring split point collapse to one wall segment per face", () => {
    // (0,0) split into node 0/node 4; (1,0) split into node 1/node 5. Node 0 connects to both
    // node 1 and node 5 (both at the same neighboring point, the east face) -- still just one
    // wall segment for node 0, even though it has two separate edges crossing that same face.
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0), n(3, 0, 1), n(4, 0, 0), n(5, 1, 0)];
    const edges: EdgeDto[] = [e(0, 1), e(1, 0), e(0, 5), e(5, 0)];
    const { passages } = buildSplitPassages(nodes, edges, squareCfg);
    // Node 0 -> east face (1 entry, deduped across its 2 edges to node 1 and node 5).
    // Node 1 -> west face (1 entry, its own edge back to node 0).
    // Node 5 -> west face (1 entry, its own edge back to node 0). Nodes 2/4 have no edges -> 0 entries.
    expect(passages).toHaveLength(3);
    for (const p of passages) expect(p.wallSegments).toHaveLength(1);
  });

  it("one-way passage's connector gets a direction marker, bidirectional does not", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0)];
    const oneWay = buildSplitPassages(nodes, [e(2, 1)], squareCfg).passages;
    expect(oneWay[0].connectors[0].oneWayOut).toBeDefined();

    const twoWay = buildSplitPassages(nodes, [e(2, 1), e(1, 2)], squareCfg).passages;
    expect(twoWay[0].connectors[0].oneWayOut).toBeUndefined();
  });

  it("a backward-only one-way passage's connector points the opposite way from a forward-only one-way", () => {
    // Node 2 (slot 0 at (0,0)) has only an incoming edge from node 1 (east neighbor) -- the
    // mirror of the existing forward-only case, exercising the other arm of the fwd/bwd ternary.
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0)];
    const forwardOnly = buildSplitPassages(nodes, [e(2, 1)], squareCfg).passages[0].connectors[0].oneWayOut;
    const backwardOnly = buildSplitPassages(nodes, [e(1, 2)], squareCfg).passages[0].connectors[0].oneWayOut;
    expect(forwardOnly).toBe(true);
    expect(backwardOnly).toBe(false);
  });

  it("a teleport edge between a split point's nodes is excluded from passage geometry entirely", () => {
    // Node 2 (slot 0 at (0,0)) has only a teleport edge to node 1 -- must not produce a wall
    // segment/passage at all, matching buildMazeWalls's own teleport exclusion.
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0)];
    const teleportOnly: EdgeDto = { from: 2, to: 1, kind: "teleport" };
    const { passages } = buildSplitPassages(nodes, [teleportOnly], squareCfg);
    expect(passages).toEqual([]);
  });

  it("a split node connected to a non-adjacent point produces no wall segment for that face", () => {
    // Node 2 (slot 0 at (0,0)) has an edge to node 1 at (2,0) -- not a geometric neighbor of
    // (0,0) in a square tessellation, so getSharedEdgeSegment returns null for that face.
    const nodes = [n(0, 0, 0), n(1, 2, 0), n(2, 0, 0)];
    const { passages } = buildSplitPassages(nodes, [e(2, 1), e(1, 2)], squareCfg);
    expect(passages).toEqual([]);
  });

  it("a node with exactly 2 connected faces gets a single straight connector between their centers, no hub point", () => {
    // Node 2 (slot 0 at split point (0,0)) connects east to node 1 and north to node 3.
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0), n(3, 0, 1)];
    const edges: EdgeDto[] = [e(2, 1), e(1, 2), e(2, 3), e(3, 2)];
    const { passages } = buildSplitPassages(nodes, edges, squareCfg);
    const node2Passage = passages.find(p => p.wallSegments.length === 2)!;
    expect(node2Passage.wallSegments).toHaveLength(2);
    expect(node2Passage.connectors).toHaveLength(1);
    expect(node2Passage.connectors[0].from).toEqual(node2Passage.wallSegments[0].center);
    expect(node2Passage.connectors[0].to).toEqual(node2Passage.wallSegments[1].center);
  });

  it("a node with 2 connected faces keeps its hub point when it carries a start/finish/teleport marker", () => {
    // Same setup as the straightening test above, but node 2 is now in `specialNodeIds`.
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0), n(3, 0, 1)];
    const edges: EdgeDto[] = [e(2, 1), e(1, 2), e(2, 3), e(3, 2)];
    const { passages } = buildSplitPassages(nodes, edges, squareCfg, new Set([2]));
    const node2Passage = passages.find(p => p.wallSegments.length === 2)!;
    expect(node2Passage.connectors).toHaveLength(2);
    const center = { x: 20, y: -20 };
    for (const c of node2Passage.connectors) {
      const dist = Math.hypot(c.from.x - center.x, c.from.y - center.y);
      expect(dist).toBeCloseTo(10, 5);
    }
  });

  it("a node with exactly 1 connected face gets one hub connector from the circle point", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0)];
    const { passages } = buildSplitPassages(nodes, [e(2, 1), e(1, 2)], squareCfg);
    const node2Passage = passages.find(p => p.wallSegments.length === 1)!;
    expect(node2Passage.connectors).toHaveLength(1);
    expect(node2Passage.connectors[0].to).toEqual(node2Passage.wallSegments[0].center);
    // Cell (0,0) center is (20, -20) in this test's cartesian mock — the connector's `from` must
    // sit on the circle (distance TILE_SIZE/4 = 10 from center), not at the center itself.
    const center = { x: 20, y: -20 };
    const dist = Math.hypot(node2Passage.connectors[0].from.x - center.x, node2Passage.connectors[0].from.y - center.y);
    expect(dist).toBeCloseTo(10, 5);
  });

  it("two nodes of the same split point sharing a face each get half the edge, non-overlapping", () => {
    // Point (0,0) split into node 0 (original) and node 2 (slot 0), both connected to node 1 east.
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0)];
    const edges: EdgeDto[] = [e(0, 1), e(1, 0), e(2, 1), e(1, 2)];
    const { passages } = buildSplitPassages(nodes, edges, squareCfg);
    expect(passages).toHaveLength(2);

    const [seg0, seg1] = passages.map(p => p.wallSegments[0]);
    // Each sub-segment spans half the shared edge -- their combined length equals the full edge,
    // and they don't overlap (share exactly one boundary point, node 0's v1 == node 2's v0 or
    // vice versa depending on slot order).
    const len = (v0: { x: number; y: number }, v1: { x: number; y: number }) =>
      Math.hypot(v1.x - v0.x, v1.y - v0.y);
    const fullEdgeLen = len(seg0.v0, seg1.v1) === len(seg0.v0, seg0.v1) + len(seg1.v0, seg1.v1)
      ? len(seg0.v0, seg1.v1) : len(seg1.v0, seg0.v1);
    expect(len(seg0.v0, seg0.v1) + len(seg1.v0, seg1.v1)).toBeCloseTo(fullEdgeLen, 5);
    expect(len(seg0.v0, seg0.v1)).toBeCloseTo(len(seg1.v0, seg1.v1), 5);

    // Each sub-segment's own center differs -- not both collapsing to the full edge's midpoint.
    expect(seg0.center).not.toEqual(seg1.center);
  });

  it("recognizes a degree-4 bridge topology (each node an opposite-face pair)", () => {
    // Point (0,0) split into node 0 (slot 0: east+west) and node 4 (slot 1: north+south).
    const nodes = [
      n(0, 0, 0), n(1, 1, 0), n(2, -1, 0),
      n(3, 0, 1), n(4, 0, 0), n(5, 0, -1),
    ];
    const edges: EdgeDto[] = [e(0, 1), e(1, 0), e(0, 2), e(2, 0), e(4, 3), e(3, 4), e(4, 5), e(5, 4)];
    const { specialShapes } = buildSplitPassages(nodes, edges, squareCfg);
    expect(specialShapes).toHaveLength(1);
    const shape = specialShapes[0];
    expect(shape.kind).toBe("bridge");
    expect(shape.pointKey).toBe("0,0");
    if (shape.kind !== "bridge") throw new Error("unreachable");
    // The cross corridor is north/south (the through corridor, east/west, draws nothing of its
    // own). Each edge is a 4-point polyline: full width at the cross faces (y = 0 and y = -40 in
    // this test's cartesian mock, i.e. the tile's own top/bottom edges), narrowing to 60% width at
    // 20%/80% of the tile's length, flat in between.
    expect(shape.edge0).toHaveLength(4);
    expect(shape.edge1).toHaveLength(4);
    const [e0start, e0taperIn, e0taperOut, e0end] = shape.edge0;
    const [e1start, e1taperIn, e1taperOut, e1end] = shape.edge1;
    // Full-width endpoints match the cross faces' own v0/v1 exactly.
    expect(e0start).toEqual(shape.crossFaces[0].v0);
    expect(e0end).toEqual(shape.crossFaces[1].v0);
    expect(e1start).toEqual(shape.crossFaces[0].v1);
    expect(e1end).toEqual(shape.crossFaces[1].v1);
    // The deck (taperIn -> taperOut) is flat: same width apart as it is at both ends of the deck.
    const width = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
    const fullWidth = width(e0start, e1start);
    const deckWidth = width(e0taperIn, e1taperIn);
    expect(width(e0taperOut, e1taperOut)).toBeCloseTo(deckWidth, 5);
    expect(deckWidth).toBeCloseTo(fullWidth * 0.6, 5);
    expect(deckWidth).toBeLessThan(fullWidth);

    // edge0/edge1 must run side by side, never crossing -- `nearestEndpointPairing` (mazeSelectors.ts)
    // picks which of crossFaces[1]'s two ends pairs with which of crossFaces[0]'s; picking the wrong
    // one draws a self-crossing "bowtie" bridge instead of two parallel edges. Checked by comparing
    // each edge's own x-offset from the shared corridor axis at both the start and end: same-sign
    // (never swapping sides) means non-crossing. The corridor axis here runs along y (north-south),
    // so "side" is which side of that vertical line each edge's x sits on.
    const axisX = (e0start.x + e1start.x) / 2;
    const e0StartSide = Math.sign(e0start.x - axisX);
    const e0EndSide = Math.sign(e0end.x - axisX);
    const e1StartSide = Math.sign(e1start.x - axisX);
    const e1EndSide = Math.sign(e1end.x - axisX);
    expect(e0StartSide).toBe(e0EndSide);
    expect(e1StartSide).toBe(e1EndSide);
    expect(e0StartSide).not.toBe(e1StartSide);
  });

  it("recognizes a degree-4 diagonal-divider topology (each node an adjacent-face pair)", () => {
    // Point (0,0) split into node 0 (slot 0: east+north) and node 4 (slot 1: west+south).
    const nodes = [
      n(0, 0, 0), n(1, 1, 0), n(2, 0, 1),
      n(3, -1, 0), n(4, 0, 0), n(5, 0, -1),
    ];
    const edges: EdgeDto[] = [e(0, 1), e(1, 0), e(0, 2), e(2, 0), e(4, 3), e(3, 4), e(4, 5), e(5, 4)];
    const { specialShapes } = buildSplitPassages(nodes, edges, squareCfg);
    expect(specialShapes).toHaveLength(1);
    const shape = specialShapes[0];
    expect(shape.kind).toBe("diagonal");
    if (shape.kind !== "diagonal") throw new Error("unreachable");
    // A real geometric diagonal between two opposite tile corners -- corner0 != corner1, and
    // both sit at the tile's own half-diagonal distance from center (10*sqrt(2) for a 20-wide
    // square tile in this test's cartesian mock).
    expect(shape.corner0).not.toEqual(shape.corner1);
    const center = { x: 20, y: -20 };
    const dist0 = Math.hypot(shape.corner0.x - center.x, shape.corner0.y - center.y);
    const dist1 = Math.hypot(shape.corner1.x - center.x, shape.corner1.y - center.y);
    expect(dist0).toBeCloseTo(dist1, 5);
    expect(dist0).toBeGreaterThan(10); // farther than the mid-face distance (10)

    // The diagonal must run through the corners where an east/north face (node 0) meets a
    // west/south face (node 1) -- (0,0)'s vertices are TL=(0,-40), TR=(40,-40), BR=(40,0),
    // BL=(0,0); node 0's own corner (E+N meet) is TR, node 1's own corner (W+S meet) is BL, but
    // the *dividing* diagonal must be the other pair: TL (N meets W) and BR (S meets E) -- so
    // every one of node 0's faces (E, N) ends up strictly on one side, node 1's (W, S) on the
    // other. Getting TR/BL here instead would put a face on the wrong side of the cut.
    const corners = [shape.corner0, shape.corner1];
    expect(corners).toContainEqual({ x: 0, y: -40 }); // TL
    expect(corners).toContainEqual({ x: 40, y: 0 }); // BR
  });

  it("a degree-4 point with 3+ nodes, or a mismatched opposite/adjacent pairing, is not recognized as a special shape", () => {
    // 3-node split point -- `detectSplitSpecialShapeKind` only ever matches exactly 2 nodes.
    const threeNodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 1), n(3, 0, 0), n(4, -1, 0), n(5, 0, 0), n(6, 0, -1)];
    const threeEdges: EdgeDto[] = [e(0, 1), e(1, 0), e(3, 4), e(4, 3), e(5, 6), e(6, 5)];
    expect(buildSplitPassages(threeNodes, threeEdges, squareCfg).specialShapes).toEqual([]);

    // 2 nodes, but one an opposite pair and the other adjacent -- doesn't match either shape.
    const mismatched = [n(0, 0, 0), n(1, 1, 0), n(2, -1, 0), n(3, 0, 0), n(4, 0, 1)];
    const mismatchedEdges: EdgeDto[] = [e(0, 1), e(1, 0), e(0, 2), e(2, 0), e(3, 4), e(4, 3)];
    expect(buildSplitPassages(mismatched, mismatchedEdges, squareCfg).specialShapes).toEqual([]);
  });
});

describe("maxSplitNodeCount", () => {
  it("returns 0 for an empty node list or a maze with no split points", () => {
    expect(maxSplitNodeCount([])).toBe(0);
    expect(maxSplitNodeCount([n(0, 0, 0), n(1, 1, 0)])).toBe(0);
  });

  it("returns the largest node count at any one split point", () => {
    const nodes = [
      n(0, 0, 0), n(1, 0, 0), // 2-node split point
      n(2, 1, 0), n(3, 1, 0), n(4, 1, 0), // 3-node split point
      n(5, 2, 0), // unsplit
    ];
    expect(maxSplitNodeCount(nodes)).toBe(3);
  });
});

// --- buildTeleportEdges ---

const squareCfg: TessellationConfig = { type: "square", width: 4, height: 4 };
const teleport = (from: number, to: number): EdgeDto => ({ from, to, kind: "teleport" });

describe("buildTeleportEdges", () => {
  it("one-way teleport: single directed edge produces one entity with oneWay=true", () => {
    const nodeById = new Map<number, NodeDto>([[0, n(0, 0, 0)], [1, n(1, 3, 3)]]);
    const result = buildTeleportEdges(nodeById, [teleport(0, 1)], squareCfg);
    expect(result).toHaveLength(1);
    expect(result[0].oneWay).toBe(true);
  });

  it("two-way teleport: both directions present collapse into one entity with oneWay=false", () => {
    const nodeById = new Map<number, NodeDto>([[0, n(0, 0, 0)], [1, n(1, 3, 3)]]);
    const result = buildTeleportEdges(nodeById, [teleport(0, 1), teleport(1, 0)], squareCfg);
    expect(result).toHaveLength(1);
    expect(result[0].oneWay).toBe(false);
  });

  it("non-teleport edges are ignored", () => {
    const nodeById = new Map<number, NodeDto>([[0, n(0, 0, 0)], [1, n(1, 3, 3)]]);
    const result = buildTeleportEdges(nodeById, [e(0, 1)], squareCfg);
    expect(result).toEqual([]);
  });

  it("multiple independent teleport pairs each produce their own entity", () => {
    const nodeById = new Map<number, NodeDto>([
      [0, n(0, 0, 0)], [1, n(1, 1, 0)], [2, n(2, 2, 0)], [3, n(3, 3, 0)],
    ]);
    const result = buildTeleportEdges(nodeById, [teleport(0, 1), teleport(2, 3)], squareCfg);
    expect(result).toHaveLength(2);
  });

  it("skips a teleport edge whose endpoint is missing from nodeById", () => {
    const nodeById = new Map<number, NodeDto>([[0, n(0, 0, 0)]]); // node 1 missing
    const result = buildTeleportEdges(nodeById, [teleport(0, 1)], squareCfg);
    expect(result).toEqual([]);
  });

  it("empty edges returns empty array", () => {
    const nodeById = new Map<number, NodeDto>([[0, n(0, 0, 0)]]);
    expect(buildTeleportEdges(nodeById, [], squareCfg)).toEqual([]);
  });

  it("resolves from/to to actual cell-center positions", () => {
    const nodeById = new Map<number, NodeDto>([[0, n(0, 0, 0)], [1, n(1, 2, 0)]]);
    const result = buildTeleportEdges(nodeById, [teleport(0, 1)], squareCfg);
    expect(result[0].from).not.toEqual(result[0].to);
  });

  it("a teleport endpoint on a split point anchors to that node's hub point, not the tile center (GitHub issue #223)", () => {
    // Point (0,0) split into node 0 (original) and node 2 (slot 0); node 2 is the teleport endpoint.
    const nodeById = new Map<number, NodeDto>([[0, n(0, 0, 0)], [1, n(1, 3, 3)], [2, n(2, 0, 0)]]);
    const result = buildTeleportEdges(nodeById, [teleport(2, 1)], squareCfg);
    expect(result).toHaveLength(1);
    const center = { x: 20, y: -20 }; // cell (0,0) center, see squareCfg comment above
    const dist = Math.hypot(result[0].from[0] - center.x, result[0].from[1] - center.y);
    expect(dist).toBeCloseTo(10, 5); // TILE_SIZE / 4, not 0 (tile center)
  });
});

// --- buildMazeMarkers ---

describe("buildMazeMarkers", () => {
  it("start/finish on unsplit nodes render at the plain cell center", () => {
    const nodeById = new Map<number, NodeDto>([[0, n(0, 0, 0)], [1, n(1, 1, 1)]]);
    const markers = buildMazeMarkers(nodeById, 0, 1, squareCfg);
    expect(markers).toHaveLength(2);
    expect(markers[0].pos).toEqual([20, -20]);
  });

  it("start on a split point anchors to that node's hub point, not the tile center (GitHub issue #223)", () => {
    // Point (0,0) split into node 0 (original) and node 2 (slot 0); node 2 is start.
    const nodeById = new Map<number, NodeDto>([[0, n(0, 0, 0)], [1, n(1, 1, 1)], [2, n(2, 0, 0)]]);
    const markers = buildMazeMarkers(nodeById, 2, null, squareCfg);
    expect(markers).toHaveLength(1);
    const center = { x: 20, y: -20 };
    const dist = Math.hypot(markers[0].pos[0] - center.x, markers[0].pos[1] - center.y);
    expect(dist).toBeCloseTo(10, 5);
  });

  it("null start/finish produce no markers", () => {
    const nodeById = new Map<number, NodeDto>([[0, n(0, 0, 0)]]);
    expect(buildMazeMarkers(nodeById, null, null, squareCfg)).toEqual([]);
  });
});

// --- buildLinkHoverHighlight ---

describe("buildLinkHoverHighlight", () => {
  const noSplitsResolver = () => undefined;

  it("null link produces no highlight", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    expect(buildLinkHoverHighlight(null, nodes, noSplitsResolver, squareCfg)).toEqual([]);
  });

  it("resolves both plain-node endpoints to their cell centers", () => {
    const nodes = [n(0, 0, 0), n(1, 2, 0)];
    const link = { from: nodeEndpoint(0), to: nodeEndpoint(1) };
    const result = buildLinkHoverHighlight(link, nodes, noSplitsResolver, squareCfg);
    expect(result).toHaveLength(1);
    expect(result[0].from).not.toEqual(result[0].to);
  });

  it("returns no highlight when the from endpoint doesn't resolve to a node id", () => {
    const nodes = [n(1, 1, 0)];
    const link = { from: nodeEndpoint(0), to: nodeEndpoint(1) }; // node 0 missing from resolver output too
    expect(buildLinkHoverHighlight(link, nodes, noSplitsResolver, squareCfg)).toEqual([]);
  });

  it("returns no highlight for an unresolved split endpoint (not yet confirmed)", () => {
    const nodes = [n(0, 0, 0)];
    const link = { from: nodeEndpoint(0), to: splitEndpoint([1, 0], 0) };
    // noSplitsResolver always returns undefined -> the split endpoint never resolves.
    expect(buildLinkHoverHighlight(link, nodes, noSplitsResolver, squareCfg)).toEqual([]);
  });

  it("returns no highlight when a resolved id isn't present in the nodes snapshot", () => {
    const nodes = [n(0, 0, 0)]; // node 1 missing
    const link = { from: nodeEndpoint(0), to: nodeEndpoint(1) };
    expect(buildLinkHoverHighlight(link, nodes, noSplitsResolver, squareCfg)).toEqual([]);
  });

  it("resolves a split endpoint via the resolver to its own hub point", () => {
    // Point (0,0) split into node 0 (original) and node 2 (slot 0).
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0)];
    const resolveSplit = (point: [number, number], slotId: number) =>
      point[0] === 0 && point[1] === 0 && slotId === 0 ? 2 : undefined;
    const link = { from: nodeEndpoint(1), to: splitEndpoint([0, 0], 0) };
    const result = buildLinkHoverHighlight(link, nodes, resolveSplit, squareCfg);
    expect(result).toHaveLength(1);
    expect(result[0].from).not.toEqual(result[0].to);
  });
});
