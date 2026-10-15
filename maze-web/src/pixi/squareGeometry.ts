import { TILE_SIZE } from "./constants";
import type { Pos } from "./hexGeometry";
import { getCartesian } from "./cartesianCache";
import { kindFieldConfig, type FieldConfig } from "../fieldConfig";

/// Scales `maze-core`'s canonical unit-tile-scale projection (`Tessellation::cartesian`, read via
/// `getCartesian` -- for square, simply `(x, y)`, the tile's corner not its center) by
/// `TILE_SIZE`, then applies the two screen-space conventions core has no notion of: a half-tile
/// offset (core's origin is the tile's corner; the cell center is +0.5 tile in each axis) and a Y
/// flip (core has no notion of "up" on screen; positive Y renders upward, i.e. negative screen Y
/// in Pixi's downward-Y convention). No rotation needed for square (only hex/tri have a
/// configurable display orientation). `cfg` needs only its tessellation; callers that don't have
/// a full config in hand may pass `kindFieldConfig("square")`.
export function squareCenter(x: number, y: number, cfg: FieldConfig = kindFieldConfig("square")): Pos {
  const [cx, cy] = getCartesian(x, y, cfg);
  return { x: (cx + 0.5) * TILE_SIZE, y: -(cy + 0.5) * TILE_SIZE };
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
