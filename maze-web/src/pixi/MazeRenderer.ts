import { Container, Graphics, Text, TextStyle } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import type { NodeDto, EdgeDto, NavNodeDto, NavEdgeDto } from "../wasm/types";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { NODE_RADIUS, NODE_START_COLOR, NODE_FINISH_COLOR, NODE_COLOR, NODE_HOVER_COLOR, NODE_SELECTED_COLOR, EDGE_COLOR } from "./colorUtils";
import { cellCenter } from "./hexGeometry";
const LABEL_STYLE = new TextStyle({ fontSize: 9, fill: 0xffffff });

interface Pos { x: number; y: number; }

export function nodeColor(id: number, selectedNode: number | null, start: number | null, finish: number | null): number {
  if (id === selectedNode) return NODE_SELECTED_COLOR;
  if (id === start) return NODE_START_COLOR;
  if (id === finish) return NODE_FINISH_COLOR;
  return NODE_COLOR;
}

function gridPos(node: NodeDto, cfg: TessellationConfig): Pos {
  return cellCenter(node, cfg);
}

function arrowHeight(len: number): number {
  const side = Math.min(0.3 * len, NODE_RADIUS * 3);
  return side * Math.sqrt(3) / 2;
}

function drawArrowhead(g: Graphics, from: Pos, to: Pos, innerLen: number, color: number): void {
  if (innerLen < 1) return;
  const side = Math.min(0.3 * innerLen, NODE_RADIUS * 3);
  const height = side * Math.sqrt(3) / 2;
  const dx = (to.x - from.x) / innerLen;
  const dy = (to.y - from.y) / innerLen;
  const px = -dy;
  const py = dx;
  const baseCx = to.x - dx * height;
  const baseCy = to.y - dy * height;
  g.poly([
    to.x, to.y,
    baseCx + px * side / 2, baseCy + py * side / 2,
    baseCx - px * side / 2, baseCy - py * side / 2,
  ]);
  g.fill(color);
}

interface RenderEdge {
  path: Pos[];
  hasReverse: boolean;
}

interface RenderNode {
  id: number;
  pos: Pos;
}

function drawEdge(g: Graphics, edge: RenderEdge, color: number): void {
  const pts = edge.path;
  if (pts.length < 2) return;

  const first = pts[0];
  const second = pts[1];
  const secondLast = pts[pts.length - 2];
  const last = pts[pts.length - 1];

  const dxStart = second.x - first.x;
  const dyStart = second.y - first.y;
  const lenStart = Math.sqrt(dxStart * dxStart + dyStart * dyStart);

  const dxEnd = last.x - secondLast.x;
  const dyEnd = last.y - secondLast.y;
  const lenEnd = Math.sqrt(dxEnd * dxEnd + dyEnd * dyEnd);

  if (lenStart < 1 || lenEnd < 1) return;

  const margin = NODE_RADIUS + 1;
  const startPt: Pos = {
    x: first.x + (dxStart / lenStart) * margin,
    y: first.y + (dyStart / lenStart) * margin,
  };
  const endPt: Pos = {
    x: last.x - (dxEnd / lenEnd) * margin,
    y: last.y - (dyEnd / lenEnd) * margin,
  };

  const endSegLen = Math.sqrt(
    (endPt.x - secondLast.x) ** 2 + (endPt.y - secondLast.y) ** 2
  );

  let lineEndPt = endPt;
  if (!edge.hasReverse) {
    const ah = arrowHeight(endSegLen);
    const ux = dxEnd / lenEnd;
    const uy = dyEnd / lenEnd;
    lineEndPt = { x: endPt.x - ux * ah, y: endPt.y - uy * ah };
  }

  g.moveTo(startPt.x, startPt.y);
  for (let i = 1; i < pts.length - 1; i++) {
    g.lineTo(pts[i].x, pts[i].y);
  }
  g.lineTo(lineEndPt.x, lineEndPt.y);
  g.stroke({ width: 2, color });

  if (!edge.hasReverse) {
    drawArrowhead(g, secondLast, endPt, endSegLen, color);
  }
}

// ─── Base class ──────────────────────────────────────────────────────────────

abstract class BaseGraphRenderer {
  protected overlayContainer: Container;
  protected edgesContainer: Container;
  protected nodesContainer: Container;

  constructor(overlayContainer: Container) {
    this.overlayContainer = overlayContainer;
    this.edgesContainer = new Container();
    this.nodesContainer = new Container();
    this.overlayContainer.addChild(this.edgesContainer);
    this.overlayContainer.addChild(this.nodesContainer);
  }

  protected resetContainers(): void {
    this.edgesContainer.destroy({ children: true });
    this.nodesContainer.destroy({ children: true });
    this.edgesContainer = new Container();
    this.nodesContainer = new Container();
    this.overlayContainer.addChild(this.edgesContainer);
    this.overlayContainer.addChild(this.nodesContainer);
  }

  protected drawEdges(edges: RenderEdge[], color: number): void {
    const g = new Graphics();
    for (const edge of edges) drawEdge(g, edge, color);
    this.edgesContainer.addChild(g);
  }

  protected drawNodes(
    renderNodes: RenderNode[],
    selectedNode: number | null,
    start: number | null,
    finish: number | null,
    interactive: boolean,
  ): Map<number, Graphics> {
    const views = new Map<number, Graphics>();
    for (const { id, pos } of renderNodes) {
      const g = new Graphics();
      const color = nodeColor(id, selectedNode, start, finish);
      const r = (id === start || id === finish) ? NODE_RADIUS * 1.5 : NODE_RADIUS;
      g.circle(0, 0, r);
      g.fill(color);
      g.x = pos.x;
      g.y = pos.y;

      if (interactive) {
        g.interactive = true;
        g.cursor = "pointer";
        g.on("pointerover", () => {
          const s = useMazeStore.getState();
          if (s.selectedNode !== id) {
            const hr = (id === s.start || id === s.finish) ? NODE_RADIUS * 1.5 : NODE_RADIUS;
            g.clear(); g.circle(0, 0, hr);
            const base = nodeColor(id, null, s.start, s.finish);
            g.fill(base !== NODE_COLOR ? base : NODE_HOVER_COLOR);
          }
        });
        g.on("pointerout", () => {
          const s = useMazeStore.getState();
          const or = (id === s.start || id === s.finish) ? NODE_RADIUS * 1.5 : NODE_RADIUS;
          g.clear(); g.circle(0, 0, or);
          g.fill(nodeColor(id, s.selectedNode, s.start, s.finish));
        });
        g.on("pointerdown", (e) => {
          e.stopPropagation();
          useMazeStore.getState().selectNode(id);
        });
      }

      this.nodesContainer.addChild(g);
      views.set(id, g);
    }
    return views;
  }

  destroy(): void {
    this.edgesContainer.destroy({ children: true });
    this.nodesContainer.destroy({ children: true });
  }
}

// ─── MazeGraphRenderer ───────────────────────────────────────────────────────

export interface MazeGraphData {
  nodes: NodeDto[];
  edges: EdgeDto[];
  showNodeIds: boolean;
  showCoords: boolean;
  selectedNode: number | null;
  start: number | null;
  finish: number | null;
  cfg: TessellationConfig;
}

export class MazeGraphRenderer extends BaseGraphRenderer {
  private nodeViews: Map<number, Graphics> = new Map();
  private nodeLabels: Map<number, Text> = new Map();
  private lastData: MazeGraphData | null = null;

  constructor(overlayContainer: Container) {
    super(overlayContainer);
  }

  render(data: MazeGraphData): void {
    const prev = this.lastData;
    this.lastData = data;

    const nodesChanged = !prev
      || data.nodes !== prev.nodes
      || data.edges !== prev.edges
      || data.start !== prev.start
      || data.finish !== prev.finish
      || data.cfg !== prev.cfg;
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
    const { nodes, edges, showNodeIds, showCoords, selectedNode, start, finish, cfg } = data;
    this.nodeViews.clear();
    this.nodeLabels.clear();
    this.resetContainers();

    const nodePos = new Map<number, Pos>();
    for (const node of nodes) nodePos.set(node.id, gridPos(node, cfg));

    type PairFlags = { loToHi: boolean; hiToLo: boolean };
    const pairs = new Map<string, PairFlags>();
    for (const edge of edges) {
      const lo = Math.min(edge.from, edge.to);
      const hi = Math.max(edge.from, edge.to);
      const key = `${lo}:${hi}`;
      let f = pairs.get(key);
      if (!f) { f = { loToHi: false, hiToLo: false }; pairs.set(key, f); }
      if (edge.from === lo) f.loToHi = true; else f.hiToLo = true;
    }

    const renderEdges: RenderEdge[] = [];
    for (const [key, { loToHi, hiToLo }] of pairs) {
      const [loStr, hiStr] = key.split(":");
      const posLo = nodePos.get(Number(loStr));
      const posHi = nodePos.get(Number(hiStr));
      if (!posLo || !posHi) continue;
      const both = loToHi && hiToLo;
      if (loToHi) renderEdges.push({ path: [posLo, posHi], hasReverse: both });
      if (hiToLo) renderEdges.push({ path: [posHi, posLo], hasReverse: both });
    }

    this.drawEdges(renderEdges, EDGE_COLOR);

    const renderNodes: RenderNode[] = nodes.map(n => ({ id: n.id, pos: nodePos.get(n.id)! }));
    this.nodeViews = this.drawNodes(renderNodes, selectedNode, start, finish, true);

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
      const r = (prevId === start || prevId === finish) ? NODE_RADIUS * 1.5 : NODE_RADIUS;
      if (g) { g.clear(); g.circle(0, 0, r); g.fill(nodeColor(prevId, null, start, finish)); }
    }
    if (nextId !== null) {
      const g = this.nodeViews.get(nextId);
      const r = (nextId === start || nextId === finish) ? NODE_RADIUS * 1.5 : NODE_RADIUS;
      if (g) { g.clear(); g.circle(0, 0, r); g.fill(NODE_SELECTED_COLOR); }
    }
  }

  override destroy(): void {
    this.nodeViews.clear();
    this.nodeLabels.clear();
    super.destroy();
  }
}

// ─── NavGraphRenderer ────────────────────────────────────────────────────────

export interface NavGraphData {
  nodes: NodeDto[];
  navNodes: NavNodeDto[];
  navEdges: NavEdgeDto[];
  start: number | null;
  finish: number | null;
  cfg: TessellationConfig;
}

export class NavGraphRenderer extends BaseGraphRenderer {
  constructor(overlayContainer: Container) {
    super(overlayContainer);
  }

  render(data: NavGraphData): void {
    this.resetContainers();
    if (data.nodes.length === 0) return;

    const { nodes, navNodes, navEdges, start, finish, cfg } = data;
    const nodePos = new Map<number, Pos>();
    for (const node of nodes) nodePos.set(node.id, gridPos(node, cfg));

    const edgeKeys = new Set<string>();
    for (const e of navEdges) {
      const fromNode = e.path[0];
      const toNode = e.path[e.path.length - 1];
      edgeKeys.add(`${fromNode}->${toNode}`);
    }

    const renderEdges: RenderEdge[] = [];
    for (const e of navEdges) {
      const path = e.path.map(nid => nodePos.get(nid)).filter((p): p is Pos => p !== undefined);
      if (path.length < 2) continue;
      const fromNode = e.path[0];
      const toNode = e.path[e.path.length - 1];
      const hasReverse = edgeKeys.has(`${toNode}->${fromNode}`);
      renderEdges.push({ path, hasReverse });
    }

    this.drawEdges(renderEdges, EDGE_COLOR);

    const navNodeIds = new Set(navNodes.map(n => n.node_id));
    const renderNodes: RenderNode[] = [];
    for (const nid of navNodeIds) {
      const pos = nodePos.get(nid);
      if (pos) renderNodes.push({ id: nid, pos });
    }

    this.drawNodes(renderNodes, null, start, finish, false);
  }

  clear(): void {
    this.resetContainers();
  }
}
