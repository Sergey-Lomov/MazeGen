import type { FieldConfig } from "../fieldConfig";
import { getFieldCellSizes, type CellSizesReport } from "../wasm/mazeService";
import { TESSELLATION_UI } from "./geometry/tessellationUi";

/** A cell with a side under this (millimeters) is hard to print and to solve on paper. */
export const MIN_COMFORTABLE_CELL_SIDE_MM = 5;

/** Printed size of the cells of one cell type, in millimeters (GitHub issue #948). */
export interface PrintCellTypeSize {
  key: string;
  count: number;
  /** Distinct side lengths, longest first; empty for an irregular type. */
  sidesMm: number[];
  /** Diameter of the circle centered at a cell's center through its farthest vertex; `0` for an irregular type. */
  diameterMm: number;
  /** Cells of the type differ in size (Voronoi, the rings of a radial field). */
  regular: boolean;
}

/** Millimeters in one world unit of the tessellation when the print-sizing measure is `cellSizeMm`. */
export function mmPerWorldUnit(config: Pick<FieldConfig, "tessellation">, cellSizeMm: number): number {
  const ui = TESSELLATION_UI[config.tessellation.kind];
  return cellSizeMm / ui.cellMeasurePx * ui.pixelsPerUnit;
}

/** The cells to measure: a preset shape core builds itself, or the cells of a custom field. */
export type CellSource = { preset: string; params: Record<string, number> } | { cells: [number, number][] };

/** The cell source of a field config: a preset shape is sent as its params, so its cells are not
 * shipped through wasm. */
export function cellSourceOf(config: FieldConfig): CellSource {
  const { shape } = config;
  if (shape.shape === "custom") return { cells: shape.points.map(([x, y]) => [x, y]) };
  const { shape: preset, ...params } = shape;
  return { preset, params };
}

/** What core measured for the cell sources of all floors together. */
export interface PrintCellMeasure {
  /** Count, sides and diameter per cell type, summed over the floors. Empty for an unusable size. */
  types: PrintCellTypeSize[];
  /** The cell count of each source, in the order of `sources`. */
  sourceCounts: number[];
}

/** Measures the cells of `sources` (all floors together) for the print-sizing measure
 * `cellSizeMm`. Core counts and measures them; only numbers come back, so a preset field never
 * crosses the wasm boundary as a list of cells. */
export function measurePrintCells(
  config: Pick<FieldConfig, "tessellation">,
  sources: CellSource[],
  cellSizeMm: number,
): PrintCellMeasure {
  if (sources.length === 0) return { types: [], sourceCounts: [] };
  // Floors of one shape are sent once with their number, so core measures the shape once.
  const presets = new Map<string, { preset: string; params: Record<string, number>; times: number }>();
  const cells: [number, number][] = [];
  for (const source of sources) {
    if ("cells" in source) {
      // Not `push(...)`: a large field exceeds the argument limit of a call.
      for (const cell of source.cells) cells.push(cell);
      continue;
    }
    const key = JSON.stringify(source);
    const known = presets.get(key);
    if (known) known.times += 1;
    else presets.set(key, { ...source, times: 1 });
  }
  const keys = [...presets.keys()];
  const report = worldCellSizes(config.tessellation, [...presets.values()], cells);
  const sourceCounts = sources.map((source) =>
    "cells" in source ? source.cells.length : report.presetCounts[keys.indexOf(JSON.stringify(source))]);
  if (!Number.isFinite(cellSizeMm) || cellSizeMm <= 0) return { types: [], sourceCounts };
  const mm = mmPerWorldUnit(config, cellSizeMm);
  const types = report.types.map((type) => ({
    key: type.key,
    count: type.count,
    sidesMm: type.sides.map((side) => side * mm),
    diameterMm: type.diameter * mm,
    regular: type.regular,
  }));
  return { types, sourceCounts };
}

/** Core's answer is in world units and does not depend on the entered size, so editing the size back
 * and forth reuses it: measuring every cell of a large field takes seconds. */
const CELL_SIZES_CACHE_LIMIT = 32;
const cellSizesCache = new Map<string, CellSizesReport>();

function worldCellSizes(
  tessellation: FieldConfig["tessellation"],
  presets: { preset: string; params: Record<string, number>; times: number }[],
  cells: [number, number][],
): CellSizesReport {
  const key = JSON.stringify([tessellation, presets, cells]);
  let report = cellSizesCache.get(key);
  if (!report) {
    try {
      report = getFieldCellSizes(tessellation, { presets, cells });
    } catch (error) {
      // The dialog still works without the section; a failure is not cached so a later call retries.
      console.error("Cell sizes unavailable", error);
      return { types: [], presetCounts: presets.map(() => 0) };
    }
    if (cellSizesCache.size >= CELL_SIZES_CACHE_LIMIT) cellSizesCache.delete(cellSizesCache.keys().next().value!);
    cellSizesCache.set(key, report);
  }
  return report;
}

/** Whether any type's cells differ in size, so the entered size needs an explanation. */
export function hasIrregularType(sizes: PrintCellTypeSize[]): boolean {
  return sizes.some((type) => !type.regular);
}

/** Whether the shortest side of the type's cells is under `MIN_COMFORTABLE_CELL_SIDE_MM`; an
 * irregular type has no side to judge. */
export function hasTooSmallSide(type: PrintCellTypeSize): boolean {
  return type.regular && type.sidesMm.length > 0 && Math.min(...type.sidesMm) < MIN_COMFORTABLE_CELL_SIDE_MM;
}
