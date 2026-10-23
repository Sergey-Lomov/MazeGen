import { Container, Graphics } from "pixi.js";
import type { FieldConfig } from "../fieldConfig";
import type { PrintExportSettings } from "../store/storeTypes";
import { canvas, contrastGray } from "./colorTokens";
import { drawPaperLayoutDim, drawPaperLayoutFrame, drawPaperLayoutMargins } from "./imageExport/paperLayoutGraphics";
import { paperLayoutWorldGeometry } from "./paperLayoutGeometry";

export { paperLayoutWorldGeometry } from "./paperLayoutGeometry";
export type { PaperLayoutWorldGeometry } from "./paperLayoutGeometry";

/** Screen-independent paper/margin guide for the custom field editor. It deliberately lives in
 * world coordinates, behind the field cells, so normal pan/zoom and all tessellations keep the
 * guide aligned with the cells. */
export class PaperLayoutRenderer {
  private readonly graphics: Graphics;

  constructor(container: Container) {
    this.graphics = new Graphics();
    container.addChild(this.graphics);
  }

  render(show: boolean, config: Pick<FieldConfig, "tessellation">, settings: PrintExportSettings, viewport?: { x: number; y: number; w: number; h: number; scale: number }): void {
    this.graphics.clear();
    if (!show) return;
    const geometry = paperLayoutWorldGeometry(config, settings);
    if (!geometry) return;

    const { sheetWidth: w, sheetHeight: h, marginHorizontal: mh, marginVertical: mv } = geometry;
    const left = -w / 2;
    const top = -h / 2;
    const rect = { x: left, y: top, w, h };
    if (viewport && viewport.scale > 0) {
      drawPaperLayoutDim(this.graphics, rect, {
        x: -viewport.x / viewport.scale,
        y: -viewport.y / viewport.scale,
        w: viewport.w / viewport.scale,
        h: viewport.h / viewport.scale,
      });
    }
    const color = contrastGray(canvas.stage.background);
    drawPaperLayoutFrame(this.graphics, rect, color);
    drawPaperLayoutMargins(this.graphics, rect, mh, mv, color);
  }

  destroy(): void {
    this.graphics.destroy();
  }
}
