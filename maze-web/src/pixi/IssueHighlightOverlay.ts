import { Container, Graphics } from "pixi.js";
import type { NodeDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { cellCenter } from "./hexGeometry";
import { NODE_RADIUS } from "./colorUtils";

const HIGHLIGHT_COLOR = 0xff4444;
const HIGHLIGHT_WIDTH = 3;
const HIGHLIGHT_ALPHA = 0.9;

export interface IssueHighlightData {
  nodes: NodeDto[];
  /** Base-graph [from, to] edges to highlight — typically the loops of a hovered issue. */
  edges: [number, number][] | null;
  cfg: TessellationConfig;
}

interface Pos { x: number; y: number; }

export class IssueHighlightOverlay {
  private container: Container;
  private graphics: Graphics | null = null;

  constructor(container: Container) {
    this.container = container;
  }

  render(data: IssueHighlightData): void {
    this.clear();
    const { nodes, edges, cfg } = data;
    if (!edges || edges.length === 0 || nodes.length === 0) return;

    const nodePos = new Map<number, Pos>();
    for (const node of nodes) nodePos.set(node.id, cellCenter(node, cfg));

    const g = new Graphics();

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
