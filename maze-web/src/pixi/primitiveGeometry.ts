import { cellsInsideShape, polygonForShape, shapeForPrimitive, type PrimitiveShape } from "./shapeSelection";
import { makeProjection } from "./tessellationProjection";
import { TILE_SIZE } from "./constants";
import { getCellNeighborOffsets } from "./tessellationGeometry";
import { TESSELLATION_UI, isIdentityLinear } from "./geometry/tessellationUi";
import { kindFieldConfig, type FieldConfig } from "../fieldConfig";
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
  symmetric?: boolean;
  constrainSquare?: boolean;
}

export type ShapePrimitive = PrimitiveShape;
export type WorldPoint = { x: number; y: number };

export type PrimitiveWorldGeometry =
  | {
      kind: "boundary";
      segments: Array<[WorldPoint, WorldPoint]>;
      /** Edge-connected component id per segment; keeps corner-touching cells in separate contours. */
      components?: number[];
      /** Optional fill style for temporary cells rendered with the boundary. */
      cellColor?: number;
      cellAlpha?: number;
    }
  | {
      kind: "polygon";
      points: WorldPoint[];
      /** Number of points already committed by the user (the rest may be the cursor preview). */
      vertexCount?: number;
      /** Draw the segment from the cursor preview back to the first vertex as a dashed line. */
      dashedClosing?: boolean;
      /** Draw the segment from the last point back to the first one in the same style as the rest. */
      closed?: boolean;
      /** Draw every polygon segment as a dashed line while the polygon is being edited. */
      dashedAll?: boolean;
      /** Optional frame color for a tool-specific polygon overlay. */
      frameColor?: number;
      /** Optional fill color for the cells covered by this polygon. */
      cellColor?: number;
      cellAlpha?: number;
    }
  | { kind: "ellipse"; center: WorldPoint; width: number; height: number; dashed?: boolean };

function contextConfig(ctx: PrimitiveContext): FieldConfig {
  return ctx.config ?? kindFieldConfig(ctx.kind);
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

function worldFrame(ctx: PrimitiveContext, config: FieldConfig): WorldFrame {
  const start = ctx.startWorld ?? worldPoint(config, ctx.startGrid);
  const draggedEnd = ctx.endWorld ?? worldPoint(config, ctx.endGrid);
  const dx = draggedEnd.x - start.x;
  const dy = draggedEnd.y - start.y;
  const rawWidth = Math.max(TILE_SIZE, Math.abs(dx) + TILE_SIZE);
  const rawHeight = Math.max(TILE_SIZE, Math.abs(dy) + TILE_SIZE);

  if (ctx.symmetric) {
    const symmetricWidth = Math.max(TILE_SIZE, Math.abs(dx) * 2 + TILE_SIZE);
    const symmetricHeight = Math.max(TILE_SIZE, Math.abs(dy) * 2 + TILE_SIZE);
    const side = ctx.constrainSquare ? Math.min(symmetricWidth, symmetricHeight) : undefined;
    const width = side ?? symmetricWidth;
    const height = side ?? symmetricHeight;
    return {
      start,
      origin: start,
      width,
      height,
      directionX: dx < 0 ? -1 : 1,
      directionY: dy < 0 ? -1 : 1,
    };
  }

  const side = ctx.constrainSquare ? Math.min(rawWidth, rawHeight) : undefined;
  const width = side ?? rawWidth;
  const height = side ?? rawHeight;
  const end = side === undefined
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
  const config = contextConfig(ctx);
  const ui = TESSELLATION_UI[ctx.kind].editor;
  if (primitive === "hexagon") {
    const { shape, origin } = hexagonDragShape(ctx, config);
    return cellsInsideShape(config, shape, "center", origin);
  }
  if (primitive === "equilateral_triangle") {
    const { shape, origin } = equilateralTriangleDragShape(ctx, config);
    return cellsInsideShape(config, shape, "center", origin);
  }
  const frame = worldFrame(ctx, config);
  const width = frame.width / TILE_SIZE;
  const height = frame.height / TILE_SIZE;

  const shape = shapeForPrimitive(primitive, {
    width,
    height,
    directionX: frame.directionX,
    directionY: frame.directionY,
  });
  const inclusion = primitive === "circle" ? ui.circleInclusion : "center";
  return cellsInsideShape(config, shape, inclusion, frame.origin);
}

/** The drag start, the pointer distance from it, and the pointer direction snapped to the lattice
 * (`idleAngle` while the pointer has not left the start). */
function snappedDrag(ctx: PrimitiveContext, config: FieldConfig, idleAngle: number) {
  const dragStart = ctx.startWorld ?? worldPoint(config, ctx.startGrid);
  const pointer = ctx.endWorld ?? worldPoint(config, ctx.endGrid);
  const dx = pointer.x - dragStart.x;
  const dy = pointer.y - dragStart.y;
  const distance = Math.hypot(dx, dy);
  const rawAngle = distance > 1e-7 ? Math.atan2(dy, dx) : idleAngle;
  return { dragStart, distance, angle: snapEquilateralAngle(rawAngle, config) };
}

/** Builds an equilateral triangle from its base center (drag start) to its apex (pointer). */
function equilateralTriangleDragShape(ctx: PrimitiveContext, config: FieldConfig) {
  const { dragStart, distance, angle } = snappedDrag(ctx, config, -Math.PI / 2);
  const directionX = Math.cos(angle);
  const directionY = Math.sin(angle);
  // Shift centers the triangle: the drag start is its centroid and the pointer drives the apex
  // (circumradius), so the start stays fixed whatever the angle.
  const centered = ctx.symmetric === true;
  const height = centered ? Math.max(TILE_SIZE, distance) * 1.5 : Math.max(TILE_SIZE, distance);
  const start = centered
    ? { x: dragStart.x - directionX * height / 3, y: dragStart.y - directionY * height / 3 }
    : dragStart;
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

/** Builds a regular hexagon from the drag start to the pointer: they are opposite vertices, so the
 * shape grows to one side. With `symmetric` the start is the center and the pointer drives a vertex. */
function hexagonDragShape(ctx: PrimitiveContext, config: FieldConfig) {
  const { dragStart, distance, angle } = snappedDrag(ctx, config, hexShapeIsPointy(config) ? Math.PI / 2 : 0);
  const radius = ctx.symmetric ? Math.max(TILE_SIZE, distance) : Math.max(TILE_SIZE, distance) / 2;
  const start = ctx.symmetric
    ? dragStart
    : { x: dragStart.x + Math.cos(angle) * radius, y: dragStart.y + Math.sin(angle) * radius };
  const polygon = Array.from({ length: 6 }, (_, i) => ({
    x: radius * Math.cos(angle + i * Math.PI / 3) / TILE_SIZE,
    y: radius * Math.sin(angle + i * Math.PI / 3) / TILE_SIZE,
  }));
  return {
    shape: { kind: "hexagon" as const, radius: radius / TILE_SIZE, polygon },
    origin: start,
  };
}

/** A hexagon-of-cells outline has points on the vertical axis while the display orientation is the
 *  identity, and is turned a sixth of a revolution with any other instance of it. */
function hexShapeIsPointy(config: FieldConfig): boolean {
  return isIdentityLinear(TESSELLATION_UI[config.tessellation.kind].orientation(config.orientation));
}

export function snapEquilateralAngle(angle: number, config: FieldConfig): number {
  const ui = TESSELLATION_UI[config.tessellation.kind];
  if (!ui.equilateralSnap) return angle;
  // The canonical snap directions turned by the display orientation: a tri lattice can point a
  // triangle along either normal of its three edge families (six directions), and the display
  // orientation picks the first of them; it must not turn the snap into four right angles.
  const { step, offset: canonical } = ui.equilateralSnap;
  const o = ui.orientation(config.orientation);
  const offset = Math.atan2(
    o.b * Math.cos(canonical) + o.d * Math.sin(canonical),
    o.a * Math.cos(canonical) + o.c * Math.sin(canonical),
  );
  const snapped = offset + Math.round((angle - offset) / step) * step;
  const difference = Math.atan2(Math.sin(angle - snapped), Math.cos(angle - snapped));
  return Math.abs(difference) <= Math.PI / 30 ? snapped : angle;
}

/** The single normalization routine for every tool. Repeats isolated-cell removal (and, with
 * `smooth`, single-connection removal) until stable, so peeling one spike cannot expose a new one. Cells in `anchors` (already part of the field) count
 * as neighbors but are never removed (only `cells` are filtered). */
export function normalizeCells(
  cells: [number, number][],
  cfg: FieldConfig,
  smooth: boolean,
  isAnchor?: (x: number, y: number) => boolean,
): [number, number][] {
  let result = cells;
  for (;;) {
    // Smoothing needs at least four cells to leave a meaningful shape.
    const minLinks = smooth && result.length >= 4 ? 2 : 1;
    const present = new Set(result.map(([x, y]) => `${x},${y}`));
    const next = result.filter(([x, y]) => {
      let links = 0;
      for (const [dx, dy] of getCellNeighborOffsets(cfg, x, y)) {
        if (present.has(`${x + dx},${y + dy}`) || isAnchor?.(x + dx, y + dy)) links++;
      }
      return links >= minLinks;
    });
    if (next.length === result.length) return result;
    result = next;
  }
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
  if (primitive === "hexagon") {
    const { shape, origin } = hexagonDragShape(ctx, config);
    const polygon = polygonForShape(shape)!;
    return {
      kind: "polygon",
      points: polygon.map((point) => ({ x: origin.x + point.x * TILE_SIZE, y: origin.y + point.y * TILE_SIZE })),
    };
  }
  const frame = worldFrame(ctx, config);
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

  return { kind: "polygon", points: rectanglePoints(frame.origin, width / 2, height / 2) };
}

function rectangleBounds(start: WorldPoint, end: WorldPoint): { origin: WorldPoint; width: number; height: number } {
  return {
    origin: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
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

