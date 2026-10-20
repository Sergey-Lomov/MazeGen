import type { TeleportArrowMode, TeleportEdge } from "./types";

/** A drawable polyline for one connector: `points` is `[x0,y0,x1,y1,...]`. A straight path has
 * two points, a regular orthogonal path has three, and a radial path can include sampled arc points. */
export type RoutedConnector = { points: number[] };

/** Routes every `edges` entry as a `"straight"` center-to-center line — no bend, no collision
 *  offset (two straight connectors can still visually overlap if collinear, but that's the
 *  existing pre-#293 look, unaffected by this module). */
export function routeStraightConnectors(edges: TeleportEdge[]): RoutedConnector[] {
  return edges.map((e) => ({ points: [e.from[0], e.from[1], e.to[0], e.to[1]] }));
}

const RADIAL_ARC_STEP = Math.PI / 24;

function radialPoint(radius: number, angle: number): [number, number] {
  const x = radius * Math.cos(angle);
  const y = radius * Math.sin(angle);
  return [Math.abs(x) < 1e-12 ? 0 : x, Math.abs(y) < 1e-12 ? 0 : y];
}

function pointToPolylineDistance(point: [number, number], points: number[]): number {
  let nearest = Infinity;
  for (let i = 0; i + 3 < points.length; i += 2) {
    const [ax, ay, bx, by] = [points[i], points[i + 1], points[i + 2], points[i + 3]];
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - ax) * dx + (point[1] - ay) * dy) / lengthSquared));
    nearest = Math.min(nearest, Math.hypot(point[0] - (ax + dx * t), point[1] - (ay + dy * t)));
  }
  return nearest;
}

function appendPoint(points: number[], x: number, y: number): void {
  if (points.length === 0 || points[points.length - 2] !== x || points[points.length - 1] !== y) points.push(x, y);
}

function appendArc(points: number[], radius: number, fromAngle: number, angleDelta: number): void {
  const steps = Math.max(1, Math.ceil(Math.abs(angleDelta) / RADIAL_ARC_STEP));
  for (let step = 0; step <= steps; step++) appendPoint(points, ...radialPoint(radius, fromAngle + (angleDelta * step) / steps));
}

/** Routes radial-tessellation connectors with one corner: either along the source spoke then the
 * target ring, or along the source ring then the target spoke. Marker collisions choose between
 * those two candidates before path length breaks a tie. */
export function routeRadialConnectors(edges: TeleportEdge[], markerRadius = 0, waypoints: [number, number][] = []): RoutedConnector[] {
  const markers = [...waypoints, ...edges.flatMap((edge) => [edge.from, edge.to])];
  return edges.map(({ from, to }) => {
    const [fromX, fromY] = from;
    const [toX, toY] = to;
    const fromRadius = Math.hypot(fromX, fromY);
    const toRadius = Math.hypot(toX, toY);
    if (fromRadius === 0 || toRadius === 0) return { points: [fromX, fromY, toX, toY] };

    const fromAngle = Math.atan2(fromY, fromX);
    const toAngle = Math.atan2(toY, toX);
    let angleDelta = toAngle - fromAngle;
    if (angleDelta <= -Math.PI) angleDelta += Math.PI * 2;
    if (angleDelta > Math.PI) angleDelta -= Math.PI * 2;

    const radialThenArc: number[] = [fromX, fromY];
    appendPoint(radialThenArc, ...radialPoint(toRadius, fromAngle));
    appendArc(radialThenArc, toRadius, fromAngle, angleDelta);
    appendPoint(radialThenArc, toX, toY);

    const arcThenRadial: number[] = [fromX, fromY];
    appendArc(arcThenRadial, fromRadius, fromAngle, angleDelta);
    appendPoint(arcThenRadial, toX, toY);
    const candidates = [{ points: radialThenArc }, { points: arcThenRadial }];
    const ownPoint = (point: [number, number]) =>
      (point[0] === fromX && point[1] === fromY) || (point[0] === toX && point[1] === toY);
    const penalty = (routed: RoutedConnector) => {
      const collisions = markerRadius === 0 ? 0 : markers.filter((marker) => !ownPoint(marker) && pointToPolylineDistance(marker, routed.points) < markerRadius).length;
      let length = 0;
      for (let i = 0; i + 3 < routed.points.length; i += 2) length += Math.hypot(routed.points[i + 2] - routed.points[i], routed.points[i + 3] - routed.points[i + 1]);
      return [collisions, length] as const;
    };
    return candidates.reduce((best, candidate) => {
      const [bestCollisions, bestLength] = penalty(best);
      const [candidateCollisions, candidateLength] = penalty(candidate);
      return candidateCollisions < bestCollisions || (candidateCollisions === bestCollisions && candidateLength < bestLength) ? candidate : best;
    });
  });
}

/** One arrow to draw along a routed polyline: its position and the (unit-length) direction it
 *  points. */
export type ArrowPlacement = { x: number; y: number; dx: number; dy: number };

/** A point at `distance` along `pts` (a flat `[x0,y0,x1,y1,...]` polyline), plus the unit direction
 *  of the segment it landed in. `distance` is clamped to `[0, totalLength]`, then nudged away from
 *  any interior bend point (a join between two segments — not the path's own start/end) by up to
 *  `bendAvoidance`, toward whichever side it already sits on (see `avoidBends`) — never crossing the
 *  bend onto the other segment, so the arrow keeps the direction of the side it started on. Returns
 *  `null` for a zero-length path (every point coincides). */
function pointAtLength(pts: number[], distance: number, bendAvoidance: number): ArrowPlacement | null {
  const segLengths: number[] = [];
  let totalLength = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const len = Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
    segLengths.push(len);
    totalLength += len;
  }
  if (totalLength === 0) return null;
  const clamped = Math.min(Math.max(distance, 0), totalLength);
  let target = avoidBends(clamped, segLengths, totalLength, bendAvoidance);
  for (let s = 0; s < segLengths.length; s++) {
    const [ax, ay, bx, by] = [pts[s * 2], pts[s * 2 + 1], pts[s * 2 + 2], pts[s * 2 + 3]];
    if (target > segLengths[s] && s < segLengths.length - 1) {
      target -= segLengths[s];
      continue;
    }
    if (segLengths[s] === 0) continue;
    const t = target / segLengths[s];
    const dx = (bx - ax) / segLengths[s];
    const dy = (by - ay) / segLengths[s];
    return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t, dx, dy };
  }
  return null;
}

/** Pushes `distance` (already clamped to `[0, totalLength]`) away from any interior bend — a
 *  cumulative segment-length boundary that isn't the path's own start (0) or end (`totalLength`) —
 *  by up to `bendAvoidance`, staying on whichever side of the bend `distance` already falls on
 *  (so the arrow never crosses onto the other segment's direction). Falls back to the closest point
 *  that still has room on that side, and gives up — leaving `distance` unchanged — if that side has
 *  no room at all, which only happens on a segment shorter than `bendAvoidance`. */
function avoidBends(distance: number, segLengths: number[], totalLength: number, bendAvoidance: number): number {
  let cumulative = 0;
  for (let s = 0; s < segLengths.length - 1; s++) {
    cumulative += segLengths[s];
    const delta = distance - cumulative;
    if (Math.abs(delta) >= bendAvoidance) continue;
    if (delta >= 0) {
      const roomAfter = totalLength - cumulative;
      return cumulative + Math.min(bendAvoidance, roomAfter);
    }
    const roomBefore = cumulative;
    return cumulative - Math.min(bendAvoidance, roomBefore);
  }
  return distance;
}

/** Where to draw a one-way connector's direction arrow(s) along its routed polyline `pts`, per
 *  `TeleportArrowMode`. `"periodic"` starts at half a period in (not at the very start) so a short
 *  connector — shorter than one period but not zero-length — still gets exactly one arrow instead
 *  of none; `periodTiles` is in the same world-space units as `pts` (already tile-size-scaled by
 *  the caller, see `TeleportRenderer`). `arrowSize` is the drawn arrowhead's size — also used as the
 *  minimum distance a placement is kept from any interior bend point of an orthogonal path, since an
 *  arrow landing at or right next to a bend would straddle two differently-angled segments, reading
 *  as a visibly broken/misaligned arrowhead. Degenerate (zero-length) paths return no arrows for
 *  every mode. */
export function arrowPlacements(pts: number[], mode: TeleportArrowMode, periodTiles: number, arrowSize: number): ArrowPlacement[] {
  if (mode === "none") return [];
  let totalLength = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) totalLength += Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
  if (totalLength === 0) return [];

  if (mode === "center") {
    const p = pointAtLength(pts, totalLength / 2, arrowSize);
    return p ? [p] : [];
  }
  if (mode === "double") {
    return [pointAtLength(pts, totalLength / 3, arrowSize), pointAtLength(pts, (totalLength * 2) / 3, arrowSize)].filter(
      (p): p is ArrowPlacement => p !== null,
    );
  }
  // "periodic"
  if (periodTiles <= 0) return [];
  if (periodTiles >= totalLength) {
    // Shorter than one full period — still gets exactly one arrow (at the midpoint) instead of
    // none, same rationale as `"center"`.
    const p = pointAtLength(pts, totalLength / 2, arrowSize);
    return p ? [p] : [];
  }
  const placements: ArrowPlacement[] = [];
  for (let d = periodTiles / 2; d < totalLength; d += periodTiles) {
    const p = pointAtLength(pts, d, arrowSize);
    if (p) placements.push(p);
  }
  return placements;
}
