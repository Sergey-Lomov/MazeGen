import { TILE_SIZE } from "./constants";
import { TRI_TILE_SIZE } from "./triGeometry";
import { makeProjection } from "./tessellationProjection";
import { encodePoint } from "./tessellationProjection";
import { getCellNeighborOffsets, getSharedEdgeSegment } from "./tessellationGeometry";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { canonicalize, edgeKey, type FieldEdge } from "./fieldEditUtils";

interface SegmentHit {
  distSq: number;
  /** Fraction along the segment (0 = v0, 1 = v1) of the closest point to the query position. */
  t: number;
}

function closestPointOnSegment(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): SegmentHit {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { distSq: (px - ax) * (px - ax) + (py - ay) * (py - ay), t: 0 };
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return { distSq: (px - cx) * (px - cx) + (py - cy) * (py - cy), t };
}

/** Fraction of a segment's length, at each end, treated as a dead zone: hover/drag hit-testing
 * ignores the segment there so the cursor must clearly enter its interior before it registers.
 * Without this, passing near a grid vertex while dragging along one edge would register a hit on
 * a perpendicular edge meeting at that same vertex (#188). Only applied when `deadZone` is passed
 * to `pickEdgeAtPosition` — a plain (non-drag) click must still be able to hit an edge whose
 * nearest point is close to a vertex, so pointerdown call sites opt out. */
const EDGE_ENDPOINT_DEAD_ZONE_FRACTION = 0.2;

export function pickEdgeAtPosition(
  viewportX: number,
  viewportY: number,
  cfg: TessellationConfig,
  cells: [number, number][],
  cellSet?: Set<number>,
  deadZone = false,
): FieldEdge | null {
  const proj = makeProjection(cfg);
  const cell = proj.screenToGrid(viewportX, viewportY);

  if (!cellSet) {
    cellSet = new Set<number>();
    for (const [x, y] of cells) cellSet.add(encodePoint(x, y));
  }

  const isTriangle = cfg.type === "triangle_rect" || cfg.type === "triangle_triangle"
    || cfg.type === "triangle_circle" || cfg.type === "triangle_hexagon" || cfg.type === "tri_custom";
  const isHex = cfg.type === "hex_rectangle" || cfg.type === "hex_circle" || cfg.type === "hex_triangle" || cfg.type === "hex_parallelogram" || cfg.type === "hex_hexagon" || cfg.type === "hex_custom";
  // Cell-center-to-nearest-side distance, as a fraction of the tile's own edge-length scale, is
  // much smaller for triangles/hexagons (incenter-to-side ≈ 0.29 * side for an equilateral
  // triangle; hexagon center-to-side is the apothem, ≈ 0.87 * (side/2) ≈ 0.43 * side) than for a
  // square (center-to-side = TILE_SIZE/2 = 0.5 * TILE_SIZE) — a single `side * 0.4`-style threshold
  // tuned for one shape puts another shape's own cell center inside the edge-hit zone, so a
  // dead-center click is misread as an edge click (GitHub issue #340 follow-up). Each shape's own
  // threshold stays strictly under its own center-to-side ratio.
  const threshold = isTriangle || isHex ? TRI_TILE_SIZE * 0.12 : TILE_SIZE * 0.08;
  const thresholdSq = threshold * threshold;

  let bestKey: string | null = null;
  let bestFrom: [number, number] | null = null;
  let bestTo: [number, number] | null = null;
  let bestDist = Infinity;

  const candidates: [number, number][] = [[cell.x, cell.y]];
  for (const [dx, dy] of getCellNeighborOffsets(cfg, cell.x, cell.y))
    candidates.push([cell.x + dx, cell.y + dy]);

  const checked = new Set<string>();
  for (const [cx, cy] of candidates) {
    if (!cellSet.has(encodePoint(cx, cy))) continue;
    for (const [dx, dy] of getCellNeighborOffsets(cfg, cx, cy)) {
      const nx = cx + dx, ny = cy + dy;
      if (!cellSet.has(encodePoint(nx, ny))) continue;
      const key = edgeKey([cx, cy], [nx, ny]);
      if (checked.has(key)) continue;
      checked.add(key);

      const seg = getSharedEdgeSegment([cx, cy], [nx, ny], cfg);
      if (!seg) continue;
      const hit = closestPointOnSegment(viewportX, viewportY, seg.v0.x, seg.v0.y, seg.v1.x, seg.v1.y);
      if (deadZone && (hit.t < EDGE_ENDPOINT_DEAD_ZONE_FRACTION || hit.t > 1 - EDGE_ENDPOINT_DEAD_ZONE_FRACTION)) continue;
      const distSq = hit.distSq;
      if (distSq < thresholdSq && distSq < bestDist) {
        bestDist = distSq;
        bestKey = key;
        const [from, to] = canonicalize([cx, cy], [nx, ny]);
        bestFrom = from;
        bestTo = to;
      }
    }
  }

  if (bestKey && bestFrom && bestTo) {
    return { key: bestKey, from: bestFrom, to: bestTo };
  }
  return null;
}

/** True if `(viewportX, viewportY)` falls in some edge's own dead zone (within
 * `EDGE_ENDPOINT_DEAD_ZONE_FRACTION` of one of its endpoints, and within `pickEdgeAtPosition`'s own
 * per-shape `threshold` of the segment) — i.e. `pickEdgeAtPosition(..., deadZone=true)` returned
 * `null` specifically *because* the cursor is near a shared vertex, not because it's simply too far
 * from every edge. Used by tools with a dual edge/point mode (preset's "clear", post-edit's
 * "reset") to withhold the point/cell fallback there too — otherwise the vertex dead zone (meant to
 * avoid hair-triggering a perpendicular edge, #188) silently becomes "picks the cell instead",
 * which is not what the dead zone is for. */
export function isInEdgeVertexDeadZone(
  viewportX: number,
  viewportY: number,
  cfg: TessellationConfig,
  cells: [number, number][],
  cellSet?: Set<number>,
): boolean {
  const proj = makeProjection(cfg);
  const cell = proj.screenToGrid(viewportX, viewportY);

  if (!cellSet) {
    cellSet = new Set<number>();
    for (const [x, y] of cells) cellSet.add(encodePoint(x, y));
  }

  const isTriangle = cfg.type === "triangle_rect" || cfg.type === "triangle_triangle"
    || cfg.type === "triangle_circle" || cfg.type === "triangle_hexagon" || cfg.type === "tri_custom";
  const isHex = cfg.type === "hex_rectangle" || cfg.type === "hex_circle" || cfg.type === "hex_triangle" || cfg.type === "hex_parallelogram" || cfg.type === "hex_hexagon" || cfg.type === "hex_custom";
  const threshold = isTriangle || isHex ? TRI_TILE_SIZE * 0.12 : TILE_SIZE * 0.08;
  const thresholdSq = threshold * threshold;

  const candidates: [number, number][] = [[cell.x, cell.y]];
  for (const [dx, dy] of getCellNeighborOffsets(cfg, cell.x, cell.y))
    candidates.push([cell.x + dx, cell.y + dy]);

  const checked = new Set<string>();
  for (const [cx, cy] of candidates) {
    if (!cellSet.has(encodePoint(cx, cy))) continue;
    for (const [dx, dy] of getCellNeighborOffsets(cfg, cx, cy)) {
      const nx = cx + dx, ny = cy + dy;
      if (!cellSet.has(encodePoint(nx, ny))) continue;
      const key = edgeKey([cx, cy], [nx, ny]);
      if (checked.has(key)) continue;
      checked.add(key);

      const seg = getSharedEdgeSegment([cx, cy], [nx, ny], cfg);
      if (!seg) continue;
      const hit = closestPointOnSegment(viewportX, viewportY, seg.v0.x, seg.v0.y, seg.v1.x, seg.v1.y);
      if (hit.distSq >= thresholdSq) continue;
      if (hit.t < EDGE_ENDPOINT_DEAD_ZONE_FRACTION || hit.t > 1 - EDGE_ENDPOINT_DEAD_ZONE_FRACTION) return true;
    }
  }
  return false;
}
