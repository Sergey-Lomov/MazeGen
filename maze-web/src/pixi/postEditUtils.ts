import type { NodeDto, EdgeDto } from "../wasm/types";
import type {
  PostEditEdge, PostEditTool, PostEditTeleportEntry, PostEditTeleportEndpointHit, PostEditMeta,
  PostEditVerticalPassageEntry, PostEditVerticalPassageDirection, PostEditVerticalPassageEndpointHit,
  PostEditElevatorEntry,
} from "../store/mazeStore";
import { TILE_SIZE } from "./constants";
import { makeProjection } from "./tessellationProjection";
import { getNeighborData } from "./tessellationGeometry";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { type PostEditEndpoint, nodeEndpoint, splitEndpoint, edgeKey, endpointsEqual, resolveEndpoint } from "./postEditEndpoint";
import { deriveSplitPointsFromNodes } from "./splitPointsCore";

/** Built from a freshly confirmed WASM snapshot. `endpointFor` (see `resolverForNodeId`) resolves
 * each raw id to a `split` endpoint when it's one of a point's automatically-split extra nodes
 * (GitHub issue #222), or a plain `node` endpoint otherwise — never a not-yet-confirmed split
 * node, since every id here already exists in the snapshot. Defaults to `nodeEndpoint` for callers
 * that predate auto-split (no split points possible, so it's always the identity resolution). */
export function buildPostEditDraftEdgesFromGenerated(
  edges: EdgeDto[],
  endpointFor: (id: number) => PostEditEndpoint = nodeEndpoint,
): Record<string, PostEditEdge> {
  const basicEdges = edges.filter(e => e.kind !== "teleport");
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

/** Rebuilds editable teleport entries from generation's EdgeDto[]. Kept as their own list rather
 * than folded into `buildPostEditDraftEdgesFromGenerated`'s `Record` (keyed by `from-to`), since a
 * Teleport and a Basic edge can coexist in the same direction between the same pair (see
 * `Graph::add_edge`'s kind-aware dedup) and would otherwise silently overwrite one another in
 * that Record. A forward+backward pair between the same two nodes collapses into one two_way
 * entry (mirroring PresetTeleportEntry); a lone direction becomes a forward entry (from→to is the
 * actual passage direction, so it never needs a "backward" entry of its own). */
export function extractPostEditTeleports(
  edges: EdgeDto[],
  endpointFor: (id: number) => PostEditEndpoint = nodeEndpoint,
): { teleports: PostEditTeleportEntry[]; nextId: number } {
  const teleportEdges = edges.filter(e => e.kind === "teleport");
  const byPair = new Set(teleportEdges.map(e => `${e.from}->${e.to}`));
  const seenPairKey = new Set<string>();
  const teleports: PostEditTeleportEntry[] = [];
  let nextId = 1;

  for (const e of teleportEdges) {
    const pairKey = e.from < e.to ? `${e.from},${e.to}` : `${e.to},${e.from}`;
    if (seenPairKey.has(pairKey)) continue;
    seenPairKey.add(pairKey);

    const reverseExists = byPair.has(`${e.to}->${e.from}`);
    teleports.push({
      id: nextId,
      from: endpointFor(e.from),
      to: endpointFor(e.to),
      direction: reverseExists ? "two_way" : "forward",
    });
    nextId++;
  }

  return { teleports, nextId };
}

/** Converts editable teleport entries to the EdgeDto[] shape used by WASM calls and renderers.
 * A "backward" entry's actual passage direction runs to→from (mirrors
 * PresetConnectionState::TeleportBackward); "two_way" expands to both directions.
 *
 * `resolveSplit` resolves a `split` endpoint to a real node id, built by the caller from the
 * latest confirmed snapshot (see `PostEditController`'s node map). An entry with an unresolved
 * endpoint (a split node added but not yet confirmed — see `postEditEndpoint.ts`'s doc comment)
 * is silently dropped — nothing to draw/send yet, the same "not ready" pattern already used when
 * `nodeById` has no match for a plain id. */
export function postEditTeleportsToDto(
  teleports: PostEditTeleportEntry[],
  resolveSplit: (point: [number, number], slotId: number) => number | undefined,
): EdgeDto[] {
  const result: EdgeDto[] = [];
  for (const t of teleports) {
    const from = resolveEndpoint(t.from, resolveSplit);
    const to = resolveEndpoint(t.to, resolveSplit);
    if (from === undefined || to === undefined) continue;
    if (t.direction === "two_way") {
      result.push({ from, to, kind: "teleport" });
      result.push({ from: to, to: from, kind: "teleport" });
    } else if (t.direction === "backward") {
      result.push({ from: to, to: from, kind: "teleport" });
    } else {
      result.push({ from, to, kind: "teleport" });
    }
  }
  return result;
}

export function cyclePostEditTeleportDirection(
  teleports: PostEditTeleportEntry[],
  id: number,
): PostEditTeleportEntry[] {
  return teleports.map(t => {
    if (t.id !== id || t.direction === "two_way") return t;
    return { ...t, direction: t.direction === "forward" ? "backward" : "forward" };
  });
}

export function removePostEditTeleport(teleports: PostEditTeleportEntry[], id: number): PostEditTeleportEntry[] {
  return teleports.filter(t => t.id !== id);
}

export function movePostEditTeleportEndpoint(
  teleports: PostEditTeleportEntry[],
  hit: PostEditTeleportEndpointHit,
  endpoint: PostEditEndpoint,
): PostEditTeleportEntry[] {
  return teleports.map(t => {
    if (t.id !== hit.id) return t;
    return { ...t, [hit.end]: endpoint };
  });
}

const TELEPORT_ENDPOINT_HIT_RADIUS = TILE_SIZE * 0.3;

/** Hit-tests post-edit teleport endpoints by node id → screen position (via nodeById), unlike
 * PresetConnectionsController's cell-coordinate based pickTeleportEndpointAt.
 *
 * `resolveSplit` resolves a `split` endpoint to a real node id (see `postEditTeleportsToDto`'s doc
 * comment) — an entry whose endpoint doesn't resolve yet is skipped for hit-testing, same as one
 * whose (already resolved) id has no match in `nodeById`. */
export function pickPostEditTeleportEndpointAt(
  viewportX: number,
  viewportY: number,
  cfg: TessellationConfig,
  teleports: PostEditTeleportEntry[],
  nodeById: Map<number, NodeDto>,
  resolveSplit: (point: [number, number], slotId: number) => number | undefined,
): PostEditTeleportEndpointHit | null {
  const proj = makeProjection(cfg);
  const thresholdSq = TELEPORT_ENDPOINT_HIT_RADIUS * TELEPORT_ENDPOINT_HIT_RADIUS;
  let best: PostEditTeleportEndpointHit | null = null;
  let bestDistSq = Infinity;
  for (const t of teleports) {
    for (const end of ["from", "to"] as const) {
      const nodeId = resolveEndpoint(end === "from" ? t.from : t.to, resolveSplit);
      if (nodeId === undefined) continue;
      const node = nodeById.get(nodeId);
      if (!node) continue;
      const { x: px, y: py } = proj.gridToScreen(node.x, node.y);
      const dx = px - viewportX;
      const dy = py - viewportY;
      const distSq = dx * dx + dy * dy;
      if (distSq < thresholdSq && distSq < bestDistSq) {
        bestDistSq = distSq;
        best = { id: t.id, end };
      }
    }
  }
  return best;
}

/** Same hit-test as `pickPostEditTeleportEndpointAt`, for post-edit vertical passages (GitHub issue
 * #341) — mirrors `pickVerticalPassageEndpointAt` (`fieldEditUtils.ts`), adapted to node-id space:
 * only ever tests the endpoint whose resolved node lives on the active floor (`resolveNodeLevel`,
 * see `selectNodeLevelResolver`), same as `pickPostEditTeleportEndpointAt`'s own node-resolution
 * pattern. An endpoint whose node doesn't resolve (shouldn't happen — vertical passages are never
 * `split`-addressed) is skipped. */
export function pickPostEditVerticalPassageEndpointAt(
  viewportX: number,
  viewportY: number,
  cfg: TessellationConfig,
  passages: PostEditVerticalPassageEntry[],
  nodeById: Map<number, NodeDto>,
  resolveNodeLevel: (id: number) => number | undefined,
  activeLevel: number | undefined,
): PostEditVerticalPassageEndpointHit | null {
  const proj = makeProjection(cfg);
  const thresholdSq = TELEPORT_ENDPOINT_HIT_RADIUS * TELEPORT_ENDPOINT_HIT_RADIUS;
  let best: PostEditVerticalPassageEndpointHit | null = null;
  let bestDistSq = Infinity;
  for (const p of passages) {
    for (const end of ["from", "to"] as const) {
      const ep = end === "from" ? p.from : p.to;
      if (ep.kind !== "node") continue;
      if ((resolveNodeLevel(ep.id) ?? 0) !== (activeLevel ?? 0)) continue;
      const node = nodeById.get(ep.id);
      if (!node) continue;
      const { x: px, y: py } = proj.gridToScreen(node.x, node.y);
      const dx = px - viewportX;
      const dy = py - viewportY;
      const distSq = dx * dx + dy * dy;
      if (distSq < thresholdSq && distSq < bestDistSq) {
        bestDistSq = distSq;
        best = { id: p.id, end };
      }
    }
  }
  return best;
}

/** Only meaningful for the `vertical_passage_one_way` tool — mirrors `cycleVerticalPassageDirection`. */
export function cyclePostEditVerticalPassageDirection(
  passages: PostEditVerticalPassageEntry[],
  id: number,
): PostEditVerticalPassageEntry[] {
  return passages.map(p => {
    if (p.id !== id || p.direction === "two_way") return p;
    return { ...p, direction: p.direction === "forward" ? "backward" : "forward" };
  });
}

export function removePostEditVerticalPassage(passages: PostEditVerticalPassageEntry[], id: number): PostEditVerticalPassageEntry[] {
  return passages.filter(p => p.id !== id);
}

export function movePostEditVerticalPassageEndpoint(
  passages: PostEditVerticalPassageEntry[],
  hit: PostEditVerticalPassageEndpointHit,
  endpoint: PostEditEndpoint,
): PostEditVerticalPassageEntry[] {
  return passages.map(p => {
    if (p.id !== hit.id) return p;
    return { ...p, [hit.end]: endpoint };
  });
}

export function removePostEditElevator(elevators: PostEditElevatorEntry[], id: number): PostEditElevatorEntry[] {
  return elevators.filter(e => e.id !== id);
}

/** `PostEditVerticalPassageEntry.direction` → the wire `VerticalPassageDirectionDto` — mirrors
 * `presetVerticalPassageDirectionToDto`. */
export function postEditVerticalPassageDirectionToDto(
  direction: PostEditVerticalPassageDirection,
): import("../wasm/types").VerticalPassageDirectionDto | undefined {
  if (direction === "two_way") return undefined;
  return direction;
}

/** Converts editable vertical-passage/elevator entries to the flat `{from, to, kind}[]` shape
 * `ComputeAnalyticsConfig.vertical_edges` expects — mirrors `postEditTeleportsToDto`, but each
 * endpoint is always `node`-kind already (a vertical passage/elevator is never `split`-addressed),
 * so `resolveEndpoint` only ever hits the trivial branch; kept for symmetry and to skip an entry
 * whose endpoint somehow isn't a `node` (shouldn't happen). `direction: "backward"` runs `to->from`,
 * same convention `postEditTeleportsToDto` uses. An elevator fans out into every pairwise
 * combination of its resolvable floor endpoints, both directions — mirrors `build_preset_state`'s
 * own elevator-establishing loop on the Rust side. */
export function postEditVerticalToDto(
  passages: PostEditVerticalPassageEntry[],
  elevators: PostEditElevatorEntry[],
  resolveSplit: (point: [number, number], slotId: number) => number | undefined,
): { from: number; to: number; kind: "vertical_passage" | "elevator" }[] {
  const result: { from: number; to: number; kind: "vertical_passage" | "elevator" }[] = [];
  for (const p of passages) {
    const from = resolveEndpoint(p.from, resolveSplit);
    const to = resolveEndpoint(p.to, resolveSplit);
    if (from === undefined || to === undefined) continue;
    if (p.direction === "two_way") {
      result.push({ from, to, kind: "vertical_passage" });
      result.push({ from: to, to: from, kind: "vertical_passage" });
    } else if (p.direction === "backward") {
      result.push({ from: to, to: from, kind: "vertical_passage" });
    } else {
      result.push({ from, to, kind: "vertical_passage" });
    }
  }
  for (const e of elevators) {
    const ids = e.floors.map((f) => resolveEndpoint(f, resolveSplit)).filter((id): id is number => id !== undefined);
    for (let i = 0; i < ids.length; i++) {
      for (let j = 0; j < ids.length; j++) {
        if (i === j) continue;
        result.push({ from: ids[i], to: ids[j], kind: "elevator" });
      }
    }
  }
  return result;
}

/** `from`/`to` are always plain node endpoints here — the caller (`PostEditController`) resolves
 * a cell-edge click to the currently active real node before calling this, since edge tools apply
 * to a specific, already-resolved node (there's nothing to "wall off" for a node that doesn't
 * exist yet). `edgeKeyStr` is the pre-built `edgeKey(from, to)` string. */
export function applyPostEditEdgeTool(
  edges: Record<string, PostEditEdge>,
  tool: PostEditTool,
  edgeKeyStr: string,
  from: PostEditEndpoint,
  to: PostEditEndpoint,
  originalEdges: EdgeDto[],
): Record<string, PostEditEdge> {
  const next = { ...edges };
  const bwdKey = edgeKey(to, from);
  const fromId = from.kind === "node" ? from.id : undefined;
  const toId = to.kind === "node" ? to.id : undefined;

  if (tool === "reset") {
    const origAB = originalEdges.some(e => e.from === fromId && e.to === toId);
    const origBA = originalEdges.some(e => e.from === toId && e.to === fromId);
    delete next[edgeKeyStr];
    delete next[bwdKey];
    if (origAB && origBA) {
      next[edgeKeyStr] = { from, to, kind: "basic" };
      next[bwdKey] = { from: to, to: from, kind: "basic" };
    } else if (origAB) {
      next[edgeKeyStr] = { from, to, kind: "one_way_forward" };
    } else if (origBA) {
      next[bwdKey] = { from: to, to: from, kind: "one_way_forward" };
    }
  } else if (tool === "wall") {
    delete next[edgeKeyStr];
    delete next[bwdKey];
  } else if (tool === "passage") {
    next[edgeKeyStr] = { from, to, kind: "basic" };
    next[bwdKey] = { from: to, to: from, kind: "basic" };
  } else if (tool === "one_way") {
    if (next[edgeKeyStr] !== undefined) {
      delete next[edgeKeyStr];
      next[bwdKey] = { from: to, to: from, kind: "one_way_backward" };
    } else {
      delete next[bwdKey];
      next[edgeKeyStr] = { from, to, kind: "one_way_forward" };
    }
  }

  return next;
}

/** Rotates every geometric-face connection of a split point's nodes by one offset index
 * (clockwise/counter-clockwise, per `getNeighborData`'s fixed offset order) — the post-edit
 * counterpart of `rotatePresetSplitPoint` (fieldEditUtils.ts). Each `postEditDraftEdges` Record
 * entry is already a one-directional edge in its own right (a bidirectional passage is two
 * separate entries, `A->B` and `B->A` — see `applyPostEditEdgeTool`'s "passage" branch), so unlike
 * the preset side there's no canonical-order direction field to re-derive — an entry just gets
 * re-keyed to point at the new neighbor, `kind` unchanged.
 *
 * The entry's *other* side (not one of this point's own endpoints) moves to whichever node is
 * currently active at the new neighbor point (`resolveActiveAt`, same "active node, or that
 * point's original node" rule the dialog's own face clicks use) — there's no other way to say
 * "the same relative node" for a point that might itself be split.
 *
 * Refuses (returns the input unchanged) if any face that currently carries a connection would
 * land on a neighbor outside the field.
 *
 * `level` is the 0-based floor index `point` addresses (`undefined` = floor 0, GitHub issue #358)
 * — `nodes` is expected already scoped to that floor by the caller (a same-(x,y) node on another
 * floor must not be picked up as this point's original/neighbor node), and `activeSplitNode`
 * lookups are folded through the same `"@level"`-suffixed key `postEditDraftSplitPoints` uses. */
export function rotatePostEditSplitPoint(
  edges: Record<string, PostEditEdge>,
  point: [number, number],
  slotIds: number[],
  direction: 1 | -1,
  cfg: TessellationConfig,
  cellSet: Set<string>,
  nodes: NodeDto[],
  activeSplitNode: Record<string, PostEditEndpoint>,
  level?: number,
): Record<string, PostEditEdge> {
  const { offsets } = getNeighborData(cfg, point[0], point[1]);
  const n = offsets.length;
  if (n === 0) return edges;

  const pointKey = (p: [number, number]) => level === undefined ? `${p[0]},${p[1]}` : `${p[0]},${p[1]}@${level}`;

  const resolveActiveAt = (p: [number, number]): PostEditEndpoint | null => {
    const ids: number[] = [];
    for (const node of nodes) if (node.x === p[0] && node.y === p[1]) ids.push(node.id);
    if (ids.length === 0) return null;
    const activeEntry = activeSplitNode[pointKey(p)];
    return activeEntry ?? nodeEndpoint(ids[0]);
  };

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

  type Move = { oldKey: string; ep: PostEditEndpoint; otherIsFrom: boolean; newNeighbor: [number, number]; kind: PostEditEdge["kind"] };
  const moves: Move[] = [];

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
      if (!cellSet.has(`${newNeighbor[0]},${newNeighbor[1]}`)) return edges; // boundary — refuse entirely

      moves.push({ oldKey: key, ep, otherIsFrom: epIsTo, newNeighbor, kind: edge.kind });
    }
  }

  const next = { ...edges };
  for (const { oldKey } of moves) delete next[oldKey];
  for (const { ep, otherIsFrom, newNeighbor, kind } of moves) {
    const newOther = resolveActiveAt(newNeighbor);
    if (!newOther) continue; // shouldn't happen — every in-field cell has at least its original node
    const from = otherIsFrom ? newOther : ep;
    const to = otherIsFrom ? ep : newOther;
    next[edgeKey(from, to)] = { from, to, kind };
  }
  return next;
}

/** Result of `resetPostEditPoint` — a full replacement for every one of `postEditDraftEdges`/
 * `postEditDraftTeleports`/`postEditDraftSplitPoints`/`postEditDraftMeta` field touching `point`,
 * restored to generation-time state (GitHub issue #327's unified cell reset). */
export interface PostEditPointReset {
  draftEdges: Record<string, PostEditEdge>;
  draftTeleports: PostEditTeleportEntry[];
  splitPoints: Record<string, number[]>;
  activeSplitNode: Record<string, PostEditEndpoint>;
  draftMeta: PostEditMeta;
}

/** Resets a single point's manual edits back to what generation produced there — the cell branch
 * of the unified Reset tool (GitHub issue #327), as opposed to the edge branch (still
 * `applyPostEditEdgeTool`'s "reset", one face pair at a time). Unlike the edge branch, a split
 * connection *can* be reset this way — the whole point, including every one of its nodes'
 * edges/teleports/split-slot list/start-finish assignment, is dropped and rebuilt from
 * `_generatedNodes`/`_generatedEdges`, mirroring what `resetPostEdit` does for the entire graph.
 *
 * A manually `addSplitNode`-added slot that was never part of generation does not survive — same
 * "strict superset of the old clear behavior" reasoning `resetPostEdit`'s own doc comment gives.
 *
 * `generatedNodes`/`generatedEdges` are `_generatedNodes`/`_generatedEdges` (not `state.nodes`/
 * `state.edges`, which `confirmPostEdit` overwrites — see `applyPostEditToolAt`'s same guard).
 * `generatedStart`/`generatedFinish` are `_generatedStart`/`_generatedFinish`.
 *
 * `level` is the 0-based `floors` array index `point` addresses (`undefined` = floor 0, same
 * convention `PostEditEndpoint.level`/`activeFloorLevel` use, GitHub issue #358) — `point` alone
 * is not a unique address once `generatedNodes` spans every floor (GitHub issue #337): every
 * node/edge/split-point lookup below is scoped to nodes actually on `level`, or a same-(x,y) node
 * on another floor would be picked up as if it were at `point` on this one. */
export function resetPostEditPoint(
  point: [number, number],
  draftEdges: Record<string, PostEditEdge>,
  draftTeleports: PostEditTeleportEntry[],
  draftSplitPoints: Record<string, number[]>,
  draftActiveSplitNode: Record<string, PostEditEndpoint>,
  draftMeta: PostEditMeta,
  generatedNodes: NodeDto[],
  generatedEdges: EdgeDto[],
  generatedStart: number | null,
  generatedFinish: number | null,
  level?: number,
): PostEditPointReset {
  const bareKey = `${point[0]},${point[1]}`;
  const key = level === undefined ? bareKey : `${bareKey}@${level}`;

  // Every endpoint currently addressing this point in the draft — original node (if it still
  // exists, e.g. hasn't been removed) plus every declared draft slot — is a removal target, even
  // one added manually after generation and never confirmed.
  const currentIds = new Set<number>();
  for (const n of generatedNodes) if (n.x === point[0] && n.y === point[1] && (n.level ?? 0) === (level ?? 0)) currentIds.add(n.id);
  // A node id from generatedNodes is stable across confirms (see PostEditEndpoint's doc comment),
  // so it's safe to use directly as a removal target here even for one already dropped from the
  // draft by an earlier removeSplitNode — it simply won't match anything in refsTarget below, same
  // as any other id with no live reference. No separate "current nodes" snapshot is needed.
  const draftTargets: PostEditEndpoint[] = [
    ...[...currentIds].map((id) => nodeEndpoint(id)),
    ...(draftSplitPoints[key] ?? []).map((slotId) => splitEndpoint(point, slotId, level)),
  ];
  const refsTarget = (e: { from: PostEditEndpoint; to: PostEditEndpoint }) =>
    draftTargets.some((t) => endpointsEqual(e.from, t) || endpointsEqual(e.to, t));

  const nextDraftEdges = Object.fromEntries(
    Object.entries(draftEdges).filter(([, e]) => !refsTarget(e)),
  );
  const nextDraftTeleports = draftTeleports.filter((t) => !refsTarget(t));

  const nextSplitPoints = { ...draftSplitPoints };
  delete nextSplitPoints[key];
  const nextActiveSplitNode = { ...draftActiveSplitNode };
  delete nextActiveSplitNode[key];

  const nextMeta: PostEditMeta = { ...draftMeta };
  if (draftMeta.start !== null && draftTargets.some((t) => endpointsEqual(t, draftMeta.start!))) nextMeta.start = null;
  if (draftMeta.finish !== null && draftTargets.some((t) => endpointsEqual(t, draftMeta.finish!))) nextMeta.finish = null;

  // Rebuild this point's generation-time state from the frozen snapshot — original node keeps its
  // (stable) id, generation-time extra nodes become fresh `split` endpoints via the same slotId
  // derivation `resetPostEdit` uses for the whole graph (GitHub issue #222's auto-split contract).
  // Scoped to `level`'s own nodes first (`deriveSplitPointsFromNodes` groups purely by (x, y), so
  // an unscoped call would fold another floor's same-(x,y) point's slots into this one's).
  const levelNodes = generatedNodes.filter((n) => (n.level ?? 0) === (level ?? 0));
  const generatedSplitPoints = deriveSplitPointsFromNodes(levelNodes);
  const pointSlots = generatedSplitPoints[bareKey] ?? [];
  if (pointSlots.length > 0) nextSplitPoints[key] = pointSlots;

  const endpointForGeneratedId = (id: number): PostEditEndpoint => {
    const node = levelNodes.find((n) => n.id === id);
    if (!node || node.i === 0) return nodeEndpoint(id);
    const sortedSlots = [...pointSlots].sort((a, b) => a - b);
    const slotId = sortedSlots[node.i - 1];
    return slotId !== undefined ? splitEndpoint([node.x, node.y], slotId, level) : nodeEndpoint(id);
  };

  const pointGeneratedIds = new Set([...currentIds]);
  const touchesPoint = (id: number) => pointGeneratedIds.has(id);

  const basicEdges = generatedEdges.filter((e) => e.kind !== "teleport" && (touchesPoint(e.from) || touchesPoint(e.to)));
  const basicEdgeSet = new Set(generatedEdges.filter((e) => e.kind !== "teleport").map((e) => `${e.from}-${e.to}`));
  for (const e of basicEdges) {
    const hasReverse = basicEdgeSet.has(`${e.to}-${e.from}`);
    const from = endpointForGeneratedId(e.from);
    const to = endpointForGeneratedId(e.to);
    nextDraftEdges[edgeKey(from, to)] = { from, to, kind: hasReverse ? "basic" : "one_way_forward" };
  }

  const teleportEdges = generatedEdges.filter((e) => e.kind === "teleport" && (touchesPoint(e.from) || touchesPoint(e.to)));
  const teleportByPair = new Set(generatedEdges.filter((e) => e.kind === "teleport").map((e) => `${e.from}->${e.to}`));
  const seenTeleportPair = new Set<string>();
  let nextTeleportId = Math.max(0, ...nextDraftTeleports.map((t) => t.id)) + 1;
  for (const e of teleportEdges) {
    const pairKey = e.from < e.to ? `${e.from},${e.to}` : `${e.to},${e.from}`;
    if (seenTeleportPair.has(pairKey)) continue;
    seenTeleportPair.add(pairKey);
    const reverseExists = teleportByPair.has(`${e.to}->${e.from}`);
    nextDraftTeleports.push({
      id: nextTeleportId++,
      from: endpointForGeneratedId(e.from),
      to: endpointForGeneratedId(e.to),
      direction: reverseExists ? "two_way" : "forward",
    });
  }

  if (generatedStart !== null && touchesPoint(generatedStart)) nextMeta.start = endpointForGeneratedId(generatedStart);
  if (generatedFinish !== null && touchesPoint(generatedFinish)) nextMeta.finish = endpointForGeneratedId(generatedFinish);

  return {
    draftEdges: nextDraftEdges,
    draftTeleports: nextDraftTeleports,
    splitPoints: nextSplitPoints,
    activeSplitNode: nextActiveSplitNode,
    draftMeta: nextMeta,
  };
}
