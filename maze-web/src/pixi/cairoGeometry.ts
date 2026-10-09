import { TILE_SIZE } from "./constants";

export interface CairoPos {
  x: number;
  y: number;
}

export type CairoTileKind = "L" | "R" | "U" | "D";

/** Valid synthetic tile for face-only editors. `[0, 0]` is not occupied in the Cairo lattice. */
export const CAIRO_ANCHOR_POINT: [number, number] = [2, 1];

/** The Cairo coordinate model uses a 4-by-4 fundamental period.  JavaScript's `%` is
 * truncating, so both the quotient and remainder must be Euclidean for negative points to agree
 * with `CairoTessellation::tile_kind` in maze-core. */
function euclideanRemainder(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

export function cairoTileKind(x: number, y: number): CairoTileKind | null {
  const cellX = Math.floor(x / 4);
  const cellY = Math.floor(y / 4);
  const localX = euclideanRemainder(x, 4);
  const localY = euclideanRemainder(y, 4);
  const oddFundamentalCell = euclideanRemainder(cellX + cellY, 2) === 1;

  if (oddFundamentalCell) {
    if (localX === 1 && localY === 2) return "L";
    if (localX === 3 && localY === 2) return "R";
  } else {
    if (localX === 2 && localY === 1) return "D";
    if (localX === 2 && localY === 3) return "U";
  }
  return null;
}

export function isCairoPoint(x: number, y: number): boolean {
  return cairoTileKind(x, y) !== null;
}

/** Core's five faces, in the same order as `CairoFace::faces()`. */
const OFFSETS: Record<CairoTileKind, [number, number][]> = {
  R: [[-2, 0], [-1, -3], [3, 1], [3, -1], [-1, 3]],
  U: [[0, -2], [-3, -1], [1, 3], [3, -1], [-1, 3]],
  L: [[2, 0], [-3, -1], [1, -3], [1, 3], [-3, 1]],
  D: [[0, 2], [-3, 1], [1, -3], [3, 1], [-1, -3]],
};

/** Polygon edge indices for the five offsets above. The arrays are deliberately per orientation:
 * Cairo's face names are stable slots, while the physical edge rotates with the tile. */
const EDGE_VERTS: Record<CairoTileKind, [number, number][]> = {
  L: [[4, 0], [1, 2], [0, 1], [3, 4], [2, 3]],
  R: [[4, 0], [3, 4], [1, 2], [2, 3], [0, 1]],
  U: [[4, 0], [0, 1], [2, 3], [3, 4], [1, 2]],
  D: [[4, 0], [3, 4], [1, 2], [0, 1], [2, 3]],
};

export function cairoNeighborOffsets(x: number, y: number): [number, number][] {
  const kind = cairoTileKind(x, y);
  return kind ? OFFSETS[kind] : [];
}

export function cairoEdgeVerts(x: number, y: number): [number, number][] {
  const kind = cairoTileKind(x, y);
  return kind ? EDGE_VERTS[kind] : [];
}

/** Face indices in cyclic perimeter order, anchored at Cairo's canonical face 0.
 * Face 0 is the unique edge whose two endpoint corners have the same angle; the remaining
 * indices follow the polygon boundary from that edge. This is deliberately derived from the
 * actual edge table rather than from the raw core face-slot order. */
export function cairoCanonicalFaceOrder(x: number, y: number): number[] {
  const edgeVerts = cairoEdgeVerts(x, y);
  if (edgeVerts.length !== 5) return [];

  const order = [0];
  const used = new Set(order);
  let vertex = edgeVerts[0][1];
  while (order.length < edgeVerts.length) {
    const next = edgeVerts.findIndex(([a, b], face) => !used.has(face) && (a === vertex || b === vertex));
    if (next < 0) return [];
    order.push(next);
    used.add(next);
    const [a, b] = edgeVerts[next];
    vertex = a === vertex ? b : a;
  }
  return order;
}

/** The collinear Cairo form uses the classic pentagon vertices
 * `(-2,0), (-3,3), (0,4), (3,3), (2,0)`. A long edge is one `TILE_SIZE` wide at 100% zoom. The
 * centre spacing and orientation offsets use the same affine scale, so every shared edge
 * remains exact. Coordinates are calculated in mathematical Y-up space and flipped at the screen
 * boundary. */
const BASE_VERTICES: [number, number][] = [[-2, 0], [-3, 3], [0, 4], [3, 3], [2, 0]];
export const CAIRO_VERTEX_SCALE = 1 / 4;
export const CAIRO_CENTER_SCALE = 3 / 8;
/** Offset from the affine Cairo grid anchor to the area centroid of its pentagon. */
export const CAIRO_CENTROID_OFFSET_SCALE = 7 / 72;
const ROTATION: Record<CairoTileKind, number> = { U: 0, D: 2, L: 1, R: 3 };
const ANCHOR_OFFSET: Record<CairoTileKind, [number, number]> = {
  U: [0, -CAIRO_CENTER_SCALE],
  D: [0, CAIRO_CENTER_SCALE],
  L: [CAIRO_CENTER_SCALE, 0],
  R: [-CAIRO_CENTER_SCALE, 0],
};

function rotateQuarterTurn([x, y]: [number, number], turns: number): [number, number] {
  let result: [number, number] = [x, y];
  for (let i = 0; i < turns; i++) result = [-result[1], result[0]];
  return result;
}

/** Returns the affine screen-space anchor for a Cairo grid point. */
function cairoAnchor(x: number, y: number): CairoPos {
  return { x: x * CAIRO_CENTER_SCALE * TILE_SIZE, y: -y * CAIRO_CENTER_SCALE * TILE_SIZE };
}

/** Returns the geometric centre of the Cairo pentagon at a grid point. */
export function cairoCenter(x: number, y: number): CairoPos {
  const anchor = cairoAnchor(x, y);
  const offset = CAIRO_CENTROID_OFFSET_SCALE * TILE_SIZE;
  switch (cairoTileKind(x, y)) {
    case "U": return { x: anchor.x, y: anchor.y - offset };
    case "D": return { x: anchor.x, y: anchor.y + offset };
    case "L": return { x: anchor.x - offset, y: anchor.y };
    case "R": return { x: anchor.x + offset, y: anchor.y };
    default: return anchor;
  }
}

export function cairoVertices(x: number, y: number): CairoPos[] | null {
  const kind = cairoTileKind(x, y);
  if (!kind) return null;
  const [offsetX, offsetY] = ANCHOR_OFFSET[kind];
  const anchor = cairoAnchor(x, y);
  return BASE_VERTICES.map((vertex) => {
    const [rx, ry] = rotateQuarterTurn(vertex, ROTATION[kind]);
    return {
      x: anchor.x + (rx * CAIRO_VERTEX_SCALE + offsetX) * TILE_SIZE,
      y: anchor.y - (ry * CAIRO_VERTEX_SCALE + offsetY) * TILE_SIZE,
    };
  });
}
