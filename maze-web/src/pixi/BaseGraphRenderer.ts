import { Container, Graphics } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import { NODE_RADIUS, NODE_START_COLOR, NODE_FINISH_COLOR, NODE_COLOR, NODE_HOVER_COLOR, NODE_SELECTED_COLOR } from "./colorUtils";
import { drawDirectionArrow } from "./renderers/wallUtils";
import { TILE_SIZE } from "./constants";

export interface Pos { x: number; y: number; }

export function nodeColor(id: number, selectedNode: number | null, start: number | null, finish: number | null): number {
  if (id === selectedNode) return NODE_SELECTED_COLOR;
  if (id === start) return NODE_START_COLOR;
  if (id === finish) return NODE_FINISH_COLOR;
  return NODE_COLOR;
}

export function nodeRadius(id: number, start: number | null, finish: number | null): number {
  return (id === start || id === finish) ? NODE_RADIUS * 1.5 : NODE_RADIUS;
}

export interface RenderEdge {
  path: Pos[];
  hasReverse: boolean;
}

export interface RenderNode {
  id: number;
  pos: Pos;
}

export function buildPairedRenderEdges(
  edges: { from: number; to: number }[],
  nodePos: Map<number, Pos>,
): RenderEdge[] {
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
  return renderEdges;
}

export function buildPathRenderEdges(
  navEdges: { path: number[] }[],
  nodePos: Map<number, Pos>,
): RenderEdge[] {
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
  return renderEdges;
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

  g.moveTo(startPt.x, startPt.y);
  for (let i = 1; i < pts.length - 1; i++) {
    g.lineTo(pts[i].x, pts[i].y);
  }
  g.lineTo(endPt.x, endPt.y);
  g.stroke({ width: 2, color });

  if (!edge.hasReverse) {
    const midX = (startPt.x + endPt.x) / 2;
    const midY = (startPt.y + endPt.y) / 2;
    const edgeLen = Math.sqrt((endPt.x - startPt.x) ** 2 + (endPt.y - startPt.y) ** 2);
    if (edgeLen < 1) return;
    const ux = (endPt.x - startPt.x) / edgeLen;
    const uy = (endPt.y - startPt.y) / edgeLen;
    drawDirectionArrow(g, midX, midY, ux, uy, TILE_SIZE * 0.18, color);
  }
}

export abstract class BaseGraphRenderer {
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

  protected redrawNode(g: Graphics, r: number, color: number): void {
    g.clear();
    g.circle(0, 0, r);
    g.fill(color);
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
      this.redrawNode(g, nodeRadius(id, start, finish), color);
      g.x = pos.x;
      g.y = pos.y;

      if (interactive) {
        g.interactive = true;
        g.cursor = "pointer";
        g.on("pointerover", () => {
          const s = useMazeStore.getState();
          if (s.selectedNode !== id) {
            const base = nodeColor(id, null, s.start, s.finish);
            this.redrawNode(g, nodeRadius(id, s.start, s.finish), base !== NODE_COLOR ? base : NODE_HOVER_COLOR);
          }
        });
        g.on("pointerout", () => {
          const s = useMazeStore.getState();
          this.redrawNode(g, nodeRadius(id, s.start, s.finish), nodeColor(id, s.selectedNode, s.start, s.finish));
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
