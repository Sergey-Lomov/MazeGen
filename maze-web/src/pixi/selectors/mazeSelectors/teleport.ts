import type { NodeDto, EdgeDto } from "../../../wasm/types";
import type { FieldConfig as TessellationConfig } from "../../../fieldConfig";
import type { TeleportEdge, WallEdge, VerticalConnectionMarker, SplitPassage } from "../../renderers/types";
import { getCellCenter, buildNodePositions, nearestCellCoord, getCellNeighborOffsets } from "../../tessellationGeometry";
import { selectNodeLevelResolver } from "./state";
import { buildOneWayWallIndicatorPositions } from "./walls";
import { buildOneWayCorridorIndicatorPositions, type CorridorSegment } from "./corridors";
import { buildSplitJunctionPositions } from "./split";

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
  floorCount?: number;
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
/** Extra inputs for `buildTeleportEdges`' cross-floor badge collision spread (GitHub issue #480).
 *  All optional — a caller without them gets the pre-#480 behavior (badges left exactly on their
 *  snapped midpoint, no collision handling). */
export type TeleportBadgeSpreadOptions = {
  /** Per-floor set of cells that already draw a *center* marker (start/finish, split junction,
   *  vertical-passage/elevator end, ordinary teleport-marker cell) — built by
   *  `buildTeleportBadgeBlockedCells` from the caller's unscoped nodes/edges, keyed by floor index.
   *  A relocated badge for a pair connecting floors A and B avoids the union of floor A's and floor
   *  B's blocked cells only (a badge on floors 1↔5 ignores floor 2's markers) — the active floor
   *  never enters this; relocation is floor-independent so the pair's two badges stay together across
   *  a floor switch. Omitted → no marker cells are treated as blocked (badges still avoid each
   *  other). */
  blockedCellsByFloor?: Map<number, [number, number][]>;
  /** `false` keeps every relocated badge inside the maze field's own cell footprint (`fieldCells`);
   *  `true` lets a badge move to a grid cell outside the field. Editor renderers pass `true`
   *  (a badge just off the field edge is fine there); image-export renderers pass the user's
   *  "avoid field exit" toggle. Defaults to `true`. */
  allowOutOfField?: boolean;
  /** The maze field's own node cell coordinates, backing `allowOutOfField: false` — omitted or empty
   *  is treated as "no field constraint" regardless of `allowOutOfField`. */
  fieldCells?: [number, number][];
};

/** Builds the per-floor blocked-cell map `buildTeleportEdges`'s badge relocation (GitHub issue #480)
 *  needs: for each floor index, the grid cells that draw a *center* marker on that floor — so a
 *  relocated cross-floor badge is never dropped on top of one and hidden. Center markers are:
 *  start/finish node cells, split-junction cells (a cell holding more than one node), and both ends
 *  of every `vertical_passage`/`elevator`/`teleport` edge. One-way passage markers are deliberately
 *  excluded (they sit on cell edges, not centers). All inputs are the *unscoped* (all-floor) lists;
 *  `resolveNodeLevel` also unscoped. Callers pass every floor (not just the active one) so a badge
 *  viewed from either end floor resolves identically. */
/** Whether the project has at least one *cross-floor* teleport — a `teleport` edge whose two
 *  endpoints sit on different floors (`NodeDto.level ?? 0`). Drives the export panels' "Floor
 *  badges" subsection visibility (GitHub issue #485); fed the *unscoped* project-wide node/edge
 *  lists so the subsection doesn't flicker on a floor switch (same project-wide section-visibility
 *  rule as GitHub issue #484). */
export function hasCrossFloorTeleport(unscopedNodes: NodeDto[], unscopedEdges: EdgeDto[]): boolean {
  const levelById = new Map(unscopedNodes.map((n) => [n.id, n.level ?? 0]));
  return unscopedEdges.some((e) => e.kind === "teleport" && levelById.get(e.from) !== levelById.get(e.to));
}

export function buildTeleportBadgeBlockedCells(
  unscopedNodes: NodeDto[],
  unscopedEdges: EdgeDto[],
  resolveNodeLevel: (id: number) => number | undefined,
  startNodeId: number | null,
  finishNodeId: number | null,
): Map<number, [number, number][]> {
  const perFloor = new Map<number, Set<string>>();
  const add = (level: number | undefined, x: number, y: number) => {
    if (level === undefined) return;
    let set = perFloor.get(level);
    if (!set) { set = new Set(); perFloor.set(level, set); }
    set.add(`${x},${y}`);
  };

  // Split junctions: a cell holding more than one node (per floor).
  const cellCount = new Map<string, { level: number | undefined; x: number; y: number; n: number }>();
  for (const nd of unscopedNodes) {
    const level = resolveNodeLevel(nd.id);
    const key = `${level}:${nd.x},${nd.y}`;
    const entry = cellCount.get(key) ?? { level, x: nd.x, y: nd.y, n: 0 };
    entry.n += 1;
    cellCount.set(key, entry);
  }
  for (const { level, x, y, n } of cellCount.values()) {
    if (n > 1) add(level, x, y);
  }

  const nodeById = new Map(unscopedNodes.map((nd) => [nd.id, nd]));
  if (startNodeId !== null) {
    const s = nodeById.get(startNodeId);
    if (s) add(resolveNodeLevel(startNodeId), s.x, s.y);
  }
  if (finishNodeId !== null) {
    const f = nodeById.get(finishNodeId);
    if (f) add(resolveNodeLevel(finishNodeId), f.x, f.y);
  }

  for (const e of unscopedEdges) {
    if (e.kind !== "vertical_passage" && e.kind !== "elevator" && e.kind !== "teleport") continue;
    const a = nodeById.get(e.from);
    const b = nodeById.get(e.to);
    if (a) add(resolveNodeLevel(e.from), a.x, a.y);
    if (b) add(resolveNodeLevel(e.to), b.x, b.y);
  }

  const out = new Map<number, [number, number][]>();
  for (const [level, set] of perFloor) {
    out.set(level, [...set].map((k) => k.split(",").map(Number) as [number, number]));
  }
  return out;
}

/** Assembles the `TeleportFloorContext` + `TeleportBadgeSpreadOptions` pair every floor-aware
 *  `buildTeleportEdges` caller needs (GitHub issue #484 follow-up) — `GenerationRenderer`,
 *  `AnalyticsRenderer`/`MazeOverlayRenderer`, `PostEditRenderer`, both vector export renderers, and
 *  the export panels' `useTeleportGroupsAndCollisions` all built this by hand, six near-identical
 *  copies that drifted apart in small ways (which `unscopedEdges` list, whether `fieldCells` is
 *  passed). All inputs are the *unscoped* (all-floor) lists — `resolveNodeLevel` too. `activeFloorId`
 *  is resolved to its `floors` index here (missing → `0`, same fallback every hand-rolled copy used).
 *
 *  `unscopedEdges` feeds the `floorContext`'s bidirectional-pair detection; `blockedCellsEdges`
 *  (defaults to `unscopedEdges`) feeds `buildTeleportBadgeBlockedCells` separately — `PostEditRenderer`
 *  is the one caller that differs, passing its draft edges to the former and `state.edges` ∪ draft to
 *  the latter. `allowOutOfField`/`fieldCells` are the badge-relocation field constraint: editor
 *  canvases pass `allowOutOfField: true` and no `fieldCells`; the vector export renderers pass
 *  `!teleportAvoidFieldExit` and the field's own cells. */
export function buildTeleportFloorInputs(opts: {
  unscopedNodes: NodeDto[];
  unscopedEdges: EdgeDto[];
  floors: { id: string }[];
  activeFloorId: string;
  start: number | null;
  finish: number | null;
  blockedCellsEdges?: EdgeDto[];
  allowOutOfField: boolean;
  fieldCells?: [number, number][];
}): { floorContext: TeleportFloorContext; spread: TeleportBadgeSpreadOptions } {
  const resolveNodeLevel = selectNodeLevelResolver(opts.unscopedNodes);
  const activeFloorIndex = Math.max(opts.floors.findIndex((f) => f.id === opts.activeFloorId), 0);
  return {
    floorContext: {
      resolveNodeLevel,
      unscopedNodeById: new Map(opts.unscopedNodes.map((n) => [n.id, n])),
      unscopedEdges: opts.unscopedEdges,
      activeFloorIndex,
    },
    spread: {
      blockedCellsByFloor: buildTeleportBadgeBlockedCells(
        opts.unscopedNodes, opts.blockedCellsEdges ?? opts.unscopedEdges, resolveNodeLevel, opts.start, opts.finish,
      ),
      allowOutOfField: opts.allowOutOfField,
      ...(opts.fieldCells ? { fieldCells: opts.fieldCells } : {}),
    },
  };
}

/** Assembles a `TeleportRenderer.render`'s `waypoints` array from whatever avoidance sources a
 *  caller has in hand (GitHub issue #518) — start/finish (and other center) markers, vertical
 *  passage/elevator markers, one-way indicator centers (wall chevron/arrow/triangle *or* corridor
 *  chevron row — a caller passes at most one of the two, since a single canvas never draws both
 *  readings), and split junction hub centers. Every source is optional: a caller with no marker of
 *  a given kind (e.g. preset connections has no one-way wall indicator concept) simply omits it.
 *  Mirrors `buildTeleportFloorInputs`'s own reasoning for extracting a shared builder — six
 *  near-identical hand-rolled copies is exactly how GitHub issue #516 (dropped waypoints) happened
 *  once already. */
export function buildTeleportAvoidanceWaypoints(sources: {
  markers?: { pos: [number, number] }[];
  verticalMarkers?: VerticalConnectionMarker[];
  oneWayWallEdges?: WallEdge[];
  cfg?: TessellationConfig;
  oneWayCorridorSegments?: CorridorSegment[];
  splitPassages?: SplitPassage[];
}): [number, number][] {
  const result: [number, number][] = [];
  if (sources.markers) for (const m of sources.markers) result.push(m.pos);
  if (sources.verticalMarkers) for (const m of sources.verticalMarkers) result.push(m.pos);
  if (sources.oneWayWallEdges && sources.cfg) {
    result.push(...buildOneWayWallIndicatorPositions(sources.oneWayWallEdges, sources.cfg));
  }
  if (sources.oneWayCorridorSegments) {
    result.push(...buildOneWayCorridorIndicatorPositions(sources.oneWayCorridorSegments));
  }
  if (sources.splitPassages) result.push(...buildSplitJunctionPositions(sources.splitPassages));
  return result;
}

export function buildTeleportEdges(
  nodeById: Map<number, NodeDto>,
  edges: EdgeDto[],
  cfg: TessellationConfig,
  floorContext?: TeleportFloorContext,
  spread?: TeleportBadgeSpreadOptions,
): TeleportEdge[] {
  const spreadOpts: TeleportBadgeSpreadOptions = spread ?? {};
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

    let fromPos = nodePos.get(e.from);
    let toPos = nodePos.get(e.to);
    let toFloor: number | undefined;
    let fromFloor: number | undefined;
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
    // Symmetric case: this edge's own `from` (departure) lives on another floor, `to` (arrival) is
    // here — e.g. the reverse directed edge of a two-way cross-floor pair, seen on the arrival
    // floor. Without this branch the pair is silently dropped on this floor: `seenPairKey` already
    // claims the pair key from whichever directed edge the caller's `edges` array happened to list
    // first, so if that first one is the departure-elsewhere direction (`fromPos` unresolvable),
    // the pair never gets a second chance via the other directed edge, and the separate arrival-
    // only pass below only ever triggers for a *pure one-way* pair (which has no reverse directed
    // edge to begin with, so `seenPairKey` never blocks it in the first place).
    if (!fromPos && floorContext) {
      const level = floorContext.resolveNodeLevel(e.from);
      if (level !== undefined && level !== floorContext.activeFloorIndex) {
        const toNode = nodeById.get(e.to);
        const realFromNode = floorContext.unscopedNodeById.get(e.from);
        if (toNode && realFromNode) {
          const toCenter = getCellCenter(toNode.x, toNode.y, cfg);
          const realFromCenter = getCellCenter(realFromNode.x, realFromNode.y, cfg);
          const midX = (toCenter.x + realFromCenter.x) / 2;
          const midY = (toCenter.y + realFromCenter.y) / 2;
          const [snapX, snapY] = nearestCellCoord(midX, midY, cfg);
          const snapped = getCellCenter(snapX, snapY, cfg);
          fromPos = { x: snapped.x, y: snapped.y };
          fromFloor = level;
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
      ...(fromFloor !== undefined ? { fromFloor } : {}),
    });
  }

  // Arrival-only cross-floor one-way teleports (GitHub issue #357 follow-up): a pure one-way
  // teleport whose `from` lives on another floor never survives `edges`' own floor-scoping (which
  // only keeps an edge when `from` is on the active floor), so the loop above never sees it — the
  // active floor would otherwise show nothing at all for it, unlike a same-floor one-way teleport,
  // whose arrival end still draws (as an outline point on its own `edges` entry). Every such pair is
  // already `seenPairKey`-excluded here when it has a same-direction *or* reverse entry the loop
  // above already produced (a same-floor pair a `resolveNodeLevel`-thin `unscopedEdges` scan would
  // otherwise re-detect as "arrival-only" a second time). Scanned from `unscopedEdges` (never just
  // `edges`, which is this function's own floor-scoped param and structurally excludes exactly the
  // edges this pass needs) — a no-op when `floorContext` is absent, same as the main loop's own
  // cross-floor branch.
  if (floorContext) {
    for (const e of floorContext.unscopedEdges) {
      if (e.kind !== "teleport") continue;
      const pairKey = e.from < e.to ? `${e.from},${e.to}` : `${e.to},${e.from}`;
      if (seenPairKey.has(pairKey)) continue;
      const toLevel = floorContext.resolveNodeLevel(e.to);
      if (toLevel !== floorContext.activeFloorIndex) continue;
      const fromLevel = floorContext.resolveNodeLevel(e.from);
      if (fromLevel === undefined || fromLevel === floorContext.activeFloorIndex) continue;
      seenPairKey.add(pairKey);

      const realToNode = floorContext.unscopedNodeById.get(e.to);
      const realFromNode = floorContext.unscopedNodeById.get(e.from);
      if (!realToNode || !realFromNode) continue;
      const toPos = nodePos.get(e.to) ?? getCellCenter(realToNode.x, realToNode.y, cfg);

      const fromCenter = getCellCenter(realFromNode.x, realFromNode.y, cfg);
      const toCenter = getCellCenter(realToNode.x, realToNode.y, cfg);
      const midX = (fromCenter.x + toCenter.x) / 2;
      const midY = (fromCenter.y + toCenter.y) / 2;
      const [snapX, snapY] = nearestCellCoord(midX, midY, cfg);
      const snapped = getCellCenter(snapX, snapY, cfg);

      result.push({
        from: [snapped.x, snapped.y],
        to: [toPos.x, toPos.y],
        oneWay: true,
        fromNode: e.from,
        toNode: e.to,
        fromFloor: fromLevel,
      });
    }
  }

  spreadCrossFloorBadges(
    result, cfg, floorContext,
    spreadOpts.blockedCellsByFloor,
    spreadOpts.allowOutOfField ?? true,
    spreadOpts.fieldCells,
  );
  return result;
}

function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

/** Maximum grid distance (in expanding neighbor rings from the desired cell) `findBadgeCell` will
 *  search for a free cell before giving up and falling back to the raw snapped midpoint. */
const BADGE_SEARCH_MAX_RINGS = 10;

/** One cross-floor teleport pair, in the shape `resolveCrossFloorBadgeCells` needs — `key` is a
 *  stable identity (any string, only used for map lookup and deterministic ordering), `floors` the
 *  two floors the pair spans (its badge avoids the union of just these two floors' blocked cells),
 *  `endA`/`endB` the grid coords of the pair's two *real* endpoint cells (the badge's desired cell is
 *  their snapped midpoint, and the search slides the badge along the `endA`→`endB` line). */
export type CrossFloorBadgePair = {
  key: string;
  floors: [number, number];
  endA: [number, number];
  endB: [number, number];
};

/** The shared cross-floor badge relocation core (GitHub issue #480), used by both `buildTeleportEdges`
 *  (generation / analytics / post-edit / image export) and `buildPresetTeleportEdges` (presets) so a
 *  badge reads identically whichever path drew it. Given the *complete* list of cross-floor pairs
 *  (order-independent — sorted internally by `key`), returns a `key → world position` map: each pair's
 *  badge is placed on the free cell (see `findBadgeCell`) nearest the snapped midpoint of its two real
 *  endpoints, avoiding the union of its two floors' blocked cells (`blockedCellsByFloor`), any cell an
 *  earlier pair already claimed, and — when `allowOutOfField` is false — any cell outside `fieldCells`.
 *  A pair with nothing free in range maps to its raw snapped midpoint (pre-#480 fallback). The result
 *  does not depend on which floor is being rendered, so a pair's two badges (one per floor) stay
 *  together across a floor switch. */
export function resolveCrossFloorBadgeCells(
  pairs: CrossFloorBadgePair[],
  cfg: TessellationConfig,
  blockedCellsByFloor: Map<number, [number, number][]> | undefined,
  allowOutOfField: boolean,
  fieldCells: [number, number][] | undefined,
): Map<string, [number, number]> {
  const posByPair = new Map<string, [number, number]>();
  if (pairs.length === 0) return posByPair;

  const blockedByFloor = new Map<number, Set<string>>();
  if (blockedCellsByFloor) {
    for (const [level, cells] of blockedCellsByFloor) {
      blockedByFloor.set(level, new Set(cells.map(([x, y]) => cellKey(x, y))));
    }
  }
  const blockedOnFloors = (floors: number[]): Set<string> => {
    const union = new Set<string>();
    for (const f of floors) {
      const set = blockedByFloor.get(f);
      if (set) for (const k of set) union.add(k);
    }
    return union;
  };

  const inField = (() => {
    if (allowOutOfField || !fieldCells || fieldCells.length === 0) return () => true;
    const set = new Set(fieldCells.map(([x, y]) => cellKey(x, y)));
    return (x: number, y: number) => set.has(cellKey(x, y));
  })();

  const ordered = [...pairs].sort((p, q) => (p.key < q.key ? -1 : p.key > q.key ? 1 : 0));
  const takenByBadge = new Set<string>(); // cells claimed by an already-placed badge this pass

  for (const pair of ordered) {
    const blocked = blockedOnFloors(pair.floors);
    const aCenter = getCellCenter(pair.endA[0], pair.endA[1], cfg);
    const bCenter = getCellCenter(pair.endB[0], pair.endB[1], cfg);
    const midX = (aCenter.x + bCenter.x) / 2;
    const midY = (aCenter.y + bCenter.y) / 2;
    const [desiredX, desiredY] = nearestCellCoord(midX, midY, cfg);

    const chosen = findBadgeCell(
      cfg, desiredX, desiredY, aCenter, bCenter,
      (x, y) => {
        const k = cellKey(x, y);
        if (takenByBadge.has(k) || blocked.has(k)) return false;
        return inField(x, y);
      },
    );

    const cell = chosen ?? [desiredX, desiredY];
    if (chosen) takenByBadge.add(cellKey(chosen[0], chosen[1]));
    const c = getCellCenter(cell[0], cell[1], cfg);
    posByPair.set(pair.key, [c.x, c.y]);
  }

  return posByPair;
}

/** Relocates every cross-floor teleport badge (GitHub issue #480) off any cell that already carries
 *  a center marker on either floor the badge's pair connects — start/finish, split junction,
 *  vertical passage, elevator, ordinary teleport marker (see `buildTeleportBadgeBlockedCells`) — or
 *  another badge, so no badge is ever drawn stacked on top of something and hidden. One-way passage
 *  markers are *not* blockers (they sit on cell edges, not centers).
 *
 *  A pair connecting floors A and B avoids the union of A's and B's blocked cells only — a badge on
 *  floors 1↔5 ignores floor 2's markers.
 *
 *  **Floor-independence.** The badge position for a given cross-floor pair must NOT depend on which
 *  floor is currently rendered — otherwise the pair's two ends (one badge shown on floor A, its twin
 *  on floor B) drift apart. So the relocation runs over the *complete* cross-floor pair list rebuilt
 *  from `floorContext.unscopedEdges` (not the floor-scoped `edges`/`result`, whose membership varies
 *  by active floor), producing a `pairKey → world position` map; that map is then applied to whatever
 *  badge edges the current `result` actually contains. Both the pair order (`pairSortKey`) and the
 *  `takenByBadge` accumulation are thus identical for every active floor.
 *
 *  Search order for a displaced badge: cells are visited in expanding neighbor rings around the
 *  originally-desired (snapped-midpoint) cell, and among all free cells found the one closest to the
 *  straight line joining the teleport pair's two real endpoint cells wins (ties broken by distance
 *  back toward the desired cell) — so a badge slides *along* the connector rather than off to one
 *  side. `allowOutOfField: false` additionally rejects any cell outside `fieldCells`. If nothing free
 *  is found within `BADGE_SEARCH_MAX_RINGS`, the badge stays on the raw snapped midpoint (pre-#480
 *  behavior). `edge.from`/`edge.to` is rewritten in place; the connector re-routes to follow it. */
function spreadCrossFloorBadges(
  edges: TeleportEdge[],
  cfg: TessellationConfig,
  floorContext: TeleportFloorContext | undefined,
  blockedCellsByFloor: Map<number, [number, number][]> | undefined,
  allowOutOfField: boolean,
  fieldCells: [number, number][] | undefined,
): void {
  const badges = edges.filter((e) => e.fromFloor !== undefined || e.toFloor !== undefined);
  if (badges.length === 0) return;

  // Only floor-aware callers ever produce a cross-floor badge, so `floorContext` is always present
  // here in practice; bail defensively otherwise.
  const nodeById = floorContext?.unscopedNodeById;
  if (!nodeById) return;
  const resolveLevel = floorContext!.resolveNodeLevel;

  // --- complete cross-floor pair list, rebuilt from unscoped edges (floor-independent) ---
  const pairs = new Map<string, CrossFloorBadgePair>();
  for (const e of floorContext!.unscopedEdges) {
    if (e.kind !== "teleport") continue;
    const fromLevel = resolveLevel(e.from);
    const toLevel = resolveLevel(e.to);
    if (fromLevel === undefined || toLevel === undefined || fromLevel === toLevel) continue;
    const lo = Math.min(e.from, e.to);
    const hi = Math.max(e.from, e.to);
    const key = `${lo.toString().padStart(8, "0")},${hi.toString().padStart(8, "0")}`;
    if (pairs.has(key)) continue;
    const a = nodeById.get(lo);
    const b = nodeById.get(hi);
    if (!a || !b) continue;
    pairs.set(key, { key, floors: [fromLevel, toLevel], endA: [a.x, a.y], endB: [b.x, b.y] });
  }
  if (pairs.size === 0) return;

  const posByPair = resolveCrossFloorBadgeCells(
    [...pairs.values()], cfg, blockedCellsByFloor, allowOutOfField, fieldCells,
  );

  // --- apply the floor-independent map to whatever badge edges this floor's result holds ---
  for (const edge of badges) {
    const pos = posByPair.get(pairSortKey(edge));
    if (!pos) continue;
    const end: "from" | "to" = edge.fromFloor !== undefined ? "from" : "to";
    if (end === "from") edge.from = [pos[0], pos[1]];
    else edge.to = [pos[0], pos[1]];
  }
}

/** Stable pair identity for a cross-floor badge edge — its two node ids sorted, so the same logical
 *  pair sorts to the same key whichever directed edge (or floor) produced it. */
function pairSortKey(e: TeleportEdge): string {
  const a = e.fromNode ?? -1;
  const b = e.toNode ?? -1;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return `${lo.toString().padStart(8, "0")},${hi.toString().padStart(8, "0")}`;
}

/** Breadth-first over expanding neighbor rings from `(desiredX, desiredY)`; returns the free cell
 *  (`isFree`) closest to the infinite line through `lineA`→`lineB` (perpendicular distance dominant,
 *  distance back toward the desired cell as tie-break), or `null` if none is free within
 *  `BADGE_SEARCH_MAX_RINGS`. The desired cell itself is checked first (ring 0). */
function findBadgeCell(
  cfg: TessellationConfig,
  desiredX: number,
  desiredY: number,
  lineA: { x: number; y: number },
  lineB: { x: number; y: number },
  isFree: (x: number, y: number) => boolean,
): [number, number] | null {
  const dirX = lineB.x - lineA.x;
  const dirY = lineB.y - lineA.y;
  const dirLen = Math.hypot(dirX, dirY) || 1;
  const nx = -dirY / dirLen; // unit normal to the endpoint line
  const ny = dirX / dirLen;
  const desiredCenter = getCellCenter(desiredX, desiredY, cfg);

  const score = (x: number, y: number): number => {
    const c = getCellCenter(x, y, cfg);
    const perp = Math.abs((c.x - lineA.x) * nx + (c.y - lineA.y) * ny);
    const back = Math.hypot(c.x - desiredCenter.x, c.y - desiredCenter.y);
    return perp * 1e4 + back;
  };

  const seen = new Set<string>([cellKey(desiredX, desiredY)]);
  let frontier: [number, number][] = [[desiredX, desiredY]];
  for (let ring = 0; ring <= BADGE_SEARCH_MAX_RINGS; ring++) {
    let best: [number, number] | null = null;
    let bestScore = Infinity;
    for (const [x, y] of frontier) {
      if (!isFree(x, y)) continue;
      const s = score(x, y);
      if (s < bestScore) {
        bestScore = s;
        best = [x, y];
      }
    }
    if (best) return best;

    const next: [number, number][] = [];
    for (const [x, y] of frontier) {
      for (const [dx, dy] of getCellNeighborOffsets(cfg, x, y)) {
        const k = cellKey(x + dx, y + dy);
        if (seen.has(k)) continue;
        seen.add(k);
        next.push([x + dx, y + dy]);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return null;
}
