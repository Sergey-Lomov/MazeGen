import type { NodeDto, EdgeDto, NavNodeDto, NavEdgeDto } from "../wasm/types";
import type { FieldConfig } from "../fieldConfig";
import { NODE_RADIUS } from "./renderConstants";
import { canvas } from "./colorTokens";
import { BaseGraphRenderer, buildPathRenderEdges, buildCrossFloorMarkers } from "./BaseGraphRenderer";
import type { RenderNode, NodeCellResolver } from "./BaseGraphRenderer";
import { buildNodePositions } from "./tessellationGeometry";

export interface NavGraphData {
  nodes: NodeDto[];
  navNodes: NavNodeDto[];
  navEdges: NavEdgeDto[];
  /** The maze's full base-graph edges — drives shape-aware split node-point positioning (GitHub
   *  issue #318), see `buildNodePositions`'s own doc comment. `[]` falls back to the generic hub
   *  position. */
  edges: EdgeDto[];
  start: number | null;
  finish: number | null;
  cfg: FieldConfig;
  /** Resolves a node id's own floor (`selectNodeLevelResolver`, built from the *unscoped* node
   *  list) — needed to detect a nav-edge whose other endpoint crosses to another floor (GitHub
   *  issue #339). Omitted callers draw no cross-floor badges (same as passing an always-`undefined`
   *  resolver). */
  resolveNodeLevel?: (id: number) => number | undefined;
  /** Resolves a node id's own cell coordinate, from the *unscoped* node list — needed alongside
   *  `resolveNodeLevel` to place a cross-floor badge (GitHub issue #339, see
   *  `computeCrossFloorBadgePos`). */
  resolveNodeCell?: NodeCellResolver;
  /** The active floor's own `levels_ordered()` index — required alongside `resolveNodeLevel` to
   *  tell a same-floor endpoint from a genuinely cross-floor one. */
  activeFloorIndex?: number;
}

export class NavGraphRenderer extends BaseGraphRenderer {
  render(data: NavGraphData): void {
    this.resetContainers();
    if (data.nodes.length === 0) return;

    const { nodes, navNodes, navEdges, edges, start, finish, cfg, resolveNodeLevel, resolveNodeCell, activeFloorIndex } = data;
    const directedPairs = edges.filter((e) => e.kind !== "teleport").map((e) => ({ from: e.from, to: e.to }));
    const nodePos = buildNodePositions(nodes, cfg, directedPairs);

    const renderEdges = buildPathRenderEdges(navEdges, nodePos);
    this.drawEdges(renderEdges, canvas.edge.default);

    const navNodeIds = new Set(navNodes.map(n => n.node_id));
    const renderNodes: RenderNode[] = [];
    for (const nid of navNodeIds) {
      const pos = nodePos.get(nid);
      if (pos) renderNodes.push({ id: nid, pos });
    }

    this.drawNodes(renderNodes, null, start, finish, false);

    if (resolveNodeLevel && resolveNodeCell && activeFloorIndex !== undefined) {
      const hopPairs = navEdges.map((e) => ({ from: e.path[0], to: e.path[e.path.length - 1] }));
      const markers = buildCrossFloorMarkers(hopPairs, nodePos, resolveNodeLevel, resolveNodeCell, activeFloorIndex, cfg, NODE_RADIUS);
      this.renderCrossFloorMarkers(markers, NODE_RADIUS);
    }
  }

  clear(): void {
    this.resetContainers();
  }
}
