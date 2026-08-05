import type { TeleportEdge } from "./types";
import { getConnectorAxes, SQUARE_AXES, type Axis } from "./teleportConnectorAxes";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { getCellVertices, type Pos } from "../tessellationGeometry";
import type { RoutedConnector } from "./teleportConnectorRouting";

/** One straight piece of a connector's routed path, running along `axis` (a unit direction, see
 *  `Axis`) at the fixed perpendicular offset `fixed` from the origin along that axis's own normal
 *  — `fixed = point.x * axis.uy - point.y * axis.ux` for any point on the segment's line, the
 *  standard "signed distance of a line from the origin" for a line through the origin with
 *  direction `axis`. `lo`/`hi` are the sorted span *along* `axis` (`point.x * axis.ux + point.y *
 *  axis.uy`). This normalized shape is what lets two segments from different connectors be
 *  compared for overlap regardless of each one's own from/to direction, generalizing the old
 *  square-only `"h"`/`"v"` axis pair to any of `getConnectorAxes`' N axes. */
type Segment = { axis: Axis; fixed: number; lo: number; hi: number };

/** The two segments of one connector's single-bend orthogonal path, in draw order. `bend` is the
 *  corner point between them; `from`/`to` are its own connector's original endpoints (kept here,
 *  not just the segments, so `countCollisions` can check whether an *other* path's overlap with
 *  `candidate` lands on that other connector's own endpoint — see `ENDPOINT_COLLISION_WEIGHT`). */
type OrthogonalPath = { segments: [Segment, Segment]; bend: [number, number]; from: [number, number]; to: [number, number] };

const AXIS_EPSILON = 1e-6;

function alongAxis(axis: Axis, x: number, y: number): number {
  return x * axis.ux + y * axis.uy;
}

function perpOffset(axis: Axis, x: number, y: number): number {
  return x * axis.uy - y * axis.ux;
}

function sameAxis(a: Axis, b: Axis): boolean {
  // Axes are undirected — (ux, uy) and (-ux, -uy) are the same axis — so compare the unsigned
  // direction via the cross product magnitude alone.
  return Math.abs(a.ux * b.uy - a.uy * b.ux) < AXIS_EPSILON;
}

function makeSegment(axis: Axis, pa: [number, number], pb: [number, number]): Segment {
  const la = alongAxis(axis, pa[0], pa[1]);
  const lb = alongAxis(axis, pb[0], pb[1]);
  return { axis, fixed: perpOffset(axis, pa[0], pa[1]), lo: Math.min(la, lb), hi: Math.max(la, lb) };
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

/** Every candidate single-bend path between `from` and `to`: one per ordered pair of distinct
 *  (non-parallel) axes from `axes` — first segment along the pair's first axis (from `from` to the
 *  bend), second along its second axis (from the bend to `to`). Generalizes the old square-only
 *  2-candidate (horizontal-then-vertical / vertical-then-horizontal) set to any axis count (hex/
 *  triangle: 3 axes, 6 ordered pairs). Degenerate axis-aligned or coincident `from`/`to` can make
 *  several candidates identical — harmless, `chooseOrthogonalPaths` just picks among them. */
function candidatePaths(from: [number, number], to: [number, number], axes: Axis[]): OrthogonalPath[] {
  const paths: OrthogonalPath[] = [];
  for (const axisA of axes) {
    for (const axisB of axes) {
      if (sameAxis(axisA, axisB)) continue;
      let bend = axisIntersection(from, axisA, to, axisB);
      if (bend === null) continue;
      // `axisIntersection`'s division can land a hair off an exact `from`/`to` (e.g. `59.99999999999995`
      // instead of `60`) when `from`/`to` are collinear with one of the two axes, making that axis's own
      // segment degenerate but not exactly zero-length. A stroked degenerate segment still has *some*
      // direction (pure FP noise), which a round line-join draws as a visible spike jutting out from the
      // shared endpoint. Snapping the bend onto `from`/`to` exactly once it's already numerically on top of
      // it collapses that segment to a true zero-length point, so the renderer draws a clean two-point line.
      if (Math.hypot(bend[0] - from[0], bend[1] - from[1]) < AXIS_EPSILON) bend = from;
      else if (Math.hypot(bend[0] - to[0], bend[1] - to[1]) < AXIS_EPSILON) bend = to;
      paths.push({
        segments: [makeSegment(axisA, from, bend), makeSegment(axisB, bend, to)],
        bend,
        from,
        to,
      });
    }
  }
  return paths;
}

function segmentsOverlap(a: Segment, b: Segment): boolean {
  return sameAxis(a.axis, b.axis) && Math.abs(a.fixed - b.fixed) < AXIS_EPSILON && a.lo < b.hi && b.lo < a.hi;
}

function pathLength(path: OrthogonalPath): number {
  return (path.segments[0].hi - path.segments[0].lo) + (path.segments[1].hi - path.segments[1].lo);
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
function pointInPolygon(p: Pos, polygon: Pos[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const intersects = a.y > p.y !== b.y > p.y && p.x <= ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Whether `p` lies within the maze field — inside (or on the border of) at least one of the
 *  field's own cell polygons (GitHub issue #300: "avoid field exit" priority option). Built from
 *  the actual maze cells rather than a bounding box so a non-rectangular field (a hex/triangle
 *  shape, or a custom field outline) is respected exactly, not approximated by its bounding
 *  rectangle. */
function pointInField(p: Pos, cellPolygons: Pos[][]): boolean {
  for (const polygon of cellPolygons) {
    if (pointInPolygon(p, polygon)) return true;
  }
  return false;
}

/** Sampling step (world units) for walking a candidate's own two segments when checking whether it
 *  stays inside the field (see `candidateLeavesField`) — a quarter tile is fine enough that a
 *  segment can't "tunnel" through a field-boundary notch narrower than a tile between two samples,
 *  while staying cheap (a typical connector leg spans a handful of tiles at most). */
const FIELD_EXIT_SAMPLE_STEP = 10;

/** Whether the point at world position `(x, y)`, offset `halfWidth` to either side perpendicular to
 *  `axis` (its own CCW normal, `(-uy, ux)`), still lands inside the field (GitHub issue #300 follow-
 *  up: the drawn connector line has real visual width, so "leaves the field" must mean the stroked
 *  line's own outer edge crosses the field boundary, not just its centerline). `halfWidth <= 0`
 *  (the pre-follow-up behavior) only checks the centerline itself. */
function lineSpanInField(x: number, y: number, axis: Axis, halfWidth: number, cellPolygons: Pos[][]): boolean {
  if (halfWidth <= 0) return pointInField({ x, y }, cellPolygons);
  const nx = -axis.uy * halfWidth;
  const ny = axis.ux * halfWidth;
  return (
    pointInField({ x: x + nx, y: y + ny }, cellPolygons) && pointInField({ x: x - nx, y: y - ny }, cellPolygons)
  );
}

/** Whether any point along `candidate`'s own two segments (`from`->`bend`, `bend`->`to`) — or
 *  either of its own visual edges, offset `halfWidth` perpendicular to that segment's own axis
 *  (GitHub issue #300 follow-up: the connector draws as a real stroked line, `connectorWidth / 2 +
 *  connectorBorderWidth` wide on each side of its centerline, not an infinitely thin one) — falls
 *  outside every field cell polygon (see `pointInField`). Sampled at `FIELD_EXIT_SAMPLE_STEP`
 *  intervals plus both segment endpoints, since a purely endpoint-only check would miss a bend that
 *  cuts across a concave notch in the field's own outline. `cellPolygons` empty (no field cells
 *  known, e.g. a caller without `nodes` in hand) never flags an exit — nothing to be outside of. */
function candidateLeavesField(candidate: OrthogonalPath, cellPolygons: Pos[][], halfWidth: number): boolean {
  if (cellPolygons.length === 0) return false;
  const points: [number, number][] = [candidate.from, candidate.bend, candidate.to];
  const axes = [candidate.segments[0].axis, candidate.segments[1].axis];
  for (let i = 0; i < 2; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    const axis = axes[i];
    const length = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(1, Math.ceil(length / FIELD_EXIT_SAMPLE_STEP));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = ax + (bx - ax) * t;
      const y = ay + (by - ay) * t;
      if (!lineSpanInField(x, y, axis, halfWidth, cellPolygons)) return true;
    }
  }
  return false;
}

/** Top-priority penalty (GitHub issue #300) for a candidate leaving the field bounds — outranks
 *  every other weight (mid-path collisions, endpoint collisions, length) so a connector prefers any
 *  in-field detour over stepping outside, falling back to an out-of-field path only when every
 *  candidate leaves the field. Large enough that no realistic accumulation of ordinary/endpoint
 *  weights on an in-field candidate could ever outweigh a single field-exit penalty. */
const FIELD_EXIT_WEIGHT = 1_000_000;

/** Whether any of `candidate`'s own two segments (as actual finite line pieces, `from`->`bend` and
 *  `bend`->`to`) passes within `endpointRadius` of `otherPath`'s own `from` or `to` marker —
 *  independent of axis/parallelism (GitHub issue #297 follow-up: a same-axis-only check, as
 *  `segmentsOverlap`-based collision detection is, misses a candidate segment that crosses another
 *  connector's endpoint at an angle instead of running parallel through its corridor — a real case
 *  found in practice: one candidate's leg cut diagonally straight through a marker two axes away
 *  from its own). */
function candidateCutsThroughEndpoint(candidate: OrthogonalPath, otherPath: OrthogonalPath, endpointRadius: number): boolean {
  const candidatePoints: [number, number][] = [candidate.from, candidate.bend, candidate.to];
  const otherEndpoints: [number, number][] = [otherPath.from, otherPath.to];
  for (let i = 0; i < 2; i++) {
    const a = candidatePoints[i];
    const b = candidatePoints[i + 1];
    for (const endpoint of otherEndpoints) {
      if (pointToSegmentDistance(endpoint, a, b) < endpointRadius) return true;
    }
  }
  return false;
}

/** A collision that lands within `endpointRadius` of another connector's own `from`/`to` endpoint
 *  (see `candidateCutsThroughEndpoint`) visually cuts through that
 *  connector's marker, not just its mid-path line — weighted as if it were
 *  `ENDPOINT_COLLISION_WEIGHT` ordinary mid-path collisions (GitHub issue #297 follow-up), so
 *  `bestAgainst` strongly prefers a candidate that avoids running through someone else's endpoint
 *  even at the cost of a couple of ordinary mid-path overlaps elsewhere. */
const ENDPOINT_COLLISION_WEIGHT = 3;

/** Whether any of `candidate`'s own two segments passes within `endpointRadius` of `waypoint`
 *  (a start/finish marker's world position, GitHub issue #300) — same finite-line, clamped
 *  point-to-segment check as `candidateCutsThroughEndpoint`, just against a plain point instead of
 *  another connector's own `from`/`to`. */
function candidateCutsThroughWaypoint(candidate: OrthogonalPath, waypoint: [number, number], endpointRadius: number): boolean {
  const candidatePoints: [number, number][] = [candidate.from, candidate.bend, candidate.to];
  for (let i = 0; i < 2; i++) {
    if (pointToSegmentDistance(waypoint, candidatePoints[i], candidatePoints[i + 1]) < endpointRadius) return true;
  }
  return false;
}

/** Total weighted collision count between `candidate` and every path in `others` — each actual
 *  segment-overlap (see `segmentsOverlap`) counts as 1 (regular mid-path collision), plus a
 *  separate flat `ENDPOINT_COLLISION_WEIGHT` penalty for every `otherPath` whose own endpoint
 *  `candidate` cuts within `endpointRadius` of (see `candidateCutsThroughEndpoint`) — checked
 *  independently of same-axis overlap, since a candidate segment can cross another connector's
 *  endpoint at an angle without ever sharing an axis with any of that connector's own segments.
 *  `waypoints` (GitHub issue #300, always checked regardless of `avoidFieldExit`) adds the same
 *  `ENDPOINT_COLLISION_WEIGHT` penalty per waypoint marker the candidate cuts through (see
 *  `candidateCutsThroughWaypoint`). `cellPolygons` (only checked when `avoidFieldExit` is on) adds
 *  the much larger `FIELD_EXIT_WEIGHT` on top, once, if the candidate leaves the field bounds at
 *  all (see `candidateLeavesField`) — outranking every other weight here. */
function countCollisions(
  candidate: OrthogonalPath,
  others: OrthogonalPath[],
  endpointRadius: number,
  waypoints: [number, number][],
  avoidFieldExit: boolean,
  cellPolygons: Pos[][],
  fieldExitHalfWidth: number,
): number {
  let collisions = 0;
  for (const otherPath of others) {
    for (const otherSeg of otherPath.segments) {
      for (const ownSeg of candidate.segments) {
        if (segmentsOverlap(ownSeg, otherSeg)) {
          collisions += 1;
          break;
        }
      }
    }
    if (endpointRadius > 0 && candidateCutsThroughEndpoint(candidate, otherPath, endpointRadius)) {
      collisions += ENDPOINT_COLLISION_WEIGHT;
    }
  }
  if (endpointRadius > 0) {
    for (const waypoint of waypoints) {
      if (candidateCutsThroughWaypoint(candidate, waypoint, endpointRadius)) collisions += ENDPOINT_COLLISION_WEIGHT;
    }
  }
  if (avoidFieldExit && candidateLeavesField(candidate, cellPolygons, fieldExitHalfWidth)) {
    collisions += FIELD_EXIT_WEIGHT;
  }
  return collisions;
}

/** Picks the best of `ownCandidates` against a fixed set of `others` paths — fewest collisions
 *  (see `countCollisions`) first, ties broken toward the shortest total path length (only
 *  distinguishes candidates with 3+ axes; a square's 2-candidate h-then-v/v-then-h pair always
 *  share the same total `|dx|+|dy|` length, so this tie-break is a no-op there), then toward the
 *  earlier candidate (stable axis order from `axes`, first pairing first) for any remaining tie. */
function bestAgainst(
  ownCandidates: OrthogonalPath[],
  others: OrthogonalPath[],
  endpointRadius: number,
  waypoints: [number, number][],
  avoidFieldExit: boolean,
  cellPolygons: Pos[][],
  fieldExitHalfWidth: number,
): OrthogonalPath {
  let best = ownCandidates[0];
  let bestCollisions = Infinity;
  let bestLength = Infinity;
  for (const candidate of ownCandidates) {
    const collisions = countCollisions(candidate, others, endpointRadius, waypoints, avoidFieldExit, cellPolygons, fieldExitHalfWidth);
    const length = pathLength(candidate);
    if (collisions < bestCollisions || (collisions === bestCollisions && length < bestLength)) {
      bestCollisions = collisions;
      bestLength = length;
      best = candidate;
    }
  }
  return best;
}

/** Refinement passes (GitHub issue #297 follow-up) beyond the first greedy pass — each connector's
 *  own choice from the first pass only ever weighs its *neighbors' full candidate sets* (every
 *  path they *could* pick, not what they actually did), so a connector can end up avoiding a
 *  collision with a neighbor's candidate the neighbor never actually chose, while missing a
 *  cheaper joint rearrangement both would agree to given each other's real pick. Each extra pass
 *  re-evaluates every connector's candidates against the *previous pass's actual choices* (a
 *  snapshot taken at the start of the pass, not updated mid-pass — so a pass's own outcome doesn't
 *  depend on which connector happens to be processed first). Not a global optimum (still greedy,
 *  can still settle into a local optimum no single connector wants to leave alone, or in principle
 *  oscillate — capped at a small fixed count instead of iterating to a fixpoint) but empirically
 *  resolves cases the single first pass leaves on the table. */
const REFINEMENT_PASSES = 2;

/** For every connector (one per `edges` entry with a non-zero-length span), picks its single-bend
 *  orthogonal path (see `candidatePaths`) via one greedy pass (`bestAgainst`, run against every
 *  other connector's full candidate set — not yet resolved to a single choice, so this first pass
 *  doesn't depend on connector order) followed by `REFINEMENT_PASSES` refinement passes (see its
 *  own doc comment). */
function chooseOrthogonalPaths(
  edges: TeleportEdge[],
  axes: Axis[],
  endpointRadius: number,
  waypoints: [number, number][],
  avoidFieldExit: boolean,
  cellPolygons: Pos[][],
  fieldExitHalfWidth: number,
): OrthogonalPath[] {
  const candidates = edges.map((e) => candidatePaths(e.from, e.to, axes));

  let chosen = candidates.map((ownCandidates, i) => {
    const othersCandidates = candidates.filter((_, j) => j !== i).flat();
    return bestAgainst(ownCandidates, othersCandidates, endpointRadius, waypoints, avoidFieldExit, cellPolygons, fieldExitHalfWidth);
  });

  for (let pass = 0; pass < REFINEMENT_PASSES; pass++) {
    const snapshot = chosen;
    chosen = candidates.map((ownCandidates, i) => {
      const othersChosen = snapshot.filter((_, j) => j !== i);
      return bestAgainst(ownCandidates, othersChosen, endpointRadius, waypoints, avoidFieldExit, cellPolygons, fieldExitHalfWidth);
    });
  }

  return chosen;
}

/** Structural cache key for one `route()` call — cheap (O(edge count)) relative to the routing
 *  itself (O(edge count² × axis count²) for the first pass alone), so building it fresh on every
 *  call and comparing by value is not a meaningful cost even at realistic teleport counts (see
 *  GitHub issue #297 follow-up discussion): a caller that rebuilds its own `TeleportEdge[]` array
 *  from scratch every render (a fresh object, same content) still gets a cache hit here, without
 *  requiring that caller to keep a stable array reference itself. */
function cacheKey(
  edges: TeleportEdge[],
  gap: number,
  maxEndpointOffset: number,
  cfg: TessellationConfig | undefined,
  endpointStyle: EndpointMarkerStyle | undefined,
  waypoints: [number, number][],
  avoidFieldExit: boolean,
  fieldCells: [number, number][],
): string {
  const cfgKey = cfg === undefined ? "" : `${cfg.type}:${(cfg as { orientation?: string }).orientation ?? ""}`;
  const endpointStyleKey =
    endpointStyle === undefined
      ? ""
      : `${endpointStyle.markerRadius},${endpointStyle.markerBorderWidth},${endpointStyle.connectorBorderWidth},${endpointStyle.connectorWidth}`;
  let edgesKey = "";
  for (const e of edges) {
    edgesKey += `${e.from[0]},${e.from[1]},${e.to[0]},${e.to[1]},${e.oneWay ? 1 : 0}|`;
  }
  let waypointsKey = "";
  for (const w of waypoints) waypointsKey += `${w[0]},${w[1]}|`;
  let fieldCellsKey = "";
  if (avoidFieldExit) {
    for (const c of fieldCells) fieldCellsKey += `${c[0]},${c[1]}|`;
  }
  return `${gap}|${maxEndpointOffset}|${cfgKey}|${endpointStyleKey}|${edgesKey}|${waypointsKey}|${avoidFieldExit ? 1 : 0}|${fieldCellsKey}`;
}

/** The style knobs `endpointCollisionRadius` derives its radius from — everything that visually
 *  contributes to a teleport marker's own on-screen footprint (GitHub issue #297 follow-up): the
 *  marker's fill radius, its own border, the connector line's border, and half the connector
 *  line's own width (a stroke extends outward from its centerline by half its width). */
export type EndpointMarkerStyle = {
  markerRadius: number;
  markerBorderWidth: number;
  connectorBorderWidth: number;
  connectorWidth: number;
};

/** The effective radius (world-space units) a connector path is considered to "cut through" a
 *  teleport marker within — sum of every style knob that visually extends the marker's footprint
 *  (see `EndpointMarkerStyle`), then padded 25% (GitHub issue #297 follow-up: a purely additive sum
 *  under-reads as "just touching" the marker's own edge, not a visually-clean pass-by; the extra
 *  margin keeps a colliding path from ever looking like it's grazing the marker's exact boundary). */
function endpointCollisionRadius(style: EndpointMarkerStyle): number {
  return (style.markerRadius + style.markerBorderWidth + style.connectorBorderWidth + style.connectorWidth / 2) * 1.25;
}

/** Half the connector line's own drawn width (GitHub issue #300 follow-up) — `connectorWidth / 2 +
 *  connectorBorderWidth`, the distance from the centerline out to the visible outer edge of its
 *  border (see `TeleportRenderer`'s own `connectorWidth + connectorBorderWidth * 2` full-width draw
 *  call). Used by `candidateLeavesField` so "leaves the field" means the *drawn* line's own edge
 *  crosses the field boundary, not just its infinitely-thin centerline. */
function fieldExitLineHalfWidth(style: EndpointMarkerStyle | undefined): number {
  return style === undefined ? 0 : style.connectorWidth / 2 + style.connectorBorderWidth;
}

/** Routes teleport connectors that bend along a single perpendicular corner (GitHub issue #293's
 *  `"orthogonal"` `TeleportConnectorStyle`), avoiding collisions between connectors that share a
 *  corridor (GitHub issue #297: bend axes follow the active tessellation's own face normals, not a
 *  fixed 90°). Owns the whole collision-avoidance computation (candidate generation, greedy
 *  selection + refinement passes, corridor clustering/offset) as a single entity so every caller
 *  goes through the same routing + the same result cache, instead of each `TeleportRenderer`
 *  instance (or a plain module-level function) recomputing from scratch on every `render()` call
 *  even when nothing about the connectors actually changed. */
export class TeleportConnectorRouter {
  private lastKey: string | null = null;
  private lastResult: RoutedConnector[] = [];

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
   *  point (mid-path, no marker to stay inside) is never clamped. `cfg` drives the tessellation's own
   *  candidate bend directions (see `getConnectorAxes`, GitHub issue #297) — square's original 2-axis
   *  (horizontal/vertical) behavior when omitted, for callers that don't have a `TessellationConfig`
   *  in hand. `endpointStyle` (when given) weights a candidate that would cut through another
   *  connector's own marker (see `endpointCollisionRadius`) at `ENDPOINT_COLLISION_WEIGHT`× an
   *  ordinary mid-path collision — omitted entirely (falls back to a zero radius, so no candidate
   *  is ever weighted up, since `candidateCutsThroughEndpoint` is only checked when `endpointRadius >
   *  0`) for callers that don't have marker style in hand. `waypoints` (GitHub issue #300, world
   *  positions of the start/finish markers) are always weighted the same way as another connector's
   *  own endpoint, independent of `avoidFieldExit`. `avoidFieldExit` (GitHub issue #300), when on,
   *  adds a top-priority penalty (outranking every other weight) to any candidate that leaves the
   *  maze field's own cell footprint — `fieldCells` (the maze's own node cell coordinates) is what
   *  that check is built from; omitted/empty with `avoidFieldExit` on is the same as leaving the
   *  toggle off (nothing to be outside of). The check is against the connector's own *drawn* line
   *  width, not an infinitely-thin centerline (GitHub issue #300 follow-up) — `fieldExitLineHalfWidth`
   *  derives that half-width (`connectorWidth / 2 + connectorBorderWidth`) from the same
   *  `endpointStyle` passed in, so a caller that omits `endpointStyle` gets a centerline-only check.
   *
   *  Caches the result against a structural key (`cacheKey`, cheap relative to the routing itself)
   *  of `(edges, gap, maxEndpointOffset, cfg, endpointStyle, waypoints, avoidFieldExit, fieldCells)`
   *  — a repeat call with an equal-by-value input (even a freshly-rebuilt `edges` array, same
   *  content) reuses the previous result rather than re-running collision routing. */
  route(
    edges: TeleportEdge[],
    gap: number,
    maxEndpointOffset = Infinity,
    cfg?: TessellationConfig,
    endpointStyle?: EndpointMarkerStyle,
    waypoints: [number, number][] = [],
    avoidFieldExit = false,
    fieldCells: [number, number][] = [],
  ): RoutedConnector[] {
    const key = cacheKey(edges, gap, maxEndpointOffset, cfg, endpointStyle, waypoints, avoidFieldExit, fieldCells);
    if (key === this.lastKey) return this.lastResult;

    const result = this.computeRoute(edges, gap, maxEndpointOffset, cfg, endpointStyle, waypoints, avoidFieldExit, fieldCells);
    this.lastKey = key;
    this.lastResult = result;
    return result;
  }

  private computeRoute(
    edges: TeleportEdge[],
    gap: number,
    maxEndpointOffset: number,
    cfg: TessellationConfig | undefined,
    endpointStyle: EndpointMarkerStyle | undefined,
    waypoints: [number, number][],
    avoidFieldExit: boolean,
    fieldCells: [number, number][],
  ): RoutedConnector[] {
    const axes = cfg !== undefined ? getConnectorAxes(cfg) : SQUARE_AXES;
    // Computed once per `route()` call (not once per candidate/pass comparison) — see this
    // constructor's own doc comment about the caller-requested "don't recompute every time".
    const endpointRadius = endpointStyle !== undefined ? endpointCollisionRadius(endpointStyle) : 0;
    const cellPolygons: Pos[][] =
      avoidFieldExit && cfg !== undefined
        ? fieldCells.map(([x, y]) => getCellVertices(x, y, cfg)).filter((v): v is Pos[] => v !== null)
        : [];
    const fieldExitHalfWidth = fieldExitLineHalfWidth(endpointStyle);
    const paths = chooseOrthogonalPaths(edges, axes, endpointRadius, waypoints, avoidFieldExit, cellPolygons, fieldExitHalfWidth);

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

    // A point's coordinate nudged perpendicular to `axis` (its own CCW normal, `(-uy, ux)`) by that
    // axis's own connector offset — generalizes the old square-only "h offsets y, v offsets x".
    const nudge = (x: number, y: number, axis: Axis, offset: number): [number, number] =>
      [x - axis.uy * offset, y + axis.ux * offset];

    return paths.map((path, connectorIndex) => {
      const [fx, fy] = edges[connectorIndex].from;
      const [tx, ty] = edges[connectorIndex].to;
      // `entries` was built by `paths.forEach` above, pushing exactly 2 entries (segIndex 0 then 1)
      // per connector in order — so a connector's own entry indices are always `connectorIndex * 2`
      // and `connectorIndex * 2 + 1`, no need to search `entries` for them.
      const offset0 = offsetByEntry.get(connectorIndex * 2) ?? 0;
      const offset1 = offsetByEntry.get(connectorIndex * 2 + 1) ?? 0;
      const axis0 = path.segments[0].axis;
      const axis1 = path.segments[1].axis;
      const clampedOffset0 = Math.max(-maxEndpointOffset, Math.min(maxEndpointOffset, offset0));
      const clampedOffset1 = Math.max(-maxEndpointOffset, Math.min(maxEndpointOffset, offset1));

      // `start` only belongs to segment 0, `end` only to segment 1 — each nudged by its own
      // segment's offset (clamped to stay within the endpoint's own teleport marker). `bend` is
      // shared by both segments, so it's nudged by both in sequence (each along its own segment's
      // axis normal) using the *unclamped* offset — it has no marker to stay inside.
      const [startX, startY] = nudge(fx, fy, axis0, clampedOffset0);
      const [endX, endY] = nudge(tx, ty, axis1, clampedOffset1);
      const [bendX0, bendY0] = nudge(path.bend[0], path.bend[1], axis0, offset0);
      const [bendX, bendY] = nudge(bendX0, bendY0, axis1, offset1);

      return { points: [startX, startY, bendX, bendY, endX, endY] };
    });
  }
}
