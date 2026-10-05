import { Container, Graphics } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import { decodePoint, encodePoint, makeProjection } from "./tessellationProjection";
import { TILE_SIZE, VIEWPORT_FIT_PADDING } from "./constants";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { configAllCells } from "./tessellationCells";
import { CellFillRenderer } from "./renderers/CellFillRenderer";
import { OriginRenderer } from "./renderers/OriginRenderer";
import { GridRenderer } from "./renderers/GridRenderer";
import { buildActiveCells } from "./selectors/fieldSelectors";
import { ACTIVE_CELL_ALPHA } from "./renderConstants";
import { canvas } from "./colorTokens";
import type { Viewport } from "./renderers/types";
import { PaperLayoutRenderer } from "./PaperLayoutRenderer";
import { BackgroundImageLayer } from "./BackgroundImageLayer";
import { computeSymmetryPreview, symmetryCandidateCells, type SymmetryAxisPoints, type SymmetryPoint } from "./symmetry";

const CELL_HOVER_COLOR = 0x888888;
const HOVER_ALPHA = 0.3;
const SYMMETRY_POLYGON_COLOR = 0xffffff;
const SYMMETRY_POLYGON_ALPHA = 0.9;
const SYMMETRY_POLYGON_WIDTH = 1.25;
const SYMMETRY_POLYGON_DASH_LENGTH = TILE_SIZE * 0.35;
const SYMMETRY_POLYGON_GAP_LENGTH = TILE_SIZE * 0.22;

export class FieldEditorOverlay {
  private readonly root: Container;
  private readonly gridContainer: Container;
  private readonly backgroundImageContainer: Container;
  private readonly paperLayoutContainer: Container;
  private readonly floorContainer: Container;
  private readonly symmetryContainer: Container;
  private readonly originContainer: Container;
  private readonly hoverContainer: Container;

  private readonly grid: GridRenderer;
  private readonly backgroundImage: BackgroundImageLayer;
  private readonly paperLayout: PaperLayoutRenderer;
  private readonly floor: CellFillRenderer;
  private readonly symmetryCells: CellFillRenderer;
  private readonly symmetryGraphics: Graphics;
  private readonly origin: OriginRenderer;
  private readonly hover: CellFillRenderer;

  private viewport: Viewport = { x: 0, y: 0, w: 0, h: 0, scale: 1 };
  private selectionMoveHidden = new Set<number>();
  private selectionMoveTemporary = new Set<number>();
  private unsubscribe: (() => void) | null = null;

  constructor(container: Container) {
    this.root = container;
    this.gridContainer = new Container();
    this.backgroundImageContainer = new Container();
    this.paperLayoutContainer = new Container();
    this.floorContainer = new Container();
    this.symmetryContainer = new Container();
    this.originContainer = new Container();
    this.hoverContainer = new Container();
    this.root.addChild(this.backgroundImageContainer);
    this.root.addChild(this.gridContainer);
    this.root.addChild(this.floorContainer);
    this.root.addChild(this.paperLayoutContainer);
    this.root.addChild(this.symmetryContainer);
    this.root.addChild(this.originContainer);
    this.root.addChild(this.hoverContainer);

    this.grid = new GridRenderer(this.gridContainer);
    this.backgroundImage = new BackgroundImageLayer(
      this.backgroundImageContainer,
      this.floorContainer,
      this.gridContainer,
      this.paperLayoutContainer,
    );
    this.paperLayout = new PaperLayoutRenderer(this.paperLayoutContainer);
    this.floor = new CellFillRenderer(this.floorContainer);
    this.symmetryCells = new CellFillRenderer(this.symmetryContainer);
    this.symmetryGraphics = new Graphics();
    this.symmetryContainer.addChild(this.symmetryGraphics);
    this.origin = new OriginRenderer(this.originContainer);
    this.hover = new CellFillRenderer(this.hoverContainer);

    this.root.visible = false;

    this.unsubscribe = useMazeStore.subscribe((state, prev) => {
      const field = state.floorFields[state.activeFloorId];
      const prevField = prev.floorFields[prev.activeFloorId];
      const isOpen = state.openCard === "field_setup";
      const wasOpen = prev.openCard === "field_setup";
      if (isOpen !== wasOpen) {
        this.root.visible = isOpen;
      }

      if (isOpen && !wasOpen) {
        this.redrawAll(state);
      }

      if (isOpen && field.fieldPoints !== prevField.fieldPoints) {
        this.redrawFloor(field.fieldPoints, field.fieldEditMode, field.tessellationConfig);
      }

      if (isOpen && field.tessellationConfig !== prevField.tessellationConfig) {
        this.redrawAll(state);
      }

      if (isOpen && field.fieldEditMode !== prevField.fieldEditMode) {
        this.redrawFloor(field.fieldPoints, field.fieldEditMode, field.tessellationConfig);
        this.redrawOrigin(field.fieldEditMode === "custom" && state.showFieldOrigin, field.tessellationConfig);
        this.redrawPaperLayout(state);
      }

      if (isOpen && field.fieldPrimitive !== prevField.fieldPrimitive) {
        this.updateHover(null, field.tessellationConfig);
        this.redrawSymmetry(state);
      }

      if (isOpen && (field.fieldPoints !== prevField.fieldPoints
        || field.fieldOperation !== prevField.fieldOperation
        || state.symmetrySnapMode !== prev.symmetrySnapMode
        || state.symmetryScope !== prev.symmetryScope
        || state.symmetryAxisPoints !== prev.symmetryAxisPoints
        || state.symmetrySourceSide !== prev.symmetrySourceSide
        || state.symmetryPolygon !== prev.symmetryPolygon
        || state.symmetryPolygonFinished !== prev.symmetryPolygonFinished)) {
        this.redrawSymmetry(state);
      }

      if (isOpen && state.showFieldOrigin !== prev.showFieldOrigin) {
        this.redrawOrigin(field.fieldEditMode === "custom" && state.showFieldOrigin, field.tessellationConfig);
      }

      if (isOpen && (state.showPaperLayout !== prev.showPaperLayout
        || state.pngExportSettings.print !== prev.pngExportSettings.print)) {
        this.redrawPaperLayout(state);
      }

      if (isOpen && (state.showBackgroundImage !== prev.showBackgroundImage
        || state.backgroundImage !== prev.backgroundImage
        || state.backgroundImageManualPositioning !== prev.backgroundImageManualPositioning
        || field.fieldEditMode !== prevField.fieldEditMode)) {
        this.backgroundImage.render(
          state.backgroundImage,
          this.shouldShowBackgroundImage(state),
          state.backgroundImageManualPositioning,
        );
      }
    });
  }

  updateHover(
    cellOrCells: [number, number] | [number, number][] | null,
    cfg: TessellationConfig,
    color = CELL_HOVER_COLOR,
    alpha = HOVER_ALPHA,
  ): void {
    const cells = !cellOrCells
      ? []
      : typeof cellOrCells[0] === "number"
        ? [cellOrCells as [number, number]]
        : cellOrCells as [number, number][];
    this.hover.render({ cells, color, alpha, inset: 0, borderWidth: 0 }, cfg);
  }

  onViewportChanged(x: number, y: number, w: number, h: number, scale: number): void {
    this.viewport = { x, y, w, h, scale };
    if (this.root.visible) {
      const state = useMazeStore.getState();
      const field = state.floorFields[state.activeFloorId];
      this.grid.render({ viewport: this.viewport }, field.tessellationConfig);
      this.redrawOrigin(field.fieldEditMode === "custom" && state.showFieldOrigin, field.tessellationConfig);
      this.redrawPaperLayout(state);
      this.redrawSymmetry(state);
    }
  }

  private redrawAll(state: ReturnType<typeof useMazeStore.getState>): void {
    const field = state.floorFields[state.activeFloorId];
    this.grid.render({ viewport: this.viewport }, field.tessellationConfig);
    this.redrawFloor(field.fieldPoints, field.fieldEditMode, field.tessellationConfig);
    this.backgroundImage.render(
      state.backgroundImage,
      this.shouldShowBackgroundImage(state),
      state.backgroundImageManualPositioning,
    );
    this.redrawOrigin(field.fieldEditMode === "custom" && state.showFieldOrigin, field.tessellationConfig);
    this.redrawPaperLayout(state);
    this.redrawSymmetry(state);
  }

  private redrawFloor(fieldPoints: Set<number>, fieldEditMode: "default" | "custom", cfg: TessellationConfig): void {
    const cells = buildActiveCells(fieldPoints, fieldEditMode, cfg)
      .filter(([x, y]) => !this.selectionMoveHidden.has(encodePoint(x, y)));
    const rendered = new Set(cells.map(([x, y]) => encodePoint(x, y)));
    for (const key of this.selectionMoveTemporary) {
      if (!rendered.has(key)) cells.push(decodePoint(key));
    }
    this.floor.render({ cells, color: canvas.fieldEditor.activeCell, alpha: ACTIVE_CELL_ALPHA }, cfg);
  }

  private shouldShowBackgroundImage(state: ReturnType<typeof useMazeStore.getState>): boolean {
    const field = state.floorFields[state.activeFloorId];
    return state.showBackgroundImage && field.fieldEditMode === "custom";
  }

  setSelectionMovePreview(sourceCells: [number, number][], temporaryCells: [number, number][]): void {
    const hidden = new Set(sourceCells.map(([x, y]) => encodePoint(x, y)));
    const temporary = new Set(temporaryCells.map(([x, y]) => encodePoint(x, y)));
    if (hidden.size === this.selectionMoveHidden.size
      && temporary.size === this.selectionMoveTemporary.size
      && [...hidden].every((key) => this.selectionMoveHidden.has(key))
      && [...temporary].every((key) => this.selectionMoveTemporary.has(key))) return;
    this.selectionMoveHidden = hidden;
    this.selectionMoveTemporary = temporary;
    const state = useMazeStore.getState();
    if (state.openCard === "field_setup") {
      const field = state.floorFields[state.activeFloorId];
      this.redrawFloor(field.fieldPoints, field.fieldEditMode, field.tessellationConfig);
    }
  }

  private redrawOrigin(show: boolean, cfg: TessellationConfig): void {
    this.origin.render({ show }, cfg);
  }

  private redrawPaperLayout(state: ReturnType<typeof useMazeStore.getState>): void {
    const field = state.floorFields[state.activeFloorId];
    this.paperLayout.render(
      state.showPaperLayout && field.fieldEditMode === "custom",
      field.tessellationConfig,
      state.pngExportSettings.print,
      this.viewport,
    );
  }

  updateSymmetryPreview(axisOverride?: SymmetryAxisPoints, polygonOverride?: SymmetryPoint[]): void {
    this.redrawSymmetry(useMazeStore.getState(), axisOverride, polygonOverride);
  }

  private redrawSymmetry(
    state: ReturnType<typeof useMazeStore.getState>,
    axisOverride?: SymmetryAxisPoints,
    polygonOverride?: SymmetryPoint[],
  ): void {
    const field = state.floorFields[state.activeFloorId];
    const visible = state.openCard === "field_setup"
      && field.fieldEditMode === "custom"
      && field.fieldPrimitive === "symmetry";
    this.symmetryContainer.visible = visible;
    this.symmetryGraphics.clear();
    if (!visible) {
      this.symmetryCells.render({ cells: [], color: 0, alpha: 0 }, field.tessellationConfig);
      return;
    }

    const axisPoints = axisOverride ?? state.symmetryAxisPoints;
    const polygon = polygonOverride ?? state.symmetryPolygon;
    const color = field.fieldOperation === "remove"
      ? canvas.fieldEditor.previewRemove
      : field.fieldOperation === "select" ? canvas.fieldEditor.previewSelect : canvas.fieldEditor.previewAdd;
    if (axisPoints.length === 2) {
      const axis: [SymmetryPoint, SymmetryPoint] = [axisPoints[0], axisPoints[1]];
      const preview = computeSymmetryPreview(
        field.fieldPoints,
        symmetryCandidateCells(field.fieldPoints, field.tessellationConfig, axisPoints, decodePoint),
        field.tessellationConfig,
        {
          scope: state.symmetryScope,
          sourceSide: state.symmetrySourceSide,
          axis,
          polygon,
        },
        encodePoint,
      );
      this.symmetryCells.render({ cells: preview.mirroredCells, color, alpha: 0.45 }, field.tessellationConfig);
      const dx = axis[1].x - axis[0].x;
      const dy = axis[1].y - axis[0].y;
      const length = Math.hypot(dx, dy);
      if (length > 0) {
        const ux = dx / length;
        const uy = dy / length;
        const mx = (axis[0].x + axis[1].x) / 2;
        const my = (axis[0].y + axis[1].y) / 2;
        this.symmetryGraphics.moveTo(mx - ux * 100000, -my + uy * 100000);
        this.symmetryGraphics.lineTo(mx + ux * 100000, -my - uy * 100000);
        this.symmetryGraphics.stroke({ color, alpha: 0.9, width: 1.5 });
        this.symmetryGraphics.circle(axis[0].x, -axis[0].y, TILE_SIZE * 0.14);
        this.symmetryGraphics.circle(axis[1].x, -axis[1].y, TILE_SIZE * 0.14);
        this.symmetryGraphics.fill({ color, alpha: 0.95 });

        if (state.symmetryScope === "one_side") {
          const normalX = -uy * -state.symmetrySourceSide;
          const normalY = ux * -state.symmetrySourceSide;
          const from = { x: mx - normalX * TILE_SIZE * 0.7, y: my - normalY * TILE_SIZE * 0.7 };
          const to = { x: mx + normalX * TILE_SIZE * 0.7, y: my + normalY * TILE_SIZE * 0.7 };
          this.symmetryGraphics.moveTo(from.x, -from.y);
          this.symmetryGraphics.lineTo(to.x, -to.y);
          this.symmetryGraphics.stroke({ color, alpha: 0.95, width: 2 });
          const head = TILE_SIZE * 0.18;
          this.symmetryGraphics.moveTo(to.x - normalX * head + normalY * head, -to.y + normalY * head + normalX * head);
          this.symmetryGraphics.lineTo(to.x, -to.y);
          this.symmetryGraphics.lineTo(to.x - normalX * head - normalY * head, -to.y + normalY * head - normalX * head);
          this.symmetryGraphics.stroke({ color, alpha: 0.95, width: 2 });
        }
      }
    } else {
      this.symmetryCells.render({ cells: [], color, alpha: 0 }, field.tessellationConfig);
      if (axisPoints.length === 1) {
        this.symmetryGraphics.circle(axisPoints[0].x, -axisPoints[0].y, TILE_SIZE * 0.14);
        this.symmetryGraphics.fill({ color, alpha: 0.95 });
      }
    }
    if (state.symmetryScope === "polygon" && polygon.length > 0) {
      const hasCursorPoint = polygonOverride !== undefined
        && polygon.length > state.symmetryPolygon.length
        && !state.symmetryPolygonFinished;
      const confirmedVertexCount = state.symmetryPolygon.length;
      const solidPointCount = hasCursorPoint
        ? (confirmedVertexCount >= 2 ? polygon.length : 0)
        : (confirmedVertexCount >= 3 ? polygon.length : 0);
      if (solidPointCount >= 2) {
        for (let i = 1; i < solidPointCount; i++) {
          drawDashedSegment(
            this.symmetryGraphics,
            { x: polygon[i - 1].x, y: -polygon[i - 1].y },
            { x: polygon[i].x, y: -polygon[i].y },
            SYMMETRY_POLYGON_COLOR,
          );
        }
      }
      if (polygon.length >= 2) {
        const last = { x: polygon[polygon.length - 1].x, y: -polygon[polygon.length - 1].y };
        const first = { x: polygon[0].x, y: -polygon[0].y };
        if (state.symmetryPolygonFinished) {
          this.symmetryGraphics.moveTo(last.x, last.y);
          this.symmetryGraphics.lineTo(first.x, first.y);
          this.symmetryGraphics.stroke({ color: SYMMETRY_POLYGON_COLOR, alpha: SYMMETRY_POLYGON_ALPHA, width: SYMMETRY_POLYGON_WIDTH });
        } else {
          drawDashedSegment(this.symmetryGraphics, last, first, SYMMETRY_POLYGON_COLOR);
        }
      }
      for (const point of state.symmetryPolygon) {
        this.symmetryGraphics.circle(point.x, -point.y, TILE_SIZE * 0.12);
        this.symmetryGraphics.fill({ color: SYMMETRY_POLYGON_COLOR, alpha: SYMMETRY_POLYGON_ALPHA });
      }
    }
  }

  destroy(): void {
    this.unsubscribe?.();
    this.grid.destroy();
    this.backgroundImage.destroy();
    this.paperLayout.destroy();
    this.floor.destroy();
    this.symmetryCells.destroy();
    this.symmetryGraphics.destroy();
    this.origin.destroy();
    this.hover.destroy();
    this.gridContainer.destroy();
    this.backgroundImageContainer.destroy();
    this.paperLayoutContainer.destroy();
    this.floorContainer.destroy();
    this.symmetryContainer.destroy();
    this.originContainer.destroy();
    this.hoverContainer.destroy();
  }
}

function drawDashedSegment(
  graphics: Graphics,
  start: { x: number; y: number },
  end: { x: number; y: number },
  color: number,
): void {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return;
  const ux = dx / length;
  const uy = dy / length;
  const step = SYMMETRY_POLYGON_DASH_LENGTH + SYMMETRY_POLYGON_GAP_LENGTH;
  for (let travelled = 0; travelled < length; travelled += step) {
    const dashEnd = Math.min(travelled + SYMMETRY_POLYGON_DASH_LENGTH, length);
    graphics.moveTo(start.x + ux * travelled, start.y + uy * travelled);
    graphics.lineTo(start.x + ux * dashEnd, start.y + uy * dashEnd);
    graphics.stroke({ color, alpha: SYMMETRY_POLYGON_ALPHA, width: SYMMETRY_POLYGON_WIDTH });
  }
}

export function configScreenCenter(cfg: TessellationConfig): { x: number; y: number } {
  const cells = configAllCells(cfg);
  if (cells.length === 0) return { x: 0, y: 0 };
  const proj = makeProjection(cfg);
  let sx = 0, sy = 0;
  for (const [col, row] of cells) {
    const { x, y } = proj.gridToScreen(col, row);
    sx += x; sy += y;
  }
  return { x: sx / cells.length, y: sy / cells.length };
}

function fieldBounds(cfg: TessellationConfig): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const cells = configAllCells(cfg);
  if (cells.length === 0) return null;
  const proj = makeProjection(cfg);
  const centers = cells.map(([col, row]) => proj.gridToScreen(col, row));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of centers) {
    if (c.x < minX) minX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.x > maxX) maxX = c.x;
    if (c.y > maxY) maxY = c.y;
  }
  return { minX: minX - TILE_SIZE, minY: minY - TILE_SIZE, maxX: maxX + TILE_SIZE, maxY: maxY + TILE_SIZE };
}

/** Computes the viewport transform that fits `activeCfg`'s field onto the screen (GitHub issue
 * #373). Unifies the auto-fit rule across every field-showing feature: the target scale is driven
 * by the *largest* floor's own bounding box (max width, max height independently — possibly from
 * two different floors), not by the active floor's own size, so switching floors or features never
 * changes the zoom level, only what's centered. `allCfgs` must carry every floor's own
 * `TessellationConfig` (including `activeCfg` itself). The viewport is centered on `activeCfg`'s
 * own bbox center. */
export function fitFieldViewport(
  activeCfg: TessellationConfig,
  allCfgs: TessellationConfig[],
  screenW: number,
  screenH: number,
): { x: number; y: number; scale: number } {
  const activeBounds = fieldBounds(activeCfg);
  if (!activeBounds) return { x: screenW / 2, y: screenH / 2, scale: 1 };

  let maxW = 0, maxH = 0;
  for (const cfg of allCfgs) {
    const bounds = fieldBounds(cfg);
    if (!bounds) continue;
    maxW = Math.max(maxW, bounds.maxX - bounds.minX);
    maxH = Math.max(maxH, bounds.maxY - bounds.minY);
  }
  if (maxW <= 0 || maxH <= 0) return { x: screenW / 2, y: screenH / 2, scale: 1 };

  const scale = Math.min(VIEWPORT_FIT_PADDING * screenW / maxW, VIEWPORT_FIT_PADDING * screenH / maxH);
  const cx = (activeBounds.minX + activeBounds.maxX) / 2;
  const cy = (activeBounds.minY + activeBounds.maxY) / 2;
  return { x: screenW / 2 - scale * cx, y: screenH / 2 - scale * cy, scale };
}
