import { Container, Graphics } from "pixi.js";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { NODE_RADIUS } from "./renderConstants";
import type { Pos } from "./tessellationGeometry";
import { buildNodePositions } from "./tessellationGeometry";
import { RegionHighlightRenderer } from "./renderers/RegionHighlightRenderer";
import { touchedNodeIds } from "./renderers/edgeUtils";
import { canvas } from "./colorTokens";

const HIGHLIGHT_COLOR = canvas.debug.issueHighlight;
const HIGHLIGHT_WIDTH = 3;
const HIGHLIGHT_ALPHA = 0.9;

export interface IssueHighlightData {
  nodes: NodeDto[];
  /** Base-graph [from, to] edges to highlight — typically the loops of a hovered issue, or (GitHub
   * issue #195) a hovered invalid-teleport/teleport-group issue's flagged teleport edge(s). */
  edges: [number, number][] | null;
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
}

export class IssueHighlightOverlay {
  private container: Container;
  private graphics: Graphics | null = null;
  private readonly regionContainer: Container;
  private readonly regionRenderer: RegionHighlightRenderer;

  constructor(container: Container) {
    this.container = container;
    this.regionContainer = new Container();
    this.container.addChild(this.regionContainer);
    this.regionRenderer = new RegionHighlightRenderer(this.regionContainer);
  }

  render(data: IssueHighlightData): void {
    this.clearEdges();
    const { nodes, edges, allEdges, regionGroups, cfg } = data;
    const hasEdges = edges != null && edges.length > 0;
    const hasRegions = regionGroups != null && regionGroups.length > 0 && nodes.length > 0;

    if (hasRegions) {
      this.regionRenderer.render({ nodes, regionGroups, color: HIGHLIGHT_COLOR, width: HIGHLIGHT_WIDTH, alpha: HIGHLIGHT_ALPHA, cfg });
    } else {
      this.regionRenderer.clear();
    }

    if (!hasEdges || nodes.length === 0) return;

    const g = new Graphics();

    const directedPairs = allEdges.filter((e) => e.kind !== "teleport").map((e) => ({ from: e.from, to: e.to }));
    const nodePos: Map<number, Pos> = buildNodePositions(nodes, cfg, directedPairs);

    for (const [from, to] of edges) {
      const a = nodePos.get(from);
      const b = nodePos.get(to);
      if (!a || !b) continue;
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke({ width: HIGHLIGHT_WIDTH, color: HIGHLIGHT_COLOR, alpha: HIGHLIGHT_ALPHA });
    }

    for (const nodeId of touchedNodeIds(edges)) {
      const pos = nodePos.get(nodeId);
      if (!pos) continue;
      g.circle(pos.x, pos.y, NODE_RADIUS);
      g.fill({ color: HIGHLIGHT_COLOR, alpha: HIGHLIGHT_ALPHA });
    }

    this.container.addChild(g);
    this.graphics = g;
  }

  private clearEdges(): void {
    if (this.graphics) {
      this.graphics.destroy();
      this.graphics = null;
    }
  }

  clear(): void {
    this.clearEdges();
    this.regionRenderer.clear();
  }

  destroy(): void {
    this.clear();
    this.regionRenderer.destroy();
    this.regionContainer.destroy();
  }
}
