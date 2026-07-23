import { useMazeStore } from "../store/mazeStore";
import type { Container } from "pixi.js";
import { pickEdgeAtPosition } from "./fieldEditUtils";
import { pickPostEditTeleportEndpointAt } from "./postEditUtils";
import type { PostEditTeleportEndpointHit } from "../store/mazeStore";
import { makeProjection } from "./tessellationProjection";
import type { PostEditRenderer } from "./PostEditRenderer";
import type { NodeDto } from "../wasm/types";
import { BaseController } from "./BaseController";
import {
  type PostEditEndpoint, nodeEndpoint, edgeKey, endpointsEqual, resolveEndpoint, buildSplitNodeResolver,
} from "./postEditEndpoint";

const DRAG_EDGE_TOOLS = new Set(["wall", "passage", "reset"]);
const TELEPORT_TOOLS = new Set(["teleport_one_way", "teleport_two_way"]);
const VERTEX_TOOLS = new Set(["set_start", "set_finish", "teleport_one_way", "teleport_two_way"]);

export class PostEditController extends BaseController {
  private renderer: PostEditRenderer;

  private confirmDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  // Every real node at a point, in snapshot order (index 0 is always the point's original node
  // per Field::nodes_at/all_points's contract — see analytics.rs's node iteration) — replaces the
  // old one-id-per-cell map, since a split point (GitHub issue #221) can have more than one.
  private nodeMap: Map<string, number[]> = new Map();
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

  private getNodeMap(nodes: NodeDto[]): Map<string, number[]> {
    if (nodes !== this.nodeMapNodes) {
      this.nodeMap = buildNodeMap(nodes);
      this.nodeMapNodes = nodes;
    }
    return this.nodeMap;
  }

  /** Resolves the active endpoint for a point (which of its nodes edge-tool clicks currently
   * target) — `activeMap[key]` if the store has one, else the point's original node. `null` if
   * the point isn't in the field at all (shouldn't happen for a cell actually clicked, but a
   * stale/desynced state is cheaper to guard against than to assume away). */
  private resolveActiveEndpointAt(
    point: [number, number],
    nodeMap: Map<string, number[]>,
    activeMap: Record<string, PostEditEndpoint>,
  ): PostEditEndpoint | null {
    const key = `${point[0]},${point[1]}`;
    const ids = nodeMap.get(key);
    if (ids === undefined || ids.length === 0) return null;
    return activeMap[key] ?? nodeEndpoint(ids[0]);
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
      const endpoint = this.resolveActiveEndpointAt([cell.x, cell.y], nodeMap, state.postEditActiveSplitNode);
      if (endpoint !== null) {
        useMazeStore.getState().setPostEditEndpoint(this.draggingMarker === "set_start" ? "start" : "finish", endpoint);
      }
      return;
    }

    if (this.draggingTeleportEndpoint) {
      const proj = makeProjection(state.activeTessellationConfig);
      const cell = proj.screenToGrid(vpX, vpY);
      const nodeMap = this.getNodeMap(state.nodes);
      const endpoint = this.resolveActiveEndpointAt([cell.x, cell.y], nodeMap, state.postEditActiveSplitNode);
      if (endpoint === null) return;
      const teleport = state.postEditDraftTeleports.find(t => t.id === this.draggingTeleportEndpoint!.id);
      if (!teleport) return;
      const current = this.draggingTeleportEndpoint.end === "from" ? teleport.from : teleport.to;
      const other = this.draggingTeleportEndpoint.end === "from" ? teleport.to : teleport.from;
      const resolveSplit = buildSplitNodeResolver(nodeMap, state.postEditDraftSplitPoints);
      const currentId = resolveEndpoint(current, resolveSplit);
      const otherId = resolveEndpoint(other, resolveSplit);
      const endpointId = resolveEndpoint(endpoint, resolveSplit);
      const movedToOther = otherId !== undefined && endpointId !== undefined && otherId === endpointId;
      if (currentId !== endpointId) {
        // Cursor left the original node — this is a drag gesture even if landing on the other
        // endpoint's node is rejected below, so pointerup must not reinterpret it as a click.
        this.teleportDragMoved = true;
        if (!movedToOther) {
          useMazeStore.getState().movePostEditTeleportEndpoint(this.draggingTeleportEndpoint.id, this.draggingTeleportEndpoint.end, endpoint);
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

    if (state.postEditTool === "manage_split_nodes") {
      // This tool targets a whole point (opens the split-node dialog on click), not one of its
      // faces — highlight the cell under the cursor, not a wall/edge (see GitHub issue #221's
      // follow-up: a wall highlight there was misleading about what a click would do).
      const proj = makeProjection(state.activeTessellationConfig);
      const cell = proj.screenToGrid(vpX, vpY);
      const nodeMap = this.getNodeMap(state.nodes);
      this.renderer.updateCellHover(nodeMap.has(`${cell.x},${cell.y}`) ? [cell.x, cell.y] : null);
      this.renderer.updateHover(null);
      return;
    }
    this.renderer.updateCellHover(null);

    const edge = pickEdgeAtPosition(vpX, vpY, state.activeTessellationConfig, this.renderer.getCachedCells(), this.renderer.getCachedCellSet(), true);
    this.renderer.updateHover(edge);

    const nodeMap = this.getNodeMap(state.nodes);
    this.continueEdgeDrag(edge, (e) => {
      const nodeKey = this.cellEdgeToNodeKey(e.from, e.to, nodeMap, state.postEditActiveSplitNode);
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

    if (tool === "manage_split_nodes") {
      if (button !== 0) return;
      const proj = makeProjection(state.activeTessellationConfig);
      const cell = proj.screenToGrid(vpX, vpY);
      const key = `${cell.x},${cell.y}`;
      useMazeStore.getState().setPostEditFocusedPoint(nodeMap.has(key) ? [cell.x, cell.y] : null);
      return;
    }

    if (VERTEX_TOOLS.has(tool)) {
      const proj = makeProjection(state.activeTessellationConfig);
      const cell = proj.screenToGrid(vpX, vpY);
      const endpoint = this.resolveActiveEndpointAt([cell.x, cell.y], nodeMap, state.postEditActiveSplitNode);
      const resolveSplit = buildSplitNodeResolver(nodeMap, state.postEditDraftSplitPoints);
      const nodeId = endpoint !== null ? resolveEndpoint(endpoint, resolveSplit) : undefined;
      const meta = state.postEditDraftMeta ?? {
        start: state.start !== null ? nodeEndpoint(state.start) : null,
        finish: state.finish !== null ? nodeEndpoint(state.finish) : null,
      };
      const markerUnderCursor: "start" | "finish" | null =
        endpoint !== null && meta.start !== null && endpointsEqual(meta.start, endpoint) ? "start" :
        endpoint !== null && meta.finish !== null && endpointsEqual(meta.finish, endpoint) ? "finish" : null;
      const nodeById = this.getNodeById(state.nodes);
      const teleportHit = pickPostEditTeleportEndpointAt(vpX, vpY, state.activeTessellationConfig, state.postEditDraftTeleports, nodeById, resolveSplit);

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

      // A split node not yet confirmed (`nodeId` undefined) can't be set as start/finish or
      // teleport-clicked yet — no-op, not an error (see postEditEndpoint.ts's doc comment; the
      // same click works once the node is confirmed).
      if (endpoint === null || nodeId === undefined) return;
      if (tool === "set_start") useMazeStore.getState().setPostEditEndpoint("start", endpoint);
      else if (tool === "set_finish") useMazeStore.getState().setPostEditEndpoint("finish", endpoint);
      else this.tryTeleportClick(nodeId, tool);
      return;
    }

    const edge = pickEdgeAtPosition(vpX, vpY, state.activeTessellationConfig, this.renderer.getCachedCells(), this.renderer.getCachedCellSet());
    if (!edge) return;

    const nodeKey = this.cellEdgeToNodeKey(edge.from, edge.to, nodeMap, state.postEditActiveSplitNode);
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
            const endpoint = this.resolveActiveEndpointAt([cell.x, cell.y], nodeMap, state.postEditActiveSplitNode);
            const resolveSplit = buildSplitNodeResolver(nodeMap, state.postEditDraftSplitPoints);
            const nodeId = endpoint !== null ? resolveEndpoint(endpoint, resolveSplit) : undefined;
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
   * if the node equals the pending origin node. `nodeId` is always an already-resolved real
   * node — a split node not yet confirmed can't be teleport-clicked yet (see the VERTEX_TOOLS
   * no-op guard in `onPointerDown`). */
  private tryTeleportClick(nodeId: number, tool: string): void {
    const store = useMazeStore.getState();
    const pendingFrom = store.postEditTeleportPendingFrom;
    if (pendingFrom !== null) {
      if (pendingFrom === nodeId) return;
      const direction = tool === "teleport_two_way" ? "two_way" : "forward";
      store.addPostEditTeleport(nodeEndpoint(pendingFrom), nodeEndpoint(nodeId), direction);
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

  /** Resolves both cells of a clicked/dragged edge to their currently active endpoint
   * (`resolveActiveEndpointAt`) and builds the edge key — replaces the old bare-number
   * `${from}-${to}` construction now that a point can have more than one node (GitHub issue
   * #221). `null` if either cell isn't in the field. */
  private cellEdgeToNodeKey(
    fromCell: [number, number],
    toCell: [number, number],
    nodeMap: Map<string, number[]>,
    activeMap: Record<string, PostEditEndpoint>,
  ): { key: string; from: PostEditEndpoint; to: PostEditEndpoint } | null {
    const from = this.resolveActiveEndpointAt(fromCell, nodeMap, activeMap);
    const to = this.resolveActiveEndpointAt(toCell, nodeMap, activeMap);
    if (from === null || to === null) return null;
    return { key: edgeKey(from, to), from, to };
  }
}

/** All real nodes at each point, in snapshot order (see `Field::nodes_at`/`all_points`'s
 * determinism contract, mirrored by `maze-wasm/src/analytics.rs`'s node iteration) — index 0 is
 * always the point's original node, guaranteed by that contract, not an observation of `Graph`'s
 * incidental insertion order. */
function buildNodeMap(nodes: NodeDto[]): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (const n of nodes) {
    const key = `${n.x},${n.y}`;
    const list = m.get(key);
    if (list) list.push(n.id); else m.set(key, [n.id]);
  }
  return m;
}
