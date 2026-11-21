import type { FieldConfig } from "../fieldConfig";
import { cellsInDisplayPolygon } from "./tessellationGeometry";
import type { PrimitiveWorldGeometry } from "./primitiveGeometry";

export interface PolygonPoint {
  x: number;
  y: number;
}

/** Converts a world-space (y-up) polygon into the cells whose centers it contains, as core's
 * region query answers it (only real cells of the tessellation are ever returned). */
export function cellsInsidePolygon(
  polygon: PolygonPoint[],
  cfg: FieldConfig,
): [number, number][] {
  if (polygon.length < 3 || !hasNonCollinearPoints(polygon)) return [];
  return cellsInDisplayPolygon(polygon.map(({ x, y }) => ({ x, y: -y })), "center_inside", cfg);
}

export function polygonWorldGeometry(
  points: PolygonPoint[],
  options: { vertexCount?: number; dashedClosing?: boolean; closed?: boolean; dashedAll?: boolean; frameColor?: number; cellColor?: number; cellAlpha?: number } = {},
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
