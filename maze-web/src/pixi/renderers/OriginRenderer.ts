import { Container, Graphics } from "pixi.js";
import type { FieldConfig } from "../../fieldConfig";
import { makeProjection } from "../tessellationProjection";
import { originCellOf } from "../splitPatternTile";
import { canvas } from "../colorTokens";
import { CROSS_WIDTH, drawCrossMarker } from "./crossMarker";

export class OriginRenderer {
  private readonly g: Graphics;

  constructor(container: Container) {
    this.g = new Graphics();
    container.addChild(this.g);
  }

  render(data: { show: boolean }, cfg: FieldConfig): void {
    this.g.clear();
    if (!data.show) return;

    const proj = makeProjection(cfg);
    const { x: cx, y: cy } = proj.gridToScreen(...originCellOf(cfg));
    // Grid-unit sizes — the marker zooms with the field like any other drawn content. Fully opaque.
    // Same geometry as the generation-source cross (`GenSourceRenderer`), different color.
    this.g.setStrokeStyle({ width: CROSS_WIDTH, color: canvas.origin.default, cap: "round" });
    drawCrossMarker(this.g, cx, cy);
  }

  destroy(): void {
    this.g.destroy();
  }
}
