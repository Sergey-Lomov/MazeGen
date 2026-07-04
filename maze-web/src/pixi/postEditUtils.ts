import type { EdgeDto } from "../wasm/types";
import type { PostEditEdge, PostEditTool } from "../store/mazeStore";

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

/** Teleport edges pass through generation unchanged — no post-edit tool operates on them yet
 * (out of this feature's current scope). Kept as their own list rather than folded into
 * `buildPostEditDraftEdgesFromGenerated`'s `Record` (keyed by `from-to`), since a Teleport and a
 * Basic edge can coexist in the same direction between the same pair (see `Graph::add_edge`'s
 * kind-aware dedup) and would otherwise silently overwrite one another in that Record. */
export function extractTeleportEdges(edges: EdgeDto[]): EdgeDto[] {
  return edges.filter(e => e.kind === "teleport");
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
