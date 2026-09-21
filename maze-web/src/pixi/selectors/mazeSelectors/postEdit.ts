import type { NodeDto, EdgeDto } from "../../../wasm/types";
import type { PostEditEdge } from "../../../store/mazeStore";
import type { FieldConfig as TessellationConfig } from "../../../fieldConfig";
import type { NodeEdgeHighlight } from "../../renderers/NodeEdgeHighlightRenderer";
import { getCellCenter } from "../../tessellationGeometry";
import { NODE_RADIUS, WALL_THICKNESS } from "../../renderConstants";
import { canvas } from "../../colorTokens";
import { resolveEndpoint, type PostEditHoveredEntity, type PostEditHoverPoint } from "../../postEditEndpoint";

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

/** Matches a `PostEditHoverPoint` against a node by `(x, y)` AND level — level defaults to 0 on
 *  both sides (`PostEditHoverPoint.level`/`NodeDto.level` share that "undefined = floor 0"
 *  convention). Checking level explicitly, not just relying on `nodes` already being floor-scoped,
 *  matters because different floors' tessellations legitimately reuse the same `(x, y)` — scoping
 *  alone only narrows *which* floor's nodes are candidates; it doesn't stop a point that names a
 *  coordinate on a DIFFERENT floor at the same `(x, y)` from matching one of those candidates by
 *  accident (GitHub issue #546 follow-up: a floor-1 point/link kept drawing on floor 0 whenever the
 *  coordinates happened to coincide). */
function pointMatchesNode(p: PostEditHoverPoint, n: NodeDto): boolean {
  return n.x === p.point[0] && n.y === p.point[1] && (n.level ?? 0) === (p.level ?? 0);
}

/** Highlight for a `link`-kind `PostEditHoveredEntity` (GitHub issue #237) — same "node-to-node"
 *  style `DebugRefHighlightOverlay` uses for an edge ref (`NodeEdgeHighlightRenderer`: a straight
 *  line + circle markers on each end), cell center to cell center — not the shared geometric wall
 *  segment (a teleport link has no shared face at all to draw on), and not a split point's hub
 *  point either (kept simple: this highlight only needs to say "these two cells", not distinguish
 *  which of a split point's several nodes). Matches each endpoint via `pointMatchesNode`.
 *
 *  A cross-floor link (a vertical passage/elevator/teleport whose `from`/`to` sit on different
 *  floors, GitHub issue #546 follow-up) has at most one endpoint on the active floor at a time — a
 *  line needs both ends, so instead the on-floor endpoint alone gets a single-cell region group
 *  (returned via `soloPoints`, merged into the caller's own `regionGroups`) so the link reads as
 *  highlighted on *whichever* floor the user is currently on. `soloPoints` is filtered to
 *  `activeLevel` explicitly — matching against the unscoped `nodes` list below can resolve BOTH
 *  endpoints at once (a vertical passage's/elevator's `from`/`to` share one `(x, y)`, differing only
 *  in level, so `nodes.find` for each end succeeds regardless of which floor is active); without
 *  this filter, "no line, both endpoints solo-highlighted" would light up the point on every one of
 *  its floors at once instead of only the one actually being viewed (GitHub issue #546 follow-up:
 *  "не подсвечиваем пустое место"). Only when both endpoints resolve on the SAME active floor (an
 *  ordinary same-floor link) is the connecting line itself drawn. */
function buildLinkHoverHighlight(
  link: { from: PostEditHoverPoint; to: PostEditHoverPoint },
  nodes: NodeDto[],
  activeLevel: number,
  cfg: TessellationConfig,
): { line: NodeEdgeHighlight[]; soloPoints: number[][] } {
  const fromNode = nodes.find((n) => pointMatchesNode(link.from, n));
  const toNode = nodes.find((n) => pointMatchesNode(link.to, n));
  if (fromNode && toNode && (fromNode.level ?? 0) === activeLevel && (toNode.level ?? 0) === activeLevel) {
    return {
      line: [{
        from: getCellCenter(fromNode.x, fromNode.y, cfg),
        to: getCellCenter(toNode.x, toNode.y, cfg),
        color: canvas.fieldEditor.hover,
        alpha: 1.0,
        width: WALL_THICKNESS * 2,
        nodeRadius: NODE_RADIUS,
      }],
      soloPoints: [],
    };
  }
  const soloPoints: number[][] = [];
  if (fromNode && (fromNode.level ?? 0) === activeLevel) soloPoints.push([fromNode.id]);
  if (toNode && (toNode.level ?? 0) === activeLevel && !soloPoints.some(([id]) => id === toNode.id)) soloPoints.push([toNode.id]);
  return { line: [], soloPoints };
}

export interface PostEditBoundaryLink {
  from: PostEditHoverPoint;
  to: PostEditHoverPoint;
  style: "one_way" | "boundary";
}

/** Resolves a `point`/`points`-kind `PostEditHoveredEntity` to the maze node ids
 *  `RegionHighlightRenderer` needs (one group, one cell fill per point — mirrors
 *  `DebugRefHighlightOverlay`'s `node` ref, which treats a single node as a one-element region).
 *  Matches via `pointMatchesNode` (coordinate AND level), not just `nodes` already being
 *  floor-scoped — see that function's doc comment for why level must be checked explicitly. Not a
 *  specific node id — a split point's every node (original plus every slot) shares one cell, so
 *  highlighting any one of them (the first match) highlights the whole point.
 *
 *  Filtered to `activeLevel` (GitHub issue #546 follow-up, same reason `buildLinkHoverHighlight`'s
 *  own doc comment gives): an elevator's `points` all share one `(x, y)` across every floor it
 *  spans, so without this filter every one of those floors' matched nodes would be included in the
 *  same group and drawn on top of each other regardless of which floor is actually active. */
function resolvePointGroups(
  points: readonly PostEditHoverPoint[],
  nodes: NodeDto[],
  activeLevel: number,
): number[][] {
  const groups: number[][] = [];
  for (const p of points) {
    const group: number[] = [];
    for (const node of nodes) {
      if (pointMatchesNode(p, node) && (node.level ?? 0) === activeLevel) group.push(node.id);
    }
    if (group.length > 0 && !groups.some((existing) => existing.some((id) => group.includes(id)))) groups.push(group);
  }
  return groups;
}

/** Splits a `PostEditHoveredEntity` (GitHub issue #546) into the two highlight-primitive inputs
 *  `PostEditRenderer` feeds to its `linkHover` (`NodeEdgeHighlightRenderer`) and `entityHighlight`
 *  (`RegionHighlightRenderer`) instances — exactly one of the two is ever non-empty, mirroring
 *  `DebugRefHighlightOverlay`'s own "exactly one sub-renderer has content" contract.
 *
 *  `nodes` must be the *unscoped* maze-wide snapshot (`state.nodes`), not a floor-scoped one — a
 *  cross-floor entity (a vertical passage/elevator/teleport whose points sit on different floors)
 *  needs every floor's nodes as match candidates, or its off-floor endpoint could never resolve at
 *  all. `activeLevel` (the active floor's own 0-based index) then gates what's actually drawn to
 *  that one floor — matching finds every candidate across every floor, but only a candidate ON
 *  `activeLevel` is ever rendered, so nothing appears on a floor the entity doesn't actually touch
 *  (GitHub issue #546 follow-up: "не подсвечиваем пустое место"). */
export function buildHoveredEntityHighlight(
  entity: PostEditHoveredEntity | null,
  nodes: NodeDto[],
  activeLevel: number,
  cfg: TessellationConfig,
): { link: NodeEdgeHighlight[]; regionGroups: number[][]; boundaryLinks?: PostEditBoundaryLink[] } {
  if (!entity) return { link: [], regionGroups: [] };
  if (entity.kind === "link") {
    if (entity.highlightStyle === "one_way" || entity.highlightStyle === "boundary") {
      const fromNode = nodes.find((n) => pointMatchesNode(entity.from, n));
      const toNode = nodes.find((n) => pointMatchesNode(entity.to, n));
      if (fromNode && toNode && (fromNode.level ?? 0) === activeLevel && (toNode.level ?? 0) === activeLevel) {
        return { link: [], regionGroups: [], boundaryLinks: [{ from: entity.from, to: entity.to, style: entity.highlightStyle }] };
      }
    }
    const { line, soloPoints } = buildLinkHoverHighlight(entity, nodes, activeLevel, cfg);
    return { link: line, regionGroups: soloPoints };
  }
  const points = entity.kind === "point" ? [entity] : entity.points;
  return { link: [], regionGroups: resolvePointGroups(points, nodes, activeLevel) };
}
