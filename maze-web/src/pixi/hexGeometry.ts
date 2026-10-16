import { TILE_SIZE } from "./constants";
import { hexOrientationOf, kindFieldConfig, triOrientationOf, type FieldConfig } from "../fieldConfig";
import { squareCenter } from "./squareGeometry";
import { triCenter } from "./triGeometry";
import { getCartesian } from "./cartesianCache";
import { cairoCenter } from "./cairoGeometry";

export const INRADIUS = TILE_SIZE * Math.sqrt(3) / 2;

/// Side of `maze-core`'s area-1 hexagon in world units — a hex is drawn with side `TILE_SIZE`, so
/// world coordinates scale by `TILE_SIZE / HEX_WORLD_SIDE` pixels.
const HEX_WORLD_SIDE = Math.sqrt(2 / (3 * Math.sqrt(3)));

export interface Pos { x: number; y: number; }

/// Rotates (x, y) counter-clockwise by `deg` degrees around the origin — a plain 2D rotation
/// matrix. An isometry: never changes distances between points, only which way they render.
function rotateDeg(x: number, y: number, deg: number): Pos {
  const a = (deg * Math.PI) / 180;
  return { x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) };
}

/// Scales `maze-core`'s world-unit (flat_top-equivalent) center (`Tessellation::center`, read via
/// `getCartesian`) to pixels (`TILE_SIZE / HEX_WORLD_SIDE`), then rotates by 30° for
/// `pointy_top` (0° for `flat_top`, i.e. no rotation). Verified numerically that `pointy_top` is
/// exactly a 30° rotation of the same canonical point as `flat_top` for every (q, r) — not an
/// independent projection formula — so this stays a single source of truth instead of needing a
/// second core-side formula per hex orientation. `cfg` needs only its tessellation; callers
/// without a full config in hand may pass `kindFieldConfig("hex")`.
export function hexCenter(q: number, r: number, orientation: "flat_top" | "pointy_top", cfg: FieldConfig = kindFieldConfig("hex")): Pos {
  const [ux, uy] = getCartesian(q, r, cfg);
  const scale = TILE_SIZE / HEX_WORLD_SIDE;
  const { x, y } = rotateDeg(ux * scale, uy * scale, orientation === "pointy_top" ? 30 : 0);
  return { x, y };
}

export function cellCenter(node: { x: number; y: number }, cfg: FieldConfig): Pos {
  switch (cfg.tessellation.kind) {
    case "square": return squareCenter(node.x, node.y, cfg);
    case "hex": return hexCenter(node.x, node.y, hexOrientationOf(cfg), cfg);
    case "tri": return triCenter(node.x, node.y, triOrientationOf(cfg), cfg);
    case "cairo": return cairoCenter(node.x, node.y);
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
