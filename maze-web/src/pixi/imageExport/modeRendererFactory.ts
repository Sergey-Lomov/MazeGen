import { Container } from "pixi.js";
import { VectorByWallsRenderer } from "./VectorByWallsRenderer";
import { VectorByCorridorsRenderer } from "./VectorByCorridorsRenderer";
import type { RenderModeId } from "../../store/storeTypes";
import type { ViewportListener } from "../sceneTypes";
import type { ExportMargin } from "./exportMargins";

export interface ModeRenderer extends ViewportListener {
  /** World-space required margin around the maze's raw cell-boundary bounding box, per side —
   * pixel-accurate (GitHub issue #324 follow-up), measured off this mode's own already-rendered
   * content (`Container.getLocalBounds()`), not approximated from settings. Every mode must
   * implement this so PNG export's canvas-fit math works for any render mode, not just
   * "Vector by walls" — see `exportMargins.ts`'s `ExportMargin` doc comment. */
  getRequiredExportMargin(): ExportMargin;
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
    case "vector_by_corridors":
      return new VectorByCorridorsRenderer(container);
  }
}
