import type { Graphics } from "pixi.js";
import type { TeleportEdge, MarkerData, VerticalConnectionMarker } from "../renderers/types";
import type { TeleportGroup } from "../selectors/teleportGroups";
import type { VectorByCorridorsSettings } from "../../store/storeTypes";

/** Builds one `MarkerData` per unique teleport point (GitHub issue #313 follow-up: teleport markers
 *  also need their corridor-line widen patch, same `markerWidenPadding` waypoints use — no separate
 *  teleport-specific padding setting) so `drawMarkerWidenPatches` can widen the corridor stroke
 *  under them exactly like it does for start/finish markers. Each point's own shape/corner style
 *  come from its group's `TeleportGroupOverride` when `teleportGroupCustomization` is on and that
 *  group has one, else the base `teleportLineShape`/`teleportLineCornerStyle` — the widen patch must
 *  match what `TeleportRenderer` actually draws there, not always the base shape, so it doesn't leave
 *  a mismatched corner poking out from under a group-customized marker. Only `shape`/`cornerStyle`/
 *  `radius` matter here (widen patches are drawn in the corridor's own color, not the marker's), so
 *  `color`/`borderWidth`/`gapWidth` are omitted (`color: 0` is an unused placeholder — `MarkerData`
 *  requires it, `drawMarkerWidenPatches` never reads it). Exported as a pure function, same
 *  testability rationale as `VectorByWallsRenderer`'s `buildWallStyle`/`buildTeleportLineStyle`/
 *  `buildMarkerStyle` — a point-dedup + per-group-override resolution is worth unit-testing directly
 *  rather than only indirectly through mocked `Graphics` draw calls. `groups` is precomputed by the
 *  caller (`renderAll`) rather than recomputed here via `buildTeleportGroups` — `TeleportRenderer`'s
 *  own `render()` already computes the exact same grouping internally for the same `teleportEdges`,
 *  so a second call here would repeat that union-find work for no reason every render. */
export function buildTeleportWidenMarkers(teleportEdges: TeleportEdge[], settings: VectorByCorridorsSettings, groups: TeleportGroup[]): MarkerData[] {
  const overrideByPoint = new Map<string, VectorByCorridorsSettings["teleportGroupOverrides"][string]>();
  for (const group of groups) {
    const override = settings.teleportGroupOverrides[group.key];
    if (!override) continue;
    for (const [px, py] of group.points) overrideByPoint.set(`${px},${py}`, override);
  }

  // Coordinates `TeleportRenderer` draws as a cross-floor floor-number badge (`drawFloorBadge`) —
  // keyed by coordinate exactly like `computeFloorBadges`, so a coord that is a badge on any edge is
  // a badge everywhere (matching `TeleportRenderer`), independent of which endpoint of which edge
  // this loop happens to reach first. A badge's own marker shape/size for the widen patch is
  // `teleportFloorBadge.shape`/`.size` (GitHub issue #485 follow-up), not `teleportLineShape`/
  // `teleportLineSize` or a group override — so when `markerWidenShape` is `"match_marker"` the
  // patch copies the badge silhouette. `markerWidenShape` `"circle"`/`"square"` still overrides it
  // exactly like an ordinary marker.
  const badgeKeys = new Set<string>();
  for (const e of teleportEdges) {
    if (e.fromFloor !== undefined) badgeKeys.add(`${e.from[0]},${e.from[1]}`);
    if (e.toFloor !== undefined) badgeKeys.add(`${e.to[0]},${e.to[1]}`);
  }

  const radius = settings.teleportLineSize / 2;
  // A badge's own radius follows `teleportFloorBadge.size`, not the edge marker's `teleportLineSize`
  // — `TeleportRenderer` draws it that way (GitHub issue #485), so the widen patch must too.
  const badgeRadius = settings.teleportFloorBadge.size / 2;
  const seen = new Set<string>();
  const markers: MarkerData[] = [];
  for (const e of teleportEdges) {
    for (const pos of [e.from, e.to]) {
      const key = `${pos[0]},${pos[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const isBadge = badgeKeys.has(key);
      const override = overrideByPoint.get(key);
      markers.push({
        pos,
        color: 0,
        radius: isBadge ? badgeRadius : radius,
        shape: isBadge ? settings.teleportFloorBadge.shape : (override?.shape ?? settings.teleportLineShape),
        // `drawFloorBadge` always draws the badge shape rounded, so a `match_marker` patch rounds too.
        cornerStyle: isBadge ? "round" : settings.teleportLineCornerStyle,
        borderWidth: isBadge ? (settings.teleportFloorBadge.borderWidth ?? settings.teleportEdgeBorderWidth) : settings.teleportEdgeBorderWidth,
        gapWidth: settings.teleportEdgeGapWidth,
      });
    }
  }
  return markers;
}

/** Builds one `MarkerData` per `VerticalConnectionMarker` (GitHub issue #348) so
 *  `drawMarkerWidenPatches` can widen the corridor stroke under a vertical-connection marker the
 *  same way it already does for start/finish/teleport markers — without this, a marker with no
 *  border/gap of its own leaves the plain corridor line running unbroken straight through it.
 *  "Vector by corridors" has no decorative pictogram treatment (GitHub issue #348 — unlike "Vector
 *  by walls"), so shape/radius/corner style mirror
 *  `twoWayPassageMarker`/`oneWayPassageMarker`/`elevatorMarker`, using the same resolution
 *  `VerticalConnectionRenderer` itself uses for its abstract-marker draw path. The
 *  `borderWidth`/`gapWidth` fields are also preserved because the visible marker footprint extends
 *  to `radius + borderWidth + gapWidth`; omitting them makes the widen patch too small and can
 *  leave the split-gap background visible around the marker (GitHub issues #551, #561).
 *  Only `shape`/`cornerStyle`/`radius`/`borderWidth`/`gapWidth` matter here because the patch is
 *  drawn in the corridor's own color. `color: 0` is an unused placeholder, same convention as
 *  `buildTeleportWidenMarkers`. */
export function buildVerticalWidenMarkers(markers: VerticalConnectionMarker[], settings: VectorByCorridorsSettings): MarkerData[] {
  return markers.map((marker) => {
    const markerSettings = marker.kind === "elevator" ? settings.elevatorMarker : marker.filled ? settings.twoWayPassageMarker : settings.oneWayPassageMarker;
    return {
      pos: marker.pos,
      color: 0,
      radius: markerSettings.size / 2,
      shape: markerSettings.shape,
      cornerStyle: markerSettings.cornerStyle,
      borderWidth: markerSettings.borderWidth,
      gapWidth: markerSettings.gapWidth,
    };
  });
}

type Pt = { x: number; y: number };

/** The centre-to-centre distance between two adjacent cells, read straight from the corridor
 *  segments (GitHub issue #493) — `buildCorridorSegments` emits exactly one segment per single cell
 *  step, so the shortest full-length segment *is* one grid step. Tessellation-agnostic: `TILE_SIZE`
 *  for square, `TILE_SIZE * sqrt(3)` for hex, the triangle's own step, and so on — the corridor-turn
 *  and junction-fillet radii clamp against this instead of a hard-coded `TILE_SIZE` that is correct
 *  only for a square grid. Segments flagged `v1TouchesSplit` are skipped: they stop at a shared
 *  face's midpoint (about half a step), not the neighbour cell's centre, so they would understate
 *  the step. `fallback` (the square `TILE_SIZE`) is returned when no full segment survives. */
export function corridorCellStep(
  segments: { v0: Pt; v1: Pt; v1TouchesSplit?: boolean }[],
  fallback: number,
): number {
  let min = Infinity;
  for (const s of segments) {
    if (s.v1TouchesSplit) continue;
    const len = Math.hypot(s.v1.x - s.v0.x, s.v1.y - s.v0.y);
    if (len > 1e-3 && len < min) min = len;
  }
  return Number.isFinite(min) ? min : fallback;
}

/** Each face's own perpendicular at `p`, oriented so its dot product with `other - p` is positive
 *  (GitHub issue #314 follow-up) — used both as `drawDiagonalConnectorRibbon`'s own outward `bowFrac`
 *  offset direction (called with `other` = the connector's opposite endpoint) and, called the same
 *  way, as the diagonal gap patch's own inward inset direction (its `from`/`to` *are* the ribbon's
 *  own `from`/`to`, so the same orientation serves both). Pulled out to module scope, not duplicated
 *  inline at each call site, so both stay in sync if the orientation convention ever changes (an
 *  inline copy drifting out of sync with this one, silently bowing/shifting the wrong way, was the
 *  actual cause of two separate sign bugs earlier in this same investigation). */
function faceNormalAt(faceDir: { x: number; y: number }, p: { x: number; y: number }, other: { x: number; y: number }): { x: number; y: number } {
  const flen = Math.hypot(faceDir.x, faceDir.y) || 1;
  let px = -faceDir.y / flen, py = faceDir.x / flen;
  if (px * (other.x - p.x) + py * (other.y - p.y) < 0) { px = -px; py = -py; }
  return { x: px, y: py };
}

/** Computes the diagonal split shape's own background gap patch geometry (GitHub issue #314
 *  follow-up) — pure function, extracted out of `drawSplitPassages`' own diagonal branch so this
 *  math is directly unit-testable rather than only reachable through mocked-`Graphics` draw-call
 *  assertions. `from`/`to`/`fromFaceDir`/`toFaceDir` are the same connector-endpoint/face-direction
 *  pair `drawDiagonalConnectorRibbon` itself takes; `gridInset` is how far the patch's own two short
 *  ends get pulled in from the tile's own face boundary (perpendicular to that face, using the same
 *  `faceNormalAt` orientation the ribbon's own `bowFrac` offset uses — pointing "away from the
 *  opposite endpoint" at `from`/`to` themselves is the same inward direction here, since this
 *  function's `from`/`to` *are* the ribbon's own `from`/`to`); `gapWidth` is the patch's own desired
 *  width before clamping.
 *
 *  `clampedGapWidth` never lets the patch's own short ends cross the point where their own two lines
 *  (through `gapFrom`/`gapTo`, along `fromFaceDir`/`toFaceDir`) intersect — same ray-intersection-cap
 *  idea `bowFrac` already uses on `drawDiagonalConnectorRibbon`'s own long edges, applied here to
 *  width instead of bow distance. Parallel faces (a straight-through 2-face node) never intersect, so
 *  the clamp is a no-op there (`Infinity` half). */
export function computeDiagonalGapPatchGeometry(
  from: { x: number; y: number },
  to: { x: number; y: number },
  fromFaceDir: { x: number; y: number },
  toFaceDir: { x: number; y: number },
  gridInset: number,
  gapWidth: number,
): { gapFrom: { x: number; y: number }; gapTo: { x: number; y: number }; clampedGapWidth: number } {
  const fromInward = faceNormalAt(fromFaceDir, from, to);
  const toInward = faceNormalAt(toFaceDir, to, from);
  const gapFrom = { x: from.x + fromInward.x * gridInset, y: from.y + fromInward.y * gridInset };
  const gapTo = { x: to.x + toInward.x * gridInset, y: to.y + toInward.y * gridInset };

  const flen1 = Math.hypot(fromFaceDir.x, fromFaceDir.y) || 1;
  const flen2 = Math.hypot(toFaceDir.x, toFaceDir.y) || 1;
  const d1x = fromFaceDir.x / flen1, d1y = fromFaceDir.y / flen1;
  const d2x = toFaceDir.x / flen2, d2y = toFaceDir.y / flen2;
  const det = d1x * -d2y - d1y * -d2x;
  let maxHalf = Infinity;
  if (Math.abs(det) >= 1e-9) {
    const dx = gapTo.x - gapFrom.x, dy = gapTo.y - gapFrom.y;
    const t1 = (dx * -d2y - dy * -d2x) / det;
    const t2 = (d1x * dy - d1y * dx) / det;
    maxHalf = Math.min(Math.abs(t1), Math.abs(t2));
  }
  const clampedGapWidth = Math.min(gapWidth, maxHalf * 2);

  return { gapFrom, gapTo, clampedGapWidth };
}

/** Draws a constant-width ribbon shape between two tile faces onto `target` and fills it (GitHub
 *  issue #314 follow-up) — used only by the diagonal split shape's own connector draw in this
 *  renderer, replacing a `stroke()`-based line whose `cap`/`join` geometry couldn't be made to butt
 *  flush against the tile boundary at `from`/`to` (a `square` cap extended past it) without also
 *  needing per-case geometry fixes.
 *
 *  The four corner points are always exactly `from ± fromFaceDir * width/2` and
 *  `to ± toFaceDir * width/2` — cut *along each face's own direction* (`v1 - v0`), the same span an
 *  ordinary corridor's own stroke occupies on that face (`buildCorridorSegments`/
 *  `drawConnectorLine` both center a `width`-wide run there), so they land exactly flush against
 *  the plain corridor's own segment. `bow` never moves these corners.
 *
 *  The two *long* edges (`fromA`-`toA` and `fromB`-`toB`) are drawn as cubic Béziers
 *  (`bezierCurveTo`), not quadratics — a quadratic's single control point can't set the tangent at
 *  both ends independently, so an earlier version's curve left visibly at an angle into the tile
 *  instead of continuing straight out of the plain corridor's own segment (GitHub issue #314
 *  follow-up: the "kink at the seam" bug). A cubic's own two control points are placed at
 *  `fromA + faceNormalAt(from) * bow` and `toA + faceNormalAt(to) * bow` — offset perpendicular to
 *  *that end's own face*, not the `from`→`to` line — so the curve's tangent at each end is exactly
 *  the face's own perpendicular, continuing the ordinary corridor's own straight run into the
 *  ribbon with no kink. `faceNormalAt` is oriented toward the opposite end of the connector, so
 *  both long edges bow the same direction (into the tile) for a positive `bow`. */
export function drawDiagonalConnectorRibbon(
  target: Graphics,
  from: { x: number; y: number },
  to: { x: number; y: number },
  fromFaceDir: { x: number; y: number },
  toFaceDir: { x: number; y: number },
  width: number,
  color: number,
  /** 0..1 fraction of each long edge's own max bow (GitHub issue #314 follow-up) — not an absolute
   *  pixel distance. `bowFrac === 1` puts each edge's two control points exactly at the
   *  intersection of their own two rays (`p ± faceNormal * t`), never past it — see this
   *  function's own doc comment for why an absolute distance can't be capped this way without
   *  knowing each edge's own ray geometry. Ignored entirely when `sharp` is true — see below. */
  bowFrac = 0,
  /** The corridor's own `settings.join === "miter"` style (GitHub issue #443 follow-up), not
   *  derived from `bowFrac` — a sharp/miter corridor style should never draw this ribbon's bowed
   *  curve (visually inconsistent next to the rest of a sharp-style corridor network) regardless of
   *  what `bowFrac` is set to, and `bowFrac === 0`'s old "straight" fallback (offset along each
   *  face's own direction independently) isn't actually straight either — `fromFaceDir`/
   *  `toFaceDir` aren't parallel to the `from`→`to` line, so that quad pinches into a bowtie/
   *  trapezoid shape in the middle instead of a constant-width band. When `sharp` is true, draws a
   *  real constant-width rectangle along `from`→`to` instead, with a miter wedge at each end closing
   *  the gap against the ordinary corridor perpendicular to that end's face — the same two-ray miter construction
   *  `computeMiterJunctionPatch` uses for a T-junction, applied here to the one corner each end
   *  turns through (corridor axis to face axis). */
  sharp = false,
): void {
  const half = width / 2;
  const ldx = to.x - from.x, ldy = to.y - from.y;
  // Normal to the from->to line — used only to pick a consistent sign for each end's own width
  // offset below (the bow direction itself now comes from each face's own perpendicular instead).
  const llen = Math.hypot(ldx, ldy) || 1;
  const lnx = -ldy / llen, lny = ldx / llen;

  if (sharp) {
    drawSharpDiagonalConnectorRibbon(target, from, to, fromFaceDir, toFaceDir, width, color);
    return;
  }

  const alongEnd = (p: { x: number; y: number }, dir: { x: number; y: number }): [{ x: number; y: number }, { x: number; y: number }] => {
    const len = Math.hypot(dir.x, dir.y) || 1;
    let ux = dir.x / len, uy = dir.y / len;
    // Orient this face's own direction so "+" points to the same side of the from->to line as
    // the line's own normal — makes the sign comparable between `from`'s and `to`'s independently
    // stored face directions.
    if (ux * lnx + uy * lny < 0) { ux = -ux; uy = -uy; }
    return [{ x: p.x + ux * half, y: p.y + uy * half }, { x: p.x - ux * half, y: p.y - uy * half }];
  };
  const [fromA, fromB] = alongEnd(from, fromFaceDir);
  const [toA, toB] = alongEnd(to, toFaceDir);

  target.moveTo(fromA.x, fromA.y);
  if (bowFrac === 0) {
    target.lineTo(toA.x, toA.y).lineTo(toB.x, toB.y).lineTo(fromB.x, fromB.y);
  } else {
    // A positive `bowFrac` always bows outward, away from the tile's own center, for both `from`
    // and `to` — the control-point offset direction, distinct from `fromFaceDir`/`toFaceDir`
    // themselves (which run *along* the face). Both nodes of a diagonal point independently call
    // this with their own `bowFrac`, always positive, so their two ribbons both bow outward instead
    // of one bowing in and the other out (GitHub issue #314 follow-up).
    const fromNormal = faceNormalAt(fromFaceDir, from, to);
    const toNormal = faceNormalAt(toFaceDir, to, from);

    // Each long edge's own two control points ride along their own two rays — `p1 + t1*n1` from
    // one endpoint, `p2 + t2*n2` from the other — toward the ray intersection, never past it
    // (GitHub issue #314 follow-up: `bowFrac` is a 0..1 fraction of *that* distance, not a raw
    // pixel offset, so it can never overshoot regardless of `n1`'s/`n2`'s own angle to each other).
    // Solving `p1 + t1*n1 = p2 + t2*n2` for `t1`, `t2` via Cramer's rule; parallel rays (det ~ 0,
    // e.g. a straight-through 2-face node) fall back to the edge's own full length as the cap, so
    // `bowFrac` still behaves as a plain distance scale in that degenerate case.
    const rayIntersectionDistances = (
      p1: { x: number; y: number }, n1: { x: number; y: number },
      p2: { x: number; y: number }, n2: { x: number; y: number },
    ): [number, number] => {
      const det = n1.x * -n2.y - n1.y * -n2.x;
      if (Math.abs(det) < 1e-9) {
        const fallback = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        return [fallback, fallback];
      }
      const dx = p2.x - p1.x, dy = p2.y - p1.y;
      const t1 = (dx * -n2.y - dy * -n2.x) / det;
      const t2 = (n1.x * dy - n1.y * dx) / det;
      return [Math.max(0, t1), Math.max(0, t2)];
    };

    const [distFromA, distToA] = rayIntersectionDistances(fromA, fromNormal, toA, toNormal);
    const [distToB, distFromB] = rayIntersectionDistances(toB, toNormal, fromB, fromNormal);

    const ctrl1A = { x: fromA.x + fromNormal.x * distFromA * bowFrac, y: fromA.y + fromNormal.y * distFromA * bowFrac };
    const ctrl2A = { x: toA.x + toNormal.x * distToA * bowFrac, y: toA.y + toNormal.y * distToA * bowFrac };
    const ctrl1B = { x: toB.x + toNormal.x * distToB * bowFrac, y: toB.y + toNormal.y * distToB * bowFrac };
    const ctrl2B = { x: fromB.x + fromNormal.x * distFromB * bowFrac, y: fromB.y + fromNormal.y * distFromB * bowFrac };

    target
      .bezierCurveTo(ctrl1A.x, ctrl1A.y, ctrl2A.x, ctrl2A.y, toA.x, toA.y)
      .lineTo(toB.x, toB.y)
      .bezierCurveTo(ctrl1B.x, ctrl1B.y, ctrl2B.x, ctrl2B.y, fromB.x, fromB.y);
  }
  target.closePath().fill(color);
}

/** The `sharp: true` path of `drawDiagonalConnectorRibbon` (GitHub issue #443 follow-up) — a real
 *  constant-width band along `from`→`to` (unlike the bowed version's own `fromFaceDir`/`toFaceDir`-
 *  offset ends, which aren't parallel to that line and so pinch the band's width in the middle),
 *  with a miter wedge at each end closing the gap between the band's own straight edge and that
 *  end's own face-aligned stub — the same short flush-cut segment `alongEnd` in the bowed path
 *  produces, kept here so the ribbon still butts flush against the plain corridor's own segment at
 *  the tile boundary.
 *
 *  Built from two filled pieces rather than one polygon: the band itself (a plain rectangle, `from
 *  ± perp*half` to `to ± perp*half`), plus one miter wedge per end via `computeMiterJunctionPatch`
 *  with two rays — the band's own axis (pointing outward, away from the far end) and the inward
 *  normal of that end's face (the continuation of the ordinary corridor beyond its butt cut) —
 *  reusing the exact same two-ray miter construction a T-junction uses, just for one corner instead
 *  of an N-way fan. */
function drawSharpDiagonalConnectorRibbon(
  target: Graphics,
  from: { x: number; y: number },
  to: { x: number; y: number },
  fromFaceDir: { x: number; y: number },
  toFaceDir: { x: number; y: number },
  width: number,
  color: number,
): void {
  const half = width / 2;
  const ldx = to.x - from.x, ldy = to.y - from.y;
  const llen = Math.hypot(ldx, ldy) || 1;
  const ux = ldx / llen, uy = ldy / llen;
  const pnx = -uy * half, pny = ux * half;

  target
    .moveTo(from.x + pnx, from.y + pny)
    .lineTo(to.x + pnx, to.y + pny)
    .lineTo(to.x - pnx, to.y - pny)
    .lineTo(from.x - pnx, from.y - pny)
    .closePath()
    .fill(color);

  // `fromFaceDir`/`toFaceDir` run *along* the tile face, while the ordinary corridor meeting that
  // face runs perpendicular to it. `JunctionRay.dir` is the continuation beyond a butt-cut end, so
  // the plain corridor's continuation into the split tile is the inward face normal. Passing the
  // face tangent itself here rotates both of that ray's offset edges by 90 degrees, producing a
  // displaced, incorrectly-sized miter patch at the split/plain-corridor seam.
  for (const [origin, corridorOutward, corridorInward] of [
    [from, { x: -ux, y: -uy }, faceNormalAt(fromFaceDir, from, to)],
    [to, { x: ux, y: uy }, faceNormalAt(toFaceDir, to, from)],
  ] as const) {
    // `adjacentRayWedge` constructs the corner on the side toward its ray directions. At this
    // two-body seam the vectors above describe the continuations beyond the two butt cuts, while
    // the visible outer corner lies on the opposite side of their shared origin. Reverse both
    // together: this rotates the patch 180 degrees without changing its angle, size, or shape.
    const wedge = computeTwoRayOuterWedge(
      { dir: { x: -corridorOutward.x, y: -corridorOutward.y }, width },
      { dir: { x: -corridorInward.x, y: -corridorInward.y }, width },
    );
    if (!wedge) continue;
    const pts = wedge.points;
    target.moveTo(origin.x + pts[0].x, origin.y + pts[0].y);
    for (let i = 1; i < pts.length; i++) target.lineTo(origin.x + pts[i].x, origin.y + pts[i].y);
    target.closePath().fill(color);
  }
}

/** The single outer-corner miter wedge between two rays sharing an origin (GitHub issue #443
 *  follow-up) — a thin wrapper around `adjacentRayWedge` (the same construction
 *  `computeMiterJunctionPatch` uses per neighbor pair, verified correct on ordinary T-junctions).
 *  Order-independent in `rayA`/`rayB`: which ray is "first" doesn't come from an `atan2` sort (that
 *  broke down at the ±180° branch cut, where two rays 20° apart can land on opposite sides of the
 *  cut and sort as if 340° apart) but directly from the sign of `cross(a.dir, b.dir)` — the two
 *  offset edges facing each other are always `a`'s own edge on `b`'s side and `b`'s own edge on
 *  `a`'s side, regardless of which one was passed first.
 *
 *  Unlike an N-ray junction (where *every* adjacent pair needs its own wedge), a bare 2-ray corner
 *  only ever needs this one wedge: the reflex (>180°) side between the same two rays is already
 *  covered by the two rays' own bodies overlapping there, so a second wedge for that side would
 *  double up a corner that isn't actually open. */
function computeTwoRayOuterWedge(rayA: JunctionRay, rayB: JunctionRay): JunctionWedge | null {
  const a = rayEdges(rayA.dir, rayA.width);
  const b = rayEdges(rayB.dir, rayB.width);
  const cross = a.ux * b.uy - a.uy * b.ux; // > 0: b is CCW from a
  return cross >= 0
    ? adjacentRayWedge(a, rayA.width, b, rayB.width, 4)
    : adjacentRayWedge(b, rayB.width, a, rayA.width, 4);
}

/** One line converging on a junction point, for `computeMiterJunctionPatch` — `dir` points *away*
 *  from the junction (the direction the line runs out to its own far end), `width` is that line's
 *  own stroke width. */
export type JunctionRay = { dir: { x: number; y: number }; width: number };

/** One filled wedge that closes the gap between two angularly-adjacent rays at a junction — see
 *  `computeMiterJunctionPatch`. `points` is a quad `[edgeA, corner, edgeB, junctionOrigin]` for a
 *  genuine miter corner (the junction point itself, i.e. `(0, 0)` in the same local space `rays`
 *  was given in, closes the sliver between the two offset edges and each ray's own `butt` cut), or
 *  a triangle `[edgeA, junctionOrigin, edgeB]` as a bevel fallback past the miter limit. */
export type JunctionWedge = { points: { x: number; y: number }[] };

/** Builds one filled wedge per angularly-*adjacent* pair of rays converging on a junction point
 *  (GitHub issue #443 follow-up), closing the gap a `butt`-capped junction of 2+ lines otherwise
 *  leaves between them — every line drawn on this canvas is its own independent `stroke()` call
 *  (see `VectorByCorridorsRenderer`'s own doc comments on why: separate calls never share a Pixi
 *  `join` even at a shared vertex), so each line's own `butt` cut runs exactly perpendicular to
 *  *that* line alone; at any junction where the lines don't all meet at a clean 180°/90° grid
 *  angle, those independent perpendicular cuts leave visible triangular gaps between neighboring
 *  lines instead of a clean miter corner.
 *
 *  Deliberately builds one independent wedge per *pair* of neighbors rather than a single N-gon
 *  through every ray at once: a shared N-gon's own far corners (from an acute pair elsewhere on
 *  the same junction) can poke out past *other* rays' own bodies, reading as a stray spike instead
 *  of a patch — the same junction a real path would only ever draw as a sequence of independent
 *  two-segment joins, never one N-way polygon. Each wedge here is exactly that: a two-ray miter,
 *  same as an ordinary line turning a corner.
 *
 *  For each pair of angularly-adjacent rays (sorted around the junction by `atan2`, wrapping), the
 *  two edges facing each other — ray i's own `right` edge and ray i+1's own `left` edge, each
 *  offset `width/2` perpendicular to that ray's own direction — are extended as infinite lines and
 *  intersected; that intersection is the miter corner between them, exactly the same construction
 *  a real stroke `join` computes for two adjacent segments of one path.
 *
 *  A pair closer than ~180° apart (nearly a straight continuation of one another, not a genuine
 *  corner — the "through" direction at a T-junction) produces no meaningful corner at all: the
 *  lines already abut with no gap there, so it's skipped entirely rather than patched. A pair
 *  whose miter corner lands past `maxMiterRatio * half-width` (default ratio `4`, same default
 *  Pixi's `Graphics` stroke uses for `miterLimit`) falls back to a bevel quad through both edges'
 *  own near/far offset points instead of an arbitrarily far spike.
 *
 *  Pure geometry, no `Graphics` dependency, so a caller on a fixed tessellation (square/hex/triangle
 *  tiles only ever produce a small fixed set of distinct ray-angle patterns) can memoize the result
 *  by a rounded-angle+width cache key instead of recomputing this per split point per render. */
export function computeMiterJunctionPatch(rays: JunctionRay[], maxMiterRatio = 4): JunctionWedge[] {
  if (rays.length < 2) return [];

  const sorted = [...rays].sort((a, b) => Math.atan2(a.dir.y, a.dir.x) - Math.atan2(b.dir.y, b.dir.x));

  // Each ray's own two offset edges — `left`/`right` relative to the ray's own outward direction. A
  // wedge between ray i and ray i+1 always uses ray i's own `right` edge (the side facing ray i+1)
  // and ray i+1's own `left` edge (the side facing ray i) — the two edges bounding the gap between
  // them, regardless of which screen-space convention "left"/"right" visually correspond to (the
  // pairing is internally consistent with the `atan2` sort either way).
  const edges = sorted.map((r) => rayEdges(r.dir, r.width));

  const n = sorted.length;
  const wedges: JunctionWedge[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const wedge = adjacentRayWedge(edges[i], sorted[i].width, edges[j], sorted[j].width, maxMiterRatio);
    if (wedge) wedges.push(wedge);
  }
  return wedges;
}

/** Selects the junction wedge lying furthest toward `inward`, used where the opposite wedge is
 * already covered by overlapping strokes and would only protrude outside the split tile. */
export function selectInwardJunctionWedge(
  rays: JunctionRay[],
  inward: { x: number; y: number },
): JunctionWedge | null {
  let selected: JunctionWedge | null = null;
  let selectedScore = -Infinity;
  for (const wedge of computeMiterJunctionPatch(rays)) {
    const sum = wedge.points.reduce(
      (acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }),
      { x: 0, y: 0 },
    );
    const score = sum.x * inward.x + sum.y * inward.y;
    if (score > selectedScore) {
      selected = wedge;
      selectedScore = score;
    }
  }
  return selected;
}

/** One CCW-adjacent pair's own wedge, factored out of `computeMiterJunctionPatch`'s loop
 *  (GitHub issue #443 follow-up) so `computeTwoRayOuterWedge` — the diagonal split connector's own
 *  2-ray corner — can reuse the exact same edge/corner construction verified correct on ordinary
 *  T-junctions, instead of a separately-derived (and, in practice, sign-buggy) copy. `a`/`b` must
 *  already be `edges[i]`/`edges[j]` for a CCW-adjacent pair `i`, `i+1` (i.e. `b` is the *next* ray
 *  going counter-clockwise from `a`, not just "the other ray") — the `right`/`left` edge choice
 *  below only bounds the correct (convex, gap-side) corner for that specific adjacency direction. */
function adjacentRayWedge(
  a: { ux: number; uy: number; right: { x: number; y: number }; left: { x: number; y: number } },
  aWidth: number,
  b: { ux: number; uy: number; right: { x: number; y: number }; left: { x: number; y: number } },
  bWidth: number,
  maxMiterRatio: number,
): JunctionWedge | null {
  // Angle this pair turns through, from a's outward direction to b's — near-180° means the two rays
  // run almost straight through one another (the T-junction's own "through" pair), which already
  // abuts with no gap: skip, no wedge needed.
  const cos = a.ux * b.ux + a.uy * b.uy;
  if (cos < -1 + 1e-4) return null;

  const aEdgeOrigin = a.right;
  const bEdgeOrigin = b.left;
  const miterLimit = (Math.max(aWidth, bWidth) / 2) * maxMiterRatio;
  const origin = { x: 0, y: 0 }; // the junction point itself, in the same local space the rays were given in

  const lineIntersect = (
    p1: { x: number; y: number }, d1: { x: number; y: number },
    p2: { x: number; y: number }, d2: { x: number; y: number },
  ): { x: number; y: number } | null => {
    const det = d1.x * -d2.y - d1.y * -d2.x;
    if (Math.abs(det) < 1e-9) return null;
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const t = (dx * -d2.y - dy * -d2.x) / det;
    return { x: p1.x + d1.x * t, y: p1.y + d1.y * t };
  };

  const hit = lineIntersect(aEdgeOrigin, { x: a.ux, y: a.uy }, bEdgeOrigin, { x: b.ux, y: b.uy });
  if (hit && Math.hypot(hit.x - aEdgeOrigin.x, hit.y - aEdgeOrigin.y) <= miterLimit) {
    // Quad through both edge points, the miter corner, and the junction point itself — the corner
    // alone (a bare triangle `[edgeA, corner, edgeB]`) only closes the gap *outside* the two lines'
    // own offset edges, leaving the sliver between those edges and each line's own `butt` cut
    // (which runs through the junction point) still open.
    return { points: [aEdgeOrigin, hit, bEdgeOrigin, origin] };
  }
  // Miter corner past the limit (or the two edges never meet, near-parallel) — fall back to a bevel
  // triangle through the junction point itself instead of an arbitrarily far spike, same bevel
  // fallback a real stroke's `miterLimit` overflow uses.
  return { points: [aEdgeOrigin, origin, bEdgeOrigin] };
}

/** Each ray's own two offset edges (perpendicular to `dir`, ±`width/2`), as a point + normalized
 *  direction — shared construction between `computeMiterJunctionPatch` and
 *  `computeTwoRayOuterWedge`. */
function rayEdges(dir: { x: number; y: number }, width: number) {
  const len = Math.hypot(dir.x, dir.y) || 1;
  const ux = dir.x / len, uy = dir.y / len;
  const nx = -uy, ny = ux; // left normal (+90° rotation of the outward direction)
  const half = width / 2;
  return {
    ux, uy,
    right: { x: -nx * half, y: -ny * half },
    left: { x: nx * half, y: ny * half },
  };
}
