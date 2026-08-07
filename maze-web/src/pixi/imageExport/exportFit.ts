import { TILE_SIZE } from "../constants";
import { contentWorldBounds } from "./contentBounds";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import type { ExportMargin } from "./exportMargins";
import type { DigitalExportSettings, PrintAnchor } from "../../store/storeTypes";

export interface ExportFit {
  width: number;
  height: number;
  x: number;
  y: number;
  scale: number;
  /** World-space top-left corner of the canvas itself (not just the content within it) — lets a
   * caller draw the canvas bounds directly in world space (e.g. `DigitalFrameOverlay`, which lives
   * in a viewport-synced container and needs the canvas rect in the same coordinate space the
   * maze itself is drawn in, not screen/canvas-pixel space). Canvas world size is
   * `width/scale`×`height/scale`. */
  worldX: number;
  worldY: number;
}

/** Places a `contentW`×`contentH` box inside a `boxW`×`boxH` area starting at
 * `(offsetX, offsetY)`, per `anchor` — shared by print's page-margin placement and digital's
 * `fixed_size` centering (which always uses `"center"`). */
export function placeInBox(
  contentW: number, contentH: number,
  boxW: number, boxH: number,
  offsetX: number, offsetY: number,
  anchor: PrintAnchor,
): { x: number; y: number } {
  const extraW = boxW - contentW;
  const extraH = boxH - contentH;
  const xFrac = anchor.startsWith("top_") || anchor.startsWith("center_") || anchor.startsWith("bottom_")
    ? (anchor.endsWith("_left") ? 0 : anchor.endsWith("_right") ? 1 : 0.5)
    : 0.5; // "center" itself
  const yFrac = anchor.startsWith("top_") ? 0 : anchor.startsWith("bottom_") ? 1 : 0.5;
  return { x: offsetX + extraW * xFrac, y: offsetY + extraH * yFrac };
}

function addUniform(margin: ExportMargin, extra: number): ExportMargin {
  return { left: margin.left + extra, right: margin.right + extra, top: margin.top + extra, bottom: margin.bottom + extra };
}

/** Computes the export canvas's pixel size and the viewport transform that fits the whole maze
 * (every node's bounding box, not the current on-screen viewport/zoom/pan) into it — `scale` is a
 * multiplier of `TILE_SIZE`, not a screen-fit ratio like `fitMazeViewport`'s own `FIT_PADDING`, so
 * line/marker thickness stays visually consistent relative to a tile regardless of overall maze
 * size.
 *
 * `margin` is the render mode's own required edge margin (`resolveExportMargin`/
 * `ModeRenderer.getRequiredExportMargin`) — this function stays pure and mode-agnostic, never
 * reading `VectorByWallsSettings` itself. `wallMargin` (`resolveWallExportMargin`/
 * `computeVectorByWallsWallMargin`) is the narrower "just enough for the wall stroke" margin —
 * `edge_to_edge` uses it alone (hugs the walls tightly, no room reserved for markers/indicators
 * the maze may not even have); `margin_px`/`margin_cells` add the user's own `marginValue` on top
 * of it, so a margin of 0 in either unit reproduces `edge_to_edge` exactly rather than a raw,
 * wall-clipping cell-boundary bound. `fixed_size`'s auto-centering still uses the full `margin` so
 * a marker never gets clipped by a coincidentally tight fixed canvas.
 *
 * `contentWidth`/`contentHeight` (the maze's own rendered size after scaling, always returned)
 * let a caller compute a fill percentage for a "doesn't fit" warning — distinct from `width`/
 * `height` (the canvas/file's own pixel size, which for `fixed_size` is exactly
 * `settings.fixedWidth`/`fixedHeight`, not the content size). `overflow` is only ever true for
 * `fixed_size`, when the content doesn't fit the fixed canvas — export still proceeds; anything
 * outside the `RenderTexture`'s bounds is simply not drawn (hardware clip), same as the print
 * mode's own overflow warnings. */
export function computeDigitalExportFit(
  cfg: TessellationConfig,
  nodes: { x: number; y: number; id: number }[],
  margin: ExportMargin,
  settings: DigitalExportSettings,
  wallMargin: ExportMargin = margin,
): ExportFit & { contentWidth: number; contentHeight: number; overflow: boolean } {
  const { scale, canvasMode, marginValue, fixedWidth, fixedHeight } = settings;

  if (canvasMode === "margin_px") {
    const extra = marginValue / scale;
    const raw = contentWorldBounds(cfg, nodes, addUniform(wallMargin, extra));
    const contentWidth = raw.width * scale;
    const contentHeight = raw.height * scale;
    return { width: contentWidth, height: contentHeight, x: -raw.minX * scale, y: -raw.minY * scale, scale, contentWidth, contentHeight, overflow: false, worldX: raw.minX, worldY: raw.minY };
  }

  if (canvasMode === "margin_cells") {
    const extra = marginValue * TILE_SIZE;
    const raw = contentWorldBounds(cfg, nodes, addUniform(wallMargin, extra));
    const contentWidth = raw.width * scale;
    const contentHeight = raw.height * scale;
    return { width: contentWidth, height: contentHeight, x: -raw.minX * scale, y: -raw.minY * scale, scale, contentWidth, contentHeight, overflow: false, worldX: raw.minX, worldY: raw.minY };
  }

  if (canvasMode === "fixed_size") {
    const raw = contentWorldBounds(cfg, nodes, margin);
    const contentWidth = raw.width * scale;
    const contentHeight = raw.height * scale;
    const { x: contentX, y: contentY } = placeInBox(contentWidth, contentHeight, fixedWidth, fixedHeight, 0, 0, "center");
    return {
      width: fixedWidth,
      height: fixedHeight,
      x: contentX - raw.minX * scale,
      y: contentY - raw.minY * scale,
      scale,
      contentWidth,
      contentHeight,
      overflow: contentWidth > fixedWidth || contentHeight > fixedHeight,
      worldX: raw.minX - contentX / scale,
      worldY: raw.minY - contentY / scale,
    };
  }

  // edge_to_edge
  const raw = contentWorldBounds(cfg, nodes, wallMargin);
  const contentWidth = raw.width * scale;
  const contentHeight = raw.height * scale;
  return { width: contentWidth, height: contentHeight, x: -raw.minX * scale, y: -raw.minY * scale, scale, contentWidth, contentHeight, overflow: false, worldX: raw.minX, worldY: raw.minY };
}
