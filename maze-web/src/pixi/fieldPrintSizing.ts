import type { FieldConfig, PresetFieldShape } from "../fieldConfig";
import type { PrintFieldSizingInput } from "../store/imageExportTypes";
import { PAPER_SIZES_MM } from "./imageExport/paperSizes";
import { printMeasureToCellSideMm } from "./imageExport/printFit";
import { presetShapeExtents } from "./tessellationCells";
import { displayTransform } from "./tessellationGeometry";
import { printRectSizingOf, TESSELLATION_UI } from "./geometry/tessellationUi";

const MAX_RECT_DIMENSION = 1000;
/** Largest smallest-block dimension of any lattice; a block this large is always accepted. */
const MIN_PROBE_DIMENSION = 4;
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

interface SizingContext {
  current: PredefinedFieldConfig;
  usableWidthMm: number;
  usableHeightMm: number;
  cellSizeMm: number;
}

/** A shape-family-specific candidate search. Shared code owns validation, physical units,
 * result formatting, and the final polygon-bound measurement. */
interface PrintFieldSizingStrategy {
  matches(current: PredefinedFieldConfig): boolean;
  calculate(context: SizingContext): FieldConfig | null;
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
  // Floors of one shape kind ask the same question, and the dialog re-asks it on every render.
  // The answer does not depend on the current size, only on the shape kind.
  const key = JSON.stringify([{ ...current, shape: current.shape.shape }, input]);
  if (!sizingCache.has(key)) {
    if (sizingCache.size >= SIZING_CACHE_LIMIT) sizingCache.delete(sizingCache.keys().next().value!);
    sizingCache.set(key, computePrintFieldConfig(current, input));
  }
  // Callers keep the config in their state, so the cache never hands out its own object.
  const cached = sizingCache.get(key)!;
  return cached && { ...cached, config: structuredClone(cached.config) };
}

const SIZING_CACHE_LIMIT = 32;
const sizingCache = new Map<string, PrintFieldSizingResult | null>();

function computePrintFieldConfig(
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
  const config = sizingStrategyFor(current).calculate({
    current,
    usableWidthMm,
    usableHeightMm,
    cellSizeMm: cellSideMm,
  });
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

const AXIS_ALIGNED_STRATEGY: PrintFieldSizingStrategy = {
  matches: (current) => current.shape.shape === "rect" && TESSELLATION_UI[current.tessellation.kind].editor.axisAlignedGrid,
  calculate: ({ current, usableWidthMm, usableHeightMm, cellSizeMm }) => {
    const shape = current.shape as RectShape;
    const cols = Math.floor(usableWidthMm / cellSizeMm);
    const rows = Math.floor(usableHeightMm / cellSizeMm);
    return cols >= 1 && rows >= 1 ? { ...current, shape: { ...shape, cols, rows } } : null;
  },
};

const CAIRO_RECT_STRATEGY: PrintFieldSizingStrategy = {
  matches: (current) => printRectSizingOf(current.tessellation.kind) === "cairo" && current.shape.shape === "rect",
  calculate: ({ current, usableWidthMm, usableHeightMm, cellSizeMm }) => {
    const shape = current.shape as RectShape;
    // `field_preset_extents` measures Cairo's real pentagon bounds without materializing its
    // complete block rectangle. Keeping this separate prevents a future generic strategy from
    // accidentally turning Cairo's sizing search back into repeated full-field enumeration.
    return calculateBestRectConfig(current, shape, usableWidthMm, usableHeightMm, cellSizeMm);
  },
};

const RECTANGULAR_STRATEGY: PrintFieldSizingStrategy = {
  matches: (current) => current.shape.shape === "rect" || current.shape.shape === "parallelogram",
  calculate: ({ current, usableWidthMm, usableHeightMm, cellSizeMm }) => {
    const shape = current.shape as RectShape;
    return calculateBestRectConfig(current, shape, usableWidthMm, usableHeightMm, cellSizeMm);
  },
};

const RADIAL_STRATEGY: PrintFieldSizingStrategy = {
  matches: () => true,
  calculate: ({ current, usableWidthMm, usableHeightMm, cellSizeMm }) =>
    calculateBestRadialConfig(current, current.shape as RadialShape, usableWidthMm, usableHeightMm, cellSizeMm),
};

const PRINT_FIELD_SIZING_STRATEGIES: readonly PrintFieldSizingStrategy[] = [
  AXIS_ALIGNED_STRATEGY,
  CAIRO_RECT_STRATEGY,
  RECTANGULAR_STRATEGY,
  RADIAL_STRATEGY,
];

function sizingStrategyFor(current: PredefinedFieldConfig): PrintFieldSizingStrategy {
  return PRINT_FIELD_SIZING_STRATEGIES.find((strategy) => strategy.matches(current))!;
}

function calculateBestRectConfig(
  current: FieldConfig,
  shape: RectShape,
  usableWidthMm: number,
  usableHeightMm: number,
  cellSizeMm: number,
): FieldConfig | null {
  const withSize = (cols: number, rows: number): FieldConfig => ({ ...current, shape: { ...shape, cols, rows } });
  // Every measurement is a core call, so each size is measured at most once.
  const measured = new Map<number, Bounds>();
  const boundsAt = (cols: number, rows: number): Bounds => {
    const key = cols * (MAX_RECT_DIMENSION + 1) + rows;
    let bounds = measured.get(key);
    if (!bounds) {
      bounds = boundsInCellSides(withSize(cols, rows));
      measured.set(key, bounds);
    }
    return bounds;
  };
  const fitsAt = (cols: number, rows: number): boolean => fits(boundsAt(cols, rows), usableWidthMm, usableHeightMm, cellSizeMm);

  // Core refuses blocks below a lattice's minimum (3.12.12 needs two rows), and such a block
  // measures as infinite, so the search starts from the smallest block core accepts.
  const minRows = firstAccepted((rows) => boundsAt(MIN_PROBE_DIMENSION, rows));
  const minCols = firstAccepted((cols) => boundsAt(cols, minRows));
  if (minRows === 0 || minCols === 0) return null;

  // The bounds are close to affine in each dimension, so two measurements estimate where the
  // limit lies and the search only has to confirm it with a few calls.
  const base = boundsAt(minCols, minRows);
  const colsHint = minCols + estimateLimit(base.width, boundsAt(minCols + 2, minRows).width, usableWidthMm / cellSizeMm);
  const rowsHint = minRows + estimateLimit(base.height, boundsAt(minCols, minRows + 2).height, usableHeightMm / cellSizeMm);
  const maxCols = largestFitting((cols) => fitsAt(cols, minRows), colsHint, minCols, MAX_RECT_DIMENSION);
  const maxRows = largestFitting((rows) => fitsAt(minCols, rows), rowsHint, minRows, MAX_RECT_DIMENSION);
  if (maxCols === 0 || maxRows === 0) return null;

  // Bounds only grow with either dimension, so the tallest fitting field never gets taller as
  // the columns grow. Walking the columns down from the widest, each column's answer is at least
  // the previous one, and no column below `bestCellCount / maxRows` can win -- the walk stops
  // after the few columns near the widest instead of measuring every column.
  let best: FieldConfig | null = null;
  let bestCellCount = 0;
  let bestFill = -Infinity;
  let rows = maxRows;
  for (let cols = maxCols; cols >= minCols && cols * maxRows >= bestCellCount; cols--) {
    rows = largestFitting((r) => fitsAt(cols, r), rows, minRows, maxRows);
    if (rows === 0) continue;

    const bounds = boundsAt(cols, rows);
    const cellCount = cols * rows;
    const fill = (bounds.width * cellSizeMm) / usableWidthMm + (bounds.height * cellSizeMm) / usableHeightMm;
    // On an exact tie the narrower field wins, as when the columns were walked up.
    if (cellCount > bestCellCount || (cellCount === bestCellCount && fill >= bestFill)) {
      best = withSize(cols, rows);
      bestCellCount = cellCount;
      bestFill = fill;
    }
  }

  return best;
}

/** How many dimensions past the smallest block a size growing about linearly reaches `limit`,
 * from its size there and two further (a staggered lattice repeats every 2). An estimate only:
 * `largestFitting` verifies it. */
function estimateLimit(sizeAtMin: number, sizeTwoFurther: number, limit: number): number {
  const slope = (sizeTwoFurther - sizeAtMin) / 2;
  const estimate = slope > 0 ? Math.floor((limit - sizeAtMin) / slope) : 0;
  return Number.isFinite(estimate) ? estimate : 0;
}

/** Smallest `value` in `1..=MIN_PROBE_DIMENSION` whose block core accepts (finite bounds), 0 when
 * none does. */
function firstAccepted(boundsOf: (value: number) => Bounds): number {
  for (let value = 1; value <= MIN_PROBE_DIMENSION; value++) {
    if (Number.isFinite(boundsOf(value).width)) return value;
  }
  return 0;
}

/** Largest `value` in `min..=max` with `fitsAt(value)`, 0 when even `min` does not fit. `fitsAt`
 * is monotone (true up to a limit); the search gallops from `hint` toward the limit and bisects
 * the bracket, so a good hint costs a handful of calls. */
export function largestFitting(fitsAt: (value: number) => boolean, hint: number, min: number, max: number): number {
  const start = Math.min(Math.max(Math.round(hint), min), max);
  let low: number; // fits, or min - 1
  let high: number; // does not fit, or max + 1
  if (fitsAt(start)) {
    low = start;
    high = max + 1;
    for (let step = 1; low + step <= max; step *= 2) {
      if (fitsAt(low + step)) low += step;
      else { high = low + step; break; }
    }
  } else {
    high = start;
    low = min - 1;
    for (let step = 1; high - step >= min; step *= 2) {
      if (fitsAt(high - step)) { low = high - step; break; }
      high -= step;
    }
  }
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (fitsAt(mid)) low = mid;
    else high = mid;
  }
  return low < min ? 0 : low;
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

function fits(bounds: Bounds, usableWidthMm: number, usableHeightMm: number, cellSizeMm: number): boolean {
  const epsilon = 1e-9;
  return bounds.width * cellSizeMm <= usableWidthMm + epsilon
    && bounds.height * cellSizeMm <= usableHeightMm + epsilon;
}

/** Display-space size of the field in cell sides: core measures the shape along the rows of the
 * display transform, so the field's orientation is only an instance of that transform. */
export function boundsInCellSides(config: FieldConfig): Bounds {
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
