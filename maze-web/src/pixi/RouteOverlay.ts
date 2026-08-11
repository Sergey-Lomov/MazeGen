import { Container, Graphics } from "pixi.js";
import { NODE_RADIUS } from "./renderConstants";
import type { RouteInfoDto, NodeDto, EdgeDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { buildNodePositions } from "./tessellationGeometry";

const ROUTE_LINE_COLOR = 0xffdd44;
const ROUTE_LINE_WIDTH = 3;
const ROUTE_DOT_RADIUS = NODE_RADIUS * 0.55;

export interface RouteData {
  routeInfo: RouteInfoDto;
  nodes: NodeDto[];
  /** The maze's full base-graph edges — drives shape-aware split node-point positioning (GitHub
   *  issue #318), see `buildNodePositions`'s own doc comment. `[]` falls back to the generic hub
   *  position. */
  edges: EdgeDto[];
  cfg: TessellationConfig;
}

export class RouteOverlay {
  private g: Graphics;

  constructor(container: Container) {
    this.g = new Graphics();
    container.addChild(this.g);
  }

  render(data: RouteData): void {
    const { routeInfo, nodes, edges, cfg } = data;
    this.g.clear();
    if (routeInfo.path.length < 2) return;

    const directedPairs = edges.filter((e) => e.kind !== "teleport").map((e) => ({ from: e.from, to: e.to }));
    const nodeMap = buildNodePositions(nodes, cfg, directedPairs);

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

  clear(): void {
    this.g.clear();
  }

  destroy(): void {
    this.g.destroy();
  }
}
