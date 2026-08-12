import type { NodeDto, EdgeDto, IssueDto } from "../../wasm/types";
import type { MazeState, PostEditEdge } from "../../store/mazeStore";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import type { WallEdge, MarkerData, MarkerShape, PassageKind, TeleportEdge, SplitPassage, SplitSpecialShape, TeleportCornerStyle, VerticalConnectionMarker } from "../renderers/types";
import type { NodeEdgeHighlight } from "../renderers/NodeEdgeHighlightRenderer";
import { getCellCenter, getCellVertices, getNeighborData, getSplitCircleRotationDeg, getSharedEdgeSegment, buildNodePositions, nearestCellCoord, SPLIT_HUB_RADIUS } from "../tessellationGeometry";
import { computeSplitFaceLayouts, computeSplitConnectors, detectSplitSpecialShapeKind, type SplitFaceKind } from "../splitFaceLayout";
import { buildCellSet } from "./sharedSelectors";
import { NODE_RADIUS, WALL_THICKNESS } from "../renderConstants";
import { TILE_SIZE } from "../constants";
import { canvas } from "../colorTokens";
import { splitSlotColor } from "../colorUtils";
import { resolveEndpoint, buildSplitNodeResolver, type PostEditEndpoint } from "../postEditEndpoint";

/** Bridge shape proportions (GitHub issue #294) — the taper (narrowing/widening) each take the
 *  first/last 20% of the tile's length; the flat deck spans the middle 60% at 60% of the cross
 *  corridor's full width. */
const BRIDGE_TAPER_FRAC = 0.2;
const BRIDGE_DECK_WIDTH_FRAC = 0.6;

/** Narrows a maze-wide `{ nodes, edges, start, finish }` view down to one floor, by `activeFloorId`
 *  (GitHub issue #337/#347) — the single shared floor-scoping step every render-facing consumer of
 *  a possibly-multi-floor node/edge set needs before handing them to the walls/teleports/split
 *  selectors above, none of which are floor-aware themselves: two nodes sharing an (x, y) on
 *  different floors would otherwise be mistaken for a split point by `buildSplitPointKeys`'s
 *  per-point grouping. Was inlined once in `GenerationRenderer`'s own `debugView` (GitHub issue
 *  #337); factored out here once `VectorByWallsRenderer`/`VectorByCorridorsRenderer` needed the
 *  identical scoping (GitHub issue #347) rather than each renderer re-deriving `activeFloorIndex`
 *  and re-filtering on its own. `activeFloorId` resolves to an index via `floors`' own array
 *  position (`levels_ordered()` order — see `Specs/floors.md`), defaulting to `0` (floor 1) when
 *  `activeFloorId` doesn't match any current floor (same defensive fallback `GenerationRenderer`
 *  used). A `vertical_passage`/`elevator` edge survives the cut as soon as `from` is on the active
 *  floor, even though `to` never is (it leads to another floor by construction). A `teleport` edge
 *  survives the same way (GitHub issue #337 cross-floor teleport rendering) — `to` may land on
 *  another floor once teleports themselves support cross-floor targets (#340); `buildTeleportEdges`
 *  is the one that resolves such a `to`'s real (off-image) position via `resolveNodeLevel` and
 *  substitutes a midpoint, not this function. Every other kind still requires both ends on the
 *  active floor, same as before this function existed, since an intra-floor edge with a dangling
 *  `to` is not something any of these selectors expect to handle. `start`/`finish` are only kept
 *  when they resolve to a node that survived the cut. */
export function selectFloorScopedMaze(
  nodes: NodeDto[],
  edges: EdgeDto[],
  floors: { id: string }[],
  activeFloorId: string,
  start: number | null = null,
  finish: number | null = null,
): { nodes: NodeDto[]; edges: EdgeDto[]; start: number | null; finish: number | null } {
  const activeFloorIndex = Math.max(floors.findIndex((f) => f.id === activeFloorId), 0);
  const floorNodes = nodes.filter((n) => (n.level ?? 0) === activeFloorIndex);
  const floorNodeIds = new Set(floorNodes.map((n) => n.id));
  const crossesFloorFreely = (e: EdgeDto) =>
    e.kind === "vertical_passage" || e.kind === "elevator" || e.kind === "teleport";
  const floorEdges = edges.filter((e) =>
    floorNodeIds.has(e.from) && (crossesFloorFreely(e) || floorNodeIds.has(e.to)),
  );
  return {
    nodes: floorNodes,
    edges: floorEdges,
    start: start !== null && floorNodeIds.has(start) ? start : null,
    finish: finish !== null && floorNodeIds.has(finish) ? finish : null,
  };
}

/** Narrow "ask, don't fetch" access to a node's own floor (GitHub issue #347) — built once from the
 *  full, unscoped `nodes` list (before `selectFloorScopedMaze` narrows it to one floor), so a caller
 *  that only has floor-scoped data in hand (e.g. `VectorByWallsRenderer`, after scoping its own
 *  `nodes`/`edges`) can still resolve the *other* floor's node a `vertical_passage`/`elevator`
 *  edge's `to` points at, without needing the whole unscoped node list passed around. Callers should
 *  build this once per render (not per edge) and pass the resolver function down, not the raw list —
 *  every renderer/selector wanting a node's level goes through this same narrow interface instead of
 *  each hand-rolling its own `Map`. */
export function selectNodeLevelResolver(nodes: NodeDto[]): (id: number) => number | undefined {
  const levelById = new Map(nodes.map((n) => [n.id, n.level ?? 0]));
  return (id: number) => levelById.get(id);
}

/** Every `VerticalPassage` edge's own `"from->to"` key (GitHub issue #337/#347's bidirectional-
 *  detection bug), built from the *unscoped* edge list — `selectFloorScopedMaze` only keeps a
 *  vertical/elevator edge whose `from` is on the active floor, so the reverse-direction edge of a
 *  bidirectional passage (its own `from` lives on the *other* floor) is always missing from any
 *  already floor-scoped edge list. A bidirectional-detection check built from scoped edges can
 *  therefore never find its own partner and always falls through as "one-way" — this must always
 *  be built from `state.nodes`/`state.edges` (or the debug-replay equivalent), the same unscoped
 *  source `selectNodeLevelResolver` already requires for the same reason. Shared by every caller
 *  of `buildVerticalConnectionMarkers` rather than each re-deriving it — see that function's own
 *  `allEdges` parameter. */
export function selectVerticalPassagePairSet(allEdges: EdgeDto[]): ReadonlySet<string> {
  const pairs = new Set<string>();
  for (const e of allEdges) {
    if (e.kind === "vertical_passage") pairs.add(`${e.from}->${e.to}`);
  }
  return pairs;
}

/** `VerticalPassage`/`Elevator` edges (GitHub issue #337/#347) as single point-anchored markers —
 *  the "Vector by walls" render mode's own reading of these edge kinds, see
 *  `VerticalConnectionMarker`'s own doc comment for why there's no connector line: `to` lives on
 *  another floor, entirely absent from this image's `nodes`. `edges` is expected already
 *  floor-scoped (`selectFloorScopedMaze`, which keeps a vertical/elevator edge whenever its `from`
 *  is on the active floor); `resolveNodeLevel` (`selectNodeLevelResolver`, built from the *unscoped*
 *  node list) resolves `to`'s own floor so a marker's direction arrow can compare it against
 *  `activeFloorIndex`. `verticalPairs` (`selectVerticalPassagePairSet`, same *unscoped*-source
 *  requirement as `resolveNodeLevel`, for the same reason — see that function's own doc comment) is
 *  what decides one-way vs. bidirectional; a set built from the already-scoped `edges` here would
 *  never contain the reverse-direction edge, since its own `from` is never on this floor.
 *
 *  One filled marker per distinct `from` node per edge kind — an `Elevator`'s fully-connected fan
 *  can produce several edges sharing the same `from` (one per other floor in the fan), which would
 *  otherwise draw the same marker stacked on itself several times. A one-way `VerticalPassage`'s
 *  arrival-only end also gets an *empty* marker at its `to` node, but that `to` node is (by
 *  definition) never on this call's own active floor — so it can never be found by scanning `edges`
 *  (which only ever has `from` on this floor, per `selectFloorScopedMaze`'s own doc comment).
 *  `allEdges` (the *unscoped* edge list, same source `resolveNodeLevel`/`verticalPairs` already
 *  require) is scanned separately for one-way edges whose `to` lands on this floor — that's the
 *  only way an arrival marker is ever found, since `edges` structurally can't contain it. `filled`/
 *  empty circle and the arrow's own fill are the visual distinction between "you can enter here"
 *  and "you only arrive here" (GitHub issue #337/#347 design follow-up) — see
 *  `VerticalConnectionMarker`'s own doc comment. */
export function buildVerticalConnectionMarkers(
  nodeById: Map<number, NodeDto>,
  edges: EdgeDto[],
  cfg: TessellationConfig,
  resolveNodeLevel: (id: number) => number | undefined,
  activeFloorIndex: number,
  verticalPairs: ReadonlySet<string>,
  allEdges: EdgeDto[],
): VerticalConnectionMarker[] {
  const isVertical = (e: EdgeDto): e is EdgeDto & { kind: "vertical_passage" | "elevator" } =>
    e.kind === "vertical_passage" || e.kind === "elevator";
  const verticalEdges = edges.filter(isVertical);
  const localNodeIds = new Set(nodeById.keys());
  const arrivalEdges = allEdges.filter((e): e is EdgeDto & { kind: "vertical_passage" } =>
    e.kind === "vertical_passage" && localNodeIds.has(e.to) && !localNodeIds.has(e.from) && !verticalPairs.has(`${e.to}->${e.from}`),
  );
  if (verticalEdges.length === 0 && arrivalEdges.length === 0) return [];

  const byPair = verticalPairs;
  const allNodes = Array.from(nodeById.values());
  const nodePos = buildNodePositions(allNodes, cfg, []);

  // Aggregates direction across every reachable floor, not just one edge — an `Elevator`'s fan can
  // connect one node to several other floors at once (several edges sharing the same `from`), so a
  // single marker there must show `"both"` when it reaches floors on both sides of the active one,
  // not just whichever edge happened to be seen first (GitHub issue #337/#347 design follow-up).
  const directionAcross = (targetIds: Iterable<number>): "up" | "down" | "both" | undefined => {
    let sawUp = false;
    let sawDown = false;
    for (const id of targetIds) {
      const level = resolveNodeLevel(id);
      if (level === undefined || level === activeFloorIndex) continue;
      if (level > activeFloorIndex) sawUp = true;
      else sawDown = true;
    }
    if (sawUp && sawDown) return "both";
    if (sawUp) return "up";
    if (sawDown) return "down";
    return undefined;
  };

  // Groups edges by `from`+kind first (not deduped-on-first-seen) so an Elevator fan's several
  // edges from the same node are all available to `directionAcross` before a marker is built.
  const targetsByFromKind = new Map<string, number[]>();
  const orderedFromKinds: { from: number; kind: "vertical_passage" | "elevator" }[] = [];
  for (const e of verticalEdges) {
    const groupKey = `${e.from}:${e.kind}`;
    let targets = targetsByFromKind.get(groupKey);
    if (!targets) {
      targets = [];
      targetsByFromKind.set(groupKey, targets);
      orderedFromKinds.push({ from: e.from, kind: e.kind });
    }
    targets.push(e.to);
  }

  const seenKey = new Set<string>();
  const result: VerticalConnectionMarker[] = [];
  for (const { from, kind } of orderedFromKinds) {
    const groupKey = `${from}:${kind}`;
    if (seenKey.has(groupKey)) continue;
    seenKey.add(groupKey);

    const pos = nodePos.get(from);
    if (!pos) continue;

    const targets = targetsByFromKind.get(groupKey)!;
    // A one-way VerticalPassage's departure marker draws empty (`filled: false`) with a solid
    // arrow (`arrowFilled: true`) — only the arrow, not the circle fill, distinguishes it from its
    // own arrival-only marker below. Bidirectional/Elevator draw the ordinary solid marker.
    const isOneWay = kind === "vertical_passage" && !byPair.has(`${targets[0]}->${from}`);
    const targetFloorIndex = kind === "vertical_passage" ? resolveNodeLevel(targets[0]) : undefined;
    result.push({
      pos: [pos.x, pos.y], fromNode: from, kind, direction: directionAcross(targets), targetFloorIndex,
      filled: !isOneWay, arrowFilled: true,
    });
  }

  // Arrival-end markers (one-way VerticalPassage only) — `arrivalEdges` (see this function's own
  // doc comment) is the only source that can find these, since their `to` node is never on this
  // floor's own `edges`/`nodeById` scope.
  for (const e of arrivalEdges) {
    const arrivalKey = `${e.to}:${e.kind}:arrival`;
    if (seenKey.has(arrivalKey)) continue;
    seenKey.add(arrivalKey);
    const arrivalPos = nodePos.get(e.to);
    if (!arrivalPos) continue;
    result.push({
      pos: [arrivalPos.x, arrivalPos.y], fromNode: e.to, kind: e.kind, direction: directionAcross([e.from]),
      targetFloorIndex: resolveNodeLevel(e.from), filled: false, arrowFilled: false,
    });
  }

  return result;
}

// Teleport edges are never part of `postEditEdges` — they're tracked separately (see
// `postEditDraftTeleportEdges`/`postEditTeleportEdges` in storeTypes.ts) since a Teleport and a
// Basic edge can coexist in the same direction between the same pair, which the `Record<from-to,
// PostEditEdge>` shape used here can't represent. Callers needing both must concatenate
// `postEditEdgesToDto(...)` with the teleport list themselves.
//
// `resolveSplit` resolves a `split` endpoint to a real node id (see `postEditEndpoint.ts`'s doc
// comment) — an entry with an unresolved endpoint (a split node added but not yet confirmed) is
// silently dropped, same "nothing to draw yet" pattern used elsewhere on this boundary.
export function postEditEdgesToDto(
  postEditEdges: Record<string, PostEditEdge> | null,
  resolveSplit: (point: [number, number], slotId: number) => number | undefined,
): EdgeDto[] {
  if (postEditEdges === null) return [];
  const result: EdgeDto[] = [];
  for (const e of Object.values(postEditEdges)) {
    if (e.kind === "wall") continue;
    const from = resolveEndpoint(e.from, resolveSplit);
    const to = resolveEndpoint(e.to, resolveSplit);
    if (from === undefined || to === undefined) continue;
    result.push({ from, to, kind: "basic" });
  }
  return result;
}

// A cell is "closed" (filled as a wall) only when it has no connection at all — including a
// teleport-only connection. A teleport in/out is a valid way to enter/exit the cell even though
// it renders no wall opening on any geometric side (see buildMazeWalls, which deliberately
// ignores teleport edges for the opposite reason: a teleport must not fake an open passage
// between geometric neighbors). Both kinds count as "connected" here.
//
// A split point (GitHub issue #221) can have more than one `NodeDto` at the same (x,y) — the
// original node plus each extra split node. Grouping by cell before checking connectivity is
// required: filtering `nodes` directly (one entry per *node*, not per *cell*) would mark the cell
// closed whenever any single one of its nodes happens to have no edges (e.g. the original node's
// direct passage was walled off, but a split node added at the same point has a passage of its
// own) — the point as a whole is still open, so the cell must not render as a wall.
// `allEdges` (GitHub issue #337 follow-up, optional — unscoped, same requirement as
// `buildVerticalConnectionMarkers`'s own `allEdges` param) covers a one-way `VerticalPassage`
// whose arrival-only end lands on this floor: `edges` is floor-scoped for every floor-aware
// caller (`selectFloorScopedMaze` keeps a vertical/elevator edge only when its `from` is on the
// active floor — see that function's own doc comment), so an arrival-only `to` node's edge is
// structurally absent from `edges` and this cell would otherwise be mistaken for having no
// connection at all and rendered as a wall. Omitted callers (every non-floor-aware one) see no
// change in behavior — `edges` alone is exactly what `connected` was built from before this param
// existed.
export function buildClosedCells(nodes: NodeDto[], edges: EdgeDto[], allEdges?: EdgeDto[]): [number, number][] {
  const connected = new Set<number>();
  for (const e of edges) { connected.add(e.from); connected.add(e.to); }
  if (allEdges) {
    const nodeIds = new Set(nodes.map((n) => n.id));
    for (const e of allEdges) {
      if (e.kind !== "vertical_passage") continue;
      if (nodeIds.has(e.to)) connected.add(e.to);
    }
  }
  const anyConnectedByCell = new Map<string, boolean>();
  const cellCoords = new Map<string, [number, number]>();
  for (const n of nodes) {
    const key = `${n.x},${n.y}`;
    cellCoords.set(key, [n.x, n.y]);
    anyConnectedByCell.set(key, (anyConnectedByCell.get(key) ?? false) || connected.has(n.id));
  }
  const closed: [number, number][] = [];
  for (const [key, isConnected] of anyConnectedByCell) {
    if (!isConnected) closed.push(cellCoords.get(key)!);
  }
  return closed;
}

/** Points with more than one `NodeDto` (split points, GitHub issue #221/#223) — geometric edges
 *  touching one of these are excluded from `buildMazeWalls`'s ordinary reading entirely; they
 *  render exclusively via `buildSplitPassages`'s colored per-node lines instead. */
export function buildSplitPointKeys(nodes: NodeDto[]): Set<string> {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const key = `${n.x},${n.y}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const keys = new Set<string>();
  for (const [key, count] of counts) if (count > 1) keys.add(key);
  return keys;
}

/** Largest node count at any one split point in `nodes` (0 if there's no split point at all) —
 *  used by `VectorByWallsSettingsPanel`'s Splits section (GitHub issue #294) to size its per-slot
 *  color list to what the current maze actually needs. */
export function maxSplitNodeCount(nodes: NodeDto[]): number {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const key = `${n.x},${n.y}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let max = 0;
  for (const count of counts.values()) if (count > 1 && count > max) max = count;
  return max;
}

/** One `buildCorridorSegments` result entry — `oneWayDir` mirrors `WallEdge.oneWayDir`'s own
 *  convention (GitHub issue #312): unset for a bidirectional passage, else a unit vector along the
 *  segment pointing in the passage's actual allowed direction (from `v0`'s cell to `v1`'s, or the
 *  reverse), for `VectorByCorridorsRenderer`'s one-way chevron-row indicator. `fromNode`/`toNode`
 *  (GitHub issue #312 follow-up) are the two cells' own node ids, matching `v0`/`v1` respectively —
 *  lets `computeVectorByCorridorsWarnings`' overflow check flag exactly the edges this function
 *  actually draws a segment for (geometric neighbors, not split points, per this function's own
 *  exclusions) instead of re-deriving a looser approximation from the raw edge list. */
export type CorridorSegment = {
  v0: { x: number; y: number };
  v1: { x: number; y: number };
  oneWayDir?: { dx: number; dy: number };
  fromNode: number;
  toNode: number;
  /** `v1` lands on a shared face's own midpoint instead of the neighbor cell's center, because that
   *  neighbor is a split point (GitHub issue #314 follow-up) — the renderer needs this to cap that
   *  end `butt` instead of its usual round/square cap, since the diagonal/bridge shape drawn there
   *  by `buildSplitPassages` can bow or narrow away from this segment's own straight axis, uncovering
   *  a round/square cap's extra reach past the tile boundary. */
  v1TouchesSplit?: boolean;
};

/** Center-to-center line segments for every basic passage between geometrically adjacent cells —
 *  the "Vector by corridors" render mode's own maze reading (GitHub issue #310), the inverse of
 *  `buildMazeWalls`' "gap in the wall" reading. `oneWayDir` (GitHub issue #312) distinguishes a
 *  one-way passage from a bidirectional one, same directed-set approach `buildMazeWalls` uses for
 *  its own `oneWayDir`. A split-to-split passage is skipped entirely — drawn instead by
 *  `buildSplitPassages`' own connector geometry (GitHub issue #314). A plain-to-split passage still
 *  draws its plain side's own segment, but shortened from the plain cell's center to the shared
 *  face's own midpoint (`getSharedEdgeSegment`) instead of running all the way to the split cell's
 *  center — that midpoint is exactly where `buildSplitPassages`' own per-node face share is
 *  centered (`SplitPassage.wallSegments[*].center`), so the two renderer's own line stubs meet
 *  edge-to-edge with no gap and no overlap. Teleport edges are never geometric neighbors of each
 *  other in `getNeighborData`'s sense, so they're naturally excluded without any extra `kind`
 *  check. */
export function buildCorridorSegments(
  nodes: NodeDto[],
  edges: EdgeDto[],
  cfg: TessellationConfig,
): CorridorSegment[] {
  const nodeById = new Map<number, NodeDto>();
  const nodeByCoord = new Map<string, NodeDto>();
  for (const n of nodes) {
    nodeById.set(n.id, n);
    nodeByCoord.set(`${n.x},${n.y}`, n);
  }

  const directed = new Set<string>();
  for (const e of edges) {
    if (e.kind === "teleport") continue;
    const from = nodeById.get(e.from);
    const to = nodeById.get(e.to);
    if (!from || !to) continue;
    directed.add(`${from.x},${from.y}->${to.x},${to.y}`);
  }

  const cells: [number, number][] = nodes.map((n) => [n.x, n.y]);
  const cellSet = buildCellSet(cells);
  const splitPointKeys = buildSplitPointKeys(nodes);
  const result: CorridorSegment[] = [];

  for (const n of nodes) {
    const selfKey = `${n.x},${n.y}`;
    const selfSplit = splitPointKeys.has(selfKey);
    const { offsets } = getNeighborData(cfg, n.x, n.y);
    for (const [dx, dy] of offsets) {
      const nx = n.x + dx;
      const ny = n.y + dy;
      const neighborKey = `${nx},${ny}`;
      if (!cellSet.has(neighborKey)) continue;
      const neighborSplit = splitPointKeys.has(neighborKey);
      if (selfSplit && neighborSplit) continue; // split-to-split — drawn by buildSplitPassages instead
      if (selfSplit) continue; // the plain neighbor's own pass below draws this face instead

      // A face with a split cell on either side is always drawn from the plain cell's own pass,
      // regardless of `x`/`y` ordering — the split side never contributes a "half" of its own
      // (its whole face-to-center span belongs to `buildSplitPassages`' per-node share instead), so
      // the usual `ownsEdge` dedup (which assumes both sides draw identical geometry and only one
      // should) doesn't apply here.
      const ownsEdge = neighborSplit || n.x < nx || (n.x === nx && n.y < ny);
      if (!ownsEdge) continue;

      const fwd = directed.has(`${n.x},${n.y}->${nx},${ny}`);
      const bwd = directed.has(`${nx},${ny}->${n.x},${n.y}`);
      if (!fwd && !bwd) continue;

      const neighborNode = nodeByCoord.get(neighborKey);
      if (!neighborNode) continue;

      const v0 = getCellCenter(n.x, n.y, cfg);
      // A plain cell neighboring a split point stops at the shared face's own midpoint instead of
      // reaching all the way to the split cell's center — `buildSplitPassages`' own per-node share
      // (`SplitPassage.wallSegments[*].center`) picks up from there.
      let v1 = getCellCenter(nx, ny, cfg);
      if (neighborSplit) {
        const seg = getSharedEdgeSegment([n.x, n.y], [nx, ny], cfg);
        if (seg) v1 = { x: (seg.v0.x + seg.v1.x) / 2, y: (seg.v0.y + seg.v1.y) / 2 };
      }

      let oneWayDir: { dx: number; dy: number } | undefined;
      if (fwd !== bwd) {
        const tdx = fwd ? v1.x - v0.x : v0.x - v1.x;
        const tdy = fwd ? v1.y - v0.y : v0.y - v1.y;
        const len = Math.sqrt(tdx * tdx + tdy * tdy);
        if (len > 0) oneWayDir = { dx: tdx / len, dy: tdy / len };
      }

      result.push({ v0, v1, oneWayDir, fromNode: n.id, toNode: neighborNode.id, v1TouchesSplit: neighborSplit });
    }
  }

  return result;
}

export function buildMazeWalls(
  nodes: NodeDto[],
  edges: EdgeDto[],
  cfg: TessellationConfig,
): WallEdge[] {
  const nodeById = new Map<number, NodeDto>();
  for (const n of nodes) nodeById.set(n.id, n);

  const directed = new Set<string>();
  for (const e of edges) {
    // Teleport edges are rendered by TeleportRenderer, not as a wall opening -- a teleport
    // between geometrically adjacent cells must not read as an open passage here. `edges` may
    // contain both kinds mixed together (see EdgeDto's coexistence note), so this must filter,
    // not just trust the caller passed a basic-only list.
    if (e.kind === "teleport") continue;
    const from = nodeById.get(e.from);
    const to = nodeById.get(e.to);
    if (!from || !to) continue;
    directed.add(`${from.x},${from.y}->${to.x},${to.y}`);
  }

  const cells: [number, number][] = nodes.map(n => [n.x, n.y]);
  const cellSet = buildCellSet(cells);
  const splitPointKeys = buildSplitPointKeys(nodes);
  const result: WallEdge[] = [];

  for (const n of nodes) {
    const selfKey = `${n.x},${n.y}`;
    if (splitPointKeys.has(selfKey)) continue; // rendered by buildSplitPassages instead
    const { offsets } = getNeighborData(cfg, n.x, n.y);
    for (const [dx, dy] of offsets) {
      const nx = n.x + dx;
      const ny = n.y + dy;
      if (!cellSet.has(`${nx},${ny}`)) continue;
      if (splitPointKeys.has(`${nx},${ny}`)) continue; // rendered by buildSplitPassages instead
      const ownsEdge = n.x < nx || (n.x === nx && n.y < ny);
      if (!ownsEdge) continue;

      const fwd = directed.has(`${n.x},${n.y}->${nx},${ny}`);
      const bwd = directed.has(`${nx},${ny}->${n.x},${n.y}`);

      let kind: PassageKind;
      if (fwd && bwd) kind = "both";
      else if (fwd) kind = "forward";
      else if (bwd) kind = "backward";
      else kind = "none";

      if (kind === "both") continue; // bidirectional passage — no wall

      let oneWayDir: { dx: number; dy: number } | undefined;
      if (kind === "forward" || kind === "backward") {
        const fromCenter = getCellCenter(n.x, n.y, cfg);
        const toCenter = getCellCenter(nx, ny, cfg);
        const tdx = kind === "forward" ? toCenter.x - fromCenter.x : fromCenter.x - toCenter.x;
        const tdy = kind === "forward" ? toCenter.y - fromCenter.y : fromCenter.y - toCenter.y;
        const len = Math.sqrt(tdx * tdx + tdy * tdy);
        if (len > 0) oneWayDir = { dx: tdx / len, dy: tdy / len };
      }

      result.push({
        a: [n.x, n.y],
        b: [nx, ny],
        kind,
        style: "solid",
        oneWayDir,
      });
    }
  }

  // Boundary walls (no neighbor in cellSet) — drawn even for split points: a field-edge side is
  // never one of a split node's connected faces (`buildSplitPassagesCore` only draws segments
  // toward faces the point's nodes actually connect across), so skipping it here would leave the
  // point's outer edge with no wall at all.
  const boundaryDrawn = new Set<string>();
  for (const n of nodes) {
    const { offsets } = getNeighborData(cfg, n.x, n.y);
    for (const [dx, dy] of offsets) {
      const nx = n.x + dx;
      const ny = n.y + dy;
      if (cellSet.has(`${nx},${ny}`)) continue;
      // A split point has several nodes at the same (x,y) — dedupe so its boundary side isn't
      // pushed once per node.
      const boundaryKey = `${n.x},${n.y}->${nx},${ny}`;
      if (boundaryDrawn.has(boundaryKey)) continue;
      boundaryDrawn.add(boundaryKey);
      result.push({ a: [n.x, n.y], b: [nx, ny], kind: "none", style: "solid" });
    }
  }

  return result;
}

/** Position to draw a node-anchored entity (start/finish marker, teleport endpoint) at — the
 *  cell's own center for an ordinary (unsplit) node; for a split point, a node recognized as part
 *  of a `SplitSpecialShapeKind` (bridge/diagonal, GitHub issue #318) gets `specialSplitNodePoint`'s
 *  dedicated point instead of the generic hub-circle position, since a bridge/diagonal reads
 *  visually as belonging to a specific half/lane of the tile, not an evenly-spaced slot on a
 *  circle; every other split node still gets `splitHubPoint`'s small-circle position. Thin wrapper
 *  over `buildNodePositions` (`tessellationGeometry.ts`) — same shape detection, just resolving one
 *  node id instead of building the whole map. `nodes` must include every node of the point (not
 *  just `nodeId`) for the slot index/shape detection to be computed correctly. `edges` (directed
 *  pairs only — teleports pre-filtered by the caller, same contract `buildSplitPassages` uses)
 *  drives shape detection; omit it to always fall back to the generic hub position (e.g. a caller
 *  with no edge data in hand). */
export function getSplitAwareNodePosition(
  nodes: NodeDto[],
  nodeId: number,
  cfg: TessellationConfig,
  edges: EdgeDto[] = [],
): { x: number; y: number } | null {
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return null;

  const directedPairs = edges.filter((e) => e.kind !== "teleport").map((e) => ({ from: e.from, to: e.to }));
  return buildNodePositions(nodes, cfg, directedPairs).get(nodeId) ?? null;
}

/** Colored passages for every split point (GitHub issue #223). Each node of a split point gets
 *  its own share of the wall on every geometric face it connects across (`wallSegments`) — when
 *  several of the point's nodes connect across the same face, that face's edge is divided evenly
 *  among them in slot order, each getting one contiguous sub-segment, so independent passages
 *  sharing a face read as visually distinct rather than overlapping.
 *
 *  Those shares are then linked into `connectors`: a node with exactly 2 connected faces draws one
 *  straight line directly between its two shares' centers — no hub point, since a pure through-
 *  passage reads more naturally as one continuous corridor. Any other count (1 or 3+) draws one
 *  line per share from the node's own point on a small circle (radius = 1/2 of the cell, i.e.
 *  `TILE_SIZE / 4`, evenly distributed among the point's node count, rotated by the tessellation's
 *  own starting angle — `getSplitCircleRotationDeg`) out to that share's center; the circle itself
 *  is never drawn. A node with zero connections produces no `SplitPassage` entry at all.
 *
 *  **Straightening exception:** a node whose only two connections are both ordinary geometric
 *  faces still gets the straight 2-face connector described above — but a node carrying a
 *  start/finish marker or a teleport endpoint (`specialNodeIds`) always keeps its hub point even
 *  at exactly 2 connections, since a marker/teleport line drawn on that node's hub point would
 *  otherwise sit on a straight line with nothing marking which point along it is actually special. */
/** A split point's node, abstracted over the identity type `Id` — `NodeDto`'s `id: number` for the
 *  post-generation callers, `PresetEndpoint`'s `(point, slotId?)` (via `presetEndpointKey`) for the
 *  preset-stage caller (GitHub issue #231), compared with `===`. */
export type SplitPassageNode<Id> = { id: Id; x: number; y: number };

/** Generic core of `buildSplitPassages` (GitHub issue #223/#231/#234) — parameterized over an
 *  opaque, comparable `Id` type so it has no notion of `NodeDto`/`EdgeDto`/resolved `NodeId`.
 *  `directedPairs` is the flat list of `(from, to)` id pairs this point's nodes may connect across
 *  (teleports must already be filtered out by the caller — a teleport must not read as an open
 *  passage here, same rule as `buildMazeWalls`). The geometric layout itself (dividing a face
 *  among connected nodes, straightening a 2-passage connector, hub-point fan-out, active-node
 *  z-order, one-way arrow on the connector not the face segment) is `splitFaceLayout.ts`'s shared
 *  algorithm — the same one the "Manage split nodes" dialog's tile diagram (`TileFaceEditor`) uses,
 *  so the two never drift apart. `activeId(pointKey)` resolves which of a point's nodes currently
 *  draws on top (mirrors `postEditActiveSplitNode`/`presetActiveSplitNode` — absence means the
 *  point's first/original node). `buildSplitPassages` (NodeDto/EdgeDto) and
 *  `buildPresetSplitPassages` (PresetEndpoint, presetSelectors.ts) are both thin adapters over
 *  this. */
export type SplitPassagesResult = {
  passages: SplitPassage[];
  /** Faces where every one of a split point's nodes explicitly has `wall` — drawn as one plain
   *  solid wall spanning the whole face, same as an ordinary (non-split) wall, since it isn't
   *  attributable to any single node's color. Mirrors `TileFaceEditor`'s `allWall` case. */
  wallFaces: { v0: { x: number; y: number }; v1: { x: number; y: number } }[];
  /** One entry per split point recognized as a "bridge"/"diagonal divider" topology (GitHub issue
   *  #294) — always populated regardless of `SplitStyleOverride.specialShapes`, so the renderer
   *  decides whether to use it without a second geometry pass. Empty unless the point is degree-4
   *  with exactly 2 nodes, each a straight-through opposite-face (bridge) or adjacent-face
   *  (diagonal) pair — see `SplitSpecialShapeKind`. */
  specialShapes: SplitSpecialShape[];
};

/** The tile's own vertex index shared by two adjacent faces (GitHub issue #294's diagonal-divider
 *  shape needs the real tile corner, not a face-midpoint-to-center bend) — `edgeVerts[i]` is that
 *  face's `[vi, vj]` vertex-index pair; two adjacent faces share exactly one of those four indices.
 *  Returns `null` if the faces don't actually share a vertex (shouldn't happen for the adjacent
 *  pair `detectSplitSpecialShapeKind` already validated, but keeps this total). */
function sharedCornerIndex(edgeVerts: [number, number][], faceA: number, faceB: number): number | null {
  const [a0, a1] = edgeVerts[faceA];
  const [b0, b1] = edgeVerts[faceB];
  if (a0 === b0 || a0 === b1) return a0;
  if (a1 === b0 || a1 === b1) return a1;
  return null;
}

/** Pairs `facesA`'s two endpoints with `facesB`'s two endpoints by nearest distance (GitHub issue
 *  #294's bridge shape) — for two parallel opposite faces of a tile, this picks the "same side"
 *  pairing (left edge to left edge, right to right) so the two resulting bridge edges run side by
 *  side instead of crossing through the middle. Returns `[bIndexForA0, bIndexForA1]`. */
function nearestEndpointPairing(
  a: { v0: { x: number; y: number }; v1: { x: number; y: number } },
  b: { v0: { x: number; y: number }; v1: { x: number; y: number } },
): [0 | 1, 0 | 1] {
  const dist = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y);
  const straight = dist(a.v0, b.v0) + dist(a.v1, b.v1);
  const crossed = dist(a.v0, b.v1) + dist(a.v1, b.v0);
  return straight <= crossed ? [0, 1] : [1, 0];
}

export function buildSplitPassagesCore<Id>(
  nodes: SplitPassageNode<Id>[],
  directedPairs: { from: Id; to: Id }[],
  cfg: TessellationConfig,
  specialNodeIds: ReadonlySet<Id> = new Set(),
  activeId: (pointKey: string) => Id | undefined = () => undefined,
  defaultKind: SplitFaceKind = "wall",
  wallPairs: ReadonlySet<string> = new Set(),
  nodeColors: readonly number[] = canvas.node.splitSlots,
  /** When set (GitHub issue #314 follow-up, "Vector by corridors" only), each `wallSegments[i]`'s
   *  own `center` is repositioned to divide this width — the ordinary corridor's own `thickness`,
   *  not the whole shared face — evenly among every node sharing that face, centered on the face's
   *  own midpoint. Corridor mode has no wall geometry to visually divide a face into per-node
   *  shares in the first place, so several connections leaving the same face should read as sitting
   *  side by side within the corridor that actually runs through it, not spread across the face's
   *  full (often much wider) span. `undefined` (every other caller) keeps the original
   *  divide-the-whole-face behavior `computeSplitFaceLayouts` already computes. */
  corridorConnectorWidth?: number,
): SplitPassagesResult {
  const nodeById = new Map<Id, SplitPassageNode<Id>>();
  for (const n of nodes) nodeById.set(n.id, n);

  const directed = new Set<string>();
  for (const { from, to } of directedPairs) {
    if (!nodeById.has(from) || !nodeById.has(to)) continue;
    directed.add(`${String(from)}->${String(to)}`);
  }

  const byPoint = new Map<string, SplitPassageNode<Id>[]>();
  for (const n of nodes) {
    const key = `${n.x},${n.y}`;
    const list = byPoint.get(key);
    if (list) list.push(n); else byPoint.set(key, [n]);
  }

  // The neighboring point across a face may itself be split — several of its nodes can each have
  // their own independent connection across that same geometric face. Picking a single "the"
  // neighbor node per face (as opposed to per node-pair) would check `node`'s directed/wall state
  // against the wrong neighbor whenever `node`'s real partner isn't that neighbor point's first
  // node, silently falling back to `defaultKind` even though a real decided connection exists
  // (reported bug: a passage added to a specific slot rendered as still-optional because the
  // lookup checked the neighbor's original node instead). `other` must be resolved per node pair.
  //
  // A directed (passage/one-way) match wins outright over a `wall` match — a blueprint apply
  // explicitly walls off every neighbor candidate the resolved partner didn't pick (GitHub issue
  // #243 follow-up), so the *first* candidate in iteration order with a `wall` entry isn't
  // necessarily `node`'s real connecting neighbor; a later candidate might still hold the real
  // passage. Only fall back to a `wall` match if no candidate has a directed entry at all.
  const resolveOther = (node: SplitPassageNode<Id>, neighbors: SplitPassageNode<Id>[]): SplitPassageNode<Id> => {
    let wallFallback: SplitPassageNode<Id> | null = null;
    for (const candidate of neighbors) {
      if (
        directed.has(`${String(node.id)}->${String(candidate.id)}`) ||
        directed.has(`${String(candidate.id)}->${String(node.id)}`)
      ) {
        return candidate;
      }
      if (wallPairs.has(`${String(node.id)}<->${String(candidate.id)}`)) wallFallback ??= candidate;
    }
    return wallFallback ?? neighbors[0];
  };

  const result: SplitPassage[] = [];
  const wallFaces: { v0: { x: number; y: number }; v1: { x: number; y: number } }[] = [];
  const specialShapes: SplitSpecialShape[] = [];

  for (const [pointKey, pointNodes] of byPoint) {
    if (pointNodes.length <= 1) continue; // unsplit point — rendered by buildMazeWalls instead

    const [px, py] = [pointNodes[0].x, pointNodes[0].y];
    const center = getCellCenter(px, py, cfg);
    const count = pointNodes.length;
    const { offsets, edgeVerts } = getNeighborData(cfg, px, py);

    // Per-offset-index face geometry + per-node kind, mirroring TileFaceEditor's model exactly —
    // a face this point has no actual geometric neighbor for (or whose neighbor isn't in `nodes`)
    // is skipped entirely (empty per-node kinds list, not a `SplitFaceKind` value — "none" doesn't
    // exist as a per-node decision state, see `splitFaceLayout.ts`).
    const faceInputs: { v0: { x: number; y: number }; v1: { x: number; y: number } }[] = [];
    const kindsByFace: { nodeIndex: number; kind: SplitFaceKind }[][] = [];

    for (const [dx, dy] of offsets) {
      const neighbors = byPoint.get(`${px + dx},${py + dy}`);
      const anyNeighbor = neighbors?.[0];
      const seg = anyNeighbor ? getSharedEdgeSegment([px, py], [anyNeighbor.x, anyNeighbor.y], cfg) : null;
      if (!neighbors || !seg) { faceInputs.push({ v0: center, v1: center }); kindsByFace.push([]); continue; }

      faceInputs.push(seg);
      kindsByFace.push(pointNodes.map((node, nodeIndex) => {
        const other = resolveOther(node, neighbors);
        const fwd = directed.has(`${String(node.id)}->${String(other.id)}`);
        const bwd = directed.has(`${String(other.id)}->${String(node.id)}`);
        const isWallPair = wallPairs.has(`${String(node.id)}<->${String(other.id)}`);
        const kind: SplitFaceKind = fwd && bwd ? "passage" : fwd ? "one_way_out" : bwd ? "one_way_in" : isWallPair ? "wall" : defaultKind;
        return { nodeIndex, kind };
      }));
    }

    // Per-node face-kind matrix (dense, `"wall"` for a face this point has no geometric neighbor
    // for) — only needed for special-shape detection, not the ordinary segment/connector layout,
    // which works off the sparse `kindsByFace` above.
    const faceKindsByNode: SplitFaceKind[][] = pointNodes.map((_, nodeIndex) =>
      kindsByFace.map((faceKinds) => faceKinds.find((k) => k.nodeIndex === nodeIndex)?.kind ?? "wall"),
    );
    const specialShapeKind = detectSplitSpecialShapeKind(faceKindsByNode);
    if (specialShapeKind === "diagonal") {
      // The diagonal must run through the two corners where a face of node 0 meets a face of
      // node 1 (so every one of node 0's faces ends up strictly on one side, node 1's on the
      // other) — NOT the corner shared between node 0's own two faces (that corner is where both
      // of node 0's own faces meet each other, putting it on the wrong side of the cut). With the
      // faces split into two adjacent pairs there are exactly two such node0/node1 corners
      // (degree 4: each node's pair borders the other's pair on both sides going around the tile).
      const node0Faces = faceKindsByNode[0].reduce<number[]>((acc, k, i) => (k === "wall" ? acc : [...acc, i]), []);
      const node1Faces = faceKindsByNode[1].reduce<number[]>((acc, k, i) => (k === "wall" ? acc : [...acc, i]), []);
      const verts = getCellVertices(px, py, cfg);
      const cornerIdxs: number[] = [];
      for (const fa of node0Faces) {
        for (const fb of node1Faces) {
          const c = sharedCornerIndex(edgeVerts, fa, fb);
          if (c !== null) cornerIdxs.push(c);
        }
      }
      if (verts && cornerIdxs.length === 2) {
        specialShapes.push({ kind: "diagonal", pointKey, corner0: verts[cornerIdxs[0]], corner1: verts[cornerIdxs[1]] });
      }
    } else if (specialShapeKind === "bridge") {
      // Node 0 is the "through" pair (opposite faces, drawn as nothing — an ordinary passage);
      // node 1 is the "cross" pair, drawn as the bridge's own two edges: full width at the cross
      // faces (100%), narrowing to 60% over the tile's first/last 20% of length, a flat 60%-wide
      // deck across the middle 60%.
      const crossIdx = faceKindsByNode[1].reduce<number[]>((acc, k, i) => (k === "wall" ? acc : [...acc, i]), []);
      const crossFaces: [{ v0: { x: number; y: number }; v1: { x: number; y: number } }, { v0: { x: number; y: number }; v1: { x: number; y: number } }] =
        [faceInputs[crossIdx[0]], faceInputs[crossIdx[1]]];
      // Node 0's own opposite-face pair — the through corridor's real axis (GitHub issue #314),
      // distinct from `crossFaces` (node 1's own pair) computed above.
      const throughIdx = faceKindsByNode[0].reduce<number[]>((acc, k, i) => (k === "wall" ? acc : [...acc, i]), []);
      const throughFace0 = faceInputs[throughIdx[0]];
      const throughFace1 = faceInputs[throughIdx[1]];
      const throughMid0 = { x: (throughFace0.v0.x + throughFace0.v1.x) / 2, y: (throughFace0.v0.y + throughFace0.v1.y) / 2 };
      const throughMid1 = { x: (throughFace1.v0.x + throughFace1.v1.x) / 2, y: (throughFace1.v0.y + throughFace1.v1.y) / 2 };
      const [pairB0, pairB1] = nearestEndpointPairing(crossFaces[0], crossFaces[1]);
      const endsAt = (face: typeof crossFaces[0], slot: 0 | 1) => (slot === 0 ? face.v0 : face.v1);
      const end0 = { v0: endsAt(crossFaces[0], 0), v1: endsAt(crossFaces[0], 1) };
      const end1 = { v0: endsAt(crossFaces[1], pairB0), v1: endsAt(crossFaces[1], pairB1) };

      // Corridor axis: face-midpoint to face-midpoint (not `.v0`, which needn't lie on the axis) —
      // `along(t)` interpolates a point at fraction `t` of the corridor's own length.
      const mid0 = { x: (end0.v0.x + end0.v1.x) / 2, y: (end0.v0.y + end0.v1.y) / 2 };
      const mid1 = { x: (end1.v0.x + end1.v1.x) / 2, y: (end1.v0.y + end1.v1.y) / 2 };
      const along = (t: number) => ({ x: mid0.x + (mid1.x - mid0.x) * t, y: mid0.y + (mid1.y - mid0.y) * t });

      // Each edge's own perpendicular half-width at a given axis point, scaled by `widthFrac`
      // (1.0 at the cross faces, `BRIDGE_DECK_WIDTH_FRAC` on the flat deck) — computed per side
      // (`sideSign` = +1 for edge0, -1 for edge1) from that side's own full-width offset at the
      // matching cross face, so an asymmetric face (off-center split point) still narrows evenly.
      const buildEdge = (endAt0: { x: number; y: number }, endAt1: { x: number; y: number }): [
        { x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number },
      ] => {
        const lerp = (p: { x: number; y: number }, q: { x: number; y: number }, t: number) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
        const axisAt0 = along(0), axisAt20 = along(BRIDGE_TAPER_FRAC), axisAt80 = along(1 - BRIDGE_TAPER_FRAC), axisAt100 = along(1);
        const narrowedAt = (axisPoint: { x: number; y: number }, fullWidthEnd: { x: number; y: number }, fullWidthAxis: { x: number; y: number }) =>
          lerp(axisPoint, { x: axisPoint.x + (fullWidthEnd.x - fullWidthAxis.x), y: axisPoint.y + (fullWidthEnd.y - fullWidthAxis.y) }, BRIDGE_DECK_WIDTH_FRAC);
        return [endAt0, narrowedAt(axisAt20, endAt0, axisAt0), narrowedAt(axisAt80, endAt1, axisAt100), endAt1];
      };

      specialShapes.push({
        kind: "bridge",
        pointKey,
        crossFaces: [end0, end1],
        edge0: buildEdge(end0.v0, end1.v0),
        edge1: buildEdge(end0.v1, end1.v1),
        throughLine: [throughMid0, throughMid1],
      });
    }

    const activeNodeId = activeId(pointKey);
    const activeIndexRaw = activeNodeId === undefined ? -1 : pointNodes.findIndex((n) => n.id === activeNodeId);
    const activeIndex = activeIndexRaw < 0 ? null : activeIndexRaw;
    const faceLayouts = computeSplitFaceLayouts(faceInputs, kindsByFace, activeIndex);
    faceLayouts.forEach((layout, i) => { if (layout.allWall) wallFaces.push(faceInputs[i]); });
    const hubRadius = SPLIT_HUB_RADIUS;
    const rotationRad = (getSplitCircleRotationDeg(cfg) * Math.PI) / 180;
    const nodeConnectors = computeSplitConnectors(
      faceLayouts, count, activeIndex, center, hubRadius, rotationRad,
      (nodeIndex) => specialNodeIds.has(pointNodes[nodeIndex].id),
    );

    for (const { nodeIndex, lines } of nodeConnectors) {
      if (lines.length === 0) continue; // no connections — draws nothing

      const color = splitSlotColor(nodeIndex, nodeColors);
      const wallSegments = faceLayouts
        .flatMap((layout, faceIndex) => layout.segments
          .map((s, indexInFace) => ({ s, faceIndex, indexInFace, faceCount: layout.segments.length }))
          .filter((entry) => entry.s.nodeIndex === nodeIndex))
        .map(({ s, faceIndex, indexInFace, faceCount }) => {
          let center = { x: (s.v0.x + s.v1.x) / 2, y: (s.v0.y + s.v1.y) / 2 };
          if (corridorConnectorWidth !== undefined) {
            // Divide the ordinary corridor's own width (not the whole face) evenly among every
            // node sharing this face, centered on the face's own midpoint — see this function's
            // own `corridorConnectorWidth` doc comment.
            const face = faceInputs[faceIndex];
            const faceMid = { x: (face.v0.x + face.v1.x) / 2, y: (face.v0.y + face.v1.y) / 2 };
            const fdx = face.v1.x - face.v0.x, fdy = face.v1.y - face.v0.y;
            const flen = Math.hypot(fdx, fdy) || 1;
            const ux = fdx / flen, uy = fdy / flen;
            const t = (indexInFace + 0.5) / faceCount - 0.5; // -0.5..0.5, centered
            const offset = t * corridorConnectorWidth;
            center = { x: faceMid.x + ux * offset, y: faceMid.y + uy * offset };
          }
          return {
            v0: s.v0, v1: s.v1, center,
            isUndefined: s.kind === "undefined",
            oneWayOut: s.kind === "one_way_out" ? true : s.kind === "one_way_in" ? false : undefined,
            atFaceStart: s.atFaceStart,
            atFaceEnd: s.atFaceEnd,
          };
        });
      const connectors = lines.map((line) => ({ from: line.from, to: line.to, oneWayOut: line.oneWayOut, isUndefined: line.isUndefined }));

      result.push({ color, pointKey, center, wallSegments, connectors });
    }
  }

  return { passages: result, wallFaces, specialShapes };
}

/** Post-generation adapter over `buildSplitPassagesCore` — `NodeDto`'s own `id: number` is the
 *  identity, `EdgeDto`'s teleport-kind entries are filtered out before reaching the core (a
 *  teleport must not read as an open passage, same rule as `buildMazeWalls`). `activeSplitNode`
 *  (mirrors `postEditActiveSplitNode`) resolves which of a point's nodes draws on top (GitHub
 *  issue #234 follow-up) — a `split` entry is resolved to its real `NodeId` via
 *  `buildSplitNodeResolver` (needs `postEditDraftSplitPoints` for the point's sorted slotId
 *  order); absence for a point means its original (first) node. `nodeColors` (default
 *  `canvas.node.splitSlots`) overrides `splitSlotColor`'s per-slot palette — GitHub issue #294,
 *  used by `VectorByWallsRenderer` to expose split-node colors as a user setting. See
 *  `buildSplitPassagesCore`'s doc comment for the shared algorithm. */
export function buildSplitPassages(
  nodes: NodeDto[],
  edges: EdgeDto[],
  cfg: TessellationConfig,
  specialNodeIds: ReadonlySet<number> = new Set(),
  activeSplitNode: Record<string, PostEditEndpoint> = {},
  postEditDraftSplitPoints: Record<string, number[]> = {},
  nodeColors: readonly number[] = canvas.node.splitSlots,
  /** See `buildSplitPassagesCore`'s own doc comment — "Vector by corridors" only. */
  corridorConnectorWidth?: number,
): SplitPassagesResult {
  const directedPairs = edges.filter((e) => e.kind !== "teleport").map((e) => ({ from: e.from, to: e.to }));

  const nodeMap = new Map<string, number[]>();
  for (const n of nodes) {
    const key = `${n.x},${n.y}`;
    const list = nodeMap.get(key);
    if (list) list.push(n.id); else nodeMap.set(key, [n.id]);
  }
  const resolveSplit = buildSplitNodeResolver(nodeMap, postEditDraftSplitPoints);
  const activeId = (pointKey: string): number | undefined => {
    const active = activeSplitNode[pointKey];
    if (!active) return undefined;
    return resolveEndpoint(active, resolveSplit);
  };

  return buildSplitPassagesCore(nodes, directedPairs, cfg, specialNodeIds, activeId, "wall", new Set(), nodeColors, corridorConnectorWidth);
}

// --- Loss-detection predicates ---
// When adding a new feature that produces user data (not analytics/read-only),
// add a predicate here and wire it into the relevant confirmation dialogs.

/** True when the user has made manual post-edit changes since the last generate/reset. */
export function selectPostEditDirty(s: Pick<MazeState, "postEditDirty">): boolean {
  return s.postEditDirty;
}

/** True when confirming tessellation would destroy data the user has entered. */
export function selectTessellationWouldLoseData(s: Pick<MazeState,
  "previewKind" | "tessellationKind" | "fieldDirty" | "presetsDirty" | "mazeDirty" | "postEditDirty"
>): boolean {
  if (s.previewKind === s.tessellationKind) return false;
  return s.fieldDirty || s.presetsDirty || s.mazeDirty || s.postEditDirty;
}

/** True when removing `floorId` would discard field/preset data configured on that floor.
 * Field/preset state is currently maze-wide, not per-floor (see Specs/space.md's "Not yet built
 * on top of this layer" note) — always false until a future issue introduces per-floor
 * field/preset data. Takes `floorId` (would additionally take state once real per-floor data
 * exists) rather than being a bare constant, so the call site and signature don't need to change
 * when this stops being a stub — only the body does. */
export function selectFloorRemovalLosesFieldData(_floorId: string): boolean {
  return false;
}

/** True when removing or reordering floors would require resetting the current generation/
 * post-edit results — floor identity shift affects underlying node/graph state (see
 * Specs/space.md). The caller (FloorsFeature) must actually call `reset()` on confirm when this
 * is true, not just warn — a stale maze left on screen after floor identity changed underneath it
 * would be actively misleading, not merely "possibly outdated". */
export function selectFloorChangeLosesGenerationData(s: Pick<MazeState, "mazeDirty" | "postEditDirty">): boolean {
  return s.mazeDirty || s.postEditDirty;
}

const PIPELINE_ONLY_ISSUE_KINDS = ["repair_limit_reached"];

/** Issues shown by the Analytics card/feature — `postEditAnalytics.issues` when present
 * (recomputed by `confirmPostEdit`'s `computeAnalytics`, which always re-runs right after
 * generation, even with no user edits), else `issues` (the raw post-generation snapshot).
 * `computeAnalytics` runs QC alone, with no `RepairLimits` concept, so `repair_limit_reached`
 * (pushed only by `build_maze`'s repair loop — see `Specs/repair.md`) can never appear in
 * `postEditAnalytics.issues`; carried forward from `issues` regardless of which source otherwise
 * wins, so it survives the post-generation `confirmPostEdit` recompute. Single source of truth
 * for both the bubble list (`AnalyticsFeature`) and the card status (`FeaturesPanel`) — they must
 * agree on what counts as "this maze has issues". */
export function selectAnalyticsIssues(s: Pick<MazeState, "issues" | "postEditAnalytics">): IssueDto[] {
  return [
    ...s.issues.filter((i) => PIPELINE_ONLY_ISSUE_KINDS.includes(i.kind)),
    ...(s.postEditAnalytics?.issues ?? s.issues),
  ];
}

/** Cross-floor resolution inputs for `buildTeleportEdges` (GitHub issue #337) — omitted by every
 *  non-floor-aware caller, which keeps the old behavior of silently dropping a teleport edge whose
 *  `to` doesn't resolve in `nodeById` (not reachable there yet anyway: cross-floor teleports don't
 *  exist until #340, and only floor-aware callers scope `edges` in a way that lets one through
 *  `selectFloorScopedMaze` in the first place). `resolveNodeLevel`/`unscopedNodeById` must both come
 *  from the *unscoped* node list, same requirement `buildVerticalConnectionMarkers` already has on
 *  its own `resolveNodeLevel`/`allEdges` params, since `to` never survives floor-scoping itself.
 *  `unscopedEdges` (same *unscoped* requirement) is what `byPair`'s bidirectional-detection needs
 *  for a cross-floor pair — its reverse-direction edge has its own `from` on the *other* floor, so
 *  it's never present in the already floor-scoped `edges` this function otherwise reads (same
 *  bidirectional-detection gap `selectVerticalPassagePairSet`'s own doc comment describes for
 *  `vertical_passage`). */
export type TeleportFloorContext = {
  resolveNodeLevel: (id: number) => number | undefined;
  unscopedNodeById: Map<number, NodeDto>;
  unscopedEdges: EdgeDto[];
  activeFloorIndex: number;
};

// Collapses opposite-direction teleport-edge pairs into one entity so a two-way teleport never
// renders as two overlapping lines/arrows. `oneWay: false` when both directions exist between
// the pair; `oneWay: true` (with from/to = that edge's actual direction) when only one does.
//
// A teleport endpoint on a split point (GitHub issue #223) anchors to that node's own hub point
// (`buildNodePositions`), not the tile's plain center — `nodeById`'s full value set stands in for
// `nodes` here (unsplit callers, e.g. GenerationRenderer, never have more than one node per point,
// so this is a no-op for them; only PostEditRenderer's split points actually differ). Builds the
// position map once (GitHub issue #318 follow-up) rather than calling `getSplitAwareNodePosition`
// per endpoint — that would rebuild the whole map from scratch for every one of up to `2 ×
// teleport pair count` lookups.
//
// `floorContext` (GitHub issue #337, optional — see its own doc comment) resolves a cross-floor
// `to` (absent from `nodeById`, which is floor-scoped for every floor-aware caller) via its own
// `unscopedNodeById`/`resolveNodeLevel`, then substitutes the midpoint between `from`'s and the
// real (off-image) `to` position as this edge's own `to` — the routing/collision-avoidance layers
// downstream (`TeleportConnectorRouter` et al.) never need to know the far end isn't really drawn
// there; only `toFloor` being set tells `TeleportRenderer` to draw a floor-badge at that point
// instead of an ordinary marker. That midpoint is built from each node's own plain cell center
// (`getCellCenter`), not either node's own hub position (`nodePos`/`buildNodePositions`) — a hub
// position is shaped by `directedPairs`, which differs depending on which floor is active (the
// active floor's own nodes/edges feed it, the far floor's never do), so the same logical pair
// viewed from either floor would otherwise resolve to two slightly different hub positions and the
// badge would visibly shift between floors. Plain cell centers have no such context-dependence —
// the same `(x, y)` always resolves to the same point regardless of which floor is asking.
export function buildTeleportEdges(
  nodeById: Map<number, NodeDto>,
  edges: EdgeDto[],
  cfg: TessellationConfig,
  floorContext?: TeleportFloorContext,
): TeleportEdge[] {
  const teleports = edges.filter((e) => e.kind === "teleport");
  const byPair = new Set(teleports.map((e) => `${e.from}->${e.to}`));
  const seenPairKey = new Set<string>();
  const result: TeleportEdge[] = [];
  const allNodes = Array.from(nodeById.values());
  const directedPairs = edges.filter((e) => e.kind !== "teleport").map((e) => ({ from: e.from, to: e.to }));
  const nodePos = buildNodePositions(allNodes, cfg, directedPairs);

  for (const e of teleports) {
    const pairKey = e.from < e.to ? `${e.from},${e.to}` : `${e.to},${e.from}`;
    if (seenPairKey.has(pairKey)) continue;
    seenPairKey.add(pairKey);

    const fromPos = nodePos.get(e.from);
    let toPos = nodePos.get(e.to);
    let toFloor: number | undefined;
    // A cross-floor pair's reverse edge is never in `byPair` (built from the floor-scoped
    // `teleports` above, which structurally can't contain it — see `TeleportFloorContext`'s own
    // doc comment) — re-checked against the unscoped edge list once this edge is confirmed
    // cross-floor, below, so `reverseExists` isn't finalized until after that check.
    let reverseExists = byPair.has(`${e.to}->${e.from}`);

    if (!toPos && floorContext) {
      const level = floorContext.resolveNodeLevel(e.to);
      if (level !== undefined && level !== floorContext.activeFloorIndex) {
        const fromNode = nodeById.get(e.from);
        const realToNode = floorContext.unscopedNodeById.get(e.to);
        if (fromNode && realToNode) {
          const fromCenter = getCellCenter(fromNode.x, fromNode.y, cfg);
          const realToCenter = getCellCenter(realToNode.x, realToNode.y, cfg);
          const midX = (fromCenter.x + realToCenter.x) / 2;
          const midY = (fromCenter.y + realToCenter.y) / 2;
          // Snapped onto the grid (GitHub issue #337 follow-up), not left at the raw midpoint —
          // an unsnapped point can land mid-wall, making the connector look like it cuts straight
          // through a wall instead of ending at a real cell. `nearestCellCoord` is a pure function
          // of `(midX, midY, cfg)` alone, so the snapped cell (and thus this badge's own world
          // position) is identical whichever floor computed it — required for the from/to symmetry
          // this whole midpoint scheme already depends on (see this function's own doc comment).
          const [snapX, snapY] = nearestCellCoord(midX, midY, cfg);
          const snapped = getCellCenter(snapX, snapY, cfg);
          toPos = { x: snapped.x, y: snapped.y };
          toFloor = level;
          reverseExists = floorContext.unscopedEdges.some((ue) => ue.kind === "teleport" && ue.from === e.to && ue.to === e.from);
        }
      }
    }
    if (!fromPos || !toPos) continue;

    result.push({
      from: [fromPos.x, fromPos.y],
      to: [toPos.x, toPos.y],
      oneWay: !reverseExists,
      fromNode: e.from,
      toNode: e.to,
      ...(toFloor !== undefined ? { toFloor } : {}),
    });
  }

  return result;
}

/** Highlight for `postEditHoveredLink` (GitHub issue #237) — same "node-to-node" style
 *  `DebugRefHighlightOverlay` uses for an edge ref (`NodeEdgeHighlightRenderer`: a straight line
 *  + circle markers on each end), cell center to cell center — not the shared geometric wall
 *  segment (a teleport link has no shared face at all to draw on), and not a split point's hub
 *  point either (kept simple: this highlight only needs to say "these two cells", not distinguish
 *  which of a split point's several nodes). Silently renders nothing if either endpoint doesn't
 *  resolve (an unconfirmed split node — same "nothing to draw yet" contract as
 *  `postEditEdgesToDto`). */
export function buildLinkHoverHighlight(
  link: { from: PostEditEndpoint; to: PostEditEndpoint } | null,
  nodes: NodeDto[],
  resolveSplit: (point: [number, number], slotId: number) => number | undefined,
  cfg: TessellationConfig,
): NodeEdgeHighlight[] {
  if (!link) return [];
  const fromId = resolveEndpoint(link.from, resolveSplit);
  const toId = resolveEndpoint(link.to, resolveSplit);
  if (fromId === undefined || toId === undefined) return [];
  const fromNode = nodes.find((n) => n.id === fromId);
  const toNode = nodes.find((n) => n.id === toId);
  if (!fromNode || !toNode) return [];
  return [{
    from: getCellCenter(fromNode.x, fromNode.y, cfg),
    to: getCellCenter(toNode.x, toNode.y, cfg),
    color: canvas.fieldEditor.hover,
    alpha: 1.0,
    width: WALL_THICKNESS * 2,
    nodeRadius: NODE_RADIUS,
  }];
}

/** Same field shape as `MarkerSettings` (`storeTypes.ts`) by design — kept as its own type since
 *  this lower-level selector module must not depend on the store layer, but the identical field
 *  names let a `VectorByWallsSettings` marker be passed straight through without manual zipping. */
export interface MarkerStyle {
  shape: MarkerShape;
  fillColor: number;
  borderColor: number;
  borderWidth: number;
  /** Marker radius, as a fraction of the tile size (0-1) — same convention as
   *  `VectorByWallsSettings.teleportLineSize`. */
  size: number;
  /** Sharp vs. round corners (GitHub issue #302 follow-up), same convention/rounding as
   *  `TeleportCornerStyle` — only affects the four regular-polygon `MarkerShape`s. */
  cornerStyle: TeleportCornerStyle;
  /** Floor-colored gap drawn around the marker's border (GitHub issue #302 follow-up), same
   *  convention as `VectorByWallsSettings.teleportConnectorGapWidth` — `0` (the default) draws no
   *  gap. `gapColor` is meant to always mirror the caller's own floor color; callers outside
   *  `VectorByWallsRenderer` (which have no floor color of their own to give it) simply leave
   *  `gapWidth` at `0`, so `gapColor`'s value never actually shows. */
  gapWidth: number;
  gapColor: number;
}

const DEFAULT_MARKER_SIZE = (NODE_RADIUS * 1.5) / TILE_SIZE;

const DEFAULT_START_STYLE: MarkerStyle = { shape: "circle", fillColor: canvas.node.start, borderColor: canvas.node.start, borderWidth: 0, size: DEFAULT_MARKER_SIZE, cornerStyle: "sharp", gapWidth: 0, gapColor: 0 };
const DEFAULT_FINISH_STYLE: MarkerStyle = { shape: "circle", fillColor: canvas.node.finish, borderColor: canvas.node.finish, borderWidth: 0, size: DEFAULT_MARKER_SIZE, cornerStyle: "sharp", gapWidth: 0, gapColor: 0 };

/** A start/finish marker on a split point (GitHub issue #223) anchors to that node's own hub
 *  point (`buildNodePositions`), not the tile's plain center — `nodeById`'s full value set
 *  stands in for `nodes` (see `buildTeleportEdges`'s doc comment for why this is safe for
 *  unsplit callers). `edges` drives shape detection for a bridge/diagonal split point (GitHub issue
 *  #318) — pass `[]` (default) to always use the generic hub position. `startStyle`/`finishStyle`
 *  default to a plain circle with no border (every caller except `VectorByWallsRenderer`, whose
 *  marker appearance is user-configurable — see GitHub issue #296), so passing them is opt-in. */
export function buildMazeMarkers(
  nodeById: Map<number, NodeDto>,
  start: number | null,
  finish: number | null,
  cfg: TessellationConfig,
  startStyle: MarkerStyle = DEFAULT_START_STYLE,
  finishStyle: MarkerStyle = DEFAULT_FINISH_STYLE,
  edges: EdgeDto[] = [],
): MarkerData[] {
  const markers: MarkerData[] = [];
  const allNodes = Array.from(nodeById.values());
  const directedPairs = edges.filter((e) => e.kind !== "teleport").map((e) => ({ from: e.from, to: e.to }));
  const nodePos = buildNodePositions(allNodes, cfg, directedPairs);
  if (start !== null) {
    const c = nodePos.get(start);
    if (c) {
      markers.push({
        pos: [c.x, c.y], radius: startStyle.size * TILE_SIZE,
        shape: startStyle.shape, color: startStyle.fillColor, borderColor: startStyle.borderColor, borderWidth: startStyle.borderWidth,
        cornerStyle: startStyle.cornerStyle, gapWidth: startStyle.gapWidth, gapColor: startStyle.gapColor,
      });
    }
  }
  if (finish !== null) {
    const c = nodePos.get(finish);
    if (c) {
      markers.push({
        pos: [c.x, c.y], radius: finishStyle.size * TILE_SIZE,
        shape: finishStyle.shape, color: finishStyle.fillColor, borderColor: finishStyle.borderColor, borderWidth: finishStyle.borderWidth,
        cornerStyle: finishStyle.cornerStyle, gapWidth: finishStyle.gapWidth, gapColor: finishStyle.gapColor,
      });
    }
  }
  return markers;
}

