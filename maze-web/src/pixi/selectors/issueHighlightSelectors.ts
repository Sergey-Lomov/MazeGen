import type { NodeDto } from "../../wasm/types";
import type { FieldConfig } from "../../fieldConfig";
import type { Pos } from "../tessellationGeometry";
import { getCellCenter, getNeighborData, getSharedEdgeSegment } from "../tessellationGeometry";
import { buildCellSet } from "./sharedSelectors";

export interface RegionGeometry {
  /** This region's cells, for fill rendering. */
  cells: [number, number][];
  /** Shared-wall pixel segments on this region's boundary, for perimeter rendering. Tagged with
   *  the edge-connected component (GitHub issue #618) so contour tracing never crosses between
   *  cells that only touch at a corner point, not a shared edge. */
  perimeterSegments: PerimeterSegment[];
}

/** One exposed side of a region, oriented with the region on its left. `polyline` is the side's
 *  whole flattened geometry from `v0` to `v1` (a straight side is just those two points). */
export interface PerimeterSegment {
  v0: Pos;
  v1: Pos;
  polyline: Pos[];
  component: number;
}

/** Resolves one region's maze node ids to its cell coordinates and boundary segments — same
 * boundary-wall pattern `buildPresetWallGroups` uses for preset cell sets: for every cell in the
 * set, for every tessellation-neighbor offset, if the neighbor is not also in the set, that
 * shared edge is on the perimeter. Pure (no Pixi/Graphics) so it's unit-testable on its own,
 * mirroring `presetSelectors.ts`'s selector/renderer split. */
export function buildRegionGeometry(
  regionNodeIds: number[],
  nodes: NodeDto[],
  cfg: FieldConfig,
): RegionGeometry {
  const nodeById = new Map<number, NodeDto>();
  for (const node of nodes) nodeById.set(node.id, node);

  // Dedup by coordinate, not just by id -- several distinct node ids (e.g. a split tile's
  // several nodes) can share one cell, and pushing that cell once per id would fill/stroke it
  // multiple times over (visibly darker fill, doubled perimeter lines).
  const seenCells = new Set<string>();
  const cells: [number, number][] = [];
  for (const id of regionNodeIds) {
    const node = nodeById.get(id);
    if (!node) continue;
    const key = `${node.x},${node.y}`;
    if (seenCells.has(key)) continue;
    seenCells.add(key);
    cells.push([node.x, node.y]);
  }
  if (cells.length === 0) return { cells, perimeterSegments: [] };

  const cellSet = buildCellSet(cells);

  // Group cells into edge-adjacency connected components first. Two cells that only touch at a
  // single corner point (GitHub issue #618) are not tessellation neighbors, so they land in
  // separate components even though their shared vertex coincides -- this keeps contour tracing
  // from crossing between them and rendering a self-intersecting "bowtie" shape.
  const cellKey = (x: number, y: number) => `${x},${y}`;
  // Cache each cell's own neighbor offsets from this pass -- the perimeter loop below needs the
  // same lookup per cell, and `getNeighborData` is a per-call switch, not a cached table.
  const offsetsByCell = new Map<string, [number, number][]>();
  const componentByCell = new Map<string, number>();
  let nextComponent = 0;
  for (const [x, y] of cells) {
    const key = cellKey(x, y);
    if (componentByCell.has(key)) continue;
    const component = nextComponent++;
    const stack: [number, number][] = [[x, y]];
    componentByCell.set(key, component);
    while (stack.length > 0) {
      const [cx, cy] = stack.pop()!;
      // Each cell is pushed exactly once (guarded by `componentByCell.has` below), so this cache
      // is always a fresh entry, never a repeat lookup.
      const offsets = getNeighborData(cfg, cx, cy).offsets;
      offsetsByCell.set(cellKey(cx, cy), offsets);
      for (const [dx, dy] of offsets) {
        const nx = cx + dx;
        const ny = cy + dy;
        const nKey = cellKey(nx, ny);
        if (!cellSet.has(nKey) || componentByCell.has(nKey)) continue;
        componentByCell.set(nKey, component);
        stack.push([nx, ny]);
      }
    }
  }

  const perimeterSegments: RegionGeometry["perimeterSegments"] = [];

  for (const [x, y] of cells) {
    const key = cellKey(x, y);
    const component = componentByCell.get(key)!;
    // Every cell in `cells` got a self-entry during the BFS above, so this is always cached.
    const offsets = offsetsByCell.get(key)!;
    for (const [dx, dy] of offsets) {
      const nx = x + dx;
      const ny = y + dy;
      if (cellSet.has(`${nx},${ny}`)) continue;
      const seg = getSharedEdgeSegment([x, y], [nx, ny], cfg);
      if (seg) {
        // Orient every exposed side consistently with the region on its left. This makes contour
        // tracing deterministic at pinch points where an inner opening touches the outer boundary.
        const center = getCellCenter(x, y, cfg);
        const cross = (seg.v1.x - seg.v0.x) * (center.y - seg.v0.y) - (seg.v1.y - seg.v0.y) * (center.x - seg.v0.x);
        const polyline = seg.polyline.map(([px, py]) => ({ x: px, y: py }));
        perimeterSegments.push(cross >= 0
          ? { v0: seg.v0, v1: seg.v1, polyline, component }
          : { v0: seg.v1, v1: seg.v0, polyline: polyline.reverse(), component });
      }
    }
  }

  return { cells, perimeterSegments };
}
