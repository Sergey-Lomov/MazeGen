import type { WorldPoint } from "../../wasm/mazeService";

/// Contract tolerances (`Specs/space.md`): `GEOM_EPS` is core's single world-unit tolerance for
/// geometric equality, containment and boundary tests -- the operations below use it for
/// coincidence (an intersection at a segment end, a zero-length segment, parallel segments).
/// Polylines come from a snapshot flattened at `GEOMETRY_TOLERANCE`, so a result is exact for the
/// polyline and within that tolerance of the true curve.
export const GEOM_EPS = 1e-9;

export interface ClosestPoint {
  point: WorldPoint;
  distance: number;
  /// Index of the segment holding the point; segment `i` runs from vertex `i` to `i + 1`
  /// (the last vertex wraps to the first for a closed polyline).
  segmentIndex: number;
  /// Position along that segment, `0..1`.
  t: number;
}

function segmentCount(polyline: readonly WorldPoint[], closed: boolean): number {
  if (polyline.length < 2) return 0;
  return closed ? polyline.length : polyline.length - 1;
}

function segmentAt(polyline: readonly WorldPoint[], index: number): [WorldPoint, WorldPoint] {
  return [polyline[index], polyline[(index + 1) % polyline.length]];
}

/// Closest point of a polyline to `p`; the earliest segment wins a tie. `null` for fewer than two
/// vertices.
export function closestPointOnPolyline(polyline: readonly WorldPoint[], p: WorldPoint, closed = false): ClosestPoint | null {
  let best: ClosestPoint | null = null;
  for (let i = 0; i < segmentCount(polyline, closed); i++) {
    const [a, b] = segmentAt(polyline, i);
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared <= GEOM_EPS * GEOM_EPS ? 0 : Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared));
    const point: WorldPoint = [a[0] + dx * t, a[1] + dy * t];
    const distance = Math.hypot(p[0] - point[0], p[1] - point[1]);
    if (best === null || distance < best.distance - GEOM_EPS) best = { point, distance, segmentIndex: i, t };
  }
  return best;
}

export interface PolylineIntersection {
  point: WorldPoint;
  segmentA: number;
  tA: number;
  segmentB: number;
  tB: number;
}

/// Proper and touching intersections of two polylines (an endpoint on the other polyline counts,
/// within `GEOM_EPS`). Parallel segments, collinear overlaps included, produce none. Results are
/// ordered by `segmentA`, then `tA`; a point shared by two consecutive segments of `a` is reported once.
export function polylineIntersections(
  a: readonly WorldPoint[],
  b: readonly WorldPoint[],
  closedA = false,
  closedB = false,
): PolylineIntersection[] {
  const found: PolylineIntersection[] = [];
  for (let i = 0; i < segmentCount(a, closedA); i++) {
    const [p, p2] = segmentAt(a, i);
    const rx = p2[0] - p[0];
    const ry = p2[1] - p[1];
    const lengthA = Math.hypot(rx, ry);
    if (lengthA <= GEOM_EPS) continue;
    for (let j = 0; j < segmentCount(b, closedB); j++) {
      const [q, q2] = segmentAt(b, j);
      const sx = q2[0] - q[0];
      const sy = q2[1] - q[1];
      const lengthB = Math.hypot(sx, sy);
      if (lengthB <= GEOM_EPS) continue;
      const denominator = rx * sy - ry * sx;
      if (Math.abs(denominator) <= GEOM_EPS * lengthA * lengthB) continue;
      const tA = ((q[0] - p[0]) * sy - (q[1] - p[1]) * sx) / denominator;
      const tB = ((q[0] - p[0]) * ry - (q[1] - p[1]) * rx) / denominator;
      const slackA = GEOM_EPS / lengthA;
      const slackB = GEOM_EPS / lengthB;
      if (tA < -slackA || tA > 1 + slackA || tB < -slackB || tB > 1 + slackB) continue;
      const clampedA = Math.min(1, Math.max(0, tA));
      const clampedB = Math.min(1, Math.max(0, tB));
      const point: WorldPoint = [p[0] + rx * clampedA, p[1] + ry * clampedA];
      if (found.some((f) => Math.hypot(f.point[0] - point[0], f.point[1] - point[1]) <= GEOM_EPS)) continue;
      found.push({ point, segmentA: i, tA: clampedA, segmentB: j, tB: clampedB });
    }
  }
  return found;
}

export interface OffsetOptions {
  closed?: boolean;
  /// Longest allowed miter, as a multiple of the offset distance; a sharper corner is bevelled.
  miterLimit?: number;
}

/// Offsets a polyline sideways by `distance` world units: positive to the left of its direction
/// of travel, negative to the right. Corners use a miter join, bevelled past `miterLimit`
/// (default 4). Repeated vertices are dropped first. Self-overlaps from a distance larger than a
/// local feature are not trimmed. Fewer than two distinct vertices yields an empty polyline.
export function offsetPolyline(polyline: readonly WorldPoint[], distance: number, options: OffsetOptions = {}): WorldPoint[] {
  const { closed = false, miterLimit = 4 } = options;
  const points: WorldPoint[] = [];
  for (const point of polyline) {
    const last = points[points.length - 1];
    if (!last || Math.hypot(point[0] - last[0], point[1] - last[1]) > GEOM_EPS) points.push(point);
  }
  if (closed && points.length > 1 && Math.hypot(points[0][0] - points[points.length - 1][0], points[0][1] - points[points.length - 1][1]) <= GEOM_EPS) points.pop();
  if (points.length < 2) return [];

  const count = segmentCount(points, closed);
  const normals: WorldPoint[] = [];
  for (let i = 0; i < count; i++) {
    const [a, b] = segmentAt(points, i);
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    normals.push([-(b[1] - a[1]) / length, (b[0] - a[0]) / length]);
  }
  const shifted = (point: WorldPoint, normal: WorldPoint): WorldPoint => [point[0] + normal[0] * distance, point[1] + normal[1] * distance];

  const out: WorldPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const before = closed ? normals[(i - 1 + count) % count] : normals[i - 1];
    const after = closed ? normals[i % count] : normals[i];
    if (!before) { out.push(shifted(points[i], after)); continue; }
    if (!after) { out.push(shifted(points[i], before)); continue; }
    const cosHalf = 1 + before[0] * after[0] + before[1] * after[1];
    // Miter length / distance = 2 / sqrt(2 + 2cos) = 1 / cosHalfAngle.
    const miterRatio = cosHalf <= GEOM_EPS ? Infinity : Math.SQRT2 / Math.sqrt(cosHalf);
    if (miterRatio > miterLimit) {
      out.push(shifted(points[i], before), shifted(points[i], after));
    } else {
      const bisector: WorldPoint = [(before[0] + after[0]) / cosHalf, (before[1] + after[1]) / cosHalf];
      out.push(shifted(points[i], bisector));
    }
  }
  return out;
}
