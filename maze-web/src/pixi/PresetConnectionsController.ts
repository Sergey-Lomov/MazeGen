import { useMazeStore } from "../store/mazeStore";
import type { NodeLockKind } from "../wasm/types";
import type { Container } from "pixi.js";
import { pickEdgeAtPosition } from "./presetConnectionsUtils";
import { makeProjection } from "./tessellationProjection";
import type { PresetConnectionsRenderer } from "./PresetConnectionsRenderer";

export class PresetConnectionsController {
  private getViewport: () => Container;
  private renderer: PresetConnectionsRenderer;

  private isPanning = false;
  private panStart = { x: 0, y: 0 };
  private vpStart = { x: 0, y: 0 };
  private onViewportPan: (dx: number, dy: number) => void;

  constructor(
    getViewport: () => Container,
    renderer: PresetConnectionsRenderer,
    onViewportPan: (dx: number, dy: number) => void,
  ) {
    this.getViewport = getViewport;
    this.renderer = renderer;
    this.onViewportPan = onViewportPan;
  }

  onPointerMove(canvasX: number, canvasY: number): void {
    if (this.isPanning) {
      const dx = canvasX - this.panStart.x;
      const dy = canvasY - this.panStart.y;
      this.onViewportPan(this.vpStart.x + dx, this.vpStart.y + dy);
      return;
    }

    const state = useMazeStore.getState();
    if (!state.presetConnectionsOpen) return;

    const { x: vpX, y: vpY } = this.toViewport(canvasX, canvasY);
    const edge = pickEdgeAtPosition(vpX, vpY, state.tessellationConfig, this.renderer.getCachedCells(), this.renderer.getCachedCellSet());
    this.renderer.updateHover(edge);
  }

  onPointerDown(canvasX: number, canvasY: number, button: number): void {
    const state = useMazeStore.getState();
    if (!state.presetConnectionsOpen) return;

    if (button === 1) {
      const vp = this.getViewport();
      this.isPanning = true;
      this.panStart = { x: canvasX, y: canvasY };
      this.vpStart = { x: vp.x, y: vp.y };
      return;
    }

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

  onPointerUp(button: number): void {
    if (button === 1) {
      this.isPanning = false;
    }
  }

  clearHover(): void {
    this.renderer.updateHover(null);
  }

  private toViewport(canvasX: number, canvasY: number): { x: number; y: number } {
    const vp = this.getViewport();
    return {
      x: (canvasX - vp.x) / vp.scale.x,
      y: (canvasY - vp.y) / vp.scale.y,
    };
  }
}
