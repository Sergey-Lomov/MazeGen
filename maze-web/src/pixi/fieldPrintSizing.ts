import { hexOrientationOf, triOrientationOf, type FieldConfig, type PresetFieldShape } from "../fieldConfig";
import type { PrintFieldSizingInput } from "../store/imageExportTypes";
import { PAPER_SIZES_MM } from "./imageExport/paperSizes";
import { printMeasureToCellSideMm } from "./imageExport/printFit";
import { triCenterOffset } from "./triShapeHelpers";
import { cairoRectangleBoundaryCells, configAllCells } from "./tessellationCells";
import { getCellVertices as geometryCellVertices } from "./tessellationGeometry";
import { TILE_SIZE } from "./constants";

const MAX_RECT_DIMENSION = 1000;
const MAX_RADIUS = 500;
const SQRT_3 = Math.sqrt(3);

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

interface Point {
  x: number;
  y: number;
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
  if (shape.shape === "rect" && current.tessellation.kind === "square") {
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

  for (let cols = 1; cols <= maxCols; cols++) {
    let low = 1;
    let high = MAX_RECT_DIMENSION;
    let rows = 0;
    while (low <= high) {
      const candidateRows = Math.floor((low + high) / 2);
      const candidate = withSize(cols, candidateRows);
      if (fits(boundsInCellSides(candidate), usableWidthMm, usableHeightMm, cellSizeMm)) {
        rows = candidateRows;
        low = candidateRows + 1;
      } else {
        high = candidateRows - 1;
      }
    }
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

function boundsInCellSides(config: FieldConfig): Bounds {
  const cells = boundaryCells(config);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const [x, y] of cells) {
    for (const vertex of cellVertices(x, y, config)) {
      minX = Math.min(minX, vertex.x);
      minY = Math.min(minY, vertex.y);
      maxX = Math.max(maxX, vertex.x);
      maxY = Math.max(maxY, vertex.y);
    }
  }

  return { width: maxX - minX, height: maxY - minY };
}

function boundaryCells(config: FieldConfig): [number, number][] {
  const { shape } = config;
  const kind = config.tessellation.kind;
  if (shape.shape === "rect" && kind === "cairo") return cairoRectangleBoundaryCells(shape.cols, shape.rows);
  if (shape.shape === "rect" && kind === "hex") return hexRectangleBoundaryCells(shape.cols, shape.rows, hexOrientationOf(config));
  if (shape.shape === "circle" && kind === "square") return squareCircleBoundaryCells(shape.radius);
  if ((shape.shape === "circle" || shape.shape === "hexagon") && kind === "hex") return hexagonBoundaryCells(shape.radius);
  if (shape.shape === "triangle" && kind === "tri") return triangleTriangleBoundaryCells(shape.side);
  if (shape.shape === "hexagon" && kind === "tri") return triangleHexagonBoundaryCells(shape.radius);
  const cornerRect = (shape.shape === "rect" && (kind === "square" || kind === "tri"))
    || (shape.shape === "parallelogram" && kind === "hex");
  if (!cornerRect || (shape.shape !== "rect" && shape.shape !== "parallelogram")) return configAllCells(config);

  const cols = kind === "tri" ? shape.cols * 2 : shape.cols;
  const rows = shape.rows;
  // Cell vertices are affine in the row/column coordinates. Therefore extrema of a rectangular
  // field are reached at corners; the one-cell halo also covers both triangle parities. Keeping
  // this set bounded avoids walking an entire 1000×1000 boundary during every keystroke.
  const colCandidates = new Set([0, 1, cols - 2, cols - 1].filter((col) => col >= 0 && col < cols));
  const rowCandidates = new Set([0, 1, rows - 2, rows - 1].filter((row) => row >= 0 && row < rows));
  const ox = Math.floor(cols / 2);
  const oy = Math.floor(rows / 2);
  const cells: [number, number][] = [];
  for (const col of colCandidates) {
    for (const row of rowCandidates) {
      cells.push([col - ox, row - oy]);
    }
  }
  return cells;
}

function hexRectangleBoundaryCells(cols: number, rows: number, orientation: "flat_top" | "pointy_top"): [number, number][] {
  const originCol = Math.floor(cols / 2);
  const originRow = Math.floor(rows / 2);
  const boundary: [number, number][] = [];
  for (const col of new Set([0, cols - 1])) {
    for (const row of new Set([0, rows - 1])) {
      if (orientation === "flat_top") {
        const q = col - originCol;
        boundary.push([q, row - originRow - Math.floor(q / 2)]);
      } else {
        const r = row - originRow;
        boundary.push([col - originCol - Math.floor(r / 2), r]);
      }
    }
  }
  return boundary;
}

function squareCircleBoundaryCells(radius: number): [number, number][] {
  const edge = Math.max(0, radius - 1);
  return [[edge, 0], [-edge, 0], [0, edge], [0, -edge]];
}

function hexagonBoundaryCells(radius: number): [number, number][] {
  const cells = new Set<string>();
  const add = (x: number, y: number) => cells.add(`${x},${y}`);
  for (let x = -radius; x <= radius; x++) {
    const low = -radius - x;
    const high = radius - x;
    if (low >= -radius && low <= radius) add(x, low);
    if (high >= -radius && high <= radius) add(x, high);
  }
  for (let y = 0; y <= radius; y++) add(-radius, y);
  for (let y = -radius; y <= 0; y++) add(radius, y);
  return Array.from(cells, (cell) => cell.split(",").map(Number) as [number, number]);
}

function triangleTriangleBoundaryCells(side: number): [number, number][] {
  const raw: [number, number][] = [];
  const shift = side % 2;
  for (let row = 0; row < side; row++) {
    const indent = side - 1 - row + shift;
    raw.push([indent, row], [indent + 2 * row, row]);
    if (row === side - 1) {
      for (let col = indent; col <= indent + 2 * row; col++) raw.push([col, row]);
    }
  }
  return centerBoundaryCells(raw);
}

function triangleHexagonBoundaryCells(radius: number): [number, number][] {
  const raw: [number, number][] = [];
  const oddBase = radius % 2 === 0 ? radius - 1 : radius;
  for (let row = 0; row < 2 * radius; row++) {
    const k = Math.min(row, 2 * radius - 1 - row);
    const indent = oddBase - k;
    const width = 2 * (k + radius) + 1;
    raw.push([indent, row], [indent + width - 1, row]);
    if (row === 0 || row === 2 * radius - 1) {
      for (let col = indent; col < indent + width; col++) raw.push([col, row]);
    }
  }
  return centerBoundaryCells(raw);
}

function centerBoundaryCells(raw: [number, number][]): [number, number][] {
  const { ox, oy } = triCenterOffset(raw);
  return raw.map(([x, y]) => [x - ox, y - oy]);
}

function cellVertices(x: number, y: number, config: FieldConfig): Point[] {
  if (config.shape.shape === "custom") return [];
  switch (config.tessellation.kind) {
    case "square":
      return [
        { x: x, y: y },
        { x: x + 1, y: y },
        { x: x + 1, y: y + 1 },
        { x: x, y: y + 1 },
      ];
    case "hex": {
      const orientation = hexOrientationOf(config);
      const angle = orientation === "pointy_top" ? Math.PI / 6 : 0;
      const center = rotate(
        1.5 * x,
        -(SQRT_3 * y + (SQRT_3 / 2) * x),
        angle,
      );
      const start = orientation === "flat_top" ? 0 : Math.PI / 2;
      return Array.from({ length: 6 }, (_, i) => {
        const a = start + i * Math.PI / 3;
        return { x: center.x + Math.cos(a), y: center.y - Math.sin(a) };
      });
    }
    case "tri": {
      const orientation = triOrientationOf(config);
      const side = 1;
      const height = SQRT_3 / 2;
      const pointingUp = ((x + y) % 2 + 2) % 2 === 0;
      const center = {
        x: x * side / 2 + side / 4,
        y: pointingUp ? -(y * height + height / 3) : -(y * height + 2 * height / 3),
      };
      const offsets = pointingUp
        ? [{ x: 0, y: -2 * height / 3 }, { x: side / 2, y: height / 3 }, { x: -side / 2, y: height / 3 }]
        : [{ x: -side / 2, y: -height / 3 }, { x: side / 2, y: -height / 3 }, { x: 0, y: 2 * height / 3 }];
      return offsets.map((offset) => rotate(center.x + offset.x, center.y + offset.y, triRotation(orientation)));
    }
    case "cairo": {
      return (geometryCellVertices(x, y, config) ?? []).map((point) => ({
        x: point.x / TILE_SIZE,
        y: -point.y / TILE_SIZE,
      }));
    }
  }
}

function triRotation(orientation: "r0" | "r90" | "r180" | "r270"): number {
  switch (orientation) {
    case "r0": return 0;
    case "r90": return Math.PI / 2;
    case "r180": return Math.PI;
    case "r270": return Math.PI * 3 / 2;
  }
}

function rotate(x: number, y: number, angle: number): Point {
  return {
    x: x * Math.cos(angle) - y * Math.sin(angle),
    y: x * Math.sin(angle) + y * Math.cos(angle),
  };
}
