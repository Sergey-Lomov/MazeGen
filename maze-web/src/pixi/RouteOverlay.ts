import { Container, Graphics } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import { cellCenter } from "./hexGeometry";
import { NODE_RADIUS } from "./constants";
import type { RouteInfoDto, TessellationConfig, NodeDto } from "../wasm/types";

const ROUTE_LINE_COLOR = 0xffdd44;
const ROUTE_LINE_WIDTH = 3;
const ROUTE_DOT_RADIUS = NODE_RADIUS * 0.55;

export class RouteOverlay {
  private g: Graphics;
  private unsubscribe: (() => void) | null = null;

  constructor(container: Container) {
    this.g = new Graphics();
    container.addChild(this.g);

    const state = useMazeStore.getState();
    let prevRouteInfo = state.routeInfo;
    let prevNodes = state.nodes;
    let prevCfg = state.activeTessellationConfig;
    let prevShowRoute = state.showRoute;

    this.draw(state.routeInfo, state.nodes, state.activeTessellationConfig, state.showRoute);

    this.unsubscribe = useMazeStore.subscribe((s) => {
      if (
        s.routeInfo === prevRouteInfo &&
        s.nodes === prevNodes &&
        s.activeTessellationConfig === prevCfg &&
        s.showRoute === prevShowRoute
      ) return;
      prevRouteInfo = s.routeInfo;
      prevNodes = s.nodes;
      prevCfg = s.activeTessellationConfig;
      prevShowRoute = s.showRoute;
      this.draw(s.routeInfo, s.nodes, s.activeTessellationConfig, s.showRoute);
    });
  }

  private draw(
    routeInfo: RouteInfoDto | null,
    nodes: NodeDto[],
    cfg: TessellationConfig,
    showRoute: boolean,
  ): void {
    this.g.clear();
    if (!showRoute || !routeInfo || routeInfo.path.length < 2) return;

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
    this.unsubscribe?.();
    this.g.destroy();
  }
}
