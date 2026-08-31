import type { Graphics } from "pixi.js";
import { TILE_SIZE } from "../constants";

/** Arm length (grid units) of the coordinate-origin / generation-source cross. Shared so the two
 *  markers stay identical in size and so the `gen_source` tool glyph can mirror it. */
export const CROSS_ARM = TILE_SIZE * 0.35;

/** Stroke width (grid units) of the origin / generation-source cross. */
export const CROSS_WIDTH = 3;

/** Draws a plain `+` centered on `(cx, cy)` in the current stroke color. Used by `OriginRenderer`
 *  and `GenSourceRenderer` (same shape, different color) and mirrored by the `gen_source` glyph.
 *  Caller sets the stroke style (color) before calling. */
export function drawCrossMarker(g: Graphics, cx: number, cy: number): void {
  g.moveTo(cx - CROSS_ARM, cy).lineTo(cx + CROSS_ARM, cy).stroke();
  g.moveTo(cx, cy - CROSS_ARM).lineTo(cx, cy + CROSS_ARM).stroke();
}
