import type { EdgeDto } from "../wasm/types";
import type { PostEditEdge, PostEditEdgeKind, PostEditTool } from "../store/mazeStore";

export function buildPostEditDraftEdgesFromGenerated(edges: EdgeDto[]): Record<string, PostEditEdge> {
  const edgeSet = new Set(edges.map(e => `${e.from}-${e.to}`));
  const result: Record<string, PostEditEdge> = {};
  for (const e of edges) {
    const hasReverse = edgeSet.has(`${e.to}-${e.from}`);
    result[`${e.from}-${e.to}`] = {
      from: e.from,
      to: e.to,
      kind: hasReverse ? "basic" : "one_way_forward",
    };
  }
  return result;
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
