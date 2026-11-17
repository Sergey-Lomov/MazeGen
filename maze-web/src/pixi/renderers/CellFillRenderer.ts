import { Container, Graphics } from "pixi.js";
import type { FieldConfig } from "../../fieldConfig";
import { tracePath } from "../geometry/pathRenderer";
import { getCellPath } from "../tessellationGeometry";
import { drawCellHighlightAt, type CellHighlightCornerStyle } from "../cellHighlightGeometry";

export type CellFillGroup = { cells: [number, number][]; color: number; alpha: number; inset?: number; cornerStyle?: CellHighlightCornerStyle; borderWidth?: number };

export class CellFillRenderer {
  private readonly g: Graphics;

  constructor(container: Container) {
    this.g = new Graphics();
    container.addChild(this.g);
  }

  render(data: CellFillGroup | CellFillGroup[], cfg?: FieldConfig): void {
    this.g.clear();
    if (!cfg) return;
    const groups = Array.isArray(data) ? data : [data];
    for (const group of groups) {
      // Plain fills (no inset, no border) collapse into one path and one fill instruction.
      if ((group.inset ?? 0) === 0 && !group.borderWidth) {
        for (const [x, y] of group.cells) {
          tracePath(this.g, getCellPath(x, y, cfg));
          this.g.closePath();
        }
        if (group.cells.length > 0) this.g.fill({ color: group.color, alpha: group.alpha });
        continue;
      }
      for (const [x, y] of group.cells) {
        drawCellHighlightAt(this.g, x, y, cfg, group.color, group.alpha, group.inset ?? 0, group.cornerStyle ?? "round", group.borderWidth);
      }
    }
  }

  destroy(): void {
    this.g.destroy();
  }
}
