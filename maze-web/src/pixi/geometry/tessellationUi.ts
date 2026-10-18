import { TILE_SIZE } from "../constants";
import type { DisplayOrientation, TessellationKind } from "../../fieldConfig";

/// 2x2 linear part of a display transform: `[x', y'] = [a·x + c·y, b·x + d·y]`.
export interface Linear {
  a: number;
  b: number;
  c: number;
  d: number;
}

/// Lattice-dependent editor behavior of one tessellation kind.
export interface EditorUi {
  /// Axis-aligned grid: rect is `cols x rows` squares (width/height labels, exact print sizing)
  /// and the parallelogram tool is redundant.
  axisAlignedGrid: boolean;
  /// The rect preset is labelled "rectangle" rather than "rect".
  rectLabelRectangle: boolean;
  /// Cells per `cols * rows` unit of a rect preset when the count is closed-form; else ask core.
  rectCellsPerUnit: number | null;
  /// Closed-form cell counts of the hexagon (radius) and triangle (side) presets, else ask core.
  hexagonCellCount: ((radius: number) => number) | null;
  triangleCellCount: ((side: number) => number) | null;
  /// Exact lattice rasterization of the equilateral-triangle primitive.
  latticeTriangle: boolean;
  /// Exact lattice rasterization of the hexagon primitive on the named lattice.
  latticeHexagon: "hex" | "tri" | null;
  /// Which cells a circle primitive takes: by center, or only those fully inside.
  circleInclusion: "center" | "contained";
  /// Cell-size label of the print dialogs and of the PNG result: edge length or diameter.
  printCellSize: "side" | "diameter";
  pngCellSize: "side" | "diameter";
}

const AXIS_ALIGNED: EditorUi = {
  axisAlignedGrid: true,
  rectLabelRectangle: false,
  rectCellsPerUnit: 1,
  hexagonCellCount: null,
  triangleCellCount: null,
  latticeTriangle: false,
  latticeHexagon: null,
  circleInclusion: "center",
  printCellSize: "side",
  pngCellSize: "side",
};

/// UI registry entry of one tessellation kind: metadata only -- no geometry lives here. Cell
/// geometry (centers, boundaries, neighbors) always comes from `maze-core`'s snapshot; the entry
/// says how that world-unit geometry is laid out on screen.
export interface TessellationUi {
  /// Selectable display orientations; empty when the kind has none.
  orientations: readonly DisplayOrientation[];
  /// Params of the kind's default `{ kind, params }` config.
  defaultParams: Record<string, unknown>;
  /// Which maze-wide orientation setting (`hexOrientation`/`triOrientation`) this kind carries.
  orientationSlot: "hex" | "tri" | null;
  /// Editor and sizing behavior that follows the lattice, so no consumer branches on the kind.
  editor: EditorUi;
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

/// Display rotation by quarter turns for the `r0`..`r270` orientations.
function quarterTurn(o: DisplayOrientation | undefined): Linear {
  switch (o) {
    case "r90": return { a: 0, b: -1, c: -1, d: 0 };
    case "r180": return { a: -1, b: 0, c: 0, d: -1 };
    case "r270": return { a: 0, b: 1, c: 1, d: 0 };
    default: return IDENTITY;
  }
}

export const TESSELLATION_UI: Record<TessellationKind, TessellationUi> = {
  square: {
    orientationSlot: null,
    editor: AXIS_ALIGNED,
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
    orientationSlot: "hex",
    editor: {
      axisAlignedGrid: false,
      rectLabelRectangle: true,
      rectCellsPerUnit: null,
      hexagonCellCount: (r) => 3 * r * r + 3 * r + 1,
      triangleCellCount: null,
      latticeTriangle: false,
      latticeHexagon: "hex",
      circleInclusion: "center",
      printCellSize: "diameter",
      pngCellSize: "diameter",
    },
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
    orientationSlot: "tri",
    editor: {
      axisAlignedGrid: false,
      rectLabelRectangle: false,
      rectCellsPerUnit: 2,
      hexagonCellCount: null,
      triangleCellCount: (n) => n * n,
      latticeTriangle: true,
      latticeHexagon: "tri",
      circleInclusion: "contained",
      printCellSize: "diameter",
      pngCellSize: "diameter",
    },
    orientations: ["r0", "r90", "r180", "r270"],
    defaultParams: {},
    // A triangle is drawn with side `2 * TILE_SIZE`, so it is comparable to squares and hexagons.
    pixelsPerUnit: (2 * TILE_SIZE) / TRI_WORLD_SIDE,
    base: IDENTITY,
    orientation: quarterTurn,
    splitCircleRotationDeg: 60,
    equilateralSnap: { step: Math.PI / 3, offset: -Math.PI / 2 },
    cellSidePx: TILE_SIZE * 2,
    cellMeasurePx: (TILE_SIZE * 4) / Math.sqrt(3),
    originCell: [0, 0],
    edgeHitThreshold: TILE_SIZE * 2 * 0.12,
  },
  cairo: {
    orientationSlot: null,
    editor: { ...AXIS_ALIGNED, axisAlignedGrid: false, rectCellsPerUnit: null, printCellSize: "diameter" },
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
  square_octagon: {
    orientationSlot: null,
    editor: { ...AXIS_ALIGNED, axisAlignedGrid: false, rectCellsPerUnit: null },
    orientations: [],
    defaultParams: {},
    // Every edge has world length 1, so a side is drawn `TILE_SIZE` long.
    pixelsPerUnit: TILE_SIZE,
    base: FLIP_Y,
    orientation: () => IDENTITY,
    // Half the 45 degree spacing of an octagon's faces.
    splitCircleRotationDeg: 22.5,
    equilateralSnap: null,
    cellSidePx: TILE_SIZE,
    // The octagon's circumcircle diameter, `1 / sin(22.5 degrees)` sides.
    cellMeasurePx: TILE_SIZE / Math.sin(Math.PI / 8),
    originCell: [0, 0],
    edgeHitThreshold: TILE_SIZE * 0.08,
  },
  brick: {
    orientationSlot: null,
    // A rect preset is `cols x rows` bricks, but odd rows shift half a cell, so it is not a
    // rectangle of exact width.
    editor: { ...AXIS_ALIGNED, axisAlignedGrid: false },
    orientations: [],
    defaultParams: {},
    // Bricks are unit squares, drawn `TILE_SIZE` wide.
    pixelsPerUnit: TILE_SIZE,
    base: FLIP_Y,
    orientation: () => IDENTITY,
    // The faces' neighbor directions are about 63 degrees apart at the top and bottom.
    splitCircleRotationDeg: 30,
    equilateralSnap: null,
    cellSidePx: TILE_SIZE,
    cellMeasurePx: TILE_SIZE,
    originCell: [0, 0],
    edgeHitThreshold: TILE_SIZE * 0.08,
  },
  trihexagonal: {
    orientationSlot: null,
    editor: { ...AXIS_ALIGNED, axisAlignedGrid: false, rectCellsPerUnit: null, printCellSize: "diameter" },
    orientations: [],
    defaultParams: {},
    // Every edge has world length 1, so a side is drawn `TILE_SIZE` long.
    pixelsPerUnit: TILE_SIZE,
    base: FLIP_Y,
    orientation: () => IDENTITY,
    // Half the 60 degree spacing of a hexagon's faces.
    splitCircleRotationDeg: 30,
    equilateralSnap: null,
    cellSidePx: TILE_SIZE,
    // The hexagon's circumcircle diameter, two sides.
    cellMeasurePx: TILE_SIZE * 2,
    originCell: [0, 0],
    edgeHitThreshold: TILE_SIZE * 0.08,
  },
  snub_hexagonal: {
    orientationSlot: null,
    editor: { ...AXIS_ALIGNED, axisAlignedGrid: false, rectCellsPerUnit: null, printCellSize: "diameter" },
    orientations: [],
    defaultParams: {},
    // Every edge has world length 1, so a side is drawn `TILE_SIZE` long.
    pixelsPerUnit: TILE_SIZE,
    base: FLIP_Y,
    orientation: () => IDENTITY,
    // Half the 60 degree spacing of a hexagon's faces.
    splitCircleRotationDeg: 30,
    equilateralSnap: null,
    cellSidePx: TILE_SIZE,
    // The hexagon's circumcircle diameter, two sides.
    cellMeasurePx: TILE_SIZE * 2,
    originCell: [0, 0],
    edgeHitThreshold: TILE_SIZE * 0.08,
  },
  rhombitrihexagonal: {
    orientationSlot: null,
    editor: { ...AXIS_ALIGNED, axisAlignedGrid: false, rectCellsPerUnit: null, printCellSize: "diameter" },
    orientations: [],
    defaultParams: {},
    // Every edge has world length 1, so a side is drawn `TILE_SIZE` long.
    pixelsPerUnit: TILE_SIZE,
    base: FLIP_Y,
    orientation: () => IDENTITY,
    // Half the 60 degree spacing of a hexagon's faces.
    splitCircleRotationDeg: 30,
    equilateralSnap: null,
    cellSidePx: TILE_SIZE,
    // The hexagon's circumcircle diameter, two sides.
    cellMeasurePx: TILE_SIZE * 2,
    originCell: [0, 0],
    edgeHitThreshold: TILE_SIZE * 0.08,
  },
};
