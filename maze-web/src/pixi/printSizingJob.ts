import {
  calculatePrintFieldConfig, isPredefinedFieldConfig, resolvePrintPaperSizeMm,
  type PredefinedFieldConfig, type PrintFieldSizingInput, type PrintFieldSizingResult,
} from "./fieldPrintSizing";
import { cellSourceOf, measurePrintCells, type CellSource, type PrintCellMeasure } from "./printCellSizes";

/** One floor of the print sizing dialog: a standard shape is sized again, a custom field only has
 * its cells measured. */
export interface PrintSizingFloor {
  id: string;
  /** Present for a floor with a standard shape. */
  config?: PredefinedFieldConfig;
  /** The cells of a floor without a standard shape. */
  cells?: [number, number][];
}

/** Everything the print sizing dialog needs from core, so one worker request computes it all
 * (GitHub issue #949). */
export interface PrintSizingRequest {
  config: PredefinedFieldConfig;
  input: PrintFieldSizingInput;
  floors: PrintSizingFloor[];
}

export interface PrintSizingFloorAnswer {
  id: string;
  /** The size found for a standard floor; `null` for a custom field or when nothing fits. */
  result: PrintFieldSizingResult | null;
  /** The floor has a standard shape that is calculated (and may fail to fit). */
  standard: boolean;
  cellCount: number;
}

export interface PrintSizingAnswer {
  result: PrintFieldSizingResult | null;
  floors: PrintSizingFloorAnswer[];
  measure: PrintCellMeasure;
}

/** Runs the whole calculation synchronously. It is the body of the print sizing worker; the dialog
 * never calls it on the main thread. */
export function computePrintSizing({ config, input, floors }: PrintSizingRequest): PrintSizingAnswer {
  const result = calculatePrintFieldConfig(config, input);
  const sources: CellSource[] = [];
  const answers = floors.map((floor): PrintSizingFloorAnswer & { sourceIndex: number } => {
    const sourceIndex = sources.length;
    if (!floor.config) {
      sources.push({ cells: floor.cells ?? [] });
      return { id: floor.id, result: null, standard: false, cellCount: 0, sourceIndex };
    }
    const floorResult = calculatePrintFieldConfig(floor.config, input);
    if (!floorResult || !isPredefinedFieldConfig(floorResult.config)) {
      return { id: floor.id, result: null, standard: true, cellCount: 0, sourceIndex: -1 };
    }
    sources.push(cellSourceOf(floorResult.config));
    return { id: floor.id, result: floorResult, standard: true, cellCount: 0, sourceIndex };
  });
  const measure = measurePrintCells(config, sources, input.cellSizeMm);
  return {
    result,
    floors: answers.map(({ sourceIndex, ...floor }) => ({
      ...floor,
      cellCount: sourceIndex < 0 ? 0 : measure.sourceCounts[sourceIndex] ?? 0,
    })),
    measure,
  };
}

/** Why no size was found. */
export type PrintSizingFailure = "invalid_input" | "margins" | "cell_too_large";

/** Explains a `null` result from the input alone. */
export function printSizingFailure(input: PrintFieldSizingInput): PrintSizingFailure {
  const validPaper = input.paperSize !== "custom"
    || (Number.isFinite(input.customWidthMm) && Number.isFinite(input.customHeightMm) && input.customWidthMm > 0 && input.customHeightMm > 0);
  const validMargins = Number.isFinite(input.marginHMm) && Number.isFinite(input.marginVMm) && input.marginHMm >= 0 && input.marginVMm >= 0;
  if (!Number.isFinite(input.cellSizeMm) || input.cellSizeMm <= 0 || !validPaper || !validMargins) return "invalid_input";
  const paper = resolvePrintPaperSizeMm(input);
  if (paper.widthMm - input.marginHMm * 2 <= 0 || paper.heightMm - input.marginVMm * 2 <= 0) return "margins";
  return "cell_too_large";
}
