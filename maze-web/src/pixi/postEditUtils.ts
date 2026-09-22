import type { NodeDto, EdgeDto } from "../wasm/types";
import type { PostEditEdge } from "../store/mazeStore";
import { getNeighborData } from "./tessellationGeometry";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { type PostEditEndpoint, nodeEndpoint, splitEndpoint, edgeKey, endpointsEqual } from "./postEditEndpoint";
import { formatPostEditId } from "./postEditIdFormat";
import type { ResolvedRotateNode, ResolvedSplitEdgeFace } from "../store/postEditCommandTypes";

export {
  extractPostEditTeleports,
  postEditTeleportsToDto,
  cyclePostEditTeleportDirection,
  removePostEditTeleport,
  movePostEditTeleportEndpoint,
  pickPostEditTeleportEndpointAt,
} from "./postEditTeleportUtils";

export {
  pickPostEditVerticalPassageEndpointAt,
  pickPostEditElevatorEndpointAt,
  findPostEditVerticalPassageForPair,
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
 *
 * One-way edges get a stable id (GitHub issue #564), assigned deterministically by
 * `assignSequentialIds` over each one-way edge's own canonical `edgeKey(from, to)` — already
 * directional (forward/backward on the same face sort to different keys), so no extra direction
 * component is needed in the key. */
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
  const oneWayIds = assignSequentialIds(entries.filter((e) => e.oneWay).map((e) => ({ key: e.key })));
  const result: Record<string, PostEditEdge> = {};
  for (const e of entries) {
    // Provisional id, same as `extractPostEditTeleports`' own — `buildMultiFloorPostEditDraft`
    // renumbers every one-way edge globally after merging all per-level batches.
    result[e.key] = e.oneWay
      ? { from: e.from, to: e.to, kind: "one_way_forward", id: formatPostEditId("oneWay", oneWayIds.get(e.key)!) }
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
  cfg: TessellationConfig,
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

      const j = (i + direction + n) % n;
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
  cfg: TessellationConfig,
  cellSet: Set<string>,
  nodes: NodeDto[],
  activeSplitNode: Record<string, PostEditEndpoint>,
  level?: number,
): ResolvedRotateNode[] {
  const moves = collectRotateMoves(edges, point, slotIds, direction, cfg, cellSet, nodes, level);
  if (moves === undefined || moves.length === 0) return [];

  const pointKey = (p: [number, number]) => level === undefined ? `${p[0]},${p[1]}` : `${p[0]},${p[1]}@${level}`;
  const resolveActiveAt = (p: [number, number]): PostEditEndpoint | null => {
    const ids: number[] = [];
    for (const node of nodes) if (node.x === p[0] && node.y === p[1]) ids.push(node.id);
    if (ids.length === 0) return null;
    const activeEntry = activeSplitNode[pointKey(p)];
    return activeEntry ?? nodeEndpoint(ids[0]);
  };

  // Apply every move to a scratch copy of `edges` first — same re-keying replay itself performs —
  // so the node-face snapshots read back below reflect the ROTATED wiring, not the pre-rotation one.
  const rotated = { ...edges };
  for (const { oldKey } of moves) delete rotated[oldKey];
  for (const { ep, otherIsFrom, newNeighbor, edge } of moves) {
    const newOther = resolveActiveAt(newNeighbor);
    if (!newOther) continue;
    const from = otherIsFrom ? newOther : ep;
    const to = otherIsFrom ? ep : newOther;
    // `edge.kind === "wall" || edge.kind === "basic"` would not narrow here — TS doesn't narrow a
    // discriminated union via `===` against an already-union-typed discriminant field, only via
    // exact single-literal checks — so branch on the one-way member instead.
    const movedEdge: PostEditEdge = edge.kind === "one_way_forward" || edge.kind === "one_way_backward"
      ? { kind: edge.kind, from, to, id: edge.id }
      : { kind: edge.kind, from, to };
    rotated[edgeKey(from, to)] = movedEdge;
  }

  const original = nodes.find((n) => n.x === point[0] && n.y === point[1]);
  const result: ResolvedRotateNode[] = [];
  if (original) result.push({ slotId: undefined, faces: currentSplitNodeFaces(rotated, nodeEndpoint(original.id)) });
  for (const slotId of slotIds) {
    result.push({ slotId, faces: currentSplitNodeFaces(rotated, splitEndpoint(point, slotId, level)) });
  }
  return result;
}
