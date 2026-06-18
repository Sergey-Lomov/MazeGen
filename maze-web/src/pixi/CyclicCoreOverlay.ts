import { Container, Graphics } from "pixi.js";
import type { NodeDto, NavNodeDto, NavEdgeDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { cellCenter } from "./hexGeometry";
import { NODE_RADIUS } from "./colorUtils";
import { drawDirectionArrow } from "./renderers/wallUtils";
import { TILE_SIZE } from "./constants";

const CYCLIC_NODE_COLOR  = 0x44dd88;
const CYCLIC_EDGE_COLOR  = 0x44dd88;
const DIM_NODE_COLOR     = 0x333333;
const DIM_EDGE_COLOR     = 0x2a2a2a;
const CYCLIC_NODE_ALPHA  = 1.0;
const DIM_NODE_ALPHA     = 0.5;
const CYCLIC_EDGE_WIDTH  = 2;
const DIM_EDGE_WIDTH     = 1;

export interface CyclicCoreData {
  nodes: NodeDto[];
  navNodes: NavNodeDto[];
  navEdges: NavEdgeDto[];
  /** Set of maze node ids in cyclic SCCs. */
  cyclicNodeIds: Set<number>;
  cfg: TessellationConfig;
}

interface Pos { x: number; y: number; }

export class CyclicCoreOverlay {
  private container: Container;
  private graphics: Graphics | null = null;

  constructor(container: Container) {
    this.container = container;
  }

  render(data: CyclicCoreData): void {
    this.clear();
    const { nodes, navNodes, navEdges, cyclicNodeIds, cfg } = data;
    if (nodes.length === 0) return;

    const nodePos = new Map<number, Pos>();
    for (const node of nodes) nodePos.set(node.id, cellCenter(node, cfg));


    const g = new Graphics();

    // Draw edges — cyclic if both endpoints are in cyclic set.
    const edgeKeys = new Set<string>();
    for (const e of navEdges) {
      edgeKeys.add(`${e.path[0]}->${e.path[e.path.length - 1]}`);
    }

    for (const e of navEdges) {
      const path = e.path.map(nid => nodePos.get(nid)).filter((p): p is Pos => p !== undefined);
      if (path.length < 2) continue;

      const fromId = e.path[0];
      const toId = e.path[e.path.length - 1];
      const isCyclic = cyclicNodeIds.has(fromId) && cyclicNodeIds.has(toId);
      const hasReverse = edgeKeys.has(`${toId}->${fromId}`);

      if (!isCyclic) continue;
      const color = CYCLIC_EDGE_COLOR;
      const width = CYCLIC_EDGE_WIDTH;

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
      g.stroke({ width, color });

      if (!hasReverse && isCyclic) {
        const midX = (startPt.x + endPt.x) / 2;
        const midY = (startPt.y + endPt.y) / 2;
        const edgeLen = Math.sqrt((endPt.x - startPt.x) ** 2 + (endPt.y - startPt.y) ** 2);
        if (edgeLen >= 1) {
          const ux = (endPt.x - startPt.x) / edgeLen;
          const uy = (endPt.y - startPt.y) / edgeLen;
          drawDirectionArrow(g, midX, midY, ux, uy, TILE_SIZE * 0.18, color);
        }
      }
    }

    // Draw nodes.
    for (const navNode of navNodes) {
      const pos = nodePos.get(navNode.node_id);
      if (!pos) continue;
      if (!cyclicNodeIds.has(navNode.node_id)) continue;
      g.circle(pos.x, pos.y, NODE_RADIUS);
      g.fill({ color: CYCLIC_NODE_COLOR, alpha: CYCLIC_NODE_ALPHA });
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
