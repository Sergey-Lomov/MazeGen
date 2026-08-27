import { describe, it, expect, vi } from "vitest";
import { postEditEdgesToDto, buildClosedCells, buildTeleportEdges, buildMazeWalls, buildCorridorSegments, buildSplitPassages, buildMazeMarkers, buildLinkHoverHighlight, getSplitAwareNodePosition, maxSplitNodeCount, selectFloorRemovalLosesFieldData, selectFloorChangeLosesGenerationData, selectFloorScopedMaze, selectNodeLevelResolver, type MarkerStyle } from "../pixi/selectors/mazeSelectors";
import { nodeEndpoint, splitEndpoint } from "../pixi/postEditEndpoint";
import { getCellCenter, getCellVertices } from "../pixi/tessellationGeometry";
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

  // --- allEdges (GitHub issue #337 follow-up: one-way VerticalPassage arrival end) ---

  it("without allEdges, a one-way VerticalPassage's arrival-only cell (edge absent from the floor-scoped edges list) is wrongly closed", () => {
    // Mirrors what a floor-aware caller's own `edges` looks like on the arrival floor:
    // `selectFloorScopedMaze` drops a vertical_passage edge whose `from` isn't on this floor, so
    // `edges` here has nothing at all for node 0.
    const nodes = [n(0, 0, 0)];
    const result = buildClosedCells(nodes, []);
    expect(result).toContainEqual([0, 0]);
  });

  it("allEdges recovers a one-way VerticalPassage's arrival-only cell as connected", () => {
    const nodes = [n(0, 0, 0)];
    const verticalEdge: EdgeDto = { from: 99, to: 0, kind: "vertical_passage" };
    const result = buildClosedCells(nodes, [], [verticalEdge]);
    expect(result).not.toContainEqual([0, 0]);
  });

  it("allEdges does not treat an unrelated edge kind as a vertical arrival", () => {
    const nodes = [n(0, 0, 0)];
    const teleportEdge: EdgeDto = { from: 99, to: 0, kind: "teleport" };
    const result = buildClosedCells(nodes, [], [teleportEdge]);
    expect(result).toContainEqual([0, 0]);
  });

  // GitHub issue #359 follow-up: an Elevator arrival-only cell was still wrongly closed even with
  // allEdges — the allEdges pass only ever checked `kind === "vertical_passage"`, never "elevator".
  it("allEdges recovers an Elevator's arrival-only cell as connected", () => {
    const nodes = [n(0, 0, 0)];
    const elevatorEdge: EdgeDto = { from: 99, to: 0, kind: "elevator" };
    const result = buildClosedCells(nodes, [], [elevatorEdge]);
    expect(result).not.toContainEqual([0, 0]);
  });

  // GitHub issue #359 follow-up: a one-way VerticalPassage's own *departure* cell (its `from`, on
  // this floor) was still wrongly closed on PostEdit — vertical passage/elevator edges are never
  // post-edit-editable, so neither end is in `edges`/`activeEdges`, but the allEdges pass only ever
  // checked `e.to`, never `e.from`.
  it("allEdges recovers a one-way VerticalPassage's own departure cell as connected", () => {
    const nodes = [n(0, 0, 0)];
    const verticalEdge: EdgeDto = { from: 0, to: 99, kind: "vertical_passage" };
    const result = buildClosedCells(nodes, [], [verticalEdge]);
    expect(result).not.toContainEqual([0, 0]);
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

// --- buildCorridorSegments ---

describe("buildCorridorSegments", () => {
  it("no edges — no segments", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    expect(buildCorridorSegments(nodes, [], squareCfg)).toEqual([]);
  });

  it("a connected pair draws a center-to-center segment", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const segments = buildCorridorSegments(nodes, [e(0, 1), e(1, 0)], squareCfg);
    expect(segments).toHaveLength(1);
    expect(segments[0].v0).toEqual(getCellCenter(0, 0, squareCfg));
    expect(segments[0].v1).toEqual(getCellCenter(1, 0, squareCfg));
  });

  it("a one-way passage draws the same v0/v1 as a bidirectional one, but carries its own oneWayDir (GitHub issue #312)", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const oneWay = buildCorridorSegments(nodes, [e(0, 1)], squareCfg);
    const both = buildCorridorSegments(nodes, [e(0, 1), e(1, 0)], squareCfg);
    expect(oneWay).toHaveLength(1);
    expect(oneWay[0].v0).toEqual(both[0].v0);
    expect(oneWay[0].v1).toEqual(both[0].v1);
    expect(oneWay[0].oneWayDir).toEqual({ dx: 1, dy: 0 });
    expect(both[0].oneWayDir).toBeUndefined();
  });

  it("a backward-only one-way passage's oneWayDir points from v1 toward v0", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const backward = buildCorridorSegments(nodes, [e(1, 0)], squareCfg);
    expect(backward).toHaveLength(1);
    expect(backward[0].oneWayDir).toEqual({ dx: -1, dy: 0 });
  });

  it("does not draw a segment for an unconnected neighbor pair", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    expect(buildCorridorSegments(nodes, [], squareCfg)).toEqual([]);
  });

  it("does not draw a segment for a teleport-only edge", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const teleportEdge: EdgeDto = { from: 0, to: 1, kind: "teleport" };
    expect(buildCorridorSegments(nodes, [teleportEdge], squareCfg)).toEqual([]);
  });

  it("skips a split-to-split edge entirely (drawn by buildSplitPassages instead)", () => {
    // Point (0,0) split into node 0 (original) and node 2 (extra split node); node 0 <-> node 2
    // is an inter-split edge at the same point, drawn by buildSplitPassages, never a corridor
    // segment.
    const nodes = [n(0, 0, 0), n(2, 0, 0)];
    const edges: EdgeDto[] = [e(0, 2), e(2, 0)];
    expect(buildCorridorSegments(nodes, edges, squareCfg)).toEqual([]);
  });

  it("a plain cell neighboring a split point still draws its own stub, shortened to the shared face's own midpoint (GitHub issue #314)", () => {
    // Point (0,0) split into node 0 (original) and node 2 (extra split node, wired to node 1).
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0)];
    const edges: EdgeDto[] = [e(2, 1), e(1, 2)];
    const segments = buildCorridorSegments(nodes, edges, squareCfg);
    expect(segments).toHaveLength(1);
    expect(segments[0].fromNode).toBe(1);
    expect(segments[0].toNode).toBe(2);
    expect(segments[0].v0).toEqual(getCellCenter(1, 0, squareCfg));
    // Shortened to the face midpoint between (1,0) and (0,0), not all the way to (0,0)'s own center.
    expect(segments[0].v1).not.toEqual(getCellCenter(0, 0, squareCfg));
  });

  it("a split point's unrelated neighbor still draws its own ordinary corridor segments", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0), n(3, 2, 0)];
    const edges: EdgeDto[] = [e(1, 3), e(3, 1)];
    const segments = buildCorridorSegments(nodes, edges, squareCfg);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toEqual({
      v0: getCellCenter(1, 0, squareCfg), v1: getCellCenter(2, 0, squareCfg),
      oneWayDir: undefined, fromNode: 1, toNode: 3, v1TouchesSplit: false,
    });
  });

  it("emits each connected pair's segment only once, not once per direction", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const segments = buildCorridorSegments(nodes, [e(0, 1), e(1, 0)], squareCfg);
    expect(segments).toHaveLength(1);
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

  it("corridorConnectorWidth (GitHub issue #314 follow-up): several nodes sharing a face divide the ordinary corridor's own width, centered on the face's own midpoint, not the whole face", () => {
    // (0,0) split into node 1/node 5, both facing east toward (1,0)'s node 0 -- same fixture shape
    // as the "collapse to one wall segment per face" test above, mirrored so the *receiving* point
    // (0,0) is the one with 2 nodes sharing a face. The shared face runs from (40,-40) to (40,0) in
    // this test's cartesian mock (see `squareCfg`'s own convention elsewhere in this file); its own
    // midpoint is (40,-20).
    const nodes = [n(0, 1, 0), n(1, 0, 0), n(2, 0, 1), n(3, 1, 0), n(4, -1, 0), n(5, 0, 0)];
    const edges: EdgeDto[] = [e(0, 1), e(1, 0), e(0, 5), e(5, 0)];
    const withoutWidth = buildSplitPassages(nodes, edges, squareCfg).passages.filter((p) => p.pointKey === "0,0");
    expect(withoutWidth).toHaveLength(2);
    const [a, b] = withoutWidth;
    // Default (no corridorConnectorWidth): the shared face's own full 40-length span is divided in
    // half — each share's own center sits 20 away from the face's own (40,-20) midpoint.
    expect(Math.abs(a.wallSegments[0].center.y - -20)).toBeCloseTo(10, 5);
    expect(Math.abs(b.wallSegments[0].center.y - -20)).toBeCloseTo(10, 5);

    // With corridorConnectorWidth (the ordinary corridor's own thickness): each share's own center
    // sits `width / 4` away from the face's own midpoint (half of `width / 2`), regardless of the
    // face's own (much larger) 40-length span.
    const width = 10;
    const withWidth = buildSplitPassages(nodes, edges, squareCfg, new Set(), {}, {}, undefined, width).passages.filter((p) => p.pointKey === "0,0");
    const [wa, wb] = withWidth;
    expect(Math.abs(wa.wallSegments[0].center.y - -20)).toBeCloseTo(width / 4, 5);
    expect(Math.abs(wb.wallSegments[0].center.y - -20)).toBeCloseTo(width / 4, 5);
    expect(wa.wallSegments[0].center.x).toBeCloseTo(40, 5);
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
    // the original gradual 20% taper, flat in between.
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
    const midpoint = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
      x: (a.x + b.x) / 2, y: (a.y + b.y) / 2,
    });
    const taperAxialLength = width(midpoint(e0start, e1start), midpoint(e0taperIn, e1taperIn));
    const bridgeLength = width(midpoint(e0start, e1start), midpoint(e0end, e1end));
    expect(taperAxialLength / bridgeLength).toBeCloseTo(0.2, 5);

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

// --- hex special shapes (GitHub issue #319) ---

// flat_top hex, offsets (HEX_NEIGHBOR_OFFSETS_FLAT): 0=(1,0) 1=(0,1) 2=(-1,1) 3=(-1,0) 4=(0,-1) 5=(1,-1)
// Opposite pairs: (0,3) (1,4) (2,5). Adjacent pairs: (i,i+1). Skip pairs: (i,i+2).
// Neighbor node ids are always 1..6 (one per face index); split-point node ids start at 100 to
// avoid colliding with them.
const hexCfg: TessellationConfig = { type: "hex_hexagon", radius: 4 };
const hexNeighborNodes = (x: number, y: number) => [
  n(1, x + 1, y), n(2, x, y + 1), n(3, x - 1, y + 1),
  n(4, x - 1, y), n(5, x, y - 1), n(6, x + 1, y - 1),
];

describe("hex special shapes", () => {
  it("recognizes a hex_bridge topology (2 opposite-face pairs)", () => {
    // Point (0,0) split into node 100 (faces 0,3 -- opposite) and node 101 (faces 1,4 -- opposite).
    const neighbors = hexNeighborNodes(0, 0);
    const nodes = [n(100, 0, 0), n(101, 0, 0), ...neighbors];
    const edges: EdgeDto[] = [
      e(100, 1), e(1, 100), e(100, 4), e(4, 100),
      e(101, 2), e(2, 101), e(101, 5), e(5, 101),
    ];
    const { specialShapes } = buildSplitPassages(nodes, edges, hexCfg);
    expect(specialShapes).toHaveLength(1);
    const shape = specialShapes[0];
    expect(shape.kind).toBe("bridge");
    expect(shape.pointKey).toBe("0,0");
    if (shape.kind !== "bridge") throw new Error("unreachable");
    const midpoint = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
      x: (a.x + b.x) / 2, y: (a.y + b.y) / 2,
    });
    const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      Math.hypot(a.x - b.x, a.y - b.y);
    const taperLength = distance(midpoint(shape.edge0[0], shape.edge1[0]), midpoint(shape.edge0[1], shape.edge1[1]));
    const bridgeLength = distance(midpoint(shape.edge0[0], shape.edge1[0]), midpoint(shape.edge0[3], shape.edge1[3]));
    expect(taperLength / bridgeLength).toBeCloseTo(0.08 * (1 - 0.6) / (1 - 0.4), 5);
  });

  it("recognizes a hex_triple_bridge topology (3 opposite-face pairs, node0 < node1 < node2 layering)", () => {
    // Point (0,0) split into node 100 (faces 0,3), node 101 (faces 1,4), node 102 (faces 2,5).
    const neighbors = hexNeighborNodes(0, 0);
    const nodes = [n(100, 0, 0), n(101, 0, 0), n(102, 0, 0), ...neighbors];
    const edges: EdgeDto[] = [
      e(100, 1), e(1, 100), e(100, 4), e(4, 100),
      e(101, 2), e(2, 101), e(101, 5), e(5, 101),
      e(102, 3), e(3, 102), e(102, 6), e(6, 102),
    ];
    const { specialShapes } = buildSplitPassages(nodes, edges, hexCfg);
    // node0 (through corridor) draws nothing of its own; node1 and node2 each cross it once.
    expect(specialShapes).toHaveLength(2);
    for (const shape of specialShapes) {
      expect(shape.kind).toBe("bridge");
      expect(shape.pointKey).toBe("0,0");
    }
  });

  it("recognizes a hex_diagonal topology, 2-shared-corner sub-case (adjacent pairs)", () => {
    // Point (0,0) split into node 100 (faces 0,1 -- adjacent) and node 101 (faces 3,4 -- adjacent).
    const neighbors = hexNeighborNodes(0, 0);
    const nodes = [n(100, 0, 0), n(101, 0, 0), ...neighbors];
    const edges: EdgeDto[] = [
      e(100, 1), e(1, 100), e(100, 2), e(2, 100),
      e(101, 4), e(4, 101), e(101, 5), e(5, 101),
    ];
    const { specialShapes } = buildSplitPassages(nodes, edges, hexCfg);
    expect(specialShapes).toHaveLength(1);
    const shape = specialShapes[0];
    expect(shape.kind).toBe("diagonal");
    if (shape.kind !== "diagonal") throw new Error("unreachable");
    expect(shape.corner0).not.toEqual(shape.corner1);
    expect(shape.throughLine).toBeUndefined();
  });

  it("recognizes a hex_diagonal topology, 1-shared-corner sub-case (skip pair + adjacent pair)", () => {
    // Point (0,0) split into node 100 (faces 0,2 -- skip) and node 101 (faces 4,5 -- adjacent).
    // Faces 2 and 4 share one real corner; face 0 and face 5 leave a gap (no shared corner).
    const neighbors = hexNeighborNodes(0, 0);
    const nodes = [n(100, 0, 0), n(101, 0, 0), ...neighbors];
    const edges: EdgeDto[] = [
      e(100, 1), e(1, 100), e(100, 3), e(3, 100),
      e(101, 5), e(5, 101), e(101, 6), e(6, 101),
    ];
    const { specialShapes } = buildSplitPassages(nodes, edges, hexCfg);
    expect(specialShapes).toHaveLength(1);
    const shape = specialShapes[0];
    expect(shape.kind).toBe("diagonal");
    if (shape.kind !== "diagonal") throw new Error("unreachable");
    expect(shape.corner0).not.toEqual(shape.corner1);
  });

  it("renders a hex diagonal divider with the exact same wall line as 0-2 / 3-5", () => {
    const neighbors = hexNeighborNodes(0, 0);
    const nodes = [n(100, 0, 0), n(101, 0, 0), ...neighbors];
    const edgesFor = (faces: number[][]): EdgeDto[] => faces.flatMap((nodeFaces, nodeIndex) =>
      nodeFaces.flatMap((face) => [e(100 + nodeIndex, face + 1), e(face + 1, 100 + nodeIndex)]),
    );
    const divider = buildSplitPassages(nodes, edgesFor([[0, 1, 2], [3, 4, 5]]), hexCfg).specialShapes;
    const doublePassage = buildSplitPassages(nodes, edgesFor([[0, 2], [3, 5]]), hexCfg).specialShapes;
    expect(divider).toHaveLength(1);
    expect(doublePassage).toHaveLength(1);
    expect(divider[0]).toMatchObject({
      kind: "diagonal",
      corner0: doublePassage[0].kind === "diagonal" ? doublePassage[0].corner0 : null,
      corner1: doublePassage[0].kind === "diagonal" ? doublePassage[0].corner1 : null,
    });
    if (divider[0].kind !== "diagonal") throw new Error("unreachable");
    expect(divider[0].dividerJunctions).toHaveLength(2);
    expect(divider[0].dividerJunctions?.[0]).not.toEqual(divider[0].dividerJunctions?.[1]);
  });

  it("recognizes a hex_triple_corridor topology (1 opposite + 2 adjacent pairs)", () => {
    // Point (0,0) split into node 100 (faces 0,3 -- opposite/through), node 101 (faces 1,2 -- adjacent),
    // node 102 (faces 4,5 -- adjacent).
    const neighbors = hexNeighborNodes(0, 0);
    const nodes = [n(100, 0, 0), n(101, 0, 0), n(102, 0, 0), ...neighbors];
    const edges: EdgeDto[] = [
      e(100, 1), e(1, 100), e(100, 4), e(4, 100),
      e(101, 2), e(2, 101), e(101, 3), e(3, 101),
      e(102, 5), e(5, 102), e(102, 6), e(6, 102),
    ];
    const { specialShapes } = buildSplitPassages(nodes, edges, hexCfg);
    expect(specialShapes).toHaveLength(2);
    for (const shape of specialShapes) {
      expect(shape.kind).toBe("diagonal");
      expect(shape.pointKey).toBe("0,0");
    }
    const diagonalShapes = specialShapes.filter((shape) => shape.kind === "diagonal");
    const verts = getCellVertices(0, 0, hexCfg)!;
    const endpointPairs = diagonalShapes.map((shape) => [shape.corner0, shape.corner1]);
    expect(endpointPairs).toEqual(expect.arrayContaining([
      expect.arrayContaining([verts[0], verts[4]]),
      expect.arrayContaining([verts[1], verts[3]]),
    ]));
    expect(diagonalShapes.every((shape) => shape.wallPath?.length === 3)).toBe(true);
    const bends = diagonalShapes.map((shape) => shape.wallPath![1]);
    const diameter = Math.hypot(verts[0].x - verts[3].x, verts[0].y - verts[3].y);
    expect(Math.hypot(bends[0].x - bends[1].x, bends[0].y - bends[1].y)).toBeCloseTo(diameter / 3, 5);
    // Exactly one of the two entries carries the shared through-line.
    const withThroughLine = specialShapes.filter((s) => s.kind === "diagonal" && s.throughLine);
    expect(withThroughLine).toHaveLength(1);
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

  // --- cross-floor (GitHub issue #337) ---

  const nLevel = (id: number, x: number, y: number, level: number): NodeDto => ({ id, x, y, i: 0, level });

  it("cross-floor one-way teleport: no reverse edge on either floor produces oneWay=true with a midpoint toFloor", () => {
    // Node 0 (floor 0) -> node 1 (floor 1). `edges` (floor-scoped, as a real caller would pass) only
    // has node 0's own teleport edge — node 1's reverse (if any) would have its own `from` on floor 1,
    // never present here.
    const floor0Nodes: NodeDto[] = [nLevel(0, 0, 0, 0)];
    const unscopedNodes: NodeDto[] = [nLevel(0, 0, 0, 0), nLevel(1, 3, 3, 1)];
    const unscopedEdges: EdgeDto[] = [teleport(0, 1)];
    const nodeById = new Map(floor0Nodes.map((n) => [n.id, n]));
    const result = buildTeleportEdges(nodeById, unscopedEdges, squareCfg, {
      resolveNodeLevel: selectNodeLevelResolver(unscopedNodes),
      unscopedNodeById: new Map(unscopedNodes.map((n) => [n.id, n])),
      unscopedEdges,
      activeFloorIndex: 0,
    });
    expect(result).toHaveLength(1);
    expect(result[0].oneWay).toBe(true);
    expect(result[0].toFloor).toBe(1);
  });

  it("cross-floor two-way teleport: a reverse edge on the other floor produces oneWay=false", () => {
    const floor0Nodes: NodeDto[] = [nLevel(0, 0, 0, 0)];
    const unscopedNodes: NodeDto[] = [nLevel(0, 0, 0, 0), nLevel(1, 3, 3, 1)];
    // The reverse edge's own `from` (node 1) lives on floor 1 — never in `edges` for a floor-0 render,
    // only in `unscopedEdges`, same as a real floor-scoped caller would have it.
    const unscopedEdges: EdgeDto[] = [teleport(0, 1), teleport(1, 0)];
    const floor0Edges: EdgeDto[] = [teleport(0, 1)];
    const nodeById = new Map(floor0Nodes.map((n) => [n.id, n]));
    const result = buildTeleportEdges(nodeById, floor0Edges, squareCfg, {
      resolveNodeLevel: selectNodeLevelResolver(unscopedNodes),
      unscopedNodeById: new Map(unscopedNodes.map((n) => [n.id, n])),
      unscopedEdges,
      activeFloorIndex: 0,
    });
    expect(result).toHaveLength(1);
    expect(result[0].oneWay).toBe(false);
    expect(result[0].toFloor).toBe(1);
  });

  it("cross-floor midpoint is the same world point whichever floor is active (GitHub issue #337 follow-up)", () => {
    // Same pair (node 0 @ floor 0, node 1 @ floor 1) rendered once from each floor's own
    // perspective — the badge's own world position must match exactly either way, or it visibly
    // jumps when the user switches floors.
    const unscopedNodes: NodeDto[] = [nLevel(0, 0, 0, 0), nLevel(1, 3, 3, 1)];
    const unscopedEdges: EdgeDto[] = [teleport(0, 1), teleport(1, 0)];
    const resolveNodeLevel = selectNodeLevelResolver(unscopedNodes);
    const unscopedNodeById = new Map(unscopedNodes.map((n) => [n.id, n]));

    const fromFloor0 = buildTeleportEdges(
      new Map([[0, nLevel(0, 0, 0, 0)]]), [teleport(0, 1)], squareCfg,
      { resolveNodeLevel, unscopedNodeById, unscopedEdges, activeFloorIndex: 0 },
    );
    const fromFloor1 = buildTeleportEdges(
      new Map([[1, nLevel(1, 3, 3, 1)]]), [teleport(1, 0)], squareCfg,
      { resolveNodeLevel, unscopedNodeById, unscopedEdges, activeFloorIndex: 1 },
    );

    expect(fromFloor0).toHaveLength(1);
    expect(fromFloor1).toHaveLength(1);
    // Floor 0's own badge sits at its `to` (node 1 is off-floor there); floor 1's own badge sits at
    // its `to` too (node 0 is off-floor there) — both must be the exact same world point.
    expect(fromFloor0[0].to).toEqual(fromFloor1[0].to);
  });

  it("cross-floor one-way teleport's arrival floor shows a badge->marker entity too (GitHub issue #357 follow-up)", () => {
    // Node 0 (floor 0) -> node 1 (floor 1), pure one-way, no reverse edge anywhere. Rendered from
    // floor 1's own perspective: `edges` (floor-scoped) is empty for this pair (its only edge's
    // `from` is node 0, on floor 0), so the ordinary loop produces nothing — the arrival-only scan
    // must pick it up from `unscopedEdges` instead.
    const floor1Nodes: NodeDto[] = [nLevel(1, 3, 3, 1)];
    const unscopedNodes: NodeDto[] = [nLevel(0, 0, 0, 0), nLevel(1, 3, 3, 1)];
    const unscopedEdges: EdgeDto[] = [teleport(0, 1)];
    const nodeById = new Map(floor1Nodes.map((n) => [n.id, n]));
    const result = buildTeleportEdges(nodeById, [], squareCfg, {
      resolveNodeLevel: selectNodeLevelResolver(unscopedNodes),
      unscopedNodeById: new Map(unscopedNodes.map((n) => [n.id, n])),
      unscopedEdges,
      activeFloorIndex: 1,
    });
    expect(result).toHaveLength(1);
    expect(result[0].oneWay).toBe(true);
    expect(result[0].fromFloor).toBe(0);
    expect(result[0].toFloor).toBeUndefined();
    // The real, on-floor marker (node 1) is `to` — the badge (standing in for the off-floor
    // departure end) is `from`.
    expect(result[0].to).toEqual([getCellCenter(3, 3, squareCfg).x, getCellCenter(3, 3, squareCfg).y]);
  });
});

// --- getSplitAwareNodePosition ---
// Direct tests (GitHub issue #318 follow-up) — buildMazeMarkers/buildTeleportEdges no longer call
// this function themselves (they build the position map once via buildNodePositions instead), so
// it needs its own coverage as a still-exported, still-used (exportWarnings.ts) function.

describe("getSplitAwareNodePosition", () => {
  it("returns null for an unknown node id", () => {
    const nodes = [n(0, 0, 0)];
    expect(getSplitAwareNodePosition(nodes, 99, squareCfg)).toBeNull();
  });

  it("an unsplit node resolves to its plain cell center", () => {
    const nodes = [n(0, 1, 1)];
    expect(getSplitAwareNodePosition(nodes, 0, squareCfg)).toEqual(getCellCenter(1, 1, squareCfg));
  });

  it("a split node without edges falls back to the generic hub position", () => {
    const nodes = [n(0, 0, 0), n(1, 0, 0)];
    const center = getCellCenter(0, 0, squareCfg);
    const dist = Math.hypot(
      getSplitAwareNodePosition(nodes, 1, squareCfg)!.x - center.x,
      getSplitAwareNodePosition(nodes, 1, squareCfg)!.y - center.y,
    );
    expect(dist).toBeCloseTo(10); // TILE_SIZE / 4
  });

  it("a node recognized as a diagonal split shape resolves to its own half-tile point, not the hub circle", () => {
    const nodes = [
      n(0, 0, 0), n(1, 0, 0),
      n(10, 1, 0), n(11, 0, 1), n(12, -1, 0), n(13, 0, -1), // E,N,W,S neighbors
    ];
    const edges: EdgeDto[] = [e(0, 10), e(0, 11), e(1, 12), e(1, 13)];
    const pos = getSplitAwareNodePosition(nodes, 0, squareCfg, edges)!;
    const center = getCellCenter(0, 0, squareCfg);
    expect(pos.x).toBeCloseTo(center.x + 40 / 4);
    expect(pos.y).toBeCloseTo(center.y - 40 / 4);
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

  it("start on a node recognized as a diagonal split shape anchors to its own half-tile point, not the hub circle (GitHub issue #318)", () => {
    // Point (0,0) split into node 0 (connects E,N) and node 1 (connects W,S) — a recognized
    // "diagonal" topology. Node 0 is start.
    const nodeById = new Map<number, NodeDto>([
      [0, n(0, 0, 0)], [1, n(1, 0, 0)],
      [10, n(10, 1, 0)], [11, n(11, 0, 1)], [12, n(12, -1, 0)], [13, n(13, 0, -1)], // E,N,W,S neighbors
    ]);
    const edges: EdgeDto[] = [e(0, 10), e(0, 11), e(1, 12), e(1, 13)];
    const markers = buildMazeMarkers(nodeById, 0, null, squareCfg, undefined, undefined, edges);
    expect(markers).toHaveLength(1);
    const center = getCellCenter(0, 0, squareCfg);
    // Diagonal offset for node0's (E,N) face pair: (TILE_SIZE/4, -TILE_SIZE/4).
    expect(markers[0].pos[0]).toBeCloseTo(center.x + 40 / 4);
    expect(markers[0].pos[1]).toBeCloseTo(center.y - 40 / 4);
    // Not on the generic hub circle (radius TILE_SIZE/4 from center).
    const hubDist = Math.hypot(markers[0].pos[0] - center.x, markers[0].pos[1] - center.y);
    expect(hubDist).not.toBeCloseTo(10);
  });

  it("start on a hex bridge uses the bridge lane anchor from buildNodePositions", () => {
    const neighbors = hexNeighborNodes(0, 0);
    const split0 = n(100, 0, 0); // through faces 0,3
    const split1 = n(101, 0, 0); // bridge faces 1,4
    const nodes = [split0, split1, ...neighbors];
    const nodeById = new Map<number, NodeDto>(nodes.map((node) => [node.id, node]));
    const edges: EdgeDto[] = [
      e(100, 1), e(1, 100), e(100, 4), e(4, 100),
      e(101, 2), e(2, 101), e(101, 5), e(5, 101),
    ];

    const markers = buildMazeMarkers(nodeById, split0.id, split1.id, hexCfg, undefined, undefined, edges);
    const center = getCellCenter(0, 0, hexCfg);
    expect(markers).toHaveLength(2);
    expect(markers[0].pos).not.toEqual([center.x, center.y]);
    expect(markers[1].pos).toEqual([center.x, center.y]);
  });

  it("without edges, a split node still falls back to the generic hub position (default edges=[])", () => {
    const nodeById = new Map<number, NodeDto>([[0, n(0, 0, 0)], [1, n(1, 0, 0)]]);
    const markers = buildMazeMarkers(nodeById, 0, null, squareCfg);
    const center = getCellCenter(0, 0, squareCfg);
    const dist = Math.hypot(markers[0].pos[0] - center.x, markers[0].pos[1] - center.y);
    expect(dist).toBeCloseTo(10);
  });

  it("a custom MarkerStyle's size/cornerStyle/gapWidth/gapColor pass through into MarkerData (GitHub issue #302 follow-up — size drives radius via TILE_SIZE, the rest map straight across)", () => {
    const nodeById = new Map<number, NodeDto>([[0, n(0, 0, 0)], [1, n(1, 1, 1)]]);
    const startStyle: MarkerStyle = {
      shape: "star", fillColor: 0x111, borderColor: 0x222, borderWidth: 4,
      size: 0.5, cornerStyle: "round", gapWidth: 3, gapColor: 0x333,
    };
    const markers = buildMazeMarkers(nodeById, 0, 1, squareCfg, startStyle);
    expect(markers[0]).toMatchObject({
      shape: "star", color: 0x111, borderColor: 0x222, borderWidth: 4,
      cornerStyle: "round", gapWidth: 3, gapColor: 0x333,
    });
    expect(markers[0].radius).toBe(0.5 * 40);
    // finishStyle omitted — falls back to the default circle (GitHub issue #347 follow-up:
    // matches "Vector by walls"' own Shared style default), unaffected by startStyle's own
    // custom fields.
    expect(markers[1]).toMatchObject({ shape: "circle", cornerStyle: "round", gapWidth: 3 });
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

describe("selectFloorRemovalLosesFieldData", () => {
  it("false when the floor has no fieldDirty entry", () => {
    expect(selectFloorRemovalLosesFieldData({ floorFields: {} }, "floor_1")).toBe(false);
  });

  it("false when the floor's field is not dirty", () => {
    const state = { floorFields: { floor_1: { fieldDirty: false } } } as never;
    expect(selectFloorRemovalLosesFieldData(state, "floor_1")).toBe(false);
  });

  it("true when the floor's field is dirty", () => {
    const state = { floorFields: { floor_1: { fieldDirty: true } } } as never;
    expect(selectFloorRemovalLosesFieldData(state, "floor_1")).toBe(true);
  });
});

describe("selectFloorChangeLosesGenerationData", () => {
  it("false when neither maze nor post-edit is dirty", () => {
    expect(selectFloorChangeLosesGenerationData({ mazeDirty: false, postEditDirty: false })).toBe(false);
  });

  it("true when a generation result exists (mazeDirty)", () => {
    expect(selectFloorChangeLosesGenerationData({ mazeDirty: true, postEditDirty: false })).toBe(true);
  });

  it("true when post-edit changes exist", () => {
    expect(selectFloorChangeLosesGenerationData({ mazeDirty: false, postEditDirty: true })).toBe(true);
  });

  it("true when both are dirty", () => {
    expect(selectFloorChangeLosesGenerationData({ mazeDirty: true, postEditDirty: true })).toBe(true);
  });
});

describe("selectFloorScopedMaze", () => {
  const floors = [{ id: "floor_0" }, { id: "floor_1" }];
  const n = (id: number, level: number, x = id, y = 0): NodeDto => ({ id, x, y, i: 0, level });
  const e = (from: number, to: number, kind: EdgeDto["kind"] = "basic"): EdgeDto => ({ from, to, kind });

  it("keeps only nodes on the active floor", () => {
    const nodes = [n(1, 0), n(2, 0), n(3, 1)];
    const result = selectFloorScopedMaze(nodes, [], floors, "floor_0");
    expect(result.nodes.map((x) => x.id)).toEqual([1, 2]);
  });

  it("keeps a basic edge only when both endpoints are on the active floor", () => {
    const nodes = [n(1, 0), n(2, 0), n(3, 1)];
    const edges = [e(1, 2), e(2, 3)];
    const result = selectFloorScopedMaze(nodes, edges, floors, "floor_0");
    expect(result.edges).toEqual([{ from: 1, to: 2, kind: "basic" }]);
  });

  it("keeps a vertical_passage/elevator edge whose `from` is on the active floor even though `to` is on another", () => {
    const nodes = [n(1, 0), n(2, 1)];
    const edges = [e(1, 2, "vertical_passage"), e(1, 2, "elevator")];
    const result = selectFloorScopedMaze(nodes, edges, floors, "floor_0");
    expect(result.edges).toHaveLength(2);
  });

  it("drops a vertical_passage/elevator edge whose `from` is on another floor", () => {
    const nodes = [n(1, 0), n(2, 1)];
    const edges = [e(2, 1, "vertical_passage")];
    const result = selectFloorScopedMaze(nodes, edges, floors, "floor_0");
    expect(result.edges).toEqual([]);
  });

  it("nulls out start/finish when their node isn't on the active floor", () => {
    const nodes = [n(1, 0), n(2, 1)];
    const result = selectFloorScopedMaze(nodes, [], floors, "floor_0", 1, 2);
    expect(result.start).toBe(1);
    expect(result.finish).toBeNull();
  });

  it("treats a missing `level` as floor 0", () => {
    const nodes: NodeDto[] = [{ id: 1, x: 0, y: 0, i: 0 }];
    const result = selectFloorScopedMaze(nodes, [], floors, "floor_0");
    expect(result.nodes.map((x) => x.id)).toEqual([1]);
  });

  it("falls back to floor 0 when activeFloorId doesn't match any floor", () => {
    const nodes = [n(1, 0), n(2, 1)];
    const result = selectFloorScopedMaze(nodes, [], floors, "unknown_floor_id");
    expect(result.nodes.map((x) => x.id)).toEqual([1]);
  });
});
