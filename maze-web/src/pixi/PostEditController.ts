import { useMazeStore } from "../store/mazeStore";
import type { Container } from "pixi.js";
import { pickEdgeAtPosition } from "./fieldEditUtils";
import { makeProjection } from "./tessellationProjection";
import type { PostEditRenderer } from "./PostEditRenderer";
import type { NodeDto } from "../wasm/types";
import { BaseController } from "./BaseController";

const DRAG_EDGE_TOOLS = new Set(["wall", "passage", "reset"]);
const VERTEX_TOOLS = new Set(["set_start", "set_finish"]);

export class PostEditController extends BaseController {
  private renderer: PostEditRenderer;

  private confirmDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private nodeMap: Map<string, number> = new Map();
  private nodeMapNodes: NodeDto[] | null = null;
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
    if (state.openCard !== "post_edit") return;

    const { x: vpX, y: vpY } = this.toViewport(canvasX, canvasY);

    if (this.draggingMarker) {
      const proj = makeProjection(state.activeTessellationConfig);
      const cell = proj.screenToGrid(vpX, vpY);
      const nodeMap = this.getNodeMap(state.nodes);
      const nodeId = nodeMap.get(`${cell.x},${cell.y}`);
      if (nodeId !== undefined) {
        useMazeStore.getState().setPostEditEndpoint(this.draggingMarker === "set_start" ? "start" : "finish", nodeId);
      }
      return;
    }

    const edge = pickEdgeAtPosition(vpX, vpY, state.activeTessellationConfig, this.renderer.getCachedCells(), this.renderer.getCachedCellSet());
    this.renderer.updateHover(edge);

    const nodeMap = this.getNodeMap(state.nodes);
    this.continueEdgeDrag(edge, (e) => {
      const nodeKey = cellEdgeToNodeKey(e.from, e.to, nodeMap);
      if (nodeKey) {
        useMazeStore.getState().applyPostEditTool(nodeKey.key, nodeKey.from, nodeKey.to);
        this.dragDidApply = true;
      }
    });
  }

  onPointerDown(canvasX: number, canvasY: number, button: number): void {
    const state = useMazeStore.getState();
    if (state.openCard !== "post_edit") return;

    if (this.tryStartPan(canvasX, canvasY, button)) return;

    const { x: vpX, y: vpY } = this.toViewport(canvasX, canvasY);
    const tool = state.postEditTool;
    const nodeMap = this.getNodeMap(state.nodes);

    if (VERTEX_TOOLS.has(tool)) {
      const proj = makeProjection(state.activeTessellationConfig);
      const cell = proj.screenToGrid(vpX, vpY);
      const nodeId = nodeMap.get(`${cell.x},${cell.y}`);
      const meta = state.postEditDraftMeta ?? { start: state.start, finish: state.finish };
      const markerUnderCursor: "start" | "finish" | null =
        nodeId !== undefined && meta.start === nodeId ? "start" :
        nodeId !== undefined && meta.finish === nodeId ? "finish" : null;

      if (button === 2) {
        if (markerUnderCursor) {
          useMazeStore.getState().clearPostEditEndpoint(markerUnderCursor);
        }
        return;
      }
      if (button !== 0) return;

      if (markerUnderCursor) {
        this.armMarkerDrag(markerUnderCursor === "start" ? "set_start" : "set_finish");
        return;
      }
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
        this.beginEdgeDrag(edge.key);
        this.dragDidApply = true;
      } else if (state.postEditAutoConfirm) {
        this.scheduleConfirm();
      }
    }
    this.renderer.updateHover(edge);
  }

  onPointerUp(button: number): void {
    if (button === 0 && this.isDragActive) {
      if (this.dragDidApply && useMazeStore.getState().postEditAutoConfirm) {
        this.scheduleConfirm();
      }
      this.dragDidApply = false;
    }
    super.onPointerUp(button);
    if (button === 0) this.endEdgeDrag();
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
