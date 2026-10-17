import { getCellVertices as geometryCellVertices } from "./tessellationGeometry";
import type { FieldConfig } from "../fieldConfig";
import type { WorldPoint } from "./primitiveGeometry";

export type BoundarySegment = [WorldPoint, WorldPoint];

/** Returns only the exposed edges of the selected cell union. Shared cell edges cancel out. */
export function selectionBoundarySegments(
  cells: [number, number][],
  cfg: FieldConfig,
): BoundarySegment[] {
  const edges = new Map<string, BoundarySegment>();
  for (const [x, y] of cells) {
    const vertices = cellVertices(x, y, cfg);
    for (let i = 0; i < vertices.length; i++) {
      const from = vertices[i];
      const to = vertices[(i + 1) % vertices.length];
      const fromKey = pointKey(from);
      const toKey = pointKey(to);
      const key = fromKey < toKey ? `${fromKey}|${toKey}` : `${toKey}|${fromKey}`;
      if (edges.has(key)) edges.delete(key);
      else edges.set(key, [from, to]);
    }
  }
  return [...edges.values()];
}

function cellVertices(x: number, y: number, cfg: FieldConfig): WorldPoint[] {
  return geometryCellVertices(x, y, cfg).map((point) => ({ x: point.x, y: -point.y }));
}

function pointKey(point: WorldPoint): string {
  return `${Math.round(point.x * 1e6)},${Math.round(point.y * 1e6)}`;
}
