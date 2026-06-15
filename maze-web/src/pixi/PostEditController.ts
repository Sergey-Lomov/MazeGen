import { useMazeStore } from "../store/mazeStore";
import type { Container } from "pixi.js";
import { pickEdgeAtPosition } from "./presetConnectionsUtils";
import { makeProjection } from "./tessellationProjection";
import type { PostEditRenderer } from "./PostEditRenderer";
import type { NodeDto } from "../wasm/types";
import { BaseController } from "./BaseController";

export class PostEditController extends BaseController {
  private renderer: PostEditRenderer;

  private confirmDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private nodeMap: Map<string, number> = new Map();
  private nodeMapNodes: NodeDto[] | null = null;

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
    }
    this.renderer.updateHover(edge);

    if (state.postEditAutoConfirm) {
      this.scheduleConfirm();
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
