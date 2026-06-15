import { useMazeStore } from "../store/mazeStore";
import type { Container } from "pixi.js";
import { pickEdgeAtPosition } from "./presetConnectionsUtils";
import { makeProjection } from "./tessellationProjection";
import type { PostEditRenderer } from "./PostEditRenderer";
import type { NodeDto } from "../wasm/types";
import { BaseController } from "./BaseController";

const DRAG_EDGE_TOOLS = new Set(["wall", "passage", "reset"]);

export class PostEditController extends BaseController {
  private renderer: PostEditRenderer;

  private confirmDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private nodeMap: Map<string, number> = new Map();
  private nodeMapNodes: NodeDto[] | null = null;
  private dragActive = false;
  private dragVisited = new Set<string>();
  private dragDidApply = false;

  constructor(
    getViewport: () => Container,
    renderer: PostEditRenderer,
    onViewportPan: (dx: number, dy: number) => void,
  ) {
    super(getViewport, onViewportPan);
    this.renderer = renderer;
  }

  private getNodeMap(nodes: NodeDto[]): Map<string, number> {
    if (nodes !== this.nodeMapNodes) {
      this.nodeMap = buildNodeMap(nodes);
      this.nodeMapNodes = nodes;
    }
    return this.nodeMap;
  }

  onPointerMove(canvasX: number, canvasY: number): void {
    if (this.handlePanMove(canvasX, canvasY)) return;

    const state = useMazeStore.getState();
    if (!state.postEditOpen) return;

    const { x: vpX, y: vpY } = this.toViewport(canvasX, canvasY);
    const edge = pickEdgeAtPosition(vpX, vpY, state.activeTessellationConfig, this.renderer.getCachedCells(), this.renderer.getCachedCellSet());
    this.renderer.updateHover(edge);

    if (this.dragActive && edge && !this.dragVisited.has(edge.key)) {
      this.dragVisited.add(edge.key);
      const nodeMap = this.getNodeMap(state.nodes);
      const nodeKey = cellEdgeToNodeKey(edge.from, edge.to, nodeMap);
      if (nodeKey) {
        useMazeStore.getState().applyPostEditTool(nodeKey.key, nodeKey.from, nodeKey.to);
        this.dragDidApply = true;
      }
    }
  }

  onPointerDown(canvasX: number, canvasY: number, button: number): void {
    const state = useMazeStore.getState();
    if (!state.postEditOpen) return;

    if (this.tryStartPan(canvasX, canvasY, button)) return;

    const { x: vpX, y: vpY } = this.toViewport(canvasX, canvasY);
    const tool = state.postEditTool;
    const nodeMap = this.getNodeMap(state.nodes);

    if (tool === "set_start" || tool === "set_finish") {
      if (button !== 0) return;
      const proj = makeProjection(state.activeTessellationConfig);
      const cell = proj.screenToGrid(vpX, vpY);
      const nodeId = nodeMap.get(`${cell.x},${cell.y}`);
      if (nodeId !== undefined) {
        useMazeStore.getState().setPostEditEndpoint(tool === "set_start" ? "start" : "finish", nodeId);
      }
      return;
    }

    const edge = pickEdgeAtPosition(vpX, vpY, state.activeTessellationConfig, this.renderer.getCachedCells(), this.renderer.getCachedCellSet());
    if (!edge) return;

    const nodeKey = cellEdgeToNodeKey(edge.from, edge.to, nodeMap);
    if (nodeKey) {
      useMazeStore.getState().applyPostEditTool(nodeKey.key, nodeKey.from, nodeKey.to);
      if (button === 0 && DRAG_EDGE_TOOLS.has(tool)) {
        this.dragActive = true;
        this.dragVisited = new Set([edge.key]);
        this.dragDidApply = true;
      } else if (state.postEditAutoConfirm) {
        this.scheduleConfirm();
      }
    }
    this.renderer.updateHover(edge);
  }

  onPointerUp(button: number): void {
    super.onPointerUp(button);
    if (button === 0 && this.dragActive) {
      this.dragActive = false;
      this.dragVisited.clear();
      if (this.dragDidApply && useMazeStore.getState().postEditAutoConfirm) {
        this.scheduleConfirm();
      }
      this.dragDidApply = false;
    }
  }

  clearHover(): void {
    this.renderer.updateHover(null);
  }

  destroy(): void {
    if (this.confirmDebounceTimer !== null) {
      clearTimeout(this.confirmDebounceTimer);
    }
  }

  private scheduleConfirm(): void {
    if (this.confirmDebounceTimer !== null) {
      clearTimeout(this.confirmDebounceTimer);
    }
    this.confirmDebounceTimer = setTimeout(() => {
      this.confirmDebounceTimer = null;
      void useMazeStore.getState().confirmPostEdit();
    }, 300);
  }
}

function buildNodeMap(nodes: NodeDto[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const n of nodes) m.set(`${n.x},${n.y}`, n.id);
  return m;
}

function cellEdgeToNodeKey(
  fromCell: [number, number],
  toCell: [number, number],
  nodeMap: Map<string, number>,
): { key: string; from: number; to: number } | null {
  const fromId = nodeMap.get(`${fromCell[0]},${fromCell[1]}`);
  const toId = nodeMap.get(`${toCell[0]},${toCell[1]}`);
  if (fromId === undefined || toId === undefined) return null;
  return { key: `${fromId}-${toId}`, from: fromId, to: toId };
}
