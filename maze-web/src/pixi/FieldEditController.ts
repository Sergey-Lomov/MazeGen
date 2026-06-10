import { useMazeStore } from "../store/mazeStore";
import type { TessellationProjection } from "./tessellationProjection";
import type { Container } from "pixi.js";

interface PanCallbacks {
  startPan: (x: number, y: number) => void;
  movePan: (x: number, y: number) => void;
  endPan: () => void;
}

export class FieldEditController {
  private spaceHeld = false;
  private gestureActive = false;
  private gestureButton = 0;
  private lastGridX = NaN;
  private lastGridY = NaN;

  private getProjection: () => TessellationProjection | null;
  private getViewport: () => Container;
  private panCallbacks: PanCallbacks;

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.code === "Space") { e.preventDefault(); this.spaceHeld = true; }
  };
  private onKeyUp = (e: KeyboardEvent) => {
    if (e.code === "Space") this.spaceHeld = false;
  };
  private onContextMenu = (e: Event) => { e.preventDefault(); };

  constructor(
    canvas: HTMLCanvasElement,
    getProjection: () => TessellationProjection | null,
    getViewport: () => Container,
    panCallbacks: PanCallbacks,
  ) {
    this.getProjection = getProjection;
    this.getViewport = getViewport;
    this.panCallbacks = panCallbacks;

    canvas.addEventListener("contextmenu", this.onContextMenu);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  }

  onPointerDown(canvasX: number, canvasY: number, button: number): void {
    if (!useMazeStore.getState().isEditingField) return;
    this.gestureActive = true;
    this.gestureButton = button;
    this.lastGridX = NaN;
    this.lastGridY = NaN;

    if (this.spaceHeld || button === 1) {
      this.panCallbacks.startPan(canvasX, canvasY);
      return;
    }

    const grid = this.toGrid(canvasX, canvasY);
    if (!grid) return;
    this.applyEdit(grid.x, grid.y, button);
    this.lastGridX = grid.x;
    this.lastGridY = grid.y;
  }

  onPointerMove(canvasX: number, canvasY: number): void {
    if (!this.gestureActive) return;
    if (!useMazeStore.getState().isEditingField) return;

    if (this.spaceHeld || this.gestureButton === 1) {
      this.panCallbacks.movePan(canvasX, canvasY);
      return;
    }

    const grid = this.toGrid(canvasX, canvasY);
    if (!grid) return;
    if (grid.x === this.lastGridX && grid.y === this.lastGridY) return;
    this.applyEdit(grid.x, grid.y, this.gestureButton);
    this.lastGridX = grid.x;
    this.lastGridY = grid.y;
  }

  onPointerUp(): void {
    if (this.gestureActive && (this.spaceHeld || this.gestureButton === 1)) {
      this.panCallbacks.endPan();
    }
    this.gestureActive = false;
    this.lastGridX = NaN;
    this.lastGridY = NaN;
  }

  private toGrid(canvasX: number, canvasY: number): { x: number; y: number } | null {
    const proj = this.getProjection();
    if (!proj) return null;
    const vp = this.getViewport();
    const vx = (canvasX - vp.x) / vp.scale.x;
    const vy = (canvasY - vp.y) / vp.scale.y;
    return proj.screenToGrid(vx, vy);
  }

  private applyEdit(x: number, y: number, button: number): void {
    const store = useMazeStore.getState();
    if (button === 0) {
      store.addFieldPoint(x, y);
    } else if (button === 2) {
      store.removeFieldPoint(x, y);
    }
  }

  destroy(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
  }
}
