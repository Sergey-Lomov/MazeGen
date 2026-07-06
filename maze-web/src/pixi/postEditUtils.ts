import type { NodeDto, EdgeDto } from "../wasm/types";
import type { PostEditEdge, PostEditTool, PostEditTeleportEntry, PostEditTeleportEndpointHit } from "../store/mazeStore";
import { TILE_SIZE } from "./constants";
import { makeProjection } from "./tessellationProjection";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";

export function buildPostEditDraftEdgesFromGenerated(edges: EdgeDto[]): Record<string, PostEditEdge> {
  const basicEdges = edges.filter(e => e.kind !== "teleport");
  const edgeSet = new Set(basicEdges.map(e => `${e.from}-${e.to}`));
  const result: Record<string, PostEditEdge> = {};
  for (const e of basicEdges) {
    const hasReverse = edgeSet.has(`${e.to}-${e.from}`);
    result[`${e.from}-${e.to}`] = {
      from: e.from,
      to: e.to,
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
      from: e.from,
      to: e.to,
      direction: reverseExists ? "two_way" : "forward",
    });
    nextId++;
  }

  return { teleports, nextId };
}

/** Converts editable teleport entries to the EdgeDto[] shape used by WASM calls and renderers.
 * A "backward" entry's actual passage direction runs to→from (mirrors
 * PresetConnectionState::TeleportBackward); "two_way" expands to both directions. */
export function postEditTeleportsToDto(teleports: PostEditTeleportEntry[]): EdgeDto[] {
  const result: EdgeDto[] = [];
  for (const t of teleports) {
    if (t.direction === "two_way") {
      result.push({ from: t.from, to: t.to, kind: "teleport" });
      result.push({ from: t.to, to: t.from, kind: "teleport" });
    } else if (t.direction === "backward") {
      result.push({ from: t.to, to: t.from, kind: "teleport" });
    } else {
      result.push({ from: t.from, to: t.to, kind: "teleport" });
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
  nodeId: number,
): PostEditTeleportEntry[] {
  return teleports.map(t => {
    if (t.id !== hit.id) return t;
    return { ...t, [hit.end]: nodeId };
  });
}

const TELEPORT_ENDPOINT_HIT_RADIUS = TILE_SIZE * 0.3;

/** Hit-tests post-edit teleport endpoints by node id → screen position (via nodeById), unlike
 * PresetConnectionsController's cell-coordinate based pickTeleportEndpointAt. */
export function pickPostEditTeleportEndpointAt(
  viewportX: number,
  viewportY: number,
  cfg: TessellationConfig,
  teleports: PostEditTeleportEntry[],
  nodeById: Map<number, NodeDto>,
): PostEditTeleportEndpointHit | null {
  const proj = makeProjection(cfg);
  const thresholdSq = TELEPORT_ENDPOINT_HIT_RADIUS * TELEPORT_ENDPOINT_HIT_RADIUS;
  let best: PostEditTeleportEndpointHit | null = null;
  let bestDistSq = Infinity;
  for (const t of teleports) {
    for (const end of ["from", "to"] as const) {
      const nodeId = end === "from" ? t.from : t.to;
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

export function applyPostEditEdgeTool(
  edges: Record<string, PostEditEdge>,
  tool: PostEditTool,
  edgeKey: string,
  from: number,
  to: number,
  originalEdges: EdgeDto[],
): Record<string, PostEditEdge> {
  const next = { ...edges };
  const bwdKey = `${to}-${from}`;

  if (tool === "reset") {
    const origAB = originalEdges.some(e => e.from === from && e.to === to);
    const origBA = originalEdges.some(e => e.from === to && e.to === from);
    delete next[edgeKey];
    delete next[bwdKey];
    if (origAB && origBA) {
      next[edgeKey] = { from, to, kind: "basic" };
      next[bwdKey] = { from: to, to: from, kind: "basic" };
    } else if (origAB) {
      next[edgeKey] = { from, to, kind: "one_way_forward" };
    } else if (origBA) {
      next[bwdKey] = { from: to, to: from, kind: "one_way_forward" };
    }
  } else if (tool === "wall") {
    delete next[edgeKey];
    delete next[bwdKey];
  } else if (tool === "passage") {
    next[edgeKey] = { from, to, kind: "basic" };
    next[bwdKey] = { from: to, to: from, kind: "basic" };
  } else if (tool === "one_way") {
    if (next[edgeKey] !== undefined) {
      delete next[edgeKey];
      next[bwdKey] = { from: to, to: from, kind: "one_way_backward" };
    } else {
      delete next[bwdKey];
      next[edgeKey] = { from, to, kind: "one_way_forward" };
    }
  }

  return next;
}
