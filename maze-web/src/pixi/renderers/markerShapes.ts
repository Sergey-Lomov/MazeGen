import type { Graphics } from "pixi.js";
import type { MarkerShape } from "./types";

type RegularShape = "triangle" | "square" | "diamond" | "pentagon" | "hexagon";

/** `sides`/`rotation` for `roundPoly` and `markerPolygonPoints`, shared so a rounded and sharp
 *  draw of the same shape share the exact same vertex layout. */
function regularShapeGeometry(shape: RegularShape): { sides: number; rotation: number } {
  const sides = shape === "square" ? 4 : shape === "diamond" ? 4 : shape === "triangle" ? 3 : shape === "pentagon" ? 5 : 6;
  const rotation = shape === "square" ? Math.PI / 4 : -Math.PI / 2;
  return { sides, rotation };
}

/** A regular n-gon with circumradius R has area `0.5 * n * R^2 * sin(2*pi/n)`. `drawMarkerShape`'s
 *  `r` is meant to read as "same visual size" across shapes, so every shape is area-matched to a
 *  circle of radius `r` (area `pi * r^2`) before its circumradius is computed — without this a
 *  square (smallest area-to-circumradius ratio among the regular polygons) reads visibly smaller
 *  than a hexagon or triangle at the same `r`. Star/cross aren't regular polygons; their area
 *  fractions relative to their own bounding circumradius were computed once by hand (star: 10-gon
 *  alternating outer/0.5x-inner radius; cross: 12-vertex plus-sign, arm width 0.4x) and inverted
 *  the same way. */
function areaMatchedCircumradius(sides: number, r: number): number {
  return r * Math.sqrt((2 * Math.PI) / (sides * Math.sin((2 * Math.PI) / sides)));
}

/** Star area as a function of its outer radius R (10 alternating outer-R/0.5R-inner triangles,
 *  each contributing `0.5 * R * 0.5R * sin(2*pi/10)`): `2.5 * sin(2*pi/10) * R^2`. */
const STAR_AREA_FRACTION = 2.5 * Math.sin((2 * Math.PI) / 10);
/** Cross area as a function of its bounding half-width R (arm width 0.4R): a (2R)^2 square minus
 *  four (0.6R)^2 corner notches = 2.56 * R^2. */
const CROSS_AREA_COEFFICIENT = 2.56;

/** Regular-polygon corner points for every `MarkerShape` that isn't `circle` (`cross`'s corners
 *  come from its own fixed 12-vertex layout below), first vertex pointing up. `star` alternates
 *  outer/inner radius (inner = 0.5x outer) across 10 points. Shared by `WaypointsRenderer`
 *  (start/finish markers) and `TeleportRenderer` (both teleport patterns) — GitHub issue #293
 *  follow-up unified what used to be two separate shape sets/draw functions into this one. */
export function markerPolygonPoints(shape: Exclude<MarkerShape, "circle">, cx: number, cy: number, r: number): number[] {
  if (shape === "cross") {
    const R = r * Math.sqrt(Math.PI / CROSS_AREA_COEFFICIENT);
    const arm = R * 0.4;
    return [
      cx - arm, cy - R,
      cx + arm, cy - R,
      cx + arm, cy - arm,
      cx + R, cy - arm,
      cx + R, cy + arm,
      cx + arm, cy + arm,
      cx + arm, cy + R,
      cx - arm, cy + R,
      cx - arm, cy + arm,
      cx - R, cy + arm,
      cx - R, cy - arm,
      cx - arm, cy - arm,
    ];
  }
  if (shape === "star") {
    const R = r * Math.sqrt(Math.PI / STAR_AREA_FRACTION);
    const points: number[] = [];
    for (let i = 0; i < 10; i++) {
      const angle = -Math.PI / 2 + (i / 10) * Math.PI * 2;
      const radius = i % 2 === 1 ? R * 0.5 : R;
      points.push(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
    }
    return points;
  }
  const { sides, rotation } = regularShapeGeometry(shape);
  const R = areaMatchedCircumradius(sides, r);
  const points: number[] = [];
  for (let i = 0; i < sides; i++) {
    const angle = rotation + (i / sides) * Math.PI * 2;
    points.push(cx + Math.cos(angle) * R, cy + Math.sin(angle) * R);
  }
  return points;
}

/** Circle outline used for filled markers. PixiJS `Graphics.circle()` triangulates a circle as a
 *  centre fan; with antialiasing, a fan edge can become a zoom-dependent radial seam when another
 *  Graphics is visible underneath it. A closed polygon avoids that centre-to-edge seam while
 *  remaining visually circular. The segment count follows Pixi's adaptive tessellation closely
 *  and scales with marker size (GitHub issue #561). */
export function circlePolygonPoints(cx: number, cy: number, r: number): number[] {
  const segments = Math.max(16, Math.ceil(2.3 * Math.sqrt(Math.max(0, 2 * r))) * 8);
  const points: number[] = [];
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    points.push(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
  }
  return points;
}

/** Half the axis-aligned bounding-box side of `shape` drawn at area-matched "radius" `r` (see
 *  `areaMatchedCircumradius`) — used by `TeleportRenderer`'s mixed-cell (two disagreeing links on
 *  the same point) diagonal-split marker, which always draws a plain square clip (not `shape`
 *  itself, see that call site's own comment) but must still match `shape`'s normal drawn size so a
 *  mixed marker doesn't read as a different size than a filled/outline one at the same `r`. */
export function markerBoundingHalfExtent(shape: MarkerShape, r: number): number {
  if (shape === "circle") return r;
  const points = markerPolygonPoints(shape, 0, 0, r);
  let maxAbs = 0;
  for (const v of points) maxAbs = Math.max(maxAbs, Math.abs(v));
  return maxAbs;
}

/** Draws one `MarkerShape` centered at (cx, cy) with area-matched "radius" `r` (see
 *  `areaMatchedCircumradius` — `r` is a circle-equivalent radius, not each shape's own
 *  circumradius, so every shape reads as roughly the same visual size at the same `r`) into `g`'s
 *  current path — caller still calls `.fill()`/`.stroke()`. `rounded` (only ever passed by
 *  `TeleportRenderer` — `WaypointsRenderer` always draws sharp) rounds every corner via
 *  `drawRoundedPolygon`; `circle` has no corners to round. `star`'s reflex (inward-pointing)
 *  corners are excluded from rounding (radius 0 at odd vertex indices — see
 *  `markerPolygonPoints`'s alternating outer/inner layout): they're short enough at typical marker
 *  sizes that a rounded arc there reads as a visible spike/defect, and no radius clamp fully fixes
 *  it. Only rounding the outer points also kept a sharp-star reading noticeably bigger than every
 *  other rounded shape at the same `r` — rounding what can be rounded closes most of that gap. */
export function drawMarkerShape(g: Graphics, shape: MarkerShape, cx: number, cy: number, r: number, rounded = false): void {
  if (shape === "circle") {
    g.poly(circlePolygonPoints(cx, cy, r), true);
    return;
  }
  const points = markerPolygonPoints(shape, cx, cy, r);
  if (rounded) {
    drawRoundedPolygon(g, points, r * 0.25, shape === "star" ? (i) => i % 2 === 0 : undefined);
    return;
  }
  g.poly(points);
}

/** Draws an underlay (gap ring / widen patch / floor-badge ring) that reads as the marker's own
 *  silhouette pushed outward by `outset` pixels — a true outward offset, not a uniform rescale
 *  (GitHub issue #552 second follow-up). Recomputing the polygon at `baseRadius + outset` and
 *  scaling the corner-rounding radius by the same additive amount (tried first, reverted) still
 *  drew the rounded corners as arcs of a *bigger circumradius* centered on the enlarged polygon's
 *  own vertices — on straight edges the outset reads correctly, but at each corner the arc bulges
 *  out further than a true offset would, letting the underlay visibly poke out past the marker
 *  even where the corner itself is rounded away. A true outward offset instead needs the *same*
 *  path as the marker (at its own `baseRadius`), stroked outward: `fill()` covers the polygon
 *  itself, then `stroke({ width: outset, alignment: 0, join: "round" })` grows every edge and
 *  corner uniformly by exactly `outset`, arcs included — pixi's own outer-aligned round join is
 *  the offset operation, not a second hand-rolled rounded-polygon draw. `alignment: 0` is pixi's
 *  *outer* alignment (pixi's own scale: `1` = inner, `0.5` = centered, `0` = outer — the same
 *  convention every other border/gap stroke in this codebase already uses) — the first version of
 *  this function passed `1` by mistake, which strokes entirely *inward* from `baseRadius` instead
 *  of outward, drawing the whole "ring" on top of the already-filled disc with no visible growth at
 *  any `outset` (GitHub issue #552 third follow-up). `width` at `alignment: 0` is the *full* visible
 *  ring thickness, not a diameter split across both sides of the path (confirmed empirically: a
 *  radius-10 circle stroked with `{width: 4, alignment: 0}` bounds out to radius 14, not 12) — every
 *  other `alignment: 0` stroke in this codebase already passes its border/gap width unscaled (see
 *  `WaypointsRenderer`'s own border stroke), so passing `outset * 2` here doubled the *visible*
 *  growth versus every sibling border/gap in the codebase, and versus what callers computing
 *  `outset` as "how far to push the silhouette out" expect (GitHub issue #552 eighth follow-up).
 *  `outset <= 0` draws a plain fill with no stroke (no ring to grow). `join: "round"` regardless of
 *  `rounded` — a sharp underlay's own corners still need a rounded *offset* arc to stay a true
 *  outward offset; the marker's own sharp corners are unaffected since this only affects the
 *  underlay path. */
export function drawMarkerUnderlay(g: Graphics, shape: MarkerShape, cx: number, cy: number, baseRadius: number, rounded: boolean, outset: number, color: number | { color: number; alpha?: number }): void {
  // `{ color, alpha: undefined }` is NOT the same as omitting `alpha` — pixi's `fill`/`stroke`
  // resolve it to `NaN`, not their own `1` default, silently making the whole draw invisible
  // (GitHub issue #552 fourth follow-up). Only include `alpha` in the style object when the caller
  // actually passed one.
  const fillStyle = typeof color === "number" ? { color } : color.alpha === undefined ? { color: color.color } : { color: color.color, alpha: color.alpha };
  drawMarkerShape(g, shape, cx, cy, baseRadius, rounded);
  g.fill(fillStyle);
  if (outset > 0) {
    drawMarkerShape(g, shape, cx, cy, baseRadius, rounded);
    g.stroke({ ...fillStyle, width: outset, alignment: 0, join: "round" });
  }
}

/** Rounds every corner of a closed polygon (flat `[x0, y0, x1, y1, ...]` vertex list) via
 *  `Graphics.arcTo`'s canvas-style per-corner rounding — unlike `roundPoly`, this works for any
 *  polygon (not just regular ones), so it's the one rounding path shared by every `MarkerShape`
 *  including `star`/`cross`, which have no regular-polygon equivalent `roundPoly` could use. Each
 *  corner's radius is capped to half its shorter adjacent edge — `star`'s short outer/inner edges
 *  are shorter than `radius` at typical marker sizes, and an uncapped `arcTo` on both endpoints of
 *  the same short edge produces two arcs that overshoot and cross, leaving a visible spike instead
 *  of a rounded corner. `roundCorner` (optional, only passed for `star`) additionally gates which
 *  vertex indices round at all — its reflex corners stay perfectly sharp regardless of radius. */
/** Per-corner rounding radius for `drawRoundedPolygon`'s vertex `i` of a closed polygon (`at` reads
 *  a flat `[x0, y0, x1, y1, ...]` list, wrapping) — capped to half its shorter adjacent edge (see
 *  `drawRoundedPolygon`'s own doc comment for why) and gated to 0 by `roundCorner` when that vertex
 *  shouldn't round at all (only `star`'s reflex corners use this). Exported standalone (alongside
 *  `cornerTangentPoint`) so the seam-closing math — the exact spot with a previously-fixed subtle
 *  bug (GitHub issue #293 follow-up: `star`'s path didn't close, see that function's own comment) —
 *  is unit-testable without mocking `Graphics`. */
export function polygonCornerRadius(
  points: number[],
  i: number,
  radius: number,
  roundCorner?: (i: number) => boolean,
): number {
  const n = points.length / 2;
  const at = (j: number): [number, number] => {
    const idx = ((j % n) + n) % n;
    return [points[idx * 2], points[idx * 2 + 1]];
  };
  const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  if (roundCorner && !roundCorner(((i % n) + n) % n)) return 0;
  const prevEdge = dist(at(i - 1), at(i));
  const nextEdge = dist(at(i), at(i + 1));
  return Math.min(radius, prevEdge / 2, nextEdge / 2);
}

/** The point where corner `i`'s own rounding arc touches edge `i -> i+1` (its tangent-out point) —
 *  NOT `cornerRadius` distance along the straight edge (tried and rejected earlier, wrong for any
 *  non-right-angle corner): a tangent line from a point at distance `d` to a circle of `radius`
 *  touches it at `d * cos(theta)` along the line, where `theta` is the half-angle between the two
 *  edges meeting at that corner; equivalently the tangent length from the vertex is
 *  `radius / tan(theta)`. Mirrors the trig `Graphics.arcTo` itself uses internally, so
 *  `drawRoundedPolygon`'s `moveTo` (built by calling this for corner 0) lands exactly where the
 *  loop's own last `arcTo` call (corner 0, wrapped) ends — see `drawRoundedPolygon`'s own comment
 *  for the seam bug this fixes. */
export function cornerTangentPoint(
  points: number[],
  i: number,
  radius: number,
  roundCorner?: (i: number) => boolean,
): [number, number] {
  const n = points.length / 2;
  const at = (j: number): [number, number] => {
    const idx = ((j % n) + n) % n;
    return [points[idx * 2], points[idx * 2 + 1]];
  };
  const [vx, vy] = at(i);
  const [px, py] = at(i - 1);
  const [nx, ny] = at(i + 1);
  const toPrev = Math.hypot(px - vx, py - vy);
  const toNext = Math.hypot(nx - vx, ny - vy);
  const cr = polygonCornerRadius(points, i, radius, roundCorner);
  if (cr === 0) return [vx, vy];
  const dot = ((px - vx) * (nx - vx) + (py - vy) * (ny - vy)) / (toPrev * toNext);
  const halfAngle = Math.acos(Math.min(1, Math.max(-1, dot))) / 2;
  const tangentLen = Math.min(cr / Math.tan(halfAngle), toNext);
  return [vx + ((nx - vx) / toNext) * tangentLen, vy + ((ny - vy) / toNext) * tangentLen];
}

/** Rounds every corner of a closed polygon (flat `[x0, y0, x1, y1, ...]` vertex list) via
 *  `Graphics.arcTo`'s canvas-style per-corner rounding — unlike `roundPoly`, this works for any
 *  polygon (not just regular ones), so it's the one rounding path shared by every `MarkerShape`
 *  including `star`/`cross`, which have no regular-polygon equivalent `roundPoly` could use. Each
 *  corner's radius is capped to half its shorter adjacent edge — `star`'s short outer/inner edges
 *  are shorter than `radius` at typical marker sizes, and an uncapped `arcTo` on both endpoints of
 *  the same short edge produces two arcs that overshoot and cross, leaving a visible spike instead
 *  of a rounded corner. `roundCorner` (optional, only passed for `star`) additionally gates which
 *  vertex indices round at all — its reflex corners stay perfectly sharp regardless of radius. */
export function drawRoundedPolygon(g: Graphics, points: number[], radius: number, roundCorner?: (i: number) => boolean): void {
  const n = points.length / 2;
  const at = (i: number): [number, number] => {
    const idx = ((i % n) + n) % n;
    return [points[idx * 2], points[idx * 2 + 1]];
  };
  // Must start exactly where corner 0's own arc will *end* (its tangent-out point on edge 0-1), or
  // `closePath` bridges the gap between that end and `moveTo`'s start with a stray straight segment
  // — visible as an overshoot past the seam on `star` (GitHub issue #293 follow-up). See
  // `cornerTangentPoint`'s own doc comment for the math.
  const [startX, startY] = cornerTangentPoint(points, 0, radius, roundCorner);
  g.moveTo(startX, startY);
  for (let i = 1; i <= n; i++) {
    const [cx, cy] = at(i);
    const [nx, ny] = at(i + 1);
    g.arcTo(cx, cy, nx, ny, polygonCornerRadius(points, i, radius, roundCorner));
  }
  g.closePath();
}
