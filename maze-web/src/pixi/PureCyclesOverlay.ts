import { Graphics } from "pixi.js";
import type { NodeDto, EdgeDto, NavEdgeDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { NODE_RADIUS } from "./renderConstants";
import { canvas } from "./colorTokens";
import { buildNodePositions } from "./tessellationGeometry";
import { BaseGraphRenderer, buildCrossFloorMarkers, buildPathRenderEdges } from "./BaseGraphRenderer";
import type { NodeCellResolver, Pos } from "./BaseGraphRenderer";

const PURE_NODE_COLOR = canvas.node.start;
const PURE_EDGE_COLOR = canvas.node.start;
const PURE_NODE_ALPHA = 1.0;

export interface PureCyclesData {
  nodes: NodeDto[];
  navEdges: NavEdgeDto[];
  /** The maze's full base-graph edges — drives shape-aware split node-point positioning (GitHub
   *  issue #318), see `buildNodePositions`'s own doc comment. `[]` falls back to the generic hub
   *  position. */
  edges: EdgeDto[];
  /** Set of maze node ids in the pure-cycle core. */
  pureCycleNodeIds: Set<number>;
  /** Set of "from_maze_id,to_maze_id" keys for pure-cycle edges. */
  pureCycleEdgeKeys: Set<string>;
  cfg: TessellationConfig;
  /** Resolves a node id's own floor (`selectNodeLevelResolver`, built from the *unscoped* node
   *  list) — needed to detect a pure-cycle edge whose other endpoint crosses to another floor
   *  (GitHub issue #339). Omitted callers draw no cross-floor badges. */
  resolveNodeLevel?: (id: number) => number | undefined;
  /** Resolves a node id's own cell coordinate, from the *unscoped* node list — needed alongside
   *  `resolveNodeLevel` to place a cross-floor badge (GitHub issue #339). */
  resolveNodeCell?: NodeCellResolver;
  /** The active floor's own `levels_ordered()` index — required alongside `resolveNodeLevel`. */
  activeFloorIndex?: number;
}

export class PureCyclesOverlay extends BaseGraphRenderer {
  render(data: PureCyclesData): void {
    this.resetContainers();
    const { nodes, navEdges, edges, pureCycleNodeIds, pureCycleEdgeKeys, cfg, resolveNodeLevel, resolveNodeCell, activeFloorIndex } = data;
    if (nodes.length === 0) return;

    const directedPairs = edges.filter((e) => e.kind !== "teleport").map((e) => ({ from: e.from, to: e.to }));
    const nodePos: Map<number, Pos> = buildNodePositions(nodes, cfg, directedPairs);

    const pureCycleNavEdges = navEdges.filter((e) => {
      const fromId = e.path[0];
      const toId = e.path[e.path.length - 1];
      return pureCycleEdgeKeys.has(`${fromId},${toId}`);
    });
    // `hasReverse` is checked against the *full* nav-edge graph (`reverseCheckEdges`), not just
    // the pure-cycle subset — a pure-cycle edge's reverse direction can exist among nav edges
    // without itself being part of the pure-cycle set, and should still suppress the one-way arrow.
    const renderEdges = buildPathRenderEdges(pureCycleNavEdges, nodePos, navEdges);
    this.drawEdges(renderEdges, PURE_EDGE_COLOR);

    if (resolveNodeLevel && resolveNodeCell && activeFloorIndex !== undefined) {
      const pureCycleHopPairs = pureCycleNavEdges.map((e) => ({ from: e.path[0], to: e.path[e.path.length - 1] }));
      const markers = buildCrossFloorMarkers(pureCycleHopPairs, nodePos, resolveNodeLevel, resolveNodeCell, activeFloorIndex, cfg, NODE_RADIUS);
      this.renderCrossFloorMarkers(markers, NODE_RADIUS, PURE_EDGE_COLOR, PURE_EDGE_COLOR, PURE_EDGE_COLOR);
    }

    const g = new Graphics();
    for (const nodeId of pureCycleNodeIds) {
      const pos = nodePos.get(nodeId);
      if (!pos) continue;
      g.circle(pos.x, pos.y, NODE_RADIUS);
      g.fill({ color: PURE_NODE_COLOR, alpha: PURE_NODE_ALPHA });
    }
    this.nodesContainer.addChild(g);
  }

  clear(): void {
    this.resetContainers();
  }
}
