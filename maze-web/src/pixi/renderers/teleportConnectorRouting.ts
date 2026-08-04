import type { TeleportArrowMode, TeleportEdge } from "./types";

/** One axis-aligned piece of a connector's routed path. `axis: "h"` has a fixed `y` and spans `x`
 *  from `x0` to `x1`; `axis: "v"` has a fixed `x` and spans `y` from `y0` to `y1`. `fixed` is that
 *  shared coordinate (`y` for `"h"`, `x` for `"v"`), `lo`/`hi` the sorted span on the other axis —
 *  this normalized shape is what lets two segments from different connectors be compared for
 *  overlap regardless of each one's own from/to direction. */
type Segment = { axis: "h" | "v"; fixed: number; lo: number; hi: number };

/** The two segments of one connector's single-bend orthogonal path, in draw order. `bend` is the
 *  corner point between them. */
type OrthogonalPath = { segments: [Segment, Segment]; bend: [number, number] };

function makeHSegment(y: number, xa: number, xb: number): Segment {
  return { axis: "h", fixed: y, lo: Math.min(xa, xb), hi: Math.max(xa, xb) };
}

function makeVSegment(x: number, ya: number, yb: number): Segment {
  return { axis: "v", fixed: x, lo: Math.min(ya, yb), hi: Math.max(ya, yb) };
}

/** The two candidate single-bend paths between `from` and `to`: horizontal-then-vertical (bend at
 *  `(to.x, from.y)`) and vertical-then-horizontal (bend at `(from.x, to.y)`). Degenerate axis-
 *  aligned or coincident `from`/`to` make the two candidates identical — harmless, `chooseOrthogonalPaths` just picks either. */
function candidatePaths(from: [number, number], to: [number, number]): [OrthogonalPath, OrthogonalPath] {
  const [fx, fy] = from;
  const [tx, ty] = to;
  const hThenV: OrthogonalPath = {
    segments: [makeHSegment(fy, fx, tx), makeVSegment(tx, fy, ty)],
    bend: [tx, fy],
  };
  const vThenH: OrthogonalPath = {
    segments: [makeVSegment(fx, fy, ty), makeHSegment(ty, fx, tx)],
    bend: [fx, ty],
  };
  return [hThenV, vThenH];
}

function segmentsOverlap(a: Segment, b: Segment): boolean {
  return a.axis === b.axis && a.fixed === b.fixed && a.lo < b.hi && b.lo < a.hi;
}

/** For every connector (one per `edges` entry with a non-zero-length span), picks whichever of its
 *  two single-bend candidate paths collides (segment-overlaps, see `segmentsOverlap`) with fewer
 *  segments among every *other* connector's own chosen-so-far candidate set — ties broken toward
 *  horizontal-then-vertical. Picking one connector at a time against the others' full candidate
 *  pairs (not yet resolved to a single choice) avoids order-dependence: each connector's own
 *  decision doesn't depend on which of its neighbors happened to be resolved first. */
function chooseOrthogonalPaths(edges: TeleportEdge[]): OrthogonalPath[] {
  const candidates = edges.map((e) => candidatePaths(e.from, e.to));
  return candidates.map(([hThenV, vThenH], i) => {
    let hThenVCollisions = 0;
    let vThenHCollisions = 0;
    for (let j = 0; j < candidates.length; j++) {
      if (j === i) continue;
      for (const otherSeg of [...candidates[j][0].segments, ...candidates[j][1].segments]) {
        if (hThenV.segments.some((s) => segmentsOverlap(s, otherSeg))) hThenVCollisions++;
        if (vThenH.segments.some((s) => segmentsOverlap(s, otherSeg))) vThenHCollisions++;
      }
    }
    return vThenHCollisions < hThenVCollisions ? vThenH : hThenV;
  });
}

/** A drawable polyline for one connector: `points` is `[x0,y0,x1,y1,...]` (3 points for an
 *  orthogonal path — start, offset bend, end — 2 for a straight one). */
export type RoutedConnector = { points: number[] };

/** Routes every `edges` entry as a `"straight"` center-to-center line — no bend, no collision
 *  offset (two straight connectors can still visually overlap if collinear, but that's the
 *  existing pre-#293 look, unaffected by this module). */
export function routeStraightConnectors(edges: TeleportEdge[]): RoutedConnector[] {
  return edges.map((e) => ({ points: [e.from[0], e.from[1], e.to[0], e.to[1]] }));
}

/** Routes every `edges` entry as a single-bend orthogonal path (see `chooseOrthogonalPaths`), then
 *  offsets each segment perpendicular to itself by `gap * (localIndex - (localCount - 1) / 2)`,
 *  where `localIndex`/`localCount` come from clustering same-axis, same-`fixed`-coordinate,
 *  overlapping-span segments across every connector via union-find — segments that don't overlap
 *  anything stay in a cluster of size 1 (zero offset), so the vast majority of connectors (which
 *  don't share a corridor with anything) draw exactly on-grid, only genuinely colliding runs fan
 *  out. Each connector's own bend point is nudged to the average of its two segments' individual
 *  offsets so the two segments still visually connect (their own offsets can differ since they
 *  belong to different clusters). `maxEndpointOffset` (the teleport marker's own drawn radius, when
 *  given) clamps only the start/end points' own nudge — a large cluster can otherwise offset a
 *  connector's endpoint far enough to visibly drift outside its teleport marker's shape; the bend
 *  point (mid-path, no marker to stay inside) is never clamped. */
export function routeOrthogonalConnectors(edges: TeleportEdge[], gap: number, maxEndpointOffset = Infinity): RoutedConnector[] {
  const paths = chooseOrthogonalPaths(edges);

  // Flatten to one entry per (connector, segment-within-path) for clustering.
  type Entry = { connectorIndex: number; segIndex: 0 | 1; segment: Segment };
  const entries: Entry[] = [];
  paths.forEach((path, connectorIndex) => {
    path.segments.forEach((segment, i) => entries.push({ connectorIndex, segIndex: i as 0 | 1, segment }));
  });

  const parent = entries.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (entries[i].connectorIndex === entries[j].connectorIndex) continue;
      if (segmentsOverlap(entries[i].segment, entries[j].segment)) union(i, j);
    }
  }

  const clusterMembers = new Map<number, number[]>();
  entries.forEach((_, i) => {
    const root = find(i);
    const members = clusterMembers.get(root) ?? [];
    members.push(i);
    clusterMembers.set(root, members);
  });

  // Stable per-cluster ordering (by connectorIndex) so the same input always assigns the same
  // offsets, independent of Map/array iteration order.
  const offsetByEntry = new Map<number, number>();
  for (const members of clusterMembers.values()) {
    const sorted = [...members].sort((a, b) => entries[a].connectorIndex - entries[b].connectorIndex);
    sorted.forEach((entryIndex, localIndex) => {
      offsetByEntry.set(entryIndex, gap * (localIndex - (sorted.length - 1) / 2));
    });
  }

  // A point's coordinate along a given axis, nudged by that axis's own connector offset — "h"
  // offsets y, "v" offsets x.
  const nudge = (x: number, y: number, axis: "h" | "v", offset: number): [number, number] =>
    axis === "h" ? [x, y + offset] : [x + offset, y];

  return paths.map((path, connectorIndex) => {
    const [fx, fy] = edges[connectorIndex].from;
    const [tx, ty] = edges[connectorIndex].to;
    const entryIndexFor = (segIndex: 0 | 1) =>
      entries.findIndex((e) => e.connectorIndex === connectorIndex && e.segIndex === segIndex);
    const offset0 = offsetByEntry.get(entryIndexFor(0)) ?? 0;
    const offset1 = offsetByEntry.get(entryIndexFor(1)) ?? 0;
    const axis0 = path.segments[0].axis;
    const axis1 = path.segments[1].axis;
    const clampedOffset0 = Math.max(-maxEndpointOffset, Math.min(maxEndpointOffset, offset0));
    const clampedOffset1 = Math.max(-maxEndpointOffset, Math.min(maxEndpointOffset, offset1));

    // `start` only belongs to segment 0, `end` only to segment 1 — each nudged by its own
    // segment's offset (clamped to stay within the endpoint's own teleport marker). `bend` is
    // shared by both segments, so it's nudged by both in sequence (they're always opposite axes, so
    // this moves it on both x and y independently) using the *unclamped* offset — it has no marker
    // to stay inside.
    const [startX, startY] = nudge(fx, fy, axis0, clampedOffset0);
    const [endX, endY] = nudge(tx, ty, axis1, clampedOffset1);
    const [bendX0, bendY0] = nudge(path.bend[0], path.bend[1], axis0, offset0);
    const [bendX, bendY] = nudge(bendX0, bendY0, axis1, offset1);

    return { points: [startX, startY, bendX, bendY, endX, endY] };
  });
}

/** One arrow to draw along a routed polyline: its position and the (unit-length) direction it
 *  points. */
export type ArrowPlacement = { x: number; y: number; dx: number; dy: number };

/** Minimum distance (world-space units) an arrow's placement is kept from any interior bend point
 *  of an orthogonal path — landing exactly on a bend leaves the arrow straddling two different
 *  segment directions (its own drawn direction becomes whichever segment `pointAtLength` happens
 *  to resolve to first), reading as a visibly broken/misaligned arrowhead. */
const BEND_AVOIDANCE_DISTANCE = 6;

/** A point at `distance` along `pts` (a flat `[x0,y0,x1,y1,...]` polyline), plus the unit direction
 *  of the segment it landed in. `distance` is clamped to `[0, totalLength]`, then nudged away from
 *  any interior bend point (a join between two segments — not the path's own start/end) by up to
 *  `BEND_AVOIDANCE_DISTANCE`, toward whichever side leaves more room (see `avoidBends`). Returns
 *  `null` for a zero-length path (every point coincides). */
function pointAtLength(pts: number[], distance: number): ArrowPlacement | null {
  const segLengths: number[] = [];
  let totalLength = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const len = Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
    segLengths.push(len);
    totalLength += len;
  }
  if (totalLength === 0) return null;
  const clamped = Math.min(Math.max(distance, 0), totalLength);
  let target = avoidBends(clamped, segLengths, totalLength);
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

/** Nudges `distance` (already clamped to `[0, totalLength]`) away from any interior bend — a
 *  cumulative segment-length boundary that isn't the path's own start (0) or end (`totalLength`) —
 *  by up to `BEND_AVOIDANCE_DISTANCE`, toward whichever side of the bend has more room (falls back
 *  to the side with room if only one does, and gives up — leaving `distance` unchanged — if neither
 *  side has room, which only happens on a path shorter than `2 * BEND_AVOIDANCE_DISTANCE`). */
function avoidBends(distance: number, segLengths: number[], totalLength: number): number {
  let cumulative = 0;
  for (let s = 0; s < segLengths.length - 1; s++) {
    cumulative += segLengths[s];
    const delta = distance - cumulative;
    if (Math.abs(delta) >= BEND_AVOIDANCE_DISTANCE) continue;
    const roomBefore = cumulative;
    const roomAfter = totalLength - cumulative;
    if (roomAfter >= BEND_AVOIDANCE_DISTANCE && (delta >= 0 || roomBefore < BEND_AVOIDANCE_DISTANCE)) {
      return cumulative + BEND_AVOIDANCE_DISTANCE;
    }
    if (roomBefore >= BEND_AVOIDANCE_DISTANCE) {
      return cumulative - BEND_AVOIDANCE_DISTANCE;
    }
    return distance;
  }
  return distance;
}

/** Where to draw a one-way connector's direction arrow(s) along its routed polyline `pts`, per
 *  `TeleportArrowMode`. `"periodic"` starts at half a period in (not at the very start) so a short
 *  connector — shorter than one period but not zero-length — still gets exactly one arrow instead
 *  of none; `periodTiles` is in the same world-space units as `pts` (already tile-size-scaled by
 *  the caller, see `TeleportRenderer`). Degenerate (zero-length) paths return no arrows for every
 *  mode. */
export function arrowPlacements(pts: number[], mode: TeleportArrowMode, periodTiles: number): ArrowPlacement[] {
  if (mode === "none") return [];
  let totalLength = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) totalLength += Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
  if (totalLength === 0) return [];

  if (mode === "center") {
    const p = pointAtLength(pts, totalLength / 2);
    return p ? [p] : [];
  }
  if (mode === "double") {
    return [pointAtLength(pts, totalLength / 3), pointAtLength(pts, (totalLength * 2) / 3)].filter(
      (p): p is ArrowPlacement => p !== null,
    );
  }
  // "periodic"
  if (periodTiles <= 0) return [];
  if (periodTiles >= totalLength) {
    // Shorter than one full period — still gets exactly one arrow (at the midpoint) instead of
    // none, same rationale as `"center"`.
    const p = pointAtLength(pts, totalLength / 2);
    return p ? [p] : [];
  }
  const placements: ArrowPlacement[] = [];
  for (let d = periodTiles / 2; d < totalLength; d += periodTiles) {
    const p = pointAtLength(pts, d);
    if (p) placements.push(p);
  }
  return placements;
}
