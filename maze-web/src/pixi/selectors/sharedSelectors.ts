import { getNeighborData } from "../tessellationGeometry";
import { edgeKey } from "../presetConnectionsUtils";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";

/**
 * Builds a set of canonical edge keys for all interior edges owned by the
 * lexicographically-smaller cell. Avoids processing each shared edge twice.
 */
export function buildOwnedEdgeKeys(
  cells: [number, number][],
  cfg: TessellationConfig,
  cellSet: Set<string>,
): Set<string> {
  const owned = new Set<string>();
  for (const [x, y] of cells) {
    const { offsets } = getNeighborData(cfg, x, y);
    for (const [dx, dy] of offsets) {
      const nx = x + dx;
      const ny = y + dy;
      if (!cellSet.has(`${nx},${ny}`)) continue;
      const ownsEdge = x < nx || (x === nx && y < ny);
      if (!ownsEdge) continue;
      owned.add(edgeKey([x, y], [nx, ny]));
    }
  }
  return owned;
}

export function buildCellSet(cells: [number, number][]): Set<string> {
  return new Set(cells.map(([x, y]) => `${x},${y}`));
}
