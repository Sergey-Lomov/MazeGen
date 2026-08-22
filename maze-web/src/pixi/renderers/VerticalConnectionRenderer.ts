import { Container, Graphics } from "pixi.js";
import type { VerticalConnectionMarker, MarkerShape, TeleportCornerStyle, OneWayPattern } from "./types";
import { drawMarkerShape } from "./markerShapes";
import { drawOneWayArrow, drawOneWayTriangle, drawOneWayChevron } from "./wallUtils";
import { TILE_SIZE } from "../constants";
import { navigateToFloor } from "./floorNavigation";

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

/** Style knobs for `VerticalConnectionRenderer.render` — see `VerticalSettingsFields`'s own doc
 *  comment (`storeTypes.ts`, GitHub issue #347) for the settings this is built from. Three
 *  independent marker/arrow styles (GitHub issue #347 three-section follow-up), by how a marker
 *  actually reads on the map: `twoWayPassageMarker` for a two-way `VerticalPassage`
 *  (`marker.filled === true`), `oneWayPassageMarker` for a one-way `VerticalPassage`
 *  (`marker.filled === false`, both ends), `elevatorMarker` for every `Elevator` (always two-way by
 *  construction, but its own separate section/look). `Elevator` always draws as `elevatorMarker`
 *  regardless of `style` — no decorative treatment of its own, per the issue's own rationale (no
 *  natural "decorative elevator" illustration); its own `"decorative"`/`"realistic"` treatment is a
 *  follow-up. `"realistic"` has no drawing of its own yet (reserved enum value) and falls back to
 *  the same plain marker shape `"abstract"` draws. */
export type VerticalConnectionStyle = {
  style: "abstract" | "decorative" | "realistic";
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

/** Draws a small flight-of-stairs pictogram centered at `(cx, cy)`, radius `r` — the "decorative"
 *  treatment for a `VerticalPassage` (GitHub issue #347): four ascending step rectangles read as
 *  actual stairs on a printed floor image the viewer mentally connects to the adjacent floor's own
 *  print, as opposed to the plain "cut an opening here" marker meant for a physical single-sheet
 *  build. Drawn as one filled path (a staircase silhouette), not four separate rectangles, so a
 *  single fill color/gap ring treats it exactly like any other marker shape. */
function drawStairsIcon(g: Graphics, cx: number, cy: number, r: number): void {
  const steps = 4;
  const w = (r * 2) / steps;
  const h = (r * 2) / steps;
  const left = cx - r;
  const bottom = cy + r;
  const points: number[] = [left, bottom];
  for (let i = 0; i < steps; i++) {
    const x = left + i * w;
    const yTop = bottom - (i + 1) * h;
    points.push(x, yTop, x + w, yTop);
  }
  points.push(left + steps * w, bottom);
  g.poly(points);
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
 *  distinguishes a one-way `VerticalPassage`'s departure end (solid fill + solid arrow) from its
 *  arrival-only end (empty/floor-colored fill + outline-only arrow) — see `VerticalConnectionMarker`'s
 *  own doc comment. */
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

    for (const marker of data.markers) {
      const settings =
        marker.kind === "elevator" ? data.style.elevatorMarker : marker.filled ? data.style.twoWayPassageMarker : data.style.oneWayPassageMarker;
      const [arrowColor, arrowSizeFraction, arrowStyle, arrowCornerStyle] =
        marker.kind === "elevator"
          ? [data.style.elevatorArrowColor, data.style.elevatorArrowSize, data.style.elevatorArrowStyle, data.style.elevatorArrowCornerStyle] as const
          : marker.filled
            ? [data.style.twoWayArrowColor, data.style.twoWayArrowSize, data.style.twoWayArrowStyle, data.style.twoWayArrowCornerStyle] as const
            : [data.style.oneWayArrowColor, data.style.oneWayArrowSize, data.style.oneWayArrowStyle, data.style.oneWayArrowCornerStyle] as const;
      const decorative = marker.kind === "vertical_passage" && data.style.style === "decorative";
      const group = groupByPos.get(`${marker.pos[0]},${marker.pos[1]}`)!;
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
        if (decorative) drawStairsIcon(this.g, cx, cy, r);
        else drawMarkerShape(this.g, settings.shape, cx, cy, r, rounded);
      };

      // A one-way `VerticalPassage`'s two ends (`filled: false`, GitHub issue #337/#347/fourth-fifth
      // follow-up redesign) now read as a *tinted* variant of the two-way/elevator look instead of
      // an empty outline-only circle: the arrival end (`arrowFilled: false`) draws the ordinary
      // ("primary") fill with its border recolored to `oneWayAccentColor` ("secondary", a dark
      // accent marking "you can enter here"); the departure end (`arrowFilled: true`) draws its
      // *entire* fill in that same secondary color, no separate border color, so a one-way
      // passage's exit reads as a solid dark twin of the ordinary marker. Both ends' arrows are now
      // always solid-filled — the old outline-arrow-on-arrival treatment is redundant with the new
      // border-color distinction.
      const oneWay = marker.kind === "vertical_passage" && !marker.filled;
      const accentColor = data.style.oneWayAccentColor;
      const fillColor = oneWay && marker.arrowFilled ? accentColor : settings.fillColor;
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

      const markerInteractive = typeof data.interactive === "function" ? data.interactive(marker) : (data.interactive ?? false);
      if (markerInteractive && marker.targetFloorIndex !== undefined) {
        const targetFloorIndex = marker.targetFloorIndex;
        const hit = new Graphics().circle(cx, cy, radius + borderWidth + gapWidth).fill({ color: 0, alpha: 0 });
        hit.eventMode = "static";
        hit.cursor = "pointer";
        hit.on("pointertap", () => navigateToFloor(targetFloorIndex));
        this.g.addChild(hit);
      }
    }
  }

  destroy(): void {
    this.g.destroy();
  }
}
