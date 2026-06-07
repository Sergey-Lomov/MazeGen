import { TILE_SIZE } from "./constants";
import type { Pos } from "./hexGeometry";

export function squareCenter(x: number, y: number): Pos {
  return { x: x * TILE_SIZE + TILE_SIZE / 2, y: -y * TILE_SIZE - TILE_SIZE / 2 };
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
