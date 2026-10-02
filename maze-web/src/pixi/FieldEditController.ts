import { useMazeStore } from "../store/mazeStore";
import type { TessellationProjection } from "./tessellationProjection";
import type { Container } from "pixi.js";
import { TILE_SIZE } from "./constants";
import { normalizePrimitiveCells, primitiveCells, primitiveWorldGeometry, cfgKind } from "./primitiveGeometry";
import type { ShapePrimitive, TessellationKind } from "./primitiveGeometry";
import { cellsInsidePolygon, polygonWorldGeometry } from "./polygonGeometry";
import type { PolygonPoint } from "./polygonGeometry";
import type { FieldPrimitive } from "../store/mazeStore";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { canvasToGrid } from "./hoverProviders";
import { decodePoint, encodePoint } from "./tessellationProjection";
import { sideOfAxis, snapSymmetryPoint, symmetryStatus, worldPointForCell, type SymmetryPoint } from "./symmetry";
import { selectionBoundarySegments } from "./fieldSelectionGeometry";
import { canvas } from "./colorTokens";

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
  onMoveCommit?: (cells: [number, number][], dx: number, dy: number) => boolean;
  onMovePreview?: (sourceCells: [number, number][], temporaryCells: [number, number][]) => void;
  onMoveComplete?: () => void;
  onSymmetryPreviewUpdate?: (axis: SymmetryPoint[], polygon: SymmetryPoint[]) => void;
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
  private polygonPoints: PolygonPoint[] = [];
  private polygonGridPoints: { x: number; y: number }[] = [];
  private polygonCursorPoint: PolygonPoint | null = null;
  private draggedPolygonIndex: number | null = null;
  private polygonDragStartCanvas: { x: number; y: number } | null = null;
  private polygonDragOriginalPoint: PolygonPoint | null = null;
  private polygonCloseCandidate = false;
  private lastPointerCanvas: { x: number; y: number } | null = null;
  private movePolygonPoints: PolygonPoint[] = [];
  private movePolygonGridPoints: { x: number; y: number }[] = [];
  private movePolygonCursorPoint: PolygonPoint | null = null;
  private moveSelectionCells: [number, number][] = [];
  private moveSelectionFinished = false;
  private movingSelection = false;
  private moveDragStartGrid: { x: number; y: number } | null = null;
  private moveDragStartDelta: { x: number; y: number } | null = null;
  private moveDelta = { x: 0, y: 0 };
  private symmetryDraggedPolygonIndex: number | null = null;
  private symmetryDragStartCanvas: { x: number; y: number } | null = null;
  private symmetryDragOriginalPoint: SymmetryPoint | null = null;
  private symmetryDraggedAxisIndex: number | null = null;
  private symmetryAxisDragStartCanvas: { x: number; y: number } | null = null;
  private symmetryAxisDragOriginalPoint: SymmetryPoint | null = null;

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
    if (e.key === "Shift") {
      this.shiftHeld = true;
      if (this.lastPointerCanvas && this.polygonPoints.length > 0) {
        this.updatePolygonCursor(this.lastPointerCanvas.x, this.lastPointerCanvas.y);
      }
    }
    if (e.key === "Control") {
      this.controlHeld = true;
      if (this.lastPointerCanvas && this.polygonPoints.length > 0) {
        this.updatePolygonCursor(this.lastPointerCanvas.x, this.lastPointerCanvas.y);
      }
    }
    if (e.code === "Escape") this.cancelGesture();
    if (e.code === "Backspace" || e.code === "Delete") {
      const state = useMazeStore.getState();
      const field = state.floorFields[state.activeFloorId];
      if (field.fieldPrimitive === "move" && this.moveSelectionFinished) {
        e.preventDefault();
        this.deleteMoveSelection();
      }
    }
    if (e.code === "Enter") {
      const state = useMazeStore.getState();
      const field = state.floorFields[state.activeFloorId];
      if (field.fieldPrimitive === "symmetry") {
        const status = symmetryStatus({
          axisPoints: state.symmetryAxisPoints,
          scope: state.symmetryScope,
          polygon: state.symmetryPolygon,
          polygonFinished: state.symmetryPolygonFinished,
        });
        if (status === "ready") {
          state.applySymmetry();
        } else if (state.symmetryScope === "polygon") {
          state.finishSymmetryPolygon();
          this.primitiveCallbacks.onSymmetryPreviewUpdate?.(state.symmetryAxisPoints, state.symmetryPolygon);
        }
      } else if (field.fieldPrimitive === "move") {
        if (this.movingSelection) this.commitMoveSelection();
        else if (!this.moveSelectionFinished) this.finishMoveSelection();
        else this.commitMoveSelection();
      } else {
        this.commitPolygon();
      }
    }
  };
  private onKeyUp = (e: KeyboardEvent) => {
    if (e.code === "Space") this.spaceHeld = false;
    if (e.key === "Shift") {
      this.shiftHeld = false;
      if (this.lastPointerCanvas && this.polygonPoints.length > 0) {
        this.updatePolygonCursor(this.lastPointerCanvas.x, this.lastPointerCanvas.y);
      }
    }
    if (e.key === "Control") {
      this.controlHeld = false;
      if (this.lastPointerCanvas && this.polygonPoints.length > 0) {
        this.updatePolygonCursor(this.lastPointerCanvas.x, this.lastPointerCanvas.y);
      }
    }
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

  onPointerDown(canvasX: number, canvasY: number, button: number, _shiftKey?: boolean, clickCount = 1): void {
    this.lastPointerCanvas = { x: canvasX, y: canvasY };
    const s = useMazeStore.getState();
    const field = s.floorFields[s.activeFloorId];
    if (!(s.openCard === "field_setup" && field.fieldEditMode === "custom")) return;

    // RMB pointerup never fires on Windows/Chrome; commit stale RMB gesture here as fallback.
    if (this.gestureActive && this.gestureButton === 2) this.onPointerUp();
    this.gestureActive = true;
    this.gestureButton = button;
    this.activePrimitive = field.fieldPrimitive;

    if (this.polygonPoints.length > 0 && this.activePrimitive !== "polygon") this.clearPolygon();
    if (this.movePolygonPoints.length > 0 && this.activePrimitive !== "move") this.clearMoveSelection();

    if (this.spaceHeld || button === 1) {
      this.panCallbacks.startPan(canvasX, canvasY);
      return;
    }

    if (this.activePrimitive === "symmetry") {
      this.handleSymmetryPointerDown(canvasX, canvasY, button);
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
    } else if (this.activePrimitive === "polygon") {
      if (button === 2) {
        this.cancelGesture();
        return;
      }
      if (button !== 0) return;
      const grid = this.toGrid(canvasX, canvasY);
      if (!grid) return;

      const nodeIndex = this.findPolygonNode(canvasX, canvasY);
      const lastIndex = this.polygonPoints.length - 1;
      const isLastPoint = nodeIndex === lastIndex
        || (this.polygonGridPoints.length > 0
          && grid.x === this.polygonGridPoints[lastIndex]?.x
          && grid.y === this.polygonGridPoints[lastIndex]?.y);
      if (clickCount >= 2 && this.polygonPoints.length >= 3 && isLastPoint) {
        this.commitPolygon();
        return;
      }
      if (nodeIndex !== null) {
        this.draggedPolygonIndex = nodeIndex;
        this.polygonDragStartCanvas = { x: canvasX, y: canvasY };
        this.polygonDragOriginalPoint = { ...this.polygonPoints[nodeIndex] };
        this.polygonCloseCandidate = nodeIndex === 0 && this.polygonPoints.length >= 3;
        this.polygonCursorPoint = null;
        this.updatePolygonPreview();
        return;
      }
      if (this.polygonGridPoints.length >= 3
        && grid.x === this.polygonGridPoints[0].x
        && grid.y === this.polygonGridPoints[0].y) {
        this.commitPolygon();
        return;
      }
      const previous = this.polygonGridPoints[this.polygonGridPoints.length - 1];
      if (previous?.x === grid.x && previous.y === grid.y) return;
      this.polygonGridPoints.push(grid);
      this.polygonPoints.push(this.inputWorldPoint(canvasX, canvasY, grid));
      this.polygonCursorPoint = null;
      this.updatePolygonPreview();
    } else if (this.activePrimitive === "move") {
      this.handleMovePointerDown(canvasX, canvasY, button, clickCount);
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
    this.lastPointerCanvas = { x: canvasX, y: canvasY };
    // Windows/Chrome doesn't fire pointerup for RMB; detect release via buttons mask.
    if (this.gestureActive && this.gestureButton === 2 && (buttons & 2) === 0) {
      this.onPointerUp();
      return;
    }
    const s = useMazeStore.getState();
    const field = s.floorFields[s.activeFloorId];
    if (!(s.openCard === "field_setup" && field.fieldEditMode === "custom")) return;

    if (!this.gestureActive) {
      if (field.fieldPrimitive === "symmetry") {
        this.updateSymmetryCursor(canvasX, canvasY);
        return;
      }
      if (field.fieldPrimitive === "polygon" && this.polygonPoints.length > 0) {
        this.activePrimitive = "polygon";
        this.updatePolygonCursor(canvasX, canvasY);
      } else if (field.fieldPrimitive === "move" && this.movePolygonPoints.length > 0) {
        this.activePrimitive = "move";
        this.updateMovePolygonCursor(canvasX, canvasY);
      }
      return;
    }

    if (this.spaceHeld || this.gestureButton === 1) {
      this.panCallbacks.movePan(canvasX, canvasY);
      return;
    }

    if (this.activePrimitive === "symmetry") {
      if (this.symmetryDraggedAxisIndex !== null && this.symmetryAxisDragStartCanvas) {
        const moved = Math.hypot(canvasX - this.symmetryAxisDragStartCanvas.x, canvasY - this.symmetryAxisDragStartCanvas.y) >= 3;
        if (moved) {
          const state = useMazeStore.getState();
          const field = state.floorFields[state.activeFloorId];
          const point = snapSymmetryPoint(this.toWorld(canvasX, canvasY), state.symmetrySnapMode, field.tessellationConfig);
          const axis = [...state.symmetryAxisPoints];
          axis[this.symmetryDraggedAxisIndex] = point;
          state.setSymmetryAxisPoints(axis);
          this.primitiveCallbacks.onSymmetryPreviewUpdate?.(axis, state.symmetryPolygon);
        }
        return;
      }
      if (this.symmetryDraggedPolygonIndex !== null && this.symmetryDragStartCanvas) {
        const moved = Math.hypot(canvasX - this.symmetryDragStartCanvas.x, canvasY - this.symmetryDragStartCanvas.y) >= 3;
        if (moved) {
          const state = useMazeStore.getState();
          const field = state.floorFields[state.activeFloorId];
          const polygon = [...state.symmetryPolygon];
          const point = snapSymmetryPoint(this.toWorld(canvasX, canvasY), state.symmetrySnapMode, field.tessellationConfig);
          polygon[this.symmetryDraggedPolygonIndex] = point;
          state.setSymmetryPolygon(polygon);
          this.primitiveCallbacks.onSymmetryPreviewUpdate?.(state.symmetryAxisPoints, polygon);
        }
      }
      return;
    }

    if (this.activePrimitive === "point") {
      const grid = this.toGrid(canvasX, canvasY);
      if (!grid) return;
      if (grid.x === this.lastGridX && grid.y === this.lastGridY) return;
      this.applyEdit(grid.x, grid.y, this.gestureButton);
      this.lastGridX = grid.x;
      this.lastGridY = grid.y;
    } else if (this.activePrimitive === "move") {
      this.handleMovePointerMove(canvasX, canvasY);
    } else if (this.activePrimitive === "polygon") {
      if (this.draggedPolygonIndex !== null && this.polygonDragStartCanvas) {
        const moved = Math.hypot(
          canvasX - this.polygonDragStartCanvas.x,
          canvasY - this.polygonDragStartCanvas.y,
        ) >= 3;
        if (moved) {
          this.polygonCloseCandidate = false;
          const grid = this.toGrid(canvasX, canvasY);
          if (grid) {
            this.polygonPoints[this.draggedPolygonIndex] = this.inputWorldPoint(canvasX, canvasY, grid);
            this.polygonGridPoints[this.draggedPolygonIndex] = grid;
            this.polygonCursorPoint = null;
            this.updatePolygonPreview();
          }
        }
      }
      return;
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

  /** Commits the polygon after Pixi's `pointertap` reports a double-click. */
  onDoubleClick(canvasX: number, canvasY: number, button = 0): void {
    if (button !== 0) return;
    const state = useMazeStore.getState();
    const field = state.floorFields[state.activeFloorId];
    if (field.fieldPrimitive === "symmetry") {
      if (state.symmetryScope === "polygon" && state.symmetryPolygon.length >= 3 && state.symmetryAxisPoints.length === 2) {
        state.finishSymmetryPolygon();
        this.primitiveCallbacks.onSymmetryPreviewUpdate?.(state.symmetryAxisPoints, state.symmetryPolygon);
      }
      this.updateSymmetryCursor(canvasX, canvasY);
      return;
    }
    if (field.fieldPrimitive === "move") {
      if (this.moveSelectionFinished) this.commitMoveSelection();
      else if (this.movePolygonPoints.length >= 3) this.finishMoveSelection();
      return;
    }
    if (!(state.openCard === "field_setup"
      && field.fieldEditMode === "custom"
      && field.fieldPrimitive === "polygon"
      && this.polygonPoints.length >= 3)) return;

    const grid = this.toGrid(canvasX, canvasY);
    const lastIndex = this.polygonPoints.length - 1;
    const nodeIndex = grid ? this.findPolygonNode(canvasX, canvasY) : null;
    const isLastPoint = nodeIndex === lastIndex
      || (grid !== null
        && grid.x === this.polygonGridPoints[lastIndex]?.x
        && grid.y === this.polygonGridPoints[lastIndex]?.y);
    if (isLastPoint) this.commitPolygon();
  }

  private cancelGesture(): void {
    if (this.activePrimitive === "symmetry") {
      if (this.symmetryDraggedPolygonIndex !== null && this.symmetryDragOriginalPoint) {
        const state = useMazeStore.getState();
        const polygon = [...state.symmetryPolygon];
        polygon[this.symmetryDraggedPolygonIndex] = this.symmetryDragOriginalPoint;
        state.setSymmetryPolygon(polygon);
      }
      if (this.symmetryDraggedAxisIndex !== null && this.symmetryAxisDragOriginalPoint) {
        const state = useMazeStore.getState();
        const axis = [...state.symmetryAxisPoints];
        axis[this.symmetryDraggedAxisIndex] = this.symmetryAxisDragOriginalPoint;
        state.setSymmetryAxisPoints(axis);
      }
      this.gestureActive = false;
      if (this.symmetryDraggedPolygonIndex !== null) {
        this.symmetryDraggedPolygonIndex = null;
        this.symmetryDragStartCanvas = null;
        this.symmetryDragOriginalPoint = null;
      }
      this.symmetryDraggedAxisIndex = null;
      this.symmetryAxisDragStartCanvas = null;
      this.symmetryAxisDragOriginalPoint = null;
      this.primitiveCallbacks.onSymmetryPreviewUpdate?.(useMazeStore.getState().symmetryAxisPoints, useMazeStore.getState().symmetryPolygon);
      return;
    }
    if (this.activePrimitive === "move") {
      this.clearMoveSelection();
      this.gestureActive = false;
      this.activePrimitive = "point";
      useMazeStore.getState().setFieldPrimitive("point");
      return;
    }
    if (this.draggedPolygonIndex !== null) {
      if (this.polygonDragOriginalPoint) {
        this.polygonPoints[this.draggedPolygonIndex] = this.polygonDragOriginalPoint;
        const restoredGrid = this.toGridPoint(this.polygonDragOriginalPoint);
        if (restoredGrid) this.polygonGridPoints[this.draggedPolygonIndex] = restoredGrid;
      }
      this.clearPolygonDragState();
      this.updatePolygonPreview();
      this.gestureActive = false;
      return;
    }
    if (this.polygonPoints.length > 0) {
      this.clearPolygon();
      this.gestureActive = false;
      this.lastGridX = NaN;
      this.lastGridY = NaN;
      return;
    }
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

  /** Completes a move before the field tool is replaced by another tool. */
  commitPendingMoveEdit(): void {
    if (this.activePrimitive !== "move") return;
    if (this.movingSelection) this.finishMoveDrag();
    if (this.moveSelectionFinished) this.commitMoveSelection();
    else {
      this.clearMoveSelection();
      this.activePrimitive = "point";
    }
    this.gestureActive = false;
  }

  onPointerUp(): void {
    if (!this.gestureActive) return;

    if (this.spaceHeld || this.gestureButton === 1) {
      this.panCallbacks.endPan();
    } else if (this.activePrimitive === "polygon") {
      if (this.draggedPolygonIndex !== null) {
        if (this.polygonCloseCandidate) {
          this.clearPolygonDragState();
          this.commitPolygon();
          return;
        }
        this.clearPolygonDragState();
        this.updatePolygonPreview();
      }
      // The polygon remains active between clicks until it is closed or confirmed with Enter.
    } else if (this.activePrimitive === "move") {
      if (this.movingSelection) this.finishMoveDrag();
    } else if (this.activePrimitive === "symmetry") {
      this.symmetryDraggedAxisIndex = null;
      this.symmetryAxisDragStartCanvas = null;
      this.symmetryAxisDragOriginalPoint = null;
      this.symmetryDraggedPolygonIndex = null;
      this.symmetryDragStartCanvas = null;
      this.symmetryDragOriginalPoint = null;
      this.primitiveCallbacks.onSymmetryPreviewUpdate?.(useMazeStore.getState().symmetryAxisPoints, useMazeStore.getState().symmetryPolygon);
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

  private handleMovePointerDown(canvasX: number, canvasY: number, button: number, clickCount: number): void {
    if (button === 2) {
      this.clearMoveSelection();
      this.gestureActive = false;
      return;
    }
    if (button !== 0) return;

    if (this.moveSelectionFinished) {
      this.handleSelectedMovePointerDown(canvasX, canvasY);
      return;
    }

    this.handleMovePolygonPointerDown(canvasX, canvasY, clickCount);
  }

  /** Handles interaction with the already confirmed piece, independently of polygon construction. */
  private handleSelectedMovePointerDown(canvasX: number, canvasY: number): void {
    const grid = this.toGrid(canvasX, canvasY);
    if (!grid) return;

    const selected = this.moveSelectionCells.some(([x, y]) => x + this.moveDelta.x === grid.x && y + this.moveDelta.y === grid.y);
    if (selected) {
      this.movingSelection = true;
      this.moveDragStartGrid = grid;
      this.moveDragStartDelta = { ...this.moveDelta };
      this.updateMovePreview();
      return;
    }
    this.clearMoveSelection();
  }

  /** Handles only the polygon-construction phase of select-and-move. */
  private handleMovePolygonPointerDown(canvasX: number, canvasY: number, clickCount: number): void {
    const grid = this.toGrid(canvasX, canvasY);
    if (!grid) return;

    if (this.movePolygonGridPoints.length >= 3
      && grid.x === this.movePolygonGridPoints[0].x
      && grid.y === this.movePolygonGridPoints[0].y) {
      this.finishMoveSelection();
      return;
    }
    const previous = this.movePolygonGridPoints[this.movePolygonGridPoints.length - 1];
    if (previous?.x === grid.x && previous.y === grid.y) return;
    this.movePolygonGridPoints.push(grid);
    this.movePolygonPoints.push(this.inputWorldPoint(canvasX, canvasY, grid));
    this.movePolygonCursorPoint = null;
    if (clickCount >= 2 && this.movePolygonPoints.length >= 3) this.finishMoveSelection();
    else this.updateMovePreview();
  }

  private handleMovePointerMove(canvasX: number, canvasY: number): void {
    if (this.movingSelection && this.moveDragStartGrid) {
      const grid = this.toGrid(canvasX, canvasY);
      if (!grid) return;
      this.moveDelta = this.safeMoveDelta({
        x: (this.moveDragStartDelta?.x ?? 0) + grid.x - this.moveDragStartGrid.x,
        y: (this.moveDragStartDelta?.y ?? 0) + grid.y - this.moveDragStartGrid.y,
      });
      this.updateMovePreview();
      return;
    }
    this.updateMovePolygonCursor(canvasX, canvasY);
  }

  private finishMoveSelection(): void {
    if (this.movePolygonPoints.length < 3) return;
    const state = useMazeStore.getState();
    const field = state.floorFields[state.activeFloorId];
    this.moveSelectionCells = this.activeCellsInsidePolygon(this.movePolygonPoints, field.tessellationConfig);
    this.moveSelectionFinished = true;
    this.movePolygonCursorPoint = null;
    this.updateMovePreview();
  }

  private commitMoveSelection(): void {
    if (!this.moveSelectionFinished) return;
    const { x: dx, y: dy } = this.moveDelta;
    if (dx !== 0 || dy !== 0) {
      const applied = this.primitiveCallbacks.onMoveCommit?.(this.moveSelectionCells, dx, dy) ?? false;
      if (!applied) {
        this.movingSelection = false;
        this.gestureActive = false;
        this.activePrimitive = "point";
        this.clearMoveSelection();
        this.primitiveCallbacks.onMoveComplete?.();
        return;
      }
      this.moveSelectionCells = this.moveSelectionCells.map(([x, y]) => [x + dx, y + dy]);
      const worldDelta = this.moveWorldDelta(dx, dy);
      this.movePolygonPoints = this.movePolygonPoints.map((point) => ({
        x: point.x + worldDelta.x,
        y: point.y + worldDelta.y,
      }));
      this.movePolygonGridPoints = this.movePolygonGridPoints.map((point) => ({
        x: point.x + dx,
        y: point.y + dy,
      }));
    }
    this.movingSelection = false;
    this.moveDragStartGrid = null;
    this.moveDragStartDelta = null;
    this.moveDelta = { x: 0, y: 0 };
    this.gestureActive = false;
    this.activePrimitive = "point";
    this.clearMoveSelection();
    this.primitiveCallbacks.onMoveComplete?.();
  }

  private deleteMoveSelection(): void {
    if (!this.moveSelectionFinished) return;
    if (this.movingSelection) this.finishMoveDrag();
    this.primitiveCallbacks.onPrimitiveCommit(this.moveSelectionCells, 2);
    this.activePrimitive = "point";
    this.gestureActive = false;
    this.clearMoveSelection();
    this.primitiveCallbacks.onMoveComplete?.();
  }

  private finishMoveDrag(): void {
    this.movingSelection = false;
    this.moveDragStartGrid = null;
    this.moveDragStartDelta = null;
    this.gestureActive = false;
    this.updateMovePreview();
  }

  private updateMovePolygonCursor(canvasX: number, canvasY: number): void {
    if (this.moveSelectionFinished || this.movePolygonPoints.length === 0) return;
    const grid = this.toGrid(canvasX, canvasY);
    if (!grid) return;
    this.movePolygonCursorPoint = this.inputWorldPoint(canvasX, canvasY, grid);
    this.updateMovePreview();
  }

  private updateMovePreview(): void {
    const state = useMazeStore.getState();
    const field = state.floorFields[state.activeFloorId];
    const cfg = field.tessellationConfig;
    const kind = cfgKind(cfg.type);
    const points = this.translatedMovePolygon();
    const previewPoints = this.moveSelectionFinished
      ? points
      : this.movePolygonCursorPoint
        ? [...this.movePolygonPoints, this.movePolygonCursorPoint]
        : [...this.movePolygonPoints];
    const hasPendingMove = this.moveSelectionFinished && (this.movingSelection || this.moveDelta.x !== 0 || this.moveDelta.y !== 0);
    const cells = this.moveSelectionFinished
      ? hasPendingMove
        ? this.moveSelectionCells.map(([x, y]) => [x + this.moveDelta.x, y + this.moveDelta.y] as [number, number])
        : []
      : this.activeCellsInsidePolygon(previewPoints, cfg);
    const boundaryCells = this.moveSelectionFinished
      ? hasPendingMove
        ? cells
        : this.moveSelectionCells
      : [];
    const geometry = this.moveSelectionFinished
      ? {
        kind: "boundary" as const,
        segments: selectionBoundarySegments(boundaryCells, kind, cfg),
        cellColor: canvas.fieldEditor.activeCell,
        cellAlpha: 1,
      }
      : polygonWorldGeometry(previewPoints, {
        vertexCount: this.movePolygonPoints.length,
        dashedClosing: this.movePolygonPoints.length >= 2,
        dashedAll: true,
        frameColor: 0xffffff,
        cellColor: 0xffffff,
      });
    this.primitiveCallbacks.onMovePreview?.(hasPendingMove ? this.moveSelectionCells : [], hasPendingMove ? cells : []);
    this.primitiveCallbacks.onPreviewUpdate(this.moveSelectionFinished ? [] : cells, 0, kind, cfg, geometry);
  }

  private translatedMovePolygon(): PolygonPoint[] {
    if (this.moveDelta.x === 0 && this.moveDelta.y === 0) return [...this.movePolygonPoints];
    const delta = this.moveWorldDelta(this.moveDelta.x, this.moveDelta.y);
    return this.movePolygonPoints.map((point) => ({ x: point.x + delta.x, y: point.y + delta.y }));
  }

  private moveWorldDelta(dx: number, dy: number): { x: number; y: number } {
    const anchor = this.movePolygonGridPoints[0] ?? { x: 0, y: 0 };
    const from = this.gridToWorld(anchor);
    const to = this.gridToWorld({ x: anchor.x + dx, y: anchor.y + dy });
    return { x: to.x - from.x, y: to.y - from.y };
  }

  private safeMoveDelta(delta: { x: number; y: number }): { x: number; y: number } {
    if (this.moveSelectionCells.length === 0) return { x: 0, y: 0 };
    const minX = Math.max(...this.moveSelectionCells.map(([x]) => -32768 - x));
    const maxX = Math.min(...this.moveSelectionCells.map(([x]) => 32767 - x));
    const minY = Math.max(...this.moveSelectionCells.map(([, y]) => -32768 - y));
    const maxY = Math.min(...this.moveSelectionCells.map(([, y]) => 32767 - y));
    return {
      x: Math.max(minX, Math.min(maxX, Math.trunc(delta.x))),
      y: Math.max(minY, Math.min(maxY, Math.trunc(delta.y))),
    };
  }

  private activeCellsInsidePolygon(points: PolygonPoint[], cfg: TessellationConfig): [number, number][] {
    const inside = new Set(cellsInsidePolygon(points, cfg).map(([x, y]) => encodePoint(x, y)));
    return [...useMazeStore.getState().floorFields[useMazeStore.getState().activeFloorId].fieldPoints]
      .map(decodePoint)
      .filter(([x, y]) => inside.has(encodePoint(x, y)));
  }

  private clearMoveSelection(): void {
    this.primitiveCallbacks.onPreviewClear();
    this.primitiveCallbacks.onMovePreview?.([], []);
    this.movePolygonPoints = [];
    this.movePolygonGridPoints = [];
    this.movePolygonCursorPoint = null;
    this.moveSelectionCells = [];
    this.moveSelectionFinished = false;
    this.movingSelection = false;
    this.moveDragStartGrid = null;
    this.moveDragStartDelta = null;
    this.moveDelta = { x: 0, y: 0 };
  }

  private updatePolygonPreview(): void {
    const state = useMazeStore.getState();
    const field = state.floorFields[state.activeFloorId];
    const cfg = field.tessellationConfig;
    const kind = cfgKind(cfg.type);
    const previewPoints = this.polygonCursorPoint
      ? [...this.polygonPoints, this.polygonCursorPoint]
      : [...this.polygonPoints];
    this.lastPreviewCells = previewPoints.length >= 3 ? cellsInsidePolygon(previewPoints, cfg) : [];
    this.primitiveCallbacks.onPreviewUpdate(
      this.lastPreviewCells,
      field.polygonOperation === "remove" ? 2 : 0,
      kind,
      cfg,
      polygonWorldGeometry(previewPoints, {
        vertexCount: this.polygonPoints.length,
        dashedClosing: this.polygonPoints.length >= 2,
      }),
    );
  }

  private updatePolygonCursor(canvasX: number, canvasY: number): void {
    if (this.polygonPoints.length === 0 || this.draggedPolygonIndex !== null) return;
    const grid = this.toGrid(canvasX, canvasY);
    if (!grid) return;
    this.polygonCursorPoint = this.inputWorldPoint(canvasX, canvasY, grid);
    this.updatePolygonPreview();
  }

  private commitPolygon(): void {
    const state = useMazeStore.getState();
    const field = state.floorFields[state.activeFloorId];
    if (!(state.openCard === "field_setup"
      && field.fieldEditMode === "custom"
      && field.fieldPrimitive === "polygon"
      && this.polygonPoints.length >= 3)) return;
    const committedCells = cellsInsidePolygon(this.polygonPoints, field.tessellationConfig);
    this.primitiveCallbacks.onPreviewClear();
    if (committedCells.length > 0) {
      this.primitiveCallbacks.onPrimitiveCommit(
        committedCells,
        field.polygonOperation === "remove" ? 2 : 0,
      );
    }
    this.clearPolygonState();
    this.gestureActive = false;
  }

  private clearPolygon(): void {
    this.primitiveCallbacks.onPreviewClear();
    this.clearPolygonState();
  }

  private clearPolygonState(): void {
    this.polygonPoints = [];
    this.polygonGridPoints = [];
    this.polygonCursorPoint = null;
    this.clearPolygonDragState();
    this.lastPreviewCells = [];
  }

  private clearPolygonDragState(): void {
    this.draggedPolygonIndex = null;
    this.polygonDragStartCanvas = null;
    this.polygonDragOriginalPoint = null;
    this.polygonCloseCandidate = false;
  }

  private inputWorldPoint(
    canvasX: number,
    canvasY: number,
    grid: { x: number; y: number },
  ): PolygonPoint {
    return this.shiftHeld ? this.toWorld(canvasX, canvasY) : this.gridToWorld(grid);
  }

  private handleSymmetryPointerDown(canvasX: number, canvasY: number, button: number): void {
    if (button !== 0) return;
    const state = useMazeStore.getState();
    const field = state.floorFields[state.activeFloorId];
    const point = snapSymmetryPoint(this.toWorld(canvasX, canvasY), state.symmetrySnapMode, field.tessellationConfig);
    const axisPoints = state.symmetryAxisPoints;
    if (axisPoints.length < 2) {
      const nextAxis = axisPoints.length === 0 ? [point] : [axisPoints[0], point];
      state.setSymmetryAxisPoints(nextAxis);
      if (nextAxis.length === 2) {
        const axis: [SymmetryPoint, SymmetryPoint] = [nextAxis[0], nextAxis[1]];
        const reference = [...field.fieldPoints].map(decodePoint)
          .map((cell) => worldPointForCell(cell, field.tessellationConfig))
          .find((candidate) => sideOfAxis(candidate, axis) !== 0);
        state.setSymmetrySourceSide(reference ? (sideOfAxis(reference, axis) < 0 ? -1 : 1) : 1);
      }
      this.primitiveCallbacks.onSymmetryPreviewUpdate?.(nextAxis, state.symmetryPolygon);
      return;
    }
    const axisNodeIndex = this.findSymmetryAxisNode(canvasX, canvasY, axisPoints);
    if (axisNodeIndex !== null) {
      this.symmetryDraggedAxisIndex = axisNodeIndex;
      this.symmetryAxisDragStartCanvas = { x: canvasX, y: canvasY };
      this.symmetryAxisDragOriginalPoint = axisPoints[axisNodeIndex];
      this.primitiveCallbacks.onSymmetryPreviewUpdate?.(axisPoints, state.symmetryPolygon);
      return;
    }
    if (state.symmetryScope !== "polygon") return;
    const polygon = [...state.symmetryPolygon];
    const nodeIndex = this.findSymmetryNode(canvasX, canvasY, polygon);
    if (nodeIndex !== null) {
      this.symmetryDraggedPolygonIndex = nodeIndex;
      this.symmetryDragStartCanvas = { x: canvasX, y: canvasY };
      this.symmetryDragOriginalPoint = polygon[nodeIndex];
      this.primitiveCallbacks.onSymmetryPreviewUpdate?.(state.symmetryAxisPoints, polygon);
      return;
    }
    if (state.symmetryPolygonFinished) return;
    const previous = polygon[polygon.length - 1];
    if (!previous || previous.x !== point.x || previous.y !== point.y) polygon.push(point);
    state.setSymmetryPolygon(polygon);
    this.primitiveCallbacks.onSymmetryPreviewUpdate?.(state.symmetryAxisPoints, polygon);
  }

  private updateSymmetryCursor(canvasX: number, canvasY: number): void {
    const state = useMazeStore.getState();
    const field = state.floorFields[state.activeFloorId];
    const axisPoints = state.symmetryAxisPoints;
    if (axisPoints.length === 1) {
      const point = snapSymmetryPoint(this.toWorld(canvasX, canvasY), state.symmetrySnapMode, field.tessellationConfig);
      this.primitiveCallbacks.onSymmetryPreviewUpdate?.([axisPoints[0], point], state.symmetryPolygon);
    } else if (axisPoints.length === 2 && state.symmetryScope === "polygon"
      && !state.symmetryPolygonFinished && state.symmetryPolygon.length > 0) {
      const cursor = snapSymmetryPoint(this.toWorld(canvasX, canvasY), state.symmetrySnapMode, field.tessellationConfig);
      this.primitiveCallbacks.onSymmetryPreviewUpdate?.(axisPoints, [...state.symmetryPolygon, cursor]);
    }
  }

  private findSymmetryNode(canvasX: number, canvasY: number, polygon: SymmetryPoint[]): number | null {
    const viewport = this.getViewport();
    let nearest: number | null = null;
    let distance = 12;
    polygon.forEach((point, index) => {
      const nodeX = viewport.x + point.x * viewport.scale.x;
      const nodeY = viewport.y - point.y * viewport.scale.y;
      const nextDistance = Math.hypot(canvasX - nodeX, canvasY - nodeY);
      if (nextDistance <= distance) {
        nearest = index;
        distance = nextDistance;
      }
    });
    return nearest;
  }

  private findSymmetryAxisNode(canvasX: number, canvasY: number, axis: SymmetryPoint[]): number | null {
    if (axis.length !== 2) return null;
    const viewport = this.getViewport();
    let nearest: number | null = null;
    let distance = 12;
    axis.forEach((point, index) => {
      const nodeX = viewport.x + point.x * viewport.scale.x;
      const nodeY = viewport.y - point.y * viewport.scale.y;
      const nextDistance = Math.hypot(canvasX - nodeX, canvasY - nodeY);
      if (nextDistance <= distance) {
        nearest = index;
        distance = nextDistance;
      }
    });
    return nearest;
  }

  private toGridPoint(point: PolygonPoint): { x: number; y: number } | null {
    const viewport = this.getViewport();
    const projection = this.getProjection();
    if (!projection) return null;
    return canvasToGrid(
      viewport.x + point.x * viewport.scale.x,
      viewport.y - point.y * viewport.scale.y,
      viewport,
      projection,
    );
  }

  private findPolygonNode(canvasX: number, canvasY: number): number | null {
    const viewport = this.getViewport();
    const hitRadius = 12;
    let nearest: number | null = null;
    let nearestDistance = hitRadius;
    this.polygonPoints.forEach((point, index) => {
      const nodeX = viewport.x + point.x * viewport.scale.x;
      const nodeY = viewport.y - point.y * viewport.scale.y;
      const distance = Math.hypot(canvasX - nodeX, canvasY - nodeY);
      if (distance <= nearestDistance) {
        nearest = index;
        nearestDistance = distance;
      }
    });
    return nearest;
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
