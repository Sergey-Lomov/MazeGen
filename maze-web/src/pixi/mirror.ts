import type { FieldConfig } from "../fieldConfig";
import { displayTransform, getCellVertices } from "./tessellationGeometry";
import { makeProjection } from "./tessellationProjection";
import { applyTransform, invertTransform } from "./geometry/worldTransform";
import { reflectFieldCells, type FieldOpError } from "../wasm/mazeService";
import { asFieldOpError } from "./fieldOps";
import { cellsInsidePolygon } from "./polygonGeometry";

export type MirrorSnapMode = "centers" | "corners" | "free";
export type MirrorScope = "everything" | "one_side" | "polygon";
export type MirrorPoint = { x: number; y: number };
export type MirrorAxisPoints = MirrorPoint[];

export interface MirrorOptions {
  scope: MirrorScope;
  sourceSide: -1 | 1;
  axis: [MirrorPoint, MirrorPoint];
  polygon: MirrorPoint[];
}

export interface MirrorPreview {
  sourceCells: [number, number][];
  mirroredCells: [number, number][];
  /** Why core refused the reflection; `mirroredCells` is empty then. */
  error: FieldOpError | null;
}

/** Distance (display units) under which a point counts as lying on the axis. */
const AXIS_EPSILON = 1e-6;

/** Signed side of a point relative to the directed axis. Positive means left of A→B; 0 on the axis. */
export function sideOfAxis(point: MirrorPoint, axis: [MirrorPoint, MirrorPoint], axisLength?: number): number {
  const [a, b] = axis;
  const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
  const length = axisLength ?? Math.hypot(b.x - a.x, b.y - a.y);
  return length === 0 || Math.abs(cross) / length < AXIS_EPSILON ? 0 : Math.sign(cross);
}

export function worldPointForCell(cell: [number, number], cfg: FieldConfig): MirrorPoint {
  const screen = makeProjection(cfg).gridToScreen(cell[0], cell[1]);
  return { x: screen.x, y: -screen.y };
}

export function cellForWorldPoint(point: MirrorPoint, cfg: FieldConfig): [number, number] {
  const grid = makeProjection(cfg).screenToGrid(point.x, -point.y);
  return [grid.x, grid.y];
}

/** Snap a world point using the same grid projection used by field editing. */
export function snapMirrorPoint(point: MirrorPoint, mode: MirrorSnapMode, cfg: FieldConfig): MirrorPoint {
  if (mode === "free") return { ...point };
  if (mode === "centers") return worldPointForCell(cellForWorldPoint(point, cfg), cfg);

  const grid = cellForWorldPoint(point, cfg);
  const candidates = cellVertices(grid[0], grid[1], cfg);
  let best = candidates[0] ?? point;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = (candidate.x - point.x) ** 2 + (candidate.y - point.y) ** 2;
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** The axis in `maze-core` world units: mirror space is y-up display space. */
function axisInCoreSpace(axis: [MirrorPoint, MirrorPoint], cfg: FieldConfig): [[number, number], [number, number]] {
  const inverse = invertTransform(displayTransform(cfg));
  const toCore = (point: MirrorPoint) => applyTransform(inverse, [point.x, -point.y]);
  return [toCore(axis[0]), toCore(axis[1])];
}

/**
 * Computes the cells shown by the mirror preview. Sources are the filled cells selected by the
 * scope; their mirror image comes from `maze-core`, which refuses axes that are not true
 * reflection symmetries of the tessellation (`error`, with no mirrored cells).
 */
export function computeMirrorPreview(
  filledCells: Set<number>,
  cfg: FieldConfig,
  options: MirrorOptions,
  encode: (x: number, y: number) => number,
  decode: (key: number) => [number, number],
): MirrorPreview {
  const sourceCells: [number, number][] = [];
  const axisLength = Math.hypot(options.axis[1].x - options.axis[0].x, options.axis[1].y - options.axis[0].y);
  if (axisLength === 0) return { sourceCells, mirroredCells: [], error: null };
  const polygonCells = options.scope === "polygon"
    ? new Set(cellsInsidePolygon(options.polygon, cfg).map(([x, y]) => encode(x, y)))
    : null;

  for (const key of filledCells) {
    const cell = decode(key);
    const side = sideOfAxis(worldPointForCell(cell, cfg), options.axis, axisLength);
    if (side === 0) continue;
    if (options.scope === "one_side" && side !== options.sourceSide) continue;
    if (options.scope === "polygon" && !polygonCells?.has(key)) continue;
    sourceCells.push(cell);
  }
  if (sourceCells.length === 0) return { sourceCells, mirroredCells: [], error: null };
  try {
    const mirroredCells = reflectFieldCells(cfg.tessellation, sourceCells, axisInCoreSpace(options.axis, cfg));
    return { sourceCells, mirroredCells, error: null };
  } catch (error) {
    return { sourceCells, mirroredCells: [], error: asFieldOpError(error) };
  }
}

function cellVertices(x: number, y: number, cfg: FieldConfig): MirrorPoint[] {
  return getCellVertices(x, y, cfg).map((point) => ({ x: point.x, y: -point.y }));
}

export function mirrorStatus(options: Pick<MirrorOptions, "axis" | "scope" | "polygon"> | { axisPoints: MirrorAxisPoints; scope: MirrorScope; polygon: MirrorPoint[]; polygonFinished?: boolean }): "axis" | "polygon" | "ready" {
  const axis = "axisPoints" in options ? options.axisPoints : options.axis;
  if (axis.length < 2 || (axis.length === 2 && axis[0].x === axis[1].x && axis[0].y === axis[1].y)) return "axis";
  const polygonFinished = !("polygonFinished" in options) || options.polygonFinished === true;
  if (options.scope === "polygon" && (options.polygon.length < 3 || !polygonFinished)) return "polygon";
  return "ready";
}
