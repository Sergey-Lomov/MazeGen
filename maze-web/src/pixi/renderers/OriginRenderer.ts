import { Container, Graphics } from "pixi.js";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { makeProjection } from "../tessellationProjection";
import { TILE_SIZE } from "../constants";
import { ORIGIN_COLOR, ORIGIN_ALPHA } from "../colorUtils";

export class OriginRenderer {
  private readonly g: Graphics;

  constructor(container: Container) {
    this.g = new Graphics();
    container.addChild(this.g);
  }

  render(data: { show: boolean; vpScale: number }, cfg: TessellationConfig): void {
    this.g.clear();
    if (!data.show) return;

    const proj = makeProjection(cfg);
    const { x: cx, y: cy } = proj.gridToScreen(0, 0);
    const arm = TILE_SIZE * 0.35 / data.vpScale;
    const w = Math.max(3 / data.vpScale, 2.5);

    this.g.setStrokeStyle({ width: w, color: ORIGIN_COLOR, alpha: ORIGIN_ALPHA, cap: "round" });
    this.g.moveTo(cx - arm, cy).lineTo(cx + arm, cy).stroke();
    this.g.moveTo(cx, cy - arm).lineTo(cx, cy + arm).stroke();
  }

  destroy(): void {
    this.g.destroy();
  }
}
