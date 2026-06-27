import { Container, Graphics } from "pixi.js";
import type { NodeDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { cellCenter } from "./hexGeometry";
import { NODE_RADIUS } from "./colorUtils";
import type { Pos } from "./tessellationGeometry";
import { getCellVertices } from "./tessellationGeometry";
import { buildRegionGeometry } from "./selectors/issueHighlightSelectors";

const HIGHLIGHT_COLOR = 0xff4444;
const HIGHLIGHT_WIDTH = 3;
const HIGHLIGHT_ALPHA = 0.9;
const REGION_FILL_ALPHA = 0.25;

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

  constructor(container: Container) {
    this.container = container;
  }

  render(data: IssueHighlightData): void {
    this.clear();
    const { nodes, edges, regionGroups, cfg } = data;
    const hasEdges = edges != null && edges.length > 0;
    const hasRegions = regionGroups != null && regionGroups.length > 0;
    if ((!hasEdges && !hasRegions) || nodes.length === 0) return;

    const g = new Graphics();

    if (hasEdges) {
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
    }

    if (hasRegions) {
      for (const group of regionGroups) {
        this.drawRegion(g, group, nodes, cfg);
      }
    }

    this.container.addChild(g);
    this.graphics = g;
  }

  /// Fills the region's cells and draws its perimeter, each region treated as its own isolated
  /// cell set — two separate regions never get merged into one shared boundary. Geometry
  /// (cell list + perimeter segments) comes from `buildRegionGeometry` (pure, unit-tested); this
  /// method only draws it.
  private drawRegion(g: Graphics, regionNodeIds: number[], nodes: NodeDto[], cfg: TessellationConfig): void {
    const { cells, perimeterSegments } = buildRegionGeometry(regionNodeIds, nodes, cfg);

    for (const [x, y] of cells) {
      const verts = getCellVertices(x, y, cfg);
      if (verts) {
        g.poly(verts.flatMap(v => [v.x, v.y])).fill({ color: HIGHLIGHT_COLOR, alpha: REGION_FILL_ALPHA });
      }
    }

    for (const seg of perimeterSegments) {
      g.moveTo(seg.v0.x, seg.v0.y);
      g.lineTo(seg.v1.x, seg.v1.y);
      g.stroke({ width: HIGHLIGHT_WIDTH, color: HIGHLIGHT_COLOR, alpha: HIGHLIGHT_ALPHA });
    }
  }

  clear(): void {
    if (this.graphics) {
      this.graphics.destroy();
      this.graphics = null;
    }
  }

  destroy(): void {
    this.clear();
  }
}
