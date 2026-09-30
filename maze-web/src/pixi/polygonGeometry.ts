import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { makeProjection } from "./tessellationProjection";
import type { PrimitiveWorldGeometry } from "./primitiveGeometry";

export interface PolygonPoint {
  x: number;
  y: number;
}

/** Converts a world-space polygon into the cells whose centers it contains. */
export function cellsInsidePolygon(
  polygon: PolygonPoint[],
  cfg: TessellationConfig,
): [number, number][] {
  if (polygon.length < 3 || !hasNonCollinearPoints(polygon)) return [];

  const projection = makeProjection(cfg);
  const screenPolygon = polygon.map(({ x, y }) => ({ x, y: -y }));
  const minX = Math.min(...screenPolygon.map((point) => point.x));
  const maxX = Math.max(...screenPolygon.map((point) => point.x));
  const minY = Math.min(...screenPolygon.map((point) => point.y));
  const maxY = Math.max(...screenPolygon.map((point) => point.y));
  const gridCorners = [
    projection.screenToGrid(minX, minY),
    projection.screenToGrid(maxX, minY),
    projection.screenToGrid(minX, maxY),
    projection.screenToGrid(maxX, maxY),
  ];
  const startX = Math.floor(Math.min(...gridCorners.map((point) => point.x))) - 2;
  const endX = Math.ceil(Math.max(...gridCorners.map((point) => point.x))) + 2;
  const startY = Math.floor(Math.min(...gridCorners.map((point) => point.y))) - 2;
  const endY = Math.ceil(Math.max(...gridCorners.map((point) => point.y))) + 2;

  const cells: [number, number][] = [];
  for (let x = startX; x <= endX; x++) {
    for (let y = startY; y <= endY; y++) {
      const center = projection.gridToScreen(x, y);
      if (pointInPolygon({ x: center.x, y: center.y }, screenPolygon)) cells.push([x, y]);
    }
  }
  return cells;
}

export function polygonWorldGeometry(
  points: PolygonPoint[],
  options: { vertexCount?: number; dashedClosing?: boolean } = {},
): PrimitiveWorldGeometry {
  return { kind: "polygon", points, ...options };
}

function hasNonCollinearPoints(points: PolygonPoint[]): boolean {
  const origin = points[0];
  for (let i = 1; i < points.length - 1; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const cross = (points[i].x - origin.x) * (points[j].y - origin.y)
        - (points[i].y - origin.y) * (points[j].x - origin.x);
      if (Math.abs(cross) > 1e-7) return true;
    }
  }
  return false;
}

function pointInPolygon(point: PolygonPoint, polygon: PolygonPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const current = polygon[i];
    const previous = polygon[j];
    if (pointOnSegment(point, previous, current)) return true;
    const crosses = (current.y > point.y) !== (previous.y > point.y)
      && point.x < (previous.x - current.x) * (point.y - current.y) / (previous.y - current.y) + current.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointOnSegment(point: PolygonPoint, start: PolygonPoint, end: PolygonPoint): boolean {
  const cross = (point.x - start.x) * (end.y - start.y) - (point.y - start.y) * (end.x - start.x);
  if (Math.abs(cross) > 1e-6) return false;
  return point.x >= Math.min(start.x, end.x) - 1e-6
    && point.x <= Math.max(start.x, end.x) + 1e-6
    && point.y >= Math.min(start.y, end.y) - 1e-6
    && point.y <= Math.max(start.y, end.y) + 1e-6;
}
