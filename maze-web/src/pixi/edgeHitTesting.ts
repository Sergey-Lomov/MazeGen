import { TESSELLATION_UI } from "./geometry/tessellationUi";
import { closestPointOnPolyline, fractionAlong } from "./geometry/polylineOps";
import { makeProjection } from "./tessellationProjection";
import { encodePoint } from "./tessellationProjection";
import { getCellNeighborOffsets, getFaceEdgeSegment, getSharedEdgeSegment } from "./tessellationGeometry";
import { getSeamModel } from "./selectors/seams";
import { tessellationFamily, type FieldConfig } from "../fieldConfig";
import { canonicalize, edgeKey, type FieldEdge } from "./fieldEditUtils";

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
  cfg: FieldConfig,
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

  // Cell-center-to-nearest-side distance, as a fraction of the tile's own edge-length scale, is
  // much smaller for triangles/hexagons (incenter-to-side ≈ 0.29 * side for an equilateral
  // triangle; hexagon center-to-side is the apothem, ≈ 0.87 * (side/2) ≈ 0.43 * side) than for a
  // square (center-to-side = TILE_SIZE/2 = 0.5 * TILE_SIZE) — a single `side * 0.4`-style threshold
  // tuned for one shape puts another shape's own cell center inside the edge-hit zone, so a
  // dead-center click is misread as an edge click (GitHub issue #340 follow-up). Each shape's own
  // threshold stays strictly under its own center-to-side ratio.
  const threshold = TESSELLATION_UI[tessellationFamily(cfg)].edgeHitThreshold;
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
      const hit = closestPointOnPolyline(seg.polyline, [viewportX, viewportY]);
      if (!hit) continue;
      const along = fractionAlong(seg.polyline, hit);
      if (deadZone && (along < EDGE_ENDPOINT_DEAD_ZONE_FRACTION || along > 1 - EDGE_ENDPOINT_DEAD_ZONE_FRACTION)) continue;
      const distSq = hit.distance * hit.distance;
      if (distSq < thresholdSq && distSq < bestDist) {
        bestDist = distSq;
        bestKey = key;
        const [from, to] = canonicalize([cx, cy], [nx, ny]);
        bestFrom = from;
        bestTo = to;
      }
    }
  }

  // A seam face has two copies, one per side, and a hit on either resolves to the same logical edge:
  // the key is canonical over the pair of cells, as for an ordinary edge.
  const seams = getSeamModel(cfg);
  for (const [cx, cy] of candidates) {
    if (!cellSet.has(encodePoint(cx, cy))) continue;
    for (const half of seams.halfEdgesOf([cx, cy])) {
      const [nx, ny] = half.partnerCell;
      if (!cellSet.has(encodePoint(nx, ny))) continue;
      const key = edgeKey([cx, cy], [nx, ny]);
      const copyKey = `${key}#${cx},${cy}#${half.faceIdx}`;
      if (checked.has(copyKey)) continue;
      checked.add(copyKey);

      const seg = getFaceEdgeSegment([cx, cy], half.faceIdx, cfg);
      if (!seg) continue;
      const hit = closestPointOnPolyline(seg.polyline, [viewportX, viewportY]);
      if (!hit) continue;
      const along = fractionAlong(seg.polyline, hit);
      if (deadZone && (along < EDGE_ENDPOINT_DEAD_ZONE_FRACTION || along > 1 - EDGE_ENDPOINT_DEAD_ZONE_FRACTION)) continue;
      const distSq = hit.distance * hit.distance;
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
  cfg: FieldConfig,
  cells: [number, number][],
  cellSet?: Set<number>,
): boolean {
  const proj = makeProjection(cfg);
  const cell = proj.screenToGrid(viewportX, viewportY);

  if (!cellSet) {
    cellSet = new Set<number>();
    for (const [x, y] of cells) cellSet.add(encodePoint(x, y));
  }

  const threshold = TESSELLATION_UI[tessellationFamily(cfg)].edgeHitThreshold;
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
      const hit = closestPointOnPolyline(seg.polyline, [viewportX, viewportY]);
      if (!hit || hit.distance * hit.distance >= thresholdSq) continue;
      const along = fractionAlong(seg.polyline, hit);
      if (along < EDGE_ENDPOINT_DEAD_ZONE_FRACTION || along > 1 - EDGE_ENDPOINT_DEAD_ZONE_FRACTION) return true;
    }
    for (const half of getSeamModel(cfg).halfEdgesOf([cx, cy])) {
      if (!cellSet.has(encodePoint(half.partnerCell[0], half.partnerCell[1]))) continue;
      const seg = getFaceEdgeSegment([cx, cy], half.faceIdx, cfg);
      if (!seg) continue;
      const hit = closestPointOnPolyline(seg.polyline, [viewportX, viewportY]);
      if (!hit || hit.distance * hit.distance >= thresholdSq) continue;
      const along = fractionAlong(seg.polyline, hit);
      if (along < EDGE_ENDPOINT_DEAD_ZONE_FRACTION || along > 1 - EDGE_ENDPOINT_DEAD_ZONE_FRACTION) return true;
    }
  }
  return false;
}
