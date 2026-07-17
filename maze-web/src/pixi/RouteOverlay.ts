import { Container, Graphics } from "pixi.js";
import { cellCenter } from "./hexGeometry";
import { NODE_RADIUS, adaptiveLineWidth } from "./sizing";
import type { RouteInfoDto, NodeDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";

const ROUTE_LINE_COLOR = 0xffdd44;
const ROUTE_LINE_WIDTH = 3;
const ROUTE_DOT_RADIUS = NODE_RADIUS * 0.55;

export interface RouteData {
  routeInfo: RouteInfoDto;
  nodes: NodeDto[];
  cfg: TessellationConfig;
  vpScale?: number;
}

export class RouteOverlay {
  private g: Graphics;

  constructor(container: Container) {
    this.g = new Graphics();
    container.addChild(this.g);
  }

  render(data: RouteData): void {
    const { routeInfo, nodes, cfg, vpScale = 1 } = data;
    this.g.clear();
    if (routeInfo.path.length < 2) return;

    const nodeMap = new Map<number, { x: number; y: number }>();
    for (const n of nodes) nodeMap.set(n.id, cellCenter(n, cfg));

    const positions = routeInfo.path
      .map((id) => nodeMap.get(id))
      .filter((p): p is { x: number; y: number } => p !== undefined);

    if (positions.length < 2) return;

    this.g.moveTo(positions[0].x, positions[0].y);
    for (let i = 1; i < positions.length; i++) {
      this.g.lineTo(positions[i].x, positions[i].y);
    }
    this.g.stroke({ color: ROUTE_LINE_COLOR, width: adaptiveLineWidth(vpScale, ROUTE_LINE_WIDTH) });

    const dotRadius = adaptiveLineWidth(vpScale, ROUTE_DOT_RADIUS);
    for (const p of positions) {
      this.g.circle(p.x, p.y, dotRadius);
    }
    this.g.fill(ROUTE_LINE_COLOR);
  }

  clear(): void {
    this.g.clear();
  }

  destroy(): void {
    this.g.destroy();
  }
}
