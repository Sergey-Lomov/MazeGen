import { Container } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import { makeProjection } from "./tessellationProjection";
import { TILE_SIZE } from "./constants";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { configAllCells } from "./tessellationCells";
import { CellFillRenderer } from "./renderers/CellFillRenderer";
import { OriginRenderer } from "./renderers/OriginRenderer";
import { GridRenderer } from "./renderers/GridRenderer";
import { buildActiveCells } from "./selectors/fieldSelectors";
import { ACTIVE_CELL_COLOR, ACTIVE_CELL_ALPHA } from "./colorUtils";
import type { Viewport } from "./renderers/types";

const HOVER_COLOR = 0x888888;
const HOVER_ALPHA = 0.3;

export class FieldEditorOverlay {
  private readonly root: Container;
  private readonly gridContainer: Container;
  private readonly floorContainer: Container;
  private readonly originContainer: Container;
  private readonly hoverContainer: Container;

  private readonly grid: GridRenderer;
  private readonly floor: CellFillRenderer;
  private readonly origin: OriginRenderer;
  private readonly hover: CellFillRenderer;

  private viewport: Viewport = { x: 0, y: 0, w: 0, h: 0, scale: 1 };
  private unsubscribe: (() => void) | null = null;

  constructor(container: Container) {
    this.root = container;
    this.gridContainer = new Container();
    this.floorContainer = new Container();
    this.originContainer = new Container();
    this.hoverContainer = new Container();
    this.root.addChild(this.gridContainer);
    this.root.addChild(this.floorContainer);
    this.root.addChild(this.originContainer);
    this.root.addChild(this.hoverContainer);

    this.grid = new GridRenderer(this.gridContainer);
    this.floor = new CellFillRenderer(this.floorContainer);
    this.origin = new OriginRenderer(this.originContainer);
    this.hover = new CellFillRenderer(this.hoverContainer);

    this.root.visible = false;

    this.unsubscribe = useMazeStore.subscribe((state, prev) => {
      if (state.fieldSetupOpen !== prev.fieldSetupOpen) {
        this.root.visible = state.fieldSetupOpen;
      }

      if (state.fieldSetupOpen && !prev.fieldSetupOpen) {
        this.redrawAll(state);
      }

      if (state.fieldSetupOpen && state.fieldPoints !== prev.fieldPoints) {
        this.redrawFloor(state.fieldPoints, state.fieldEditMode, state.tessellationConfig);
      }

      if (state.fieldSetupOpen && state.tessellationConfig !== prev.tessellationConfig) {
        this.redrawAll(state);
      }

      if (state.fieldSetupOpen && state.fieldEditMode !== prev.fieldEditMode) {
        this.redrawFloor(state.fieldPoints, state.fieldEditMode, state.tessellationConfig);
        this.redrawOrigin(state.fieldEditMode === "custom" && state.showFieldOrigin, state.tessellationConfig);
      }

      if (state.fieldSetupOpen && state.showFieldOrigin !== prev.showFieldOrigin) {
        this.redrawOrigin(state.fieldEditMode === "custom" && state.showFieldOrigin, state.tessellationConfig);
      }
    });
  }

  updateHover(cell: [number, number] | null, cfg: TessellationConfig): void {
    if (!cell) {
      this.hover.render({ cells: [], color: HOVER_COLOR, alpha: HOVER_ALPHA }, cfg);
    } else {
      this.hover.render({ cells: [cell], color: HOVER_COLOR, alpha: HOVER_ALPHA }, cfg);
    }
  }

  onViewportChanged(x: number, y: number, w: number, h: number, scale: number): void {
    this.viewport = { x, y, w, h, scale };
    if (this.root.visible) {
      const state = useMazeStore.getState();
      this.grid.render({ viewport: this.viewport }, state.tessellationConfig);
      this.redrawOrigin(state.fieldEditMode === "custom" && state.showFieldOrigin, state.tessellationConfig);
    }
  }

  private redrawAll(state: ReturnType<typeof useMazeStore.getState>): void {
    this.grid.render({ viewport: this.viewport }, state.tessellationConfig);
    this.redrawFloor(state.fieldPoints, state.fieldEditMode, state.tessellationConfig);
    this.redrawOrigin(state.fieldEditMode === "custom" && state.showFieldOrigin, state.tessellationConfig);
  }

  private redrawFloor(fieldPoints: Set<number>, fieldEditMode: "default" | "custom", cfg: TessellationConfig): void {
    const cells = buildActiveCells(fieldPoints, fieldEditMode, cfg);
    this.floor.render({ cells, color: ACTIVE_CELL_COLOR, alpha: ACTIVE_CELL_ALPHA }, cfg);
  }

  private redrawOrigin(show: boolean, cfg: TessellationConfig): void {
    this.origin.render({ show, vpScale: this.viewport.scale }, cfg);
  }

  destroy(): void {
    this.unsubscribe?.();
    this.grid.destroy();
    this.floor.destroy();
    this.origin.destroy();
    this.hover.destroy();
    this.gridContainer.destroy();
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

export function fitFieldViewport(
  cfg: TessellationConfig,
  screenW: number,
  screenH: number,
  padding = 0.85,
): { x: number; y: number; scale: number } {
  const cells = configAllCells(cfg);
  if (cells.length === 0) return { x: screenW / 2, y: screenH / 2, scale: 1 };
  const proj = makeProjection(cfg);
  const centers = cells.map(([col, row]) => proj.gridToScreen(col, row));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of centers) {
    if (c.x < minX) minX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.x > maxX) maxX = c.x;
    if (c.y > maxY) maxY = c.y;
  }
  minX -= TILE_SIZE; minY -= TILE_SIZE; maxX += TILE_SIZE; maxY += TILE_SIZE;
  const W = maxX - minX;
  const H = maxY - minY;
  if (W <= 0 || H <= 0) return { x: screenW / 2, y: screenH / 2, scale: 1 };
  const scale = Math.min(padding * screenW / W, padding * screenH / H);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return { x: screenW / 2 - scale * cx, y: screenH / 2 - scale * cy, scale };
}
