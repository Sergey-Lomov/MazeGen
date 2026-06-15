import { useMazeStore } from "../store/mazeStore";
import type { NodeLockKind } from "../wasm/types";
import type { Container } from "pixi.js";
import { pickEdgeAtPosition } from "./presetConnectionsUtils";
import { makeProjection } from "./tessellationProjection";
import type { PresetConnectionsRenderer } from "./PresetConnectionsRenderer";
import { BaseController } from "./BaseController";

export class PresetConnectionsController extends BaseController {
  private renderer: PresetConnectionsRenderer;

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
    if (!state.presetConnectionsOpen) return;

    const { x: vpX, y: vpY } = this.toViewport(canvasX, canvasY);
    const edge = pickEdgeAtPosition(vpX, vpY, state.tessellationConfig, this.renderer.getCachedCells(), this.renderer.getCachedCellSet());
    this.renderer.updateHover(edge);
  }

  onPointerDown(canvasX: number, canvasY: number, button: number): void {
    const state = useMazeStore.getState();
    if (!state.presetConnectionsOpen) return;

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

    if (tool === "lock_in" || tool === "lock_out" || tool === "lock_both") {
      const proj = makeProjection(state.tessellationConfig);
      const cell = proj.screenToGrid(vpX, vpY);
      const x = cell.x, y = cell.y;
      const key = `${x},${y}`;
      const store = useMazeStore.getState();
      if (button === 2) {
        store.removeLockedNode(x, y);
      } else if (button === 0) {
        const kindMap: Record<string, NodeLockKind> = { lock_in: "in", lock_out: "out", lock_both: "both" };
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
    }
    this.renderer.updateHover(edge);
  }

  clearHover(): void {
    this.renderer.updateHover(null);
  }
}
