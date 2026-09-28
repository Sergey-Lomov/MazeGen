import { cellsInsideShape, polygonForShape, shapeForPrimitive, type PrimitiveShape } from "./shapeSelection";
import { makeProjection } from "./tessellationProjection";
import { TILE_SIZE } from "./constants";
import { triCenterOffset, triHexagonRaw, triTriangleRaw } from "./triShapeHelpers";
import type { FieldConfig } from "../fieldConfig";
import type { TessellationKind } from "../store/mazeStore";

export type { TessellationKind };

export interface PrimitiveContext {
  startGrid: { x: number; y: number };
  endGrid: { x: number; y: number };
  startWorld?: WorldPoint;
  endWorld?: WorldPoint;
  gridRadius: number;
  kind: TessellationKind;
  config?: FieldConfig;
  /** Discrete side length for a lattice-aligned equilateral triangle. */
  latticeSide?: number;
  /** Discrete radius for a centered standard primitive. */
  latticeRadius?: number;
  symmetric?: boolean;
  constrainSquare?: boolean;
}

export type ShapePrimitive = PrimitiveShape;
type WorldPoint = { x: number; y: number };

export type PrimitiveWorldGeometry =
  | { kind: "polygon"; points: WorldPoint[] }
  | { kind: "ellipse"; center: WorldPoint; width: number; height: number };

function contextConfig(ctx: PrimitiveContext): FieldConfig {
  if (ctx.config) return ctx.config;
  return ctx.kind === "square"
    ? { type: "square", width: 0, height: 0 }
    : ctx.kind === "hex"
      ? { type: "hex_hexagon", radius: 0 }
      : { type: "triangle_rect", cols: 0, rows: 0 };
}

function worldPoint(config: FieldConfig, point: { x: number; y: number }): WorldPoint {
  const screen = makeProjection(config).gridToScreen(point.x, point.y);
  return { x: screen.x, y: -screen.y };
}

interface WorldFrame {
  start: WorldPoint;
  origin: WorldPoint;
  width: number;
  height: number;
  directionX: -1 | 1;
  directionY: -1 | 1;
}

function worldFrame(ctx: PrimitiveContext, config: FieldConfig, primitive?: ShapePrimitive): WorldFrame {
  const start = ctx.startWorld ?? worldPoint(config, ctx.startGrid);
  const draggedEnd = ctx.endWorld ?? worldPoint(config, ctx.endGrid);
  const dx = draggedEnd.x - start.x;
  const dy = draggedEnd.y - start.y;
  const rawWidth = Math.max(TILE_SIZE, Math.abs(dx) + TILE_SIZE);
  const rawHeight = Math.max(TILE_SIZE, Math.abs(dy) + TILE_SIZE);

  if (ctx.symmetric) {
    const symmetricWidth = Math.max(TILE_SIZE, Math.abs(dx) * 2 + TILE_SIZE);
    const symmetricHeight = Math.max(TILE_SIZE, Math.abs(dy) * 2 + TILE_SIZE);
    const constrained = ctx.constrainSquare && primitive === "parallelogram"
      ? equalSideParallelogramFrame(symmetricWidth, symmetricHeight)
      : ctx.constrainSquare && primitive === "hexagon"
        ? regularHexagonFrame(symmetricWidth, symmetricHeight, config)
        : undefined;
    const side = ctx.constrainSquare ? Math.min(symmetricWidth, symmetricHeight) : undefined;
    const width = constrained?.width ?? side ?? symmetricWidth;
    const height = constrained?.height ?? side ?? symmetricHeight;
    return {
      start,
      origin: start,
      width,
      height,
      directionX: dx < 0 ? -1 : 1,
      directionY: dy < 0 ? -1 : 1,
    };
  }

  const constrained = ctx.constrainSquare && primitive === "parallelogram"
    ? equalSideParallelogramFrame(rawWidth, rawHeight)
    : ctx.constrainSquare && primitive === "hexagon"
      ? regularHexagonFrame(rawWidth, rawHeight, config)
      : undefined;
  const side = ctx.constrainSquare ? Math.min(rawWidth, rawHeight) : undefined;
  const width = constrained?.width ?? side ?? rawWidth;
  const height = constrained?.height ?? side ?? rawHeight;
  const end = constrained
      ? { x: start.x + Math.sign(dx) * Math.max(0, width - TILE_SIZE), y: start.y + Math.sign(dy) * Math.max(0, height - TILE_SIZE) }
      : side === undefined
        ? draggedEnd
        : { x: start.x + Math.sign(dx) * Math.max(0, side - TILE_SIZE), y: start.y + Math.sign(dy) * Math.max(0, side - TILE_SIZE) };
  return {
    start,
    origin: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
    width,
    height,
    directionX: dx < 0 ? -1 : 1,
    directionY: dy < 0 ? -1 : 1,
  };
}

export function primitiveCells(primitive: ShapePrimitive, ctx: PrimitiveContext): [number, number][] {
  if (primitive === "equilateral_triangle" && ctx.kind === "triangle" && ctx.latticeSide !== undefined) {
    return centeredTriangularTriangle(ctx.latticeSide);
  }
  const config = contextConfig(ctx);
  if (primitive === "hexagon" && ctx.kind === "hex" && (ctx.latticeRadius !== undefined || (ctx.symmetric && ctx.constrainSquare))) {
    const radius = ctx.latticeRadius ?? centeredHexRadius(worldFrame(ctx, config, primitive), config);
    return translateCells(centeredHexagon(radius), ctx.startGrid);
  }
  if (primitive === "hexagon" && ctx.kind === "triangle" && (ctx.latticeRadius !== undefined || (ctx.symmetric && ctx.constrainSquare))) {
    const frame = worldFrame(ctx, config, primitive);
    const radius = ctx.latticeRadius ?? Math.max(1, Math.round(frame.height / TILE_SIZE / 4));
    return translateCells(centeredTriangularHexagon(radius), ctx.startGrid);
  }
  if (primitive === "equilateral_triangle") {
    const { shape, origin } = equilateralTriangleDragShape(ctx, config);
    return cellsInsideShape(config, shape, "center", origin);
  }
  const frame = worldFrame(ctx, config, primitive);
  const width = frame.width / TILE_SIZE;
  const height = frame.height / TILE_SIZE;

  const shape = shapeForPrimitive(primitive, config, {
    width,
    height,
    ...(ctx.latticeRadius !== undefined ? { radius: ctx.latticeRadius } : {}),
    directionX: frame.directionX,
    directionY: frame.directionY,
    anchorStart: primitive === "hexagon" && !ctx.symmetric,
    startOffsetX: (frame.start.x - frame.origin.x) / TILE_SIZE,
    startOffsetY: (frame.start.y - frame.origin.y) / TILE_SIZE,
  });
  const inclusion = primitive === "circle" && ctx.kind === "triangle" ? "contained" : "center";
  return cellsInsideShape(config, shape, inclusion, frame.origin);
}

/** Exact lattice rasterization for the predefined triangular field shape. Each increment of the
 * side adds one complete row, so every integer size has its own smooth triangular boundary. */
function centeredTriangularTriangle(side: number): [number, number][] {
  const raw = triTriangleRaw(Math.max(1, Math.floor(side)));
  const { ox, oy } = triCenterOffset(raw);
  return raw.map(([x, y]) => [x - ox, y - oy]);
}

/** Exact lattice rasterization for a regular hexagon on the triangular grid. */
function centeredTriangularHexagon(radius: number): [number, number][] {
  const raw = triHexagonRaw(Math.max(1, Math.floor(radius)));
  const { ox, oy } = triCenterOffset(raw);
  return raw.map(([x, y]) => [x - ox, y - oy]);
}

function translateCells(cells: [number, number][], offset: { x: number; y: number }): [number, number][] {
  return cells.map(([x, y]) => [x + offset.x, y + offset.y]);
}

/** Builds an equilateral triangle from its base center (drag start) to its apex (pointer). */
function equilateralTriangleDragShape(ctx: PrimitiveContext, config: FieldConfig) {
  const start = ctx.startWorld ?? worldPoint(config, ctx.startGrid);
  const pointer = ctx.endWorld ?? worldPoint(config, ctx.endGrid);
  const dx = pointer.x - start.x;
  const dy = pointer.y - start.y;
  const distance = Math.hypot(dx, dy);
  const height = Math.max(TILE_SIZE, distance);
  const rawAngle = distance > 1e-7 ? Math.atan2(dy, dx) : -Math.PI / 2;
  const angle = snapEquilateralAngle(rawAngle, config);
  const directionX = Math.cos(angle);
  const directionY = Math.sin(angle);
  const perpendicularX = -directionY;
  const perpendicularY = directionX;
  const halfBase = height / Math.sqrt(3);
  const baseA = { x: -perpendicularX * halfBase / TILE_SIZE, y: -perpendicularY * halfBase / TILE_SIZE };
  const baseB = { x: perpendicularX * halfBase / TILE_SIZE, y: perpendicularY * halfBase / TILE_SIZE };
  const apex = { x: directionX * height / TILE_SIZE, y: directionY * height / TILE_SIZE };
  return {
    shape: { kind: "triangle" as const, side: 1, polygon: [baseA, baseB, apex] },
    origin: start,
  };
}

function snapEquilateralAngle(angle: number, config: FieldConfig): number {
  let step: number;
  let offset: number;
  if (config.type === "hex_hexagon" || config.type === "hex_rectangle"
    || config.type === "hex_circle" || config.type === "hex_triangle"
    || config.type === "hex_parallelogram" || config.type === "hex_custom") {
    step = Math.PI / 3;
    offset = config.orientation === "pointy_top" ? 0 : Math.PI / 6;
  } else if (config.type === "square" || config.type === "square_circle"
    || config.type === "square_triangle" || config.type === "square_custom") {
    step = Math.PI / 2;
    offset = -Math.PI / 2;
  } else if (config.type === "triangle_rect" || config.type === "triangle_triangle"
    || config.type === "triangle_circle" || config.type === "triangle_hexagon"
    || config.type === "tri_custom") {
    // An equilateral triangle can point along either normal of each of the
    // three edge families in the triangular lattice: six directions total.
    // The tessellation orientation selects the first direction in that set;
    // it must not turn the snap into four right angles.
    step = Math.PI / 3;
    offset = ({ r0: -Math.PI / 2, r90: 0, r180: Math.PI / 2, r270: Math.PI } as const)[config.orientation ?? "r0"];
  } else {
    return angle;
  }
  const snapped = offset + Math.round((angle - offset) / step) * step;
  const difference = Math.atan2(Math.sin(angle - snapped), Math.cos(angle - snapped));
  return Math.abs(difference) <= Math.PI / 30 ? snapped : angle;
}

/** Exact axial rasterization for a regular hexagon on a hexagonal grid. */
function centeredHexagon(radius: number): [number, number][] {
  const r = Math.max(1, Math.floor(radius));
  const cells: [number, number][] = [];
  for (let q = -r; q <= r; q++) {
    for (let row = -r; row <= r; row++) {
      if (Math.max(Math.abs(q), Math.abs(row), Math.abs(q + row)) <= r) cells.push([q, row]);
    }
  }
  return cells;
}

function centeredHexRadius(frame: WorldFrame, config: FieldConfig): number {
  const orientation = (config as { orientation?: string }).orientation;
  const diameter = orientation === "pointy_top" ? frame.width : frame.height;
  return Math.max(1, Math.round(diameter / TILE_SIZE / 4));
}

/** Removes one-cell-wide terminal spikes from a primitive result. */
export function smoothPrimitiveCells(
  cells: [number, number][],
  kind: TessellationKind,
): [number, number][] {
  if (cells.length < 4) return cells;
  const selected = new Set(cells.map(([x, y]) => `${x},${y}`));
  const offsets = kind === "square"
    ? [[1, 0], [-1, 0], [0, 1], [0, -1]]
    : kind === "hex"
      ? [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]]
      : undefined;

  return cells.filter(([x, y]) => {
    const neighbors = offsets ?? ((x + y) % 2 === 0
      ? [[-1, 0], [1, 0], [0, -1]]
      : [[-1, 0], [1, 0], [0, 1]]);
    let count = 0;
    for (const [dx, dy] of neighbors) if (selected.has(`${x + dx},${y + dy}`)) count++;
    return count !== 1;
  });
}

export function normalizePrimitiveCells(
  cells: [number, number][],
  kind: TessellationKind,
  smooth: boolean,
): [number, number][] {
  let result = removeIsolatedPrimitiveCells(cells, kind);
  if (smooth) result = smoothPrimitiveCells(result, kind);
  return removeIsolatedPrimitiveCells(result, kind);
}

function removeIsolatedPrimitiveCells(cells: [number, number][], kind: TessellationKind): [number, number][] {
  // Fewer than two cells cannot contain an accidental isolated cell. This preserves a valid
  // one-cell primitive such as a 1×1 rectangle.
  if (cells.length < 2) return cells;
  const selected = new Set(cells.map(([x, y]) => `${x},${y}`));
  return cells.filter(([x, y]) => primitiveNeighborOffsets(kind, x, y)
    .some(([dx, dy]) => selected.has(`${x + dx},${y + dy}`)));
}

function primitiveNeighborOffsets(kind: TessellationKind, x: number, y: number): number[][] {
  if (kind === "square") return [[1, 0], [-1, 0], [0, 1], [0, -1]];
  if (kind === "hex") return [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
  return (x + y) % 2 === 0
    ? [[-1, 0], [1, 0], [0, -1]]
    : [[-1, 0], [1, 0], [0, 1]];
}

export function primitiveWorldGeometry(primitive: ShapePrimitive, ctx: PrimitiveContext): PrimitiveWorldGeometry {
  const config = contextConfig(ctx);
  if (primitive === "equilateral_triangle") {
    const { shape, origin } = equilateralTriangleDragShape(ctx, config);
    const polygon = polygonForShape(shape)!;
    return {
      kind: "polygon",
      points: polygon.map((point) => ({ x: origin.x + point.x * TILE_SIZE, y: origin.y + point.y * TILE_SIZE })),
    };
  }
  const frame = worldFrame(ctx, config, primitive);
  const width = frame.width;
  const height = frame.height;

  if (primitive === "circle") return { kind: "ellipse", center: frame.origin, width, height };

  if (primitive === "rectangle" && !ctx.constrainSquare) {
    const bounds = visualFrame(ctx, config, frame);
    return { kind: "polygon", points: rectanglePoints(bounds.origin, bounds.width / 2, bounds.height / 2) };
  }

  if (primitive === "triangle") {
    return {
      kind: "polygon",
      points: [
        { x: frame.origin.x - frame.directionX * width / 2, y: frame.origin.y - frame.directionY * height / 2 },
        { x: frame.origin.x + frame.directionX * width / 2, y: frame.origin.y - frame.directionY * height / 2 },
        { x: frame.origin.x - frame.directionX * width / 2, y: frame.origin.y + frame.directionY * height / 2 },
      ],
    };
  }

  const halfWidth = width / 2;
  const halfHeight = height / 2;
  if (primitive === "rectangle") {
    return { kind: "polygon", points: rectanglePoints(frame.origin, halfWidth, halfHeight) };
  }
  if (primitive === "parallelogram") {
    const bounds = visualFrame(ctx, config, frame);
    const skew = parallelogramSkewSign(frame) * bounds.height / (2 * Math.sqrt(3));
    const halfBase = Math.max(0, bounds.width / 2 - Math.abs(skew));
    return {
      kind: "polygon",
      points: [
        { x: bounds.origin.x - halfBase - skew, y: bounds.origin.y - bounds.height / 2 },
        { x: bounds.origin.x + halfBase - skew, y: bounds.origin.y - bounds.height / 2 },
        { x: bounds.origin.x + halfBase + skew, y: bounds.origin.y + bounds.height / 2 },
        { x: bounds.origin.x - halfBase + skew, y: bounds.origin.y + bounds.height / 2 },
      ],
    };
  }

  const shape = shapeForPrimitive("hexagon", config, {
    width: width / TILE_SIZE,
    height: height / TILE_SIZE,
    directionX: frame.directionX,
    directionY: frame.directionY,
    anchorStart: !ctx.symmetric,
    startOffsetX: (frame.start.x - frame.origin.x) / TILE_SIZE,
    startOffsetY: (frame.start.y - frame.origin.y) / TILE_SIZE,
  });
  const polygon = polygonForShape(shape)!;
  return {
    kind: "polygon",
    points: polygon.map((point) => ({ x: frame.origin.x + point.x * TILE_SIZE, y: frame.origin.y + point.y * TILE_SIZE })),
  };
}

function rectangleBounds(start: WorldPoint, end: WorldPoint): { origin: WorldPoint; width: number; height: number } {
  return {
    origin: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

function equalSideParallelogramFrame(width: number, height: number): { width: number; height: number } {
  const axisRatio = Math.sqrt(3);
  const sideHeight = Math.max(TILE_SIZE, Math.min(height, width / axisRatio));
  return { width: axisRatio * sideHeight, height: sideHeight };
}

function regularHexagonFrame(width: number, height: number, config: FieldConfig): { width: number; height: number } {
  const diameter = Math.max(TILE_SIZE, Math.min(width, height));
  const tessellationOrientation = (config as { orientation?: string }).orientation;
  const primitiveOrientation = tessellationOrientation === "pointy_top" ? "flat_top" : "pointy_top";
  return primitiveOrientation === "pointy_top"
    ? { width: diameter * Math.sqrt(3) / 2, height: diameter }
    : { width: diameter, height: diameter * Math.sqrt(3) / 2 };
}

function parallelogramSkewSign(frame: WorldFrame): -1 | 1 {
  return frame.directionX === frame.directionY ? 1 : -1;
}

function visualFrame(ctx: PrimitiveContext, config: FieldConfig, frame: WorldFrame): { origin: WorldPoint; width: number; height: number } {
  if (ctx.constrainSquare) return { origin: frame.origin, width: frame.width, height: frame.height };
  const start = ctx.startWorld ?? worldPoint(config, ctx.startGrid);
  const end = ctx.endWorld ?? worldPoint(config, ctx.endGrid);
  return ctx.symmetric
    ? { origin: start, width: Math.abs(end.x - start.x) * 2, height: Math.abs(end.y - start.y) * 2 }
    : rectangleBounds(start, end);
}

function rectanglePoints(origin: WorldPoint, halfWidth: number, halfHeight: number): WorldPoint[] {
  return [
    { x: origin.x - halfWidth, y: origin.y - halfHeight },
    { x: origin.x + halfWidth, y: origin.y - halfHeight },
    { x: origin.x + halfWidth, y: origin.y + halfHeight },
    { x: origin.x - halfWidth, y: origin.y + halfHeight },
  ];
}

export function cfgKind(cfgType: string): TessellationKind {
  if (cfgType.startsWith("hex")) return "hex";
  if (cfgType.startsWith("tri")) return "triangle";
  return "square";
}
