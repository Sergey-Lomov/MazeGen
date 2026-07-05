import { useMazeStore } from "../store/mazeStore";
import type { NodeLockKind } from "../wasm/types";
import type { Container } from "pixi.js";
import { pickEdgeAtPosition, pickTeleportEndpointAt, type PresetTeleportEndpointHit } from "./presetConnectionsUtils";
import { makeProjection, encodePoint } from "./tessellationProjection";
import type { PresetConnectionsRenderer } from "./PresetConnectionsRenderer";
import { BaseController } from "./BaseController";

const DRAG_EDGE_TOOLS = new Set(["wall", "passage", "reset"]);
const TELEPORT_TOOLS = new Set(["teleport_one_way", "teleport_two_way"]);
const VERTEX_TOOLS = new Set(["set_start", "set_finish", "teleport_one_way", "teleport_two_way"]);

export class PresetConnectionsController extends BaseController {
  private renderer: PresetConnectionsRenderer;
  private dragActive = false;
  private dragVisited = new Set<string>();
  private draggingTeleportEndpoint: PresetTeleportEndpointHit | null = null;
  private teleportDragMoved = false;
  private draggingMarker: "set_start" | "set_finish" | null = null;
  private lastViewportPos = { x: 0, y: 0 };

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.code === "Escape") this.cancelPendingTeleport();
  };

  constructor(
    getViewport: () => Container,
    renderer: PresetConnectionsRenderer,
    onViewportPan: (dx: number, dy: number) => void,
  ) {
    super(getViewport, onViewportPan);
    this.renderer = renderer;
    window.addEventListener("keydown", this.onKeyDown);
  }

  onPointerMove(canvasX: number, canvasY: number): void {
    if (this.handlePanMove(canvasX, canvasY)) return;

    const state = useMazeStore.getState();
    if (state.openCard !== "preset_connections") return;

    const { x: vpX, y: vpY } = this.toViewport(canvasX, canvasY);
    this.lastViewportPos = { x: vpX, y: vpY };

    if (this.draggingMarker) {
      const proj = makeProjection(state.tessellationConfig);
      const cell = proj.screenToGrid(vpX, vpY);
      if (!this.renderer.getCachedCellSet().has(encodePoint(cell.x, cell.y))) return;
      const coords: [number, number] = [cell.x, cell.y];
      if (this.draggingMarker === "set_start") useMazeStore.getState().setPresetStart(coords);
      else useMazeStore.getState().setPresetFinish(coords);
      return;
    }

    if (this.draggingTeleportEndpoint) {
      const proj = makeProjection(state.tessellationConfig);
      const cell = proj.screenToGrid(vpX, vpY);
      if (!this.renderer.getCachedCellSet().has(encodePoint(cell.x, cell.y))) return;
      const teleport = state.presetTeleports.find(t => t.id === this.draggingTeleportEndpoint!.id);
      if (!teleport) return;
      const current = this.draggingTeleportEndpoint.end === "from" ? teleport.from : teleport.to;
      const other = this.draggingTeleportEndpoint.end === "from" ? teleport.to : teleport.from;
      const movedToOther = other[0] === cell.x && other[1] === cell.y;
      if (current[0] !== cell.x || current[1] !== cell.y) {
        // Cursor left the original cell — this is a drag gesture even if landing on the other
        // endpoint's cell is rejected below, so pointerup must not reinterpret it as a click.
        this.teleportDragMoved = true;
        if (!movedToOther) {
          useMazeStore.getState().movePresetTeleportEndpoint(this.draggingTeleportEndpoint.id, this.draggingTeleportEndpoint.end, [cell.x, cell.y]);
        }
      }
      return;
    }

    if (TELEPORT_TOOLS.has(state.presetConnectionsTool)) {
      if (state.presetTeleportPendingFrom) {
        this.renderer.updateTeleportPreview(state.presetTeleportPendingFrom, vpX, vpY);
      } else {
        this.renderer.updateTeleportPreview(null, 0, 0);
      }
      return;
    }
    this.renderer.updateTeleportPreview(null, 0, 0);

    const edge = pickEdgeAtPosition(vpX, vpY, state.tessellationConfig, this.renderer.getCachedCells(), this.renderer.getCachedCellSet());
    this.renderer.updateHover(edge);

    if (this.dragActive && edge && !this.dragVisited.has(edge.key)) {
      this.dragVisited.add(edge.key);
      useMazeStore.getState().applyPresetConnectionsTool(edge.key, edge.from, edge.to);
    }
  }

  onPointerDown(canvasX: number, canvasY: number, button: number): void {
    const state = useMazeStore.getState();
    if (state.openCard !== "preset_connections") return;

    if (this.tryStartPan(canvasX, canvasY, button)) return;

    const { x: vpX, y: vpY } = this.toViewport(canvasX, canvasY);
    const tool = state.presetConnectionsTool;

    if (VERTEX_TOOLS.has(tool)) {
      const proj = makeProjection(state.tessellationConfig);
      const cell = proj.screenToGrid(vpX, vpY);
      const coords: [number, number] = [cell.x, cell.y];
      const store = useMazeStore.getState();

      // Start/finish markers and teleport endpoints are hit-tested only for the tool group
      // that owns them, so the two categories can freely overlap (e.g. a teleport endpoint
      // placed on the start cell, or a start marker placed on a teleport endpoint's cell).
      const onStartFinishTool = tool === "set_start" || tool === "set_finish";
      const onStart = onStartFinishTool &&
        store.presetStart !== null && store.presetStart[0] === coords[0] && store.presetStart[1] === coords[1];
      const onFinish = onStartFinishTool &&
        store.presetFinish !== null && store.presetFinish[0] === coords[0] && store.presetFinish[1] === coords[1];
      const teleportHit = TELEPORT_TOOLS.has(tool)
        ? pickTeleportEndpointAt(vpX, vpY, state.tessellationConfig, store.presetTeleports)
        : null;

      if (button === 2) {
        if (onStart) store.setPresetStart(null);
        else if (onFinish) store.setPresetFinish(null);
        else if (teleportHit) store.removePresetTeleport(teleportHit.id);
        else if (store.presetTeleportPendingFrom) this.cancelPendingTeleport();
        return;
      }
      if (button !== 0) return;

      if (onStart) {
        this.draggingMarker = "set_start";
        return;
      }
      if (onFinish) {
        this.draggingMarker = "set_finish";
        return;
      }
      if (teleportHit) {
        // Arm as a drag candidate — resolved on pointerup: if the cursor never moved to a
        // different cell, treat it as a plain click (start/complete a new teleport) instead of
        // a drag, so clicking an existing endpoint's cell can still begin/finish a new link there.
        this.draggingTeleportEndpoint = teleportHit;
        this.teleportDragMoved = false;
        return;
      }

      if (tool === "set_start") store.setPresetStart(coords);
      else if (tool === "set_finish") store.setPresetFinish(coords);
      else this.tryTeleportClick(vpX, vpY, tool, state);
      return;
    }

    if (tool === "gen_source") {
      if (button !== 0) return;
      const proj = makeProjection(state.tessellationConfig);
      const cell = proj.screenToGrid(vpX, vpY);
      const coords: [number, number] = [cell.x, cell.y];
      const store = useMazeStore.getState();
      const cur = store.presetGenSource;
      if (cur && cur[0] === coords[0] && cur[1] === coords[1]) {
        store.setPresetGenSource(null);
      } else {
        store.setPresetGenSource(coords);
      }
      return;
    }

    if (tool === "lock_in" || tool === "lock_out" || tool === "full_lock") {
      const proj = makeProjection(state.tessellationConfig);
      const cell = proj.screenToGrid(vpX, vpY);
      const x = cell.x, y = cell.y;
      const key = `${x},${y}`;
      const store = useMazeStore.getState();
      if (button === 2) {
        store.removeLockedNode(x, y);
      } else if (button === 0) {
        const kindMap: Record<string, NodeLockKind> = { lock_in: "in", lock_out: "out", full_lock: "both" };
        const kind = kindMap[tool];
        if (store.lockedNodes.get(key) === kind) {
          store.removeLockedNode(x, y);
        } else {
          store.setLockedNode(x, y, kind);
        }
      }
      return;
    }

    const edge = pickEdgeAtPosition(vpX, vpY, state.tessellationConfig, this.renderer.getCachedCells(), this.renderer.getCachedCellSet());
    if (!edge) return;

    if (button === 2) {
      useMazeStore.getState().applyPresetConnectionsReset(edge.key);
    } else if (button === 0) {
      useMazeStore.getState().applyPresetConnectionsTool(edge.key, edge.from, edge.to);
      if (DRAG_EDGE_TOOLS.has(tool)) {
        this.dragActive = true;
        this.dragVisited = new Set([edge.key]);
      }
    }
    this.renderer.updateHover(edge);
  }

  onPointerUp(button: number): void {
    super.onPointerUp(button);
    if (button === 0) {
      this.dragActive = false;
      this.dragVisited.clear();
      this.draggingMarker = null;

      if (this.draggingTeleportEndpoint) {
        if (!this.teleportDragMoved) {
          const state = useMazeStore.getState();
          if (TELEPORT_TOOLS.has(state.presetConnectionsTool)) {
            if (state.presetTeleportPendingFrom) {
              // A placement is already in progress — clicking an existing endpoint's cell
              // completes the new link there rather than cycling that endpoint's direction.
              this.tryTeleportClick(this.lastViewportPos.x, this.lastViewportPos.y, state.presetConnectionsTool, state);
            } else {
              state.cyclePresetTeleportDirection(this.draggingTeleportEndpoint.id);
            }
          }
        }
        this.draggingTeleportEndpoint = null;
        this.teleportDragMoved = false;
      }
    }
  }

  /** Starts or completes a two-click teleport placement at the cell under (vpX, vpY). No-op if
   * the cell is outside the field, or (on completion) equal to the pending origin cell. */
  private tryTeleportClick(vpX: number, vpY: number, tool: string, state: ReturnType<typeof useMazeStore.getState>): void {
    const proj = makeProjection(state.tessellationConfig);
    const cell = proj.screenToGrid(vpX, vpY);
    if (!this.renderer.getCachedCellSet().has(encodePoint(cell.x, cell.y))) return;

    const coords: [number, number] = [cell.x, cell.y];
    const store = useMazeStore.getState();
    const pendingFrom = store.presetTeleportPendingFrom;
    if (pendingFrom) {
      if (pendingFrom[0] === coords[0] && pendingFrom[1] === coords[1]) return;
      const direction = tool === "teleport_two_way" ? "two_way" : "forward";
      store.addPresetTeleport(pendingFrom, coords, direction);
      this.renderer.updateTeleportPreview(null, 0, 0);
    } else {
      store.setPresetTeleportPendingFrom(coords);
    }
  }

  private cancelPendingTeleport(): void {
    const state = useMazeStore.getState();
    if (!state.presetTeleportPendingFrom) return;
    state.setPresetTeleportPendingFrom(null);
    this.renderer.updateTeleportPreview(null, 0, 0);
  }

  clearHover(): void {
    this.renderer.updateHover(null);
    this.renderer.updateTeleportPreview(null, 0, 0);
  }

  destroy(): void {
    window.removeEventListener("keydown", this.onKeyDown);
  }
}
