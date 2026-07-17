import { Container, Graphics } from "pixi.js";
import type { NodeDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { cellCenter } from "./hexGeometry";
import { NODE_RADIUS } from "./sizing";
import type { Pos } from "./tessellationGeometry";
import { RegionHighlightRenderer } from "./renderers/RegionHighlightRenderer";

const HIGHLIGHT_COLOR = 0xff4444;
const HIGHLIGHT_WIDTH = 3;
const HIGHLIGHT_ALPHA = 0.9;

export interface IssueHighlightData {
  nodes: NodeDto[];
  /** Base-graph [from, to] edges to highlight — typically the loops of a hovered issue. */
  edges: [number, number][] | null;
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
    const { nodes, edges, regionGroups, cfg } = data;
    const hasEdges = edges != null && edges.length > 0;
    const hasRegions = regionGroups != null && regionGroups.length > 0 && nodes.length > 0;

    if (hasRegions) {
      this.regionRenderer.render({ nodes, regionGroups, color: HIGHLIGHT_COLOR, width: HIGHLIGHT_WIDTH, alpha: HIGHLIGHT_ALPHA, cfg });
    } else {
      this.regionRenderer.clear();
    }

    if (!hasEdges || nodes.length === 0) return;

    const g = new Graphics();

    const nodePos = new Map<number, Pos>();
    for (const node of nodes) nodePos.set(node.id, cellCenter(node, cfg));

    for (const [from, to] of edges) {
      const a = nodePos.get(from);
      const b = nodePos.get(to);
      if (!a || !b) continue;
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke({ width: HIGHLIGHT_WIDTH, color: HIGHLIGHT_COLOR, alpha: HIGHLIGHT_ALPHA });
    }

    const touchedNodeIds = new Set<number>();
    for (const [from, to] of edges) {
      touchedNodeIds.add(from);
      touchedNodeIds.add(to);
    }
    for (const nodeId of touchedNodeIds) {
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
