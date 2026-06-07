import { TILE_SIZE } from "./constants";
import type { NodeDto, TessellationConfig } from "../wasm/types";

export const INRADIUS = TILE_SIZE * Math.sqrt(3) / 2;

export interface Pos { x: number; y: number; }

export function squareCenter(x: number, y: number): Pos {
  return { x: x * TILE_SIZE + TILE_SIZE / 2, y: -y * TILE_SIZE - TILE_SIZE / 2 };
}

export function hexCenter(q: number, r: number, orientation: "flat_top" | "pointy_top"): Pos {
  if (orientation === "flat_top") {
    return {
      x: q * TILE_SIZE * 1.5,
      y: -(r * INRADIUS * 2 + q * INRADIUS),
    };
  } else {
    return {
      x: q * INRADIUS * 2 + r * INRADIUS,
      y: -(r * TILE_SIZE * 1.5),
    };
  }
}

export function cellCenter(node: NodeDto, cfg: TessellationConfig): Pos {
  if (cfg.type === "square") {
    return squareCenter(node.x, node.y);
  } else if (cfg.type === "hex_parallelogram" || cfg.type === "hex_hexagon") {
    return hexCenter(node.x, node.y, cfg.orientation ?? "flat_top");
  } else {
    cfg satisfies never;
    throw new Error(`unknown tessellation type: ${(cfg as { type: string }).type}`);
  }
}

// Returns 6 vertices of a regular hexagon centered at (cx, cy).
// flat_top: first vertex at angle 0° (right), subsequent at 60° intervals.
// pointy_top: first vertex at angle 90° (top in screen coords = negative y), subsequent at 60° intervals.
export function hexVertices(cx: number, cy: number, orientation: "flat_top" | "pointy_top"): Pos[] {
  const startAngle = orientation === "flat_top" ? 0 : Math.PI / 2;
  const vertices: Pos[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = startAngle + (i * Math.PI) / 3;
    vertices.push({
      x: cx + TILE_SIZE * Math.cos(angle),
      y: cy - TILE_SIZE * Math.sin(angle),
    });
  }
  return vertices;
}

// Returns the bounding box of the given centers expanded by halfTileSize on all sides.
export function mazeBounds(centers: Pos[], halfTileSize: number): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of centers) {
    if (c.x < minX) minX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.x > maxX) maxX = c.x;
    if (c.y > maxY) maxY = c.y;
  }
  return {
    minX: minX - halfTileSize,
    minY: minY - halfTileSize,
    maxX: maxX + halfTileSize,
    maxY: maxY + halfTileSize,
  };
}
