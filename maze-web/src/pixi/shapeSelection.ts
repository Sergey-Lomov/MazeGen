import type { FieldConfig } from "../fieldConfig";
import type { Linear } from "./geometry/tessellationUi";
import { TILE_SIZE } from "./constants";
import { makeProjection } from "./tessellationProjection";
import { originCellOf } from "./splitPatternTile";
import { cellsInDisplayRect, getCellVertices as geometryCellVertices } from "./tessellationGeometry";

export type ShapeKind = "rectangle" | "circle" | "triangle" | "hexagon";
export type ShapeInclusion = "center" | "contained";
export interface ShapeOrigin { x: number; y: number }
export type PrimitiveShape = "rectangle" | "circle" | "triangle" | "equilateral_triangle" | "hexagon";
export interface PrimitiveShapeGeometry {
  width: number;
  height: number;
  directionX?: -1 | 1;
  directionY?: -1 | 1;
  polygon?: Point[];
}

export type ShapeDefinition =
  | { kind: "rectangle"; width: number; height: number }
  | { kind: "circle"; radius: number; width?: number; height?: number }
  | { kind: "triangle"; side: number; width?: number; height?: number; orientation?: Linear; polygon?: Point[] }
  | { kind: "hexagon"; radius: number; width?: number; height?: number; orientation?: "flat_top" | "pointy_top"; polygon?: Point[] };

type Point = { x: number; y: number };
const BOUNDARY_EPSILON_PX = 0.25;

export function shapeForPrimitive(
  primitive: Exclude<PrimitiveShape, "equilateral_triangle" | "hexagon">,
  geometry: PrimitiveShapeGeometry,
): ShapeDefinition {
  if (primitive === "rectangle") return { kind: "rectangle", width: geometry.width, height: geometry.height };
  if (primitive === "circle") {
    return { kind: "circle", radius: Math.max(geometry.width, geometry.height) / 2, width: geometry.width, height: geometry.height };
  }
  return {
    kind: "triangle",
    side: 1,
    polygon: geometry.polygon ?? [
      { x: -(geometry.directionX ?? 1) * geometry.width / 2, y: -(geometry.directionY ?? 1) * geometry.height / 2 },
      { x: (geometry.directionX ?? 1) * geometry.width / 2, y: -(geometry.directionY ?? 1) * geometry.height / 2 },
      { x: -(geometry.directionX ?? 1) * geometry.width / 2, y: (geometry.directionY ?? 1) * geometry.height / 2 },
    ],
  };
}

export function regularHexagonDimensions(radius: number, orientation: "flat_top" | "pointy_top"): { width: number; height: number } {
  return orientation === "pointy_top"
    ? { width: radius * Math.sqrt(3), height: radius * 2 }
    : { width: radius * 2, height: radius * Math.sqrt(3) };
}

function hexDimensions(shape: Extract<ShapeDefinition, { kind: "hexagon" }>): { width: number; height: number } {
  if (shape.width !== undefined || shape.height !== undefined) {
    return {
      width: shape.width ?? shape.radius * 2,
      height: shape.height ?? shape.radius * Math.sqrt(3),
    };
  }
  return regularHexagonDimensions(shape.radius, shape.orientation ?? "flat_top");
}

function shapeBounds(shape: ShapeDefinition): { minX: number; maxX: number; minY: number; maxY: number } {
  switch (shape.kind) {
    case "rectangle":
      return { minX: -shape.width / 2, maxX: shape.width / 2, minY: -shape.height / 2, maxY: shape.height / 2 };
    case "circle":
      return { minX: -(shape.width ?? shape.radius * 2) / 2, maxX: (shape.width ?? shape.radius * 2) / 2, minY: -(shape.height ?? shape.radius * 2) / 2, maxY: (shape.height ?? shape.radius * 2) / 2 };
    case "triangle": {
      if (shape.polygon) {
        const xs = shape.polygon.map((point) => point.x);
        const ys = shape.polygon.map((point) => point.y);
        return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
      }
      const width = shape.width ?? shape.side;
      const height = shape.height ?? shape.side * Math.sqrt(3) / 2;
      return { minX: -width / 2, maxX: width / 2, minY: -height * 2 / 3, maxY: height / 3 };
    }
    case "hexagon": {
      if (shape.polygon) {
        const xs = shape.polygon.map((point) => point.x);
        const ys = shape.polygon.map((point) => point.y);
        return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
      }
      const { width, height } = hexDimensions(shape);
      return { minX: -width / 2, maxX: width / 2, minY: -height / 2, maxY: height / 2 };
    }
  }
}

function pointInTriangle(p: Point, a: Point, b: Point, c: Point): boolean {
  const sign = (p1: Point, p2: Point, p3: Point) =>
    (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
  const d1 = sign(p, a, b);
  const d2 = sign(p, b, c);
  const d3 = sign(p, c, a);
  const edgeLength = (p1: Point, p2: Point) => Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const e1 = BOUNDARY_EPSILON_PX * edgeLength(a, b);
  const e2 = BOUNDARY_EPSILON_PX * edgeLength(b, c);
  const e3 = BOUNDARY_EPSILON_PX * edgeLength(c, a);
  return !((d1 < -e1 || d2 < -e2 || d3 < -e3)
    && (d1 > e1 || d2 > e2 || d3 > e3));
}

function edgeSignedDistance(point: Point, a: Point, b: Point): number {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length === 0) return 0;
  return ((b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x)) / length;
}

export function polygonForShape(shape: ShapeDefinition): Point[] | null {
  switch (shape.kind) {
    case "rectangle": {
      const { width, height } = shape;
      return [
        { x: -width / 2, y: -height / 2 },
        { x: width / 2, y: -height / 2 },
        { x: width / 2, y: height / 2 },
        { x: -width / 2, y: height / 2 },
      ];
    }
    case "triangle": {
      if (shape.polygon) return shape.polygon;
      const width = shape.width ?? shape.side;
      const height = shape.height ?? shape.side * Math.sqrt(3) / 2;
      const o = shape.orientation;
      const rotatePoint = (point: Point): Point =>
        o ? { x: o.a * point.x + o.c * point.y, y: o.b * point.x + o.d * point.y } : point;
      return [
        { x: 0, y: -height * 2 / 3 },
        { x: width / 2, y: height / 3 },
        { x: -width / 2, y: height / 3 },
      ].map(rotatePoint);
    }
    case "hexagon": {
      if (shape.polygon) return shape.polygon;
      const startAngle = shape.orientation === "pointy_top" ? Math.PI / 2 : 0;
      const { width, height } = hexDimensions(shape);
      return Array.from({ length: 6 }, (_, i) => {
        const angle = startAngle + i * Math.PI / 3;
        return { x: width / 2 * Math.cos(angle), y: height / 2 * Math.sin(angle) };
      });
    }
    case "circle":
      return null;
  }
}

function containsPoint(shape: ShapeDefinition, point: Point): boolean {
  switch (shape.kind) {
    case "rectangle":
      return Math.abs(point.x) <= shape.width / 2 + BOUNDARY_EPSILON_PX
        && Math.abs(point.y) <= shape.height / 2 + BOUNDARY_EPSILON_PX;
    case "circle":
      {
        const rx = (shape.width ?? shape.radius * 2) / 2;
        const ry = (shape.height ?? shape.radius * 2) / 2;
        const scale = 1 + BOUNDARY_EPSILON_PX / Math.min(rx, ry);
        return (point.x / rx) ** 2 + (point.y / ry) ** 2 <= scale ** 2;
      }
    case "triangle": {
      const vertices = polygonForShape(shape)!;
      return pointInTriangle(point, vertices[0], vertices[1], vertices[2]);
    }
    case "hexagon": {
      const vertices = polygonForShape(shape)!;
      for (let i = 0; i < vertices.length; i++) {
        const a = vertices[i];
        const b = vertices[(i + 1) % vertices.length];
        if (edgeSignedDistance(point, a, b) < -BOUNDARY_EPSILON_PX) return false;
      }
      return true;
    }
  }
}

function containsCell(shape: ShapeDefinition, vertices: Point[]): boolean {
  if (shape.kind === "circle") {
    const rx = (shape.width ?? shape.radius * 2) / 2 + BOUNDARY_EPSILON_PX;
    const ry = (shape.height ?? shape.radius * 2) / 2 + BOUNDARY_EPSILON_PX;
    return vertices.every((p) => (p.x / rx) ** 2 + (p.y / ry) ** 2 <= 1);
  }
  return vertices.every((p) => containsPoint(shape, p));
}

function candidateCells(cfg: FieldConfig, shape: ShapeDefinition, origin: Point): [number, number][] {
  const b = shapeBounds(shape);
  // Shape coordinates are Y-up; display space is Y-down.
  const y0 = -(b.minY + origin.y), y1 = -(b.maxY + origin.y);
  return cellsInDisplayRect({
    minX: b.minX + origin.x,
    maxX: b.maxX + origin.x,
    minY: Math.min(y0, y1),
    maxY: Math.max(y0, y1),
  }, "intersects", cfg);
}

function cellCenter(projection: ReturnType<typeof makeProjection>, origin: Point, x: number, y: number): Point {
  const point = projection.gridToScreen(x, y);
  return { x: point.x - origin.x, y: -point.y - origin.y };
}

function cellVertices(cfg: FieldConfig, origin: Point, x: number, y: number): Point[] {
  return geometryCellVertices(x, y, cfg).map((point) => ({
    x: point.x - origin.x,
    y: -point.y - origin.y,
  }));
}

/** Selects cells by one geometric rule for every tessellation and every predefined shape. */
export function cellsInsideShape(
  cfg: FieldConfig,
  shape: ShapeDefinition,
  inclusion: ShapeInclusion = "center",
  origin?: ShapeOrigin,
): [number, number][] {
  const pixelShape = {
    ...shape,
    ...(shape.kind === "rectangle" ? { width: shape.width * TILE_SIZE, height: shape.height * TILE_SIZE } : {}),
    ...(shape.kind === "circle" ? { radius: shape.radius * TILE_SIZE } : {}),
    ...(shape.kind === "triangle" ? { side: shape.side * TILE_SIZE } : {}),
    ...(shape.kind === "hexagon" ? { radius: shape.radius * TILE_SIZE } : {}),
    ...((shape.kind === "triangle" || shape.kind === "hexagon") && shape.polygon ? { polygon: shape.polygon.map((point) => ({ x: point.x * TILE_SIZE, y: point.y * TILE_SIZE })) } : {}),
    ...((shape.kind === "circle" || shape.kind === "triangle" || shape.kind === "hexagon") && shape.width !== undefined ? { width: shape.width * TILE_SIZE } : {}),
    ...((shape.kind === "circle" || shape.kind === "triangle" || shape.kind === "hexagon") && shape.height !== undefined ? { height: shape.height * TILE_SIZE } : {}),
  } as ShapeDefinition;
  const projection = makeProjection(cfg);
  const originScreen = projection.gridToScreen(...originCellOf(cfg));
  const shapeOrigin = origin ?? { x: originScreen.x, y: -originScreen.y };
  const result: [number, number][] = [];
  for (const [x, y] of candidateCells(cfg, pixelShape, shapeOrigin)) {
    if (inclusion === "contained") {
      if (!containsCell(pixelShape, cellVertices(cfg, shapeOrigin, x, y))) continue;
    } else if (!containsPoint(pixelShape, cellCenter(projection, shapeOrigin, x, y))) {
      continue;
    }
    result.push([x, y]);
  }
  return result.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}
