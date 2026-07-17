import { Container, Graphics } from "pixi.js";
import type { NodeDto, NavEdgeDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { cellCenter } from "./hexGeometry";
import { NODE_RADIUS } from "./renderConstants";
import { canvas } from "./colorTokens";
import { drawDirectionArrow } from "./renderers/wallUtils";
import { TILE_SIZE } from "./constants";

const PURE_NODE_COLOR = canvas.node.start;
const PURE_EDGE_COLOR = canvas.node.start;
const PURE_NODE_ALPHA = 1.0;
const PURE_EDGE_WIDTH = 2;

export interface PureCyclesData {
  nodes: NodeDto[];
  navEdges: NavEdgeDto[];
  /** Set of maze node ids in the pure-cycle core. */
  pureCycleNodeIds: Set<number>;
  /** Set of "from_maze_id,to_maze_id" keys for pure-cycle edges. */
  pureCycleEdgeKeys: Set<string>;
  cfg: TessellationConfig;
}

interface Pos { x: number; y: number; }

export class PureCyclesOverlay {
  private container: Container;
  private graphics: Graphics | null = null;

  constructor(container: Container) {
    this.container = container;
  }

  render(data: PureCyclesData): void {
    this.clear();
    const { nodes, navEdges, pureCycleNodeIds, pureCycleEdgeKeys, cfg } = data;
    if (nodes.length === 0) return;

    const nodePos = new Map<number, Pos>();
    for (const node of nodes) nodePos.set(node.id, cellCenter(node, cfg));

    const g = new Graphics();

    // Track which directed edges exist (for one-way arrow logic).
    const allNavEdgeKeys = new Set<string>();
    for (const e of navEdges) {
      allNavEdgeKeys.add(`${e.path[0]},${e.path[e.path.length - 1]}`);
    }

    for (const e of navEdges) {
      const fromId = e.path[0];
      const toId = e.path[e.path.length - 1];
      const edgeKey = `${fromId},${toId}`;
      if (!pureCycleEdgeKeys.has(edgeKey)) continue;

      const path = e.path.map(nid => nodePos.get(nid)).filter((p): p is Pos => p !== undefined);
      if (path.length < 2) continue;

      const first = path[0];
      const last = path[path.length - 1];
      const dxStart = path[1].x - first.x;
      const dyStart = path[1].y - first.y;
      const dxEnd = last.x - path[path.length - 2].x;
      const dyEnd = last.y - path[path.length - 2].y;
      const lenStart = Math.sqrt(dxStart * dxStart + dyStart * dyStart);
      const lenEnd = Math.sqrt(dxEnd * dxEnd + dyEnd * dyEnd);
      if (lenStart < 1 || lenEnd < 1) continue;

      const margin = NODE_RADIUS + 1;
      const startPt: Pos = { x: first.x + (dxStart / lenStart) * margin, y: first.y + (dyStart / lenStart) * margin };
      const endPt: Pos = { x: last.x - (dxEnd / lenEnd) * margin, y: last.y - (dyEnd / lenEnd) * margin };

      g.moveTo(startPt.x, startPt.y);
      for (let i = 1; i < path.length - 1; i++) g.lineTo(path[i].x, path[i].y);
      g.lineTo(endPt.x, endPt.y);
      g.stroke({ width: PURE_EDGE_WIDTH, color: PURE_EDGE_COLOR });

      // Arrow for one-way edges (no reverse in nav edges).
      const hasReverse = allNavEdgeKeys.has(`${toId},${fromId}`);
      if (!hasReverse) {
        const midX = (startPt.x + endPt.x) / 2;
        const midY = (startPt.y + endPt.y) / 2;
        const edgeLen = Math.sqrt((endPt.x - startPt.x) ** 2 + (endPt.y - startPt.y) ** 2);
        if (edgeLen >= 1) {
          const ux = (endPt.x - startPt.x) / edgeLen;
          const uy = (endPt.y - startPt.y) / edgeLen;
          drawDirectionArrow(g, midX, midY, ux, uy, TILE_SIZE * 0.18, PURE_EDGE_COLOR);
        }
      }
    }

    // Draw nodes.
    for (const nodeId of pureCycleNodeIds) {
      const pos = nodePos.get(nodeId);
      if (!pos) continue;
      g.circle(pos.x, pos.y, NODE_RADIUS);
      g.fill({ color: PURE_NODE_COLOR, alpha: PURE_NODE_ALPHA });
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
