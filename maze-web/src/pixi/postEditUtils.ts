import type { NodeDto, EdgeDto } from "../wasm/types";
import type { PostEditEdge } from "../store/mazeStore";
import {
  type PostEditEndpoint, nodeEndpoint, edgeKey, endpointKey, endpointsEqual,
} from "./postEditEndpoint";
import type { ResolvedSplitEdgeFace } from "../store/postEditCommandTypes";
import type { PostEditCommand } from "../store/postEditCommandTypes";

export {
  extractPostEditTeleports,
  postEditTeleportsToDto,
  floorScopedTeleportEdges,
  cyclePostEditTeleportDirection,
  removePostEditTeleport,
  movePostEditTeleportEndpoint,
  pickPostEditTeleportEndpointAt,
} from "./postEditTeleportUtils";

export {
  pickPostEditVerticalPassageEndpointAt,
  pickPostEditElevatorEndpointAt,
  cyclePostEditVerticalPassageDirection,
  removePostEditVerticalPassage,
  movePostEditVerticalPassageEndpoint,
  resolveVerticalPassageMove,
  removePostEditElevator,
  movePostEditElevatorEndpoint,
  resolveElevatorMove,
  elevatorComponent,
  extractPostEditVerticalPassages,
  extractPostEditElevators,
  postEditVerticalPassageDirectionToDto,
  postEditVerticalToDto,
} from "./postEditVerticalUtils";

/** Assigns stable, deterministic ids to a batch of logical entities (GitHub issue #564) — sorts by
 * `key` (a canonical, order-of-extraction-independent string, never a raw array/iteration index —
 * see `extractPostEditVerticalPassages`/`extractPostEditElevators`/one-way baseline extraction
 * below) and numbers from 1. Two calls with the same `key` set, regardless of input order, always
 * produce the same `key -> id` mapping — the property the "shuffled input" determinism tests check.
 * Called separately per entity category (one-way, split point, vertical passage, elevator) — each
 * has its own independent id namespace/counter, never shared across categories. */
export function assignSequentialIds(items: { key: string }[]): Map<string, number> {
  const sortedKeys = items.map((i) => i.key).sort();
  const result = new Map<string, number>();
  let nextId = 1;
  for (const key of sortedKeys) result.set(key, nextId++);
  return result;
}

/** Built from a freshly confirmed WASM snapshot. `endpointFor` (see `resolverForNodeId`) resolves
 * each raw id to a `split` endpoint when it's one of a point's automatically-split extra nodes
 * (GitHub issue #222), or a plain `node` endpoint otherwise — never a not-yet-confirmed split
 * node, since every id here already exists in the snapshot. Defaults to `nodeEndpoint` for callers
 * that predate auto-split (no split points possible, so it's always the identity resolution).
 */
export function buildPostEditDraftEdgesFromGenerated(
  edges: EdgeDto[],
  endpointFor: (id: number) => PostEditEndpoint = nodeEndpoint,
): Record<string, PostEditEdge> {
  const basicEdges = edges.filter(e => e.kind !== "teleport" && e.kind !== "vertical_passage" && e.kind !== "elevator");
  const edgeSet = new Set(basicEdges.map(e => `${e.from}-${e.to}`));
  const entries: { key: string; from: PostEditEndpoint; to: PostEditEndpoint; oneWay: boolean }[] = [];
  for (const e of basicEdges) {
    const hasReverse = edgeSet.has(`${e.to}-${e.from}`);
    const from = endpointFor(e.from);
    const to = endpointFor(e.to);
    entries.push({ key: edgeKey(from, to), from, to, oneWay: !hasReverse });
  }
  const result: Record<string, PostEditEdge> = {};
  for (const e of entries) {
    result[e.key] = e.oneWay
      ? { from: e.from, to: e.to, kind: "one_way_forward" }
      : { from: e.from, to: e.to, kind: "basic" };
  }
  return result;
}

/** Drops a node whose split slot has been removed client-side (`removeSplitNode`/
 * `resetPostEditPoint`) but not yet reflected in `nodes` itself — `state.nodes` is only ever
 * replaced wholesale by a `confirmPostEdit` response (`nodes: snapshot.nodes`), so a slot removed
 * on the draft still has a stale `NodeDto` sitting in `nodes` until the next confirm lands. A node
 * survives if it's the point's original (`i === 0`), or its slotId (`i - 1`) is still declared in
 * `splitPoints` under `pointKey(n)`. Shared by `postEditSlice.ts`'s `prunedNodes` (what gets sent
 * to WASM as `cfg.nodes`, keyed multi-floor with an `"@level"` suffix) and
 * `PostEditRenderer.floorScoped` (what gets grouped into split points for drawing, keyed bare
 * `"x,y"` since its `splitPoints` is already floor-scoped) — the two must never drift, since a
 * removed-but-unconfirmed split node's own graph state and its on-canvas split-ness are the same
 * underlying fact (GitHub issue #388). `pointKey` lets each caller supply its own key convention. */
export function pruneRemovedSplitNodes<T extends { x: number; y: number; i: number }>(
  nodes: T[],
  splitPoints: Record<string, number[]>,
  pointKey: (n: T) => string = (n) => `${n.x},${n.y}`,
): T[] {
  return nodes.filter((n) => {
    if (n.i === 0) return true;
    const slots = splitPoints[pointKey(n)];
    return slots !== undefined && slots.includes(n.i - 1);
  });
}

/** Every face currently wired on `target` (a split node's own endpoint), read from live
 * `postEditDraftEdges` and grouped one entry per distinct neighbor — the starting point
 * `applyPostEditToolAt` upserts a single clicked face into before re-emitting the slot's full
 * `updateSplitNodeFaces` list (GitHub issue #545), and `rotateSplitPointNodes` below reads back
 * after applying a rotation's moves to build `rotateSplitPoint`'s own full-node snapshot (GitHub
 * issue #548 compaction follow-up). A neighbor with no edge at all in either direction never
 * appears here (both directions read back as `"wall"`, so there is nothing to record) — same
 * "absence is wall" convention every other post-edit edge lookup uses. */
export function currentSplitNodeFaces(edges: Record<string, PostEditEdge>, target: PostEditEndpoint): ResolvedSplitEdgeFace[] {
  const byNeighbor = new Map<string, ResolvedSplitEdgeFace>();
  for (const e of Object.values(edges)) {
    const isFrom = endpointsEqual(e.from, target);
    const isTo = endpointsEqual(e.to, target);
    if (!isFrom && !isTo) continue;
    const neighbor = isFrom ? e.to : e.from;
    const nKey = edgeKey(neighbor, target);
    const face = byNeighbor.get(nKey) ?? {
      neighbor,
      toNeighbor: { kind: "wall" as const, from: target, to: neighbor },
      fromNeighbor: { kind: "wall" as const, from: neighbor, to: target },
    };
    if (isFrom) face.toNeighbor = e; else face.fromNeighbor = e;
    byNeighbor.set(nKey, face);
  }
  return [...byNeighbor.values()];
}

/** `ep`'s own field coordinates/level — a `split` endpoint already carries them directly, a `node`
 * endpoint is looked up in `nodes`. `undefined` if a `node` endpoint doesn't resolve (stale/removed
 * id). Used to find which POINT a face's neighbor belongs to, e.g. to check whether that point is
 * currently split. */
export function endpointFieldPoint(
  nodes: NodeDto[],
  ep: PostEditEndpoint,
): { point: [number, number]; level?: number } | undefined {
  if (ep.kind === "split") return { point: ep.point, level: ep.level };
  const node = nodes.find((n) => n.id === ep.id);
  if (!node) return undefined;
  // `NodeDto.level` is a plain `number`, always `0` (never `undefined`) for a single-floor maze —
  // but `PostEditEndpoint`'s own `level` convention (and every `pointKeyOf`-style point key built
  // from it) uses `undefined` to MEAN level 0 (GitHub issue #625: a raw `node.level` of `0` passed
  // through here built a "x,y@0" key that never matched the "x,y" key `splitPoints`/`splitPointIds`
  // actually use for level 0, so a level-0 neighbor was silently never recognized as split at all).
  // Normalize the same way `(level ?? 0) === (level ?? 0)` comparisons already do elsewhere in this
  // file, so callers can key straight off the result without re-deriving this themselves.
  return { point: [node.x, node.y], level: node.level === 0 ? undefined : node.level };
}

/** Builds the face list a whole-split-point removal (`removeSplitPoint`) restores onto the point's
 * original node once every slot is gone (GitHub issue #625) — `originalEndpoint`'s own generation-
 * time wiring (`baselineEdges`, read via `currentSplitNodeFaces`) for every neighbor that is NOT
 * currently split, but the point's own LIVE connection (`liveEdges`, read from every one of
 * `pointForms` — the original node plus every slot about to be removed) redirected onto
 * `originalEndpoint` for every neighbor that IS currently split.
 *
 * Un-splitting a point must never leave a still-split neighbor with a face pointing at a node that's
 * about to disappear (GitHub issue #625) — whichever of this point's own nodes (original or any
 * slot) actually held that connection, the survivor (`originalEndpoint`) inherits it, kind and
 * direction unchanged, instead of the connection reverting to whatever generation had wired there
 * (typically a wall, since the bridge was itself created in post-edit, after generation ran). A
 * neighbor that isn't currently split has no shape to preserve, so its generation-time face is
 * restored as before — this only special-cases the "neighbor is itself a split" case the plain
 * baseline restore used to ignore. */
export function buildRestoredOriginalFaces(
  nodes: NodeDto[],
  baselineEdges: Record<string, PostEditEdge>,
  liveEdges: Record<string, PostEditEdge>,
  liveSplitPoints: Record<string, number[]>,
  originalEndpoint: PostEditEndpoint,
  pointForms: PostEditEndpoint[],
): ResolvedSplitEdgeFace[] {
  const isCurrentlySplit = (ep: PostEditEndpoint): boolean => {
    const coords = endpointFieldPoint(nodes, ep);
    if (!coords) return false;
    const key = coords.level === undefined ? `${coords.point[0]},${coords.point[1]}` : `${coords.point[0]},${coords.point[1]}@${coords.level}`;
    return (liveSplitPoints[key] ?? []).length > 0;
  };

  const baselineFaces = currentSplitNodeFaces(baselineEdges, originalEndpoint);
  const byNeighborKey = new Map<string, ResolvedSplitEdgeFace>();
  for (const face of baselineFaces) {
    if (!isCurrentlySplit(face.neighbor)) byNeighborKey.set(edgeKey(originalEndpoint, face.neighbor), face);
  }

  // Live faces from every one of this point's own nodes, redirected onto `originalEndpoint` —
  // whichever node actually held the connection to a still-split neighbor, that connection survives.
  for (const form of pointForms) {
    for (const face of currentSplitNodeFaces(liveEdges, form)) {
      if (!isCurrentlySplit(face.neighbor)) continue;
      const key = edgeKey(originalEndpoint, face.neighbor);
      const redirected: ResolvedSplitEdgeFace = {
        neighbor: face.neighbor,
        toNeighbor: { ...face.toNeighbor, from: originalEndpoint, to: face.neighbor },
        fromNeighbor: { ...face.fromNeighbor, from: face.neighbor, to: originalEndpoint },
      };
      byNeighborKey.set(key, redirected);
    }
  }

  return [...byNeighborKey.values()];
}

/** Builds the `updateSplitNodeFaces` command(s) needed to redirect a still-split NEIGHBOR's own
 * face away from one of `point`'s about-to-vanish forms (`vanishingForms`) onto `originalEndpoint`
 * instead (GitHub issue #625) — the counterpart to `buildRestoredOriginalFaces`, which only rewrites
 * `point`'s OWN edges map. A neighbor's shape is recorded in ITS OWN log commands (`addSplitNode`'s
 * sibling `updateSplitNodeFaces`/`applySplitBlueprint`), not derivable from `point`'s edges alone —
 * simply cascading/removing `point`'s own commands leaves the neighbor's command sitting there
 * unchanged, its `faces` still naming a node that's about to stop existing (whether or not `point`
 * itself ends up fully un-split — a NON-generation-baked slot's own cascade removes only that one
 * slot's commands, never touching a neighbor's).
 *
 * One command per affected neighbor point, each carrying that neighbor's OWN complete post-redirect
 * face list (`currentSplitNodeFaces` read against `liveEdges`, same full-snapshot shape every other
 * split face command carries) — never a partial patch, so compaction's existing per-lifeline
 * supersession rules apply unchanged. `slotId: undefined` when the neighbor's OWN connecting node is
 * its original node (same "undefined addresses the original" convention every other split command
 * uses). Returns one command per distinct neighbor point among `vanishingForms`' current live
 * neighbors that is itself currently split — a neighbor that isn't split is already fully handled by
 * `buildRestoredOriginalFaces`'s ordinary baseline-vs-live merge on `point`'s own side. */
export function buildNeighborRedirectCommands(
  nodes: NodeDto[],
  liveEdges: Record<string, PostEditEdge>,
  liveSplitPoints: Record<string, number[]>,
  liveSplitPointIds: Record<string, string>,
  originalEndpoint: PostEditEndpoint,
  vanishingForms: PostEditEndpoint[],
): PostEditCommand[] {
  const pointKeyOf = (p: [number, number], lvl?: number) => lvl === undefined ? `${p[0]},${p[1]}` : `${p[0]},${p[1]}@${lvl}`;
  const isCurrentlySplit = (ep: PostEditEndpoint): { point: [number, number]; level?: number; key: string } | undefined => {
    const coords = endpointFieldPoint(nodes, ep);
    if (!coords) return undefined;
    const key = pointKeyOf(coords.point, coords.level);
    return (liveSplitPoints[key] ?? []).length > 0 ? { ...coords, key } : undefined;
  };

  // One entry per affected neighbor ENDPOINT (not per neighbor point) — a split neighbor point can
  // have SEVERAL of its own nodes (original node plus any of its slots) each independently facing
  // `point`, and only some of them may actually hold a live connection to a vanishing form while
  // others already show a wall on that same face (GitHub issue #625: collapsing to one entry per
  // POINT here previously let a later, wall-holding node silently overwrite an earlier, live-
  // connection-holding one in the map, dropping the live connection's own redirect entirely).
  const affectedNeighbors = new Map<string, PostEditEndpoint>();
  for (const form of vanishingForms) {
    const faces = currentSplitNodeFaces(liveEdges, form);
    for (const face of faces) {
      const neighborPoint = isCurrentlySplit(face.neighbor);
      if (!neighborPoint) continue;
      affectedNeighbors.set(endpointKey(face.neighbor), face.neighbor);
    }
  }

  const commands: PostEditCommand[] = [];
  for (const [, neighborEndpoint] of affectedNeighbors) {
    const coords = endpointFieldPoint(nodes, neighborEndpoint);
    if (!coords) continue;
    const neighborKey = pointKeyOf(coords.point, coords.level);
    const pointId = liveSplitPointIds[neighborKey];
    if (pointId === undefined) continue;
    // Redirect the neighbor's own face (currently naming one of `vanishingForms`) onto
    // `originalEndpoint` before reading the neighbor's full face list back — `currentSplitNodeFaces`
    // only sees what's actually keyed in `edges`, so the vanishing endpoint's own key must be
    // rewritten first, on a scratch copy, rather than trying to patch the read-back snapshot.
    const scratch = { ...liveEdges };
    for (const [k, e] of Object.entries(liveEdges)) {
      const isFrom = endpointsEqual(e.from, neighborEndpoint);
      const isTo = endpointsEqual(e.to, neighborEndpoint);
      if (!isFrom && !isTo) continue;
      const other = isFrom ? e.to : e.from;
      if (!vanishingForms.some((f) => endpointsEqual(f, other))) continue;
      delete scratch[k];
      const redirected: PostEditEdge = isFrom
        ? { ...e, to: originalEndpoint }
        : { ...e, from: originalEndpoint };
      scratch[edgeKey(redirected.from, redirected.to)] = redirected;
    }
    const faces = currentSplitNodeFaces(scratch, neighborEndpoint);
    commands.push({
      kind: "updateSplitNodeFaces",
      point: coords.point,
      level: coords.level,
      slotId: neighborEndpoint.kind === "split" ? neighborEndpoint.slotId : undefined,
      pointId,
      faces,
    });
  }
  return commands;
}

