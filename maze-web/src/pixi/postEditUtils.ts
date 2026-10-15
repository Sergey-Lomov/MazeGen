import type { NodeDto, EdgeDto } from "../wasm/types";
import type { PostEditEdge } from "../store/mazeStore";
import { getNeighborData, rotateFaceIndex } from "./tessellationGeometry";
import type { FieldConfig } from "../fieldConfig";
import {
  type PostEditEndpoint, type LogicalCandidate, nodeEndpoint, splitEndpoint, edgeKey, endpointKey, endpointsEqual,
  buildLogicalCandidates, isDecidedPostEditEdge, resolvePartnerForPlacement,
} from "./postEditEndpoint";
import { canCompleteOppositePair, hasCompleteOppositePair, detectSplitSpecialShapeKind, type SplitFaceKind } from "./splitFaceLayout";
import { recordOnLevel } from "./fieldEditUtils";
import type { ResolvedRotateNode, ResolvedSplitEdgeFace } from "../store/postEditCommandTypes";
import type { PostEditCommand } from "../store/postEditCommandTypes";
import { cairoCanonicalFaceOrder } from "./cairoGeometry";

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

/** Computes every geometric-face connection move a split point's nodes would undergo when rotated
 * by one offset index (clockwise/counter-clockwise, per `getNeighborData`'s fixed offset order) —
 * the post-edit counterpart of `rotatePresetSplitPoint` (fieldEditUtils.ts). Each `postEditDraftEdges`
 * Record entry is already a one-directional edge in its own right (a bidirectional passage is two
 * separate entries, `A->B` and `B->A`), so unlike the preset side there's no canonical-order
 * direction field to re-derive — an entry just gets re-keyed to point at the new neighbor, `kind`
 * unchanged.
 *
 * Returns `undefined` if any face that currently carries a connection would land on a neighbor
 * outside the field (rotation must be refused entirely) — the sole caller, `rotateSplitPointNodes`,
 * treats this as "nothing to do".
 *
 * `level` is the 0-based floor index `point` addresses (`undefined` = floor 0, GitHub issue #358)
 * — `nodes` is expected already scoped to that floor by the caller (a same-(x,y) node on another
 * floor must not be picked up as this point's original/neighbor node). */
type RotateMove = { oldKey: string; ep: PostEditEndpoint; otherIsFrom: boolean; newNeighbor: [number, number]; edge: PostEditEdge };

function collectRotateMoves(
  edges: Record<string, PostEditEdge>,
  point: [number, number],
  slotIds: number[],
  direction: 1 | -1,
  cfg: FieldConfig,
  cellSet: Set<string>,
  nodes: NodeDto[],
  level: number | undefined,
): RotateMove[] | undefined {
  const { offsets } = getNeighborData(cfg, point[0], point[1]);
  const n = offsets.length;
  if (n === 0) return [];

  const coordsOf = (ep: PostEditEndpoint): [number, number] | undefined => {
    if (ep.kind === "split") return ep.point;
    const node = nodes.find((n) => n.id === ep.id);
    return node ? [node.x, node.y] : undefined;
  };

  const endpoints: PostEditEndpoint[] = [
    ...(() => {
      const original = nodes.find((n) => n.x === point[0] && n.y === point[1]);
      return original ? [nodeEndpoint(original.id)] : [];
    })(),
    ...slotIds.map((slotId) => splitEndpoint(point, slotId, level)),
  ];

  const moves: RotateMove[] = [];

  for (const ep of endpoints) {
    for (const [key, edge] of Object.entries(edges)) {
      const epIsFrom = endpointsEqual(edge.from, ep);
      const epIsTo = !epIsFrom && endpointsEqual(edge.to, ep);
      if (!epIsFrom && !epIsTo) continue;

      const other = epIsFrom ? edge.to : edge.from;
      const otherCoords = coordsOf(other);
      if (!otherCoords) continue;

      const i = offsets.findIndex(([dx, dy]) => point[0] + dx === otherCoords[0] && point[1] + dy === otherCoords[1]);
      if (i === -1) continue; // not a geometric neighbor of `point` (shouldn't happen for a face edge)

      const j = rotateFaceIndex(cfg, point[0], point[1], i, direction);
      const newNeighbor: [number, number] = [point[0] + offsets[j][0], point[1] + offsets[j][1]];
      // Refuse entirely — not just for a neighbor outside the field, but also for one inside it
      // with no node at all yet (a sparse/partially-populated field can have an empty cell in
      // `cellSet`). `rotateSplitPointNodes`' own `resolveActiveAt` requires a node to exist at the
      // target coordinate before it can resolve WHICH node the moved edge should now point at — if
      // this refusal didn't also check that, the move would still get queued here, its `oldKey`
      // deleted from the scratch copy, and then silently dropped there when `resolveActiveAt`
      // returns `null`, losing the connection instead of refusing the whole rotation.
      if (!cellSet.has(`${newNeighbor[0]},${newNeighbor[1]}`)) return undefined; // boundary — refuse entirely
      if (!nodes.some((n) => n.x === newNeighbor[0] && n.y === newNeighbor[1])) return undefined;

      moves.push({ oldKey: key, ep, otherIsFrom: epIsTo, newNeighbor, edge });
    }
  }
  return moves;
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

/** `endpoint`'s per-face kind at `point`, in `getNeighborData`'s offset order — the standalone,
 * any-point counterpart of `ManageSplitNodesDialog`'s inline `facesOf` (GitHub issue #588),
 * generalized so a caller can compute this for a NEIGHBOR point, not just the dialog's own focused
 * one (needed to detect whether rotating one split point breaks a neighbor's recognized special
 * shape before applying the rotation). A face outside `cellSet` reads as `"wall"` (boundary); one
 * with no real node at the neighbor coordinate also reads as `"wall"` (nothing to connect to). The
 * connected neighbor node is resolved the same way a face click would (`resolvePartnerForPlacement`
 * over the neighbor's own candidates), so a split neighbor's real connected slot is found even when
 * its active UI slot isn't the one wired to `point`. Mirrors `presetSplitNodeFaceKinds`
 * (`fieldEditUtils.ts`) for the preset stage. */
export function postEditSplitNodeFaceKinds(
  endpoint: PostEditEndpoint,
  point: [number, number],
  cfg: FieldConfig,
  cellSet: Set<string>,
  edges: Record<string, PostEditEdge>,
  splitPoints: Record<string, number[]>,
  activeSplitNode: Record<string, PostEditEndpoint>,
  nodes: NodeDto[],
  level?: number,
): SplitFaceKind[] {
  const { offsets } = getNeighborData(cfg, point[0], point[1]);
  const levelSplitPoints = recordOnLevel(splitPoints, level);
  const splitPointsAt = (p: [number, number]) => levelSplitPoints[`${p[0]},${p[1]}`] ?? [];
  return offsets.map(([dx, dy]): SplitFaceKind => {
    const neighbor: [number, number] = [point[0] + dx, point[1] + dy];
    if (!cellSet.has(`${neighbor[0]},${neighbor[1]}`)) return "wall";
    const neighborIds: number[] = [];
    for (const n of nodes) if (n.x === neighbor[0] && n.y === neighbor[1] && (n.level ?? 0) === (level ?? 0)) neighborIds.push(n.id);
    if (neighborIds.length === 0) return "wall";
    const candidates = buildLogicalCandidates(neighbor, neighborIds, splitPointsAt(neighbor), level);
    const resolved = resolvePartnerForPlacement([endpoint], candidates, edges, activeSplitNode, neighbor, level);
    if (!resolved) return "wall";
    const neighborPartner = resolved.endpoint;

    const fwd = edges[edgeKey(endpoint, neighborPartner)];
    const bwd = edges[edgeKey(neighborPartner, endpoint)];
    if (fwd?.kind === "basic" || bwd?.kind === "basic") return "passage";
    if (fwd?.kind === "one_way_forward" || fwd?.kind === "one_way_backward") return "one_way_out";
    if (bwd?.kind === "one_way_forward" || bwd?.kind === "one_way_backward") return "one_way_in";
    return "wall";
  });
}

/** Which of `candidatePoint`'s own geometric face indices (per `getNeighborData(cfg, ...)`'s fixed
 * offset order) already carry a **decided** edge (`basic`/`one_way_forward`/`one_way_backward`),
 * checked against any of the candidate's own forms, in either direction — a `wall` entry does not
 * count (a wall never forms a bridge/diagonal pair with an opposite face, see
 * `canCompleteOppositePair`'s own doc comment). */
function decidedFaceIndicesOf(
  candidatePoint: [number, number],
  candidateForms: PostEditEndpoint[],
  edges: Record<string, PostEditEdge>,
  cfg: FieldConfig,
  nodes: NodeDto[],
): Set<number> {
  const { offsets } = getNeighborData(cfg, candidatePoint[0], candidatePoint[1]);
  const coordsOf = (ep: PostEditEndpoint): [number, number] | undefined => {
    if (ep.kind === "split") return ep.point;
    const node = nodes.find((n) => n.id === ep.id);
    return node ? [node.x, node.y] : undefined;
  };
  const result = new Set<number>();
  for (const e of Object.values(edges)) {
    if (!isDecidedPostEditEdge(e)) continue;
    const fromForm = candidateForms.find((f) => endpointsEqual(f, e.from));
    const toForm = candidateForms.find((f) => endpointsEqual(f, e.to));
    if (!fromForm && !toForm) continue;
    const other = fromForm ? e.to : e.from;
    const otherCoords = coordsOf(other);
    if (!otherCoords) continue;
    const i = offsets.findIndex(([dx, dy]) => candidatePoint[0] + dx === otherCoords[0] && candidatePoint[1] + dy === otherCoords[1]);
    if (i !== -1) result.add(i);
  }
  return result;
}

/** The candidate at `neighborPoint` that already has a DECIDED edge on exactly `targetFace` (toward
 * `point`), if any — this is the neighbor's REAL, already-standing partner on this exact face, not a
 * geometric guess. This is the common case for two adjacent split points wired to each other (e.g.
 * two neighboring "bridge" tiles): rotating one moves a DIFFERENT one of its own nodes onto the face
 * that already connects to the other tile's node — the two nodes were already partners on this
 * shared face before the rotation, and remain so after, just via the rotated point's other node.
 * Must be checked before `selectOppositeFaceOwner`'s geometry guess: the existing partner's own
 * `decidedFaceIndicesOf` already contains `targetFace` (that's the whole reason it's the answer), so
 * `canCompleteOppositePair`'s `!decidedFaces.has(targetFace)` guard would otherwise wrongly exclude
 * it as "already occupied" — it isn't occupied by a THIRD party, it's occupied by the very
 * connection this rotation is re-keying. */
function selectExistingFaceOwner(
  candidates: LogicalCandidate[],
  neighborPoint: [number, number],
  targetFace: number,
  edges: Record<string, PostEditEdge>,
  cfg: FieldConfig,
  nodes: NodeDto[],
): LogicalCandidate | null {
  const matches = candidates.filter((c) => decidedFaceIndicesOf(neighborPoint, c.forms, edges, cfg, nodes).has(targetFace));
  return matches.length === 1 ? matches[0] : null;
}

/** Filters `candidates` to those for which `canCompleteOppositePair` matches `targetFace` — exactly
 * one match is a confident owner; zero or more than one is ambiguous (no real evidence, or
 * conflicting evidence) and the caller must fall back rather than guess further. */
function selectOppositeFaceOwner(
  candidates: LogicalCandidate[],
  neighborPoint: [number, number],
  targetFace: number,
  degree: number,
  edges: Record<string, PostEditEdge>,
  cfg: FieldConfig,
  nodes: NodeDto[],
): LogicalCandidate | null {
  const matches = candidates.filter((c) => canCompleteOppositePair(decidedFaceIndicesOf(neighborPoint, c.forms, edges, cfg, nodes), targetFace, degree));
  return matches.length === 1 ? matches[0] : null;
}

/** Resolves which node of a (possibly split) `newNeighbor` a rotate's brand-new face should connect
 * to — there is no prior edge evidence for this exact face at all (it didn't exist before the
 * rotation moved a connection onto it), so unlike `resolvePartnerForPlacement` the evidence source
 * here is the candidate's OWN decided geometry on its OTHER faces (`selectOppositeFaceOwner`), not a
 * lookup against `point`. Always resolves against the pre-rotation `edges` (the neighbor itself never
 * rotates within this call, so its own face wiring is stable throughout) — `assignedThisRotation`
 * additionally guards against the SAME neighbor node being handed two different new faces within one
 * multi-move rotation (geometry evidence alone can't see the other assignments this same rotation is
 * making), demoting the second one to the fallback path instead of silently reusing the first pick.
 *
 * Before guessing geometrically, this first checks whether `newNeighbor` already has a REAL decided
 * edge standing on exactly `targetFace` (`selectExistingFaceOwner`) — the common case for two
 * adjacent split points wired to each other (e.g. two neighboring "bridge" tiles sharing a face):
 * rotating `point` moves a DIFFERENT one of its own nodes onto the face that already connects to the
 * neighbor's node, so the neighbor's existing partner on that exact face simply carries over,
 * regardless of geometry. The caller (`rotateSplitPointNodes`) is responsible for deleting that old
 * standing edge once this returns it as the owner, same as any other move's old key.
 *
 * A finished bridge/diagonal's new face is geometrically never opposite either of its own 2 existing
 * decided faces (proven for degree 4: the 2 faces NOT in an existing opposite pair are always
 * `circularDist` 1, never `degree/2`, from either member of that pair) — so `selectOppositeFaceOwner`
 * can never fire for an already-complete candidate, and the resolution falls through toward the
 * active/original fallback. Without a further check, that fallback has no notion of "don't disturb an
 * already-finished shape" and can pick exactly that candidate (e.g. because it happens to be active),
 * silently destroying it by giving it an unwanted 3rd decided face. So before falling all the way to
 * active/original, this restricts the fallback to candidates that do NOT already hold a complete
 * opposite pair (a candidate with 0 or 1 decided faces is always safe to extend). If EVERY candidate
 * at `newNeighbor` already holds a finished pair (e.g. rotating a bridge tile onto a neighbor that's
 * itself fully wired on both its own nodes), there is no safe node to hand the new face to at all —
 * picking "the least bad" one would still corrupt it, so this refuses the connection outright
 * (`null`, the face reverts to wall) rather than guess. */
function resolveFaceOwner(
  point: [number, number],
  newNeighbor: [number, number],
  cfg: FieldConfig,
  edges: Record<string, PostEditEdge>,
  nodes: NodeDto[],
  activeSplitNode: Record<string, PostEditEndpoint>,
  assignedThisRotation: Map<number, number>,
  level: number | undefined,
  splitPointsAt: (p: [number, number]) => number[],
): PostEditEndpoint | null {
  const neighborIds: number[] = [];
  for (const n of nodes) if (n.x === newNeighbor[0] && n.y === newNeighbor[1]) neighborIds.push(n.id);
  if (neighborIds.length === 0) return null;
  const neighborSlots = splitPointsAt(newNeighbor);
  const candidates = buildLogicalCandidates(newNeighbor, neighborIds, neighborSlots, level);
  // A candidate's canonical form for writing into `edges`: the `split`-kind form when it's a
  // registered slot of `newNeighbor`, the plain `node` form otherwise — never the raw node id for a
  // slot. `buildLogicalCandidates` already builds both forms per candidate; picking the `split` one
  // here (instead of always `nodeEndpoint(nodeId)`) keeps every edge this function hands back
  // consistent with how `currentSplitNodeFaces`/`facesOf` elsewhere look up that same slot's own
  // faces (by its `split` form), which structural `endpointsEqual` cannot bridge on its own.
  const canonicalFormOf = (nodeId: number): PostEditEndpoint => {
    const candidate = candidates.find((c) => c.nodeId === nodeId);
    return candidate?.forms.find((f) => f.kind === "split") ?? nodeEndpoint(nodeId);
  };

  const { offsets: neighborOffsets } = getNeighborData(cfg, newNeighbor[0], newNeighbor[1]);
  const degree = neighborOffsets.length;
  const targetFace = neighborOffsets.findIndex(([dx, dy]) => newNeighbor[0] + dx === point[0] && newNeighbor[1] + dy === point[1]);

  if (targetFace !== -1) {
    const existing = selectExistingFaceOwner(candidates, newNeighbor, targetFace, edges, cfg, nodes);
    if (existing) return canonicalFormOf(existing.nodeId);

    const owner = selectOppositeFaceOwner(candidates, newNeighbor, targetFace, degree, edges, cfg, nodes);
    if (owner && assignedThisRotation.get(owner.nodeId) === undefined) {
      assignedThisRotation.set(owner.nodeId, targetFace);
      return canonicalFormOf(owner.nodeId);
    }
  }

  const pointKey = (p: [number, number]) => level === undefined ? `${p[0]},${p[1]}` : `${p[0]},${p[1]}@${level}`;
  const active = activeSplitNode[pointKey(newNeighbor)];
  const safeCandidates = candidates.filter((c) => !hasCompleteOppositePair(decidedFaceIndicesOf(newNeighbor, c.forms, edges, cfg, nodes), degree));
  // Every candidate already holds a finished opposite pair — there is no safe node to hand this new
  // face to at all, not even "the least bad" one (that would still corrupt whichever candidate gets
  // picked). Refuse the new connection outright (the face reverts to wall) rather than guess.
  if (safeCandidates.length === 0) return null;

  if (active) {
    const match = safeCandidates.find((c) => c.forms.some((f) => endpointsEqual(f, active)));
    if (match) return canonicalFormOf(match.nodeId);
    // Active matched none of the safe candidates — either it's genuinely unresolved (no candidate
    // at all matches it), or it names exactly one of the unsafe (finished-pair) candidates `safe-
    // Candidates` excluded. A safe alternative takes priority over disturbing a finished shape; a
    // genuinely unresolved active is returned as-is, same as everywhere else.
    const activeMatchesUnsafe = candidates.some((c) => c.forms.some((f) => endpointsEqual(f, active)));
    if (activeMatchesUnsafe) return canonicalFormOf(safeCandidates[0].nodeId);
    return active;
  }
  return canonicalFormOf(safeCandidates[0].nodeId);
}

/** Resolves a `rotateSplitPoint` command's `nodes` — every one of `point`'s own nodes' (original
 * plus each numbered slot) COMPLETE post-rotation face list, not a diff (GitHub issue #548
 * compaction follow-up: `updateSplitNodeFaces`/`applySplitBlueprint` already carry a full snapshot,
 * so every split command that can recur against the same node is now uniformly a snapshot — a
 * diff-shaped command can't be safely dropped by compaction when an earlier command in the same log
 * is superseded, since the diff was resolved relative to a state that earlier command helped
 * produce). Computed by applying `collectRotateMoves`' raw re-key list to a scratch copy of `edges`,
 * then reading each node's resulting wiring back via `currentSplitNodeFaces` — replay has no
 * tessellation/field access (`PostEditReplayContext` is identity-only), so this resolution only
 * happens once, here, at construction time. Returns `[]` if the rotation must be refused (a moved
 * connection would land outside the field) — the caller treats an empty node list as "nothing to
 * do", same as the old diff-shaped `moves` convention. */
export function rotateSplitPointNodes(
  edges: Record<string, PostEditEdge>,
  point: [number, number],
  slotIds: number[],
  direction: 1 | -1,
  cfg: FieldConfig,
  cellSet: Set<string>,
  nodes: NodeDto[],
  activeSplitNode: Record<string, PostEditEndpoint>,
  splitPoints: Record<string, number[]>,
  level?: number,
): ResolvedRotateNode[] {
  const moves = collectRotateMoves(edges, point, slotIds, direction, cfg, cellSet, nodes, level);
  if (moves === undefined || moves.length === 0) return [];

  const levelSplitPoints = recordOnLevel(splitPoints, level);
  const splitPointsAt = (p: [number, number]) => levelSplitPoints[`${p[0]},${p[1]}`] ?? [];
  const coordsOf = (ep: PostEditEndpoint): [number, number] | undefined => {
    if (ep.kind === "split") return ep.point;
    const node = nodes.find((n) => n.id === ep.id);
    return node ? [node.x, node.y] : undefined;
  };
  // Tracks which neighbor node geometry-evidence has already assigned a new face to WITHIN this
  // rotation call — always resolved against the immutable pre-rotation `edges` (the neighbor itself
  // never rotates here, so its own geometry is stable throughout), so two different new faces in the
  // same multi-move rotation could otherwise both match the same neighbor node; the second one falls
  // back instead of silently reusing the first pick (see `resolveFaceOwner`'s doc comment).
  const assignedThisRotation = new Map<number, number>();

  // Apply every move to a scratch copy of `edges` first — same re-keying replay itself performs —
  // so the node-face snapshots read back below reflect the ROTATED wiring, not the pre-rotation one.
  const rotated = { ...edges };
  for (const { oldKey } of moves) delete rotated[oldKey];

  // Every one of `point`'s own forms (original + every slot) — a `newOther` resolved via
  // `selectExistingFaceOwner` may already have a standing edge toward ANY of them (not necessarily
  // the specific `ep` this move is re-keying), since the two neighbors were already partners on this
  // shared face before the rotation. Resolve every move's owner and drop those standing edges FIRST,
  // in one pass, before any rotated edge is written — doing the delete inside the same loop that
  // writes would wipe out an earlier move's freshly-written edge whenever two moves (e.g. a
  // bidirectional passage's two directed Record entries) resolve to the same owner.
  const pointForms: PostEditEndpoint[] = [
    ...(() => { const o = nodes.find((n) => n.x === point[0] && n.y === point[1]); return o ? [nodeEndpoint(o.id)] : []; })(),
    ...slotIds.map((slotId) => splitEndpoint(point, slotId, level)),
  ];
  const resolvedOwners = moves.map((m) => resolveFaceOwner(point, m.newNeighbor, cfg, edges, nodes, activeSplitNode, assignedThisRotation, level, splitPointsAt));
  for (const newOther of resolvedOwners) {
    if (!newOther) continue;
    for (const pf of pointForms) {
      delete rotated[edgeKey(newOther, pf)];
      delete rotated[edgeKey(pf, newOther)];
    }
  }

  // An old neighbor node that ISN'T picked up as `ep`'s new-face owner this rotation loses its
  // partner on the face that used to point at `point`. When that old neighbor is itself split (has
  // more than one declared node at its point), leaving the face merely absent reads as an
  // undecided/optional face in the UI and silently turns one of its OTHER, unrelated decided faces
  // into part of an incomplete/broken bridge shape — so this must become an explicit wall edge
  // instead (mirrors preset's `rotatePresetSplitPoint` fix for the same bug). A plain (non-split)
  // old neighbor has nothing else to protect, so it keeps the old "just vanish" behavior.
  const rewrittenPairKeys = new Set(moves.map(({ ep }, i) => {
    const newOther = resolvedOwners[i];
    return newOther ? `${edgeKey(newOther, ep)}|${edgeKey(ep, newOther)}` : null;
  }).filter((k): k is string => k !== null));
  moves.forEach(({ ep, otherIsFrom, edge }) => {
    const other = otherIsFrom ? edge.from : edge.to;
    const pairKey = `${edgeKey(other, ep)}|${edgeKey(ep, other)}`;
    if (rewrittenPairKeys.has(pairKey)) return;
    const otherCoords = coordsOf(other);
    if (!otherCoords) return;
    if (splitPointsAt(otherCoords).length === 0) return; // plain neighbor — nothing else to protect
    const from = otherIsFrom ? other : ep;
    const to = otherIsFrom ? ep : other;
    rotated[edgeKey(from, to)] = { kind: "wall", from, to };
  });

  moves.forEach(({ ep, otherIsFrom, edge }, i) => {
    const newOther = resolvedOwners[i];
    if (!newOther) return;
    const from = otherIsFrom ? newOther : ep;
    const to = otherIsFrom ? ep : newOther;
    // `edge.kind === "wall" || edge.kind === "basic"` would not narrow here — TS doesn't narrow a
    // discriminated union via `===` against an already-union-typed discriminant field, only via
    // exact single-literal checks — so branch on the one-way member instead.
    const movedEdge: PostEditEdge = { kind: edge.kind, from, to };
    rotated[edgeKey(from, to)] = movedEdge;
  });

  const original = nodes.find((n) => n.x === point[0] && n.y === point[1]);
  const result: ResolvedRotateNode[] = [];
  if (original) result.push({ slotId: undefined, faces: currentSplitNodeFaces(rotated, nodeEndpoint(original.id)) });
  for (const slotId of slotIds) {
    result.push({ slotId, faces: currentSplitNodeFaces(rotated, splitEndpoint(point, slotId, level)) });
  }
  return result;
}

/** `nodes` filtered to `point`/`level`, indexed the same way a split point's own node list is
 * ordered elsewhere (original node first). Shared by `postEditReplay.ts`'s `"rotateSplitPoint"`
 * (and other) replay cases and `applyRotatedNodesToEdges` below, so both resolve a point's
 * original node identically (level-scoped — a same-coordinate node on another level is never a
 * match). */
export function nodeAt(nodes: NodeDto[], point: [number, number], level: number | undefined, index: number): NodeDto | undefined {
  const levelNodes = nodes.filter((n) => n.x === point[0] && n.y === point[1] && (n.level ?? 0) === (level ?? 0));
  return levelNodes[index];
}

/** Rebuilds the edges map a `rotateSplitPoint` command's replay would produce (`postEditReplay.ts`'s
 * `"rotateSplitPoint"` case) from `rotateSplitPointNodes`' own resolved-node snapshot — every edge
 * referencing one of `point`'s own nodes is dropped first, then each resolved node's full post-
 * rotation face list (including any wall-compensation edge written onto an old split neighbor,
 * see `rotateSplitPointNodes`' doc comment) is written back. Shared by the real replay path
 * (`postEditReplay.ts` calls this instead of duplicating the loop) and
 * `rotateSplitPointBreaksNeighborShape`'s dry run below, so the three can never disagree on what a
 * rotation actually produces. Returns `undefined` if a resolved node claims to be the point's
 * original (undecided `slotId`) but `nodes` has none at `point`/`level` — mirrors replay's own
 * `fail(state)` case; callers that aren't a command replay (the dry run below) treat this the same
 * as "rotation is a no-op". */
export function applyRotatedNodesToEdges(
  edges: Record<string, PostEditEdge>,
  point: [number, number],
  level: number | undefined,
  nodes: NodeDto[],
  rotatedNodes: ResolvedRotateNode[],
): Record<string, PostEditEdge> | undefined {
  const targets: PostEditEndpoint[] = [];
  for (const rotatedNode of rotatedNodes) {
    if (rotatedNode.slotId === undefined) {
      const original = nodeAt(nodes, point, level, 0);
      if (original === undefined) return undefined;
      targets.push(nodeEndpoint(original.id));
    } else {
      targets.push(splitEndpoint(point, rotatedNode.slotId, level));
    }
  }
  const refsAnyTarget = (e: { from: PostEditEndpoint; to: PostEditEndpoint }) =>
    targets.some((target) => endpointsEqual(e.from, target) || endpointsEqual(e.to, target));
  const next = Object.fromEntries(Object.entries(edges).filter(([, e]) => !refsAnyTarget(e)));
  rotatedNodes.forEach((rotatedNode, i) => {
    const target = targets[i];
    for (const face of rotatedNode.faces) {
      const toKey = edgeKey(target, face.neighbor);
      const fromKey = edgeKey(face.neighbor, target);
      if (face.toNeighbor.kind === "wall") delete next[toKey]; else next[toKey] = face.toNeighbor;
      if (face.fromNeighbor.kind === "wall") delete next[fromKey]; else next[fromKey] = face.fromNeighbor;
    }
  });
  return next;
}

/** True if rotating `point`'s split nodes by `direction` would make a currently-recognized special
 * shape (bridge/diagonal/etc., `detectSplitSpecialShapeKind`) at one of `point`'s geometric
 * neighbors unrecognized (GitHub issue #588) — dry-runs the rotation (`rotateSplitPointNodes` is
 * pure) and compares each split neighbor's own `faceKindsByNode` before/after via
 * `postEditSplitNodeFaceKinds`. Only `point`'s immediate geometric neighbors can possibly be
 * affected — a rotation only ever re-keys edges touching `point`'s own nodes. A neighbor that isn't
 * itself split (fewer than 2 declared nodes), or wasn't recognized before the rotation, is never a
 * "break" regardless of what happens to it after. */
export function rotateSplitPointBreaksNeighborShape(
  edges: Record<string, PostEditEdge>,
  point: [number, number],
  slotIds: number[],
  direction: 1 | -1,
  cfg: FieldConfig,
  cellSet: Set<string>,
  nodes: NodeDto[],
  activeSplitNode: Record<string, PostEditEndpoint>,
  splitPoints: Record<string, number[]>,
  level?: number,
): boolean {
  const rotatedNodes = rotateSplitPointNodes(edges, point, slotIds, direction, cfg, cellSet, nodes, activeSplitNode, splitPoints, level);
  if (rotatedNodes.length === 0) return false;
  const after = applyRotatedNodesToEdges(edges, point, level, nodes, rotatedNodes);
  if (after === undefined) return false; // rotation couldn't resolve its own original node — same as a no-op

  const { offsets } = getNeighborData(cfg, point[0], point[1]);
  const levelSplitPoints = recordOnLevel(splitPoints, level);
  for (const [dx, dy] of offsets) {
    const neighbor: [number, number] = [point[0] + dx, point[1] + dy];
    const neighborSlots = levelSplitPoints[`${neighbor[0]},${neighbor[1]}`] ?? [];
    const neighborOriginal = nodeAt(nodes, neighbor, level, 0);
    const neighborEndpoints: PostEditEndpoint[] = [
      ...(neighborOriginal ? [nodeEndpoint(neighborOriginal.id)] : []),
      ...neighborSlots.map((slotId) => splitEndpoint(neighbor, slotId, level)),
    ];
    if (neighborEndpoints.length < 2) continue; // not split — nothing to break

    const before = neighborEndpoints.map((ep) => postEditSplitNodeFaceKinds(ep, neighbor, cfg, cellSet, edges, splitPoints, activeSplitNode, nodes, level));
    const canonicalOrder = cfg.tessellation.kind === "cairo" ? cairoCanonicalFaceOrder(neighbor[0], neighbor[1]) : undefined;
    const beforeKind = detectSplitSpecialShapeKind(before, canonicalOrder);
    if (beforeKind === null) continue; // wasn't recognized before — nothing to break

    const afterKinds = neighborEndpoints.map((ep) => postEditSplitNodeFaceKinds(ep, neighbor, cfg, cellSet, after, splitPoints, activeSplitNode, nodes, level));
    if (detectSplitSpecialShapeKind(afterKinds, canonicalOrder) === null) return true;
  }
  return false;
}
