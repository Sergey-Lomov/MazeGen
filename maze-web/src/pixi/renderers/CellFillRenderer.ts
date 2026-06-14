import { Container, Graphics } from "pixi.js";
import { getCellVertices } from "../tessellationGeometry";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";

export type CellFillGroup = { cells: [number, number][]; color: number; alpha: number };

export class CellFillRenderer {
  private readonly g: Graphics;

  constructor(container: Container) {
    this.g = new Graphics();
    container.addChild(this.g);
  }

  render(data: CellFillGroup | CellFillGroup[], cfg?: TessellationConfig): void {
    this.g.clear();
    if (!cfg) return;
    const groups = Array.isArray(data) ? data : [data];
    for (const group of groups) {
      for (const [x, y] of group.cells) {
        const verts = getCellVertices(x, y, cfg);
        if (!verts) continue;
        this.g.poly(verts.flatMap(v => [v.x, v.y])).fill({ color: group.color, alpha: group.alpha });
      }
    }
  }

  destroy(): void {
    this.g.destroy();
  }
}
