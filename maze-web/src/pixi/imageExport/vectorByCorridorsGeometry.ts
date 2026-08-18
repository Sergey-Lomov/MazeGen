import type { Graphics } from "pixi.js";
import type { TeleportEdge, MarkerData } from "../renderers/types";
import type { TeleportGroup } from "../selectors/teleportGroups";
import type { VectorByCorridorsSettings } from "../../store/storeTypes";
import { TILE_SIZE } from "../constants";

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

  const radius = settings.teleportLineSize * TILE_SIZE;
  const seen = new Set<string>();
  const markers: MarkerData[] = [];
  for (const e of teleportEdges) {
    for (const pos of [e.from, e.to]) {
      const key = `${pos[0]},${pos[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const override = overrideByPoint.get(key);
      markers.push({
        pos,
        color: 0,
        radius,
        shape: override?.shape ?? settings.teleportLineShape,
        cornerStyle: settings.teleportLineCornerStyle,
        borderWidth: settings.teleportEdgeBorderWidth,
        gapWidth: settings.teleportEdgeGapWidth,
      });
    }
  }
  return markers;
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
   *  knowing each edge's own ray geometry. */
  bowFrac = 0,
): void {
  const half = width / 2;
  const ldx = to.x - from.x, ldy = to.y - from.y;
  // Normal to the from->to line — used only to pick a consistent sign for each end's own width
  // offset below (the bow direction itself now comes from each face's own perpendicular instead).
  const llen = Math.hypot(ldx, ldy) || 1;
  const lnx = -ldy / llen, lny = ldx / llen;

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
