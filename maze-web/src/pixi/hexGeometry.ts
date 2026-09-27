import { TILE_SIZE } from "./constants";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { squareCenter } from "./squareGeometry";
import { triCenter } from "./triGeometry";
import { getCartesian } from "./cartesianCache";

export const INRADIUS = TILE_SIZE * Math.sqrt(3) / 2;

export interface Pos { x: number; y: number; }

/// Rotates (x, y) counter-clockwise by `deg` degrees around the origin — a plain 2D rotation
/// matrix. An isometry: never changes distances between points, only which way they render.
function rotateDeg(x: number, y: number, deg: number): Pos {
  const a = (deg * Math.PI) / 180;
  return { x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) };
}

/// Scales `maze-core`'s canonical (flat_top-equivalent, unit-tile-scale) projection
/// (`Tessellation::cartesian`, read via `getCartesian`) by `TILE_SIZE`, then rotates by 30° for
/// `pointy_top` (0° for `flat_top`, i.e. no rotation). Verified numerically that `pointy_top` is
/// exactly a 30° rotation of the same canonical point as `flat_top` for every (q, r) — not an
/// independent projection formula — so this stays a single source of truth instead of needing a
/// second core-side formula per hex orientation. `cfg` needs only its `type` discriminant;
/// callers without a full config in hand may pass a minimal `{ type: "hex_hexagon", radius: 0 }`.
export function hexCenter(q: number, r: number, orientation: "flat_top" | "pointy_top", cfg: TessellationConfig = { type: "hex_hexagon", radius: 0 }): Pos {
  const [ux, uy] = getCartesian(q, r, cfg);
  const { x, y } = rotateDeg(ux * TILE_SIZE, uy * TILE_SIZE, orientation === "pointy_top" ? 30 : 0);
  return { x, y };
}

export function cellCenter(node: { x: number; y: number }, cfg: TessellationConfig): Pos {
  if (cfg.type === "square" || cfg.type === "square_circle" || cfg.type === "square_triangle" || cfg.type === "square_custom") {
    return squareCenter(node.x, node.y, cfg);
  } else if (cfg.type === "hex_rectangle" || cfg.type === "hex_circle" || cfg.type === "hex_parallelogram" || cfg.type === "hex_hexagon" || cfg.type === "hex_custom") {
    return hexCenter(node.x, node.y, (cfg as { orientation?: "flat_top" | "pointy_top" }).orientation ?? "flat_top", cfg);
  } else if (cfg.type === "triangle_rect" || cfg.type === "triangle_triangle" || cfg.type === "triangle_circle" || cfg.type === "triangle_hexagon" || cfg.type === "tri_custom") {
    return triCenter(node.x, node.y, (cfg as { orientation?: "r0" | "r90" | "r180" | "r270" }).orientation ?? "r0", cfg);
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
