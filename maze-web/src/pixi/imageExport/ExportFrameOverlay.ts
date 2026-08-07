import { Container, Graphics } from "pixi.js";
import { useMazeStore } from "../../store/mazeStore";
import { computePrintExportFit, computeSheetScreenLayout, computePrintPlacementFromViewport, computeViewportFromPrintPlacement, DPI_BY_DENSITY, mmToPx } from "./printFit";
import { computeDigitalExportFit } from "./exportFit";
import { resolveExportMargin, resolveWallExportMargin, resolveBackgroundColor } from "./exportMargins";
import { contrastGray } from "../colorTokens";
import type { ViewportListener } from "../sceneTypes";
import type { PrintExportSettings } from "../../store/storeTypes";

const DASH_LENGTH = 10;
const GAP_LENGTH = 6;
const FRAME_STROKE_WIDTH = 2;
const MARGIN_STROKE_WIDTH = 1;
const DIM_ALPHA = 0.45;

type ScreenRect = { x: number; y: number; w: number; h: number };
type PrintFrameLayout = ScreenRect & { sheetWidthPx: number; sheetHeightPx: number };

/** Draws the export canvas boundary as an overlay on the editor canvas — a solid frame, a dimmed
 * region outside it, and (print mode only) dashed lines marking the page margins. Print mode's
 * frame is a fixed rect in screen space (`imageExportFrameContainer`, NOT in
 * `MazeScene.syncedLayers`): the sheet stays put while the maze content underneath keeps panning/
 * zooming, and panning/zooming syncs back into `print.scale`/`offsetXMm`/`offsetYMm` (see
 * `syncPlacementToViewport`/`syncViewportToPlacement`). Digital mode has no such fixed-frame/pan-
 * sync mechanic — its canvas position is already a direct, always-in-sync function of the maze's
 * own bounding box, so its frame is just `computeDigitalExportFit`'s world-space rect converted to
 * screen space through the live viewport transform (`onViewportChanged`'s `x/y/scale`) each time
 * it's queried — no independent state of its own. */
export class ExportFrameOverlay implements ViewportListener {
  private readonly graphics: Graphics;
  private unsubscribe: (() => void) | null = null;
  private lastViewport = { x: 0, y: 0, scale: 1 };
  // Depth counter around our own setPrintCustomPlacement()/setViewportTransform() writes (which
  // recursively re-enter redraw()) so redraw() doesn't try to sync canvas<->settings again from
  // its own output. A counter, not a boolean: syncViewportToPlacement's setViewportTransform call
  // synchronously triggers syncPlacementToViewport's setPrintCustomPlacement call before either
  // returns, so the two guards nest and a plain boolean's inner `finally` would clear it early.
  private syncingDepth = 0;
  private get syncing(): boolean {
    return this.syncingDepth > 0;
  }
  private wasFrameActive = false;

  constructor(
    container: Container,
    private readonly setViewportTransform: (x: number, y: number, scale: number) => void,
    private readonly getScreenSize: () => { width: number; height: number },
  ) {
    this.graphics = new Graphics();
    container.addChild(this.graphics);
    this.subscribe();
    this.redraw();
  }

  /** Called after a screen-size-only refresh (`MazeScene.notifyScreenResized`) — the canvas DOM
   * element resized (side panel opening/closing, card switching, DevTools toggling) but the maze
   * itself didn't pan/zoom. `syncLayersToViewport()` (already called by the time this runs) only
   * re-fires `onViewportChanged` with the *same* x/y/scale as before, which `actuallyMoved` in
   * `onViewportChanged` correctly ignores — but the print frame's own screen rect
   * (`computeSheetScreenLayout`'s x/y/w/h) DOES change with screen size, and nothing else re-checks
   * that: `redraw()` otherwise only runs from the store subscription, which a pure screen resize
   * never triggers. Re-running it here is what re-fits the canvas under the *new* frame rect while
   * keeping the same anchor/scale settings — e.g. the frame narrowing once a side panel finishes
   * mounting after `becameActive` already synced against the wider, pre-panel screen. */
  notifyExternalResize(): void {
    this.redraw();
  }

  // w/h unused: screen size is now read live via getScreenSize() at redraw time (see its doc
  // comment) rather than cached from this callback's params, to avoid drawing against a stale
  // canvas size on any redraw that isn't itself triggered by a viewport change.
  onViewportChanged(x: number, y: number, _w: number, _h: number, scale: number): void {
    // A resize-triggered syncLayersToViewport() re-fires this with the *same* x/y/scale as before
    // (nothing actually panned/zoomed) — only a genuine value change is real user pan/zoom.
    const actuallyMoved = x !== this.lastViewport.x || y !== this.lastViewport.y || scale !== this.lastViewport.scale;
    this.lastViewport = { x, y, scale };
    const state = useMazeStore.getState();
    const layout = this.currentPrintFrameLayout(state);
    // Skip while syncing: this viewport change is our own syncViewportToPlacement() echo (a
    // settings-panel edit pushed onto the canvas), not real user pan/zoom — syncing it back would
    // immediately stomp anchor to "custom" the instant a fixed anchor is picked from the dropdown.
    if (layout && !this.syncing && actuallyMoved) this.syncPlacementToViewport(state, layout);
    // syncPlacementToViewport's setPrintCustomPlacement already triggers redraw() via the store
    // subscription below when it's active; the explicit call covers every other case (print frame
    // not shown — nothing to sync — or digital frame, which needs the new viewport regardless).
    this.redraw();
  }

  private subscribe(): void {
    this.unsubscribe = useMazeStore.subscribe(() => this.redraw());
  }

  private isExportPanelOpen(state: ReturnType<typeof useMazeStore.getState>): boolean {
    return state.openCard === "image_export"
      && state.openExportFormatSettings === "png"
      && state.activeRenderMode !== null
      && state.nodes.length > 0;
  }

  private currentPrintFrameLayout(state: ReturnType<typeof useMazeStore.getState>): PrintFrameLayout | null {
    if (!this.isExportPanelOpen(state) || state.pngExportSettings.outputMode !== "print" || state.activeRenderMode === null) return null;
    const wallMargin = resolveWallExportMargin(state.activeRenderMode, { vectorByWallsSettings: state.vectorByWallsSettings });
    const printFit = computePrintExportFit(state.activeTessellationConfig, state.nodes, wallMargin, state.pngExportSettings.print);
    if (printFit.sheetWidthPx <= 0 || printFit.sheetHeightPx <= 0) return null;
    const screenSize = this.getScreenSize();
    const layout = computeSheetScreenLayout(printFit.sheetWidthPx, printFit.sheetHeightPx, screenSize.width, screenSize.height);
    return { ...layout, sheetWidthPx: printFit.sheetWidthPx, sheetHeightPx: printFit.sheetHeightPx };
  }

  /** Digital canvas's world-space rect (`computeDigitalExportFit`'s `worldX`/`worldY` + size)
   * converted to screen space through the live viewport transform — recomputed fresh every call,
   * no cached/synced state (unlike the print frame, digital's canvas position is always exactly
   * derived from the current maze bbox + settings, nothing to keep in sync). */
  private currentDigitalFrameLayout(state: ReturnType<typeof useMazeStore.getState>): ScreenRect | null {
    if (!this.isExportPanelOpen(state) || state.pngExportSettings.outputMode !== "digital" || state.activeRenderMode === null) return null;
    const margin = resolveExportMargin(state.activeRenderMode, { vectorByWallsSettings: state.vectorByWallsSettings });
    const wallMargin = resolveWallExportMargin(state.activeRenderMode, { vectorByWallsSettings: state.vectorByWallsSettings });
    const fit = computeDigitalExportFit(state.activeTessellationConfig, state.nodes, margin, state.pngExportSettings.digital, wallMargin);
    if (fit.width <= 0 || fit.height <= 0) return null;
    const { scale } = this.lastViewport;
    return {
      x: fit.worldX * scale + this.lastViewport.x,
      y: fit.worldY * scale + this.lastViewport.y,
      w: (fit.width / fit.scale) * scale,
      h: (fit.height / fit.scale) * scale,
    };
  }

  /** Keeps `print.scale`/`offsetXMm`/`offsetYMm` synced to what's visible under the frame right
   * now — called only from `onViewportChanged` (an actual pan/zoom), never from the store-subscribe
   * path (`redraw()`'s other caller): that path fires on the resulting settings change too, which
   * would otherwise try to resync from its own output on every unrelated store update.
   *
   * Turns off `scaleAutoFit` first: a real pan/zoom is the user manually choosing a scale, which
   * would otherwise fight `PngExportSettingsPanel`'s auto-fit effect (that effect would immediately
   * overwrite the scale this call is about to set, back to the auto-fit value, every render). */
  private syncPlacementToViewport(state: ReturnType<typeof useMazeStore.getState>, frameLayout: ScreenRect): void {
    if (state.activeRenderMode === null) return;
    const wallMargin = resolveWallExportMargin(state.activeRenderMode, { vectorByWallsSettings: state.vectorByWallsSettings });
    const { scale, offsetXMm, offsetYMm } = computePrintPlacementFromViewport(
      state.activeTessellationConfig, state.nodes, wallMargin, state.pngExportSettings.print, this.lastViewport, frameLayout,
    );
    this.syncingDepth++;
    try {
      if (state.pngExportSettings.print.scaleAutoFit) state.setPrintScaleAutoFit(false);
      state.setPrintCustomPlacement(scale, offsetXMm, offsetYMm);
    } finally {
      this.syncingDepth--;
    }
  }

  /** Opposite direction of `syncPlacementToViewport`: when the print panel's own fields change
   * (typed scale, picked a fixed anchor, switched from digital to print, changed the sheet size),
   * moves the editor viewport so the canvas shows exactly that placement under the fixed frame.
   * Skipped while `syncing` (this settings change is our own echo of a pan/zoom) to avoid feeding
   * the viewport back into itself. */
  private syncViewportToPlacement(state: ReturnType<typeof useMazeStore.getState>, frameLayout: ScreenRect): void {
    if (state.activeRenderMode === null) return;
    const wallMargin = resolveWallExportMargin(state.activeRenderMode, { vectorByWallsSettings: state.vectorByWallsSettings });
    const { x, y, scale } = computeViewportFromPrintPlacement(
      state.activeTessellationConfig, state.nodes, wallMargin, state.pngExportSettings.print, frameLayout,
    );
    this.lastViewport = { x, y, scale };
    // setViewportTransform synchronously fans out into onViewportChanged -> syncPlacementToViewport
    // -> a store write -> a re-entrant redraw() call, all before this call returns. Guard the whole
    // call, not just the inner store write, or that re-entrant redraw() sees syncing=false and
    // starts another round of syncViewportToPlacement from the round-trip-drifted settings —
    // infinite mutual recursion (stack overflow).
    this.syncingDepth++;
    try {
      this.setViewportTransform(x, y, scale);
    } finally {
      this.syncingDepth--;
    }
  }

  private redraw(): void {
    const state = useMazeStore.getState();
    const printLayout = this.currentPrintFrameLayout(state);
    const becameActive = printLayout !== null && !this.wasFrameActive;
    this.wasFrameActive = printLayout !== null;

    if (printLayout && !this.syncing) {
      const settings = state.pngExportSettings.print;
      const sheetSizeChanged = this.sheetSizeChanged(printLayout);
      const placementChanged = this.placementChanged(settings);
      if (becameActive || sheetSizeChanged || placementChanged) {
        this.syncViewportToPlacement(state, printLayout);
      }
      this.lastPlacement = { scale: settings.scale, offsetXMm: settings.offsetXMm, offsetYMm: settings.offsetYMm, anchor: settings.anchor };
      this.lastSheetSize = { x: printLayout.x, y: printLayout.y, w: printLayout.w, h: printLayout.h };
    }

    this.graphics.clear();
    const layout = printLayout ?? this.currentDigitalFrameLayout(state);
    if (!layout) return;

    const backgroundColor = state.activeRenderMode ? resolveBackgroundColor(state.activeRenderMode, { vectorByWallsSettings: state.vectorByWallsSettings }) : 0;
    const frameColor = contrastGray(backgroundColor);

    this.drawDimOverlay(layout);
    this.drawSolidRect(layout.x, layout.y, layout.w, layout.h, frameColor);
    if (printLayout) this.drawMarginLines(printLayout, state.pngExportSettings.print, frameColor);
  }

  private lastPlacement: Pick<PrintExportSettings, "scale" | "offsetXMm" | "offsetYMm" | "anchor"> | null = null;

  private placementChanged(settings: PrintExportSettings): boolean {
    const prev = this.lastPlacement;
    if (!prev) return false;
    return prev.scale !== settings.scale || prev.offsetXMm !== settings.offsetXMm
      || prev.offsetYMm !== settings.offsetYMm || prev.anchor !== settings.anchor;
  }

  // Frame's own screen rect (computeSheetScreenLayout's x/y/w/h) changes whenever the sheet's pixel
  // dimensions change (paper size, orientation, custom width/height, DPI/density) OR whenever the
  // available screen area changes (canvas resize — side panel opening/closing, card switching,
  // DevTools) even if the sheet's own px size stays the same, since computeSheetScreenLayout always
  // re-centers/re-fits the frame within the current screen size. Re-fitting the viewport here (not
  // just redrawing the frame outline) is what keeps the maze content correctly scaled/placed
  // relative to the frame after either kind of change — without it the frame rect moves but the
  // content underneath stays at its old, now-mismatched screen position.
  private lastSheetSize: ScreenRect | null = null;

  private sheetSizeChanged(layout: ScreenRect): boolean {
    const prev = this.lastSheetSize;
    if (!prev) return false;
    return prev.x !== layout.x || prev.y !== layout.y || prev.w !== layout.w || prev.h !== layout.h;
  }

  private drawDimOverlay(layout: ScreenRect): void {
    const { width: screenW, height: screenH } = this.getScreenSize();
    // Four rects covering everything outside `layout` (top/bottom bands full-width, left/right
    // bands only the remaining height) rather than an even-odd cutout path — simpler and this
    // shape has no rotation/skew to worry about.
    this.graphics.rect(0, 0, screenW, layout.y).fill({ color: 0x000000, alpha: DIM_ALPHA });
    this.graphics.rect(0, layout.y + layout.h, screenW, screenH - layout.y - layout.h).fill({ color: 0x000000, alpha: DIM_ALPHA });
    this.graphics.rect(0, layout.y, layout.x, layout.h).fill({ color: 0x000000, alpha: DIM_ALPHA });
    this.graphics.rect(layout.x + layout.w, layout.y, screenW - layout.x - layout.w, layout.h).fill({ color: 0x000000, alpha: DIM_ALPHA });
  }

  // Pixi centers a stroke on the path — inset the rect outward by half the stroke width so the
  // whole line sits outside the canvas bounds it's marking, instead of eating into the content.
  private drawSolidRect(x: number, y: number, w: number, h: number, color: number): void {
    const half = FRAME_STROKE_WIDTH / 2;
    this.graphics.rect(x - half, y - half, w + FRAME_STROKE_WIDTH, h + FRAME_STROKE_WIDTH).stroke({ width: FRAME_STROKE_WIDTH, color });
  }

  private drawMarginLines(printLayout: PrintFrameLayout, settings: PrintExportSettings, color: number): void {
    const dpi = DPI_BY_DENSITY[settings.density];
    const sheetToScreenX = printLayout.w / printLayout.sheetWidthPx;
    const sheetToScreenY = printLayout.h / printLayout.sheetHeightPx;
    const marginHScreen = mmToPx(settings.marginHMm, dpi) * sheetToScreenX;
    const marginVScreen = mmToPx(settings.marginVMm, dpi) * sheetToScreenY;
    if (marginHScreen <= 0 && marginVScreen <= 0) return;

    const left = printLayout.x + marginHScreen;
    const right = printLayout.x + printLayout.w - marginHScreen;
    const top = printLayout.y + marginVScreen;
    const bottom = printLayout.y + printLayout.h - marginVScreen;

    if (marginHScreen > 0) {
      this.drawDashedSegment([left, printLayout.y], [left, printLayout.y + printLayout.h], color);
      this.drawDashedSegment([right, printLayout.y], [right, printLayout.y + printLayout.h], color);
    }
    if (marginVScreen > 0) {
      this.drawDashedSegment([printLayout.x, top], [printLayout.x + printLayout.w, top], color);
      this.drawDashedSegment([printLayout.x, bottom], [printLayout.x + printLayout.w, bottom], color);
    }
  }

  // Strokes each dash individually (rather than accumulating every moveTo/lineTo pair and calling
  // stroke() once at the end) — mirrors IssueHighlightOverlay's per-segment stroke() pattern, the
  // only other place in this codebase drawing disconnected line segments on one Graphics.
  private drawDashedSegment([x1, y1]: [number, number], [x2, y2]: [number, number], color: number): void {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.hypot(dx, dy);
    const ux = dx / length;
    const uy = dy / length;
    const step = DASH_LENGTH + GAP_LENGTH;

    let travelled = 0;
    while (travelled < length) {
      const dashEnd = Math.min(travelled + DASH_LENGTH, length);
      this.graphics.moveTo(x1 + ux * travelled, y1 + uy * travelled);
      this.graphics.lineTo(x1 + ux * dashEnd, y1 + uy * dashEnd);
      this.graphics.stroke({ width: MARGIN_STROKE_WIDTH, color });
      travelled += step;
    }
  }

  destroy(): void {
    this.unsubscribe?.();
    this.graphics.destroy();
  }
}
