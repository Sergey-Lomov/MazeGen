import { Container, Graphics } from "pixi.js";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { NODE_RADIUS } from "./renderConstants";
import type { Pos } from "./tessellationGeometry";
import { buildNodePositions } from "./tessellationGeometry";
import { drawOneWayWallHighlight, drawDirectionArrow } from "./renderers/wallUtils";
import { RegionHighlightRenderer } from "./renderers/RegionHighlightRenderer";
import { touchedNodeIds } from "./renderers/edgeUtils";
import { canvas } from "./colorTokens";
import { BaseGraphRenderer, buildCrossFloorMarkers } from "./BaseGraphRenderer";
import type { NodeCellResolver } from "./BaseGraphRenderer";
import type { IssueHighlightEdge } from "../store/postEditFullTypes";

const HIGHLIGHT_COLOR = canvas.debug.issueHighlight;
const HIGHLIGHT_WIDTH = 3;
const HIGHLIGHT_ALPHA = 0.9;

export interface IssueHighlightData {
  nodes: NodeDto[];
  /** Base-graph edges to highlight — typically the loops of a hovered issue, or (GitHub issue
   * #195) a hovered invalid-teleport/teleport-group issue's flagged teleport edge(s). Each edge's
   * own `asWall` (GitHub issue #377) picks line-vs-wall drawing — see `IssueHighlightEdge`. */
  edges: IssueHighlightEdge[] | null;
  /** The maze's full edge list (`state.edges`, not the highlighted subset above) — drives
   *  shape-aware split node-point positioning (GitHub issue #318), see `buildNodePositions`'s own
   *  doc comment. `[]` falls back to the generic hub position. */
  allEdges: EdgeDto[];
  /** SCC regions to highlight, each as its own list of maze node ids — typically the undersized
   * regions of a hovered issue. Kept as separate groups (not one flat list) so each region gets
   * its own perimeter/fill, instead of two adjacent-in-id-space-but-disjoint regions merging into
   * one outline. Mutually exclusive with `edges` in practice (one hover shows one or the other),
   * but both are rendered independently if both happen to be set. */
  regionGroups: number[][] | null;
  cfg: TessellationConfig;
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
}

export class IssueHighlightOverlay extends BaseGraphRenderer {
  private readonly regionContainer: Container;
  private readonly regionRenderer: RegionHighlightRenderer;

  constructor(container: Container) {
    super(container);
    this.regionContainer = new Container();
    this.overlayContainer.addChild(this.regionContainer);
    this.regionRenderer = new RegionHighlightRenderer(this.regionContainer);
  }

  render(data: IssueHighlightData): void {
    this.resetContainers();
    const { nodes, edges, allEdges, regionGroups, cfg, resolveNodeLevel, resolveNodeCell, activeFloorIndex } = data;
    const hasEdges = edges != null && edges.length > 0;
    const hasRegions = regionGroups != null && regionGroups.length > 0 && nodes.length > 0;

    if (hasRegions) {
      this.regionRenderer.render({ nodes, regionGroups, color: HIGHLIGHT_COLOR, width: HIGHLIGHT_WIDTH, alpha: HIGHLIGHT_ALPHA, cfg });
    } else {
      this.regionRenderer.clear();
    }

    if (!hasEdges || nodes.length === 0) return;

    // Wall edges (GitHub issue #377 — e.g. a single flagged invalid_one_way) draw as the shared
    // wall between their two cells instead of a line — no node/cross-floor markers, since the
    // wall segment itself is the marker. Falls back to a line if the two endpoints turn out not
    // to be tessellation-adjacent (no shared wall to draw, e.g. a cross-floor edge whose other
    // endpoint isn't resolvable to a cell here).
    const nodeById = new Map<number, NodeDto>();
    for (const node of nodes) nodeById.set(node.id, node);

    const wallG = new Graphics();
    const lineEdges: IssueHighlightEdge[] = [];
    for (const edge of edges) {
      if (!edge.asWall) {
        lineEdges.push(edge);
        continue;
      }
      const from = nodeById.get(edge.from);
      const to = nodeById.get(edge.to);
      if (!from || !to) {
        lineEdges.push(edge);
        continue;
      }
      const drew = drawOneWayWallHighlight(wallG, [from.x, from.y], [to.x, to.y], cfg, HIGHLIGHT_COLOR, HIGHLIGHT_WIDTH, HIGHLIGHT_ALPHA);
      if (!drew) lineEdges.push(edge);
    }
    this.edgesContainer.addChild(wallG);

    if (lineEdges.length === 0) return;

    const directedPairs = allEdges.filter((e) => e.kind !== "teleport").map((e) => ({ from: e.from, to: e.to }));
    const nodePos: Map<number, Pos> = buildNodePositions(nodes, cfg, directedPairs);
    const linePairs: [number, number][] = lineEdges.map((e) => [e.from, e.to]);

    const g = new Graphics();
    for (const edge of lineEdges) {
      const a = nodePos.get(edge.from);
      const b = nodePos.get(edge.to);
      if (!a || !b) continue;
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke({ width: HIGHLIGHT_WIDTH, color: HIGHLIGHT_COLOR, alpha: HIGHLIGHT_ALPHA });

      // GitHub issue #470: a one-way cycle's edges carry `directed` — draw a direction-of-travel
      // arrow at the edge midpoint even when the underlying edge is bidirectional, so the cycle
      // reads as one-way.
      if (edge.directed) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        if (len > 0) {
          drawDirectionArrow(g, (a.x + b.x) / 2, (a.y + b.y) / 2, dx / len, dy / len, HIGHLIGHT_WIDTH * 2, HIGHLIGHT_COLOR, HIGHLIGHT_ALPHA);
        }
      }
    }
    this.edgesContainer.addChild(g);

    if (resolveNodeLevel && resolveNodeCell && activeFloorIndex !== undefined) {
      const markers = buildCrossFloorMarkers(linePairs.map(([from, to]) => ({ from, to })), nodePos, resolveNodeLevel, resolveNodeCell, activeFloorIndex, cfg, NODE_RADIUS);
      this.renderCrossFloorMarkers(markers, NODE_RADIUS, HIGHLIGHT_COLOR, HIGHLIGHT_COLOR, HIGHLIGHT_COLOR);
    }

    const nodesG = new Graphics();
    for (const nodeId of touchedNodeIds(linePairs)) {
      const pos = nodePos.get(nodeId);
      if (!pos) continue;
      nodesG.circle(pos.x, pos.y, NODE_RADIUS);
      nodesG.fill({ color: HIGHLIGHT_COLOR, alpha: HIGHLIGHT_ALPHA });
    }
    this.nodesContainer.addChild(nodesG);
  }

  clear(): void {
    this.resetContainers();
    this.regionRenderer.clear();
  }

  override destroy(): void {
    super.destroy();
    this.regionRenderer.destroy();
    this.regionContainer.destroy();
  }
}
