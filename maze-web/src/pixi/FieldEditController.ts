import { useMazeStore } from "../store/mazeStore";
import type { TessellationProjection } from "./tessellationProjection";
import type { Container } from "pixi.js";
import { TILE_SIZE } from "./constants";
import { primitiveCells, cfgKind } from "./primitiveGeometry";
import type { ShapePrimitive, TessellationKind } from "./primitiveGeometry";
import type { FieldPrimitive } from "../store/mazeStore";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";

interface PanCallbacks {
  startPan: (x: number, y: number) => void;
  movePan: (x: number, y: number) => void;
  endPan: () => void;
}

interface PrimitiveCallbacks {
  onPreviewUpdate: (cells: [number, number][], button: number, kind: TessellationKind, cfg: TessellationConfig) => void;
  onPreviewClear: () => void;
  onPrimitiveCommit: (cells: [number, number][], button: number) => void;
}

export class FieldEditController {
  private spaceHeld = false;
  private gestureActive = false;
  private gestureButton = 0;
  private lastGridX = NaN;
  private lastGridY = NaN;

  private primitiveStartGrid: { x: number; y: number } | null = null;
  private primitiveStartCanvas: { x: number; y: number } | null = null;
  private lastPreviewCells: [number, number][] = [];
  private activePrimitive: FieldPrimitive = "point";
  // non-null only when activePrimitive !== "point" and gesture is active
  private activeShapePrimitive: ShapePrimitive | null = null;
  private lastGridRadius = 0;
  private lastEndGrid: { x: number; y: number } | null = null;

  private canvas: HTMLCanvasElement;
  private getProjection: () => TessellationProjection | null;
  private getViewport: () => Container;
  private panCallbacks: PanCallbacks;
  private primitiveCallbacks: PrimitiveCallbacks;

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.code === "Space") { e.preventDefault(); this.spaceHeld = true; }
    if (e.code === "Escape") this.cancelGesture();
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
    primitiveCallbacks: PrimitiveCallbacks,
  ) {
    this.canvas = canvas;
    this.getProjection = getProjection;
    this.getViewport = getViewport;
    this.panCallbacks = panCallbacks;
    this.primitiveCallbacks = primitiveCallbacks;

    canvas.addEventListener("contextmenu", this.onContextMenu);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  }

  onPointerDown(canvasX: number, canvasY: number, button: number): void {
    const s = useMazeStore.getState();
    if (!(s.openCard === "field_setup" && s.fieldEditMode === "custom")) return;

    // RMB pointerup never fires on Windows/Chrome; commit stale RMB gesture here as fallback.
    if (this.gestureActive && this.gestureButton === 2) this.onPointerUp();
    this.gestureActive = true;
    this.gestureButton = button;
    this.activePrimitive = s.fieldPrimitive;

    if (this.spaceHeld || button === 1) {
      this.panCallbacks.startPan(canvasX, canvasY);
      return;
    }

    if (this.activePrimitive === "point") {
      this.lastGridX = NaN;
      this.lastGridY = NaN;
      const grid = this.toGrid(canvasX, canvasY);
      if (!grid) return;
      this.applyEdit(grid.x, grid.y, button);
      this.lastGridX = grid.x;
      this.lastGridY = grid.y;
    } else {
      const grid = this.toGrid(canvasX, canvasY);
      if (!grid) return;
      this.primitiveStartGrid = grid;
      this.primitiveStartCanvas = { x: canvasX, y: canvasY };
      this.activeShapePrimitive = this.activePrimitive as ShapePrimitive;
      this.lastGridRadius = 0;
      this.lastEndGrid = null;
      this.lastPreviewCells = [];
      // show initial shape at radius=1 immediately on mousedown
      const cfg = useMazeStore.getState().tessellationConfig;
      const kind = cfgKind(cfg.type);
      this.lastPreviewCells = primitiveCells(this.activeShapePrimitive, { startGrid: grid, endGrid: grid, gridRadius: 1, kind });
      this.lastGridRadius = 1;
      this.lastEndGrid = grid;
      this.primitiveCallbacks.onPreviewUpdate(this.lastPreviewCells, button, kind, cfg);
    }
  }

  onPointerMove(canvasX: number, canvasY: number, buttons = 0xffff): void {
    if (!this.gestureActive) return;
    // Windows/Chrome doesn't fire pointerup for RMB; detect release via buttons mask.
    if (this.gestureButton === 2 && (buttons & 2) === 0) {
      this.onPointerUp();
      return;
    }
    const s = useMazeStore.getState();
    if (!(s.openCard === "field_setup" && s.fieldEditMode === "custom")) return;

    if (this.spaceHeld || this.gestureButton === 1) {
      this.panCallbacks.movePan(canvasX, canvasY);
      return;
    }

    if (this.activePrimitive === "point") {
      const grid = this.toGrid(canvasX, canvasY);
      if (!grid) return;
      if (grid.x === this.lastGridX && grid.y === this.lastGridY) return;
      this.applyEdit(grid.x, grid.y, this.gestureButton);
      this.lastGridX = grid.x;
      this.lastGridY = grid.y;
    } else if (this.primitiveStartGrid && this.primitiveStartCanvas && this.activeShapePrimitive) {
      const currentGrid = this.toGrid(canvasX, canvasY);
      if (!currentGrid) return;

      const screenDist = Math.hypot(canvasX - this.primitiveStartCanvas.x, canvasY - this.primitiveStartCanvas.y);
      const vp = this.getViewport();
      const tileScreenPx = TILE_SIZE * vp.scale.x;
      const gridRadius = Math.max(1, Math.round(screenDist / tileScreenPx));

      if (gridRadius === this.lastGridRadius && currentGrid.x === this.lastEndGrid?.x && currentGrid.y === this.lastEndGrid?.y) return;

      const cfg = useMazeStore.getState().tessellationConfig;
      const kind = cfgKind(cfg.type);
      this.lastPreviewCells = primitiveCells(this.activeShapePrimitive, { startGrid: this.primitiveStartGrid, endGrid: currentGrid, gridRadius, kind });
      this.lastGridRadius = gridRadius;
      this.lastEndGrid = currentGrid;
      this.primitiveCallbacks.onPreviewUpdate(this.lastPreviewCells, this.gestureButton, kind, cfg);
    }
  }

  private cancelGesture(): void {
    if (!this.gestureActive) return;
    // Point streak commits cells on each move — no batch to cancel.
    // Escape only cancels shape-primitive gestures (preview cleared, nothing committed).
    if (this.activeShapePrimitive !== null && this.primitiveStartGrid !== null) {
      this.primitiveCallbacks.onPreviewClear();
      this.primitiveStartGrid = null;
      this.primitiveStartCanvas = null;
      this.activeShapePrimitive = null;
      this.lastPreviewCells = [];
      this.lastGridRadius = 0;
      this.lastEndGrid = null;
    }
    this.gestureActive = false;
    this.lastGridX = NaN;
    this.lastGridY = NaN;
  }

  onPointerUp(): void {
    if (!this.gestureActive) return;

    if (this.spaceHeld || this.gestureButton === 1) {
      this.panCallbacks.endPan();
    } else if (this.activeShapePrimitive !== null && this.primitiveStartGrid !== null) {
      this.primitiveCallbacks.onPreviewClear();
      this.primitiveCallbacks.onPrimitiveCommit(this.lastPreviewCells, this.gestureButton);
      this.primitiveStartGrid = null;
      this.primitiveStartCanvas = null;
      this.activeShapePrimitive = null;
      this.lastPreviewCells = [];
      this.lastGridRadius = 0;
      this.lastEndGrid = null;
    }

    this.gestureActive = false;
    this.lastGridX = NaN;
    this.lastGridY = NaN;
  }

  getHoverCell(canvasX: number, canvasY: number): [number, number] | null {
    const grid = this.toGrid(canvasX, canvasY);
    if (!grid) return null;
    return [grid.x, grid.y];
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
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
  }
}

