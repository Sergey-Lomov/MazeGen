import { Container, Graphics } from "pixi.js";
import type { Viewport } from "./types";
import type { FieldConfig } from "../../fieldConfig";
import { makeProjection } from "../tessellationProjection";
import { getCellVertices } from "../tessellationGeometry";
import { GRID_LINE_ALPHA } from "../renderConstants";
import { canvas } from "../colorTokens";

/** Above this count the grid is visually too dense to be useful and too expensive to rebuild. */
export const MAX_VIEWPORT_GRID_CELLS = 50_000;

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

interface GridRenderState {
  cfg: FieldConfig;
  color: number;
  scale: number;
  cells: readonly [number, number][] | undefined;
  bounds: GridBounds | null;
  suppressed: boolean;
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
    const bounds = cells
      ? null
      : makeProjection(cfg).gridBounds(x, y, w, h, scale);
    const suppressed = bounds !== null && !shouldRenderViewportGrid(bounds);
    const nextRender: GridRenderState = { cfg, color, scale, cells, bounds, suppressed };

    if (this.sameRender(nextRender)) return;

    // Clearing an already-suppressed grid on every pointermove still needlessly touches Pixi's
    // graphics object. The first transition to the suppressed state is enough.
    if (suppressed) {
      if (!this.lastRender?.suppressed) this.g.clear();
      this.lastRender = nextRender;
      return;
    }

    this.g.clear();

    this.g.setStrokeStyle({ width: 1 / scale, color, alpha: GRID_LINE_ALPHA });

    const drawCell = (xi: number, yi: number): void => {
      const verts = getCellVertices(xi, yi, cfg);
      if (!verts) return;
      this.g.moveTo(verts[verts.length - 1].x, verts[verts.length - 1].y);
      for (const v of verts) this.g.lineTo(v.x, v.y);
    };

    if (cells) {
      // Export renderers can supply the actual maze cells so the optional grid does not bleed
      // into the viewport/export margin around an irregular field.
      for (const [xi, yi] of cells) drawCell(xi, yi);
    } else if (bounds) {
      for (let xi = bounds.minX; xi <= bounds.maxX; xi++) {
        for (let yi = bounds.minY; yi <= bounds.maxY; yi++) drawCell(xi, yi);
      }
    }
    this.g.stroke();
    this.lastRender = nextRender;
  }

  private sameRender(next: GridRenderState): boolean {
    const previous = this.lastRender;
    if (!previous
      || previous.cfg !== next.cfg
      || previous.color !== next.color
      || previous.scale !== next.scale
      || previous.cells !== next.cells
      || previous.suppressed !== next.suppressed) return false;
    if (previous.bounds === next.bounds) return true;
    if (!previous.bounds || !next.bounds) return false;
    return previous.bounds.minX === next.bounds.minX
      && previous.bounds.maxX === next.bounds.maxX
      && previous.bounds.minY === next.bounds.minY
      && previous.bounds.maxY === next.bounds.maxY;
  }

  destroy(): void {
    this.g.destroy();
  }
}
