import { TILE_SIZE } from "../constants";
import type { DisplayOrientation, TessellationKind } from "../../fieldConfig";

/// 2x2 linear part of a display transform: `[x', y'] = [a·x + c·y, b·x + d·y]`.
export interface Linear {
  a: number;
  b: number;
  c: number;
  d: number;
}

/// UI registry entry of one tessellation kind: metadata only -- no geometry lives here. Cell
/// geometry (centers, boundaries, neighbors) always comes from `maze-core`'s snapshot; the entry
/// says how that world-unit geometry is laid out on screen.
export interface TessellationUi {
  /// Selectable display orientations; empty when the kind has none.
  orientations: readonly DisplayOrientation[];
  /// Params of the kind's default `{ kind, params }` config.
  defaultParams: Record<string, unknown>;
  /// Pixels per world unit, chosen so a cell is drawn at the size of a `TILE_SIZE` square.
  pixelsPerUnit: number;
  /// Linear map from core's world space to the screen at the kind's default orientation.
  base: Linear;
  /// Extra linear map applied on top of `base` for a display orientation.
  orientation(orientation: DisplayOrientation | undefined): Linear;
  /// Starting rotation (degrees, clockwise) of a split point's circle-point angles (GitHub issue
  /// #223): half the angular spacing of the kind's faces, so the first node's point does not land
  /// on a tile vertex or an edge midpoint.
  splitCircleRotationDeg: number;
  /// Directions an equilateral primitive snaps to, in core's canonical orientation: every `step`
  /// radians from `offset`. The display orientation turns them like everything else. `null` for a
  /// lattice without such directions.
  equilateralSnap: { step: number; offset: number } | null;
  /// Length of one geometric cell side, in pixels.
  cellSidePx: number;
  /// The print-sizing measure of a cell, in pixels: the square's side, or a regular polygon's
  /// circumcircle diameter.
  cellMeasurePx: number;
  /// A valid cell near the lattice origin (not every coordinate is a cell): where the origin marker
  /// sits, and the tile the face-only pattern editors draw (`originCellOf`).
  originCell: readonly [number, number];
  /// Edge hover/click hit distance, in pixels.
  edgeHitThreshold: number;
}

/// Whether `linear` leaves every direction unchanged.
export function isIdentityLinear(linear: Linear): boolean {
  return linear.a === 1 && linear.b === 0 && linear.c === 0 && linear.d === 1;
}

const IDENTITY: Linear = { a: 1, b: 0, c: 0, d: 1 };
/// Math Y-up to screen Y-down.
const FLIP_Y: Linear = { a: 1, b: 0, c: 0, d: -1 };

function rotation(deg: number): Linear {
  const angle = (deg * Math.PI) / 180;
  return { a: Math.cos(angle), b: Math.sin(angle), c: -Math.sin(angle), d: Math.cos(angle) };
}

/// Side of core's area-1 regular hexagon, and of its area-1 equilateral triangle, in world units.
const HEX_WORLD_SIDE = Math.sqrt(2 / (3 * Math.sqrt(3)));
const TRI_WORLD_SIDE = 2 / Math.sqrt(Math.sqrt(3));

export const TESSELLATION_UI: Record<TessellationKind, TessellationUi> = {
  square: {
    orientations: [],
    defaultParams: {},
    pixelsPerUnit: TILE_SIZE,
    base: FLIP_Y,
    orientation: () => IDENTITY,
    splitCircleRotationDeg: 45,
    equilateralSnap: { step: Math.PI / 2, offset: -Math.PI / 2 },
    cellSidePx: TILE_SIZE,
    cellMeasurePx: TILE_SIZE,
    originCell: [0, 0],
    edgeHitThreshold: TILE_SIZE * 0.08,
  },
  hex: {
    orientations: ["flat_top", "pointy_top"],
    defaultParams: {},
    // A hexagon is drawn with side `TILE_SIZE`.
    pixelsPerUnit: TILE_SIZE / HEX_WORLD_SIDE,
    base: IDENTITY,
    orientation: (o) => (o === "pointy_top" ? rotation(30) : IDENTITY),
    splitCircleRotationDeg: 30,
    equilateralSnap: { step: Math.PI / 3, offset: Math.PI / 6 },
    cellSidePx: TILE_SIZE,
    cellMeasurePx: TILE_SIZE * 2,
    originCell: [0, 0],
    edgeHitThreshold: TILE_SIZE * 2 * 0.12,
  },
  tri: {
    orientations: ["r0", "r90", "r180", "r270"],
    defaultParams: {},
    // A triangle is drawn with side `2 * TILE_SIZE`, so it is comparable to squares and hexagons.
    pixelsPerUnit: (2 * TILE_SIZE) / TRI_WORLD_SIDE,
    base: IDENTITY,
    orientation: (o) => {
      switch (o) {
        case "r90": return { a: 0, b: -1, c: -1, d: 0 };
        case "r180": return { a: -1, b: 0, c: 0, d: -1 };
        case "r270": return { a: 0, b: 1, c: 1, d: 0 };
        default: return IDENTITY;
      }
    },
    splitCircleRotationDeg: 60,
    equilateralSnap: { step: Math.PI / 3, offset: -Math.PI / 2 },
    cellSidePx: TILE_SIZE * 2,
    cellMeasurePx: (TILE_SIZE * 4) / Math.sqrt(3),
    originCell: [0, 0],
    edgeHitThreshold: TILE_SIZE * 2 * 0.12,
  },
  cairo: {
    orientations: [],
    defaultParams: {},
    pixelsPerUnit: TILE_SIZE,
    base: FLIP_Y,
    orientation: () => IDENTITY,
    splitCircleRotationDeg: 36,
    equilateralSnap: null,
    cellSidePx: TILE_SIZE,
    cellMeasurePx: TILE_SIZE,
    originCell: [2, 1],
    edgeHitThreshold: TILE_SIZE * 0.08,
  },
};
