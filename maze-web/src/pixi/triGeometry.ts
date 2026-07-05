import { TILE_SIZE } from "./constants";
import type { Pos } from "./hexGeometry";
import { getCartesian } from "./cartesianCache";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";

// Triangle side length is 2×TILE_SIZE so triangles are visually comparable to squares/hexagons.
// H = TRI_TILE_SIZE * sqrt(3) / 2 (triangle height).
// col-step = TRI_TILE_SIZE / 2 (adjacent col-triangles share one base).
// Parity: (col + row) % 2 === 0 → pointing-up, else pointing-down.
// Centroid of pointing-up:   cx = col*S/2 + S/4,  cy = -(row*H + H/3)
// Centroid of pointing-down: cx = col*S/2 + S/4,  cy = -(row*H + 2*H/3)
export const TRI_TILE_SIZE = TILE_SIZE * 2;

export type TriOrientation = "r0" | "r90" | "r180" | "r270";

// Rotates a flat_base (r0) coordinate by the given orientation.
// r0:   (x,y) → (x,y)      base at bottom, apex up
// r90:  (x,y) → (-y,-x)    base at left,   apex right
// r180: (x,y) → (-x,-y)    base at top,    apex down
// r270: (x,y) → (y,x)      base at right,  apex left
function rotate(x: number, y: number, orientation: TriOrientation): Pos {
  switch (orientation) {
    case "r0":   return { x,    y    };
    case "r90":  return { x: -y, y: -x };
    case "r180": return { x: -x, y: -y };
    case "r270": return { x:  y, y:  x };
  }
}

/// Scales `maze-core`'s canonical (r0-equivalent, unit-tile-scale — core's S = 2.0) projection
/// (`Tessellation::cartesian`, read via `getCartesian`) by `TRI_TILE_SIZE / 2`, then applies the
/// r0/r90/r180/r270 rotation matrix above. Verified numerically that each orientation is exactly
/// a fixed-angle rotation of the same canonical point (r90/r180/r270 rotate by 90°/180°/270°) —
/// rotation is an isometry, so this never changes distances between points, only which way they
/// render on screen. `cfg` needs only its `type` discriminant; callers without a full config in
/// hand may pass a minimal `{ type: "triangle_rect", cols: 0, rows: 0 }`.
export function triCenter(col: number, row: number, orientation: TriOrientation, cfg: TessellationConfig = { type: "triangle_rect", cols: 0, rows: 0 }): Pos {
  const [ux, uy] = getCartesian(col, row, cfg);
  const scale = TRI_TILE_SIZE / 2;
  return rotate(ux * scale, uy * scale, orientation);
}

// Returns 3 vertices of the triangle at (col, row) for the given orientation.
// Vertex order (r0):
//   pointing-up:   v[0]=top, v[1]=bottom-right, v[2]=bottom-left
//   pointing-down: v[0]=top-left, v[1]=top-right, v[2]=bottom
export function triVertices(col: number, row: number, orientation: TriOrientation): Pos[] {
  const S = TRI_TILE_SIZE;
  const H = S * Math.sqrt(3) / 2;
  const pointingUp = (col + row) % 2 === 0;

  // Compute flat_base (r0) center directly from grid coords.
  const flat_cx = col * S / 2 + S / 4;
  const flat_cy = pointingUp ? -(row * H + H / 3) : -(row * H + 2 * H / 3);

  let offsets: Pos[];
  if (pointingUp) {
    offsets = [
      { x: 0,      y: -2 * H / 3 },
      { x: S / 2,  y:      H / 3 },
      { x: -S / 2, y:      H / 3 },
    ];
  } else {
    offsets = [
      { x: -S / 2, y: -H / 3 },
      { x:  S / 2, y: -H / 3 },
      { x: 0,      y:  2 * H / 3 },
    ];
  }

  return offsets.map(o => rotate(flat_cx + o.x, flat_cy + o.y, orientation));
}
