import { Container, Graphics } from "pixi.js";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { makeProjection } from "../tessellationProjection";
import { TILE_SIZE } from "../constants";

const GEN_SOURCE_COLOR = 0x3399ff;
const GEN_SOURCE_ALPHA = 0.95;

export class GenSourceRenderer {
  private readonly g: Graphics;

  constructor(container: Container) {
    this.g = new Graphics();
    container.addChild(this.g);
  }

  render(data: { source: [number, number] | null; vpScale: number }, cfg: TessellationConfig): void {
    this.g.clear();
    if (!data.source) return;

    const proj = makeProjection(cfg);
    const { x: cx, y: cy } = proj.gridToScreen(data.source[0], data.source[1]);
    const arm = TILE_SIZE * 0.35 / data.vpScale;
    const w = Math.max(3 / data.vpScale, 2);

    this.g.setStrokeStyle({ width: w, color: GEN_SOURCE_COLOR, alpha: GEN_SOURCE_ALPHA, cap: "round" });
    this.g.moveTo(cx - arm, cy).lineTo(cx + arm, cy).stroke();
    this.g.moveTo(cx, cy - arm).lineTo(cx, cy + arm).stroke();
  }

  destroy(): void {
    this.g.destroy();
  }
}
