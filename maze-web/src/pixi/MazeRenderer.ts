import { Container, Graphics, Text, TextStyle } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import type { NodeDto, EdgeDto } from "../wasm/types";
import { TILE_SIZE } from "./constants";

const NODE_RADIUS = 6;
const NODE_COLOR = 0x4a9eff;
const NODE_HOVER_COLOR = 0xff9f4a;
const NODE_SELECTED_COLOR = 0xff4a4a;
const NODE_START_COLOR = 0x44dd88;
const NODE_FINISH_COLOR = 0xdd4466;
const EDGE_COLOR = 0x888888;
const LABEL_STYLE = new TextStyle({ fontSize: 9, fill: 0xffffff });

interface Pos { x: number; y: number; }

function nodeColor(id: number, selectedNode: number | null, start: number | null, finish: number | null): number {
  if (id === selectedNode) return NODE_SELECTED_COLOR;
  if (id === start) return NODE_START_COLOR;
  if (id === finish) return NODE_FINISH_COLOR;
  return NODE_COLOR;
}

function drawArrowhead(g: Graphics, from: Pos, to: Pos, edgeLen: number): void {
  if (edgeLen < 1) return;
  const side = 0.1 * edgeLen;
  const height = side * Math.sqrt(3) / 2;
  const dx = (to.x - from.x) / edgeLen;
  const dy = (to.y - from.y) / edgeLen;
  const px = -dy;
  const py = dx;
  const baseCx = to.x - dx * height;
  const baseCy = to.y - dy * height;
  g.poly([
    to.x, to.y,
    baseCx + px * side / 2, baseCy + py * side / 2,
    baseCx - px * side / 2, baseCy - py * side / 2,
  ]);
  g.fill(EDGE_COLOR);
}

export class MazeGraphRenderer {
  private overlayContainer: Container;
  private edgesContainer: Container;
  private nodesContainer: Container;
  private nodeViews: Map<number, Graphics> = new Map();
  private nodeLabels: Map<number, Text> = new Map();

  private unsubscribe: (() => void) | null = null;

  constructor(overlayContainer: Container) {
    this.overlayContainer = overlayContainer;
    this.edgesContainer = new Container();
    this.nodesContainer = new Container();
    this.overlayContainer.addChild(this.edgesContainer);
    this.overlayContainer.addChild(this.nodesContainer);

    this.subscribeToStore();
  }

  private subscribeToStore(): void {
    let prev = useMazeStore.getState();
    this.unsubscribe = useMazeStore.subscribe((state) => {
      const nodesChanged = state.nodes !== prev.nodes || state.edges !== prev.edges
        || state.start !== prev.start || state.finish !== prev.finish;
      const debugChanged =
        state.showNodeIds !== prev.showNodeIds ||
        state.showCoords !== prev.showCoords;
      const selectionChanged = state.selectedNode !== prev.selectedNode;
      if (!nodesChanged && !debugChanged && !selectionChanged) {
        prev = state;
        return;
      }

      if (nodesChanged) {
        this.renderGraph(state.nodes, state.edges, state.showNodeIds, state.showCoords, state.selectedNode, state.start, state.finish);
      } else {
        if (debugChanged) {
          this.updateLabels(state.nodes, state.showNodeIds, state.showCoords);
        }
        if (selectionChanged) {
          // start/finish are stable here: they only change with nodes, which triggers nodesChanged above.
          this.updateSelection(prev.selectedNode, state.selectedNode, state.start, state.finish);
        }
      }

      prev = state;
    });
  }

  private renderGraph(
    nodes: NodeDto[],
    edges: EdgeDto[],
    showNodeIds: boolean,
    showCoords: boolean,
    selectedNode: number | null,
    start: number | null,
    finish: number | null,
  ): void {
    this.nodeViews.clear();
    this.nodeLabels.clear();
    this.edgesContainer.destroy({ children: true });
    this.nodesContainer.destroy({ children: true });
    this.edgesContainer = new Container();
    this.nodesContainer = new Container();
    this.overlayContainer.addChild(this.edgesContainer);
    this.overlayContainer.addChild(this.nodesContainer);

    const nodePos = new Map<number, Pos>();
    for (const node of nodes) {
      nodePos.set(node.id, { x: node.x * TILE_SIZE, y: -node.y * TILE_SIZE });
    }

    type PairFlags = { loToHi: boolean; hiToLo: boolean };
    const pairs = new Map<string, PairFlags>();

    for (const edge of edges) {
      const lo = Math.min(edge.from, edge.to);
      const hi = Math.max(edge.from, edge.to);
      const pairKey = `${lo}:${hi}`;
      let flags = pairs.get(pairKey);
      if (!flags) {
        flags = { loToHi: false, hiToLo: false };
        pairs.set(pairKey, flags);
      }
      if (edge.from === lo) flags.loToHi = true;
      else flags.hiToLo = true;
    }

    for (const [pairKey, { loToHi, hiToLo }] of pairs) {
      const [loStr, hiStr] = pairKey.split(":");
      const lo = Number(loStr);
      const hi = Number(hiStr);
      const posLo = nodePos.get(lo);
      const posHi = nodePos.get(hi);
      if (!posLo || !posHi) continue;

      const dx = posHi.x - posLo.x;
      const dy = posHi.y - posLo.y;
      const len = Math.sqrt(dx * dx + dy * dy);

      const g = new Graphics();
      g.moveTo(posLo.x, posLo.y);
      g.lineTo(posHi.x, posHi.y);
      g.stroke({ width: 2, color: EDGE_COLOR });

      if (loToHi && !hiToLo) {
        drawArrowhead(g, posLo, posHi, len);
      } else if (hiToLo && !loToHi) {
        drawArrowhead(g, posHi, posLo, len);
      }

      this.edgesContainer.addChild(g);
    }

    for (const node of nodes) {
      const pos = nodePos.get(node.id)!;
      const g = new Graphics();
      const color = nodeColor(node.id, selectedNode, start, finish);
      g.circle(0, 0, NODE_RADIUS);
      g.fill(color);
      g.x = pos.x;
      g.y = pos.y;
      g.interactive = true;
      g.cursor = "pointer";

      g.on("pointerover", () => {
        const s = useMazeStore.getState();
        if (s.selectedNode !== node.id) {
          g.clear();
          g.circle(0, 0, NODE_RADIUS);
          const base = nodeColor(node.id, null, s.start, s.finish);
          g.fill(base !== NODE_COLOR ? base : NODE_HOVER_COLOR);
        }
      });
      g.on("pointerout", () => {
        const s = useMazeStore.getState();
        g.clear();
        g.circle(0, 0, NODE_RADIUS);
        g.fill(nodeColor(node.id, s.selectedNode, s.start, s.finish));
      });
      g.on("pointerdown", (e) => {
        e.stopPropagation();
        useMazeStore.getState().selectNode(node.id);
      });

      this.nodesContainer.addChild(g);
      this.nodeViews.set(node.id, g);

      const label = this.makeLabel(node, showNodeIds, showCoords);
      if (label) {
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
      if (g) { g.clear(); g.circle(0, 0, NODE_RADIUS); g.fill(nodeColor(prevId, null, start, finish)); }
    }
    if (nextId !== null) {
      const g = this.nodeViews.get(nextId);
      if (g) { g.clear(); g.circle(0, 0, NODE_RADIUS); g.fill(NODE_SELECTED_COLOR); }
    }
  }

  destroy(): void {
    this.unsubscribe?.();
    this.edgesContainer.destroy({ children: true });
    this.nodesContainer.destroy({ children: true });
    this.nodeViews.clear();
    this.nodeLabels.clear();
  }
}
