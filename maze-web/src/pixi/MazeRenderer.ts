import { Application, Container, Graphics, Text, TextStyle } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import type { NodeDto, EdgeDto } from "../wasm/types";

const NODE_RADIUS = 6;
const NODE_SPACING = 40;
const NODE_COLOR = 0x4a9eff;
const NODE_HOVER_COLOR = 0xff9f4a;
const NODE_SELECTED_COLOR = 0xff4a4a;
const EDGE_COLOR = 0x888888;
const LABEL_STYLE = new TextStyle({ fontSize: 9, fill: 0xffffff });

export class MazeRenderer {
  private app: Application;
  private viewport: Container;
  private edgesContainer: Container;
  private nodesContainer: Container;
  private nodeViews: Map<number, Graphics> = new Map();
  private nodeLabels: Map<number, Text> = new Map();

  private isDragging = false;
  private dragStart = { x: 0, y: 0 };
  private viewportStart = { x: 0, y: 0 };

  private unsubscribe: (() => void) | null = null;
  private onBlur = () => { this.isDragging = false; };
  private onWheel: (e: WheelEvent) => void = () => {};

  constructor(app: Application) {
    this.app = app;

    this.viewport = new Container();
    this.edgesContainer = new Container();
    this.nodesContainer = new Container();
    this.viewport.addChild(this.edgesContainer);
    this.viewport.addChild(this.nodesContainer);
    this.app.stage.addChild(this.viewport);

    this.viewport.x = app.screen.width / 2;
    this.viewport.y = app.screen.height / 2;

    this.setupInteraction();
    this.subscribeToStore();
  }

  private setupInteraction(): void {
    const stage = this.app.stage;
    stage.interactive = true;
    stage.hitArea = this.app.screen;

    stage.on("pointerdown", (e) => {
      this.isDragging = true;
      this.dragStart = { x: e.globalX, y: e.globalY };
      this.viewportStart = { x: this.viewport.x, y: this.viewport.y };
    });

    stage.on("pointermove", (e) => {
      if (!this.isDragging) return;
      this.viewport.x = this.viewportStart.x + (e.globalX - this.dragStart.x);
      this.viewport.y = this.viewportStart.y + (e.globalY - this.dragStart.y);
    });

    stage.on("pointerup", () => { this.isDragging = false; });
    stage.on("pointerupoutside", () => { this.isDragging = false; });

    window.addEventListener("blur", this.onBlur);

    this.onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const rect = this.app.canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      this.viewport.x = mouseX + (this.viewport.x - mouseX) * factor;
      this.viewport.y = mouseY + (this.viewport.y - mouseY) * factor;
      this.viewport.scale.x *= factor;
      this.viewport.scale.y *= factor;
    };
    this.app.canvas.addEventListener("wheel", this.onWheel, { passive: false });
  }

  private subscribeToStore(): void {
    let prev = useMazeStore.getState();
    this.unsubscribe = useMazeStore.subscribe((state) => {
      const nodesChanged = state.nodes !== prev.nodes || state.edges !== prev.edges;
      const debugChanged =
        state.showNodeIds !== prev.showNodeIds ||
        state.showCoords !== prev.showCoords;
      const selectionChanged = state.selectedNode !== prev.selectedNode;

      if (!nodesChanged && !debugChanged && !selectionChanged) {
        prev = state;
        return;
      }

      if (nodesChanged) {
        this.renderGraph(state.nodes, state.edges, state.showNodeIds, state.showCoords, state.selectedNode);
      } else if (debugChanged) {
        this.updateLabels(state.nodes, state.showNodeIds, state.showCoords);
      } else if (selectionChanged) {
        this.updateSelection(prev.selectedNode, state.selectedNode);
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
  ): void {
    for (const g of this.nodeViews.values()) g.destroy();
    for (const t of this.nodeLabels.values()) t.destroy();
    this.nodeViews.clear();
    this.nodeLabels.clear();
    this.edgesContainer.removeChildren();
    this.nodesContainer.removeChildren();

    const nodePos = new Map<number, { x: number; y: number }>();
    for (const node of nodes) {
      nodePos.set(node.id, { x: node.x * NODE_SPACING, y: -node.y * NODE_SPACING });
    }

    for (const edge of edges) {
      const a = nodePos.get(edge.a);
      const b = nodePos.get(edge.b);
      if (!a || !b) continue;
      const g = new Graphics();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke({ width: 2, color: EDGE_COLOR });
      this.edgesContainer.addChild(g);
    }

    for (const node of nodes) {
      const pos = nodePos.get(node.id)!;
      const g = new Graphics();
      const color = node.id === selectedNode ? NODE_SELECTED_COLOR : NODE_COLOR;
      g.circle(0, 0, NODE_RADIUS);
      g.fill(color);
      g.x = pos.x;
      g.y = pos.y;
      g.interactive = true;
      g.cursor = "pointer";

      g.on("pointerover", () => {
        if (useMazeStore.getState().selectedNode !== node.id) {
          g.clear();
          g.circle(0, 0, NODE_RADIUS);
          g.fill(NODE_HOVER_COLOR);
        }
      });
      g.on("pointerout", () => {
        const sel = useMazeStore.getState().selectedNode;
        g.clear();
        g.circle(0, 0, NODE_RADIUS);
        g.fill(sel === node.id ? NODE_SELECTED_COLOR : NODE_COLOR);
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

  private updateSelection(prevId: number | null, nextId: number | null): void {
    if (prevId !== null) {
      const g = this.nodeViews.get(prevId);
      if (g) { g.clear(); g.circle(0, 0, NODE_RADIUS); g.fill(NODE_COLOR); }
    }
    if (nextId !== null) {
      const g = this.nodeViews.get(nextId);
      if (g) { g.clear(); g.circle(0, 0, NODE_RADIUS); g.fill(NODE_SELECTED_COLOR); }
    }
  }

  destroy(): void {
    this.unsubscribe?.();
    window.removeEventListener("blur", this.onBlur);
    this.app.canvas.removeEventListener("wheel", this.onWheel);
    this.app.destroy();
  }
}
