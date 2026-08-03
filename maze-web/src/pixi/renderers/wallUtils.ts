import type { Graphics } from "pixi.js";
import { TILE_SIZE } from "../constants";
import { canvas } from "../colorTokens";

/** Shared style knobs for every one-way indicator pattern (`drawOneWayTriangle`/`Chevron`/`Arrow`)
 *  — GitHub issue #292. `color` defaults to `canvas.edge.oneWay` (the indicator's own fill/stroke
 *  color), `borderColor`/`borderWidth` draw an outline around the indicator (a filled triangle's
 *  own stroke; a second, wider stroke pass underneath a line-based pattern's stroke so the border
 *  reads as an outline around the whole shape) — `borderWidth: 0` (falls back to no border) skips
 *  the second pass entirely. `join`/`cap` are pixi stroke options applied to the pattern's own
 *  strokes (never to a filled triangle's fill, only its border stroke). */
export type OneWayDrawStyle = {
  color?: number;
  borderColor?: number;
  borderWidth?: number;
  size?: number;
  /** Line thickness for chevron/arrow's own stroke — independent of `size` (the indicator's
   *  geometric scale). Has no effect on `drawOneWayTriangle`, a filled shape with no line stroke
   *  of its own. GitHub issue #292 follow-up: size used to also drive stroke thickness. */
  thickness?: number;
  join?: "round" | "miter";
  cap?: "round" | "square";
};

function resolvedSize(style?: OneWayDrawStyle): number {
  return style?.size ?? TILE_SIZE * 0.18;
}

function resolvedThickness(style?: OneWayDrawStyle): number {
  return style?.thickness ?? 4;
}

// Draws a direction arrow triangle centered at (cx, cy), pointing in (dx, dy) direction.
// size controls the scale. Color defaults to canvas.edge.oneWay.
export function drawDirectionArrow(
  g: Graphics,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
  size: number,
  color?: number,
): void {
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
  g.fill(color ?? canvas.edge.oneWay);
}

// Draws a filled equilateral triangle one-way indicator, optionally bordered, centered at
// (cx, cy), pointing in (dx, dy) direction. Uses `Graphics.roundPoly` (a regular-polygon
// primitive with a per-corner rounding radius) rather than a hand-built `poly` path, since
// `join` on an open/closed stroke never rounds a filled shape's own corners — only `roundPoly`'s
// `corner` radius can (GitHub issue #292 follow-up: "join doesn't round the triangle itself").
export function drawOneWayTriangle(
  g: Graphics,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
  style?: OneWayDrawStyle,
): void {
  const size = resolvedSize(style) * 0.5;
  const length = size * 2; // full tip-to-base length
  // roundPoly's circumradius R relates to an equilateral triangle's tip-to-base length as
  // length = 1.5*R (tip sits at +R from the centroid, base at -0.5*R). Solved so the tip lands at
  // +0.65*length and the base at -0.35*length from the wall's midpoint (cx, cy) — GitHub issue
  // #292 follow-up ("tip 65% ahead, base 35% behind").
  const radius = (2 / 3) * length;
  const centroidOffset = 0.65 * length - radius;
  const centroidX = cx + dx * centroidOffset;
  const centroidY = cy + dy * centroidOffset;
  const rotation = Math.atan2(dy, dx) + Math.PI / 2; // roundPoly's first vertex points "up" at rotation 0
  const corner = (style?.join ?? "round") === "round" ? size * 0.3 : 0;

  const outline = () => g.roundPoly(centroidX, centroidY, radius, 3, corner, rotation);
  outline().fill(style?.color ?? canvas.edge.oneWay);
  if (style?.borderWidth) {
    // `alignment: 0` (outside) so the border grows outward only — the triangle's own size never
    // shrinks as borderWidth increases (GitHub issue #292 follow-up).
    outline().stroke({
      width: style.borderWidth,
      color: style.borderColor ?? canvas.floor.default,
      join: style.join ?? "round",
      alignment: 0,
    });
  }
}

// Draws a "chevron" one-way indicator (two open strokes forming a shallow `>` shape) centered at
// (cx, cy), pointing in (dx, dy) direction — an outline alternative to the filled
// `drawOneWayTriangle`. A wider bordered pass is drawn first (when borderWidth is set), the main
// stroke on top, so the border reads as an outline around the whole shape.
export function drawOneWayChevron(
  g: Graphics,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
  style?: OneWayDrawStyle,
): void {
  const size = resolvedSize(style);
  const px = -dy;
  const py = dx;
  const tipX = cx + dx * size;
  const tipY = cy + dy * size;
  const backX = cx - dx * size * 0.6;
  const backY = cy - dy * size * 0.6;
  const width = size * 1.4; // shallow: twice the original opening angle
  const color = style?.color ?? canvas.edge.oneWay;
  const strokeWidth = resolvedThickness(style);
  const join = style?.join ?? "round";
  const cap = style?.cap ?? "round";

  const path = (g: Graphics) =>
    g.moveTo(backX + px * width, backY + py * width)
      .lineTo(tipX, tipY)
      .lineTo(backX - px * width, backY - py * width);

  if (style?.borderWidth) {
    path(g).stroke({ width: strokeWidth + style.borderWidth * 2, color: style.borderColor ?? canvas.floor.default, cap, join });
  }
  path(g).stroke({ width: strokeWidth, color, cap, join });
}

// Draws a one-way indicator as a line with a line-only arrowhead (two short strokes, no filled
// triangle) at its tip, centered at (cx, cy), pointing in (dx, dy) direction — a thin-line
// alternative to the filled `drawOneWayTriangle`. A wider bordered pass is drawn first (when
// borderWidth is set), the main stroke on top, so the border reads as an outline around the whole
// shape (shaft + arrowhead).
export function drawOneWayArrow(
  g: Graphics,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
  style?: OneWayDrawStyle,
): void {
  const size = resolvedSize(style);
  const tailX = cx - dx * size;
  const tailY = cy - dy * size;
  const tipX = cx + dx * size;
  const tipY = cy + dy * size;
  const px = -dy;
  const py = dx;
  const headSize = size * 0.5;
  const headBackX = tipX - dx * headSize;
  const headBackY = tipY - dy * headSize;
  const color = style?.color ?? canvas.edge.oneWay;
  const strokeWidth = resolvedThickness(style);
  const join = style?.join ?? "round";
  const cap = style?.cap ?? "round";

  const path = (g: Graphics) =>
    // Shaft ends at the arrowhead's own base (not the tip) — otherwise a square cap makes the
    // shaft's flat end protrude past the narrower arrowhead strokes (GitHub issue #292 follow-up).
    g.moveTo(tailX, tailY).lineTo(headBackX, headBackY)
      .moveTo(headBackX + px * headSize * 0.6, headBackY + py * headSize * 0.6).lineTo(tipX, tipY)
      .lineTo(headBackX - px * headSize * 0.6, headBackY - py * headSize * 0.6);

  if (style?.borderWidth) {
    path(g).stroke({ width: strokeWidth + style.borderWidth * 2, color: style.borderColor ?? canvas.floor.default, cap, join });
  }
  path(g).stroke({ width: strokeWidth, color, cap, join });
}
