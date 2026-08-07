import { exactCellBounds } from "../tessellationGeometry";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import type { ExportMargin } from "./exportMargins";

/** World-space bounding box of the maze's own drawn content — every node's exact cell polygon
 * (`exactCellBounds`, correct per-tessellation extent, not a uniform per-center pad) inset by
 * `margin` on each side. The single source of truth for "how big is the maze, actually" shared by
 * every PNG export canvas-fit computation (`computeDigitalExportFit`'s `edge_to_edge`/
 * `margin_px`/`margin_cells` branches, `computePrintExportFit`, `computeAutoFitPrintScale`) — each
 * caller passes whichever `ExportMargin` fits its own question: `resolveWallExportMargin`'s tight
 * wall-only margin for a hug-the-walls fit, or `resolveExportMargin`'s full margin when markers/
 * indicators must never get clipped (digital's `fixed_size` auto-centering). */
export function contentWorldBounds(
  cfg: TessellationConfig,
  nodes: { x: number; y: number; id: number }[],
  margin: ExportMargin,
): { minX: number; minY: number; width: number; height: number } {
  const { minX, minY, maxX, maxY } = exactCellBounds(nodes, cfg);
  return {
    minX: minX - margin.left,
    minY: minY - margin.top,
    width: maxX - minX + margin.left + margin.right,
    height: maxY - minY + margin.top + margin.bottom,
  };
}
