import type { TeleportEdge } from "./types";
import type { Axis } from "./teleportConnectorAxes";
import type { Pos } from "../tessellationGeometry";
import {
  AXIS_EPSILON, alongAxis, perpOffset, sameAxis, axisIntersection, pointToSegmentDistance,
  lineSpanInField, FIELD_EXIT_SAMPLE_STEP,
} from "./teleportGeometryUtils";

/** One straight piece of a connector's routed path, running along `axis` (a unit direction, see
 *  `Axis`) at the fixed perpendicular offset `fixed` from the origin along that axis's own normal
 *  — `fixed = point.x * axis.uy - point.y * axis.ux` for any point on the segment's line, the
 *  standard "signed distance of a line from the origin" for a line through the origin with
 *  direction `axis`. `lo`/`hi` are the sorted span *along* `axis` (`point.x * axis.ux + point.y *
 *  axis.uy`). This normalized shape is what lets two segments from different connectors be
 *  compared for overlap regardless of each one's own from/to direction, generalizing the old
 *  square-only `"h"`/`"v"` axis pair to any of `getConnectorAxes`' N axes. */
export type Segment = { axis: Axis; fixed: number; lo: number; hi: number };

/** The two segments of one connector's single-bend orthogonal path, in draw order. `bend` is the
 *  corner point between them; `from`/`to` are its own connector's original endpoints (kept here,
 *  not just the segments, so `countCollisions` can check whether an *other* path's overlap with
 *  `candidate` lands on that other connector's own endpoint — see `ENDPOINT_COLLISION_WEIGHT`). */
export type OrthogonalPath = { segments: [Segment, Segment]; bend: [number, number]; from: [number, number]; to: [number, number] };

function makeSegment(axis: Axis, pa: [number, number], pb: [number, number]): Segment {
  const la = alongAxis(axis, pa[0], pa[1]);
  const lb = alongAxis(axis, pb[0], pb[1]);
  return { axis, fixed: perpOffset(axis, pa[0], pa[1]), lo: Math.min(la, lb), hi: Math.max(la, lb) };
}

/** Every candidate single-bend path between `from` and `to`: one per ordered pair of distinct
 *  (non-parallel) axes from `axes` — first segment along the pair's first axis (from `from` to the
 *  bend), second along its second axis (from the bend to `to`). Generalizes the old square-only
 *  2-candidate (horizontal-then-vertical / vertical-then-horizontal) set to any axis count (hex/
 *  triangle: 3 axes, 6 ordered pairs). Degenerate axis-aligned or coincident `from`/`to` can make
 *  several candidates identical — harmless, `chooseOrthogonalPaths` just picks among them. */
export function candidatePaths(from: [number, number], to: [number, number], axes: Axis[]): OrthogonalPath[] {
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

export function segmentsOverlap(a: Segment, b: Segment): boolean {
  return sameAxis(a.axis, b.axis) && Math.abs(a.fixed - b.fixed) < AXIS_EPSILON && a.lo < b.hi && b.lo < a.hi;
}

export function pathLength(path: OrthogonalPath): number {
  return (path.segments[0].hi - path.segments[0].lo) + (path.segments[1].hi - path.segments[1].lo);
}

/** Whether any point along `candidate`'s own two segments (`from`->`bend`, `bend`->`to`) — or
 *  either of its own visual edges, offset `halfWidth` perpendicular to that segment's own axis
 *  (GitHub issue #300 follow-up: the connector draws as a real stroked line, `connectorWidth / 2 +
 *  connectorGapWidth` wide on each side of its centerline, not an infinitely thin one) — falls
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
export function chooseOrthogonalPaths(
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
