import { useMazeStore } from "../store/mazeStore";
import type { NodeLockKind } from "../wasm/types";
import type { Container } from "pixi.js";
import { pickEdgeAtPosition } from "./presetConnectionsUtils";
import { makeProjection } from "./tessellationProjection";
import type { PresetConnectionsRenderer } from "./PresetConnectionsRenderer";
import { BaseController } from "./BaseController";

const DRAG_EDGE_TOOLS = new Set(["wall", "passage", "reset"]);

export class PresetConnectionsController extends BaseController {
  private renderer: PresetConnectionsRenderer;
  private dragActive = false;
  private dragVisited = new Set<string>();

  constructor(
    getViewport: () => Container,
    renderer: PresetConnectionsRenderer,
    onViewportPan: (dx: number, dy: number) => void,
  ) {
    super(getViewport, onViewportPan);
    this.renderer = renderer;
  }

  onPointerMove(canvasX: number, canvasY: number): void {
    if (this.handlePanMove(canvasX, canvasY)) return;

    const state = useMazeStore.getState();
    if (state.openCard !== "preset_connections") return;

    const { x: vpX, y: vpY } = this.toViewport(canvasX, canvasY);
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

    if (tool === "set_start" || tool === "set_finish") {
      if (button !== 0) return;
      const proj = makeProjection(state.tessellationConfig);
      const cell = proj.screenToGrid(vpX, vpY);
      const coords: [number, number] = [cell.x, cell.y];
      if (tool === "set_start") useMazeStore.getState().setPresetStart(coords);
      else useMazeStore.getState().setPresetFinish(coords);
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
    }
  }

  clearHover(): void {
    this.renderer.updateHover(null);
  }
}
