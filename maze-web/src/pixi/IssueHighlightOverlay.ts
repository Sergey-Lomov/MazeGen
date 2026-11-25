import { Graphics } from "pixi.js";
import type { NodeDto, EdgeDto, NavEdgeDto } from "../wasm/types";
import type { FieldConfig } from "../fieldConfig";
import { NODE_RADIUS } from "../domain/renderConstants";
import type { Pos } from "../domain/tessellationGeometry";
import { buildNodePositions } from "../domain/splitNodeGeometry";
import { splitWallAndLineEdges } from "./renderers/wallUtils";
import { fullyHighlightedNavEdges } from "./renderers/edgeUtils";
import { getCellHighlightInset } from "./cellHighlightGeometry";
import { canvas } from "../domain/colorTokens";
import { BaseGraphRenderer, buildCrossFloorMarkers, buildPathRenderEdges } from "./BaseGraphRenderer";
import type { NodeCellResolver } from "./BaseGraphRenderer";
import type { IssueHighlightEdge } from "../store/postEditFullTypes";
import type { SeamHopContext } from "../domain/graphSeams";

const HIGHLIGHT_WIDTH = 3;
const HIGHLIGHT_ALPHA = 1;

export interface IssueHighlightData {
  nodes: NodeDto[];
  /** Base-graph edges to highlight — typically issue loops or boundary-style entities. Each edge's
   * own `asWall` (GitHub issue #377) picks line-vs-wall drawing — see `IssueHighlightEdge`.
   * Flagged cells are not drawn here: they go through the shared coordinate warning layer. */
  edges: IssueHighlightEdge[] | null;
  /** The maze's full edge list (`state.edges`, not the highlighted subset above) — drives
   *  shape-aware split node-point positioning (GitHub issue #318), see `buildNodePositions`'s own
   *  doc comment. `[]` falls back to the generic hub position. */
  allEdges: EdgeDto[];
  /** Nav edges of the maze — a highlighted loop is drawn along them, so dots land on nav nodes only. */
  navEdges: NavEdgeDto[];
  cfg: FieldConfig;
  /** Resolves a node id's own floor (`selectNodeLevelResolver`, built from the *unscoped* node
   *  list) — needed to detect a highlighted edge whose other endpoint crosses to another floor
   *  (GitHub issue #367, closing the #339 gap for this overlay). Omitted callers draw no
   *  cross-floor badges. */
  resolveNodeLevel?: (id: number) => number | undefined;
  /** Resolves a node id's own cell coordinate, from the *unscoped* node list — needed alongside
   *  `resolveNodeLevel` to place a cross-floor badge (GitHub issue #367). */
  resolveNodeCell?: NodeCellResolver;
  /** The active floor's own `levels_ordered()` index — required alongside `resolveNodeLevel`. */
  activeFloorIndex?: number;
  /** Every cross-floor edge's own `"from->to"` key (`vertical_passage` / `elevator` / `teleport` —
   *  every kind that can span floors), built from the *unscoped* `state.edges`. A cross-floor stub
   *  gets its direction arrow only when the underlying connection is genuinely one-way — exactly
   *  one of `"from->to"`/`"to->from"` present. Must be unscoped: a two-way connection's reverse
   *  edge lives on the other floor and is always missing from any floor-scoped list (GitHub issue
   *  #337/#347). */
  crossFloorEdgeKeys?: ReadonlySet<string>;
  /** Width of the studio renderer's wall one-way marker. When omitted, a boundary highlight uses
   *  the full cell-to-cell distance for generic wall entities. */
  oneWayBoundaryWidth?: number;
  /** Seam hop context (GitHub issue #841): a highlighted edge across a glue breaks at the glue's contour. */
  seam?: SeamHopContext;
}

export class IssueHighlightOverlay extends BaseGraphRenderer {
  render(data: IssueHighlightData): void {
    this.resetContainers();
    const { nodes, edges, allEdges, navEdges, cfg, resolveNodeLevel, resolveNodeCell, activeFloorIndex, crossFloorEdgeKeys, oneWayBoundaryWidth, seam } = data;
    const hasEdges = edges != null && edges.length > 0;
    const highlightColor = canvas.coordinateWarning[edges?.[0]?.severity ?? "warning"];

    if (!hasEdges || nodes.length === 0) return;

    // Wall edges (GitHub issue #377 — e.g. a single flagged invalid_one_way) draw as the shared
    // wall between their two cells instead of a line — no node/cross-floor markers, since the
    // wall segment itself is the marker. Falls back to a line if the two endpoints turn out not
    // to be tessellation-adjacent (no shared wall to draw, e.g. a cross-floor edge whose other
    // endpoint isn't resolvable to a cell here).
    const nodeById = new Map<number, NodeDto>();
    for (const node of nodes) nodeById.set(node.id, node);
    const cellOf = (id: number): [number, number] | undefined => {
      const node = nodeById.get(id);
      return node ? [node.x, node.y] : undefined;
    };

    const wallG = new Graphics();
    const lineEdges = splitWallAndLineEdges(wallG, edges, cellOf, cfg, highlightColor, 0.25, HIGHLIGHT_WIDTH, oneWayBoundaryWidth, getCellHighlightInset());
    this.edgesContainer.addChild(wallG);

    if (lineEdges.length === 0) return;

    const directedPairs = allEdges.filter((e) => e.kind !== "teleport").map((e) => ({ from: e.from, to: e.to }));
    const nodePos: Map<number, Pos> = buildNodePositions(nodes, cfg, directedPairs);
    const linePairs: [number, number][] = lineEdges.map((e) => [e.from, e.to]);

    // Same drawing as the Cycles overlay: each nav edge whose every hop is highlighted is one
    // continuous contour between nav nodes, with dots at the nav nodes only.
    const highlightedNavEdges = fullyHighlightedNavEdges(navEdges, linePairs);
    this.drawEdges(buildPathRenderEdges(highlightedNavEdges, nodePos, navEdges, seam), highlightColor);

    if (resolveNodeLevel && resolveNodeCell && activeFloorIndex !== undefined) {
      // A cross-floor stub gets its direction arrow only when the underlying connection is
      // genuinely one-way — exactly one of `"from->to"`/`"to->from"` present in
      // `crossFloorEdgeKeys`, with the stub then pointing whichever way that lone edge runs (which
      // may be opposite the loop's own traversal). A two-way connection (both keys present) or a
      // hop with no cross-floor edge at all (neither key) feeds both directions so
      // `buildCrossFloorMarkers` resolves the stub to `direction: "none"` (no arrow).
      const oneWayDir = (from: number, to: number): [number, number] | null => {
        if (crossFloorEdgeKeys == null) return null;
        const fwd = crossFloorEdgeKeys.has(`${from}->${to}`);
        const bwd = crossFloorEdgeKeys.has(`${to}->${from}`);
        if (fwd === bwd) return null;
        return fwd ? [from, to] : [to, from];
      };
      const markerPairs = linePairs.flatMap(([from, to]) => {
        const dir = oneWayDir(from, to);
        return dir ? [{ from: dir[0], to: dir[1] }] : [{ from, to }, { from: to, to: from }];
      });
      const markers = buildCrossFloorMarkers(markerPairs, nodePos, resolveNodeLevel, resolveNodeCell, activeFloorIndex, cfg, NODE_RADIUS);
      this.renderCrossFloorMarkers(markers, NODE_RADIUS, highlightColor, highlightColor, highlightColor, true, HIGHLIGHT_WIDTH);
    }

    this.drawNodeDots(highlightedNavEdges.flatMap((e) => [e.path[0], e.path[e.path.length - 1]]), nodePos, highlightColor, HIGHLIGHT_ALPHA);
  }

  clear(): void {
    this.resetContainers();
  }
}
