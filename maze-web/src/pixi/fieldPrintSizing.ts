import { isSwitchedShape, type FieldConfig, type PresetFieldShape } from "../fieldConfig";
import type { PrintFieldSizingInput } from "../store/imageExportTypes";
import { getFieldPrintSizing } from "../wasm/mazeService";
import { PAPER_SIZES_MM } from "./imageExport/paperSizes";
import { printMeasureToCellSideMm } from "./imageExport/printFit";
import { compactNetOf } from "./fieldOps";
import { displayTransform } from "./tessellationGeometry";
import { TESSELLATION_UI } from "./geometry/tessellationUi";

/** Smallest physical cell measure the print sizing dialog accepts. */
export const MIN_PRINT_CELL_SIZE_MM = 3;

export type { PrintFieldSizingInput } from "../store/imageExportTypes";

export type PredefinedFieldConfig = FieldConfig & { shape: PresetFieldShape };

export interface PrintFieldSizingResult {
  config: FieldConfig;
  fieldWidthMm: number;
  fieldHeightMm: number;
  usableWidthMm: number;
  usableHeightMm: number;
  /** The search cap the size sits on, when the sheet may hold a larger field than core searches. */
  limit: number | null;
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
  // The answer does not depend on the current size, only on the shape kind; a box or polyhedron also depends
  // on everything it is made of (proportions, net, mode), as the sizing keeps them, and a cylinder or
  // torus on which sides it glues.
  const shape = isSwitchedShape(current.shape) ? current.shape
    : current.shape.shape === "cylinder" ? { shape: "cylinder", axis: current.shape.axis }
    : current.shape.shape;
  const key = JSON.stringify([{ ...current, shape }, input]);
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
  const { shape: preset, ...params } = packedForSheet(current, usableWidthMm, usableHeightMm).shape;
  // The whole search (the shape's family, a cylinder's or torus's closing up) runs in core.
  const t = displayTransform(current);
  const sized = getFieldPrintSizing({
    tessellation: current.tessellation,
    preset,
    params,
    directions: [[t.a, t.c], [t.b, t.d]],
    cellSide: TESSELLATION_UI[current.tessellation.kind].cellSidePx,
    usableWidthMm,
    usableHeightMm,
    cellSideMm,
    axisAligned: TESSELLATION_UI[current.tessellation.kind].editor.axisAlignedGrid,
  });
  if (!sized) return null;

  return {
    config: { ...current, shape: { shape: preset, ...sized.params } as PresetFieldShape },
    fieldWidthMm: sized.width * cellSideMm,
    fieldHeightMm: sized.height * cellSideMm,
    usableWidthMm,
    usableHeightMm,
    limit: sized.limit ?? null,
  };
}

/** A box in the compact layout is packed for the shape of the printable area (a portrait sheet
 * wants the faces stacked, a landscape one side by side); other fields are returned as they are. */
function packedForSheet(current: PredefinedFieldConfig, usableWidthMm: number, usableHeightMm: number): PredefinedFieldConfig {
  const { shape } = current;
  if (!isSwitchedShape(shape) || shape.net !== compactNetOf(current.tessellation, shape)) return current;
  const aspect = Math.min(1000, Math.max(1, Math.round(usableWidthMm / usableHeightMm * 100)));
  return { ...current, shape: { ...shape, aspect } };
}
