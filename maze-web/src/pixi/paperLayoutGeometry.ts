import type { FieldConfig } from "../fieldConfig";
import type { PrintExportSettings } from "../store/storeTypes";
import { cellMeasureWorldUnits, printCellMeasureMm, resolveSheetSizeMm, DPI_BY_DENSITY, mmToPx } from "./imageExport/printFit";
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
  config: Pick<FieldConfig, "tessellation">,
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
    || !Number.isFinite(settings.marginHMm) || !Number.isFinite(settings.marginVMm)
    || settings.marginHMm < 0 || settings.marginVMm < 0) return null;

  return {
    sheetWidth: mmToPx(widthMm, dpi) / cellScale,
    sheetHeight: mmToPx(heightMm, dpi) / cellScale,
    marginHorizontal: mmToPx(settings.marginHMm, dpi) / cellScale,
    marginVertical: mmToPx(settings.marginVMm, dpi) / cellScale,
    cellSizeMm,
  };
}
