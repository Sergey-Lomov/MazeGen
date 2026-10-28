import { describe, it, expect, vi } from "vitest";
import { buildTeleportEdges, buildTeleportBadgeBlockedCells, buildMazeWalls, buildSplitPassages, hasCrossFloorTeleport, selectNodeLevelResolver, buildOneWayWallIndicatorPositions, buildSplitJunctionPositions, buildTeleportAvoidanceWaypoints, type TeleportBadgeSpreadOptions } from "../pixi/selectors/mazeSelectors";
import { getCellCenter, nearestCellCoord } from "../pixi/tessellationGeometry";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { FieldConfig } from "../fieldConfig";
import type { VerticalConnectionMarker } from "../pixi/renderers/types";
import { n, e, squareCfg, teleport, twoWay } from "./mazeSelectorsKit";

vi.mock("pixi.js", async () => (await import("./mazeSelectorsMocks")).pixiMock());
vi.mock("../store/mazeStore", async () => (await import("./mazeSelectorsMocks")).mazeStoreMock());
// getCellCenter (via cartesianCache's getCartesian) delegates to wasm, unavailable in this
// unit-test environment, so only the real preset/geometry entry points are kept.
vi.mock("../wasm/mazeService", async (importActual) =>
  (await import("./postEditSliceMocks")).mazeServiceMock(await importActual<typeof import("../wasm/mazeService")>()));


describe("hasCrossFloorTeleport (GitHub issue #485)", () => {
  const at = (id: number, level: number): NodeDto => ({ id, x: id, y: 0, i: 0, level });
  const tp = (from: number, to: number): EdgeDto => ({ from, to, kind: "teleport" });

  it("is false with no teleport at all", () => {
    expect(hasCrossFloorTeleport([at(0, 0), at(1, 1)], [{ from: 0, to: 1, kind: "basic" }])).toBe(false);
  });

  it("is false for a teleport whose two endpoints are on the same floor", () => {
    expect(hasCrossFloorTeleport([at(0, 1), at(1, 1)], [tp(0, 1)])).toBe(false);
    // level undefined defaults to 0 on both ends — still same-floor.
    expect(hasCrossFloorTeleport([{ id: 0, x: 0, y: 0, i: 0 }, { id: 1, x: 1, y: 0, i: 0 }], [tp(0, 1)])).toBe(false);
  });

  it("is true once one teleport spans two floors", () => {
    expect(hasCrossFloorTeleport([at(0, 0), at(1, 2)], [tp(0, 1)])).toBe(true);
    // one same-floor teleport plus one cross-floor -> still true.
    expect(hasCrossFloorTeleport([at(0, 0), at(1, 0), at(2, 0), at(3, 1)], [tp(0, 1), tp(2, 3)])).toBe(true);
  });

  it("ignores a non-teleport edge that happens to span floors", () => {
    expect(hasCrossFloorTeleport([at(0, 0), at(1, 3)], [{ from: 0, to: 1, kind: "basic" }])).toBe(false);
  });
});

// --- buildTeleportEdges ---


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

  // --- cross-floor badge collision spread (GitHub issue #480) ---

  const spreadCtx = (nodes: NodeDto[], unscopedEdges: EdgeDto[], activeFloorIndex: number) => ({
    resolveNodeLevel: selectNodeLevelResolver(nodes),
    unscopedNodeById: new Map(nodes.map((nd) => [nd.id, nd])),
    unscopedEdges,
    activeFloorIndex,
  });
  const blockOpts = (nodes: NodeDto[], unscopedEdges: EdgeDto[], extra: Partial<TeleportBadgeSpreadOptions> = {}) => ({
    blockedCellsByFloor: buildTeleportBadgeBlockedCells(nodes, unscopedEdges, selectNodeLevelResolver(nodes), null, null),
    ...extra,
  });
  const isCellCenter = (p: [number, number], cfg: FieldConfig): boolean => {
    const [gx, gy] = nearestCellCoord(p[0], p[1], cfg);
    const c = getCellCenter(gx, gy, cfg);
    return Math.abs(c.x - p[0]) < 1e-6 && Math.abs(c.y - p[1]) < 1e-6;
  };

  it("a cross-floor badge is never left on a cell that carries a node marker", () => {
    // node 0 @ (1,1) f0 -> node 1 @ (1,1) f1: raw midpoint snaps to (1,1), where node 0's own teleport
    // marker sits. The badge must move off it.
    const nodes: NodeDto[] = [nLevel(0, 1, 1, 0), nLevel(1, 1, 1, 1)];
    const unscopedEdges: EdgeDto[] = [teleport(0, 1)];
    const result = buildTeleportEdges(
      new Map([[0, nodes[0]]]), unscopedEdges, squareCfg, spreadCtx(nodes, unscopedEdges, 0),
      blockOpts(nodes, unscopedEdges),
    );
    const badge = result.find((r) => r.toFloor !== undefined)!;
    expect(badge).toBeDefined();
    // Not on the marker cell (1,1); still snapped to some real cell center.
    expect(nearestCellCoord(badge.to[0], badge.to[1], squareCfg)).not.toEqual([1, 1]);
    expect(isCellCenter(badge.to, squareCfg)).toBe(true);
  });

  it("two cross-floor badges resolving to the same cell land on different cells", () => {
    // Two one-way cross-floor teleports whose midpoints both snap to (1,1):
    //   node 0 @ (0,0) -> node 1 @ (2,2)   midpoint (1,1)
    //   node 2 @ (2,0) -> node 3 @ (0,2)   midpoint (1,1)
    const nodes: NodeDto[] = [
      nLevel(0, 0, 0, 0), nLevel(1, 2, 2, 1),
      nLevel(2, 2, 0, 0), nLevel(3, 0, 2, 1),
    ];
    const unscopedEdges: EdgeDto[] = [teleport(0, 1), teleport(2, 3)];
    const result = buildTeleportEdges(
      new Map([[0, nodes[0]], [2, nodes[2]]]), unscopedEdges, squareCfg, spreadCtx(nodes, unscopedEdges, 0),
      blockOpts(nodes, unscopedEdges),
    );
    expect(result).toHaveLength(2);
    expect(result[0].toFloor).toBe(1);
    expect(result[1].toFloor).toBe(1);
    expect(nearestCellCoord(result[0].to[0], result[0].to[1], squareCfg))
      .not.toEqual(nearestCellCoord(result[1].to[0], result[1].to[1], squareCfg));
  });

  it("the same cross-floor pair picks the identical badge cell whichever floor is rendered", () => {
    const nodes: NodeDto[] = [nLevel(0, 0, 0, 0), nLevel(1, 2, 2, 1)];
    const unscopedEdges: EdgeDto[] = [teleport(0, 1), teleport(1, 0)];
    const fromFloor0 = buildTeleportEdges(
      new Map([[0, nodes[0]]]), [teleport(0, 1)], squareCfg, spreadCtx(nodes, unscopedEdges, 0),
      blockOpts(nodes, unscopedEdges),
    );
    const fromFloor1 = buildTeleportEdges(
      new Map([[1, nodes[1]]]), [teleport(1, 0)], squareCfg, spreadCtx(nodes, unscopedEdges, 1),
      blockOpts(nodes, unscopedEdges),
    );
    expect(fromFloor0[0].to).toEqual(fromFloor1[0].to);
  });

  it("a badge on floors 0<->2 ignores a marker that only exists on floor 1", () => {
    // Cross-floor pair node 0 @ (1,1) f0 -> node 1 @ (1,1) f2, midpoint snaps to (1,1). A floor-1
    // node also sits at (1,1) but must NOT push the badge — the pair never touches floor 1.
    const nodes: NodeDto[] = [nLevel(0, 1, 1, 0), nLevel(1, 1, 1, 2), nLevel(9, 1, 1, 1)];
    const unscopedEdges: EdgeDto[] = [teleport(0, 1)];
    const withFloor1Marker = buildTeleportEdges(
      new Map([[0, nodes[0]]]), unscopedEdges, squareCfg, spreadCtx(nodes, unscopedEdges, 0),
      blockOpts(nodes, unscopedEdges),
    );
    // node 0's own teleport marker is on floor 0 at (1,1), so the badge still moves; but the result
    // must match the case where the floor-1 marker isn't there at all.
    const noFloor1Marker = buildTeleportEdges(
      new Map([[0, nodes[0]]]), unscopedEdges, squareCfg,
      spreadCtx([nodes[0], nodes[1]], unscopedEdges, 0),
      blockOpts([nodes[0], nodes[1]], unscopedEdges),
    );
    expect(withFloor1Marker[0].to).toEqual(noFloor1Marker[0].to);
  });

  it("allowOutOfField:false keeps a relocated badge inside fieldCells", () => {
    // node 0 @ (0,0) f0 -> node 1 @ (0,0) f1: midpoint snaps to (0,0), a node cell -> must relocate.
    // Field is only the single column x=0, so the badge can only go to (0,1)/(0,-1) etc., never x!=0.
    const nodes: NodeDto[] = [nLevel(0, 0, 0, 0), nLevel(1, 0, 0, 1)];
    const unscopedEdges: EdgeDto[] = [teleport(0, 1)];
    const fieldCells: [number, number][] = [[0, 0], [0, 1], [0, 2], [0, 3], [0, -1], [0, -2]];
    const result = buildTeleportEdges(
      new Map([[0, nodes[0]]]), unscopedEdges, squareCfg, spreadCtx(nodes, unscopedEdges, 0),
      blockOpts(nodes, unscopedEdges, { allowOutOfField: false, fieldCells }),
    );
    const badge = result.find((r) => r.toFloor !== undefined)!;
    const [gx] = nearestCellCoord(badge.to[0], badge.to[1], squareCfg);
    expect(gx).toBe(0);
  });

  it("a pair's badge stays in the same cell even when a competing cross-floor badge exists on only one of the two floors", () => {
    // Pair P: node 0 @ (2,2) f0 <-> node 1 @ (2,2) f1, midpoint snaps to (2,2).
    // Pair Q: node 2 @ (2,2) f0 -> node 3 @ (4,4) f2 (one-way), its midpoint also snaps to (3,3)...
    // Force a collision: put Q's snap at (2,2) too -> node 3 @ (2,2) f2.
    // Q is visible from floor 0 (its `from` node 2 is on f0) but NOT from floor 1.
    // P must resolve to the identical cell whether rendered from floor 0 or floor 1.
    const nodes: NodeDto[] = [
      nLevel(0, 2, 2, 0), nLevel(1, 2, 2, 1),
      nLevel(2, 2, 2, 0), nLevel(3, 2, 2, 2),
    ];
    const unscopedEdges: EdgeDto[] = [teleport(0, 1), teleport(1, 0), teleport(2, 3)];
    const fromFloor0 = buildTeleportEdges(
      new Map([[0, nodes[0]], [2, nodes[2]]]),
      [teleport(0, 1), teleport(2, 3)],
      squareCfg, spreadCtx(nodes, unscopedEdges, 0), blockOpts(nodes, unscopedEdges),
    );
    const fromFloor1 = buildTeleportEdges(
      new Map([[1, nodes[1]]]), [teleport(1, 0)],
      squareCfg, spreadCtx(nodes, unscopedEdges, 1), blockOpts(nodes, unscopedEdges),
    );
    const p0 = fromFloor0.find((r) => (r.fromNode === 0 && r.toNode === 1) || (r.fromNode === 1 && r.toNode === 0))!;
    const p1 = fromFloor1.find((r) => (r.fromNode === 0 && r.toNode === 1) || (r.fromNode === 1 && r.toNode === 0))!;
    const posOf = (r: typeof p0) => (r.toFloor !== undefined ? r.to : r.from);
    expect(posOf(p0)).toEqual(posOf(p1));
  });

  it("a cross-floor badge is relocated off the start/finish node cell (post-edit draft start/finish path)", () => {
    // node 0 @ (1,1) f0 -> node 1 @ (1,1) f1: badge snaps to (1,1). No teleport/vertical marker sits
    // there other than node 0's own — but node 9 @ (1,1) f0 is the *start*, passed as `startNodeId`.
    // `blockOpts` hardcodes null/null, so build the block map by hand here to exercise the branch.
    const nodes: NodeDto[] = [nLevel(0, 1, 1, 0), nLevel(1, 1, 1, 1), nLevel(9, 1, 1, 0)];
    const unscopedEdges: EdgeDto[] = [teleport(0, 1)];
    const withStart = buildTeleportEdges(
      new Map([[0, nodes[0]]]), unscopedEdges, squareCfg, spreadCtx(nodes, unscopedEdges, 0),
      { blockedCellsByFloor: buildTeleportBadgeBlockedCells(nodes, unscopedEdges, selectNodeLevelResolver(nodes), 9, null) },
    );
    const badge = withStart.find((r) => r.toFloor !== undefined)!;
    expect(nearestCellCoord(badge.to[0], badge.to[1], squareCfg)).not.toEqual([1, 1]);
  });

  it("a vertical_passage / elevator endpoint on the badge cell also pushes the badge off", () => {
    // Cross-floor pair node 0 @ (1,1) f0 -> node 1 @ (1,1) f1, snap (1,1). node 0 itself is a teleport
    // marker there anyway, so instead test a *different* snap: node 0 @ (0,0) f0 -> node 1 @ (2,2) f1,
    // snap (1,1); a vertical_passage edge node 5 @ (1,1) f0 -- node 6 @ (1,1) f1 puts a marker on (1,1).
    const nodes: NodeDto[] = [
      nLevel(0, 0, 0, 0), nLevel(1, 2, 2, 1),
      nLevel(5, 1, 1, 0), nLevel(6, 1, 1, 1),
    ];
    const unscopedEdges: EdgeDto[] = [teleport(0, 1), { from: 5, to: 6, kind: "vertical_passage" }];
    const withMarker = buildTeleportEdges(
      new Map([[0, nodes[0]]]), [teleport(0, 1)], squareCfg, spreadCtx(nodes, unscopedEdges, 0),
      blockOpts(nodes, unscopedEdges),
    );
    const badge = withMarker.find((r) => r.toFloor !== undefined)!;
    expect(nearestCellCoord(badge.to[0], badge.to[1], squareCfg)).not.toEqual([1, 1]);

    // Same, with the blocker as an elevator edge instead.
    const elevatorEdges: EdgeDto[] = [teleport(0, 1), { from: 5, to: 6, kind: "elevator" }];
    const withElevator = buildTeleportEdges(
      new Map([[0, nodes[0]]]), [teleport(0, 1)], squareCfg, spreadCtx(nodes, elevatorEdges, 0),
      blockOpts(nodes, elevatorEdges),
    );
    expect(nearestCellCoord(withElevator.find((r) => r.toFloor !== undefined)!.to[0], withElevator.find((r) => r.toFloor !== undefined)!.to[1], squareCfg))
      .not.toEqual([1, 1]);
  });

  it("a badge with no free cell within the search radius falls back to the raw snapped midpoint", () => {
    // node 0 @ (0,0) f0 -> node 1 @ (0,0) f1: snap (0,0). allowOutOfField:false with fieldCells = the
    // single cell (0,0) -> every other cell is out of field and (0,0) itself is blocked (node marker),
    // so nothing is ever free -> badge stays on the raw snapped midpoint = (0,0)'s center.
    const nodes: NodeDto[] = [nLevel(0, 0, 0, 0), nLevel(1, 0, 0, 1)];
    const unscopedEdges: EdgeDto[] = [teleport(0, 1)];
    const result = buildTeleportEdges(
      new Map([[0, nodes[0]]]), unscopedEdges, squareCfg, spreadCtx(nodes, unscopedEdges, 0),
      blockOpts(nodes, unscopedEdges, { allowOutOfField: false, fieldCells: [[0, 0]] }),
    );
    const badge = result.find((r) => r.toFloor !== undefined)!;
    expect(nearestCellCoord(badge.to[0], badge.to[1], squareCfg)).toEqual([0, 0]);
  });
});

// --- buildTeleportAvoidanceWaypoints (GitHub issue #518) ---

describe("buildTeleportAvoidanceWaypoints", () => {
  it("with no sources given, returns an empty array", () => {
    expect(buildTeleportAvoidanceWaypoints({})).toEqual([]);
  });

  it("combines every given source's own positions into one flat array", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const wallEdges = buildMazeWalls(nodes, [e(0, 1)], squareCfg);
    const splitNodes = [n(0, 0, 0), n(1, 1, 0), n(2, 0, 0), n(3, 0, 1)];
    const splitEdges: EdgeDto[] = [...twoWay(0, 1), ...twoWay(2, 3)];
    const { passages } = buildSplitPassages(splitNodes, splitEdges, squareCfg);

    const waypoints = buildTeleportAvoidanceWaypoints({
      markers: [{ pos: [1, 2] }],
      verticalMarkers: [{ pos: [3, 4] } as unknown as VerticalConnectionMarker],
      oneWayWallEdges: wallEdges,
      cfg: squareCfg,
      splitPassages: passages,
    });

    expect(waypoints).toContainEqual([1, 2]);
    expect(waypoints).toContainEqual([3, 4]);
    expect(waypoints).toEqual(expect.arrayContaining(buildOneWayWallIndicatorPositions(wallEdges, squareCfg)));
    expect(waypoints).toEqual(expect.arrayContaining(buildSplitJunctionPositions(passages)));
    expect(waypoints).toHaveLength(4);
  });

  it("omits oneWayWallEdges' contribution when cfg isn't given alongside it", () => {
    const nodes = [n(0, 0, 0), n(1, 1, 0)];
    const wallEdges = buildMazeWalls(nodes, [e(0, 1)], squareCfg);
    expect(buildTeleportAvoidanceWaypoints({ oneWayWallEdges: wallEdges })).toEqual([]);
  });
});