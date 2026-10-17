import type { FieldConfig } from "../fieldConfig";
import { getCellVertices } from "./tessellationGeometry";
import { configAllCells } from "./tessellationCells";
import { makeProjection } from "./tessellationProjection";
import { TILE_SIZE } from "./constants";
import { cellsInsidePolygon } from "./polygonGeometry";

export type SymmetrySnapMode = "centers" | "corners" | "free";
export type SymmetryScope = "everything" | "one_side" | "polygon";
export type SymmetryPoint = { x: number; y: number };
export type SymmetryAxisPoints = SymmetryPoint[];

export interface SymmetryOptions {
  scope: SymmetryScope;
  sourceSide: -1 | 1;
  axis: [SymmetryPoint, SymmetryPoint];
  polygon: SymmetryPoint[];
}

export interface SymmetryPreview {
  sourceCells: [number, number][];
  mirroredCells: [number, number][];
}

export function reflectPointAcrossAxis(point: SymmetryPoint, axis: [SymmetryPoint, SymmetryPoint]): SymmetryPoint {
  const [a, b] = axis;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return { ...point };
  const projection = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
  const projected = { x: a.x + projection * dx, y: a.y + projection * dy };
  return { x: 2 * projected.x - point.x, y: 2 * projected.y - point.y };
}

/** Signed side of a point relative to the directed axis. Positive means left of A→B. */
export function sideOfAxis(point: SymmetryPoint, axis: [SymmetryPoint, SymmetryPoint]): number {
  const [a, b] = axis;
  return Math.sign((b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x));
}

export function worldPointForCell(cell: [number, number], cfg: FieldConfig): SymmetryPoint {
  const screen = makeProjection(cfg).gridToScreen(cell[0], cell[1]);
  return { x: screen.x, y: -screen.y };
}

export function cellForWorldPoint(point: SymmetryPoint, cfg: FieldConfig): [number, number] {
  const grid = makeProjection(cfg).screenToGrid(point.x, -point.y);
  return [grid.x, grid.y];
}

/** Snap a world point using the same grid projection used by field editing. */
export function snapSymmetryPoint(point: SymmetryPoint, mode: SymmetrySnapMode, cfg: FieldConfig): SymmetryPoint {
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

/**
 * Computes the cells shown by the symmetry preview. `candidateCells` is the finite set of
 * editable cells; only active cells from that set can become sources.
 */
export function computeSymmetryPreview(
  filledCells: Set<number>,
  candidateCells: [number, number][],
  cfg: FieldConfig,
  options: SymmetryOptions,
  encode: (x: number, y: number) => number,
): SymmetryPreview {
  const sourceCells: [number, number][] = [];
  const mirroredCells: [number, number][] = [];
  const seenMirrors = new Set<number>();
  const polygonCells = options.scope === "polygon"
    ? new Set(cellsInsidePolygon(options.polygon, cfg).map(([x, y]) => encode(x, y)))
    : null;
  const axisLength = Math.hypot(options.axis[1].x - options.axis[0].x, options.axis[1].y - options.axis[0].y);
  if (axisLength === 0) return { sourceCells, mirroredCells };

  for (const cell of candidateCells) {
    const key = encode(cell[0], cell[1]);
    if (!filledCells.has(key)) continue;

    const point = worldPointForCell(cell, cfg);
    const side = sideOfAxis(point, options.axis);
    if (side === 0) continue;
    if (options.scope === "one_side" && side !== options.sourceSide) continue;
    if (options.scope === "polygon" && !polygonCells?.has(key)) continue;

    const mirror = cellForWorldPoint(reflectPointAcrossAxis(point, options.axis), cfg);
    const mirrorKey = encode(mirror[0], mirror[1]);
    if (mirrorKey === key || seenMirrors.has(mirrorKey)) continue;
    seenMirrors.add(mirrorKey);
    sourceCells.push(cell);
    mirroredCells.push(mirror);
  }
  return { sourceCells, mirroredCells };
}

/** Returns a finite editable universe around the current field and axis. */
export function symmetryCandidateCells(
  filledCells: Set<number>,
  cfg: FieldConfig,
  axisPoints: SymmetryAxisPoints,
  decode: (key: number) => [number, number],
): [number, number][] {
  const cells = new Map<string, [number, number]>();
  for (const cell of configAllCells(cfg)) cells.set(`${cell[0]},${cell[1]}`, cell);
  for (const key of filledCells) {
    const cell = decode(key);
    cells.set(`${cell[0]},${cell[1]}`, cell);
  }

  const worldPoints = [
    ...[...cells.values()].map((cell) => worldPointForCell(cell, cfg)),
    ...axisPoints,
  ];
  if (worldPoints.length === 0) return [];
  const minX = Math.min(...worldPoints.map((point) => point.x)) - TILE_SIZE * 2;
  const maxX = Math.max(...worldPoints.map((point) => point.x)) + TILE_SIZE * 2;
  const minY = Math.min(...worldPoints.map((point) => point.y)) - TILE_SIZE * 2;
  const maxY = Math.max(...worldPoints.map((point) => point.y)) + TILE_SIZE * 2;
  const projection = makeProjection(cfg);
  const gridCorners = [
    projection.screenToGrid(minX, -minY), projection.screenToGrid(maxX, -minY),
    projection.screenToGrid(minX, -maxY), projection.screenToGrid(maxX, -maxY),
  ];
  const minGridX = Math.min(...gridCorners.map((point) => point.x)) - 2;
  const maxGridX = Math.max(...gridCorners.map((point) => point.x)) + 2;
  const minGridY = Math.min(...gridCorners.map((point) => point.y)) - 2;
  const maxGridY = Math.max(...gridCorners.map((point) => point.y)) + 2;
  for (let x = minGridX; x <= maxGridX; x++) {
    for (let y = minGridY; y <= maxGridY; y++) cells.set(`${x},${y}`, [x, y]);
  }
  return [...cells.values()];
}

function cellVertices(x: number, y: number, cfg: FieldConfig): SymmetryPoint[] {
  return getCellVertices(x, y, cfg).map((point) => ({ x: point.x, y: -point.y }));
}

export function symmetryStatus(options: Pick<SymmetryOptions, "axis" | "scope" | "polygon"> | { axisPoints: SymmetryAxisPoints; scope: SymmetryScope; polygon: SymmetryPoint[]; polygonFinished?: boolean }): "axis" | "polygon" | "ready" {
  const axis = "axisPoints" in options ? options.axisPoints : options.axis;
  if (axis.length < 2 || (axis.length === 2 && axis[0].x === axis[1].x && axis[0].y === axis[1].y)) return "axis";
  const polygonFinished = !("polygonFinished" in options) || options.polygonFinished === true;
  if (options.scope === "polygon" && (options.polygon.length < 3 || !polygonFinished)) return "polygon";
  return "ready";
}
