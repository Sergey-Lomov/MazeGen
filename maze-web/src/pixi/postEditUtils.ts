import type { NodeDto, EdgeDto } from "../wasm/types";
import type { PostEditEdge } from "../store/mazeStore";
import { getNeighborData } from "./tessellationGeometry";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { type PostEditEndpoint, nodeEndpoint, splitEndpoint, edgeKey, endpointsEqual } from "./postEditEndpoint";

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
  findPostEditVerticalPassageForPair,
  cyclePostEditVerticalPassageDirection,
  removePostEditVerticalPassage,
  movePostEditVerticalPassageEndpoint,
  removePostEditElevator,
  elevatorComponent,
  postEditVerticalPassageDirectionToDto,
  postEditVerticalToDto,
} from "./postEditVerticalUtils";

/** Built from a freshly confirmed WASM snapshot. `endpointFor` (see `resolverForNodeId`) resolves
 * each raw id to a `split` endpoint when it's one of a point's automatically-split extra nodes
 * (GitHub issue #222), or a plain `node` endpoint otherwise — never a not-yet-confirmed split
 * node, since every id here already exists in the snapshot. Defaults to `nodeEndpoint` for callers
 * that predate auto-split (no split points possible, so it's always the identity resolution). */
export function buildPostEditDraftEdgesFromGenerated(
  edges: EdgeDto[],
  endpointFor: (id: number) => PostEditEndpoint = nodeEndpoint,
): Record<string, PostEditEdge> {
  const basicEdges = edges.filter(e => e.kind !== "teleport" && e.kind !== "vertical_passage" && e.kind !== "elevator");
  const edgeSet = new Set(basicEdges.map(e => `${e.from}-${e.to}`));
  const result: Record<string, PostEditEdge> = {};
  for (const e of basicEdges) {
    const hasReverse = edgeSet.has(`${e.to}-${e.from}`);
    const from = endpointFor(e.from);
    const to = endpointFor(e.to);
    result[edgeKey(from, to)] = {
      from,
      to,
      kind: hasReverse ? "basic" : "one_way_forward",
    };
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
 * outside the field (rotation must be refused entirely) — the sole caller, `rotateSplitPointMoves`,
 * treats this as "nothing to do".
 *
 * `level` is the 0-based floor index `point` addresses (`undefined` = floor 0, GitHub issue #358)
 * — `nodes` is expected already scoped to that floor by the caller (a same-(x,y) node on another
 * floor must not be picked up as this point's original/neighbor node). */
type RotateMove = { oldKey: string; ep: PostEditEndpoint; otherIsFrom: boolean; newNeighbor: [number, number]; kind: PostEditEdge["kind"] };

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
      if (!cellSet.has(`${newNeighbor[0]},${newNeighbor[1]}`)) return undefined; // boundary — refuse entirely

      moves.push({ oldKey: key, ep, otherIsFrom: epIsTo, newNeighbor, kind: edge.kind });
    }
  }
  return moves;
}

/** Resolves `collectRotateMoves`'s raw move list into `ResolvedRotateMove[]` — used to build a
 * `rotateSplitPoint` command (GitHub issue #543), whose replay has no tessellation/field access and
 * needs each move's resulting endpoints/kind pre-computed (see `ResolvedRotateMove`'s doc comment,
 * `postEditCommandTypes.ts`). Returns `[]` if the rotation must be refused (a moved connection
 * would land outside the field) — the caller treats an empty move list as "nothing to do". */
export function rotateSplitPointMoves(
  edges: Record<string, PostEditEdge>,
  point: [number, number],
  slotIds: number[],
  direction: 1 | -1,
  cfg: TessellationConfig,
  cellSet: Set<string>,
  nodes: NodeDto[],
  activeSplitNode: Record<string, PostEditEndpoint>,
  level?: number,
): { oldKey: string; from: PostEditEndpoint; to: PostEditEndpoint; edgeKind: PostEditEdge["kind"] }[] {
  const moves = collectRotateMoves(edges, point, slotIds, direction, cfg, cellSet, nodes, level);
  if (moves === undefined) return [];

  const pointKey = (p: [number, number]) => level === undefined ? `${p[0]},${p[1]}` : `${p[0]},${p[1]}@${level}`;
  const resolveActiveAt = (p: [number, number]): PostEditEndpoint | null => {
    const ids: number[] = [];
    for (const node of nodes) if (node.x === p[0] && node.y === p[1]) ids.push(node.id);
    if (ids.length === 0) return null;
    const activeEntry = activeSplitNode[pointKey(p)];
    return activeEntry ?? nodeEndpoint(ids[0]);
  };

  const resolved: { oldKey: string; from: PostEditEndpoint; to: PostEditEndpoint; edgeKind: PostEditEdge["kind"] }[] = [];
  for (const { oldKey, ep, otherIsFrom, newNeighbor, kind } of moves) {
    const newOther = resolveActiveAt(newNeighbor);
    if (!newOther) continue;
    const from = otherIsFrom ? newOther : ep;
    const to = otherIsFrom ? ep : newOther;
    resolved.push({ oldKey, from, to, edgeKind: kind });
  }
  return resolved;
}
