import { TILE_SIZE } from "./constants";
import type { Pos } from "./hexGeometry";
import { getCartesian } from "./cartesianCache";
import { kindFieldConfig, type FieldConfig } from "../fieldConfig";

/// Scales `maze-core`'s world-unit center (`Tessellation::center`, read via `getCartesian` -- a
/// unit square's center, `(x + 0.5, y + 0.5)`) by `TILE_SIZE` (one world unit is one square side)
/// and flips Y (core is math Y-up; Pixi's screen Y points down). No rotation needed for square
/// (only hex/tri have a configurable display orientation). `cfg` needs only its tessellation;
/// callers that don't have a full config in hand may pass `kindFieldConfig("square")`.
export function squareCenter(x: number, y: number, cfg: FieldConfig = kindFieldConfig("square")): Pos {
  const [cx, cy] = getCartesian(x, y, cfg);
  return { x: cx * TILE_SIZE, y: -cy * TILE_SIZE };
}

// Returns 4 vertices of a square tile centered at (cx, cy), clockwise: tl → tr → br → bl.
export function squareVertices(cx: number, cy: number): Pos[] {
  const h = TILE_SIZE / 2;
  return [
    { x: cx - h, y: cy - h },
    { x: cx + h, y: cy - h },
    { x: cx + h, y: cy + h },
    { x: cx - h, y: cy + h },
  ];
}
