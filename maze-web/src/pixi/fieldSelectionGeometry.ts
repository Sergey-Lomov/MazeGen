import { TILE_SIZE } from "./constants";
import { hexCenter, hexVertices } from "./hexGeometry";
import { triVertices } from "./triGeometry";
import { getCellVertices as geometryCellVertices } from "./tessellationGeometry";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import type { TessellationKind } from "./primitiveGeometry";
import type { WorldPoint } from "./primitiveGeometry";

export type BoundarySegment = [WorldPoint, WorldPoint];

/** Returns only the exposed edges of the selected cell union. Shared cell edges cancel out. */
export function selectionBoundarySegments(
  cells: [number, number][],
  kind: TessellationKind,
  cfg: TessellationConfig,
): BoundarySegment[] {
  const edges = new Map<string, BoundarySegment>();
  for (const [x, y] of cells) {
    const vertices = cellVertices(x, y, kind, cfg);
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

function cellVertices(x: number, y: number, kind: TessellationKind, cfg: TessellationConfig): WorldPoint[] {
  if (kind === "square") {
    const h = TILE_SIZE / 2;
    const cx = x * TILE_SIZE + h;
    const cy = y * TILE_SIZE + h;
    return [
      { x: cx - h, y: cy - h },
      { x: cx + h, y: cy - h },
      { x: cx + h, y: cy + h },
      { x: cx - h, y: cy + h },
    ];
  }
  if (kind === "hex") {
    const orientation = (cfg as { orientation?: "flat_top" | "pointy_top" }).orientation ?? "flat_top";
    const center = hexCenter(x, y, orientation, cfg);
    return hexVertices(center.x, center.y, orientation).map((point) => ({ x: point.x, y: -point.y }));
  }
  if (kind === "cairo") return geometryCellVertices(x, y, cfg)?.map((point) => ({ x: point.x, y: -point.y })) ?? [];
  const orientation = (cfg as { orientation?: "r0" | "r90" | "r180" | "r270" }).orientation ?? "r0";
  return triVertices(x, y, orientation).map((point) => ({ x: point.x, y: -point.y }));
}

function pointKey(point: WorldPoint): string {
  return `${Math.round(point.x * 1e6)},${Math.round(point.y * 1e6)}`;
}
