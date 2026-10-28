import type { FieldConfig } from "../fieldConfig";
import { getCellVertices } from "./tessellationGeometry";
import type { PolygonPoint } from "./polygonGeometry";

/** Pointer angle (radians) within which a side direction snaps to a tessellation edge direction. */
const SNAP_TOLERANCE = (12 * Math.PI) / 180;
const DIRECTION_EPSILON = 1e-6;
/** Cell block sampled for edge directions; covers Cairo's periodic 4x4 orientation classes. */
const SAMPLE_SPAN = 4;
/** More distinct edge directions than this means the tessellation has no usable grid axes. */
const MAX_ALIGNMENT_DIRECTIONS = 12;

const directionCache = new WeakMap<FieldConfig, number[]>();

/** Folds an angle into [0, PI): a side direction has no sense. */
function foldAngle(angle: number): number {
  const folded = angle % Math.PI;
  return folded < 0 ? folded + Math.PI : folded;
}

/** Smallest absolute difference between two folded angles. */
function angleGap(a: number, b: number): number {
  const gap = Math.abs(foldAngle(a) - foldAngle(b));
  return Math.min(gap, Math.PI - gap);
}

/** Cell outline, or nothing when core rejects the coordinates (e.g. radial/voronoi kinds, where
 * the sampled block is not necessarily made of valid cells). */
function sampleVertices(x: number, y: number, cfg: FieldConfig): ReturnType<typeof getCellVertices> {
  try {
    return getCellVertices(x, y, cfg);
  } catch {
    return [];
  }
}

/** Distinct edge directions (world space, y-up, folded into [0, PI)) of the tessellation's cells. */
export function tessellationEdgeDirections(cfg: FieldConfig): number[] {
  const cached = directionCache.get(cfg);
  if (cached) return cached;
  const directions: number[] = [];
  for (let x = 0; x < SAMPLE_SPAN; x++) {
    for (let y = 0; y < SAMPLE_SPAN; y++) {
      const vertices = sampleVertices(x, y, cfg);
      for (let i = 0; i < vertices.length; i++) {
        const a = vertices[i];
        const b = vertices[(i + 1) % vertices.length];
        if (Math.hypot(b.x - a.x, b.y - a.y) < DIRECTION_EPSILON) continue;
        const angle = foldAngle(Math.atan2(-(b.y - a.y), b.x - a.x));
        if (!directions.some((known) => angleGap(known, angle) < DIRECTION_EPSILON * 100)) directions.push(angle);
      }
    }
  }
  // Curved or irregular tessellations (radial, voronoi, arcs) yield a spread of directions, and
  // snapping to that many is noise rather than alignment: leave the angle free there.
  const result = directions.length > MAX_ALIGNMENT_DIRECTIONS ? [] : directions.sort((a, b) => a - b);
  directionCache.set(cfg, result);
  return result;
}

/** Nearest edge direction to `angle` within the snap tolerance, skipping `exclude`; else null. */
function nearestDirection(angle: number, directions: readonly number[], exclude?: number): number | null {
  let best: number | null = null;
  let bestGap = SNAP_TOLERANCE;
  for (const direction of directions) {
    if (exclude !== undefined && angleGap(direction, exclude) < SNAP_TOLERANCE / 2) continue;
    const gap = angleGap(direction, angle);
    if (gap <= bestGap) {
      best = direction;
      bestGap = gap;
    }
  }
  return best;
}

/** Projects `vector` on the line at `direction`, keeping its sign relative to the line. */
function projectOnDirection(vector: PolygonPoint, direction: number): PolygonPoint {
  const ux = Math.cos(direction);
  const uy = Math.sin(direction);
  const length = vector.x * ux + vector.y * uy;
  return { x: ux * length, y: uy * length };
}

/** Moves `end` onto the nearest tessellation edge direction through `start` (base edge). */
export function snapBaseEnd(
  start: PolygonPoint,
  end: PolygonPoint,
  directions: readonly number[],
): PolygonPoint {
  const vector = { x: end.x - start.x, y: end.y - start.y };
  if (Math.hypot(vector.x, vector.y) < DIRECTION_EPSILON) return end;
  const direction = nearestDirection(Math.atan2(vector.y, vector.x), directions);
  if (direction === null) return end;
  const projected = projectOnDirection(vector, direction);
  return { x: start.x + projected.x, y: start.y + projected.y };
}

export interface ParallelogramOptions {
  /** Snap the second side to a tessellation edge direction other than the base direction. */
  directions?: readonly number[];
  /** Make the second side as long as the base. */
  equalSides?: boolean;
}

/**
 * Parallelogram `a, b, b + s, a + s` from the base `a -> b` and a pointer position; the second
 * side `s` runs from `a` towards the pointer. Returns null for a degenerate (zero-area) result.
 */
export function parallelogramFromPoints(
  a: PolygonPoint,
  b: PolygonPoint,
  pointer: PolygonPoint,
  options: ParallelogramOptions = {},
): PolygonPoint[] | null {
  const base = { x: b.x - a.x, y: b.y - a.y };
  const baseLength = Math.hypot(base.x, base.y);
  if (baseLength < DIRECTION_EPSILON) return null;
  let side = { x: pointer.x - a.x, y: pointer.y - a.y };
  if (options.directions) {
    const direction = nearestDirection(Math.atan2(side.y, side.x), options.directions, Math.atan2(base.y, base.x));
    if (direction !== null) side = projectOnDirection(side, direction);
  }
  if (options.equalSides) {
    const length = Math.hypot(side.x, side.y);
    if (length < DIRECTION_EPSILON) return null;
    side = { x: side.x / length * baseLength, y: side.y / length * baseLength };
  }
  const cross = base.x * side.y - base.y * side.x;
  if (Math.abs(cross) < DIRECTION_EPSILON * baseLength) return null;
  return [
    a,
    b,
    { x: b.x + side.x, y: b.y + side.y },
    { x: a.x + side.x, y: a.y + side.y },
  ];
}
