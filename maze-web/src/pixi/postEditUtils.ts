import type { NodeDto, EdgeDto } from "../wasm/types";
import type { PostEditEdge, PostEditTool, PostEditTeleportEntry, PostEditTeleportEndpointHit } from "../store/mazeStore";
import { TILE_SIZE } from "./constants";
import { makeProjection } from "./tessellationProjection";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { type PostEditEndpoint, nodeEndpoint, edgeKey, resolveEndpoint } from "./postEditEndpoint";

/** Built from a freshly confirmed WASM snapshot — every id here is an already-real node, never a
 * not-yet-confirmed split node, so entries are always plain `node` endpoints. */
export function buildPostEditDraftEdgesFromGenerated(edges: EdgeDto[]): Record<string, PostEditEdge> {
  const basicEdges = edges.filter(e => e.kind !== "teleport");
  const edgeSet = new Set(basicEdges.map(e => `${e.from}-${e.to}`));
  const result: Record<string, PostEditEdge> = {};
  for (const e of basicEdges) {
    const hasReverse = edgeSet.has(`${e.to}-${e.from}`);
    const from = nodeEndpoint(e.from);
    const to = nodeEndpoint(e.to);
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
export function extractPostEditTeleports(edges: EdgeDto[]): { teleports: PostEditTeleportEntry[]; nextId: number } {
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
      from: nodeEndpoint(e.from),
      to: nodeEndpoint(e.to),
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
