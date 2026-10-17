/** Shared "which split node is this?" label resolution (GitHub issue #546 eighth follow-up) —
 *  factored out of `ManageSplitNodesDialog`'s own `facesOf`/`semanticNames`/`describeEndpoint` so
 *  the "Changes" panel's bubbles can resolve a split point's node to the exact same short label
 *  ("Кор"/"Мост"/etc. when the point's current face configuration matches a recognized special-split
 *  topology, `splitNodeLabelShort` otherwise) the split-edit panel's own link bubbles show — instead
 *  of a bare, always-numeric "N{n}" that also only ever appeared for a non-original node.
 *
 *  A point being a "split tile" is having ANY entry in `postEditDraftSplitPoints` at all — it does
 *  NOT depend on which particular node (`NodeDto.i === 0`/original included) a given endpoint
 *  resolves to. The suffix must show for every one of a split tile's nodes, original node included —
 *  there is no such thing as "the first node of a split tile is not itself split". */

import type { NodeDto } from "../wasm/types";
import type { PostEditEdge } from "../store/postEditTypes";
import { type PostEditEndpoint, nodeEndpoint, splitEndpoint, edgeKey, resolveEndpoint, buildSplitNodeResolver, floorScopedEndpoint, endpointsEqual, buildLogicalCandidates, resolvePartnerForPlacement, resolveEndpointToHoverPoint } from "./postEditEndpoint";
import { getNeighborData } from "./tessellationGeometry";
import { splitNodeSemanticNames } from "./splitNodeNames";
import { splitShapeBinding } from "./splitShape";
import { splitNodeLabelShort } from "../components/features/SplitNodesDialogView";
import { formatTargetLabel } from "./targetLabel";
import type { TileFace, TileFaceKind } from "../components/features/TileFaceEditor";
import type { FieldConfig } from "../fieldConfig";

/** Everything needed to resolve any point's per-node short labels, maze-wide (not pre-scoped to one
 *  floor — `resolveSplitNodeShortLabel` scopes to whichever floor `point`/`level` names, since a
 *  single "Changes" row's bubbles can span several floors, e.g. an elevator/vertical passage). */
export interface SplitLabelContext {
  allNodes: readonly NodeDto[];
  splitPoints: Record<string, number[]>;
  activeSplitNode: Record<string, PostEditEndpoint>;
  draftEdges: Record<string, PostEditEdge> | null;
  /** A floor's own tessellation config — field shape/size is per-floor (GitHub issue #611), so this
   *  is looked up by `level` (`undefined` = floor 0) rather than a single maze-wide config, same as
   *  `inFieldCellsAt` below. */
  cfgAt: (level: number | undefined) => FieldConfig;
  /** A floor's in-field cell set (`"x,y"` keys) — looked up by `level` (`undefined` = floor 0)
   *  rather than a single fixed set, same reasoning as `cfgAt` above. */
  inFieldCellsAt: (level: number | undefined) => ReadonlySet<string>;
}

/** Resolves which of a (possibly split) point's nodes is currently active — mirrors
 *  `ManageSplitNodesDialog`'s own `resolveActiveAt`. */
function resolveActiveAt(ctx: SplitLabelContext, floorNodes: readonly NodeDto[], level: number | undefined, p: [number, number]): PostEditEndpoint | null {
  const pKey = level === undefined ? `${p[0]},${p[1]}` : `${p[0]},${p[1]}@${level}`;
  const ids: number[] = [];
  for (const n of floorNodes) if (n.x === p[0] && n.y === p[1]) ids.push(n.id);
  if (ids.length === 0) return null;
  return ctx.activeSplitNode[pKey] ?? nodeEndpoint(ids[0]);
}

/** Which of a (possibly split) neighbor point's nodes actually connects back to `endpoint` — a
 *  thin wrapper over the shared `resolvePartnerForPlacement` (GitHub issue #580): tries every real
 *  node at `p` for a decided/wall edge with `endpoint` before falling back to the neighbor's active
 *  UI slot, so a neighbor that's itself split doesn't get checked against the wrong one of its
 *  nodes. */
function resolveConnectedNeighborAt(
  ctx: SplitLabelContext,
  floorNodes: readonly NodeDto[],
  level: number | undefined,
  p: [number, number],
  endpoint: PostEditEndpoint,
): PostEditEndpoint | null {
  if (!ctx.draftEdges) return resolveActiveAt(ctx, floorNodes, level, p);
  const ids: number[] = [];
  for (const n of floorNodes) if (n.x === p[0] && n.y === p[1]) ids.push(n.id);
  if (ids.length === 0) return null;
  const pKey = `${p[0]},${p[1]}`;
  const pSlots = ctx.splitPoints[level === undefined ? pKey : `${pKey}@${level}`] ?? [];
  const candidates = buildLogicalCandidates(p, ids, pSlots, level);
  const result = resolvePartnerForPlacement([endpoint], candidates, ctx.draftEdges, ctx.activeSplitNode, p, level);
  return result?.endpoint ?? null;
}

/** Faces of one node at `point` — mirrors `ManageSplitNodesDialog`'s own `facesOf`. */
function facesOf(
  ctx: SplitLabelContext,
  floorNodes: readonly NodeDto[],
  level: number | undefined,
  point: [number, number],
  endpoint: PostEditEndpoint,
): TileFace[] {
  const { offsets } = getNeighborData(ctx.cfgAt(level), point[0], point[1]);
  const inFieldCells = ctx.inFieldCellsAt(level);
  return offsets.map(([dx, dy]) => {
    const neighbor: [number, number] = [point[0] + dx, point[1] + dy];
    const boundary = !inFieldCells.has(`${neighbor[0]},${neighbor[1]}`);
    if (boundary) return { kind: "wall" as TileFaceKind, boundary };
    if (!ctx.draftEdges) return { kind: "wall" as TileFaceKind, boundary };

    const neighborActive = resolveConnectedNeighborAt(ctx, floorNodes, level, neighbor, endpoint);
    if (!neighborActive) return { kind: "wall" as TileFaceKind, boundary: false };

    const fwd = ctx.draftEdges[edgeKey(endpoint, neighborActive)];
    const bwd = ctx.draftEdges[edgeKey(neighborActive, endpoint)];
    let kind: TileFaceKind = "wall";
    if (fwd?.kind === "basic" || bwd?.kind === "basic") kind = "passage";
    else if (fwd?.kind === "one_way_forward" || fwd?.kind === "one_way_backward") kind = "one_way_out";
    else if (bwd?.kind === "one_way_forward" || bwd?.kind === "one_way_backward") kind = "one_way_in";
    else if (fwd?.kind === "wall" || bwd?.kind === "wall") kind = "wall";
    return { kind, boundary: false };
  });
}

/** The single post-edit-stage point-label formatter (GitHub issue #602) — every post-edit UI spot
 *  that shows a point's coordinates (status bar, "Changes" panel bubbles, "Manage split nodes"
 *  dialog links) goes through this, instead of each resolving coordinates/floor/split-node
 *  independently. Always resolves the split-node suffix via `resolveSplitNodeShortLabel` —
 *  `formatTarget`'s previous caller (`cellInspection.ts`) never resolved this at all (GitHub issue
 *  #595's follow-up).
 *
 *  `includeFloor` is the caller's own call, same as every one of the ten call sites unified here
 *  had before this refactor. `ctx` is `null` for a caller with no split/geometry context handy
 *  (mirrors `resolveSplitNodeShortLabel`'s own `ctx: null` case) — the suffix is simply omitted
 *  then, same as an unsplit point always has. */
export function postEditTargetLabel(
  ctx: SplitLabelContext | null,
  endpoint: PostEditEndpoint,
  nodeById: ReadonlyMap<number, { x: number; y: number; level?: number }>,
  includeFloor: boolean,
): string {
  const resolved = resolveEndpointToHoverPoint(endpoint, nodeById);
  if (!resolved) return endpoint.kind === "node" ? `#${endpoint.id}` : formatTargetLabel(endpoint.point, endpoint.level ?? 0, includeFloor, undefined);
  const suffix = resolveSplitNodeShortLabel(ctx, resolved.point, resolved.level, endpoint);
  return formatTargetLabel(resolved.point, resolved.level ?? 0, includeFloor, suffix);
}

/** Short label for `endpoint`, addressing `point`/`level` — the point's recognized special-split
 *  topology's semantic short name (e.g. "Мост"/"Кор") when one matches, `splitNodeLabelShort`
 *  otherwise. `undefined` when `point`/`level` isn't a split tile at all (no entry in `splitPoints`)
 *  — the caller's own signal to omit the "(N{n})" suffix entirely, same as a plain unsplit point
 *  always has. */
export function resolveSplitNodeShortLabel(
  ctx: SplitLabelContext | null,
  point: [number, number],
  rawLevel: number | undefined,
  endpoint: PostEditEndpoint,
): string | undefined {
  if (ctx === null) return undefined;
  // `NodeDto.level` (the source of `rawLevel` for most callers, via `resolveEndpointToHoverPoint`)
  // comes straight off the wasm snapshot as a real `0` for floor 0, not `undefined` — every other
  // `"x,y"`/`"x,y@level"`-keyed lookup in post-edit (`postEditDraftSplitPoints` itself included,
  // `buildMultiFloorPostEditDraft`'s `levelKey = level === 0 ? undefined : level`) normalizes floor
  // 0 to `undefined` before building a key. Skipping this normalization silently looked up every
  // floor-0 split point under `"x,y@0"`, which `splitPoints` never has an entry for (it's always
  // bare `"x,y"`) — the suffix vanished for every floor-0 point, i.e. almost every point on a
  // single-floor maze (GitHub issue #546 ninth follow-up).
  const level = rawLevel === 0 ? undefined : rawLevel;
  const key = level === undefined ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
  const slots = ctx.splitPoints[key];
  if (slots === undefined || slots.length === 0) return undefined;
  const sortedSlots = [...slots].sort((a, b) => a - b);
  const floorNodes = ctx.allNodes.filter((n) => (n.level ?? 0) === (level ?? 0));

  const originalNodeId = floorNodes.find((n) => n.x === point[0] && n.y === point[1])?.id;
  const originalEndpoint: PostEditEndpoint | null = originalNodeId !== undefined ? nodeEndpoint(originalNodeId) : null;
  const nodeEndpointsInOrder: PostEditEndpoint[] = [
    ...(originalEndpoint ? [originalEndpoint] : []),
    ...sortedSlots.map((slotId) => splitEndpoint(point, slotId, level)),
  ];

  const pointNodeIds = new Set(floorNodes.filter((n) => n.x === point[0] && n.y === point[1]).map((n) => n.id));
  const resolveSplit = buildSplitNodeResolver(
    new Map([[`${point[0]},${point[1]}`, [...pointNodeIds]]]),
    { [`${point[0]},${point[1]}`]: sortedSlots },
  );
  const endpointsMatch = (a: PostEditEndpoint, b: PostEditEndpoint): boolean => {
    const ra = resolveEndpoint(floorScopedEndpoint(a, level, pointNodeIds) ?? a, resolveSplit);
    const rb = resolveEndpoint(floorScopedEndpoint(b, level, pointNodeIds) ?? b, resolveSplit);
    if (ra !== undefined && rb !== undefined) return ra === rb;
    return endpointsEqual(a, b);
  };

  const semanticNames = splitNodeSemanticNames(
    nodeEndpointsInOrder.map((ep) => ({ faces: facesOf(ctx, floorNodes, level, point, ep) })),
    splitShapeBinding(ctx.cfgAt(level), point[0], point[1]),
  );
  const idx = nodeEndpointsInOrder.findIndex((ep) => endpointsMatch(ep, endpoint));
  if (idx < 0) {
    // A stale/removed slot's endpoint — no longer one of this point's current nodes. Fall back to
    // whatever slot number it names directly, same as a `split`-kind endpoint elsewhere.
    return endpoint.kind === "split" ? splitNodeLabelShort(endpoint.slotId) : undefined;
  }
  const slotIdAt = idx === 0 && originalEndpoint ? undefined : sortedSlots[idx - (originalEndpoint ? 1 : 0)];
  return semanticNames?.[idx]?.short ?? splitNodeLabelShort(slotIdAt);
}
