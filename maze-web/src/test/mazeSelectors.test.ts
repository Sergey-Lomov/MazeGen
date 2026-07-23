import { describe, it, expect, vi } from "vitest";
import { postEditEdgesToDto, buildClosedCells, buildTeleportEdges, buildMazeWalls, filterNodesToActiveSplitNode } from "../pixi/selectors/mazeSelectors";
import { nodeEndpoint, splitEndpoint } from "../pixi/postEditEndpoint";
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
  it("no wall on the (0,0)-(1,0) edge when only the split node (not the original) has a passage there", () => {
    // Reproduces the reported scenario: direct passage between two neighbors walled off (no edge
    // between node 0's coordinates and node 1 at all), then a split node (id 2) added at (0,0)
    // and wired to node 1 — the cell boundary between (0,0) and (1,0) should read as an open
    // passage (no wall segment), since `directed` is keyed by cell coordinates, not node id, so a
    // split node's edge to a neighbor cell should register on the same coordinate-pair key as the
    // original node's would.
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0)];
    const edges: EdgeDto[] = [e(2, 1), e(1, 2)]; // bidirectional passage: split node <-> node 1
    const walls = buildMazeWalls(nodes, edges, squareCfg);
    const boundary = walls.filter(w =>
      (w.a[0] === 0 && w.a[1] === 0 && w.b[0] === 1 && w.b[1] === 0) ||
      (w.a[0] === 1 && w.a[1] === 0 && w.b[0] === 0 && w.b[1] === 0));
    expect(boundary.every(w => w.kind === "both")).toBe(true);
  });
});

// --- filterNodesToActiveSplitNode ---

describe("filterNodesToActiveSplitNode", () => {
  it("point absent from splitPoints passes through untouched", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const edges = [e(0, 1)];
    const result = filterNodesToActiveSplitNode(nodes, edges, {}, {});
    expect(result.nodes).toEqual(nodes);
    expect(result.edges).toEqual(edges);
  });

  it("defaults to the original node when no active entry is set", () => {
    // Point (0,0) split into node 0 (original) and node 2 (slot 0). No postEditActiveSplitNode
    // entry -- must default to the original (node 0), dropping node 2 and its edge.
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0)];
    const edges = [e(0, 1), e(2, 1)];
    const result = filterNodesToActiveSplitNode(nodes, edges, { "0,0": [0] }, {});
    expect(result.nodes.map(nd => nd.id).sort()).toEqual([0, 1]);
    expect(result.edges).toEqual([e(0, 1)]);
  });

  it("keeps only the active split node's edges when a split node is active", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0)];
    const edges = [e(0, 1), e(2, 1)];
    const result = filterNodesToActiveSplitNode(
      nodes, edges, { "0,0": [0] }, { "0,0": splitEndpoint([0, 0], 0) },
    );
    expect(result.nodes.map(nd => nd.id).sort()).toEqual([1, 2]);
    expect(result.edges).toEqual([e(2, 1)]);
  });

  it("falls back to the original node when the active entry references a split node not yet in splitPoints/confirmed", () => {
    // A just-added split node (slot 1) is marked active, but the point's splitPoints/nodeMap only
    // knows about slot 0 (the addition hasn't been confirmed into the snapshot yet) -- the active
    // endpoint doesn't resolve, and must fall back to the original node rather than silently
    // keeping every node "active" (the bug this fallback fixes: an unresolved activeId matching no
    // real id would leave nothing filtered out).
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0)];
    const edges = [e(0, 1), e(2, 1)];
    const result = filterNodesToActiveSplitNode(
      nodes, edges, { "0,0": [0] }, { "0,0": splitEndpoint([0, 0], 1) },
    );
    expect(result.nodes.map(nd => nd.id).sort()).toEqual([0, 1]);
    expect(result.edges).toEqual([e(0, 1)]);
  });

  it("switching the active endpoint changes which edges survive", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0)];
    const edges = [e(0, 1), e(2, 1)];
    const originalActive = filterNodesToActiveSplitNode(
      nodes, edges, { "0,0": [0] }, { "0,0": nodeEndpoint(0) },
    );
    const splitActive = filterNodesToActiveSplitNode(
      nodes, edges, { "0,0": [0] }, { "0,0": splitEndpoint([0, 0], 0) },
    );
    expect(originalActive.edges).toEqual([e(0, 1)]);
    expect(splitActive.edges).toEqual([e(2, 1)]);
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
});
