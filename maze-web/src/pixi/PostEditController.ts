import { useMazeStore } from "../store/mazeStore";
import type { Container } from "pixi.js";
import { pickEdgeAtPosition } from "./fieldEditUtils";
import { pickPostEditTeleportEndpointAt } from "./postEditUtils";
import type { PostEditTeleportEndpointHit } from "../store/mazeStore";
import { makeProjection } from "./tessellationProjection";
import type { PostEditRenderer } from "./PostEditRenderer";
import type { NodeDto } from "../wasm/types";
import { BaseController } from "./BaseController";

const DRAG_EDGE_TOOLS = new Set(["wall", "passage", "reset"]);
const TELEPORT_TOOLS = new Set(["teleport_one_way", "teleport_two_way"]);
const VERTEX_TOOLS = new Set(["set_start", "set_finish", "teleport_one_way", "teleport_two_way"]);

export class PostEditController extends BaseController {
  private renderer: PostEditRenderer;

  private confirmDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private nodeMap: Map<string, number> = new Map();
  private nodeMapNodes: NodeDto[] | null = null;
  private dragDidApply = false;

  private draggingTeleportEndpoint: PostEditTeleportEndpointHit | null = null;
  private teleportDragMoved = false;
  private lastViewportPos = { x: 0, y: 0 };

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.code === "Escape") this.cancelPendingTeleport();
  };

  constructor(
    getViewport: () => Container,
    renderer: PostEditRenderer,
    onViewportPan: (dx: number, dy: number) => void,
  ) {
    super(getViewport, onViewportPan);
    this.renderer = renderer;
    window.addEventListener("keydown", this.onKeyDown);
  }

  private getNodeMap(nodes: NodeDto[]): Map<string, number> {
    if (nodes !== this.nodeMapNodes) {
      this.nodeMap = buildNodeMap(nodes);
      this.nodeMapNodes = nodes;
    }
    return this.nodeMap;
  }

  private getNodeById(nodes: NodeDto[]): Map<number, NodeDto> {
    return new Map(nodes.map(n => [n.id, n]));
  }

  onPointerMove(canvasX: number, canvasY: number): void {
    if (this.handlePanMove(canvasX, canvasY)) return;

    const state = useMazeStore.getState();
    if (state.openCard !== "post_edit") return;

    const { x: vpX, y: vpY } = this.toViewport(canvasX, canvasY);
    this.lastViewportPos = { x: vpX, y: vpY };

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

    if (this.draggingTeleportEndpoint) {
      const proj = makeProjection(state.activeTessellationConfig);
      const cell = proj.screenToGrid(vpX, vpY);
      const nodeMap = this.getNodeMap(state.nodes);
      const nodeId = nodeMap.get(`${cell.x},${cell.y}`);
      if (nodeId === undefined) return;
      const teleport = state.postEditDraftTeleports.find(t => t.id === this.draggingTeleportEndpoint!.id);
      if (!teleport) return;
      const current = this.draggingTeleportEndpoint.end === "from" ? teleport.from : teleport.to;
      const other = this.draggingTeleportEndpoint.end === "from" ? teleport.to : teleport.from;
      const movedToOther = other === nodeId;
      if (current !== nodeId) {
        // Cursor left the original node — this is a drag gesture even if landing on the other
        // endpoint's node is rejected below, so pointerup must not reinterpret it as a click.
        this.teleportDragMoved = true;
        if (!movedToOther) {
          useMazeStore.getState().movePostEditTeleportEndpoint(this.draggingTeleportEndpoint.id, this.draggingTeleportEndpoint.end, nodeId);
        }
      }
      return;
    }

    if (TELEPORT_TOOLS.has(state.postEditTool)) {
      if (state.postEditTeleportPendingFrom !== null) {
        const nodeById = this.getNodeById(state.nodes);
        const fromNode = nodeById.get(state.postEditTeleportPendingFrom);
        if (fromNode) {
          const proj = makeProjection(state.activeTessellationConfig);
          const { x: px, y: py } = proj.gridToScreen(fromNode.x, fromNode.y);
          this.renderer.updateTeleportPreview({ x: px, y: py }, vpX, vpY);
        }
      } else {
        this.renderer.updateTeleportPreview(null, 0, 0);
      }
      return;
    }
    this.renderer.updateTeleportPreview(null, 0, 0);

    const edge = pickEdgeAtPosition(vpX, vpY, state.activeTessellationConfig, this.renderer.getCachedCells(), this.renderer.getCachedCellSet(), true);
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
      const nodeById = this.getNodeById(state.nodes);
      const teleportHit = pickPostEditTeleportEndpointAt(vpX, vpY, state.activeTessellationConfig, state.postEditDraftTeleports, nodeById);

      if (button === 2) {
        if (markerUnderCursor) {
          useMazeStore.getState().clearPostEditEndpoint(markerUnderCursor);
        } else if (teleportHit) {
          useMazeStore.getState().removePostEditTeleport(teleportHit.id);
        } else if (state.postEditTeleportPendingFrom !== null) {
          this.cancelPendingTeleport();
        }
        return;
      }
      if (button !== 0) return;

      if (markerUnderCursor) {
        this.armMarkerDrag(markerUnderCursor === "start" ? "set_start" : "set_finish");
        return;
      }
      if (teleportHit) {
        // Arm as a drag candidate — resolved on pointerup: if the cursor never moved to a
        // different node, treat it as a plain click (start/complete a new teleport, or cycle
        // direction) instead of a drag.
        this.draggingTeleportEndpoint = teleportHit;
        this.teleportDragMoved = false;
        return;
      }

      if (nodeId === undefined) return;
      if (tool === "set_start") useMazeStore.getState().setPostEditEndpoint("start", nodeId);
      else if (tool === "set_finish") useMazeStore.getState().setPostEditEndpoint("finish", nodeId);
      else this.tryTeleportClick(nodeId, tool);
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
    if (button === 0) {
      this.endEdgeDrag();

      if (this.draggingTeleportEndpoint) {
        if (!this.teleportDragMoved) {
          const state = useMazeStore.getState();
          if (TELEPORT_TOOLS.has(state.postEditTool)) {
            const nodeMap = this.getNodeMap(state.nodes);
            const proj = makeProjection(state.activeTessellationConfig);
            const cell = proj.screenToGrid(this.lastViewportPos.x, this.lastViewportPos.y);
            const nodeId = nodeMap.get(`${cell.x},${cell.y}`);
            if (state.postEditTeleportPendingFrom !== null) {
              // A placement is already in progress — clicking an existing endpoint's node
              // completes the new link there rather than cycling that endpoint's direction.
              if (nodeId !== undefined) this.tryTeleportClick(nodeId, state.postEditTool);
            } else {
              state.cyclePostEditTeleportDirection(this.draggingTeleportEndpoint.id);
            }
          }
        }
        this.draggingTeleportEndpoint = null;
        this.teleportDragMoved = false;
      }
    }
  }

  /** Starts or completes a two-click teleport placement at the given node. No-op on completion
   * if the node equals the pending origin node. */
  private tryTeleportClick(nodeId: number, tool: string): void {
    const store = useMazeStore.getState();
    const pendingFrom = store.postEditTeleportPendingFrom;
    if (pendingFrom !== null) {
      if (pendingFrom === nodeId) return;
      const direction = tool === "teleport_two_way" ? "two_way" : "forward";
      store.addPostEditTeleport(pendingFrom, nodeId, direction);
      this.renderer.updateTeleportPreview(null, 0, 0);
    } else {
      store.setPostEditTeleportPendingFrom(nodeId);
    }
  }

  private cancelPendingTeleport(): void {
    const state = useMazeStore.getState();
    if (state.postEditTeleportPendingFrom === null) return;
    state.setPostEditTeleportPendingFrom(null);
    this.renderer.updateTeleportPreview(null, 0, 0);
  }

  clearHover(): void {
    this.renderer.updateHover(null);
    this.renderer.updateTeleportPreview(null, 0, 0);
  }

  destroy(): void {
    window.removeEventListener("keydown", this.onKeyDown);
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
