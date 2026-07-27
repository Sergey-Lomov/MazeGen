import type { NodeDto } from "../../wasm/types";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import type { Pos } from "../tessellationGeometry";
import { getNeighborData, getSharedEdgeSegment } from "../tessellationGeometry";
import { buildCellSet } from "./sharedSelectors";

export interface RegionGeometry {
  /** This region's cells, for fill rendering. */
  cells: [number, number][];
  /** Shared-wall pixel segments on this region's boundary, for perimeter rendering. */
  perimeterSegments: { v0: Pos; v1: Pos }[];
}

/** Resolves one region's maze node ids to its cell coordinates and boundary segments — same
 * boundary-wall pattern `buildPresetWallGroups` uses for preset cell sets: for every cell in the
 * set, for every tessellation-neighbor offset, if the neighbor is not also in the set, that
 * shared edge is on the perimeter. Pure (no Pixi/Graphics) so it's unit-testable on its own,
 * mirroring `presetSelectors.ts`'s selector/renderer split. */
export function buildRegionGeometry(
  regionNodeIds: number[],
  nodes: NodeDto[],
  cfg: TessellationConfig,
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
  const perimeterSegments: RegionGeometry["perimeterSegments"] = [];

  for (const [x, y] of cells) {
    const { offsets } = getNeighborData(cfg, x, y);
    for (const [dx, dy] of offsets) {
      const nx = x + dx;
      const ny = y + dy;
      if (cellSet.has(`${nx},${ny}`)) continue;
      const seg = getSharedEdgeSegment([x, y], [nx, ny], cfg);
      if (seg) perimeterSegments.push(seg);
    }
  }

  return { cells, perimeterSegments };
}
