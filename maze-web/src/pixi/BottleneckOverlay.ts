import { Container, Graphics } from "pixi.js";
import { cellCenter } from "./hexGeometry";
import { NODE_RADIUS } from "./colorUtils";
import type { NodeDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";

const HARD_COLOR = 0xff3333;
const SOFT_COLOR = 0xff9933;
const HARD_RADIUS = NODE_RADIUS * 0.9;
const SOFT_RADIUS = NODE_RADIUS * 0.7;
const HARD_ALPHA = 0.85;
const SOFT_ALPHA = 0.6;

export interface BottleneckData {
  hardNodeIds: number[];
  softNodeIds: number[];
  nodes: NodeDto[];
  cfg: TessellationConfig;
}

export class BottleneckOverlay {
  private g: Graphics;

  constructor(container: Container) {
    this.g = new Graphics();
    container.addChild(this.g);
  }

  render(data: BottleneckData): void {
    const { hardNodeIds, softNodeIds, nodes, cfg } = data;
    this.g.clear();

    const nodeMap = new Map<number, { x: number; y: number }>();
    for (const n of nodes) nodeMap.set(n.id, cellCenter(n, cfg));

    for (const id of softNodeIds) {
      const pos = nodeMap.get(id);
      if (!pos) continue;
      this.g.circle(pos.x, pos.y, SOFT_RADIUS);
    }
    this.g.fill({ color: SOFT_COLOR, alpha: SOFT_ALPHA });

    for (const id of hardNodeIds) {
      const pos = nodeMap.get(id);
      if (!pos) continue;
      this.g.circle(pos.x, pos.y, HARD_RADIUS);
    }
    this.g.fill({ color: HARD_COLOR, alpha: HARD_ALPHA });
  }

  clear(): void {
    this.g.clear();
  }

  destroy(): void {
    this.g.destroy();
  }
}
