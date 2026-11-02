import { Graphics } from "pixi.js";
import type { Container } from "pixi.js";
import type { Viewport } from "./types";
import type { FieldConfig } from "../../fieldConfig";
import { makeProjection } from "../tessellationProjection";
import { cellsNearDisplayRect, getCellOutlinePath } from "../tessellationGeometry";
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

/**
 * Curves retain sub-pixel accuracy at normal scale with eight chords per quarter arc, then
 * progressively become cheaper while zoomed out.
 */
export function viewportGridMaxChordAngle(scale: number): number {
  return Math.min(Math.PI / 4, Math.PI / (16 * Math.max(scale, 0.125)));
}

/// Extra margin drawn around the viewport, as a fraction of its size. A pan then reuses the
/// geometry until the viewport leaves the drawn area, instead of rebuilding on every cell crossed.
const VIEWPORT_DRAW_MARGIN = 0.2;
/** Wait for navigation to settle before rebuilding expensive viewport geometry. */
export const VIEWPORT_GRID_REBUILD_DELAY_MS = 120;

function isDevBuild(): boolean {
  return (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;
}

/** Emits Chrome User Timing entries only in development, so a Performance trace can separate core
 * geometry work from Pixi command construction without changing production interaction cost. */
function profileGrid<T>(owner: string, phase: string, work: () => T): T {
  if (!isDevBuild() || typeof performance === "undefined") return work();
  const start = performance.now();
  const value = work();
  const duration = performance.now() - start;
  performance.measure(`Maze grid (${owner}): ${phase}`, { start, duration });
  return value;
}

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
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRender: { data: { viewport: Viewport; color?: number }; cfg: FieldConfig } | null = null;

  constructor(container: Container, private readonly diagnosticOwner = "unknown") {
    this.g = new Graphics();
    container.addChild(this.g);
  }

  render(
    data: { viewport: Viewport; color?: number },
    cfg: FieldConfig,
    cells?: readonly [number, number][],
  ): void {
    if (this.canReuseViewportGeometry(data, cfg, cells)) return;
    if (cells === undefined && this.shouldDeferViewportRebuild(data, cfg)) {
      this.pendingRender = { data, cfg };
      if (this.rebuildTimer !== null) clearTimeout(this.rebuildTimer);
      this.rebuildTimer = setTimeout(() => {
        this.rebuildTimer = null;
        const pending = this.pendingRender;
        this.pendingRender = null;
        if (pending) profileGrid(this.diagnosticOwner, "rebuild", () => this.renderNow(pending.data, pending.cfg));
      }, VIEWPORT_GRID_REBUILD_DELAY_MS);
      return;
    }
    this.cancelPendingRebuild();
    profileGrid(this.diagnosticOwner, "rebuild", () => this.renderNow(data, cfg, cells));
  }

  private cancelPendingRebuild(): void {
    if (this.rebuildTimer !== null) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = null;
    this.pendingRender = null;
  }

  private canReuseViewportGeometry(
    data: { viewport: Viewport; color?: number },
    cfg: FieldConfig,
    cells: readonly [number, number][] | undefined,
  ): boolean {
    const { x, y, w, h, scale } = data.viewport;
    const color = data.color ?? canvas.grid.line;
    const view: WorldRect = {
      minX: -x / scale,
      maxX: (-x + w) / scale,
      minY: -y / scale,
      maxY: (-y + h) / scale,
    };
    const previous = this.lastRender;
    return !!(previous
      && previous.cfg === cfg
      && previous.color === color
      && previous.scale === scale
      && previous.cells === cells
      && (cells ? !previous.suppressed : previous.suppressed || (previous.drawn !== null && rectContains(previous.drawn, view))));
  }

  private shouldDeferViewportRebuild(data: { viewport: Viewport; color?: number }, cfg: FieldConfig): boolean {
    const previous = this.lastRender;
    // A changed field/configuration must appear immediately. During navigation the old grid already
    // follows the viewport transform, so its expensive path geometry can safely wait for the idle
    // edge of the gesture.
    return previous !== null
      && previous.cfg === cfg
      && previous.color === (data.color ?? canvas.grid.line)
      && previous.cells === undefined;
  }

  private renderNow(
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

    const bounds = profileGrid(this.diagnosticOwner, "viewport bounds", () => cells
      ? null
      : makeProjection(cfg).gridBounds(x, y, w, h, scale));
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
      tracePath(this.g, getCellOutlinePath(xi, yi, cfg), undefined, viewportGridMaxChordAngle(scale));
    };
    if (cells) {
      // Export renderers can supply the actual maze cells so the optional grid does not bleed
      // into the viewport/export margin around an irregular field.
      profileGrid(this.diagnosticOwner, "trace paths", () => {
        for (const [xi, yi] of cells) drawCell(xi, yi);
      });
    } else if (drawn) {
      // Not every lattice coordinate is a cell (Cairo skips some), so ask core which cells the
      // drawn area touches instead of walking the coordinate box. `cellsNearDisplayRect` also
      // fetches and caches their outlines through that same core call.
      const visible = profileGrid(this.diagnosticOwner, "core region and outlines", () => cellsNearDisplayRect(drawn, cfg));
      profileGrid(this.diagnosticOwner, "trace paths", () => {
        for (const [xi, yi] of visible) drawCell(xi, yi);
      });
    }
    profileGrid(this.diagnosticOwner, "Pixi stroke", () => this.g.stroke());
    this.lastRender = { cfg, color, scale, cells, drawn, suppressed };
  }

  destroy(): void {
    this.cancelPendingRebuild();
    this.g.destroy();
  }
}
