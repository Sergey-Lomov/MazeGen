import { Container, Graphics } from "pixi.js";
import { cellCenter } from "./hexGeometry";
import { NODE_RADIUS } from "./colorUtils";
import type { RouteInfoDto, NodeDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";

const ROUTE_LINE_COLOR = 0xffdd44;
const ROUTE_LINE_WIDTH = 3;
const ROUTE_DOT_RADIUS = NODE_RADIUS * 0.55;

export interface RouteData {
  routeInfo: RouteInfoDto | null;
  nodes: NodeDto[];
  cfg: TessellationConfig;
}

export class RouteOverlay {
  private g: Graphics;

  constructor(container: Container) {
    this.g = new Graphics();
    container.addChild(this.g);
  }

  render(data: RouteData): void {
    const { routeInfo, nodes, cfg } = data;
    this.g.clear();
    if (!routeInfo || routeInfo.path.length < 2) return;

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
    this.g.stroke({ color: ROUTE_LINE_COLOR, width: ROUTE_LINE_WIDTH });

    for (const p of positions) {
      this.g.circle(p.x, p.y, ROUTE_DOT_RADIUS);
    }
    this.g.fill(ROUTE_LINE_COLOR);
  }

  destroy(): void {
    this.g.destroy();
  }
}
