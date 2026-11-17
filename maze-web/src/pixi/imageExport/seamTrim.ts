import { Graphics } from "pixi.js";
import type { FieldConfig } from "../../fieldConfig";
import { getCellCenter, getCellVertices, getFaceEdgeSegment, getCellNeighborOffsets } from "../tessellationGeometry";
import { getSeamModel } from "../selectors/seams";

/** Smallest `1 - dot` of two outward normals at a shared vertex that still needs a wedge. A strip reaches
 *  `margin` beyond the wall, so even a tiny angle between neighbors opens a visible sliver there. */
const WEDGE_MIN_ANGLE_DEFICIT = 1e-9;

/** Unit normal of the chord `(x0, y0)-(x1, y1)` pointing away from `center`, or `[0, 0]` for a point. The
 *  normal is the chord's own, not the direction from the center: on a curved side the two differ, and
 *  strips of consecutive chords along one arc would not line up. */
function outwardChordNormal(x0: number, y0: number, x1: number, y1: number, center: { x: number; y: number }): [number, number] {
  const length = Math.hypot(x1 - x0, y1 - y0);
  if (length === 0) return [0, 0];
  let nx = (y1 - y0) / length;
  let ny = -(x1 - x0) / length;
  if (nx * ((x0 + x1) / 2 - center.x) + ny * ((y0 + y1) / 2 - center.y) < 0) {
    nx = -nx;
    ny = -ny;
  }
  return [nx, ny];
}

/** Polygons of the trim mask: every cell, plus an outward strip along each ordinary field edge. A glued
 *  face gets no strip, so artwork under the mask is cut at that exact boundary (`Specs/image-export.md`,
 *  "Topology section"). Display space. */
export function trimMaskPolygons(cells: readonly [number, number][], cfg: FieldConfig, margin: number): number[][] {
  const polygons: number[][] = [];
  const cellKeys = new Set(cells.map(([x, y]) => `${x},${y}`));
  const boundaryVertices = new Map<string, { cell: string; x: number; y: number; nx: number; ny: number }[]>();
  const seams = getSeamModel(cfg);
  // The union of cells keeps every interior edge. Add an outward strip only for an ordinary field
  // edge; a glued face intentionally has no strip, so all artwork is cut at that exact boundary.
  for (const [x, y] of cells) {
    const vertices = getCellVertices(x, y, cfg);
    polygons.push(vertices.flatMap(({ x: px, y: py }) => [px, py]));
    const center = getCellCenter(x, y, cfg);
    for (const [face, [dx, dy]] of getCellNeighborOffsets(cfg, x, y).entries()) {
      if (seams.halfEdgeAt([x, y], face) || (dx !== 0 || dy !== 0) && cellKeys.has(`${x + dx},${y + dy}`)) continue;
      const edge = getFaceEdgeSegment([x, y], face, cfg);
      if (!edge) continue;
      for (let index = 1; index < edge.polyline.length; index++) {
        const [x0, y0] = edge.polyline[index - 1];
        const [x1, y1] = edge.polyline[index];
        const [nx, ny] = outwardChordNormal(x0, y0, x1, y1, center);
        if (nx === 0 && ny === 0) continue;
        polygons.push([x0, y0, x1, y1, x1 + nx * margin, y1 + ny * margin, x0 + nx * margin, y0 + ny * margin]);
        for (const [px, py] of [[x0, y0], [x1, y1]]) {
          const key = `${Math.round(px * 100)},${Math.round(py * 100)}`;
          const entries = boundaryVertices.get(key) ?? [];
          entries.push({ cell: `${x},${y}`, x: px, y: py, nx, ny });
          boundaryVertices.set(key, entries);
        }
      }
    }
  }

  // A face strip alone leaves the diagonal quadrant at a convex field corner uncovered. An
  // export-only trim mask would therefore cut off the miter that `WallRenderer` has already drawn.
  // Join each pair of boundary faces belonging to the same cell with its outward corner wedge.
  for (const entries of boundaryVertices.values()) {
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i];
        const b = entries[j];
        const dot = a.nx * b.nx + a.ny * b.ny;
        if (dot > 1 - WEDGE_MIN_ANGLE_DEFICIT) continue;
        polygons.push([a.x, a.y, a.x + a.nx * margin, a.y + a.ny * margin, b.x + b.nx * margin, b.y + b.ny * margin]);
      }
    }
  }
  return polygons;
}

export function drawTrimMask(mask: Graphics, cells: readonly [number, number][], cfg: FieldConfig, margin: number): void {
  mask.clear();
  for (const polygon of trimMaskPolygons(cells, cfg, margin)) {
    mask.poly(polygon).fill(0xffffff);
  }
}
