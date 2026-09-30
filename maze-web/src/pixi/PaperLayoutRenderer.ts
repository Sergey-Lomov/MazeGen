import { Container, Graphics } from "pixi.js";
import type { FieldConfig } from "../fieldConfig";
import type { PrintExportSettings } from "../store/storeTypes";
import { canvas, contrastGray } from "./colorTokens";
import { cellMeasureWorldUnits, printCellMeasureMm, resolveSheetSizeMm, DPI_BY_DENSITY, mmToPx } from "./imageExport/printFit";
import { drawPaperLayoutDim, drawPaperLayoutFrame, drawPaperLayoutMargins } from "./imageExport/paperLayoutGraphics";
import { DEFAULT_PRINT_CELL_SIZE_MM } from "./fieldPrintSizing";

export interface PaperLayoutWorldGeometry {
  sheetWidth: number;
  sheetHeight: number;
  marginHorizontal: number;
  marginVertical: number;
  cellSizeMm: number;
}

/** Converts the shared print settings into editor-world dimensions. The editor uses the same
 * print scale as PNG export, so a paper edge drawn here has exactly the same physical ratio as
 * the sheet used by the print exporter. */
export function paperLayoutWorldGeometry(
  config: Pick<FieldConfig, "type">,
  settings: PrintExportSettings,
): PaperLayoutWorldGeometry | null {
  const { widthMm, heightMm } = resolveSheetSizeMm(settings);
  const dpi = DPI_BY_DENSITY[settings.density];
  const cellSizeMm = settings.scaleAutoFit
    ? DEFAULT_PRINT_CELL_SIZE_MM
    : printCellMeasureMm(config, settings.scale, dpi);
  const measureWorld = cellMeasureWorldUnits(config);
  const cellScale = mmToPx(cellSizeMm, dpi) / measureWorld;
  if (![widthMm, heightMm, cellSizeMm, cellScale].every(Number.isFinite)
    || widthMm <= 0 || heightMm <= 0 || cellSizeMm <= 0 || cellScale <= 0
    || settings.marginHMm < 0 || settings.marginVMm < 0) return null;

  return {
    sheetWidth: mmToPx(widthMm, dpi) / cellScale,
    sheetHeight: mmToPx(heightMm, dpi) / cellScale,
    marginHorizontal: mmToPx(settings.marginHMm, dpi) / cellScale,
    marginVertical: mmToPx(settings.marginVMm, dpi) / cellScale,
    cellSizeMm,
  };
}

/** Screen-independent paper/margin guide for the custom field editor. It deliberately lives in
 * world coordinates, behind the field cells, so normal pan/zoom and all tessellations keep the
 * guide aligned with the cells. */
export class PaperLayoutRenderer {
  private readonly graphics: Graphics;

  constructor(container: Container) {
    this.graphics = new Graphics();
    container.addChild(this.graphics);
  }

  render(show: boolean, config: Pick<FieldConfig, "type">, settings: PrintExportSettings, viewport?: { x: number; y: number; w: number; h: number; scale: number }): void {
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
