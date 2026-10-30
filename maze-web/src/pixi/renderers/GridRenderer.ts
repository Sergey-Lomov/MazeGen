import { Container, Graphics } from "pixi.js";
import type { Viewport } from "./types";
import type { FieldConfig } from "../../fieldConfig";
import { makeProjection } from "../tessellationProjection";
import { cellsNearDisplayRect, getCellOutlinePath } from "../tessellationGeometry";
import { prefetchCellOutlines } from "../cartesianCache";
import { tracePath } from "../geometry/pathRenderer";
import { TILE_SIZE } from "../constants";
import { GRID_LINE_ALPHA } from "../renderConstants";
import { canvas } from "../colorTokens";

/** Above this count the grid is visually too dense to be useful and too expensive to rebuild. */
export const MAX_VIEWPORT_GRID_CELLS = 50_000;
/// Cells drawn beyond the viewport edge on each side; a cell is at most two tiles across.
const VIEWPORT_CELL_PAD = 6;

export interface GridBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export function viewportGridCellCount(bounds: GridBounds): number {
  const width = Math.max(0, bounds.maxX - bounds.minX + 1);
  const height = Math.max(0, bounds.maxY - bounds.minY + 1);
  return width * height;
}

export function shouldRenderViewportGrid(bounds: GridBounds): boolean {
  return viewportGridCellCount(bounds) <= MAX_VIEWPORT_GRID_CELLS;
}

/// Extra margin drawn around the viewport, as a fraction of its size. A pan then reuses the
/// geometry until the viewport leaves the drawn area, instead of rebuilding on every cell crossed.
const VIEWPORT_DRAW_MARGIN = 0.2;

interface WorldRect {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

interface GridRenderState {
  cfg: FieldConfig;
  color: number;
  scale: number;
  cells: readonly [number, number][] | undefined;
  /// World rect the current geometry covers; null for explicit cells or a suppressed grid.
  drawn: WorldRect | null;
  suppressed: boolean;
}

function rectContains(outer: WorldRect, inner: WorldRect): boolean {
  return outer.minX <= inner.minX && outer.maxX >= inner.maxX
    && outer.minY <= inner.minY && outer.maxY >= inner.maxY;
}

export class GridRenderer {
  private readonly g: Graphics;
  private lastRender: GridRenderState | null = null;

  constructor(container: Container) {
    this.g = new Graphics();
    container.addChild(this.g);
  }

  render(
    data: { viewport: Viewport; color?: number },
    cfg: FieldConfig,
    cells?: readonly [number, number][],
  ): void {
    const { x, y, w, h, scale } = data.viewport;
    const color = data.color ?? canvas.grid.line;
    const view: WorldRect = {
      minX: -x / scale,
      maxX: (-x + w) / scale,
      minY: -y / scale,
      maxY: (-y + h) / scale,
    };
    const previous = this.lastRender;
    if (previous
      && previous.cfg === cfg
      && previous.color === color
      && previous.scale === scale
      && previous.cells === cells
      && (cells ? !previous.suppressed : previous.drawn !== null && rectContains(previous.drawn, view))) {
      return;
    }

    const bounds = cells
      ? null
      : makeProjection(cfg).gridBounds(x, y, w, h, scale);
    const suppressed = bounds !== null && !shouldRenderViewportGrid(bounds);

    // Clearing an already-suppressed grid on every pointermove still needlessly touches Pixi's
    // graphics object. The first transition to the suppressed state is enough.
    if (suppressed) {
      if (!previous?.suppressed) this.g.clear();
      this.lastRender = { cfg, color, scale, cells, drawn: null, suppressed };
      return;
    }

    const padX = Math.max(VIEWPORT_CELL_PAD * TILE_SIZE, VIEWPORT_DRAW_MARGIN * (view.maxX - view.minX));
    const padY = Math.max(VIEWPORT_CELL_PAD * TILE_SIZE, VIEWPORT_DRAW_MARGIN * (view.maxY - view.minY));
    const drawn: WorldRect | null = cells ? null : {
      minX: view.minX - padX,
      maxX: view.maxX + padX,
      minY: view.minY - padY,
      maxY: view.maxY + padY,
    };

    this.g.clear();

    this.g.setStrokeStyle({ width: 1 / scale, color, alpha: GRID_LINE_ALPHA });

    const drawCell = (xi: number, yi: number): void => {
      tracePath(this.g, getCellOutlinePath(xi, yi, cfg));
    };

    if (cells) {
      // Export renderers can supply the actual maze cells so the optional grid does not bleed
      // into the viewport/export margin around an irregular field.
      for (const [xi, yi] of cells) drawCell(xi, yi);
    } else if (drawn) {
      // Not every lattice coordinate is a cell (Cairo skips some), so ask core which cells the
      // drawn area touches instead of walking the coordinate box.
      const visible = cellsNearDisplayRect(drawn, cfg);
      prefetchCellOutlines(visible, cfg);
      for (const [xi, yi] of visible) drawCell(xi, yi);
    }
    this.g.stroke();
    this.lastRender = { cfg, color, scale, cells, drawn, suppressed };
  }

  destroy(): void {
    this.g.destroy();
  }
}
