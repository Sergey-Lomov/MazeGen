import type { TeleportArrowMode, TeleportEdge } from "./types";

/** A drawable polyline for one connector: `points` is `[x0,y0,x1,y1,...]` (3 points for an
 *  orthogonal path — start, offset bend, end — 2 for a straight one). */
export type RoutedConnector = { points: number[] };

/** Routes every `edges` entry as a `"straight"` center-to-center line — no bend, no collision
 *  offset (two straight connectors can still visually overlap if collinear, but that's the
 *  existing pre-#293 look, unaffected by this module). */
export function routeStraightConnectors(edges: TeleportEdge[]): RoutedConnector[] {
  return edges.map((e) => ({ points: [e.from[0], e.from[1], e.to[0], e.to[1]] }));
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
