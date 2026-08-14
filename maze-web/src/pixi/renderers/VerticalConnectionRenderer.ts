import { Container, Graphics } from "pixi.js";
import type { VerticalConnectionMarker, MarkerShape, TeleportCornerStyle } from "./types";
import { drawMarkerShape } from "./markerShapes";
import { drawDirectionArrow } from "./wallUtils";
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
 *  comment (`storeTypes.ts`, GitHub issue #347) for the settings this is built from. `Elevator`
 *  always draws as `elevatorMarker` regardless of `displayStyle` — no decorative treatment of its
 *  own, per the issue's own rationale (no natural "decorative elevator" illustration). */
export type VerticalConnectionStyle = {
  displayStyle: "marker" | "decorative";
  verticalPassageMarker: VerticalMarkerStyle;
  elevatorMarker: VerticalMarkerStyle;
  arrowColor: number;
};

/** Draws an outline-only (stroked, unfilled) direction arrow — the arrival-end marker's own arrow
 *  style (`marker.filled === false`, GitHub issue #337/#347 design follow-up), distinguishing "you
 *  only arrive here" from the departure end's ordinary filled arrow (`drawDirectionArrow`). Same
 *  triangle geometry as `drawDirectionArrow`, just closed and stroked instead of filled. */
function drawDirectionArrowOutline(g: Graphics, cx: number, cy: number, dx: number, dy: number, size: number, color: number): void {
  const px = -dy;
  const py = dx;
  const tipX = cx + dx * size;
  const tipY = cy + dy * size;
  const baseX = cx - dx * size * 0.5;
  const baseY = cy - dy * size * 0.5;
  g.poly([
    tipX, tipY,
    baseX + px * size * 0.6, baseY + py * size * 0.6,
    baseX - px * size * 0.6, baseY - py * size * 0.6,
  ]);
  g.stroke({ color, width: 1.5 });
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
      const settings = marker.kind === "elevator" ? data.style.elevatorMarker : data.style.verticalPassageMarker;
      const decorative = marker.kind === "vertical_passage" && data.style.displayStyle === "decorative";
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

      if (gapWidth > 0) {
        drawShape(radius + borderWidth + gapWidth);
        this.g.fill(settings.gapColor);
      }
      drawShape(radius);
      // A one-way VerticalPassage's markers (`filled: false`, both departure and arrival ends,
      // GitHub issue #337/#347 design follow-up) draw an empty circle — its own gap color (mirrors
      // the floor color, see `VerticalMarkerStyle`'s own doc comment) instead of the ordinary fill.
      // Only the arrow (`arrowFilled`) tells the two ends apart; the circle fill itself doesn't.
      this.g.fill(marker.filled ? settings.fillColor : settings.gapColor);
      if (borderWidth > 0) {
        drawShape(radius);
        this.g.stroke({ color: settings.borderColor ?? settings.fillColor, width: borderWidth, alignment: 0 });
      }

      if (marker.direction) {
        // The arrow must contrast against *this marker's own* circle fill, not a single fixed
        // color — a filled circle (two-way/Elevator) needs the gap/floor color, an empty circle
        // (one-way VerticalPassage, either end) needs the marker's own fill color, or the arrow
        // becomes invisible against a same-colored circle underneath it (GitHub issue #337/#347
        // regression: `data.style.arrowColor` alone can only ever match one of the two cases).
        const arrowColor = marker.filled ? settings.gapColor : settings.fillColor;
        // `"both"` (Elevator fan reaching floors on both sides of the active one, GitHub issue
        // #337/#347 design follow-up) draws one arrow each way instead of picking a side.
        const dys = marker.direction === "both" ? [-1, 1] : [marker.direction === "up" ? -1 : 1];
        // "both" draws one up-arrow and one down-arrow (GitHub issue #337 follow-up) — each arrow's
        // own base sits at the marker center by default (see `drawDirectionArrow`'s own tip/base
        // geometry), so two opposite-facing arrows would straddle center and overlap. Shifting each
        // arrow's own origin sideways (not along its own up/down axis, which would shorten how much
        // of the circle each arrow visually spans) keeps both fully visible, side by side. `oy` also
        // corrects for `drawDirectionArrow`'s own tip/base asymmetry (tip at `+size`, base at
        // `-size*0.5`, so an arrow's own visual midpoint sits at `origin + dy*size*0.25`, not at its
        // origin) — without this, the two arrows' own visual centers land on opposite sides of `cy`
        // instead of both sitting level with it.
        const arrowSize = radius * 0.6;
        const originOffset = dys.length > 1 ? arrowSize * 0.55 : 0;
        for (const [i, dy] of dys.entries()) {
          const ox = cx + (i === 0 ? -1 : 1) * originOffset;
          const oy = cy - dy * arrowSize * 0.25;
          if (marker.arrowFilled) {
            drawDirectionArrow(this.g, ox, oy, 0, dy, arrowSize, arrowColor);
          } else {
            drawDirectionArrowOutline(this.g, ox, oy, 0, dy, arrowSize, arrowColor);
          }
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
