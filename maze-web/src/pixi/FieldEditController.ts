import { useMazeStore } from "../store/mazeStore";
import type { TessellationProjection } from "./tessellationProjection";
import type { Container } from "pixi.js";
import { TILE_SIZE } from "./constants";
import { normalizePrimitiveCells, primitiveCells, primitiveWorldGeometry, cfgKind } from "./primitiveGeometry";
import type { ShapePrimitive, TessellationKind } from "./primitiveGeometry";
import type { FieldPrimitive } from "../store/mazeStore";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { canvasToGrid } from "./hoverProviders";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
}

interface PanCallbacks {
  startPan: (x: number, y: number) => void;
  movePan: (x: number, y: number) => void;
  endPan: () => void;
}

interface PrimitiveCallbacks {
  onPreviewUpdate: (cells: [number, number][], button: number, kind: TessellationKind, cfg: TessellationConfig, geometry: ReturnType<typeof primitiveWorldGeometry>) => void;
  onPreviewClear: () => void;
  onPrimitiveCommit: (cells: [number, number][], button: number) => void;
}

export class FieldEditController {
  private spaceHeld = false;
  private shiftHeld = false;
  private controlHeld = false;
  private gestureActive = false;
  private gestureButton = 0;
  private lastGridX = NaN;
  private lastGridY = NaN;

  private primitiveStartGrid: { x: number; y: number } | null = null;
  private primitiveStartWorld: { x: number; y: number } | null = null;
  private primitiveStartCanvas: { x: number; y: number } | null = null;
  private lastPreviewCells: [number, number][] = [];
  private activePrimitive: FieldPrimitive = "point";
  // non-null only when activePrimitive !== "point" and gesture is active
  private activeShapePrimitive: ShapePrimitive | null = null;
  private lastGridRadius = 0;
  private lastEndGrid: { x: number; y: number } | null = null;
  private lastEndWorld: { x: number; y: number } | null = null;

  private canvas: HTMLCanvasElement;
  private getProjection: () => TessellationProjection | null;
  private getViewport: () => Container;
  private panCallbacks: PanCallbacks;
  private primitiveCallbacks: PrimitiveCallbacks;

  private onKeyDown = (e: KeyboardEvent) => {
    // Space-to-pan is a canvas-only gesture — must not swallow a literal space typed into a
    // text input/textarea elsewhere on the page (e.g. renaming a rule/stage), which this
    // listener would otherwise do globally via `window`, regardless of focus.
    if (isTypingTarget(e.target)) return;
    if (e.code === "Space") { e.preventDefault(); this.spaceHeld = true; }
    if (e.key === "Shift") this.shiftHeld = true;
    if (e.key === "Control") this.controlHeld = true;
    if (e.code === "Escape") this.cancelGesture();
  };
  private onKeyUp = (e: KeyboardEvent) => {
    if (e.code === "Space") this.spaceHeld = false;
    if (e.key === "Shift") this.shiftHeld = false;
    if (e.key === "Control") this.controlHeld = false;
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
    const field = s.floorFields[s.activeFloorId];
    if (!(s.openCard === "field_setup" && field.fieldEditMode === "custom")) return;

    // RMB pointerup never fires on Windows/Chrome; commit stale RMB gesture here as fallback.
    if (this.gestureActive && this.gestureButton === 2) this.onPointerUp();
    this.gestureActive = true;
    this.gestureButton = button;
    this.activePrimitive = field.fieldPrimitive;

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
      this.primitiveStartWorld = this.gridToWorld(grid);
      this.primitiveStartCanvas = { x: canvasX, y: canvasY };
      this.activeShapePrimitive = this.activePrimitive as ShapePrimitive;
      this.lastGridRadius = 0;
      this.lastEndGrid = null;
      this.lastPreviewCells = [];
      // show initial shape at radius=1 immediately on mousedown
      const gs = useMazeStore.getState();
      const cfg = gs.floorFields[gs.activeFloorId].tessellationConfig;
      const kind = cfgKind(cfg.type);
      const initialCells = primitiveCells(this.activeShapePrimitive, { startGrid: grid, endGrid: grid, startWorld: this.primitiveStartWorld, endWorld: this.primitiveStartWorld, gridRadius: 1, kind, config: cfg, symmetric: this.shiftHeld, constrainSquare: this.controlHeld });
      this.lastPreviewCells = normalizePrimitiveCells(initialCells, kind, gs.smoothPrimitives);
      this.lastGridRadius = 1;
      this.lastEndGrid = grid;
      this.lastEndWorld = this.primitiveStartWorld;
      this.primitiveCallbacks.onPreviewUpdate(this.lastPreviewCells, button, kind, cfg, primitiveWorldGeometry(this.activeShapePrimitive, { startGrid: grid, endGrid: grid, startWorld: this.primitiveStartWorld, endWorld: this.primitiveStartWorld, gridRadius: 1, kind, config: cfg, symmetric: this.shiftHeld, constrainSquare: this.controlHeld }));
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
    if (!(s.openCard === "field_setup" && s.floorFields[s.activeFloorId].fieldEditMode === "custom")) return;

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
    } else if (this.primitiveStartGrid && this.primitiveStartWorld && this.primitiveStartCanvas && this.activeShapePrimitive) {
      const currentGrid = this.toGrid(canvasX, canvasY);
      if (!currentGrid) return;
      const currentWorld = this.toWorld(canvasX, canvasY);

      const screenDist = Math.hypot(canvasX - this.primitiveStartCanvas.x, canvasY - this.primitiveStartCanvas.y);
      const vp = this.getViewport();
      const tileScreenPx = TILE_SIZE * vp.scale.x;
      const gridRadius = Math.max(1, Math.round(screenDist / tileScreenPx));

      if (gridRadius === this.lastGridRadius
        && currentGrid.x === this.lastEndGrid?.x
        && currentGrid.y === this.lastEndGrid?.y
        && currentWorld.x === this.lastEndWorld?.x
        && currentWorld.y === this.lastEndWorld?.y) return;

      const ms = useMazeStore.getState();
      const cfg = ms.floorFields[ms.activeFloorId].tessellationConfig;
      const kind = cfgKind(cfg.type);
      const nextCells = primitiveCells(this.activeShapePrimitive, { startGrid: this.primitiveStartGrid, endGrid: currentGrid, startWorld: this.primitiveStartWorld, endWorld: currentWorld, gridRadius, kind, config: cfg, symmetric: this.shiftHeld, constrainSquare: this.controlHeld });
      this.lastPreviewCells = normalizePrimitiveCells(nextCells, kind, ms.smoothPrimitives);
      this.lastGridRadius = gridRadius;
      this.lastEndGrid = currentGrid;
      this.lastEndWorld = currentWorld;
      this.primitiveCallbacks.onPreviewUpdate(this.lastPreviewCells, this.gestureButton, kind, cfg, primitiveWorldGeometry(this.activeShapePrimitive, { startGrid: this.primitiveStartGrid, endGrid: currentGrid, startWorld: this.primitiveStartWorld, endWorld: currentWorld, gridRadius, kind, config: cfg, symmetric: this.shiftHeld, constrainSquare: this.controlHeld }));
    }
  }

  private cancelGesture(): void {
    if (!this.gestureActive) return;
    // Point streak commits cells on each move — no batch to cancel.
    // Escape only cancels shape-primitive gestures (preview cleared, nothing committed).
    if (this.activeShapePrimitive !== null && this.primitiveStartGrid !== null) {
      this.primitiveCallbacks.onPreviewClear();
      this.primitiveStartGrid = null;
      this.primitiveStartWorld = null;
      this.primitiveStartCanvas = null;
      this.activeShapePrimitive = null;
      this.lastPreviewCells = [];
      this.lastGridRadius = 0;
      this.lastEndGrid = null;
      this.lastEndWorld = null;
    }
    this.gestureActive = false;
    this.lastGridX = NaN;
    this.lastGridY = NaN;
  }

  cancelPointerGesture(): void {
    if (this.gestureActive && (this.spaceHeld || this.gestureButton === 1)) {
      this.panCallbacks.endPan();
    }
    this.cancelGesture();
  }

  onPointerUp(): void {
    if (!this.gestureActive) return;

    if (this.spaceHeld || this.gestureButton === 1) {
      this.panCallbacks.endPan();
    } else if (this.activeShapePrimitive !== null && this.primitiveStartGrid !== null) {
      this.primitiveCallbacks.onPreviewClear();
      this.primitiveCallbacks.onPrimitiveCommit(this.lastPreviewCells, this.gestureButton);
      this.primitiveStartGrid = null;
      this.primitiveStartWorld = null;
      this.primitiveStartCanvas = null;
      this.activeShapePrimitive = null;
      this.lastPreviewCells = [];
      this.lastGridRadius = 0;
      this.lastEndGrid = null;
      this.lastEndWorld = null;
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

  isGestureActive(): boolean {
    return this.gestureActive;
  }

  private toGrid(canvasX: number, canvasY: number): { x: number; y: number } | null {
    const proj = this.getProjection();
    if (!proj) return null;
    return canvasToGrid(canvasX, canvasY, this.getViewport(), proj);
  }

  private toWorld(canvasX: number, canvasY: number): { x: number; y: number } {
    const viewport = this.getViewport();
    return {
      x: (canvasX - viewport.x) / viewport.scale.x,
      y: -(canvasY - viewport.y) / viewport.scale.y,
    };
  }

  private gridToWorld(grid: { x: number; y: number }): { x: number; y: number } {
    const projection = this.getProjection();
    if (!projection) return { x: 0, y: 0 };
    const screen = projection.gridToScreen(grid.x, grid.y);
    return { x: screen.x, y: -screen.y };
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
