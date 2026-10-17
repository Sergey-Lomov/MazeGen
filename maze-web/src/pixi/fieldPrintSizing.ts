import type { FieldConfig, PresetFieldShape } from "../fieldConfig";
import type { PrintFieldSizingInput } from "../store/imageExportTypes";
import { PAPER_SIZES_MM } from "./imageExport/paperSizes";
import { printMeasureToCellSideMm } from "./imageExport/printFit";
import { presetShapeExtents } from "./tessellationCells";
import { displayTransform } from "./tessellationGeometry";
import { TESSELLATION_UI } from "./geometry/tessellationUi";

const MAX_RECT_DIMENSION = 1000;
const MAX_RADIUS = 500;

/** Initial physical cell measure used by print-layout previews before a manual size is confirmed. */
export const DEFAULT_PRINT_CELL_SIZE_MM = 10;

export type { PrintFieldSizingInput } from "../store/imageExportTypes";

export type PredefinedFieldConfig = FieldConfig & { shape: PresetFieldShape };

type RectShape = Extract<PresetFieldShape, { cols: number }>;
type RadialShape = Exclude<PresetFieldShape, RectShape>;

export interface PrintFieldSizingResult {
  config: FieldConfig;
  fieldWidthMm: number;
  fieldHeightMm: number;
  usableWidthMm: number;
  usableHeightMm: number;
}

interface Bounds {
  width: number;
  height: number;
}

export function resolvePrintPaperSizeMm(input: Pick<PrintFieldSizingInput, "paperSize" | "customWidthMm" | "customHeightMm" | "orientation">): { widthMm: number; heightMm: number } {
  const base = input.paperSize === "custom"
    ? { w: input.customWidthMm, h: input.customHeightMm }
    : PAPER_SIZES_MM[input.paperSize];
  return input.orientation === "landscape"
    ? { widthMm: base.h, heightMm: base.w }
    : { widthMm: base.w, heightMm: base.h };
}

export function isPredefinedFieldConfig(config: FieldConfig): config is PredefinedFieldConfig {
  return config.shape.shape !== "custom";
}

/** Calculates a predefined field shape that fits the requested printed cell size and paper area.
 * The returned config remains a normal logical `FieldConfig`; physical sizing is only used for
 * this one calculation and is not part of the generation/WASM protocol. */
export function calculatePrintFieldConfig(
  current: PredefinedFieldConfig,
  input: PrintFieldSizingInput,
): PrintFieldSizingResult | null {
  if (!Number.isFinite(input.cellSizeMm) || input.cellSizeMm <= 0) return null;
  if (!Number.isFinite(input.marginHMm) || !Number.isFinite(input.marginVMm) || input.marginHMm < 0 || input.marginVMm < 0) return null;
  if (input.paperSize === "custom" && (!Number.isFinite(input.customWidthMm) || !Number.isFinite(input.customHeightMm) || input.customWidthMm <= 0 || input.customHeightMm <= 0)) return null;

  const paper = resolvePrintPaperSizeMm(input);
  const usableWidthMm = paper.widthMm - input.marginHMm * 2;
  const usableHeightMm = paper.heightMm - input.marginVMm * 2;
  if (usableWidthMm <= 0 || usableHeightMm <= 0) return null;

  const cellSideMm = printMeasureToCellSideMm(current, input.cellSizeMm);
  const config = calculateConfig(current, usableWidthMm, usableHeightMm, cellSideMm);
  if (!config) return null;

  const bounds = boundsInCellSides(config);
  return {
    config,
    fieldWidthMm: bounds.width * cellSideMm,
    fieldHeightMm: bounds.height * cellSideMm,
    usableWidthMm,
    usableHeightMm,
  };
}

function calculateConfig(
  current: PredefinedFieldConfig,
  usableWidthMm: number,
  usableHeightMm: number,
  cellSizeMm: number,
): FieldConfig | null {
  const { shape } = current;
  if (shape.shape === "rect" && TESSELLATION_UI[current.tessellation.kind].editor.axisAlignedGrid) {
    const cols = Math.floor(usableWidthMm / cellSizeMm);
    const rows = Math.floor(usableHeightMm / cellSizeMm);
    return cols >= 1 && rows >= 1 ? { ...current, shape: { ...shape, cols, rows } } : null;
  }
  if (shape.shape === "rect" || shape.shape === "parallelogram") {
    return calculateBestRectConfig(current, shape, usableWidthMm, usableHeightMm, cellSizeMm);
  }
  return calculateBestRadialConfig(current, shape, usableWidthMm, usableHeightMm, cellSizeMm);
}

function calculateBestRectConfig(
  current: FieldConfig,
  shape: RectShape,
  usableWidthMm: number,
  usableHeightMm: number,
  cellSizeMm: number,
): FieldConfig | null {
  let best: FieldConfig | null = null;
  let bestCellCount = 0;
  let bestFill = -Infinity;
  const withSize = (cols: number, rows: number): FieldConfig => ({ ...current, shape: { ...shape, cols, rows } });
  const maxCols = maxFittingRectDimension(withSize, "cols", usableWidthMm, usableHeightMm, cellSizeMm);

  // Bounds only grow with either dimension, so the tallest fitting field never gets taller as
  // the columns grow: walking the rows down from the previous column's answer replaces a binary
  // search per column.
  let rows = maxFittingRectDimension(withSize, "rows", usableWidthMm, usableHeightMm, cellSizeMm);
  for (let cols = 1; cols <= maxCols; cols++) {
    while (rows > 0 && !fits(boundsInCellSides(withSize(cols, rows)), usableWidthMm, usableHeightMm, cellSizeMm)) rows--;
    if (rows === 0) continue;

    const candidate = withSize(cols, rows);
    const bounds = boundsInCellSides(candidate);
    // The geometric rectangle is evaluated by the shared selector.  During this search only the
    // ordering matters; materializing every hex cell for every binary-search candidate turns a
    // harmless sizing dialog into an O(n^3) operation.  The final selected config is materialized
    // once by the caller.
    const cellCount = cols * rows;
    const fill = (bounds.width * cellSizeMm) / usableWidthMm + (bounds.height * cellSizeMm) / usableHeightMm;
    if (cellCount > bestCellCount || (cellCount === bestCellCount && fill > bestFill)) {
      best = candidate;
      bestCellCount = cellCount;
      bestFill = fill;
    }
  }

  return best;
}

function calculateBestRadialConfig(
  current: FieldConfig,
  shape: RadialShape,
  usableWidthMm: number,
  usableHeightMm: number,
  cellSizeMm: number,
): FieldConfig | null {
  let best: FieldConfig | null = null;
  let low = 1;
  let probe = 1;

  // Bounds grow monotonically with radius. Exponential probing avoids walking every radius when
  // the requested cell is large; the binary search below avoids the O(radius^3) behavior that
  // occurred for tiny cells when every candidate regenerated all radial cells.
  while (probe <= MAX_RADIUS) {
    const candidate = radialCandidate(current, shape, probe);
    if (!fits(boundsInCellSides(candidate), usableWidthMm, usableHeightMm, cellSizeMm)) break;
    best = candidate;
    low = probe + 1;
    probe *= 2;
  }

  if (!best) return null;

  let high = Math.min(probe - 1, MAX_RADIUS);
  while (low <= high) {
    const radius = Math.floor((low + high) / 2);
    const candidate = radialCandidate(current, shape, radius);
    if (fits(boundsInCellSides(candidate), usableWidthMm, usableHeightMm, cellSizeMm)) {
      best = candidate;
      low = radius + 1;
    } else {
      high = radius - 1;
    }
  }
  return best;
}

function radialCandidate(current: FieldConfig, shape: RadialShape, radius: number): FieldConfig {
  return { ...current, shape: shape.shape === "triangle" ? { ...shape, side: radius } : { ...shape, radius } };
}

function maxFittingRectDimension(
  withSize: (cols: number, rows: number) => FieldConfig,
  dimension: "cols" | "rows",
  usableWidthMm: number,
  usableHeightMm: number,
  cellSizeMm: number,
): number {
  const candidate = (value: number): FieldConfig => dimension === "cols" ? withSize(value, 1) : withSize(1, value);
  if (!fits(boundsInCellSides(candidate(1)), usableWidthMm, usableHeightMm, cellSizeMm)) return 0;

  let best = 1;
  let probe = 2;
  while (probe <= MAX_RECT_DIMENSION && fits(boundsInCellSides(candidate(probe)), usableWidthMm, usableHeightMm, cellSizeMm)) {
    best = probe;
    probe *= 2;
  }

  let low = best + 1;
  let high = Math.min(probe - 1, MAX_RECT_DIMENSION);
  while (low <= high) {
    const value = Math.floor((low + high) / 2);
    if (fits(boundsInCellSides(candidate(value)), usableWidthMm, usableHeightMm, cellSizeMm)) {
      best = value;
      low = value + 1;
    } else {
      high = value - 1;
    }
  }
  return best;
}

function fits(bounds: Bounds, usableWidthMm: number, usableHeightMm: number, cellSizeMm: number): boolean {
  const epsilon = 1e-9;
  return bounds.width * cellSizeMm <= usableWidthMm + epsilon
    && bounds.height * cellSizeMm <= usableHeightMm + epsilon;
}

/** Display-space size of the field in cell sides: core measures the shape along the rows of the
 * display transform, so the field's orientation is only an instance of that transform. */
function boundsInCellSides(config: FieldConfig): Bounds {
  const t = displayTransform(config);
  const extents = presetShapeExtents(config, [[t.a, t.c], [t.b, t.d]]);
  // A shape core refuses (too large to build) never fits.
  if (!extents) return { width: Infinity, height: Infinity };
  const side = TESSELLATION_UI[config.tessellation.kind].cellSidePx;
  return {
    width: (extents[0][1] - extents[0][0]) / side,
    height: (extents[1][1] - extents[1][0]) / side,
  };
}
