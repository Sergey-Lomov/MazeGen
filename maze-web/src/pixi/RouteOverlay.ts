import { Graphics } from "pixi.js";
import { NODE_RADIUS } from "./renderConstants";
import type { RouteInfoDto, NodeDto, EdgeDto } from "../wasm/types";
import type { FieldConfig } from "../fieldConfig";
import { buildNodePositions } from "./tessellationGeometry";
import { BaseGraphRenderer, buildCrossFloorMarkers } from "./BaseGraphRenderer";
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
  cfg: FieldConfig;
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

export class RouteOverlay extends BaseGraphRenderer {
  render(data: RouteData): void {
    this.resetContainers();
    const { routeInfo, nodes, edges, cfg, resolveNodeLevel, resolveNodeCell, activeFloorIndex } = data;
    if (routeInfo.path.length < 2) return;

    const directedPairs = edges.filter((e) => e.kind !== "teleport").map((e) => ({ from: e.from, to: e.to }));
    const nodeMap = buildNodePositions(nodes, cfg, directedPairs);

    const positions = routeInfo.path.map((id) => nodeMap.get(id));
    if (positions.filter((p) => p !== undefined).length < 2) return;

    const g = new Graphics();

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
          g.moveTo(positions[segmentStart]!.x, positions[segmentStart]!.y);
          for (let j = segmentStart + 1; j < i; j++) g.lineTo(positions[j]!.x, positions[j]!.y);
        }
        segmentStart = -1;
      }
    }
    g.stroke({ color: ROUTE_LINE_COLOR, width: ROUTE_LINE_WIDTH });
    this.edgesContainer.addChild(g);

    const badgeRadius = ROUTE_DOT_RADIUS * 1.5;
    if (resolveNodeLevel && resolveNodeCell && activeFloorIndex !== undefined) {
      const hopPairs: { from: number; to: number }[] = [];
      for (let i = 1; i < routeInfo.path.length; i++) {
        hopPairs.push({ from: routeInfo.path[i - 1], to: routeInfo.path[i] });
      }
      const markers = buildCrossFloorMarkers(hopPairs, nodeMap, resolveNodeLevel, resolveNodeCell, activeFloorIndex, cfg, badgeRadius);
      // Route's own stub is a plain center-to-center line, no margin trim, no direction arrow —
      // its own visual identity, unlike the other overlays' `drawCrossFloorStub`-based stub.
      const stubs = new Graphics();
      for (const marker of markers) {
        stubs.moveTo(marker.nodePos.x, marker.nodePos.y).lineTo(marker.badgePos.x, marker.badgePos.y)
          .stroke({ width: ROUTE_LINE_WIDTH, color: ROUTE_LINE_COLOR });
        drawCrossFloorBadge(
          this.nodesContainer, marker.badgePos, marker.targetFloorIndex, badgeRadius,
          ROUTE_LINE_COLOR, ROUTE_LINE_COLOR, canvas.floor.default,
        );
      }
      this.edgesContainer.addChild(stubs);
    }

    const dots = new Graphics();
    for (const p of positions) {
      if (!p) continue;
      dots.circle(p.x, p.y, ROUTE_DOT_RADIUS);
    }
    dots.fill(ROUTE_LINE_COLOR);
    this.nodesContainer.addChild(dots);
  }

  clear(): void {
    this.resetContainers();
  }
}
