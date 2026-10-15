import { contentWorldBounds, type ContentBoundsBasis } from "./contentBounds";
import type { FieldConfig } from "../../fieldConfig";
import type { ExportMargin } from "./exportMargins";
import type { PrintExportSettings } from "../../store/storeTypes";
import { PAPER_SIZES_MM } from "./paperSizes";
import { placeInBox } from "./exportFit";
import { TILE_SIZE, VIEWPORT_FIT_PADDING } from "../constants";
import { TRI_TILE_SIZE } from "../triGeometry";

const MM_PER_INCH = 25.4;
const SQRT_3 = Math.sqrt(3);

export const DPI_BY_DENSITY: Record<PrintExportSettings["density"], number> = {
  screen_96: 96,
  draft_150: 150,
  print_300: 300,
  high_600: 600,
};

export function mmToPx(mm: number, dpi: number): number {
  return (mm / MM_PER_INCH) * dpi;
}

/** Editor-viewport scale that renders the maze at physical 1:1 with the target paper — one
 * on-screen millimeter equals one printed millimeter (GitHub issue #476). `calibratedCssPpi` is
 * the user-calibrated effective CSS pixels-per-inch (`screenCalibration.ts`); `density` picks the
 * print DPI via `DPI_BY_DENSITY`. Independent of `TILE_SIZE`: both the on-paper and on-screen cell
 * size are `TILE_SIZE * scale`, so it cancels. Pure — a viewport command, it does not read or
 * write `print.scale`. */
export function computePhysicalOneToOneViewportScale(
  printScale: number,
  density: PrintExportSettings["density"],
  calibratedCssPpi: number,
): number {
  return (printScale * calibratedCssPpi) / DPI_BY_DENSITY[density];
}

export function pxToMm(px: number, dpi: number): number {
  return (px / dpi) * MM_PER_INCH;
}

/** World-space length of the print-sizing measure at scale 1: square side, or circumcircle
 * diameter for regular hexagons and triangles. */
export function cellMeasureWorldUnits(config: Pick<FieldConfig, "tessellation">): number {
  if (config.tessellation.kind === "hex") {
    return TILE_SIZE * 2;
  }
  if (config.tessellation.kind === "tri") {
    return (TRI_TILE_SIZE * 2) / SQRT_3;
  }
  return TILE_SIZE;
}

/** World-space length of one geometric cell side at scale 1. Hexagons use TILE_SIZE as their
 * circumradius/side length, while triangles use TRI_TILE_SIZE as their side length. */
export function cellSideWorldUnits(config: Pick<FieldConfig, "tessellation">): number {
  return config.tessellation.kind === "tri"
    ? TRI_TILE_SIZE
    : TILE_SIZE;
}

/** Converts the print-sizing measure (square side or polygon circumcircle diameter) to a
 * geometric cell side in millimeters. */
export function printMeasureToCellSideMm(config: Pick<FieldConfig, "tessellation">, measureMm: number): number {
  return measureMm * cellSideWorldUnits(config) / cellMeasureWorldUnits(config);
}

/** Physical print-sizing measure represented by a print scale. */
export function printCellMeasureMm(config: Pick<FieldConfig, "tessellation">, scale: number, dpi: number): number {
  return pxToMm(cellMeasureWorldUnits(config) * scale, dpi);
}

/** Resolves the sheet's physical size in millimeters (portrait-normalized, then swapped for
 * landscape) — standard sizes from `PAPER_SIZES_MM`, or the user's own `customWidthMm`/
 * `customHeightMm` when `paperSize === "custom"`. */
export function resolveSheetSizeMm(settings: PrintExportSettings): { widthMm: number; heightMm: number } {
  const { w, h } = settings.paperSize === "custom"
    ? { w: settings.customWidthMm, h: settings.customHeightMm }
    : PAPER_SIZES_MM[settings.paperSize];
  return settings.orientation === "landscape" ? { widthMm: h, heightMm: w } : { widthMm: w, heightMm: h };
}

function rawContentSizePx(cfg: FieldConfig, nodes: { x: number; y: number; id: number }[], margin: ExportMargin, scale: number, basis: ContentBoundsBasis = "cell") {
  const { minX, minY, width, height } = contentWorldBounds(cfg, nodes, margin, basis);
  return { minXWorld: minX, minYWorld: minY, widthPx: width * scale, heightPx: height * scale };
}

export interface PrintFit {
  sheetWidthPx: number;
  sheetHeightPx: number;
  /** Transform for the maze content, in the same `(x, y, scale)` sense as `ExportFit` — apply to
   * the mode-renderer's container before rendering into a `sheetWidthPx`×`sheetHeightPx` texture. */
  x: number;
  y: number;
  scale: number;
  contentWidth: number;
  contentHeight: number;
  availableWidth: number;
  availableHeight: number;
  /** Content's placed rect extends past the sheet's own edges — actually clipped/lost on export. */
  clipsSheetBounds: boolean;
  /** Content's placed rect extends past the margin-inset rect (but may still be within the sheet)
   * — visible on export, but sitting in the margin zone the user reserved. */
  entersMarginZone: boolean;
}

/** Computes the print canvas's fit — a fixed-size sheet (`sheetWidthPx`×`sheetHeightPx`, from
 * paper size + DPI), with the maze content (its real drawn extent — `contentMargin`'s bbox inset,
 * scaled by `settings.scale`) placed inside the sheet's margin-inset area per `settings.anchor`.
 * Pure function — `contentMargin` should be the render mode's pixel-accurate export margin
 * (`ModeRenderer.getRequiredExportMargin()`, GitHub issue #324 follow-up), the same "how big is
 * the maze, actually" question `computeDigitalExportFit`'s `edge_to_edge`/`margin_px`/
 * `margin_cells` branches answer.
 *
 * `clipsSheetBounds`/`entersMarginZone` are informational only — export still proceeds when either
 * is true; content outside the sheet's own pixel bounds is simply not drawn (hardware clip). Both
 * are edge-rect checks (content's actual placed rect vs. the sheet/margin rects), not just a size
 * comparison — content can be small enough to fit but still poke past an edge under an off-center
 * anchor (including "custom"). */
export function computePrintExportFit(
  cfg: FieldConfig,
  nodes: { x: number; y: number; id: number }[],
  contentMargin: ExportMargin,
  settings: PrintExportSettings,
  basis: ContentBoundsBasis = "cell",
): PrintFit {
  const dpi = DPI_BY_DENSITY[settings.density];
  const { widthMm, heightMm } = resolveSheetSizeMm(settings);
  const sheetWidthPx = mmToPx(widthMm, dpi);
  const sheetHeightPx = mmToPx(heightMm, dpi);
  const marginHPx = mmToPx(settings.marginHMm, dpi);
  const marginVPx = mmToPx(settings.marginVMm, dpi);
  const availableWidth = sheetWidthPx - marginHPx * 2;
  const availableHeight = sheetHeightPx - marginVPx * 2;

  const { minXWorld, minYWorld, widthPx: contentWidth, heightPx: contentHeight } = rawContentSizePx(cfg, nodes, contentMargin, settings.scale, basis);

  // "custom" bypasses placeInBox's 9-way anchor math — the user positioned the content directly
  // (panning/zooming under the on-canvas frame, see ExportFrameOverlay), and offsetXMm/offsetYMm
  // already are the margin-relative position, only needing an mm→px conversion.
  const { x: contentX, y: contentY } = settings.anchor === "custom"
    ? { x: marginHPx + mmToPx(settings.offsetXMm, dpi), y: marginVPx + mmToPx(settings.offsetYMm, dpi) }
    : placeInBox(contentWidth, contentHeight, availableWidth, availableHeight, marginHPx, marginVPx, settings.anchor);

  // Sub-pixel tolerance — floating-point placement math (placeInBox's division, the auto-fit
  // scale's own division) can land content a fraction of a px past an edge it's meant to touch
  // exactly (e.g. clicking "auto-fit" sizes content to exactly fill the margin-safe area), which
  // without this reads as a false "content overflows" warning the instant the user hits the exact
  // boundary rather than only once content actually pokes past it.
  const EPSILON_PX = 0.01;
  const clipsSheetBounds = contentX < -EPSILON_PX || contentY < -EPSILON_PX
    || contentX + contentWidth > sheetWidthPx + EPSILON_PX || contentY + contentHeight > sheetHeightPx + EPSILON_PX;
  const entersMarginZone = contentX < marginHPx - EPSILON_PX || contentY < marginVPx - EPSILON_PX
    || contentX + contentWidth > sheetWidthPx - marginHPx + EPSILON_PX || contentY + contentHeight > sheetHeightPx - marginVPx + EPSILON_PX;

  return {
    sheetWidthPx,
    sheetHeightPx,
    x: contentX - minXWorld * settings.scale,
    y: contentY - minYWorld * settings.scale,
    scale: settings.scale,
    contentWidth,
    contentHeight,
    availableWidth,
    availableHeight,
    clipsSheetBounds,
    entersMarginZone,
  };
}

/** Fits the sheet's own aspect ratio (`sheetWidthPx`×`sheetHeightPx`, from `computePrintExportFit`)
 * into the given screen size with padding, centered — a different concept from `computePrintExportFit`
 * itself (which fits maze *content* into the sheet): this fits the *sheet* into the *screen*, for
 * the on-canvas print-mode frame overlay, which is fixed in screen space and never zooms/pans with
 * the maze underneath it. Uses the same `VIEWPORT_FIT_PADDING` as every other "fit to screen"
 * computation (GitHub issue #373 follow-up) so every auto-fit feature lands at the same zoom
 * percentage. */
export function computeSheetScreenLayout(sheetWidthPx: number, sheetHeightPx: number, screenW: number, screenH: number): { x: number; y: number; w: number; h: number } {
  const scale = VIEWPORT_FIT_PADDING * Math.min(screenW / sheetWidthPx, screenH / sheetHeightPx);
  const w = sheetWidthPx * scale;
  const h = sheetHeightPx * scale;
  return { x: (screenW - w) / 2, y: (screenH - h) / 2, w, h };
}

/** Recomputes `print.scale`/`offsetXMm`/`offsetYMm` so that `computePrintExportFit` reproduces
 * exactly what's currently visible under the on-canvas print frame — called on every editor
 * pan/zoom while the print settings panel is open (`ExportFrameOverlay`'s viewport-change hook),
 * so panning/zooming the maze behind the fixed frame directly repositions/rescales the print
 * output instead of only being a visual preview.
 *
 * `viewport` is the editor's live world→screen transform (`screenPt = worldPt*scale + (x,y)`),
 * `frameLayout` is the frame's own screen rect (`computeSheetScreenLayout`'s result) — together
 * they place a world point in "sheet-native" pixel space: project to screen, subtract the frame's
 * origin, then divide by the frame's own screen-fit downscale (`frameLayout.w / sheetWidthPx`) to
 * undo it, landing in the same pixel space `computePrintExportFit`'s `scale`/`x`/`y` operate in. */
export function computePrintPlacementFromViewport(
  cfg: FieldConfig,
  nodes: { x: number; y: number; id: number }[],
  contentMargin: ExportMargin,
  settings: PrintExportSettings,
  viewport: { x: number; y: number; scale: number },
  frameLayout: { x: number; y: number; w: number; h: number },
  basis: ContentBoundsBasis = "cell",
): { scale: number; offsetXMm: number; offsetYMm: number } {
  const dpi = DPI_BY_DENSITY[settings.density];
  const { widthMm } = resolveSheetSizeMm(settings);
  const sheetWidthPx = mmToPx(widthMm, dpi);
  const marginHPx = mmToPx(settings.marginHMm, dpi);
  const marginVPx = mmToPx(settings.marginVMm, dpi);

  const frameToSheetScale = sheetWidthPx / frameLayout.w;
  const scale = viewport.scale * frameToSheetScale;

  const { minX: minXWorld, minY: minYWorld } = contentWorldBounds(cfg, nodes, contentMargin, basis);
  const contentScreenX = minXWorld * viewport.scale + viewport.x;
  const contentScreenY = minYWorld * viewport.scale + viewport.y;
  const contentSheetX = (contentScreenX - frameLayout.x) * frameToSheetScale;
  const contentSheetY = (contentScreenY - frameLayout.y) * frameToSheetScale;

  return {
    scale,
    offsetXMm: pxToMm(contentSheetX - marginHPx, dpi),
    offsetYMm: pxToMm(contentSheetY - marginVPx, dpi),
  };
}

/** Inverse of `computePrintPlacementFromViewport` — given the sheet-space placement
 * `computePrintExportFit` already computes for the current settings (any anchor, fixed or
 * custom), derives the editor viewport `(x, y, scale)` that makes the canvas show exactly that
 * placement under the frame. Used to push panel edits (typing a new scale, picking a fixed
 * anchor, switching to print mode) back onto the canvas — the opposite direction of
 * `computePrintPlacementFromViewport`, which pushes canvas pan/zoom into settings. Reuses
 * `computePrintExportFit`'s own `x`/`y`/`scale` rather than re-deriving placement, so it stays
 * correct for every anchor including "custom" without duplicating `placeInBox`'s math. */
export function computeViewportFromPrintPlacement(
  cfg: FieldConfig,
  nodes: { x: number; y: number; id: number }[],
  contentMargin: ExportMargin,
  settings: PrintExportSettings,
  frameLayout: { x: number; y: number; w: number; h: number },
  basis: ContentBoundsBasis = "cell",
): { x: number; y: number; scale: number } {
  const dpi = DPI_BY_DENSITY[settings.density];
  const { widthMm } = resolveSheetSizeMm(settings);
  const sheetWidthPx = mmToPx(widthMm, dpi);
  const frameToSheetScale = sheetWidthPx / frameLayout.w;

  const printFit = computePrintExportFit(cfg, nodes, contentMargin, settings, basis);
  const viewportScale = printFit.scale / frameToSheetScale;

  return {
    x: printFit.x / frameToSheetScale + frameLayout.x,
    y: printFit.y / frameToSheetScale + frameLayout.y,
    scale: viewportScale,
  };
}

/** Computes the scale that makes the maze content (at `scale=1`) exactly fill the available
 * (margin-inset) area on the limiting axis. A pure, one-shot calculation — it doesn't read or
 * write `print.scaleAutoFit` itself. `PngExportSettingsPanel`'s `useEffect` re-runs it on every
 * sheet/DPI/margin/maze change while `print.scaleAutoFit` is on, keeping `print.scale` in
 * lockstep; a one-time caller (e.g. a manual "fit now" action) can just call this once instead. */
export function computeAutoFitPrintScale(
  cfg: FieldConfig,
  nodes: { x: number; y: number; id: number }[],
  contentMargin: ExportMargin,
  settings: PrintExportSettings,
  basis: ContentBoundsBasis = "cell",
): number {
  const dpi = DPI_BY_DENSITY[settings.density];
  const { widthMm, heightMm } = resolveSheetSizeMm(settings);
  const availableWidth = mmToPx(widthMm, dpi) - mmToPx(settings.marginHMm, dpi) * 2;
  const availableHeight = mmToPx(heightMm, dpi) - mmToPx(settings.marginVMm, dpi) * 2;

  const { widthPx: rawContentWidth, heightPx: rawContentHeight } = rawContentSizePx(cfg, nodes, contentMargin, 1, basis);
  if (rawContentWidth <= 0 || rawContentHeight <= 0) return settings.scale;

  return Math.min(availableWidth / rawContentWidth, availableHeight / rawContentHeight);
}
