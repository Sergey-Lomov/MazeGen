import { squareCenter, squareVertices } from "./squareGeometry";
import { hexCenter, hexVertices } from "./hexGeometry";
import { triCenter, triVertices } from "./triGeometry";
import type { TriOrientation } from "./triGeometry";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";

export type Pos = { x: number; y: number };

// Square: tl=0, tr=1, br=2, bl=3. E=v1→v2, N=v0→v1, W=v3→v0, S=v2→v3
export const SQUARE_NEIGHBOR_OFFSETS: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]];
export const SQUARE_EDGE_VERTS: [number, number][] = [[1, 2], [0, 1], [3, 0], [2, 3]];
export const HEX_NEIGHBOR_OFFSETS_FLAT: [number, number][] = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
export const HEX_NEIGHBOR_OFFSETS_POINTY: [number, number][] = [[-1, 1], [-1, 0], [0, -1], [1, -1], [1, 0], [0, 1]];
export const HEX_EDGE_VERTS: [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0]];
export const TRI_NEIGHBOR_OFFSETS_UP: [number, number][] = [[-1, 0], [1, 0], [0, -1]];
export const TRI_NEIGHBOR_OFFSETS_DOWN: [number, number][] = [[-1, 0], [1, 0], [0, 1]];
export const TRI_EDGE_VERTS_UP: [number, number][] = [[0, 2], [0, 1], [1, 2]];
export const TRI_EDGE_VERTS_DOWN: [number, number][] = [[0, 2], [1, 2], [0, 1]];

/** Starting rotation (degrees, clockwise) added to a split point's per-node circle-point angles
 *  (GitHub issue #223) before evenly distributing them — a per-tessellation constant so the first
 *  node's point doesn't land exactly on a tile vertex/edge-midpoint by coincidence. Square: 45°
 *  (halfway between its 4 edge directions). Hex/tri: 0° for now, to be tuned visually later. */
export function getSplitCircleRotationDeg(cfg: TessellationConfig): number {
  switch (cfg.type) {
    case "square":
    case "square_custom":
      return 45;
    default:
      return 0;
  }
}

export function getCellVertices(x: number, y: number, cfg: TessellationConfig): Pos[] | null {
  switch (cfg.type) {
    case "square":
    case "square_custom": {
      const c = squareCenter(x, y, cfg);
      return squareVertices(c.x, c.y);
    }
    case "hex_parallelogram":
    case "hex_hexagon":
    case "hex_custom": {
      const ori = (cfg as { orientation?: "flat_top" | "pointy_top" }).orientation ?? "flat_top";
      const c = hexCenter(x, y, ori, cfg);
      return hexVertices(c.x, c.y, ori);
    }
    case "triangle_rect":
    case "triangle_triangle":
    case "triangle_hexagon":
    case "tri_custom": {
      const ori = (cfg as { orientation?: TriOrientation }).orientation ?? "r0";
      return triVertices(x, y, ori);
    }
    default:
      return null;
  }
}

export function getCellCenter(x: number, y: number, cfg: TessellationConfig): Pos {
  switch (cfg.type) {
    case "square":
    case "square_custom":
      return squareCenter(x, y, cfg);
    case "hex_parallelogram":
    case "hex_hexagon":
    case "hex_custom": {
      const ori = (cfg as { orientation?: "flat_top" | "pointy_top" }).orientation ?? "flat_top";
      return hexCenter(x, y, ori, cfg);
    }
    case "triangle_rect":
    case "triangle_triangle":
    case "triangle_hexagon":
    case "tri_custom": {
      const ori = (cfg as { orientation?: TriOrientation }).orientation ?? "r0";
      return triCenter(x, y, ori, cfg);
    }
    default:
      return { x: 0, y: 0 };
  }
}

export function getNeighborData(
  cfg: TessellationConfig,
  x: number,
  y: number,
): { offsets: [number, number][]; edgeVerts: [number, number][] } {
  switch (cfg.type) {
    case "square":
    case "square_custom":
      return { offsets: SQUARE_NEIGHBOR_OFFSETS, edgeVerts: SQUARE_EDGE_VERTS };
    case "hex_parallelogram":
    case "hex_hexagon":
    case "hex_custom": {
      const ori = (cfg as { orientation?: string }).orientation ?? "flat_top";
      return {
        offsets: ori === "flat_top" ? HEX_NEIGHBOR_OFFSETS_FLAT : HEX_NEIGHBOR_OFFSETS_POINTY,
        edgeVerts: HEX_EDGE_VERTS,
      };
    }
    case "triangle_rect":
    case "triangle_triangle":
    case "triangle_hexagon":
    case "tri_custom": {
      const up = (x + y) % 2 === 0;
      return {
        offsets: up ? TRI_NEIGHBOR_OFFSETS_UP : TRI_NEIGHBOR_OFFSETS_DOWN,
        edgeVerts: up ? TRI_EDGE_VERTS_UP : TRI_EDGE_VERTS_DOWN,
      };
    }
    default:
      return { offsets: [], edgeVerts: [] };
  }
}

export function getCellNeighborOffsets(cfg: TessellationConfig, x: number, y: number): [number, number][] {
  return getNeighborData(cfg, x, y).offsets;
}

export function getSharedEdgeSegment(
  a: [number, number],
  b: [number, number],
  cfg: TessellationConfig,
): { v0: Pos; v1: Pos } | null {
  const less = a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  const [fa, fb] = less ? [a, b] : [b, a];
  const verts = getCellVertices(fa[0], fa[1], cfg);
  if (!verts) return null;
  const { offsets, edgeVerts } = getNeighborData(cfg, fa[0], fa[1]);
  const dx = fb[0] - fa[0];
  const dy = fb[1] - fa[1];
  for (let i = 0; i < offsets.length; i++) {
    if (offsets[i][0] === dx && offsets[i][1] === dy) {
      const [vi, vj] = edgeVerts[i];
      return { v0: verts[vi], v1: verts[vj] };
    }
  }
  return null;
}
