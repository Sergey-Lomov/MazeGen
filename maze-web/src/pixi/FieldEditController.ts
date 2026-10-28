import { notifyAutoFillPreviewActive } from "../notifications/fieldSetupNotifications";
import { useMazeStore } from "../store/mazeStore";
import type { TessellationProjection } from "./tessellationProjection";
import type { Container } from "pixi.js";
import { TILE_SIZE } from "./constants";
import { normalizeCellsToFixpoint, normalizePrimitiveCells, primitiveCells, primitiveWorldGeometry } from "./primitiveGeometry";
import type { PrimitiveContext, ShapePrimitive, TessellationKind } from "./primitiveGeometry";
import { cellsInsidePolygon, polygonWorldGeometry } from "./polygonGeometry";
import type { PolygonPoint } from "./polygonGeometry";
import type { FieldPrimitive } from "../store/mazeStore";
import type { FieldConfig } from "../fieldConfig";
import { canvasToGrid } from "./hoverProviders";
import { decodePoint, encodePoint } from "./tessellationProjection";
import { sideOfAxis, snapSymmetryPoint, symmetryStatus, worldPointForCell, type SymmetryPoint } from "./symmetry";
import { selectionBoundary } from "./fieldSelectionGeometry";
import { canvas } from "./colorTokens";
import { connectedMagicWandCells } from "./magicWand";
import { getCartesian } from "./cartesianCache";
import { fieldOperationAvailable, isFieldOpError } from "./fieldOps";
import { translateFieldCells, type WorldPoint } from "../wasm/mazeService";
import { canActivateFieldPrimitive, fieldPrimitiveForShortcut } from "./fieldPrimitiveShortcuts";
import { blurActiveElement } from "./toolShortcuts";
import { EMPTY_FIELD_SIZE_READOUT, measureCells, measureShape, mergeFieldSizeReadout, type FieldSizeReadout } from "./fieldSizeReadout";

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
  onPreviewUpdate: (cells: [number, number][], button: number, kind: TessellationKind, cfg: FieldConfig, geometry: ReturnType<typeof primitiveWorldGeometry>) => void;
  onPreviewClear: () => void;
  onPrimitiveCommit: (cells: [number, number][], button: number) => void;
  onSelectionMovePreview?: (sourceCells: [number, number][], temporaryCells: [number, number][]) => void;
  onSelectionMove?: (cells: [number, number][], vector: [number, number]) => boolean;
  onSymmetryPreviewUpdate?: (axis: SymmetryPoint[], polygon: SymmetryPoint[]) => void;
  onSizeReadout?: (readout: FieldSizeReadout) => void;
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
  private selectionPreviewVisible = false;
  private lastSizeReadout: FieldSizeReadout = EMPTY_FIELD_SIZE_READOUT;
  private selectionSourceCells: [number, number][] = [];
  private selectionCells: [number, number][] = [];
  /** Pending move in `maze-core` world units; always a translation symmetry of the tessellation. */
  private selectionPendingVector: [number, number] = [0, 0];
  private selectionDragActive = false;
  private selectionAdditiveGestureActive = false;
  /** World-space center of the cell the drag grabbed. */
  private selectionDragStartCenter: WorldPoint | null = null;
  private selectionDragBaseVector: [number, number] = [0, 0];
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
    const state = useMazeStore.getState();
    const field = state.floorFields[state.activeFloorId];
    if (state.backgroundAutoFillPreview !== null) return;
    if (state.openCard === "field_setup" && field.fieldEditMode === "custom" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const operation = e.key === "+" || e.code === "Equal" || e.code === "NumpadAdd"
        ? "add"
        : e.key === "-" || e.code === "Minus" || e.code === "NumpadSubtract"
          ? "remove"
          : e.key === "0" || e.code === "Digit0" || e.code === "Numpad0"
            ? "select"
            : null;
      if (operation) {
        e.preventDefault();
        blurActiveElement();
        state.setFieldOperation(operation);
        return;
      }
      const primitive = fieldPrimitiveForShortcut(e.code);
      if (primitive && canActivateFieldPrimitive(
        primitive,
        field.fieldOperation,
        state.backgroundAutoFillPreview !== null,
        fieldOperationAvailable(field.fieldConfig.tessellation, "reflect"),
      )) {
        e.preventDefault();
        blurActiveElement();
        state.setFieldPrimitive(primitive);
        return;
      }
    }
    if (e.code === "Space" && this.selectionPreviewVisible) {
      e.preventDefault();
      this.commitSelectionMove();
      return;
    }
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
      if (field.fieldOperation === "select" && this.selectionPreviewVisible) {
        e.preventDefault();
        this.deleteSelection();
        return;
      }
    }
    if (e.code === "Enter") {
      const state = useMazeStore.getState();
      const field = state.floorFields[state.activeFloorId];
      if (field.fieldOperation === "select" && this.selectionPreviewVisible) {
        e.preventDefault();
        this.commitSelectionMove();
      } else if (field.fieldPrimitive === "symmetry") {
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

    if (s.backgroundAutoFillPreview !== null) {
      if (this.spaceHeld || button === 1) {
        this.gestureActive = true;
        this.gestureButton = button;
        this.panCallbacks.startPan(canvasX, canvasY);
      } else {
        notifyAutoFillPreviewActive();
      }
      return;
    }

    // Selection is strictly a left-button operation. In particular, RMB must not
    // confirm/move the current selection or start another selection gesture.
    if (field.fieldOperation === "select" && button === 2) return;

    // RMB pointerup never fires on Windows/Chrome; commit stale RMB gesture here as fallback.
    if (this.gestureActive && this.gestureButton === 2) this.onPointerUp();
    this.gestureActive = true;
    this.gestureButton = button;
    this.activePrimitive = field.fieldPrimitive;

    if (this.selectionPreviewVisible) {
      const additiveSelection = field.fieldPrimitive === "point"
        && field.fieldOperation === "select"
        && button === 0
        && (this.shiftHeld || _shiftKey === true);
      if (additiveSelection) {
        const grid = this.toGrid(canvasX, canvasY);
        if (!grid) return;
        this.selectionAdditiveGestureActive = true;
        this.lastGridX = grid.x;
        this.lastGridY = grid.y;
        this.lastPreviewCells = this.mergeSelectionCells(this.selectionSourceCells, [[grid.x, grid.y]]);
        this.updatePointSelectionPreview();
        return;
      }
      const grid = button === 0 ? this.toGrid(canvasX, canvasY) : null;
      const selected = grid !== null && this.selectionCells.some(([x, y]) => x === grid.x && y === grid.y);
      if (field.fieldOperation === "select" && selected && fieldOperationAvailable(field.fieldConfig.tessellation, "translate")) {
        this.selectionDragActive = true;
        this.selectionDragStartCenter = getCartesian(grid.x, grid.y, field.fieldConfig);
        this.selectionDragBaseVector = [...this.selectionPendingVector];
        return;
      }
      this.commitSelectionMove();
      return;
    }

    if (this.polygonPoints.length > 0 && this.activePrimitive !== "polygon") this.clearPolygon();

    if (this.spaceHeld || button === 1) {
      this.panCallbacks.startPan(canvasX, canvasY);
      return;
    }

    if (this.activePrimitive === "symmetry") {
      this.handleSymmetryPointerDown(canvasX, canvasY, button);
      return;
    }

    if (this.activePrimitive === "magic_wand") {
      const grid = this.toGrid(canvasX, canvasY);
      if (grid && (button === 0 || button === 2)) this.applyMagicWand(grid.x, grid.y, button);
      this.gestureActive = false;
      return;
    }

    if (this.activePrimitive === "point") {
      this.lastGridX = NaN;
      this.lastGridY = NaN;
      this.lastPreviewCells = [];
      const grid = this.toGrid(canvasX, canvasY);
      if (!grid) return;
      if (field.fieldOperation === "select") {
        this.lastPreviewCells = [[grid.x, grid.y]];
        this.updatePointSelectionPreview();
      } else this.applyEdit(grid.x, grid.y, button);
      this.lastGridX = grid.x;
      this.lastGridY = grid.y;
    } else if (this.activePrimitive === "polygon") {
      if (button !== 0 && button !== 2) return;
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
      const cfg = gs.floorFields[gs.activeFloorId].fieldConfig;
      const kind = cfg.tessellation.kind;
      const initialCells = primitiveCells(this.activeShapePrimitive, { startGrid: grid, endGrid: grid, startWorld: this.primitiveStartWorld, endWorld: this.primitiveStartWorld, gridRadius: 1, kind, config: cfg, symmetric: this.shiftHeld, constrainSquare: this.controlHeld });
      this.lastPreviewCells = this.operationCells(normalizePrimitiveCells(initialCells, cfg, gs.smoothPrimitives));
      this.lastGridRadius = 1;
      this.lastEndGrid = grid;
      this.lastEndWorld = this.primitiveStartWorld;
      this.reportSize({ shape: measureShape(this.lastPreviewCells, this.activePrimitive) });
      this.primitiveCallbacks.onPreviewUpdate(this.lastPreviewCells, this.operationButton(), kind, cfg, this.primitivePreviewGeometry(this.activeShapePrimitive, { startGrid: grid, endGrid: grid, startWorld: this.primitiveStartWorld, endWorld: this.primitiveStartWorld, gridRadius: 1, kind, config: cfg, symmetric: this.shiftHeld, constrainSquare: this.controlHeld }));
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

    if (s.backgroundAutoFillPreview !== null) {
      if (this.gestureActive && (this.spaceHeld || this.gestureButton === 1)) {
        this.panCallbacks.movePan(canvasX, canvasY);
      }
      return;
    }

    if (!this.gestureActive) {
      if (field.fieldPrimitive === "symmetry") {
        this.updateSymmetryCursor(canvasX, canvasY);
        return;
      }
      if (field.fieldPrimitive === "polygon" && this.polygonPoints.length > 0) {
        this.activePrimitive = "polygon";
        this.updatePolygonCursor(canvasX, canvasY);
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
          const point = snapSymmetryPoint(this.toWorld(canvasX, canvasY), state.symmetrySnapMode, field.fieldConfig);
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
          const point = snapSymmetryPoint(this.toWorld(canvasX, canvasY), state.symmetrySnapMode, field.fieldConfig);
          polygon[this.symmetryDraggedPolygonIndex] = point;
          state.setSymmetryPolygon(polygon);
          this.primitiveCallbacks.onSymmetryPreviewUpdate?.(state.symmetryAxisPoints, polygon);
        }
      }
      return;
    }

    if (this.selectionDragActive) {
      this.updateSelectionDrag(canvasX, canvasY);
      return;
    }

    if (this.selectionAdditiveGestureActive) {
      const grid = this.toGrid(canvasX, canvasY);
      if (!grid) return;
      if (grid.x === this.lastGridX && grid.y === this.lastGridY) return;
      this.lastPreviewCells = this.mergeSelectionCells(this.lastPreviewCells, [[grid.x, grid.y]]);
      this.updatePointSelectionPreview();
      this.lastGridX = grid.x;
      this.lastGridY = grid.y;
      return;
    }

    if (this.activePrimitive === "point") {
      const grid = this.toGrid(canvasX, canvasY);
      if (!grid) return;
      if (grid.x === this.lastGridX && grid.y === this.lastGridY) return;
      if (field.fieldOperation === "select") {
        this.lastPreviewCells = this.mergeSelectionCells(this.lastPreviewCells, [[grid.x, grid.y]]);
        this.updatePointSelectionPreview();
      } else {
        this.applyEdit(grid.x, grid.y, this.gestureButton);
      }
      this.lastGridX = grid.x;
      this.lastGridY = grid.y;
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
      const cfg = ms.floorFields[ms.activeFloorId].fieldConfig;
      const kind = cfg.tessellation.kind;
      const nextCells = primitiveCells(this.activeShapePrimitive, { startGrid: this.primitiveStartGrid, endGrid: currentGrid, startWorld: this.primitiveStartWorld, endWorld: currentWorld, gridRadius, kind, config: cfg, symmetric: this.shiftHeld, constrainSquare: this.controlHeld });
      this.lastPreviewCells = this.operationCells(normalizePrimitiveCells(nextCells, cfg, ms.smoothPrimitives));
      this.lastGridRadius = gridRadius;
      this.lastEndGrid = currentGrid;
      this.lastEndWorld = currentWorld;
      this.reportSize({ shape: measureShape(this.lastPreviewCells, this.activePrimitive) });
      this.primitiveCallbacks.onPreviewUpdate(this.lastPreviewCells, this.operationButton(), kind, cfg, this.primitivePreviewGeometry(this.activeShapePrimitive, { startGrid: this.primitiveStartGrid, endGrid: currentGrid, startWorld: this.primitiveStartWorld, endWorld: currentWorld, gridRadius, kind, config: cfg, symmetric: this.shiftHeld, constrainSquare: this.controlHeld }));
    }
  }

  /** Commits the polygon after Pixi's `pointertap` reports a double-click. */
  onDoubleClick(canvasX: number, canvasY: number, button = 0): void {
    if (button !== 0) return;
    const state = useMazeStore.getState();
    if (state.backgroundAutoFillPreview !== null) return;
    const field = state.floorFields[state.activeFloorId];
    if (field.fieldPrimitive === "symmetry") {
      if (state.symmetryScope === "polygon" && state.symmetryPolygon.length >= 3 && state.symmetryAxisPoints.length === 2) {
        state.finishSymmetryPolygon();
        this.primitiveCallbacks.onSymmetryPreviewUpdate?.(state.symmetryAxisPoints, state.symmetryPolygon);
      }
      this.updateSymmetryCursor(canvasX, canvasY);
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
    if (this.selectionPreviewVisible) {
      this.clearSelectionPreview();
    }
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
      this.clearPreview();
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
    const previewing = useMazeStore.getState().backgroundAutoFillPreview !== null;
    if (previewing) {
      if (this.gestureActive && (this.spaceHeld || this.gestureButton === 1)) this.panCallbacks.endPan();
      this.cancelGesture();
      return;
    }
    if (!this.gestureActive) return;

    if (this.spaceHeld || this.gestureButton === 1) {
      this.panCallbacks.endPan();
    } else if (this.selectionDragActive) {
      this.selectionDragActive = false;
      this.selectionDragStartCenter = null;
      this.updateSelectionPreview();
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
    } else if (this.selectionAdditiveGestureActive) {
      const state = useMazeStore.getState();
      const field = state.floorFields[state.activeFloorId];
      this.selectionAdditiveGestureActive = false;
      this.showSelection(this.operationCells(this.lastPreviewCells), field.fieldConfig.tessellation.kind, field.fieldConfig);
    } else if (this.activePrimitive === "point" && useMazeStore.getState().floorFields[useMazeStore.getState().activeFloorId].fieldOperation === "select") {
      const state = useMazeStore.getState();
      const field = state.floorFields[state.activeFloorId];
      this.showSelection(this.operationCells(this.lastPreviewCells), field.fieldConfig.tessellation.kind, field.fieldConfig);
    } else if (this.activePrimitive === "symmetry") {
      this.symmetryDraggedAxisIndex = null;
      this.symmetryAxisDragStartCanvas = null;
      this.symmetryAxisDragOriginalPoint = null;
      this.symmetryDraggedPolygonIndex = null;
      this.symmetryDragStartCanvas = null;
      this.symmetryDragOriginalPoint = null;
      this.primitiveCallbacks.onSymmetryPreviewUpdate?.(useMazeStore.getState().symmetryAxisPoints, useMazeStore.getState().symmetryPolygon);
    } else if (this.activeShapePrimitive !== null && this.primitiveStartGrid !== null) {
      const state = useMazeStore.getState();
      const field = state.floorFields[state.activeFloorId];
      if (field.fieldOperation === "select") {
        this.showSelection(this.lastPreviewCells, field.fieldConfig.tessellation.kind, field.fieldConfig);
      } else {
        this.clearPreview();
        this.primitiveCallbacks.onPrimitiveCommit(this.lastPreviewCells, this.operationButton());
      }
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
    if (useMazeStore.getState().backgroundAutoFillPreview !== null) return null;
    const grid = this.toGrid(canvasX, canvasY);
    if (!grid) return null;
    return [grid.x, grid.y];
  }

  getMagicWandPreview(canvasX: number, canvasY: number): [number, number][] {
    const state = useMazeStore.getState();
    if (state.backgroundAutoFillPreview !== null) return [];
    const field = state.floorFields[state.activeFloorId];
    if (field.fieldPrimitive !== "magic_wand") return [];
    const grid = this.toGrid(canvasX, canvasY);
    if (!grid) return [];
    return this.magicWandCellsAt(grid.x, grid.y, field.fieldOperation) ?? [];
  }

  isGestureActive(): boolean {
    return this.gestureActive;
  }

  hasSelectionPreview(): boolean {
    return this.selectionPreviewVisible;
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

  private updatePolygonPreview(): void {
    const state = useMazeStore.getState();
    const field = state.floorFields[state.activeFloorId];
    const cfg = field.fieldConfig;
    const kind = cfg.tessellation.kind;
    const previewPoints = this.polygonCursorPoint
      ? [...this.polygonPoints, this.polygonCursorPoint]
      : [...this.polygonPoints];
    this.lastPreviewCells = previewPoints.length >= 3
      ? this.operationCells(this.polygonCells(previewPoints))
      : [];
    this.reportSize({ shape: measureShape(this.lastPreviewCells, "polygon") });
    this.primitiveCallbacks.onPreviewUpdate(
      this.lastPreviewCells,
      this.operationButton(),
      kind,
      cfg,
      polygonWorldGeometry(previewPoints, {
        vertexCount: this.polygonPoints.length,
        dashedClosing: this.polygonPoints.length >= 2,
        ...(field.fieldOperation === "select" ? { dashedAll: true } : {}),
      }),
    );
  }

  /** Polygon cells without isolated cells and, with smoothing, single-connection spikes. When
   * adding, cells already in the field count as neighbors. */
  private polygonCells(points: PolygonPoint[]): [number, number][] {
    const state = useMazeStore.getState();
    const field = state.floorFields[state.activeFloorId];
    const cells = cellsInsidePolygon(points, field.fieldConfig);
    const adding = this.effectiveOperation(this.gestureButton) === "add";
    return normalizeCellsToFixpoint(
      cells,
      field.fieldConfig,
      state.smoothPrimitives,
      adding ? (x, y) => field.fieldPoints.has(encodePoint(x, y)) : undefined,
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
    const committedCells = this.operationCells(this.polygonCells(this.polygonPoints));
    if (field.fieldOperation === "select") {
      this.showSelection(committedCells, field.fieldConfig.tessellation.kind, field.fieldConfig);
    } else {
      this.clearPreview();
    }
    if (field.fieldOperation !== "select" && committedCells.length > 0) {
      this.primitiveCallbacks.onPrimitiveCommit(
        committedCells,
        this.operationButton(),
      );
    }
    this.clearPolygonState();
    this.gestureActive = false;
  }

  private clearPolygon(): void {
    this.clearPreview();
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
    const point = snapSymmetryPoint(this.toWorld(canvasX, canvasY), state.symmetrySnapMode, field.fieldConfig);
    const axisPoints = state.symmetryAxisPoints;
    if (axisPoints.length < 2) {
      const nextAxis = axisPoints.length === 0 ? [point] : [axisPoints[0], point];
      state.setSymmetryAxisPoints(nextAxis);
      if (nextAxis.length === 2) {
        const axis: [SymmetryPoint, SymmetryPoint] = [nextAxis[0], nextAxis[1]];
        const reference = [...field.fieldPoints].map(decodePoint)
          .map((cell) => worldPointForCell(cell, field.fieldConfig))
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
      const point = snapSymmetryPoint(this.toWorld(canvasX, canvasY), state.symmetrySnapMode, field.fieldConfig);
      this.primitiveCallbacks.onSymmetryPreviewUpdate?.([axisPoints[0], point], state.symmetryPolygon);
    } else if (axisPoints.length === 2 && state.symmetryScope === "polygon"
      && !state.symmetryPolygonFinished && state.symmetryPolygon.length > 0) {
      const cursor = snapSymmetryPoint(this.toWorld(canvasX, canvasY), state.symmetrySnapMode, field.fieldConfig);
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

  private effectiveOperation(button: number): "add" | "remove" | "select" {
    const operation = useMazeStore.getState().floorFields[useMazeStore.getState().activeFloorId].fieldOperation;
    if (operation === "select" || button !== 2) return operation;
    return operation === "add" ? "remove" : "add";
  }

  private applyEdit(x: number, y: number, button: number): void {
    const store = useMazeStore.getState();
    const operation = this.effectiveOperation(button);
    if (operation === "add") {
      store.addFieldPoint(x, y);
    } else if (operation === "remove") {
      store.removeFieldPoint(x, y);
    }
  }

  private applyMagicWand(x: number, y: number, button: number): void {
    const state = useMazeStore.getState();
    const field = state.floorFields[state.activeFloorId];
    const operation = this.effectiveOperation(button);
    const cells = this.magicWandCellsAt(x, y, operation);
    if (!cells || cells.length === 0) return;
    if (operation === "select") {
      this.showSelection(cells, field.fieldConfig.tessellation.kind, field.fieldConfig);
    } else {
      this.primitiveCallbacks.onPrimitiveCommit(cells, operation === "remove" ? 2 : 0);
    }
  }

  private magicWandCellsAt(
    x: number,
    y: number,
    operation: "add" | "remove" | "select",
  ): [number, number][] | null {
    const state = useMazeStore.getState();
    const field = state.floorFields[state.activeFloorId];
    const startKey = encodePoint(x, y);

    // Select and Remove operate on occupied cells. Add operates on an empty component;
    // connectedMagicWandCells returns null for the unbounded empty component.
    if ((operation === "select" || operation === "remove") && !field.fieldPoints.has(startKey)) return null;
    if (operation === "add" && field.fieldPoints.has(startKey)) return null;

    return connectedMagicWandCells([x, y], field.fieldConfig, field.fieldPoints);
  }

  private operationButton(button = this.gestureButton): number {
    const operation = this.effectiveOperation(button);
    return operation === "remove" ? 2 : operation === "select" ? 1 : 0;
  }

  private operationCells(cells: [number, number][]): [number, number][] {
    const state = useMazeStore.getState();
    const field = state.floorFields[state.activeFloorId];
    if (field.fieldOperation !== "select") return cells;
    return cells.filter(([x, y]) => field.fieldPoints.has(encodePoint(x, y)));
  }

  private primitivePreviewGeometry(primitive: ShapePrimitive, context: PrimitiveContext): ReturnType<typeof primitiveWorldGeometry> {
    const geometry = primitiveWorldGeometry(primitive, context);
    if (useMazeStore.getState().floorFields[useMazeStore.getState().activeFloorId].fieldOperation !== "select") return geometry;
    if (geometry.kind === "ellipse") return { ...geometry, dashed: true };
    if (geometry.kind === "polygon") return { ...geometry, dashedAll: true };
    return geometry;
  }

  private mergeSelectionCells(current: [number, number][], next: [number, number][]): [number, number][] {
    return [...current, ...next]
      .filter(([x, y], index, cells) => cells.findIndex(([cx, cy]) => cx === x && cy === y) === index);
  }

  /** Clears the primitive preview and, with it, the status-bar size readout. */
  private clearPreview(): void {
    this.primitiveCallbacks.onPreviewClear();
    this.reportSize(EMPTY_FIELD_SIZE_READOUT);
  }

  /** Merges a partial update into the status-bar readout; the sink is notified only on a real change. */
  private reportSize(update: Partial<FieldSizeReadout>): void {
    const next = mergeFieldSizeReadout(this.lastSizeReadout, update);
    if (next === this.lastSizeReadout) return;
    this.lastSizeReadout = next;
    this.primitiveCallbacks.onSizeReadout?.(next);
  }

  private showSelection(cells: [number, number][], kind: TessellationKind, cfg: FieldConfig): void {
    this.primitiveCallbacks.onPreviewClear();
    this.reportSize({ selection: measureCells(cells), shape: null });
    this.selectionSourceCells = cells.map(([x, y]) => [x, y]);
    this.selectionCells = cells.map(([x, y]) => [x, y]);
    this.selectionPendingVector = [0, 0];
    this.selectionDragActive = false;
    this.selectionDragStartCenter = null;
    this.primitiveCallbacks.onPreviewUpdate(
      [],
      1,
      kind,
      cfg,
      {
        kind: "boundary",
        ...selectionBoundary(cells, cfg),
        cellColor: canvas.fieldEditor.previewSelect,
        cellAlpha: 1,
      },
    );
    this.selectionPreviewVisible = true;
  }

  private updatePointSelectionPreview(): void {
    const state = useMazeStore.getState();
    const field = state.floorFields[state.activeFloorId];
    const cfg = field.fieldConfig;
    const kind = cfg.tessellation.kind;
    this.reportSize({ selection: measureCells(this.lastPreviewCells) });
    this.primitiveCallbacks.onPreviewUpdate(
      this.lastPreviewCells,
      1,
      kind,
      cfg,
      {
        kind: "boundary",
        ...selectionBoundary(this.lastPreviewCells, cfg),
        cellColor: canvas.fieldEditor.previewSelect,
        cellAlpha: 0.5,
      },
    );
  }

  private updateSelectionDrag(canvasX: number, canvasY: number): void {
    if (!this.selectionDragStartCenter) return;
    const grid = this.toGrid(canvasX, canvasY);
    if (!grid) return;
    const cfg = useMazeStore.getState().floorFields[useMazeStore.getState().activeFloorId].fieldConfig;
    const center = getCartesian(grid.x, grid.y, cfg);
    const vector: [number, number] = [
      this.selectionDragBaseVector[0] + center[0] - this.selectionDragStartCenter[0],
      this.selectionDragBaseVector[1] + center[1] - this.selectionDragStartCenter[1],
    ];
    try {
      this.selectionCells = translateFieldCells(cfg.tessellation, this.selectionSourceCells, vector);
      this.selectionPendingVector = vector;
    } catch (error) {
      // A pointer position core refuses (no translation symmetry, outside the tessellation)
      // keeps the last valid preview, so the selection snaps between valid
      // positions.
      if (!isFieldOpError(error)) throw error;
      return;
    }
    this.updateSelectionPreview();
  }

  private updateSelectionPreview(): void {
    const state = useMazeStore.getState();
    const field = state.floorFields[state.activeFloorId];
    const cfg = field.fieldConfig;
    const kind = cfg.tessellation.kind;
    const hasPendingMove = this.selectionDragActive
      || this.hasPendingSelectionMove();
    // A translation can change the index span on offset-coordinate tessellations.
    this.reportSize({ selection: measureCells(this.selectionCells) });
    this.primitiveCallbacks.onSelectionMovePreview?.(
      hasPendingMove ? this.selectionSourceCells : [],
      hasPendingMove ? this.selectionCells : [],
    );
    this.primitiveCallbacks.onPreviewUpdate(
      [],
      1,
      kind,
      cfg,
      {
        kind: "boundary",
        ...selectionBoundary(this.selectionCells, cfg),
        cellColor: canvas.fieldEditor.previewSelect,
        cellAlpha: 0.5,
      },
    );
  }

  private hasPendingSelectionMove(): boolean {
    return this.selectionPendingVector[0] !== 0 || this.selectionPendingVector[1] !== 0;
  }

  private commitSelectionMove(): boolean {
    if (useMazeStore.getState().backgroundAutoFillPreview !== null) return false;
    if (!this.selectionPreviewVisible) return false;
    if (this.hasPendingSelectionMove()) {
      const applied = this.primitiveCallbacks.onSelectionMove?.(
        this.selectionSourceCells,
        this.selectionPendingVector,
      ) ?? false;
      if (!applied) return false;
    }
    this.exitSelectionMode();
    return true;
  }

  private deleteSelection(): void {
    if (useMazeStore.getState().backgroundAutoFillPreview !== null) return;
    if (!this.selectionPreviewVisible || this.selectionSourceCells.length === 0) return;
    this.primitiveCallbacks.onPrimitiveCommit(this.selectionSourceCells, 2);
    this.exitSelectionMode();
  }

  private exitSelectionMode(): void {
    this.clearSelectionPreview();
    this.gestureActive = false;
    const state = useMazeStore.getState();
    this.activePrimitive = state.floorFields[state.activeFloorId].fieldPrimitive;
  }

  commitPendingSelectionMove(): boolean {
    return this.commitSelectionMove();
  }

  private clearSelectionPreview(): void {
    this.primitiveCallbacks.onSelectionMovePreview?.([], []);
    this.clearPreview();
    this.selectionPreviewVisible = false;
    this.selectionSourceCells = [];
    this.selectionCells = [];
    this.selectionPendingVector = [0, 0];
    this.selectionDragActive = false;
    this.selectionAdditiveGestureActive = false;
    this.selectionDragStartCenter = null;
    this.selectionDragBaseVector = [0, 0];
  }

  destroy(): void {
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
  }
}
