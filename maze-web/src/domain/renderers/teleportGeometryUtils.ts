import type { Axis } from "./teleportConnectorAxes";
import { pointInPolygon as containsPointInPolygon } from "../tessellationGeometry";
import type { Pos } from "../tessellationGeometry";

export const AXIS_EPSILON = 1e-6;

export function alongAxis(axis: Axis, x: number, y: number): number {
  return x * axis.ux + y * axis.uy;
}

export function perpOffset(axis: Axis, x: number, y: number): number {
  return x * axis.uy - y * axis.ux;
}

export function sameAxis(a: Axis, b: Axis): boolean {
  // Axes are undirected — (ux, uy) and (-ux, -uy) are the same axis — so compare the unsigned
  // direction via the cross product magnitude alone.
  return Math.abs(a.ux * b.uy - a.uy * b.ux) < AXIS_EPSILON;
}

/** Intersection of the line through `from` along `axisA` with the line through `to` along `axisB`
 *  — the bend point of a path that runs `from` along `axisA`, then along `axisB` into `to`. `null`
 *  when the two axes are (numerically) parallel, so no single bend point connects them. */
export function axisIntersection(from: [number, number], axisA: Axis, to: [number, number], axisB: Axis): [number, number] | null {
  const det = axisA.ux * axisB.uy - axisA.uy * axisB.ux;
  if (Math.abs(det) < AXIS_EPSILON) return null;
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const t = (dx * axisB.uy - dy * axisB.ux) / det;
  return [from[0] + t * axisA.ux, from[1] + t * axisA.uy];
}

/** Shortest distance from point `p` to the segment `a`-`b` (both `[x, y]`) — standard clamped
 *  point-to-segment projection, not just point-to-line (which would ignore the segment's own
 *  finite extent). */
export function pointToSegmentDistance(p: [number, number], a: [number, number], b: [number, number]): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const lenSq = abx * abx + aby * aby;
  if (lenSq < AXIS_EPSILON) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / lenSq));
  const projX = a[0] + t * abx;
  const projY = a[1] + t * aby;
  return Math.hypot(p[0] - projX, p[1] - projY);
}

/** Standard ray-casting point-in-polygon test (odd-even rule), `<=` on the crossing comparison so a
 *  point exactly on a shared cell edge (the common case here — every field-boundary sample lands
 *  exactly on some cell's own edge) still reads as "inside" that cell rather than falling through
 *  the gap between float-imprecise edge tests of two adjacent cells. */
/** Whether `p` lies within the maze field — inside (or on the border of) at least one of the
 *  field's own cell polygons (GitHub issue #300: "avoid field exit" priority option). Built from
 *  the actual maze cells rather than a bounding box so a non-rectangular field (a hex/triangle
 *  shape, or a custom field outline) is respected exactly, not approximated by its bounding
 *  rectangle. */
export function pointInField(p: Pos, cellPolygons: Pos[][]): boolean {
  for (const polygon of cellPolygons) {
    if (containsPointInPolygon(p, polygon)) return true;
  }
  return false;
}

/** Sampling step (world units) for walking a candidate's own two segments when checking whether it
 *  stays inside the field (see `candidateLeavesField`) — a quarter tile is fine enough that a
 *  segment can't "tunnel" through a field-boundary notch narrower than a tile between two samples,
 *  while staying cheap (a typical connector leg spans a handful of tiles at most). */
export const FIELD_EXIT_SAMPLE_STEP = 10;

/** Whether the point at world position `(x, y)`, offset `halfWidth` to either side perpendicular to
 *  `axis` (its own CCW normal, `(-uy, ux)`), still lands inside the field (GitHub issue #300 follow-
 *  up: the drawn connector line has real visual width, so "leaves the field" must mean the stroked
 *  line's own outer edge crosses the field boundary, not just its centerline). `halfWidth <= 0`
 *  (the pre-follow-up behavior) only checks the centerline itself. */
export function lineSpanInField(x: number, y: number, axis: Axis, halfWidth: number, cellPolygons: Pos[][]): boolean {
  if (halfWidth <= 0) return pointInField({ x, y }, cellPolygons);
  const nx = -axis.uy * halfWidth;
  const ny = axis.ux * halfWidth;
  return (
    pointInField({ x: x + nx, y: y + ny }, cellPolygons) && pointInField({ x: x - nx, y: y - ny }, cellPolygons)
  );
}
