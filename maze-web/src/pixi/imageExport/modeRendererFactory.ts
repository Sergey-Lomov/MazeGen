import { Container } from "pixi.js";
import { VectorByWallsRenderer } from "./VectorByWallsRenderer";
import { VectorByCorridorsRenderer } from "./VectorByCorridorsRenderer";
import type { RenderModeId } from "../../store/storeTypes";
import type { ViewportListener } from "../sceneTypes";
import type { ExportMargin } from "./exportMargins";

/** See `ModeRenderer.setRenderPass`. */
export type RenderPass = "full" | "backdrop" | "content" | "overlay" | "foreground";

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
  /** Which part of the picture is drawn: the backdrop (background fill and grid, over the whole viewport), the
   * content above it, the overlay (everything that must stay above the content of every cut copy: split shapes,
   * widen patches, teleports, markers, index labels), or all of them. A cut sheet (GitHub issue #859) draws the
   * backdrop once, unclipped, then the content of every copy, then the overlay of every copy, each shifted and
   * clipped to the sheet's region (GitHub issue #888). A mode with nothing to lift above the content leaves its
   * overlay empty. `"foreground"` is the content and the overlay together, without the backdrop. */
  setRenderPass(pass: RenderPass): void;
  /** The content and the overlay as separate containers, so a caller drawing several shifted copies can stack the
   * content of all copies below the overlay of all copies without the mode building its geometry twice. They start
   * as children of the container given to `createModeRenderer`, and may be moved elsewhere (GitHub issue #888). */
  readonly layers: { readonly content: Container; readonly overlay: Container };
  /** Whether the mode puts anything in its `"overlay"` pass; a cut export skips the empty pass. */
  readonly hasOverlay: boolean;
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
