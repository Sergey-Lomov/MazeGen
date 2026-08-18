import type { NodeDto, EdgeDto } from "../../../wasm/types";
import type { PostEditEdge } from "../../../store/mazeStore";
import type { FieldConfig as TessellationConfig } from "../../../fieldConfig";
import type { NodeEdgeHighlight } from "../../renderers/NodeEdgeHighlightRenderer";
import { getCellCenter } from "../../tessellationGeometry";
import { NODE_RADIUS, WALL_THICKNESS } from "../../renderConstants";
import { canvas } from "../../colorTokens";
import { resolveEndpoint, type PostEditEndpoint } from "../../postEditEndpoint";

// Teleport edges are never part of `postEditEdges` — they're tracked separately (see
// `postEditDraftTeleportEdges`/`postEditTeleportEdges` in storeTypes.ts) since a Teleport and a
// Basic edge can coexist in the same direction between the same pair, which the `Record<from-to,
// PostEditEdge>` shape used here can't represent. Callers needing both must concatenate
// `postEditEdgesToDto(...)` with the teleport list themselves.
//
// `resolveSplit` resolves a `split` endpoint to a real node id (see `postEditEndpoint.ts`'s doc
// comment) — an entry with an unresolved endpoint (a split node added but not yet confirmed) is
// silently dropped, same "nothing to draw yet" pattern used elsewhere on this boundary.
export function postEditEdgesToDto(
  postEditEdges: Record<string, PostEditEdge> | null,
  resolveSplit: (point: [number, number], slotId: number) => number | undefined,
): EdgeDto[] {
  if (postEditEdges === null) return [];
  const result: EdgeDto[] = [];
  for (const e of Object.values(postEditEdges)) {
    if (e.kind === "wall") continue;
    const from = resolveEndpoint(e.from, resolveSplit);
    const to = resolveEndpoint(e.to, resolveSplit);
    if (from === undefined || to === undefined) continue;
    result.push({ from, to, kind: "basic" });
  }
  return result;
}

/** Highlight for `postEditHoveredLink` (GitHub issue #237) — same "node-to-node" style
 *  `DebugRefHighlightOverlay` uses for an edge ref (`NodeEdgeHighlightRenderer`: a straight line
 *  + circle markers on each end), cell center to cell center — not the shared geometric wall
 *  segment (a teleport link has no shared face at all to draw on), and not a split point's hub
 *  point either (kept simple: this highlight only needs to say "these two cells", not distinguish
 *  which of a split point's several nodes). Silently renders nothing if either endpoint doesn't
 *  resolve (an unconfirmed split node — same "nothing to draw yet" contract as
 *  `postEditEdgesToDto`). */
export function buildLinkHoverHighlight(
  link: { from: PostEditEndpoint; to: PostEditEndpoint } | null,
  nodes: NodeDto[],
  resolveSplit: (point: [number, number], slotId: number) => number | undefined,
  cfg: TessellationConfig,
): NodeEdgeHighlight[] {
  if (!link) return [];
  const fromId = resolveEndpoint(link.from, resolveSplit);
  const toId = resolveEndpoint(link.to, resolveSplit);
  if (fromId === undefined || toId === undefined) return [];
  const fromNode = nodes.find((n) => n.id === fromId);
  const toNode = nodes.find((n) => n.id === toId);
  if (!fromNode || !toNode) return [];
  return [{
    from: getCellCenter(fromNode.x, fromNode.y, cfg),
    to: getCellCenter(toNode.x, toNode.y, cfg),
    color: canvas.fieldEditor.hover,
    alpha: 1.0,
    width: WALL_THICKNESS * 2,
    nodeRadius: NODE_RADIUS,
  }];
}
