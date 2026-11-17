import { Container, Graphics } from "pixi.js";
import type { OneWayStyleOverride } from "./types";
import { drawOneWayTriangle, drawOneWayChevron, drawOneWayArrow, type OneWayDrawStyle } from "./wallUtils";

/** Where a pointer's gap ring must stop: the outer side the pointer stands on, which may be a curve. */
export interface WaypointOpeningClip {
  /** Unit normal of the outer side, pointing out of the field (the side's overall direction; a curved side's local normals follow it). */
  nx: number;
  ny: number;
  /** The outer side's flattened path, at least two points — the floor's edge, the wall's centre line. */
  side: readonly (readonly [number, number])[];
  /** How far past the floor's edge (the wall's centre line) the gap may go — half the wall's thickness where the wall stays, 0 where it is cut. */
  reach: number;
}

/** One external-passage pointer (GitHub issue #330): the look is the One-ways section's, except for the pattern,
 *  color, size, thickness, gap width and corner style the endpoint's own "External passage" section sets. */
export interface WaypointOpeningArrow {
  x: number;
  y: number;
  dx: number;
  dy: number;
  style: OneWayStyleOverride;
  clip: WaypointOpeningClip;
}

/** The area a pointer's gap ring may cover: the floor side of the outer side, up to `clip.reach` past it, measured along
 *  the side's local normal — so a curved side is followed, not replaced by its tangent line. The side's path is
 *  continued straight by `span` beyond both ends and the area reaches `span` into the floor — more than the ring itself
 *  ever covers. */
export function gapClipPolygon(arrow: WaypointOpeningArrow): number[] {
  const { style, clip } = arrow;
  const span = 2 * ((style.size ?? 0) + 2 * (style.gapWidth ?? 0) + (style.thickness ?? 0));
  const side = clip.side;
  const last = side.length - 1;
  /** Unit tangent at vertex `i`, and the local normal on the outward side. */
  const frame = (i: number) => {
    const a = side[Math.max(i - 1, 0)];
    const b = side[Math.min(i + 1, last)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const tx = (b[0] - a[0]) / len;
    const ty = (b[1] - a[1]) / len;
    const flip = ty * clip.nx - tx * clip.ny < 0 ? -1 : 1;
    return { tx, ty, nx: flip * ty, ny: -flip * tx };
  };
  const outline: number[] = [];
  const push = (p: readonly [number, number], along: number, i: number) => {
    const f = frame(i);
    outline.push(p[0] + f.tx * along + f.nx * clip.reach, p[1] + f.ty * along + f.ny * clip.reach);
  };
  push(side[0], -span, 0);
  for (let i = 0; i <= last; i++) push(side[i], 0, i);
  push(side[last], span, last);
  // The closing edge lies `span` below the deepest point of the side, so a strongly curved side never leaves the pointer's floor part outside.
  let floor = Infinity;
  for (let i = 0; i < outline.length; i += 2) floor = Math.min(floor, outline[i] * clip.nx + outline[i + 1] * clip.ny);
  const ends = [outline.length - 2, 0].flatMap((i) => {
    const drop = outline[i] * clip.nx + outline[i + 1] * clip.ny - (floor - span);
    return [outline[i] - clip.nx * drop, outline[i + 1] - clip.ny * drop];
  });
  return [...outline, ...ends];
}

/** Draws the pointers that stand on the field's outer wall where an endpoint's external passage is. Cutting the
 *  wall is not done here (`isOpeningWall` leaves the segment out of the walls), this only paints pointers, on top
 *  of the walls. Where the wall stays (`clip.reach` > 0) the gap ring is wider by `reach`, so it reaches the wall's
 *  outer edge instead of stopping `gapWidth` past the pointer, short of it. The ring is clipped (`gapClipPolygon`) to the floor side of the border plus `reach`, so the floor-colored ring never
 *  spills onto the background beyond the wall. Each ring gets its own mask, built fresh every render. */
export class WaypointOpeningRenderer {
  private readonly gaps: Container;
  private readonly main: Graphics;

  constructor(container: Container) {
    this.gaps = new Container();
    this.main = new Graphics();
    container.addChild(this.gaps);
    container.addChild(this.main);
  }

  render(arrows: readonly WaypointOpeningArrow[]): void {
    this.clearGaps();
    this.main.clear();
    for (const arrow of arrows) {
      const { x, y, dx, dy, style } = arrow;
      const look: OneWayDrawStyle = { color: style.color, gapColor: style.gapColor, gapWidth: style.gapWidth, size: style.size, thickness: style.thickness, headWidth: style.headWidth, join: style.join, cap: style.cap };
      if (style.gapWidth) {
        const gap = new Graphics();
        const mask = new Graphics();
        mask.poly(gapClipPolygon(arrow)).fill(0xffffff);
        // Where the wall stays the ring is wider by `reach`, so it clears the wall up to its outer edge.
        drawPointer(gap, style.pattern, x, y, dx, dy, { ...look, gapWidth: style.gapWidth + arrow.clip.reach, layer: "gap" });
        gap.mask = mask;
        this.gaps.addChild(mask, gap);
      }
      drawPointer(this.main, style.pattern, x, y, dx, dy, { ...look, layer: "main" });
    }
  }

  private clearGaps(): void {
    for (const child of this.gaps.removeChildren()) child.destroy();
  }

  destroy(): void {
    this.clearGaps();
    this.gaps.destroy();
    this.main.destroy();
  }
}

function drawPointer(g: Graphics, pattern: OneWayStyleOverride["pattern"], x: number, y: number, dx: number, dy: number, style: OneWayDrawStyle): void {
  switch (pattern) {
    case "chevron":
      drawOneWayChevron(g, x, y, dx, dy, style);
      break;
    case "arrow":
      drawOneWayArrow(g, x, y, dx, dy, style);
      break;
    default:
      drawOneWayTriangle(g, x, y, dx, dy, style);
  }
}
