import { Container } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import { makeProjection } from "./tessellationProjection";
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

const CELL_HOVER_COLOR = 0x888888;
const HOVER_ALPHA = 0.3;

export class FieldEditorOverlay {
  private readonly root: Container;
  private readonly gridContainer: Container;
  private readonly paperLayoutContainer: Container;
  private readonly floorContainer: Container;
  private readonly originContainer: Container;
  private readonly hoverContainer: Container;

  private readonly grid: GridRenderer;
  private readonly paperLayout: PaperLayoutRenderer;
  private readonly floor: CellFillRenderer;
  private readonly origin: OriginRenderer;
  private readonly hover: CellFillRenderer;

  private viewport: Viewport = { x: 0, y: 0, w: 0, h: 0, scale: 1 };
  private unsubscribe: (() => void) | null = null;

  constructor(container: Container) {
    this.root = container;
    this.gridContainer = new Container();
    this.paperLayoutContainer = new Container();
    this.floorContainer = new Container();
    this.originContainer = new Container();
    this.hoverContainer = new Container();
    this.root.addChild(this.gridContainer);
    this.root.addChild(this.paperLayoutContainer);
    this.root.addChild(this.floorContainer);
    this.root.addChild(this.originContainer);
    this.root.addChild(this.hoverContainer);

    this.grid = new GridRenderer(this.gridContainer);
    this.paperLayout = new PaperLayoutRenderer(this.paperLayoutContainer);
    this.floor = new CellFillRenderer(this.floorContainer);
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
      }

      if (isOpen && state.showFieldOrigin !== prev.showFieldOrigin) {
        this.redrawOrigin(field.fieldEditMode === "custom" && state.showFieldOrigin, field.tessellationConfig);
      }

      if (isOpen && (state.showPaperLayout !== prev.showPaperLayout
        || state.pngExportSettings.print !== prev.pngExportSettings.print)) {
        this.redrawPaperLayout(state);
      }
    });
  }

  updateHover(cell: [number, number] | null, cfg: TessellationConfig): void {
    if (!cell) {
      this.hover.render({ cells: [], color: CELL_HOVER_COLOR, alpha: HOVER_ALPHA, inset: 0, borderWidth: 0 }, cfg);
    } else {
      this.hover.render({ cells: [cell], color: CELL_HOVER_COLOR, alpha: HOVER_ALPHA, inset: 0, borderWidth: 0 }, cfg);
    }
  }

  onViewportChanged(x: number, y: number, w: number, h: number, scale: number): void {
    this.viewport = { x, y, w, h, scale };
    if (this.root.visible) {
      const state = useMazeStore.getState();
      const field = state.floorFields[state.activeFloorId];
      this.grid.render({ viewport: this.viewport }, field.tessellationConfig);
      this.redrawOrigin(field.fieldEditMode === "custom" && state.showFieldOrigin, field.tessellationConfig);
      this.redrawPaperLayout(state);
    }
  }

  private redrawAll(state: ReturnType<typeof useMazeStore.getState>): void {
    const field = state.floorFields[state.activeFloorId];
    this.grid.render({ viewport: this.viewport }, field.tessellationConfig);
    this.redrawFloor(field.fieldPoints, field.fieldEditMode, field.tessellationConfig);
    this.redrawOrigin(field.fieldEditMode === "custom" && state.showFieldOrigin, field.tessellationConfig);
    this.redrawPaperLayout(state);
  }

  private redrawFloor(fieldPoints: Set<number>, fieldEditMode: "default" | "custom", cfg: TessellationConfig): void {
    const cells = buildActiveCells(fieldPoints, fieldEditMode, cfg);
    this.floor.render({ cells, color: canvas.fieldEditor.activeCell, alpha: ACTIVE_CELL_ALPHA }, cfg);
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

  destroy(): void {
    this.unsubscribe?.();
    this.grid.destroy();
    this.paperLayout.destroy();
    this.floor.destroy();
    this.origin.destroy();
    this.hover.destroy();
    this.gridContainer.destroy();
    this.paperLayoutContainer.destroy();
    this.floorContainer.destroy();
    this.originContainer.destroy();
    this.hoverContainer.destroy();
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
