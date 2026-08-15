import { Graphics, Text, TextStyle } from "pixi.js";
import type { NodeDto, EdgeDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { NODE_RADIUS } from "./renderConstants";
import { canvas } from "./colorTokens";
import { base, hexToNumber } from "../styles/palette";
import { BaseGraphRenderer, nodeColor, nodeRadius, buildPairedRenderEdges, buildCrossFloorMarkers } from "./BaseGraphRenderer";
import type { RenderNode, NodeCellResolver } from "./BaseGraphRenderer";
import { buildNodePositions } from "./tessellationGeometry";

const LABEL_STYLE = new TextStyle({ fontSize: 9, fill: hexToNumber(base.textInverse) });

export interface MazeGraphData {
  nodes: NodeDto[];
  edges: EdgeDto[];
  showNodeIds: boolean;
  showCoords: boolean;
  selectedNode: number | null;
  start: number | null;
  finish: number | null;
  cfg: TessellationConfig;
  interactive?: boolean;
  /** Resolves a node id's own floor (`selectNodeLevelResolver`, built from the *unscoped* node
   *  list) — needed to detect a base-graph edge whose other endpoint crosses to another floor
   *  (GitHub issue #339). Omitted callers draw no cross-floor badges. */
  resolveNodeLevel?: (id: number) => number | undefined;
  /** Resolves a node id's own cell coordinate, from the *unscoped* node list — needed alongside
   *  `resolveNodeLevel` to place a cross-floor badge (GitHub issue #339). */
  resolveNodeCell?: NodeCellResolver;
  /** The active floor's own `levels_ordered()` index — required alongside `resolveNodeLevel`. */
  activeFloorIndex?: number;
}

export class MazeGraphRenderer extends BaseGraphRenderer {
  private nodeViews: Map<number, Graphics> = new Map();
  private nodeLabels: Map<number, Text> = new Map();
  private lastData: MazeGraphData | null = null;

  render(data: MazeGraphData): void {
    const prev = this.lastData;
    this.lastData = data;

    const nodesChanged = !prev
      || data.nodes !== prev.nodes
      || data.edges !== prev.edges
      || data.start !== prev.start
      || data.finish !== prev.finish
      || data.cfg !== prev.cfg
      || data.resolveNodeLevel !== prev.resolveNodeLevel
      || data.resolveNodeCell !== prev.resolveNodeCell
      || data.activeFloorIndex !== prev.activeFloorIndex;
    const debugChanged = !prev
      || data.showNodeIds !== prev.showNodeIds
      || data.showCoords !== prev.showCoords;
    const selectionChanged = !prev || data.selectedNode !== prev.selectedNode;

    if (nodesChanged) {
      this.renderGraph(data);
    } else {
      if (debugChanged) this.updateLabels(data.nodes, data.showNodeIds, data.showCoords);
      if (selectionChanged && prev) this.updateSelection(prev.selectedNode, data.selectedNode, data.start, data.finish);
    }
  }

  clear(): void {
    this.nodeViews.clear();
    this.nodeLabels.clear();
    this.resetContainers();
    this.lastData = null;
  }

  private renderGraph(data: MazeGraphData): void {
    const { nodes, edges, showNodeIds, showCoords, selectedNode, start, finish, cfg, interactive = true, resolveNodeLevel, resolveNodeCell, activeFloorIndex } = data;
    this.nodeViews.clear();
    this.nodeLabels.clear();
    this.resetContainers();

    const directedPairs = edges.filter((e) => e.kind !== "teleport").map((e) => ({ from: e.from, to: e.to }));
    const nodePos = buildNodePositions(nodes, cfg, directedPairs);

    const renderEdges = buildPairedRenderEdges(edges, nodePos);
    this.drawEdges(renderEdges, canvas.edge.default);

    const renderNodes: RenderNode[] = nodes.map(n => ({ id: n.id, pos: nodePos.get(n.id)! }));
    this.nodeViews = this.drawNodes(renderNodes, selectedNode, start, finish, interactive);

    if (resolveNodeLevel && resolveNodeCell && activeFloorIndex !== undefined) {
      const markers = buildCrossFloorMarkers(edges, nodePos, resolveNodeLevel, resolveNodeCell, activeFloorIndex, cfg, NODE_RADIUS);
      this.renderCrossFloorMarkers(markers, NODE_RADIUS);
    }

    for (const node of nodes) {
      const label = this.makeLabel(node, showNodeIds, showCoords);
      if (label) {
        const pos = nodePos.get(node.id)!;
        label.x = pos.x + NODE_RADIUS + 2;
        label.y = pos.y - NODE_RADIUS - 2;
        this.nodesContainer.addChild(label);
        this.nodeLabels.set(node.id, label);
      }
    }
  }

  private makeLabel(node: NodeDto, showNodeIds: boolean, showCoords: boolean): Text | null {
    const parts: string[] = [];
    if (showNodeIds) parts.push(`${node.id}`);
    if (showCoords) parts.push(`(${node.x},${node.y})`);
    if (parts.length === 0) return null;
    return new Text({ text: parts.join(" "), style: LABEL_STYLE });
  }

  private updateLabels(nodes: NodeDto[], showNodeIds: boolean, showCoords: boolean): void {
    for (const t of this.nodeLabels.values()) t.destroy();
    this.nodeLabels.clear();
    for (const node of nodes) {
      const g = this.nodeViews.get(node.id);
      if (!g) continue;
      const label = this.makeLabel(node, showNodeIds, showCoords);
      if (label) {
        label.x = g.x + NODE_RADIUS + 2;
        label.y = g.y - NODE_RADIUS - 2;
        this.nodesContainer.addChild(label);
        this.nodeLabels.set(node.id, label);
      }
    }
  }

  private updateSelection(prevId: number | null, nextId: number | null, start: number | null, finish: number | null): void {
    if (prevId !== null) {
      const g = this.nodeViews.get(prevId);
      if (g) this.redrawNode(g, nodeRadius(prevId, start, finish), nodeColor(prevId, null, start, finish));
    }
    if (nextId !== null) {
      const g = this.nodeViews.get(nextId);
      if (g) this.redrawNode(g, nodeRadius(nextId, start, finish), canvas.node.selected);
    }
  }

  override destroy(): void {
    this.nodeViews.clear();
    this.nodeLabels.clear();
    super.destroy();
  }
}
