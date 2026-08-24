import { Container, Graphics, Text } from "pixi.js";
import type { TextStyleFontWeight } from "pixi.js";
import type { VerticalConnectionMarker, MarkerShape, TeleportCornerStyle, OneWayPattern, ElevatorBadgeFontWeight } from "./types";
import type { ElevatorBadgeSettings } from "../../store/imageExportTypes";
import { drawMarkerShape } from "./markerShapes";
import { drawOneWayArrow, drawOneWayTriangle, drawOneWayChevron } from "./wallUtils";
import { TILE_SIZE } from "../constants";
import { navigateToFloor } from "./floorNavigation";
import { computeElevatorBadgePositions, formatElevatorBadgeLabel } from "./elevatorBadgeLayout";
import { canvas } from "../colorTokens";

/** Same field shape as `MarkerSettings` (`storeTypes.ts`) plus `gapColor`, by design — kept as its
 *  own type since this lower-level renderer module must not depend on the store layer, same
 *  rationale as `mazeSelectors.ts`'s own `MarkerStyle`. `gapColor` mirrors the caller's own floor
 *  color, same convention every other marker's gap ring in this codebase uses (never the marker's
 *  own `fillColor`). */
export type VerticalMarkerStyle = {
  shape: MarkerShape;
  cornerStyle: TeleportCornerStyle;
  fillColor: number;
  borderColor: number;
  borderWidth: number;
  gapWidth: number;
  gapColor: number;
  size: number;
};

/** Same field shape as `DecorativeLineStyle` (`imageExportTypes.ts`), kept as its own type for the
 *  same "no store-layer dependency" reason as `VerticalMarkerStyle` (GitHub issue #428). A
 *  decorative pictogram's stroke — no fill/border/gap/shape concept, unlike a marker. */
export type VerticalDecorativeLineStyle = {
  lineColor: number;
  lineWidth: number;
  size: number;
};

/** Style knobs for `VerticalConnectionRenderer.render` — see `VerticalSettingsFields`'s own doc
 *  comment (`storeTypes.ts`, GitHub issue #347) for the settings this is built from. Three
 *  independent marker/arrow styles (GitHub issue #347 three-section follow-up), by how a marker
 *  actually reads on the map: `twoWayPassageMarker` for a two-way `VerticalPassage`
 *  (`marker.filled === true`), `oneWayPassageMarker` for a one-way `VerticalPassage`
 *  (`marker.filled === false`, both ends), `elevatorMarker` for every `Elevator` (always two-way by
 *  construction, but its own separate section/look). `"decorative"` (GitHub issue #428) draws
 *  `decorativeStairsTwoWay`/`decorativeStairsOneWay`/`decorativeElevator` instead — a separate,
 *  line-only style surface (see `VerticalDecorativeLineStyle`), replacing the marker-shaped fields
 *  above for that style only. */
export type VerticalConnectionStyle = {
  style: "abstract" | "decorative";
  twoWayPassageMarker: VerticalMarkerStyle;
  oneWayPassageMarker: VerticalMarkerStyle;
  elevatorMarker: VerticalMarkerStyle;
  twoWayArrowColor: number;
  /** Direction-arrow size, as a fraction of the marker's own radius (0-1). */
  twoWayArrowSize: number;
  twoWayArrowStyle: OneWayPattern;
  twoWayArrowCornerStyle: "round" | "miter";
  oneWayArrowColor: number;
  oneWayArrowSize: number;
  oneWayArrowStyle: OneWayPattern;
  oneWayArrowCornerStyle: "round" | "miter";
  /** One-way passage marker colors, "primary"/"secondary" (GitHub issue #347 fifth follow-up,
   *  simplified from the fourth follow-up's separate `oneWayEntryColor`/`oneWayExitColor`, which
   *  always meant the same accent anyway): the **primary** color is `oneWayPassageMarker.fillColor`
   *  itself — the arrival end's ordinary fill, same field every other marker's own fill uses, no
   *  dedicated field of its own. The **secondary** color (`oneWayAccentColor`, below) is one shared
   *  accent driving both the arrival end's border and the departure end's *entire* fill — see the
   *  `oneWay` branch in `render` for how it's actually applied to each end. */
  oneWayAccentColor: number;
  elevatorArrowColor: number;
  elevatorArrowSize: number;
  elevatorArrowStyle: OneWayPattern;
  elevatorArrowCornerStyle: "round" | "miter";
  decorativeStairsTwoWay: VerticalDecorativeLineStyle;
  decorativeStairsOneWay: VerticalDecorativeLineStyle;
  decorativeElevator: VerticalDecorativeLineStyle;
  decorativeStairsArrowColor: number;
  /** Direction-arrow size, as a fraction of the stairs icon's own half-width (0-1) — same
   *  convention as `twoWayArrowSize`. */
  decorativeStairsArrowSize: number;
  decorativeStairsAccentColor: number;
  /** "Floor-number badges" (GitHub issue #430) — see `ElevatorBadgeSettings`'s own doc comment.
   *  Independent of `style`: applies to `elevatorMarker`/`decorativeElevator` alike. */
  elevatorBadges: ElevatorBadgeSettings;
};

/** Dark accent for a one-way passage marker's entry border / exit fill (GitHub issue #347 fourth
 *  follow-up) — mirrors `DEFAULT_VERTICAL_SETTINGS`'s own `ONE_WAY_ACCENT_DARK`
 *  (`imageExportDefaults.ts`). */
const ONE_WAY_ACCENT_DARK = 0x196c64;

/** Fixed live-canvas `VerticalConnectionStyle` shared by every read-only/tool-driven view with no
 *  settings panel of its own for this (`GenerationRenderer`, `AnalyticsRenderer`, `PostEditRenderer`,
 *  `PresetConnectionsRenderer`) — same convention as `TeleportRenderer`'s own `DEFAULT_LINE_STYLE`
 *  fallback. Only `VectorByWallsRenderer`'s export panel lets the user configure this style
 *  (`buildVerticalConnectionStyle`). Previously duplicated byte-for-byte in all four renderer files
 *  (GitHub issue #337/#347) — the "no shared renderer instances across features" rule
 *  (`maze-web/CLAUDE.md`) is about renderer *instances*, not plain data, so a single shared constant
 *  here is the "extract shared code into a base class or utility" case that rule itself calls for.
 *  `VerticalPassage`/`Elevator` share `canvas.vertical.default` but are told apart by shape (circle
 *  vs. diamond); a two-way passage's own solid fill and a one-way passage's own empty (floor-colored)
 *  fill are what tell those two apart. Floor-number badges (GitHub issue #430) stay `enabled: false`
 *  — none of these four views has a settings panel to opt into them from. */
export const DEFAULT_VERTICAL_STYLE: VerticalConnectionStyle = {
  style: "abstract",
  twoWayPassageMarker: {
    shape: "circle",
    cornerStyle: "round",
    fillColor: canvas.vertical.default,
    borderColor: canvas.vertical.default,
    borderWidth: 3,
    gapWidth: 3,
    gapColor: canvas.floor.default,
    size: 0.22,
  },
  oneWayPassageMarker: {
    shape: "circle",
    cornerStyle: "round",
    fillColor: canvas.vertical.default,
    borderColor: canvas.vertical.default,
    borderWidth: 3,
    gapWidth: 3,
    gapColor: canvas.floor.default,
    size: 0.22,
  },
  elevatorMarker: {
    shape: "diamond",
    cornerStyle: "round",
    fillColor: canvas.vertical.default,
    borderColor: canvas.vertical.default,
    borderWidth: 3,
    gapWidth: 3,
    gapColor: canvas.floor.default,
    size: 0.22,
  },
  twoWayArrowColor: canvas.floor.default,
  twoWayArrowSize: 0.75,
  twoWayArrowStyle: "triangle",
  twoWayArrowCornerStyle: "round",
  oneWayArrowColor: canvas.floor.default,
  oneWayArrowSize: 0.75,
  oneWayArrowStyle: "triangle",
  oneWayArrowCornerStyle: "round",
  oneWayAccentColor: ONE_WAY_ACCENT_DARK,
  elevatorArrowColor: canvas.floor.default,
  elevatorArrowSize: 0.75,
  elevatorArrowStyle: "triangle",
  elevatorArrowCornerStyle: "round",
  // `style: "abstract"` above means these decorative fields (GitHub issue #428) are never actually
  // read — filled in only to satisfy `VerticalConnectionStyle`'s type.
  decorativeStairsTwoWay: { lineColor: canvas.vertical.default, lineWidth: 3, size: 0.22 },
  decorativeStairsOneWay: { lineColor: canvas.vertical.default, lineWidth: 3, size: 0.22 },
  decorativeElevator: { lineColor: canvas.vertical.default, lineWidth: 3, size: 0.22 },
  decorativeStairsArrowColor: canvas.floor.default,
  decorativeStairsArrowSize: 0.75,
  decorativeStairsAccentColor: ONE_WAY_ACCENT_DARK,
  // Floor-number badges (GitHub issue #430) are a settings-panel-only opt-in — none of these
  // read-only/tool-driven views has a settings panel to enable them from, so `enabled: false` here
  // makes every other field below purely inert filler (kept in sync with
  // `imageExportDefaults.ts`'s own `elevatorBadges` values only by convention, not by import — this
  // module must not depend on the store layer, see this file's own class-level doc comment).
  elevatorBadges: { enabled: false, labelType: "arabic", size: 0.7, placement: "top_bottom", distance: 4, gap: 2, gapWidth: 2, cornerStyle: "round", evenDistribution: false, shape: "circle", fillColor: 0xf0c900, textColor: canvas.floor.default, fontWeight: "bold" },
};

/** Each pattern's own tip reach, as a fraction of its `size` param (`wallUtils.ts`) — none of the
 *  three shared primitives puts its tip exactly at `size` from `(cx, cy)`: `drawOneWayTriangle`'s
 *  tip sits at `0.65 * length` where `length = size` (its own "tip 65% ahead" convention, GitHub
 *  issue #292 follow-up); `drawOneWayChevron`/`drawOneWayArrow` both put their tip at exactly
 *  `size`. Used to rescale the `size` passed to each primitive so the drawn tip always lands
 *  exactly at the caller's own `arrowSize` regardless of pattern — otherwise a triangle visibly
 *  fell short of the marker's own radius at `arrowSizeFraction: 1` while a chevron/arrow already
 *  reached it exactly (GitHub issue #347 fourth follow-up: "arrow size 1 should fill the marker's
 *  own radius, for every pattern"). */
function patternTipFraction(pattern: OneWayPattern): number {
  return pattern === "triangle" ? 0.65 : 1;
}

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
function arrowThickness(arrowSizeFraction: number): number {
  const t = (arrowSizeFraction - ARROW_SIZE_MIN) / (ARROW_SIZE_MAX - ARROW_SIZE_MIN);
  return ARROW_THICKNESS_MIN + t * (ARROW_THICKNESS_MAX - ARROW_THICKNESS_MIN);
}

/** Dispatches to the one shared one-way-indicator drawing primitive matching `pattern`
 *  (`wallUtils.ts`, GitHub issue #347 third follow-up — same three patterns/corner-style knob as
 *  the wall one-way indicator, `oneWayPattern`/`oneWayJoin`). `size` here is the caller's own
 *  desired tip reach from `(cx, cy)` (a marker-relative arrow half-length) — rescaled by
 *  `patternTipFraction` before being passed down as `size` in `OneWayDrawStyle`, since the three
 *  primitives don't agree among themselves on what fraction of their own `size` param reaches the
 *  tip. `thickness` (GitHub issue #347 fifth follow-up) drives `chevron`/`arrow`'s own stroke width
 *  (`OneWayDrawStyle.thickness`, `wallUtils.ts` defaults to a fixed `4` when omitted) — `triangle`
 *  is a filled shape with no stroke of its own, so `thickness` is simply never read for it. See
 *  `drawArrowFilled` for the one call site. */
function drawArrowPattern(g: Graphics, pattern: OneWayPattern, cx: number, cy: number, dx: number, dy: number, size: number, color: number, join: "round" | "miter", thickness: number): void {
  // `cap` (chevron/arrow's own stroke line-ends) mirrors `join` the same way the wall one-way
  // indicator's own `buildOneWayStyle` does (`exportStyleBuilders.ts`) — `join`/`cap` are two
  // separate pixi stroke options (corners vs. line-ends); without setting `cap` too, the corner
  // style only ever rounded a corner join, never the stroke's own open ends, which stayed pixi's
  // default `"round"` regardless of the "miter" selection (GitHub issue #347 third follow-up).
  const cap: "square" | "round" = join === "miter" ? "square" : "round";
  const drawnSize = size / patternTipFraction(pattern);
  const style = { color, size: drawnSize, join, cap, thickness };
  if (pattern === "triangle") drawOneWayTriangle(g, cx, cy, dx, dy, style);
  else if (pattern === "chevron") drawOneWayChevron(g, cx, cy, dx, dy, style);
  else drawOneWayArrow(g, cx, cy, dx, dy, style);
}

/** Draws the departure-end (`marker.filled: true`/`marker.arrowFilled: true`) direction arrow —
 *  the ordinary, full-color pattern draw, no outline treatment. */
function drawArrowFilled(g: Graphics, pattern: OneWayPattern, cx: number, cy: number, dx: number, dy: number, size: number, color: number, join: "round" | "miter", thickness: number): void {
  drawArrowPattern(g, pattern, cx, cy, dx, dy, size, color, join, thickness);
}

/** Each pattern's own tip/base visual midpoint, as a fraction of `size` — the tip-reach `size`
 *  `drawArrowPattern` itself is called with (GitHub issue #347 fourth follow-up; NOT the rescaled
 *  `drawnSize` passed further down to `wallUtils.ts`, which differs by `patternTipFraction`) —
 *  ahead of the `(cx, cy)` origin. None of the three shared primitives is actually centered on its
 *  own input origin: `drawOneWayChevron`'s tip sits at `+drawnSize` (= `+size`, `patternTipFraction`
 *  is 1), back at `-0.6*drawnSize` (midpoint `+0.2*size` ahead of its own input `cy`, since it draws
 *  directly off the input with no internal recentering); `drawOneWayTriangle` *does* recenter
 *  internally (its own `centroidOffset`, tip at `+0.65*drawnSize` and base at `-0.35*drawnSize` from
 *  the *input* origin, but then redrawn around a `roundPoly` centroid offset by
 *  `0.65*drawnSize - (2/3)*drawnSize = -drawnSize/60` from that same input — and `drawnSize =
 *  size/0.65`, so as a fraction of `size` this residual offset is `-1/(0.65*60) = -1/39`) —
 *  netting a much smaller residual midpoint offset than the input-relative tip/base numbers alone
 *  would suggest; `drawOneWayArrow`'s tail/tip are symmetric (`-drawnSize`/`+drawnSize`, offset
 *  `0`). Used to compensate a bidirectional pair's own `oy` so both arrows' visual centers land on
 *  the same on-screen row instead of straddling it (mirrors the old hand-built
 *  `drawDirectionArrow`'s own `size*0.25` constant, replaced when this dispatch was introduced). */
function patternMidpointOffset(pattern: OneWayPattern): number {
  if (pattern === "triangle") return -1 / 39;
  if (pattern === "chevron") return 0.2;
  return 0;
}

/** Number of ascending steps a decorative stairs pictogram draws — shared by the icon itself and
 *  `drawStairsArrow` (GitHub issue #428), which needs the same step geometry to lay its own
 *  parallel line along the stairs' own diagonal run. */
const STAIRS_STEPS = 3;

/** Returns the corner points of a stairs zigzag centered at `(cx, cy)`, half-width/height `r` — an
 *  *open* polyline (GitHub issue #428: "no bottom closing edge", a real stroke-only zigzag instead of
 *  a closed poly) that starts on a vertical riser segment (GitHub issue #428 fourth follow-up
 *  reverted the third follow-up's horizontal-start shape back to this — a vertical riser at the
 *  start reads better than a short horizontal landing stub at the marker's own scale); the *end*
 *  segment is horizontal (`STAIRS_STEPS` risers interleaved with `STAIRS_STEPS - 1` horizontal
 *  shelves nets one more riser than shelf, so the last drawn segment is a shelf, not a riser — this
 *  asymmetry is intentional, not a bug). Shared by `drawStairsIcon` (stroking the returned path) and
 *  `drawStairsArrow` (deriving the diagonal run's own direction from the same left/bottom/step
 *  geometry) so the two never drift apart. */
function stairsZigzagPoints(cx: number, cy: number, r: number): number[] {
  const w = (r * 2) / STAIRS_STEPS;
  const h = (r * 2) / STAIRS_STEPS;
  const left = cx - r;
  const bottom = cy + r;
  const points: number[] = [left, bottom];
  for (let i = 0; i < STAIRS_STEPS; i++) {
    const x = left + i * w;
    const yTop = bottom - (i + 1) * h;
    points.push(x, yTop, x + w, yTop);
  }
  return points;
}

/** Draws the decorative stairs pictogram as an open stroked zigzag, `(cx, cy)`-centered, half-size
 *  `r` (GitHub issue #428) — see `stairsZigzagPoints`. `lineWidth`/`color` are the caller's own
 *  `decorativeStairsTwoWay`/`decorativeStairsOneWay` line style; stroke only, no fill and no closing
 *  edge back along the bottom (unlike the pre-#428 filled-silhouette version). */
function drawStairsIcon(g: Graphics, cx: number, cy: number, r: number, lineWidth: number, color: number): void {
  const points = stairsZigzagPoints(cx, cy, r);
  g.moveTo(points[0], points[1]);
  for (let i = 2; i < points.length; i += 2) g.lineTo(points[i], points[i + 1]);
  g.stroke({ color, width: lineWidth, join: "round", cap: "round" });
}

/** Draws the decorative elevator pictogram, `(cx, cy)`-centered, half-size `r` (GitHub issue #428):
 *  a stroked square shaft outline, a vertical doors-split line through its center, and two short
 *  cable strokes above its top edge — all in the caller's own `decorativeElevator` line style, no
 *  fill (an elevator has no natural "decorative" illustration beyond this schematic, mirrored from
 *  the issue's own no-decorative-elevator rationale for the marker-shaped treatment — see
 *  `VerticalConnectionStyle`'s doc comment). Never gets a direction arrow — see `render`. */
function drawElevatorIcon(g: Graphics, cx: number, cy: number, r: number, lineWidth: number, color: number): void {
  const top = cy - r;
  const bottom = cy + r;
  const left = cx - r;
  g.rect(left, top, r * 2, r * 2);
  g.moveTo(cx, top).lineTo(cx, bottom);
  const cableSpread = r * 0.4;
  const cableTop = top - r * 0.6;
  g.moveTo(cx - cableSpread, cableTop).lineTo(cx - cableSpread, top);
  g.moveTo(cx + cableSpread, cableTop).lineTo(cx + cableSpread, top);
  g.stroke({ color, width: lineWidth, join: "round", cap: "round" });
}

/** Draws the decorative stairs' own direction arrow (GitHub issue #428) — a dedicated primitive, not
 *  `OneWayPattern` (an arrowhead pattern reads as a point indicator; this needs to read as
 *  "direction of travel along the stairs' own diagonal run" instead): a straight line drawn parallel
 *  to the stairs' own diagonal run (bottom-left to top-right, same overall run `stairsZigzagPoints`
 *  traces), offset above it (screen-up from the line itself), with a small arrowhead at whichever end
 *  `pointsUp` selects — mirroring `marker.direction` (GitHub issue #428 third follow-up: "the arrow
 *  must point toward the *other* floor this marker's own connection leads to", the same up/down
 *  reasoning `render`'s own marker-shape branch already applies via `dys`/`marker.direction`, not
 *  always the diagonal's own "up" end as the very first decorative-style version did). `crossedOut`
 *  (GitHub issue #428, one-way arrival end) still draws the ordinary arrowhead at the tip — GitHub
 *  issue #428 fifth follow-up: "the crossed-out arrow was missing its own head entirely" — plus a
 *  short perpendicular tick placed just past the tip, in the direction the head itself points
 *  (`"->|"`, GitHub issue #428 seventh follow-up moved this from just short of the tip, where it
 *  read as sitting at the head's own base) — mirrors `oneWayAccentColor`'s own from/to visual
 *  distinction, adapted to a line icon that has no fill/border to split. */
function drawStairsArrow(g: Graphics, cx: number, cy: number, r: number, size: number, color: number, lineWidth: number, crossedOut: boolean, pointsUp: boolean): void {
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
  g.moveTo(x0, y0).lineTo(x1, y1);
  // The head sits at the diagonal's "up" end (`x1, y1`) when `pointsUp`, at its "down" end (`x0, y0`)
  // otherwise — `hx, hy` the tip, `hdx, hdy` the direction pointing away from the line's own body
  // toward that tip, so the back-vector math below reads correctly for either end.
  const hx = pointsUp ? x1 : x0;
  const hy = pointsUp ? y1 : y0;
  const hdx = pointsUp ? dx : -dx;
  const hdy = pointsUp ? dy : -dy;
  const headLen = halfLen * 0.7;
  const headAngle = Math.PI / 6;
  const back1x = hx - (hdx * Math.cos(headAngle) - hdy * Math.sin(headAngle)) * headLen;
  const back1y = hy - (hdy * Math.cos(headAngle) + hdx * Math.sin(headAngle)) * headLen;
  const back2x = hx - (hdx * Math.cos(headAngle) + hdy * Math.sin(headAngle)) * headLen;
  const back2y = hy - (hdy * Math.cos(headAngle) - hdx * Math.sin(headAngle)) * headLen;
  g.moveTo(hx, hy).lineTo(back1x, back1y);
  g.moveTo(hx, hy).lineTo(back2x, back2y);
  if (crossedOut) {
    // Sits just past the tip, in the direction the arrowhead itself points (GitHub issue #428
    // seventh follow-up: "->|" — the tick is what the arrow runs *into*, not a mark back at the
    // head's own base) — a small step forward from `hx, hy` along the shaft direction.
    const tickGap = halfLen * 0.25;
    const tickCx = hx + hdx * tickGap;
    const tickCy = hy + hdy * tickGap;
    const tickLen = halfLen * 0.5;
    g.moveTo(tickCx - px * tickLen, tickCy - py * tickLen).lineTo(tickCx + px * tickLen, tickCy + py * tickLen);
  }
  g.stroke({ color, width: lineWidth, join: "round", cap: "round" });
}

/** Draws one floor-number badge's gap ring alone (GitHub issue #430 second follow-up) — same
 *  "gap ring, then fill on top" convention `WaypointsRenderer` uses for `MarkerSettings.gapWidth`,
 *  but split into its own function so every badge's gap ring across a whole render pass can be drawn
 *  *before* any badge's own fill (`drawElevatorBadges`' two-pass draw order below) — otherwise a
 *  gap ring drawn immediately before its own fill would still land on top of an already-drawn
 *  neighboring badge, cutting into it; drawing every gap first keeps every badge's own fill on top
 *  of any gap ring it might overlap, never the reverse. Sized to `radius + gapWidth` alone (no
 *  border-width addition; badges never draw a border) — still no inter-badge *avoidance* (two gap
 *  rings can still overlap each other), only a fixed draw order so a gap never wins over a fill. */
function drawElevatorBadgeGap(container: Container, pos: { x: number; y: number }, radius: number, shape: MarkerShape, rounded: boolean, gapWidth: number, gapColor: number): void {
  if (gapWidth <= 0) return;
  const gapGraphics = new Graphics();
  drawMarkerShape(gapGraphics, shape, pos.x, pos.y, radius + gapWidth, rounded);
  gapGraphics.fill(gapColor);
  container.addChild(gapGraphics);
}

/** Draws one floor-number badge's own body (GitHub issue #430) — a small filled circle with a
 *  centered label (`formatElevatorBadgeLabel`), independent of `drawFloorBadge`'s own
 *  cross-floor-navigation badge (`floorBadge.ts`, a different feature: an off-floor endpoint
 *  stand-in with a knockout digit and its own click-to-navigate wiring). This badge never navigates
 *  and always fills solid, with the label drawn *on top* in `textColor` rather than knocked out of
 *  the fill — the issue's own "fill color"/"text color" pair implies two independently visible
 *  colors, not a stencil cutout. No gap ring here — see `drawElevatorBadgeGap`. */
const ELEVATOR_BADGE_FONT_WEIGHTS: Record<ElevatorBadgeFontWeight, TextStyleFontWeight> = {
  regular: "normal",
  bold: "bold",
};

function drawElevatorBadgeBody(container: Container, pos: { x: number; y: number }, radius: number, shape: MarkerShape, rounded: boolean, label: string, fillColor: number, textColor: number, fontSize: number, fontWeight: ElevatorBadgeFontWeight): void {
  const g = new Graphics();
  drawMarkerShape(g, shape, pos.x, pos.y, radius, rounded);
  g.fill(fillColor);
  container.addChild(g);
  const text = new Text({
    text: label,
    style: { fontSize, fill: textColor, fontWeight: ELEVATOR_BADGE_FONT_WEIGHTS[fontWeight], trim: true },
    resolution: 4,
  });
  text.anchor.set(0.5);
  text.x = pos.x;
  text.y = pos.y;
  container.addChild(text);
}

/** Picks one font size shared by every elevator badge across the whole render pass (round-4 GitHub
 *  issue #430 follow-up) — sized to fit the widest label among *every* elevator marker being drawn,
 *  not just one marker's own fan, so every badge in the image reads at the same size regardless of
 *  which elevator it belongs to (an elevator reaching only floor 2 must still draw as small as one
 *  reaching floor 8, e.g. `labelType: "roman"`'s `"VIII"`, since a shared badge size that changed
 *  per-elevator would look inconsistent across the maze). Starts at the baseline `radius * 1.4` and
 *  only ever scales *down* — every badge shares whatever the single worst-case label needs. */
function fitElevatorBadgeFontSize(labels: string[], radius: number): number {
  const baseline = radius * 1.4;
  const targetWidth = radius * 1.6;
  let widest = 0;
  for (const label of labels) {
    const probe = new Text({ text: label, style: { fontSize: baseline, fontWeight: "bold", trim: true } });
    widest = Math.max(widest, probe.width);
    probe.destroy();
  }
  if (widest <= targetWidth || widest === 0) return baseline;
  return baseline * (targetWidth / widest);
}

/** Draws every floor-number badge for one `Elevator` marker (GitHub issue #430) — a no-op unless
 *  `settings.enabled` and the marker actually carries a resolved fan (`targetFloorIndices`, only
 *  ever set for `kind === "elevator"`, see `VerticalConnectionMarker`'s own doc comment). Shared by
 *  both the marker-shape and decorative render branches — badges are an independent layer on top of
 *  either. `gapColor` is the current floor color — callers pass `elevatorMarker.gapColor`, which
 *  already mirrors it (see `VerticalMarkerStyle`'s own doc comment), so badges don't need their own
 *  copy of that convention threaded through. `fontSize` is shared across the whole render pass (see
 *  `fitElevatorBadgeFontSize`), not recomputed per marker. Draws every badge's own gap ring first,
 *  then every badge's own body — never gap-then-body-then-gap-then-body — so no badge's fill ever
 *  ends up underneath a neighboring badge's gap ring. */
function drawElevatorBadges(container: Container, marker: VerticalConnectionMarker, cx: number, cy: number, markerRadius: number, settings: ElevatorBadgeSettings, gapColor: number, fontSize: number): void {
  if (!settings.enabled || marker.kind !== "elevator" || !marker.targetFloorIndices || marker.targetFloorIndices.length === 0) return;
  const badgeRadius = markerRadius * settings.size;
  const rounded = settings.cornerStyle === "round";
  const positions = computeElevatorBadgePositions(cx, cy, markerRadius, marker.targetFloorIndices.length, badgeRadius, settings.distance, settings.gap, settings.placement, settings.evenDistribution);
  const labels = marker.targetFloorIndices.map((floorIndex) => formatElevatorBadgeLabel(floorIndex, settings.labelType));
  for (const pos of positions) {
    drawElevatorBadgeGap(container, pos, badgeRadius, settings.shape, rounded, settings.gapWidth, gapColor);
  }
  for (const [i, label] of labels.entries()) {
    drawElevatorBadgeBody(container, positions[i], badgeRadius, settings.shape, rounded, label, settings.fillColor, settings.textColor, fontSize, settings.fontWeight);
  }
}

/** Renders `VerticalPassage`/`Elevator` markers for one mode renderer (GitHub issue #347) — its own
 *  low-level primitive, alongside `WaypointsRenderer`/`TeleportRenderer`, so a future floor-aware
 *  `GenerationRenderer` can own its own instance the same way it already does for those (per
 *  `maze-web/CLAUDE.md`'s feature-renderer ownership rule — never a shared instance across
 *  renderers). Draws each marker's own gap ring / fill / border via the same
 *  `radius + borderWidth + gapWidth` outer-alignment convention every other marker in this codebase
 *  uses (`WaypointsRenderer`, teleport markers, one-way indicators), then an optional direction
 *  arrow on top pointing at the other floor this connection leads to (`marker.direction`,
 *  screen-up/down — there's no geometric "up/down" in a single 2D floor image, so the arrow always
 *  points straight up or down on screen regardless of the marker's own shape/rotation). `filled`
 *  distinguishes a two-way `VerticalPassage`/`Elevator` (`filled: true`, ordinary marker look) from a
 *  one-way `VerticalPassage`'s two ends (`filled: false` on both) — see the `oneWay` branch further
 *  down for the departure/arrival accent-color treatment those two ends actually get, and
 *  `VerticalConnectionMarker`'s own doc comment for the `arrowFilled` field that tells them apart. */
export class VerticalConnectionRenderer {
  private readonly g: Graphics;

  constructor(container: Container) {
    this.g = new Graphics();
    container.addChild(this.g);
  }

  /** `interactive` (GitHub issue #337 follow-up) wires click-to-switch-floor on every marker whose
   *  own `targetFloorIndex` resolved (a `VerticalPassage` always has exactly one target floor; an
   *  `Elevator`'s fan does not, so its markers never get `targetFloorIndex` and stay non-interactive
   *  regardless of this flag — see `VerticalConnectionMarker`'s own doc comment). One listener per
   *  marker `Graphics`, not a shared hit-test the way `TeleportRenderer.wireGroupInteractivity`
   *  needs (a handful of markers per floor at most — no bucket-search justified here). */
  render(data: {
    markers: VerticalConnectionMarker[];
    style: VerticalConnectionStyle;
    /** Per-marker click-to-switch-floor gate — a plain `boolean` applies to every marker alike
     *  (e.g. `GenerationRenderer`'s always-on read-only canvas); a predicate lets a tool-driven
     *  canvas (`PostEditRenderer`, `PresetConnectionsRenderer`) withhold navigation while the
     *  active tool needs the same click for something else (e.g. the reset tool, or the one-way
     *  vertical-passage tool's own direction-cycle click on a one-way marker, `marker.filled ===
     *  false`) — see GitHub issue #341's follow-up. */
    interactive?: boolean | ((marker: VerticalConnectionMarker) => boolean);
  }): void {
    this.g.clear();
    this.g.removeChildren().forEach((c) => c.destroy());

    // Two markers can share the same cell (an Elevator + VerticalPassage from the same node, or a
    // one-way VerticalPassage's departure end sharing a cell with another edge's arrival end) — GitHub
    // issue #337 follow-up. Spread same-position markers left/right along X so their circles don't
    // stack directly on top of each other; a lone marker at a position keeps its original center.
    const groupByPos = new Map<string, VerticalConnectionMarker[]>();
    for (const marker of data.markers) {
      const key = `${marker.pos[0]},${marker.pos[1]}`;
      const group = groupByPos.get(key);
      if (group) group.push(marker);
      else groupByPos.set(key, [marker]);
    }

    // Shared across every elevator badge drawn this render pass (round-4 GitHub issue #430
    // follow-up) — see `fitElevatorBadgeFontSize`'s own doc comment for why this must be computed
    // once over every elevator's own `targetFloorIndices`, not per marker. `markerRadius` is the
    // same for every elevator in one pass (one style mode applies to the whole render call), sourced
    // from whichever branch this pass actually uses.
    const decorative = data.style.style === "decorative";
    const elevatorMarkerRadius = (decorative ? data.style.decorativeElevator.size : data.style.elevatorMarker.size) * TILE_SIZE;
    const badgeRadius = elevatorMarkerRadius * data.style.elevatorBadges.size;
    const allBadgeLabels = data.markers
      .filter((m) => m.kind === "elevator" && m.targetFloorIndices)
      .flatMap((m) => m.targetFloorIndices!.map((floorIndex) => formatElevatorBadgeLabel(floorIndex, data.style.elevatorBadges.labelType)));
    const badgeFontSize = fitElevatorBadgeFontSize(allBadgeLabels, badgeRadius);

    for (const marker of data.markers) {
      const group = groupByPos.get(`${marker.pos[0]},${marker.pos[1]}`)!;

      if (decorative) {
        this.renderDecorativeMarker(marker, group, data.style, data.interactive, badgeFontSize);
        continue;
      }

      const settings =
        marker.kind === "elevator" ? data.style.elevatorMarker : marker.filled ? data.style.twoWayPassageMarker : data.style.oneWayPassageMarker;
      const [arrowColor, arrowSizeFraction, arrowStyle, arrowCornerStyle] =
        marker.kind === "elevator"
          ? [data.style.elevatorArrowColor, data.style.elevatorArrowSize, data.style.elevatorArrowStyle, data.style.elevatorArrowCornerStyle] as const
          : marker.filled
            ? [data.style.twoWayArrowColor, data.style.twoWayArrowSize, data.style.twoWayArrowStyle, data.style.twoWayArrowCornerStyle] as const
            : [data.style.oneWayArrowColor, data.style.oneWayArrowSize, data.style.oneWayArrowStyle, data.style.oneWayArrowCornerStyle] as const;
      const radius = settings.size * TILE_SIZE;
      let cx = marker.pos[0];
      const cy = marker.pos[1];
      if (group.length > 1) {
        const slot = group.indexOf(marker);
        const offset = radius + Math.max(settings.borderWidth ?? 0, 0) + Math.max(settings.gapWidth ?? 0, 0) * 0.5;
        cx += (slot - (group.length - 1) / 2) * offset * 2;
      }
      const rounded = settings.cornerStyle === "round";
      const borderWidth = settings.borderWidth ?? 0;
      const gapWidth = settings.gapWidth ?? 0;

      const drawShape = (r: number) => {
        drawMarkerShape(this.g, settings.shape, cx, cy, r, rounded);
      };

      // A one-way `VerticalPassage`'s two ends (`filled: false`, GitHub issue #337/#347/fourth-fifth
      // follow-up redesign, sixth follow-up swapped which end gets which treatment — see below) now
      // read as a *tinted* variant of the two-way/elevator look instead of an empty outline-only
      // circle: the departure end (`arrowFilled: true`, "from" — where you leave this floor) draws
      // the ordinary ("primary") fill with its border recolored to `oneWayAccentColor` ("secondary",
      // a dark accent marking "you can leave from here"); the arrival end (`arrowFilled: false`,
      // "to" — where you'd arrive, but this floor has no way back out) draws its *entire* fill in
      // that same secondary color, no separate border color, so a one-way passage's arrival-only end
      // reads as a solid dark twin of the ordinary marker — sealed off, matching the sixth follow-up's
      // "arrival end fully darkened, departure end light with a border" correction. Both ends' arrows
      // are now always solid-filled — the old outline-arrow-on-arrival treatment is redundant with the
      // new border-color distinction.
      const oneWay = marker.kind === "vertical_passage" && !marker.filled;
      const accentColor = data.style.oneWayAccentColor;
      const fillColor = oneWay && !marker.arrowFilled ? accentColor : settings.fillColor;
      const borderColor = oneWay ? accentColor : (settings.borderColor ?? settings.fillColor);

      if (gapWidth > 0) {
        drawShape(radius + borderWidth + gapWidth);
        this.g.fill(settings.gapColor);
      }
      drawShape(radius);
      this.g.fill(fillColor);
      if (borderWidth > 0) {
        drawShape(radius);
        this.g.stroke({ color: borderColor, width: borderWidth, alignment: 0 });
      }

      if (marker.direction) {
        // `"both"` (Elevator fan reaching floors on both sides of the active one, GitHub issue
        // #337/#347 design follow-up) draws one arrow each way instead of picking a side.
        const dys = marker.direction === "both" ? [-1, 1] : [marker.direction === "up" ? -1 : 1];
        // "both" draws one up-arrow and one down-arrow (GitHub issue #337 follow-up) — each arrow's
        // own tip/base isn't centered on its own origin (see `patternMidpointOffset`), so two
        // opposite-facing arrows sharing the marker center would overlap. Spreading the pair along
        // the axis each pattern reads best on keeps both fully visible without one overlapping the
        // other: `chevron`/`triangle` spread vertically (stacked one above the other, each still
        // pointing its own up/down — matches how these two patterns used to be positioned before
        // the pattern dispatch existed, restored in GitHub issue #347's seventh follow-up after the
        // sixth follow-up briefly moved `triangle` to a sideways spread) while `arrow` spreads
        // sideways, since a vertical spread would shorten how far apart the shaft/head of two
        // abutting up/down arrows read (GitHub issue #347 fourth follow-up). `originOffset` is
        // fixed to the marker's own `radius`, not `arrowSize` — otherwise shrinking `arrowSize` (the
        // arrow-size slider) would also shrink the gap between the two arrows, making them converge
        // on the marker center instead of shrinking in place (GitHub issue #347 third follow-up
        // regression). `oy` also compensates each pattern's own tip/base midpoint offset so both
        // arrows' visual centers land on the same row/column as each other, not just as `cy`/`cx`.
        const arrowSize = radius * arrowSizeFraction;
        // `originOffset` multiplier tightened `0.55` -> `0.4` (GitHub issue #347 fifth follow-up:
        // "move the elevator's two arrows a bit closer together"), then widened again to `0.5` for
        // `chevron` alone (GitHub issue #347 sixth follow-up: "spread the elevator's two chevrons a
        // bit further apart vertically") — still fixed to `radius`, not `arrowSize`, per the
        // regression fix above.
        const originOffset = dys.length > 1 ? radius * (arrowStyle === "chevron" ? 0.5 : 0.4) : 0;
        const vertical = dys.length > 1 && arrowStyle !== "arrow";
        // A vertically-stacked `triangle` pair draws each triangle at `0.75` of the ordinary
        // `arrowSize` (GitHub issue #347 seventh follow-up) — the two triangles read as too large
        // stacked at full size; single triangles and every other pattern/pair combination are
        // unaffected.
        const pairArrowSizeFraction = dys.length > 1 && arrowStyle === "triangle" ? 0.75 : 1;
        const pairArrowSize = arrowSize * pairArrowSizeFraction;
        // Single chevron (not a spread pair) reads visually off-center toward its own back/base
        // with the pair's own `0.2` compensation (GitHub issue #347 sixth follow-up) — a lone
        // chevron needs a stronger pull toward its tip to look centered on the marker.
        const singleChevronMidpointFraction = 0.3;
        const midpointFraction = dys.length === 1 && arrowStyle === "chevron"
          ? singleChevronMidpointFraction
          : patternMidpointOffset(arrowStyle);
        const midpointOffset = midpointFraction * pairArrowSize;
        const thickness = arrowThickness(arrowSizeFraction);
        for (const [i, dy] of dys.entries()) {
          const side = i === 0 ? -1 : 1;
          const ox = cx + (vertical ? 0 : side * originOffset);
          const oy = cy - dy * midpointOffset + (vertical ? side * originOffset : 0);
          // Both ends of a one-way passage now draw a solid arrow (GitHub issue #347 fourth
          // follow-up redesign) — the old outline-only arrival arrow is redundant with the new
          // dark-border/dark-fill distinction between entry and exit (see `fillColor`/`borderColor`
          // above), and `drawArrowOutline` (still used nowhere else) is kept only if a future
          // pattern needs a real outline-only draw again.
          drawArrowFilled(this.g, arrowStyle, ox, oy, 0, dy, pairArrowSize, arrowColor, arrowCornerStyle, thickness);
        }
      }

      this.wireInteractivity(marker, data.interactive, cx, cy, radius + borderWidth + gapWidth);
      drawElevatorBadges(this.g, marker, cx, cy, radius, data.style.elevatorBadges, data.style.elevatorMarker.gapColor, badgeFontSize);
    }
  }

  /** Wires the same click-to-switch-floor hit area both the marker-shape and decorative branches of
   *  `render` need (GitHub issue #428 factored this out of the marker-shape branch's own inline copy)
   *  — see `render`'s own `interactive` param doc comment for the gating rules. */
  private wireInteractivity(
    marker: VerticalConnectionMarker,
    interactive: boolean | ((marker: VerticalConnectionMarker) => boolean) | undefined,
    cx: number,
    cy: number,
    hitRadius: number,
  ): void {
    const markerInteractive = typeof interactive === "function" ? interactive(marker) : (interactive ?? false);
    if (!markerInteractive || marker.targetFloorIndex === undefined) return;
    const targetFloorIndex = marker.targetFloorIndex;
    const hit = new Graphics().circle(cx, cy, hitRadius).fill({ color: 0, alpha: 0 });
    hit.eventMode = "static";
    hit.cursor = "pointer";
    hit.on("pointertap", () => navigateToFloor(targetFloorIndex));
    this.g.addChild(hit);
  }

  /** Renders one marker in the "decorative" style (GitHub issue #428) — a line-only pictogram
   *  (`drawStairsIcon`/`drawElevatorIcon`) instead of the marker-shape branch's filled shape, using
   *  `decorativeStairsTwoWay`/`decorativeStairsOneWay`/`decorativeElevator`'s own `lineColor`/
   *  `lineWidth`/`size` fields (no fill/border/gap/shape concept for a stroke-only icon). Only a
   *  `VerticalPassage` draws a direction arrow (`drawStairsArrow`) — a two-way passage draws it in
   *  `decorativeStairsArrowColor`; a one-way passage draws it in `decorativeStairsAccentColor` at
   *  both ends, crossed-out at the arrival (`arrowFilled: false`) end. `Elevator` never draws an
   *  arrow, decorative or not (see `VerticalConnectionStyle`'s own doc comment). Position-grouping
   *  (same-cell spread) mirrors the marker-shape branch's own logic, sized off each icon's own
   *  `size` instead of a marker's `borderWidth`/`gapWidth` (neither exists here). */
  private renderDecorativeMarker(
    marker: VerticalConnectionMarker,
    group: VerticalConnectionMarker[],
    style: VerticalConnectionStyle,
    interactive: boolean | ((marker: VerticalConnectionMarker) => boolean) | undefined,
    badgeFontSize: number,
  ): void {
    const lineStyle =
      marker.kind === "elevator" ? style.decorativeElevator : marker.filled ? style.decorativeStairsTwoWay : style.decorativeStairsOneWay;
    const radius = lineStyle.size * TILE_SIZE;
    let cx = marker.pos[0];
    const cy = marker.pos[1];
    if (group.length > 1) {
      const slot = group.indexOf(marker);
      cx += (slot - (group.length - 1) / 2) * radius * 2.2;
    }

    if (marker.kind === "elevator") {
      drawElevatorIcon(this.g, cx, cy, radius, lineStyle.lineWidth, lineStyle.lineColor);
      this.wireInteractivity(marker, interactive, cx, cy, radius);
      drawElevatorBadges(this.g, marker, cx, cy, radius, style.elevatorBadges, style.elevatorMarker.gapColor, badgeFontSize);
      return;
    }

    drawStairsIcon(this.g, cx, cy, radius, lineStyle.lineWidth, lineStyle.lineColor);

    if (marker.direction) {
      const oneWay = !marker.filled;
      const arrowColor = oneWay ? style.decorativeStairsAccentColor : style.decorativeStairsArrowColor;
      const crossedOut = oneWay && !marker.arrowFilled;
      // `marker.direction` is the floor this marker's own connection leads to (GitHub issue #428
      // third follow-up) — same up/down reasoning `render`'s own marker-shape branch already applies
      // (`dys`, above): `"up"` points the arrowhead at the diagonal's own "up" end, `"down"` at its
      // "down" end. `"both"` never reaches a `VerticalPassage` marker (only `Elevator`, which draws
      // no decorative arrow at all — see this method's own doc comment), so it's not handled here.
      const pointsUp = marker.direction === "up";
      drawStairsArrow(this.g, cx, cy, radius, style.decorativeStairsArrowSize, arrowColor, lineStyle.lineWidth, crossedOut, pointsUp);
    }

    this.wireInteractivity(marker, interactive, cx, cy, radius);
  }

  destroy(): void {
    this.g.destroy();
  }
}
