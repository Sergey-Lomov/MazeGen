import type { Graphics } from "pixi.js";
import type { MarkerShape } from "./types";

type RegularShape = "triangle" | "square" | "diamond" | "pentagon" | "hexagon";
type Point = [number, number];
type MarkerColor = number | { color: number; alpha?: number };

const offsetPolygonCache = new Map<string, number[]>();

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

function polygonSignedArea(points: number[]): number {
  let area = 0;
  const n = points.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += points[i * 2] * points[j * 2 + 1] - points[j * 2] * points[i * 2 + 1];
  }
  return area / 2;
}

function lineIntersection(a: Point, b: Point, c: Point, d: Point): Point | null {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const cdx = d[0] - c[0];
  const cdy = d[1] - c[1];
  const denominator = abx * cdy - aby * cdx;
  if (Math.abs(denominator) < 1e-8) return null;
  const t = ((c[0] - a[0]) * cdy - (c[1] - a[1]) * cdx) / denominator;
  return [a[0] + abx * t, a[1] + aby * t];
}

type OffsetJoin = "miter" | "bevel" | "round";

/** Returns a closed offset path. Straight output edges are parallel to their source edges and
 * exactly `distance` away. A limited miter becomes a real bevel/round join rather than a clipped
 * vertex, which would make adjacent edges leave the requested offset. */
export function offsetPolygonPath(
  points: number[], distance: number, miterLimit = 4, join: OffsetJoin = "miter",
  roundCorner?: (index: number) => boolean,
): number[] {
  if (distance <= 0 || points.length < 6) return [...points];
  const n = points.length / 2;
  const outwardSign = polygonSignedArea(points) >= 0 ? 1 : -1;
  const at = (i: number): Point => {
    const index = ((i % n) + n) % n;
    return [points[index * 2], points[index * 2 + 1]];
  };
  const offsetLine = (from: Point, to: Point): [Point, Point] => {
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const length = Math.hypot(dx, dy) || 1;
    const nx = outwardSign * dy / length * distance;
    const ny = outwardSign * -dx / length * distance;
    return [[from[0] + nx, from[1] + ny], [to[0] + nx, to[1] + ny]];
  };

  const result: number[] = [];
  const push = (point: Point): void => { result.push(point[0], point[1]); };
  const appendRoundJoin = (vertex: Point, from: Point, to: Point): void => {
    const fromAngle = Math.atan2(from[1] - vertex[1], from[0] - vertex[0]);
    const toAngle = Math.atan2(to[1] - vertex[1], to[0] - vertex[0]);
    let delta = ((toAngle - fromAngle + Math.PI) % (2 * Math.PI)) - Math.PI;
    const outwardX = from[0] + to[0] - 2 * vertex[0];
    const outwardY = from[1] + to[1] - 2 * vertex[1];
    const midpoint = fromAngle + delta / 2;
    if (Math.cos(midpoint) * outwardX + Math.sin(midpoint) * outwardY < 0) delta += delta >= 0 ? -2 * Math.PI : 2 * Math.PI;
    const steps = Math.max(1, Math.ceil(Math.abs(delta) * distance / 2));
    for (let step = 0; step <= steps; step++) {
      const angle = fromAngle + delta * step / steps;
      push([vertex[0] + Math.cos(angle) * distance, vertex[1] + Math.sin(angle) * distance]);
    }
  };
  for (let i = 0; i < n; i++) {
    const prev = at(i - 1);
    const vertex = at(i);
    const next = at(i + 1);
    const previousLine = offsetLine(prev, vertex);
    const nextLine = offsetLine(vertex, next);
    const intersection = lineIntersection(previousLine[0], previousLine[1], nextLine[0], nextLine[1]);
    const point = intersection ?? nextLine[0];
    const dx = point[0] - vertex[0];
    const dy = point[1] - vertex[1];
    const maxMiter = Math.max(distance * miterLimit, distance);
    const length = Math.hypot(dx, dy);
    const useRound = join === "round" && (!roundCorner || roundCorner(i));
    if (useRound) appendRoundJoin(vertex, previousLine[1], nextLine[0]);
    else if (intersection && length <= maxMiter) push(point);
    else { push(previousLine[1]); push(nextLine[0]); }
  }
  return result;
}

/** Compatibility helper for callers/tests that need the ordinary miter/bevel path. */
export function offsetPolygonPoints(points: number[], distance: number, miterLimit = 4): number[] {
  return offsetPolygonPath(points, distance, miterLimit, "miter");
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

const COMPENSATION_REFERENCE_RADIUS = 100;
const compensatedRatioCache = new Map<string, number>();

/** Outer contour of `shape` at circle-equivalent radius `r`: its fill contour offset by `distance`,
 *  with the join `drawOffsetMarkerShape` and the border/underlay draws share. */
function offsetMarkerContour(shape: Exclude<MarkerShape, "circle">, r: number, distance: number, rounded: boolean): number[] {
  return offsetPolygonPath(
    markerPolygonPoints(shape, 0, 0, r), distance, 4,
    rounded ? "round" : "miter",
    shape === "star" ? (i) => i % 2 === 0 : undefined,
  );
}

/** Fill-contour circle-equivalent radius for `shape` such that its *outer* contour (fill offset by
 *  `borderWidth`, same join `drawOffsetMarkerShape` uses) has the same area as a circle's outer
 *  contour `r + borderWidth`. Sharp-cornered shapes gain more border area/reach per `borderWidth`
 *  than a circle, so without this the same `size`/`borderWidth` reads heavier on them (GitHub issue
 *  #683). Equals `r` for `circle` and for `borderWidth <= 0`. Solved by bisection on the actual
 *  offset path area, so every join/shape detail is accounted for. The problem is scale-invariant, so
 *  the solution is cached as a fraction of `r` keyed by `borderWidth / r`. */
export function borderCompensatedRadius(shape: MarkerShape, r: number, borderWidth: number, rounded: boolean): number {
  if (shape === "circle" || borderWidth <= 0 || r <= 0) return r;
  const ratio = borderWidth / r;
  const cacheKey = `${shape}:${ratio}:${rounded ? "round" : "miter"}`;
  let fraction = compensatedRatioCache.get(cacheKey);
  if (fraction === undefined) {
    // Solved at a fixed large reference radius so round-join arcs are finely tessellated (their
    // step count scales with the offset distance) — the result is then a pure fraction of `r`.
    const target = Math.PI * (COMPENSATION_REFERENCE_RADIUS * (1 + ratio)) ** 2;
    const distance = COMPENSATION_REFERENCE_RADIUS * ratio;
    const outerArea = (fillR: number): number => Math.abs(polygonSignedArea(offsetMarkerContour(shape, fillR, distance, rounded)));
    let lo = 0.01 * COMPENSATION_REFERENCE_RADIUS;
    let hi = COMPENSATION_REFERENCE_RADIUS;
    if (outerArea(hi) <= target) {
      fraction = 1;
    } else if (outerArea(lo) >= target) {
      fraction = 0.01;
    } else {
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (outerArea(mid) < target) lo = mid; else hi = mid;
      }
      fraction = (lo + hi) / 2 / COMPENSATION_REFERENCE_RADIUS;
    }
    if (compensatedRatioCache.size >= 512) compensatedRatioCache.delete(compensatedRatioCache.keys().next().value!);
    compensatedRatioCache.set(cacheKey, fraction);
  }
  return r * fraction;
}

function drawOffsetMarkerShape(g: Graphics, shape: MarkerShape, cx: number, cy: number, r: number, distance: number, rounded: boolean): void {
  if (shape === "circle") {
    g.poly(circlePolygonPoints(cx, cy, r + distance), true);
    return;
  }
  // Rounded and sharp contours have different joins; keeping that in the key avoids a sharp
  // contour cached by a gap pass being reused for a rounded border (or vice versa).
  const cacheKey = `${shape}:${r}:${distance}:${rounded ? "round" : "miter"}`;
  let normalized = offsetPolygonCache.get(cacheKey);
  if (!normalized) {
    normalized = offsetMarkerContour(shape, r, distance, rounded);
    if (offsetPolygonCache.size >= 512) offsetPolygonCache.delete(offsetPolygonCache.keys().next().value!);
    offsetPolygonCache.set(cacheKey, normalized);
  }
  const points = normalized.map((value, i) => value + (i % 2 === 0 ? cx : cy));
  g.poly(points, true);
}

/** Draws a framed marker without Pixi's GPU stroke tessellation. The outer contour is a geometric
 * offset of the inner contour, then the inner fill is placed on top; this avoids both Pixi stroke
 * seams (PixiJS v8 issue #9831) and scale-based corner thickening. */
export function drawMarkerWithBorder(
  g: Graphics,
  shape: MarkerShape,
  cx: number,
  cy: number,
  r: number,
  rounded: boolean,
  fillColor: MarkerColor,
  borderColor: MarkerColor,
  borderWidth: number,
): void {
  r = borderCompensatedRadius(shape, r, borderWidth, rounded);
  if (borderWidth > 0) {
    drawOffsetMarkerShape(g, shape, cx, cy, r, borderWidth, rounded);
    g.fill(borderColor);
  }
  drawMarkerShape(g, shape, cx, cy, r, rounded);
  g.fill(fillColor);
}

/* Historical rationale for the underlay offset (the implementation below no longer uses the
 * old stroke-based approach):
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
/** Draws an underlay as a filled geometric offset. `borderWidth` is the border of the marker this
 * underlay sits under (`0` when `baseRadius` is already border-compensated or the marker has no
 * border); it is required so a new call site cannot silently offset from a different fill contour
 * than the one `drawMarkerWithBorder` draws (GitHub issue #683). Straight edges stay parallel; joins are
 * miter-limited and rounded where the marker uses rounded corners, avoiding Pixi stroke seams. */
export function drawMarkerUnderlay(g: Graphics, shape: MarkerShape, cx: number, cy: number, baseRadius: number, rounded: boolean, outset: number, color: number | { color: number; alpha?: number }, borderWidth: number): void {
  // Same fill contour `drawMarkerWithBorder` draws for this marker (GitHub issue #683).
  baseRadius = borderCompensatedRadius(shape, baseRadius, borderWidth, rounded);
  // `{ color, alpha: undefined }` is NOT the same as omitting `alpha` — pixi's `fill`/`stroke`
  // resolve it to `NaN`, not their own `1` default, silently making the whole draw invisible
  // (GitHub issue #552 fourth follow-up). Only include `alpha` in the style object when the caller
  // actually passed one.
  const fillStyle = typeof color === "number" ? { color } : color.alpha === undefined ? { color: color.color } : { color: color.color, alpha: color.alpha };
  drawOffsetMarkerShape(g, shape, cx, cy, baseRadius, Math.max(outset, 0), rounded);
  g.fill(fillStyle);
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

/** Draws a rounded rectangle as one closed path. PixiJS `roundRect()` uses the same
 * fan-based rounded-shape tessellation as `roundPoly()`; at some zooms its antialiased
 * joins can expose a hairline against an underlay. Keeping this path-based also makes
 * framed badges use the same seam-free geometry as the other marker shapes. */
export function drawRoundedRect(g: Graphics, x: number, y: number, width: number, height: number, radius: number): void {
  const r = Math.min(Math.max(radius, 0), Math.min(Math.abs(width), Math.abs(height)) / 2);
  if (width < 0 || height < 0) {
    g.rect(x, y, width, height);
    return;
  }
  if (r === 0) {
    g.rect(x, y, width, height);
    return;
  }
  g.moveTo(x + r, y)
    .lineTo(x + width - r, y)
    .arcTo(x + width, y, x + width, y + r, r)
    .lineTo(x + width, y + height - r)
    .arcTo(x + width, y + height, x + width - r, y + height, r)
    .lineTo(x + r, y + height)
    .arcTo(x, y + height, x, y + height - r, r)
    .lineTo(x, y + r)
    .arcTo(x, y, x + r, y, r)
    .closePath();
}
