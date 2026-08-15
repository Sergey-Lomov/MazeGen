import { Container, Graphics } from "pixi.js";
import { NODE_RADIUS } from "./renderConstants";
import type { RouteInfoDto, NodeDto, EdgeDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { buildNodePositions } from "./tessellationGeometry";
import { buildCrossFloorMarkers } from "./BaseGraphRenderer";
import type { NodeCellResolver } from "./BaseGraphRenderer";
import { drawCrossFloorBadge } from "./renderers/floorBadge";
import { canvas } from "./colorTokens";

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
  /** Resolves a node id's own floor (`selectNodeLevelResolver`, built from the *unscoped* node
   *  list) — needed to detect a route hop whose other endpoint crosses to another floor (GitHub
   *  issue #339). Omitted callers draw no cross-floor badges. */
  resolveNodeLevel?: (id: number) => number | undefined;
  /** Resolves a node id's own cell coordinate, from the *unscoped* node list — needed alongside
   *  `resolveNodeLevel` to place a cross-floor badge (GitHub issue #339). */
  resolveNodeCell?: NodeCellResolver;
  /** The active floor's own `levels_ordered()` index — required alongside `resolveNodeLevel`. */
  activeFloorIndex?: number;
}

export class RouteOverlay {
  private container: Container;
  private g: Graphics;
  private badgesContainer: Container;

  constructor(container: Container) {
    this.container = container;
    this.g = new Graphics();
    container.addChild(this.g);
    this.badgesContainer = new Container();
    container.addChild(this.badgesContainer);
  }

  render(data: RouteData): void {
    const { routeInfo, nodes, edges, cfg, resolveNodeLevel, resolveNodeCell, activeFloorIndex } = data;
    this.g.clear();
    this.clearBadges();
    if (routeInfo.path.length < 2) return;

    const directedPairs = edges.filter((e) => e.kind !== "teleport").map((e) => ({ from: e.from, to: e.to }));
    const nodeMap = buildNodePositions(nodes, cfg, directedPairs);

    const positions = routeInfo.path.map((id) => nodeMap.get(id));
    if (positions.filter((p) => p !== undefined).length < 2) return;

    // Draw each maximal run of on-floor positions as its own polyline segment — a gap in `positions`
    // (a hop through an off-floor node) must NOT connect the runs on either side of it directly,
    // that hop is instead represented by its own cross-floor badge below.
    let segmentStart = -1;
    for (let i = 0; i <= positions.length; i++) {
      const p = i < positions.length ? positions[i] : undefined;
      if (p) {
        if (segmentStart === -1) segmentStart = i;
      } else if (segmentStart !== -1) {
        if (i - segmentStart >= 2) {
          this.g.moveTo(positions[segmentStart]!.x, positions[segmentStart]!.y);
          for (let j = segmentStart + 1; j < i; j++) this.g.lineTo(positions[j]!.x, positions[j]!.y);
        }
        segmentStart = -1;
      }
    }
    this.g.stroke({ color: ROUTE_LINE_COLOR, width: ROUTE_LINE_WIDTH });

    let markers: ReturnType<typeof buildCrossFloorMarkers> = [];
    let badgeRadius = ROUTE_DOT_RADIUS * 1.5;
    if (resolveNodeLevel && resolveNodeCell && activeFloorIndex !== undefined) {
      const hopPairs: { from: number; to: number }[] = [];
      for (let i = 1; i < routeInfo.path.length; i++) {
        hopPairs.push({ from: routeInfo.path[i - 1], to: routeInfo.path[i] });
      }
      markers = buildCrossFloorMarkers(hopPairs, nodeMap, resolveNodeLevel, resolveNodeCell, activeFloorIndex, cfg, badgeRadius);
      for (const marker of markers) {
        this.g.moveTo(marker.nodePos.x, marker.nodePos.y).lineTo(marker.badgePos.x, marker.badgePos.y)
          .stroke({ width: ROUTE_LINE_WIDTH, color: ROUTE_LINE_COLOR });
      }
    }

    for (const p of positions) {
      if (!p) continue;
      this.g.circle(p.x, p.y, ROUTE_DOT_RADIUS);
    }
    this.g.fill(ROUTE_LINE_COLOR);

    for (const marker of markers) {
      drawCrossFloorBadge(
        this.badgesContainer, marker.badgePos, marker.targetFloorIndex, badgeRadius,
        ROUTE_LINE_COLOR, ROUTE_LINE_COLOR, canvas.floor.default,
      );
    }
  }

  private clearBadges(): void {
    this.badgesContainer.destroy({ children: true });
    this.badgesContainer = new Container();
    this.container.addChild(this.badgesContainer);
  }

  clear(): void {
    this.g.clear();
    this.clearBadges();
  }

  destroy(): void {
    this.g.destroy();
    this.badgesContainer.destroy({ children: true });
  }
}
