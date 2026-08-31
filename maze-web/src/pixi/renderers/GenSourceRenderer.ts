import { Container, Graphics } from "pixi.js";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { makeProjection } from "../tessellationProjection";
import { CROSS_WIDTH, drawCrossMarker } from "./crossMarker";

/** Generation-source cross color. Mirrored by the `gen_source` tool glyph (`toolGlyphs.ts`). */
export const GEN_SOURCE_COLOR = 0x3399ff;

/** A plain cross at the source cell's center — same shape as `OriginRenderer`, just a different
 *  color. Grid-unit sizes, so it zooms with the field. Mirrored by the `gen_source` tool glyph. */
export class GenSourceRenderer {
  private readonly g: Graphics;

  constructor(container: Container) {
    this.g = new Graphics();
    container.addChild(this.g);
  }

  render(data: { source: [number, number] | null }, cfg: TessellationConfig): void {
    this.g.clear();
    if (!data.source) return;

    const proj = makeProjection(cfg);
    const { x: cx, y: cy } = proj.gridToScreen(data.source[0], data.source[1]);
    this.g.setStrokeStyle({ width: CROSS_WIDTH, color: GEN_SOURCE_COLOR, cap: "round" });
    drawCrossMarker(this.g, cx, cy);
  }

  destroy(): void {
    this.g.destroy();
  }
}
