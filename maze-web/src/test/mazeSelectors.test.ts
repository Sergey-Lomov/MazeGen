import { describe, it, expect, vi } from "vitest";
import { postEditEdgesToDto, buildClosedCells, buildTeleportEdges, buildMazeWalls, buildSplitPassages, buildMazeMarkers } from "../pixi/selectors/mazeSelectors";
import { nodeEndpoint } from "../pixi/postEditEndpoint";
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

const n = (id: number, x: number, y: number): NodeDto => ({ id, x, y });
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

  it("a split point's own geometric edges render no WallEdge at all (GitHub issue #223)", () => {
    // Point (0,0) split into node 0 (original) and node 2 (extra split node, wired to node 1).
    // Every edge touching (0,0) -- including its boundary walls -- must be entirely absent from
    // buildMazeWalls's output; split points render exclusively via buildSplitPassages instead.
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0)];
    const edges: EdgeDto[] = [e(2, 1), e(1, 2)];
    const walls = buildMazeWalls(nodes, edges, squareCfg);
    const touchingSplitPoint = walls.filter(w =>
      (w.a[0] === 0 && w.a[1] === 0) || (w.b[0] === 0 && w.b[1] === 0));
    expect(touchingSplitPoint).toEqual([]);
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
    expect(buildSplitPassages(nodes, [e(0, 1), e(1, 0)], squareCfg)).toEqual([]);
  });

  it("each connected split node gets one passage entry, in a distinct color", () => {
    // Point (0,0) split into node 0 (-> node 1 east) and node 2 (-> node 3 north).
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0), n(3, 0, 1)];
    const edges: EdgeDto[] = [e(0, 1), e(1, 0), e(2, 3), e(3, 2)];
    const passages = buildSplitPassages(nodes, edges, squareCfg);
    expect(passages).toHaveLength(2);
    expect(passages[0].color).not.toBe(passages[1].color);
    expect(passages[0].wallSegments).toHaveLength(1);
    expect(passages[1].wallSegments).toHaveLength(1);
  });

  it("a node with no connections produces no passage entry", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0)];
    const passages = buildSplitPassages(nodes, [], squareCfg);
    expect(passages).toEqual([]);
  });

  it("several edges from one node to different nodes of the same neighboring split point collapse to one wall segment per face", () => {
    // (0,0) split into node 0/node 4; (1,0) split into node 1/node 5. Node 0 connects to both
    // node 1 and node 5 (both at the same neighboring point, the east face) -- still just one
    // wall segment for node 0, even though it has two separate edges crossing that same face.
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0), n(3, 0, 1), n(4, 0, 0), n(5, 1, 0)];
    const edges: EdgeDto[] = [e(0, 1), e(1, 0), e(0, 5), e(5, 0)];
    const passages = buildSplitPassages(nodes, edges, squareCfg);
    // Node 0 -> east face (1 entry, deduped across its 2 edges to node 1 and node 5).
    // Node 1 -> west face (1 entry, its own edge back to node 0).
    // Node 5 -> west face (1 entry, its own edge back to node 0). Nodes 2/4 have no edges -> 0 entries.
    expect(passages).toHaveLength(3);
    for (const p of passages) expect(p.wallSegments).toHaveLength(1);
  });

  it("one-way passage's wall segment gets a direction vector, bidirectional does not", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0)];
    const oneWay = buildSplitPassages(nodes, [e(2, 1)], squareCfg);
    expect(oneWay[0].wallSegments[0].oneWayDir).toBeDefined();

    const twoWay = buildSplitPassages(nodes, [e(2, 1), e(1, 2)], squareCfg);
    expect(twoWay[0].wallSegments[0].oneWayDir).toBeUndefined();
  });

  it("a backward-only one-way passage points from the neighbor's center back toward this node, opposite of a forward-only one-way", () => {
    // Node 2 (slot 0 at (0,0)) has only an incoming edge from node 1 (east neighbor) -- the
    // mirror of the existing forward-only case, exercising the other arm of the fwd/bwd ternary.
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0)];
    const forwardOnly = buildSplitPassages(nodes, [e(2, 1)], squareCfg)[0].wallSegments[0].oneWayDir!;
    const backwardOnly = buildSplitPassages(nodes, [e(1, 2)], squareCfg)[0].wallSegments[0].oneWayDir!;
    expect(backwardOnly).toBeDefined();
    expect(backwardOnly.dx).toBeCloseTo(-forwardOnly.dx, 5);
    expect(backwardOnly.dy).toBeCloseTo(-forwardOnly.dy, 5);
  });

  it("a teleport edge between a split point's nodes is excluded from passage geometry entirely", () => {
    // Node 2 (slot 0 at (0,0)) has only a teleport edge to node 1 -- must not produce a wall
    // segment/passage at all, matching buildMazeWalls's own teleport exclusion.
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0)];
    const teleportOnly: EdgeDto = { from: 2, to: 1, kind: "teleport" };
    const passages = buildSplitPassages(nodes, [teleportOnly], squareCfg);
    expect(passages).toEqual([]);
  });

  it("a split node connected to a non-adjacent point produces no wall segment for that face", () => {
    // Node 2 (slot 0 at (0,0)) has an edge to node 1 at (2,0) -- not a geometric neighbor of
    // (0,0) in a square tessellation, so getSharedEdgeSegment returns null for that face.
    const nodes = [n(0, 0, 0), n(1, 2, 0), n(2, 0, 0)];
    const passages = buildSplitPassages(nodes, [e(2, 1), e(1, 2)], squareCfg);
    expect(passages).toEqual([]);
  });

  it("a node with exactly 2 connected faces gets a single straight connector between their centers, no hub point", () => {
    // Node 2 (slot 0 at split point (0,0)) connects east to node 1 and north to node 3.
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0), n(3, 0, 1)];
    const edges: EdgeDto[] = [e(2, 1), e(1, 2), e(2, 3), e(3, 2)];
    const passages = buildSplitPassages(nodes, edges, squareCfg);
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
    const passages = buildSplitPassages(nodes, edges, squareCfg, new Set([2]));
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
    const passages = buildSplitPassages(nodes, [e(2, 1), e(1, 2)], squareCfg);
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
    const passages = buildSplitPassages(nodes, edges, squareCfg);
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
