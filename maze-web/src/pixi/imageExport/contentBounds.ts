import { exactCellBounds, cellCenterBounds } from "../tessellationGeometry";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import type { ExportMargin } from "./exportMargins";

/** Which raw bbox `contentWorldBounds` insets by `margin` — `"cell"` (default, `exactCellBounds`)
 * for render modes whose content reaches the cell's own polygon boundary (e.g. "Vector by walls"'
 * wall stroke sits on the cell face), `"center"` (`cellCenterBounds`) for modes whose content stops
 * well short of it (e.g. "Vector by corridors": a line runs cell-center to cell-center, so a border
 * cell's own segment never reaches the tile edge — GitHub issue #324). */
export type ContentBoundsBasis = "cell" | "center";

/** World-space bounding box of the maze's own drawn content — the render mode's own raw bbox
 * (`basis`, correct per-tessellation extent, not a uniform per-center pad) inset by `margin` on
 * each side. The single source of truth for "how big is the maze, actually" shared by every PNG
 * export canvas-fit computation (`computeDigitalExportFit`'s `edge_to_edge`/`margin_px`/
 * `margin_cells` branches, `computePrintExportFit`, `computeAutoFitPrintScale`) — every caller
 * passes the same pixel-accurate `ModeRenderer.getRequiredExportMargin()` (GitHub issue #324
 * follow-up), no separate wall-only vs. full-margin variant needed anymore. */
export function contentWorldBounds(
  cfg: TessellationConfig,
  nodes: { x: number; y: number; id: number }[],
  margin: ExportMargin,
  basis: ContentBoundsBasis = "cell",
): { minX: number; minY: number; width: number; height: number } {
  const { minX, minY, maxX, maxY } = basis === "center" ? cellCenterBounds(nodes, cfg) : exactCellBounds(nodes, cfg);
  return {
    minX: minX - margin.left,
    minY: minY - margin.top,
    width: maxX - minX + margin.left + margin.right,
    height: maxY - minY + margin.top + margin.bottom,
  };
}
