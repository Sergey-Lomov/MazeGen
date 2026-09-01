import { Container, Graphics } from "pixi.js";
import { CROSS_WIDTH, drawCrossMarker } from "./crossMarker";

/** Generation-source cross color. Mirrored by the `gen_source` tool glyph (`toolGlyphs.ts`). */
export const GEN_SOURCE_COLOR = 0x3399ff;

/** A plain cross at the source node's anchor — same shape as `OriginRenderer`, just a different
 *  color. Grid-unit sizes, so it zooms with the field. Mirrored by the `gen_source` tool glyph.
 *  Takes an already-resolved screen position (via `presetEndpointScreenPos`) so a source placed on
 *  a specific node of a split point draws at that node's shape-aware anchor, not the tile center
 *  (GitHub issue #494). */
export class GenSourceRenderer {
  private readonly g: Graphics;

  constructor(container: Container) {
    this.g = new Graphics();
    container.addChild(this.g);
  }

  render(data: { sourceScreen: { x: number; y: number } | null }): void {
    this.g.clear();
    if (!data.sourceScreen) return;

    this.g.setStrokeStyle({ width: CROSS_WIDTH, color: GEN_SOURCE_COLOR, cap: "round" });
    drawCrossMarker(this.g, data.sourceScreen.x, data.sourceScreen.y);
  }

  destroy(): void {
    this.g.destroy();
  }
}
