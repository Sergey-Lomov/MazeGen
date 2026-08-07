import { Container } from "pixi.js";
import { VectorByWallsRenderer } from "./VectorByWallsRenderer";
import type { RenderModeId } from "../../store/storeTypes";
import type { ViewportListener } from "../sceneTypes";
import type { ExportMargin } from "./exportMargins";

export interface ModeRenderer extends ViewportListener {
  /** World-space required margin around the maze's raw cell-boundary bounding box, per side, for
   * this mode's own current settings — see `exportMargins.ts`'s doc comment. Every mode must
   * implement this so PNG export's "edge-to-edge" canvas mode works for any render mode, not just
   * "Vector by walls". */
  getRequiredExportMargin(): ExportMargin;
  /** Narrower margin used only by PNG export's "edge to edge" canvas mode — just enough for the
   * mode's own wall/border stroke, not markers/indicators — see `exportMargins.ts`'s
   * `computeVectorByWallsWallMargin`. */
  getRequiredWallExportMargin(): ExportMargin;
  /** This mode's own current background fill color (0xRRGGBB) — see `exportMargins.ts`'s
   * `resolveBackgroundColor`. Used to pick a contrasting color for canvas-drawn UI (e.g. the
   * print-mode export frame) that must stay visible against it. */
  getBackgroundColor(): number;
  destroy(): void;
}

/** Single place that switches on `RenderModeId` to build a mode's renderer instance — shared by
 * `ImageExportRenderer` (one live instance per active mode) and `PngExporter` (one temporary,
 * export-only instance, never sharing a container with the live one). Adding a new mode means
 * adding one case here — no other switch to keep in sync. */
export function createModeRenderer(mode: RenderModeId, container: Container): ModeRenderer {
  switch (mode) {
    case "vector_by_walls":
      return new VectorByWallsRenderer(container);
  }
}
