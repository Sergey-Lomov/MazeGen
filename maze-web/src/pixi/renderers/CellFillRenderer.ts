import { Container, Graphics } from "pixi.js";
import { getCellVertices } from "../tessellationGeometry";
import type { FieldConfig } from "../../fieldConfig";
import { drawCellHighlight, type CellHighlightCornerStyle } from "../cellHighlightGeometry";

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
      for (const [x, y] of group.cells) {
        const verts = getCellVertices(x, y, cfg);
        if (!verts) continue;
        drawCellHighlight(this.g, verts, group.color, group.alpha, group.inset ?? 0, group.cornerStyle ?? "round", group.borderWidth);
      }
    }
  }

  destroy(): void {
    this.g.destroy();
  }
}
