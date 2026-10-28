import { Container, Graphics } from "pixi.js";
import { canvas } from "../colorTokens";
import { colorToHsl, hslToColor } from "../../store/colorMath";
import type { SeamArrow, SeamPair } from "../selectors/seamArrows";

type Point = [number, number];

/// What the seam arrow renderer draws: the arrows of the active floor and the one focused (by the pointer
/// or by the topology panel), as an arrow index and, when a single pair is focused, its index.
export interface SeamArrowData {
  arrows: readonly SeamArrow[];
  focus: { arrow: number; pair: number | null } | null;
}

/// Radius of the disc behind the twist icon, relative to the head width.
const ICON_DISC_SHARE = 0.7;
/// The twist icon is Lucide's `refresh-cw` (two circular arrows) on its 24-unit grid, centred on the disc and always
/// upright. `ICON_SCALE` is the half-width of that grid in disc radii, `ICON_STROKE` the icon's line width in grid units.
const ICON_SCALE = 0.66;
const ICON_STROKE = 2.2;
const ICON_ARC_STEPS = 12;

/// Points on the circular arc of radius `r` from `from` to `to`, clockwise on the screen (SVG's sweep flag 1, small arc).
function arcPoints(from: Point, to: Point, r: number): Point[] {
  const mx = (from[0] + to[0]) / 2;
  const my = (from[1] + to[1]) / 2;
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const chord = Math.hypot(dx, dy);
  const h = Math.sqrt(Math.max(r * r - (chord / 2) ** 2, 0));
  const cx = mx - (dy / chord) * h;
  const cy = my + (dx / chord) * h;
  const start = Math.atan2(from[1] - cy, from[0] - cx);
  let sweep = Math.atan2(to[1] - cy, to[0] - cx) - start;
  while (sweep < 0) sweep += Math.PI * 2;
  const points: Point[] = [];
  for (let i = 0; i <= ICON_ARC_STEPS; i++) {
    const angle = start + (sweep * i) / ICON_ARC_STEPS;
    points.push([cx + Math.cos(angle) * r, cy + Math.sin(angle) * r]);
  }
  return points;
}

/// `refresh-cw` as strokes on the 24-unit grid: each half is two arcs ending in a line, plus the corner of its head.
const REFRESH_CW: Point[][] = (() => {
  const half = (flip: boolean): Point[][] => {
    const p = ([x, y]: Point): Point => (flip ? [24 - x, 24 - y] : [x, y]);
    const sweep = [...arcPoints([3, 12], [12, 3], 9), ...arcPoints([12, 3], [18.74, 5.74], 9.75).slice(1), [21, 8] as Point];
    const corner: Point[] = [[21, 3], [21, 8], [16, 8]];
    return [sweep.map(p), corner.map(p)];
  };
  return [...half(false), ...half(true)];
})();

/// The colour of glue `index` of `count`: the palette's seam arrow colour with its hue spread evenly
/// round the wheel, so every glue has its own colour in the same muted gamut.
export function glueColor(index: number, count: number, hovered: boolean): number {
  const { h, s, l } = colorToHsl(hovered ? canvas.topology.seamArrowHover : canvas.topology.seamArrow);
  return hslToColor({ h: h + (360 * index) / Math.max(count, 1), s, l });
}

/// The body with its two ends moved inward just far enough for the square end of the stroke to stay behind the base of the
/// head: a body leaving a wall at an angle would otherwise poke a corner past the base, over the contour. Each shift is
/// at most half of the segment it moves along.
export function tuckEnds(path: Point[], headA: Point[], headB: Point[], width: number): Point[] {
  if (path.length < 2) return path;
  const out = path.map((point): Point => [point[0], point[1]]);
  const tuck = (end: number, next: number, head: Point[]): void => {
    const [tip, left, right] = head;
    const dx = out[next][0] - out[end][0];
    const dy = out[next][1] - out[end][1];
    const length = Math.hypot(dx, dy);
    const baseLength = Math.hypot(right[0] - left[0], right[1] - left[1]);
    if (length === 0 || baseLength === 0) return;
    // Normal of the base, towards the tip, and the body direction against it.
    let nx = -(right[1] - left[1]) / baseLength;
    let ny = (right[0] - left[0]) / baseLength;
    if ((tip[0] - out[end][0]) * nx + (tip[1] - out[end][1]) * ny < 0) [nx, ny] = [-nx, -ny];
    const cos = (dx * nx + dy * ny) / length;
    const sin = Math.abs((dx * ny - dy * nx) / length);
    if (cos <= 0.01) return;
    const shift = Math.min((width / 2) * (sin / cos), length / 2);
    out[end] = [out[end][0] + (dx / length) * shift, out[end][1] + (dy / length) * shift];
  };
  tuck(0, 1, headA);
  tuck(out.length - 1, out.length - 2, headB);
  return out;
}

/// Draws one arrow: a single opaque polyline with a head at each end, a contour along each run of faces and, on a
/// twisted seam, a refresh icon (two circular arrows) in the middle. A hovered arrow is lighter, with the same widths.
/// With `pair`, the body, heads and icon are those of that glued pair alone, so they lead from the hovered face to its partner.
export function drawSeamArrow(g: Graphics, arrow: SeamArrow, hovered = false, color = glueColor(0, 1, hovered), pair: SeamPair | null = null): void {
  const shown = pair ?? arrow;
  const lines: [Point[], number, "butt" | "round"][] = [
    ...(pair ? [pair.path] : arrow.bodies).map((line): [Point[], number, "butt" | "round"] => [tuckEnds(line, shown.headA, shown.headB, arrow.width), arrow.width, "butt"]),
    ...arrow.braces.map((line): [Point[], number, "butt" | "round"] => [line, arrow.braceWidth, "round"]),
  ];
  for (const [line, width, cap] of lines) {
    g.moveTo(line[0][0], line[0][1]);
    for (const point of line.slice(1)) g.lineTo(point[0], point[1]);
    g.stroke({ color, alpha: 1, width, join: "round", cap });
  }
  for (const head of [shown.headA, shown.headB]) {
    g.poly(head.flat(), true);
    g.fill({ color, alpha: 1 });
  }
  if (!arrow.twist) return;

  // The icon in white on a disc of the glue's colour.
  const [cx, cy] = shown.mid;
  const radius = arrow.headWidth * ICON_DISC_SHARE;
  g.circle(cx, cy, radius);
  g.fill({ color, alpha: 1 });
  const unit = (ICON_SCALE * radius) / 12;
  for (const line of REFRESH_CW) {
    g.moveTo(cx + (line[0][0] - 12) * unit, cy + (line[0][1] - 12) * unit);
    for (const [x, y] of line.slice(1)) g.lineTo(cx + (x - 12) * unit, cy + (y - 12) * unit);
    g.stroke({ color: canvas.topology.seamTwistIcon, width: ICON_STROKE * unit, cap: "round", join: "round" });
  }
}

/// Layer of the seam arrows (GitHub issue #841): every glued pair of a floor as one polyline from one face
/// to the other. Pure drawing, like the other base renderers: the feature-renderers that show seams own
/// one, put its container right above their grid and feed it through `watchSeamArrows`.
export class SeamArrowRenderer {
  private readonly g = new Graphics();

  constructor(container: Container) {
    container.addChild(this.g);
  }

  render({ arrows, focus }: SeamArrowData): void {
    const g = this.g;
    if (g.destroyed) return;
    g.clear();
    const count = arrows.length;
    arrows.forEach((arrow, i) => { if (i !== focus?.arrow) drawSeamArrow(g, arrow, false, glueColor(i, count, false)); });
    // The focused arrow is drawn last so it stays on top where arrows cross.
    if (focus && arrows[focus.arrow]) {
      const arrow = arrows[focus.arrow];
      const pair = focus.pair === null ? null : arrow.pairs[focus.pair] ?? null;
      drawSeamArrow(g, arrow, true, glueColor(focus.arrow, count, true), pair);
    }
  }

  destroy(): void {
    this.g.destroy();
  }
}
