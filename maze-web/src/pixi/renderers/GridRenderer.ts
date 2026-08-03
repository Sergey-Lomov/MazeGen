import { Container, Graphics } from "pixi.js";
import type { Viewport } from "./types";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { makeProjection } from "../tessellationProjection";
import { getCellVertices } from "../tessellationGeometry";
import { GRID_LINE_ALPHA } from "../renderConstants";
import { canvas } from "../colorTokens";

export class GridRenderer {
  private readonly g: Graphics;

  constructor(container: Container) {
    this.g = new Graphics();
    container.addChild(this.g);
  }

  render(data: { viewport: Viewport; color?: number }, cfg: TessellationConfig): void {
    this.g.clear();
    const { x, y, w, h, scale } = data.viewport;
    const proj = makeProjection(cfg);
    const bounds = proj.gridBounds(x, y, w, h, scale);

    this.g.setStrokeStyle({ width: 1 / scale, color: data.color ?? canvas.grid.line, alpha: GRID_LINE_ALPHA });

    for (let xi = bounds.minX; xi <= bounds.maxX; xi++) {
      for (let yi = bounds.minY; yi <= bounds.maxY; yi++) {
        const verts = getCellVertices(xi, yi, cfg);
        if (!verts) continue;
        this.g.moveTo(verts[verts.length - 1].x, verts[verts.length - 1].y);
        for (const v of verts) this.g.lineTo(v.x, v.y);
      }
    }
    this.g.stroke();
  }

  destroy(): void {
    this.g.destroy();
  }
}
