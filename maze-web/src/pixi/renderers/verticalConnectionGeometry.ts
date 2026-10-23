import type { OneWayPattern, VerticalArrowStyle, VerticalConnectionMarker, VerticalConnectionStyle } from "./types";

/** Pure (Pixi-free) geometry of `VerticalConnectionRenderer`'s direction arrows and one-way wall
 *  ticks — shared by the renderer itself, `toolGlyphs.ts`'s glyph copy, and the export warnings
 *  (`exportWarnings.ts`, GitHub issue #744), which need to know where a one-way passage's stop line
 *  lands without drawing anything. */

/** `chevron`/`arrow`'s own stroke thickness range (GitHub issue #347 fifth follow-up) — the arrow
 *  size slider's own extremes, `ARROW_SIZE_MIN`/`ARROW_SIZE_MAX` (matching the panel's own
 *  `SliderRow` `min`/`max` for `<kind>ArrowSize`, `VectorByWallsSettingsPanel.tsx`). Interpolated
 *  linearly against `arrowSizeFraction` in `arrowThickness` below so a thin arrow at the slider's
 *  own minimum doesn't draw with the same fixed 4px stroke a full-size arrow does — `triangle` has
 *  no stroke of its own (a filled shape) and ignores this entirely. */
const ARROW_SIZE_MIN = 0.2;
const ARROW_SIZE_MAX = 1;
const ARROW_THICKNESS_MIN = 2;
const ARROW_THICKNESS_MAX = 4;

/** Linearly interpolates `chevron`/`arrow`'s own stroke thickness between `ARROW_THICKNESS_MIN`/
 *  `MAX` as `arrowSizeFraction` moves across its own slider range (GitHub issue #347 fifth
 *  follow-up: "shrinking the arrow/chevron size should shrink its line thickness too, linearly
 *  between min and max"). `triangle` has no stroke of its own — dispatched separately in
 *  `drawArrowPattern` below, which just ignores this for that pattern. */
export function arrowThickness(arrowSizeFraction: number): number {
  const t = (arrowSizeFraction - ARROW_SIZE_MIN) / (ARROW_SIZE_MAX - ARROW_SIZE_MIN);
  return ARROW_THICKNESS_MIN + t * (ARROW_THICKNESS_MAX - ARROW_THICKNESS_MIN);
}

/** Fraction of `size` (the arrow's own tip reach, see `drawArrowFilled`) at which a one-way
 *  passage's wall tick sits when placed past the arrowhead's own tip (`atTip: true`, GitHub issue
 *  #693, gap follow-up). Past `1` (the tip's own normalized reach, same for every pattern) so the
 *  tick clears the arrowhead instead of cutting across it. */
export const ONE_WAY_WALL_TICK_TIP_DISTANCE_FRACTION = 1.3;

/** Fraction of `size` at which the tick sits past the arrow's own back/base (`atTip: false`).
 *  `triangle`'s own base sits at roughly `-0.54 * size` from the origin (`drawOneWayTriangle`'s
 *  `-0.35 * length` after `drawArrowPattern`'s tip-fraction rescale), closer to the origin than
 *  the tip's `+1 * size` — using the same magnitude as the tip side here would leave a visibly
 *  wider gap on this side than on the tip side, breaking the symmetric-gap read the issue asks
 *  for. Chosen a bit past the triangle's base beyond the matching-gap value (`0.84`) — the shape's
 *  own base reads as flush against the tick at that distance, so nudged outward slightly for a
 *  visible but still tight gap. */
export const ONE_WAY_WALL_TICK_BASE_DISTANCE_FRACTION = 1.05;

/** Half-length of a one-way passage's wall tick, as a fraction of `size` — matches the triangle's
 *  own base half-width (GitHub issue #693, rounded-rect follow-up: the tick reads as "the wall
 *  this end runs into," so its own width should match the triangle's base rather than read as an
 *  arbitrarily short mark). For `size = 1` (this function's own `size` unit, same convention as
 *  `ONE_WAY_WALL_TICK_CORNER_RADIUS_FRACTION` below), the triangle's circumradius is `radius =
 *  (1 / 0.4875) * 0.5` (`patternTipFraction("triangle")` rescale), and an equilateral triangle's
 *  base spans `radius * sqrt(3)` between its two non-tip vertices — half of that is this
 *  fraction. */
const ONE_WAY_WALL_TICK_LENGTH_FRACTION = (1 / 0.4875) * 0.5 * Math.sqrt(3) * 0.5;

/** Corner radius of the wall tick's rounded rect, as a fraction of `size` — matches
 *  `drawOneWayTriangle`'s own `roundPoly` corner radius (GitHub issue #693, rounded-rect
 *  follow-up), so both shapes in the composite read with the same corner style. Derived the same
 *  way as `patternVisualTipFraction`'s inset: for `size = 1` (this function's own `size` unit,
 *  the tick's positioning scale, same convention as `drawOneWayWallTick`'s `size` param), the
 *  triangle is drawn with `drawnSize = size / patternTipFraction("triangle")` (`0.4875`), giving
 *  `radius = drawnSize/2`, `length = 1.5*radius`, and `corner = (length*0.5)*0.3` — `≈0.2308`. */
const ONE_WAY_WALL_TICK_CORNER_RADIUS_FRACTION = 0.3 * 0.5 * 1.5 * (1 / 0.4875) * 0.5;

/** Each pattern's own tip/base visual midpoint, as a fraction of `size` — the tip-reach `size`
 *  `drawArrowPattern` itself is called with (GitHub issue #347 fourth follow-up) — ahead of the
 *  `(cx, cy)` origin. None of the three shared primitives is actually centered on its own input
 *  origin: `drawOneWayChevron`'s tip sits at `+length`, back at `-0.6*length` (`wallUtils.ts`) —
 *  since `patternTipFraction` always normalizes the drawn tip to exactly `+size` (i.e. `length =
 *  size` here), the midpoint `(tip + back) / 2 = 0.2*length` is `+0.2*size`, independent of
 *  `WINGSPAN_FRACTION`; `drawOneWayTriangle` *does* recenter internally (its own `centroidOffset`,
 *  GitHub issue #681 third follow-up: `centroidOffset = 0.65*length - radius = -radius/40`, since
 *  the primitive's internal `radius = drawnSize/2`, `length = 1.5*radius` — and here `drawnSize =
 *  size/0.4875` (`patternTipFraction` for `triangle`), so `radius = size/0.975` and as a fraction
 *  of `size` the offset is `-(1/40)/0.975 = -1/39`); `drawOneWayArrow`'s tail/tip are symmetric
 *  (`-size`/`+size`, offset `0`). Used to compensate a bidirectional pair's own `oy` so both
 *  arrows' visual centers land on the same on-screen row instead of straddling it (mirrors the
 *  old hand-built `drawDirectionArrow`'s own `size*0.25` constant, replaced when this dispatch was
 *  introduced). */
export function patternMidpointOffset(pattern: VerticalArrowStyle): number {
  if (pattern === "triangle") return -1 / 39;
  if (pattern === "chevron") return 0.2;
  return 0;
}

/** Fraction of `size` at which `pattern`'s own tip actually reads visually, used as the "far"
 *  extreme instead of the nominal `+1` when centering a one-way marker's departure-end
 *  arrow+wall-tick pair (GitHub issue #693, round-corner follow-up). `drawOneWayTriangle` rounds
 *  its `roundPoly` corners by `corner = (length*0.5)*0.3` (`wallUtils.ts`) — for an equilateral
 *  triangle every vertex has a 60° interior angle, and rounding a vertex of interior angle `theta`
 *  with radius `r` cuts it back along its own bisector by `r / tan(theta/2)`. At the tip, that
 *  bisector IS the arrow's axis, so the cut shortens the tip's axial reach by a non-negligible
 *  `≈0.4 * size` (`tan(30°) = 1/sqrt(3)`, `insetTip = corner/tan(30°)`, worked out in `size`-
 *  fraction units below) — unlike the two base corners, whose bisectors point off-axis, so
 *  rounding shrinks the base edge's *width* without moving its *axial* position. `chevron`/`arrow`
 *  are plain stroked paths (no `roundPoly`), so their tip is a stroke endpoint (`cap: "round"`
 *  rounds outward, not inward) — their nominal `+1` tip stays exact. */
export function patternVisualTipFraction(pattern: OneWayPattern): number {
  if (pattern === "triangle") {
    const styleSize = 1 / 0.4875; // patternTipFraction("triangle") = 0.4875, for size (pairArrowSize) = 1
    const radius = styleSize * 0.5;
    const length = 1.5 * radius;
    const corner = (length * 0.5) * 0.3;
    const insetTip = corner / Math.tan(Math.PI / 6);
    return 1 - insetTip; // insetTip is already a fraction of size (= 1 here)
  }
  return 1;
}

/** Fraction of `size` (the pattern's own normalized tip reach, see `patternTipFraction`) at which
 *  `pattern`'s own back/base sits, relative to the arrow's origin — used to center a one-way
 *  marker's triangle/chevron/arrow-plus-wall-tick pair in the marker itself (GitHub issue #693,
 *  centering follow-up), the same way `drawVerticalArrows`'s glyph copy already does. `triangle`'s
 *  own base sits at `-0.35 * length` relative to its centroid-offset drawing (`drawOneWayTriangle`,
 *  `length = size / patternTipFraction("triangle")`) — i.e. `-(0.35 / 0.65) * size` once rescaled
 *  to this function's normalized `size` convention; `chevron`/`arrow` both draw their own back
 *  exactly at the origin (offset `0`, see `patternMidpointOffset`'s own doc comment). */
export function patternBaseFraction(pattern: OneWayPattern): number {
  if (pattern === "triangle") return -(0.35 / 0.65);
  return 0;
}


/** Midpoint compensation of a single (non-paired) chevron — a lone chevron reads visually
 *  off-center toward its own back/base with the pair's own `0.2` compensation (GitHub issue #347
 *  sixth follow-up), so it needs a stronger pull toward its tip to look centered on the marker. */
const SINGLE_CHEVRON_MIDPOINT_FRACTION = 0.3;

/** Fraction of the arrow size `VerticalConnectionRenderer` shifts an arrow's origin by so its
 *  visual center lands on the marker — `patternMidpointOffset`, except for a single chevron. */
export function arrowMidpointFraction(pattern: VerticalArrowStyle, paired: boolean): number {
  return !paired && pattern === "chevron" ? SINGLE_CHEVRON_MIDPOINT_FRACTION : patternMidpointOffset(pattern);
}

/** Fraction of the arrow size a one-way marker's arrow origin is shifted by so the arrow+wall-tick
 *  *pair* is centered on the marker, not the arrow alone (GitHub issue #693, centering follow-up).
 *  The pair runs between the tick on one side (past the tip for the arrival end, past the base for
 *  the departure end) and the arrow's own far extreme on the other (its base for the arrival end,
 *  its visual tip — `patternVisualTipFraction`, not the nominal `+1` — for the departure end). */
export function oneWayTickCenteringFraction(pattern: OneWayPattern, arrowFilled: boolean): number {
  return arrowFilled
    ? (patternVisualTipFraction(pattern) - ONE_WAY_WALL_TICK_BASE_DISTANCE_FRACTION) / 2
    : (patternBaseFraction(pattern) + ONE_WAY_WALL_TICK_TIP_DISTANCE_FRACTION) / 2;
}

/** An axis-aligned rounded rect, `radius` already clamped to fit it (`roundRect` semantics). */
export type RoundedRectGeometry = { x: number; y: number; w: number; h: number; radius: number };

/** Geometry of a one-way `VerticalPassage`'s wall tick (GitHub issue #693) — see
 *  `drawOneWayWallTick` for the visual rationale. A filled rounded rect perpendicular to the
 *  arrow: `(dx, dy)` is always `(0, ±1)` for a vertical passage, so the rect is always horizontal.
 *  Its length matches the triangle's base width, its corner radius the triangle's own `roundPoly`
 *  corners, and its thickness is the arrow's stroke thickness thinned 25% (a rounded rect reads
 *  visually heavier than a stroked line at the same thickness). */
export function oneWayWallTickRect(ox: number, oy: number, dx: number, dy: number, size: number, atTip: boolean, thickness: number): RoundedRectGeometry {
  const along = atTip ? 1 : -1;
  const distanceFraction = atTip ? ONE_WAY_WALL_TICK_TIP_DISTANCE_FRACTION : ONE_WAY_WALL_TICK_BASE_DISTANCE_FRACTION;
  const tickCx = ox + dx * size * distanceFraction * along;
  const tickCy = oy + dy * size * distanceFraction * along;
  const w = size * ONE_WAY_WALL_TICK_LENGTH_FRACTION * 2;
  const h = thickness * 0.75;
  const corner = size * ONE_WAY_WALL_TICK_CORNER_RADIUS_FRACTION;
  return { x: tickCx - w / 2, y: tickCy - h / 2, w, h, radius: Math.min(corner, w / 2, h / 2) };
}

/** Geometry of the decorative stairs' direction arrow (GitHub issue #428) — see `drawStairsArrow`.
 *  `(x0, y0)`-`(x1, y1)` is the shaft (bottom-left to top-right), `(hx, hy)` the arrowhead tip,
 *  `(hdx, hdy)` the unit direction toward that tip, `(px, py)` the screen-up perpendicular. */
export type StairsArrowGeometry = {
  x0: number; y0: number; x1: number; y1: number;
  hx: number; hy: number; hdx: number; hdy: number;
  px: number; py: number;
  halfLen: number;
  pointsUp: boolean;
};

export function stairsArrowGeometry(cx: number, cy: number, r: number, size: number, pointsUp: boolean): StairsArrowGeometry {
  // Offset large enough to clear the stairs icon's own top-most riser (not just nudge past its
  // centerline) — GitHub issue #428 fourth follow-up: "arrow currently runs right over the steps,
  // needs to sit clearly above them".
  const offset = r * 1.1;
  const halfLen = r * size;
  // The stairs' own diagonal runs bottom-left to top-right at 45°-equivalent slope `dy/dx = -1`
  // over its own bounding box (`stairsZigzagPoints`'s first/last points) — normalized here since
  // the box itself may be non-square in principle (r is shared for both axes today, kept general).
  const dx = 1 / Math.SQRT2;
  const dy = -1 / Math.SQRT2;
  // Perpendicular unit vector pointing screen-up (negative Y): of the two unit vectors
  // perpendicular to `(dx, dy)` — `(-dy, dx)` and `(dy, -dx)` — only `(dy, -dx)` has a negative Y
  // component here (evaluates to `(-0.707, -0.707)`, up-and-left); the previous `(-dy, dx)` pointed
  // down-right instead, which combined with too-small `offset` was why the arrow used to run right
  // through the steps instead of clearing them (GitHub issue #428 fourth follow-up fix).
  const px = dy;
  const py = -dx;
  const ox = cx + px * offset;
  const oy = cy + py * offset;
  const x0 = ox - dx * halfLen;
  const y0 = oy - dy * halfLen;
  const x1 = ox + dx * halfLen;
  const y1 = oy + dy * halfLen;
  // The head sits at the diagonal's "up" end (`x1, y1`) when `pointsUp`, at its "down" end (`x0, y0`)
  // otherwise — `hx, hy` the tip, `hdx, hdy` the direction pointing away from the line's own body
  // toward that tip, so the back-vector math reads correctly for either end.
  return {
    x0, y0, x1, y1,
    hx: pointsUp ? x1 : x0,
    hy: pointsUp ? y1 : y0,
    hdx: pointsUp ? dx : -dx,
    hdy: pointsUp ? dy : -dy,
    px, py, halfLen, pointsUp,
  };
}

/** A line segment from `(x0, y0)` to `(x1, y1)`. */
export type SegmentGeometry = { x0: number; y0: number; x1: number; y1: number };

/** The decorative stairs arrow's perpendicular wall tick (GitHub issue #693, decorative
 *  follow-up). `atTip` (the arrival end's crossed-out `"->|"`, GitHub issue #428 seventh
 *  follow-up) places it just past the arrowhead, in the direction the head points; otherwise (the
 *  departure end) just past the shaft's own tail. Both use the same gap so the ends read alike. */
export function stairsTickSegment(arrow: StairsArrowGeometry, atTip: boolean): SegmentGeometry {
  const { hdx, hdy, px, py, halfLen } = arrow;
  const tickGap = halfLen * 0.5;
  const tickLen = halfLen * 0.5;
  const baseX = atTip ? arrow.hx : (arrow.pointsUp ? arrow.x0 : arrow.x1);
  const baseY = atTip ? arrow.hy : (arrow.pointsUp ? arrow.y0 : arrow.y1);
  const along = atTip ? 1 : -1;
  const tickCx = baseX + hdx * tickGap * along;
  const tickCy = baseY + hdy * tickGap * along;
  return { x0: tickCx - px * tickLen, y0: tickCy - py * tickLen, x1: tickCx + px * tickLen, y1: tickCy + py * tickLen };
}

/** The drawn footprint of a one-way passage marker's stop line (wall tick), as a convex core plus
 *  an outward rounding radius: a filled rounded rect in the abstract style, a round-capped stroked
 *  segment in the decorative style (`halfWidth` = half its stroke width). */
export type StopLineShape =
  | ({ kind: "roundedRect" } & RoundedRectGeometry)
  | ({ kind: "segment"; halfWidth: number } & SegmentGeometry);

/** Where `VerticalConnectionRenderer` draws `marker`'s stop line under `style`, or `null` when it
 *  draws none: not a one-way `VerticalPassage` end, no direction, or the abstract `"sign"` arrow
 *  style (a +/- glyph has no axis to place a tick against). Mirrors the renderer's own placement. */
export function oneWayStopLineShape(marker: VerticalConnectionMarker, style: VerticalConnectionStyle): StopLineShape | null {
  if (marker.kind !== "vertical_passage" || marker.filled) return null;
  if (marker.direction !== "up" && marker.direction !== "down") return null;
  const [cx, cy] = marker.pos;
  if (style.style === "decorative") {
    const lineStyle = style.decorativeStairsOneWay;
    const arrow = stairsArrowGeometry(cx, cy, lineStyle.size / 2, style.decorativeStairsOneWayArrowSize, marker.direction === "up");
    return { kind: "segment", ...stairsTickSegment(arrow, !marker.arrowFilled), halfWidth: lineStyle.lineWidth / 2 };
  }
  const arrowStyle = style.oneWayArrowStyle;
  if (arrowStyle === "sign") return null;
  const dy = marker.direction === "up" ? -1 : 1;
  const arrowSize = (style.oneWayPassageMarker.size / 2) * style.oneWayArrowSize;
  const oy = cy
    - dy * arrowMidpointFraction(arrowStyle, false) * arrowSize
    - dy * oneWayTickCenteringFraction(arrowStyle, marker.arrowFilled) * arrowSize;
  const rect = oneWayWallTickRect(cx, oy, 0, dy, arrowSize, !marker.arrowFilled, arrowThickness(style.oneWayArrowSize));
  return { kind: "roundedRect", ...rect };
}

/** Axis-aligned box by its corners; may be degenerate (zero width/height). */
type Box = { x0: number; y0: number; x1: number; y1: number };

/** A rounded rect as its convex core (the rect shrunk by its corner radius) plus that radius —
 *  the rounded rect is exactly the set of points within `radius` of the core. */
function roundedRectCore(rect: RoundedRectGeometry): { core: Box; radius: number } {
  const radius = Math.max(0, Math.min(rect.radius, rect.w / 2, rect.h / 2));
  return { core: { x0: rect.x + radius, y0: rect.y + radius, x1: rect.x + rect.w - radius, y1: rect.y + rect.h - radius }, radius };
}

function boxBoxDistance(a: Box, b: Box): number {
  const dx = Math.max(0, a.x0 - b.x1, b.x0 - a.x1);
  const dy = Math.max(0, a.y0 - b.y1, b.y0 - a.y1);
  return Math.hypot(dx, dy);
}

function pointSegmentDistance(px: number, py: number, s: SegmentGeometry): number {
  const vx = s.x1 - s.x0;
  const vy = s.y1 - s.y0;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - s.x0) * vx + (py - s.y0) * vy) / len2));
  return Math.hypot(px - (s.x0 + t * vx), py - (s.y0 + t * vy));
}

/** Liang–Barsky clip: whether segment `s` has any point inside (or on) box `b`. */
function segmentHitsBox(s: SegmentGeometry, b: Box): boolean {
  const dx = s.x1 - s.x0;
  const dy = s.y1 - s.y0;
  let t0 = 0;
  let t1 = 1;
  const clips: [number, number][] = [[-dx, s.x0 - b.x0], [dx, b.x1 - s.x0], [-dy, s.y0 - b.y0], [dy, b.y1 - s.y0]];
  for (const [p, q] of clips) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

function segmentBoxDistance(s: SegmentGeometry, b: Box): number {
  if (segmentHitsBox(s, b)) return 0;
  const point = (x: number, y: number): Box => ({ x0: x, y0: y, x1: x, y1: y });
  return Math.min(
    boxBoxDistance(point(s.x0, s.y0), b),
    boxBoxDistance(point(s.x1, s.y1), b),
    pointSegmentDistance(b.x0, b.y0, s),
    pointSegmentDistance(b.x1, b.y0, s),
    pointSegmentDistance(b.x0, b.y1, s),
    pointSegmentDistance(b.x1, b.y1, s),
  );
}

/** Float slack so shapes that exactly touch never read as overlapping. */
const OVERLAP_EPSILON = 1e-6;

/** Whether a stop line's drawn footprint overlaps the rounded rect `rect` — strictly, so shapes
 *  that only touch along an edge do not count. Exact for rounded corners and round stroke caps:
 *  both shapes are a convex core grown by a radius, so they overlap iff their cores are closer
 *  than the two radii combined. */
export function stopLineOverlapsRoundedRect(shape: StopLineShape, rect: RoundedRectGeometry): boolean {
  const target = roundedRectCore(rect);
  if (shape.kind === "segment") {
    return segmentBoxDistance(shape, target.core) < shape.halfWidth + target.radius - OVERLAP_EPSILON;
  }
  const own = roundedRectCore(shape);
  const radii = own.radius + target.radius;
  if (radii > OVERLAP_EPSILON) return boxBoxDistance(own.core, target.core) < radii - OVERLAP_EPSILON;
  // Sharp-cornered rects: the cores are the rects themselves, so they must share interior area.
  const a = own.core;
  const b = target.core;
  return Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > OVERLAP_EPSILON
    && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > OVERLAP_EPSILON;
}
