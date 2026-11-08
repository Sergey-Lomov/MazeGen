import { Container, Graphics } from "pixi.js";
import { useMazeStore } from "../../store/mazeStore";
import { createFloorNodesSelector } from "../selectors/mazeSelectors";
import { computePrintExportFit, computeSheetScreenLayout, computePrintPlacementFromViewport, computeViewportFromPrintPlacement, DPI_BY_DENSITY, mmToPx } from "./printFit";
import { computeDigitalExportFit } from "./exportFit";
import { resolveBackgroundColor, resolveContentBoundsBasis } from "./exportMargins";
import { resolveCutPlan, resolveExportContent } from "./exportContent";
import { contrastGray } from "../colorTokens";
import type { ViewportListener } from "../sceneTypes";
import type { PrintExportSettings } from "../../store/storeTypes";
import type { ImageExportRenderer } from "./ImageExportRenderer";
import { drawPaperLayoutDim, drawPaperLayoutFrame, drawPaperLayoutMargins } from "./paperLayoutGraphics";


type ScreenRect = { x: number; y: number; w: number; h: number };
type PrintFrameLayout = ScreenRect & { sheetWidthPx: number; sheetHeightPx: number };

/** Active floor's nodes only — the export image draws one floor, so fit/placement must ignore the rest (GitHub issue #790). */
const selectActiveFloorNodes = createFloorNodesSelector();
function activeFloorNodes(state: ReturnType<typeof useMazeStore.getState>) {
  return selectActiveFloorNodes(state.nodes, state.floors, state.activeFloorId);
}

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
  // The frame is a viewport layer. Ctrl navigation intentionally leaves this transform untouched
  // while the canvas viewport continues moving.
  private frameViewport = { x: 0, y: 0, scale: 1 };
  private printFrameWorldLayout: PrintFrameLayout | null = null;
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
    private readonly setViewportTransform: (x: number, y: number, scale: number, navigation?: "layout" | "canvas") => void,
    private readonly getScreenSize: () => { width: number; height: number },
    // Optional — lets the frame read a pixel-accurate margin off the same live mode-renderer
    // instance the on-screen canvas itself uses (GitHub issue #324 follow-up), instead of a
    // Pixi-free geometric approximation. Undefined only in tests that don't need it (an
    // `ImageExportRenderer` always exists in the real scene — `MazeScene` constructs both together).
    private readonly imageExportRenderer?: ImageExportRenderer,
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

  /** Mirrors the actual transform of the frame's viewport layer. MazeScene calls this whenever
   * ordinary navigation moves the complete layout; Ctrl navigation deliberately does not. */
  setFrameViewport(x: number, y: number, scale: number): void {
    this.frameViewport = { x, y, scale };
  }

  /** "Physical size (1:1)" viewport command from the print settings panel (GitHub issue #476):
   * set the editor viewport to `targetScale` and centre the complete print layout. Deliberately does NOT write
   * `print.scale`/`anchor`/`offset` — the user changed how they view the sheet, not the maze's
   * placement on it — so it's `syncingDepth`-guarded exactly like `syncViewportToPlacement`, to
   * stop `onViewportChanged` mistaking this for a real pan/zoom and stomping the placement. A
   * genuine pan/zoom afterwards still flows through `syncPlacementToViewport` as usual. */
  applyViewportScaleAroundFrameCentre(targetScale: number): void {
    const world = this.printFrameWorldLayout;
    if (!world || targetScale <= 0) return;
    // Scale the existing layout around the sheet, rather than assigning the same transform to the
    // sheet and canvas. They can intentionally differ after canvas-only navigation; assigning
    // them a shared transform would discard that relative placement.
    const previousViewport = this.lastViewport;
    const previousFrame = this.frameViewport;
    if (previousViewport.scale <= 0) return;
    const ratio = targetScale / previousViewport.scale;
    const { width, height } = this.getScreenSize();
    const newFrameScale = previousFrame.scale * ratio;
    const newFrameX = width / 2 - (world.x + world.w / 2) * newFrameScale;
    const newFrameY = height / 2 - (world.y + world.h / 2) * newFrameScale;
    const newX = newFrameX + (previousViewport.x - previousFrame.x) * ratio;
    const newY = newFrameY + (previousViewport.y - previousFrame.y) * ratio;

    this.syncingDepth++;
    try {
      // Mark this as a layout zoom even if the scene forwards viewport changes asynchronously:
      // it must never be interpreted as canvas-only navigation and written back to placement.
      this.setViewportTransform(newX, newY, targetScale, "layout");
    } finally {
      this.syncingDepth--;
    }
    // The `setViewportTransform` callback moves the real Pixi viewport, but its `onViewportChanged`
    // echo is skipped while syncing — mirror the new transform into our own cache so a subsequent
    // real pan/zoom computes its delta from here.
    this.lastViewport = { x: newX, y: newY, scale: targetScale };
    this.frameViewport = { x: newFrameX, y: newFrameY, scale: newFrameScale };
    this.redraw();
  }

  /** Restores the complete print layout (sheet and canvas) to its padded screen-fit position. */
  fitLayoutToScreen(): boolean {
    const state = useMazeStore.getState();
    const layout = this.basePrintFrameLayout(state);
    const world = this.printFrameWorldLayout;
    if (!layout || !world) return false;
    const scale = layout.w / world.w;
    const x = layout.x - world.x * scale;
    const y = layout.y - world.y * scale;
    this.frameViewport = { x, y, scale };
    this.lastViewport = this.frameViewport;
    this.syncingDepth++;
    try {
      this.setViewportTransform(x, y, scale);
    } finally {
      this.syncingDepth--;
    }
    this.redraw();
    return true;
  }

  // w/h unused: screen size is now read live via getScreenSize() at redraw time (see its doc
  // comment) rather than cached from this callback's params, to avoid drawing against a stale
  // canvas size on any redraw that isn't itself triggered by a viewport change.
  onViewportChanged(x: number, y: number, _w: number, _h: number, scale: number, navigation?: "layout" | "canvas"): void {
    // A resize-triggered syncLayersToViewport() re-fires this with the *same* x/y/scale as before
    // (nothing actually panned/zoomed) — only a genuine value change is real user pan/zoom.
    const previousViewport = this.lastViewport;
    const actuallyMoved = x !== previousViewport.x || y !== previousViewport.y || scale !== previousViewport.scale;
    this.lastViewport = { x, y, scale };
    const state = useMazeStore.getState();
    const layout = this.currentPrintFrameLayout(state);
    // Skip while syncing: this viewport change is our own syncViewportToPlacement() echo (a
    // settings-panel edit pushed onto the canvas), not real user pan/zoom — syncing it back would
    // immediately stomp anchor to "custom" the instant a fixed anchor is picked from the dropdown.
    if (layout && !this.syncing && actuallyMoved && navigation !== "layout") this.syncPlacementToViewport(state, layout);
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
      // Hidden while another `SidePanel` covers the PNG settings panel (GitHub issue #629
      // follow-up) — the frame/dimming would otherwise keep showing for a panel the user can no
      // longer see or act on.
      && !state.exportFormatSettingsCovered
      && state.activeRenderMode !== null
      && state.nodes.length > 0;
  }

  /** Resolves the active mode's own pixel-accurate export margin (GitHub issue #324 follow-up) off
   * the live mode-renderer instance the on-screen canvas itself uses — zero margin (not "no frame
   * at all") when there's no `ImageExportRenderer` on hand, which only happens in tests that don't
   * exercise margin precision; the real scene always constructs both together. */
  private resolveMargin(state: ReturnType<typeof useMazeStore.getState>) {
    if (state.activeRenderMode === null) return { left: 0, right: 0, top: 0, bottom: 0 };
    return this.imageExportRenderer?.getModeRenderer(state.activeRenderMode)?.getRequiredExportMargin()
      ?? { left: 0, right: 0, top: 0, bottom: 0 };
  }

  /** The margin and bounds basis of the fit math: the active mode's own, or the cut sheet's region
   * when a glue has a cut line (GitHub issue #859). */
  private resolveContent(state: ReturnType<typeof useMazeStore.getState>) {
    const modeMargin = this.resolveMargin(state);
    const plan = resolveCutPlan({
      cfg: state.activeFieldConfig,
      floorId: state.activeFloorId,
      topology: state.floorTopology[state.activeFloorId],
      cuts: state.pngExportSettings.cuts,
      floorNodes: activeFloorNodes(state),
      margin: () => modeMargin,
    });
    return resolveExportContent(plan, modeMargin, resolveContentBoundsBasis(state.activeRenderMode!));
  }

  private basePrintFrameLayout(state: ReturnType<typeof useMazeStore.getState>): PrintFrameLayout | null {
    if (!this.isExportPanelOpen(state) || state.pngExportSettings.outputMode !== "print" || state.activeRenderMode === null) return null;
    const { margin, basis } = this.resolveContent(state);
    const printFit = computePrintExportFit(state.activeFieldConfig, activeFloorNodes(state), margin, state.pngExportSettings.print, basis);
    if (printFit.sheetWidthPx <= 0 || printFit.sheetHeightPx <= 0) return null;
    const screenSize = this.getScreenSize();
    const layout = computeSheetScreenLayout(printFit.sheetWidthPx, printFit.sheetHeightPx, screenSize.width, screenSize.height);
    return { ...layout, sheetWidthPx: printFit.sheetWidthPx, sheetHeightPx: printFit.sheetHeightPx };
  }

  private currentPrintFrameLayout(state: ReturnType<typeof useMazeStore.getState>): PrintFrameLayout | null {
    const layout = this.printFrameWorldLayout;
    if (!layout || !this.basePrintFrameLayout(state)) return null;
    const transform = this.frameViewport;
    return {
      x: layout.x * transform.scale + transform.x,
      y: layout.y * transform.scale + transform.y,
      w: layout.w * transform.scale,
      h: layout.h * transform.scale,
      sheetWidthPx: layout.sheetWidthPx,
      sheetHeightPx: layout.sheetHeightPx,
    };
  }


  /** Digital canvas's world-space rect (`computeDigitalExportFit`'s `worldX`/`worldY` + size)
   * converted to screen space through the live viewport transform — recomputed fresh every call,
   * no cached/synced state (unlike the print frame, digital's canvas position is always exactly
   * derived from the current maze bbox + settings, nothing to keep in sync). */
  private currentDigitalFrameLayout(state: ReturnType<typeof useMazeStore.getState>): ScreenRect | null {
    if (!this.isExportPanelOpen(state) || state.pngExportSettings.outputMode !== "digital" || state.activeRenderMode === null) return null;
    const { margin, basis } = this.resolveContent(state);
    const fit = computeDigitalExportFit(state.activeFieldConfig, activeFloorNodes(state), margin, state.pngExportSettings.digital, basis);
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
   * Clears the legacy `scaleAutoFit` project flag first. A real pan/zoom is a manual scale choice. */
  private syncPlacementToViewport(state: ReturnType<typeof useMazeStore.getState>, frameLayout: ScreenRect): void {
    if (state.activeRenderMode === null) return;
    const { margin, basis } = this.resolveContent(state);
    const { scale, offsetXMm, offsetYMm } = computePrintPlacementFromViewport(
      state.activeFieldConfig, activeFloorNodes(state), margin, state.pngExportSettings.print, this.lastViewport, frameLayout, basis,
    );
    this.syncingDepth++;
    try {
      if (state.pngExportSettings.print.scaleAutoFit) state.setPrintScaleAutoFit(false);
      state.setPrintCustomPlacement(scale, offsetXMm, offsetYMm);
      const print = useMazeStore.getState().pngExportSettings.print;
      // The surrounding onViewportChanged() redraw runs after this guarded store write. Mark this
      // placement as observed now, otherwise that redraw treats the Ctrl-only move as a panel edit
      // and calls syncViewportToPlacement(), moving the sheet as well.
      this.lastPlacement = { scale: print.scale, offsetXMm: print.offsetXMm, offsetYMm: print.offsetYMm, anchor: print.anchor };
    } finally {
      this.syncingDepth--;
    }
  }

  /** Opposite direction of `syncPlacementToViewport`: when the print panel's own fields change
   * (typed scale, picked a fixed anchor, switched from digital to print, changed the sheet size),
   * moves the editor viewport so the canvas shows exactly that placement under the fixed frame.
   * Skipped while `syncing` (this settings change is our own echo of a pan/zoom) to avoid feeding
   * the viewport back into itself. */
  private syncViewportToPlacement(state: ReturnType<typeof useMazeStore.getState>, frameLayout: ScreenRect, canvasOnly = false): void {
    if (state.activeRenderMode === null) return;
    const { margin, basis } = this.resolveContent(state);
    const { x, y, scale } = computeViewportFromPrintPlacement(
      state.activeFieldConfig, activeFloorNodes(state), margin, state.pngExportSettings.print, frameLayout, basis,
    );
    this.lastViewport = { x, y, scale };
    if (!canvasOnly) this.frameViewport = { x, y, scale };
    // setViewportTransform synchronously fans out into onViewportChanged -> syncPlacementToViewport
    // -> a store write -> a re-entrant redraw() call, all before this call returns. Guard the whole
    // call, not just the inner store write, or that re-entrant redraw() sees syncing=false and
    // starts another round of syncViewportToPlacement from the round-trip-drifted settings —
    // infinite mutual recursion (stack overflow).
    this.syncingDepth++;
    try {
      this.setViewportTransform(x, y, scale, canvasOnly ? "canvas" : undefined);
    } finally {
      this.syncingDepth--;
    }
  }

  private redraw(): void {
    const state = useMazeStore.getState();
    const basePrintLayout = this.basePrintFrameLayout(state);
    let printLayout = this.currentPrintFrameLayout(state) ?? basePrintLayout;
    const becameActive = printLayout !== null && !this.wasFrameActive;
    this.wasFrameActive = printLayout !== null;

    if (printLayout && !this.syncing) {
      const settings = state.pngExportSettings.print;
      const sheetSizeChanged = this.sheetSizeChanged(basePrintLayout!);
      const placementChanged = this.placementChanged(settings);
      const activeFloorChanged = this.lastActiveFloorId !== null && this.lastActiveFloorId !== state.activeFloorId;
      const initialPlacement = becameActive || this.printFrameWorldLayout === null || activeFloorChanged;
      if (initialPlacement || placementChanged || sheetSizeChanged) {
        // Once the preview exists, Scale/anchor/offset are canvas-local edits. They must win over
        // a coincidental frame-size recalculation and must never recenter the sheet.
        const canvasOnly = !initialPlacement && placementChanged;
        // A canvas-only edit is relative to the sheet where it is *now*, not to the original
        // screen-centred frame used when the panel opened. Using the latter was the remaining
        // source of the apparent centring on every Scale edit after the layout had been moved.
        const placementFrame = canvasOnly ? this.currentPrintFrameLayout(state)! : basePrintLayout!;
        this.syncViewportToPlacement(state, placementFrame, canvasOnly);
        if (!canvasOnly) {
          this.printFrameWorldLayout = { ...this.toFrameWorld(basePrintLayout!), sheetWidthPx: basePrintLayout!.sheetWidthPx, sheetHeightPx: basePrintLayout!.sheetHeightPx };
          printLayout = basePrintLayout!;
        } else {
          // The sheet is unchanged; only the canvas viewport is updated relative to it.
          printLayout = placementFrame;
        }
      }
      this.lastPlacement = { scale: settings.scale, offsetXMm: settings.offsetXMm, offsetYMm: settings.offsetYMm, anchor: settings.anchor };
      this.lastSheetSize = { x: basePrintLayout!.x, y: basePrintLayout!.y, w: basePrintLayout!.w, h: basePrintLayout!.h };
    }

    this.lastActiveFloorId = state.activeFloorId;

    this.graphics.clear();
    const layout = printLayout ?? this.currentDigitalFrameLayout(state);
    if (!layout) return;

    const backgroundColor = state.activeRenderMode ? resolveBackgroundColor(state.activeRenderMode, { vectorByWallsSettings: state.vectorByWallsSettings, vectorByCorridorsSettings: state.vectorByCorridorsSettings }) : 0;
    const frameColor = contrastGray(backgroundColor);

    const drawLayout = this.toFrameWorld(layout);
    this.drawDimOverlay(drawLayout);
    // `drawLayout` is in the viewport layer's coordinates, so counter that layer's scale to keep
    // the frame and dashes visually stable as a paper-size change refits the viewport.
    drawPaperLayoutFrame(this.graphics, drawLayout, frameColor, this.frameViewport.scale);
    if (printLayout) {
      const dpi = DPI_BY_DENSITY[state.pngExportSettings.print.density];
      const sheetToScreenX = drawLayout.w / printLayout.sheetWidthPx;
      const sheetToScreenY = drawLayout.h / printLayout.sheetHeightPx;
      drawPaperLayoutMargins(
        this.graphics,
        drawLayout,
        mmToPx(state.pngExportSettings.print.marginHMm, dpi) * sheetToScreenX,
        mmToPx(state.pngExportSettings.print.marginVMm, dpi) * sheetToScreenY,
        frameColor,
        this.frameViewport.scale,
      );
    }
  }

  private lastActiveFloorId: string | null = null;

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
    drawPaperLayoutDim(this.graphics, layout, this.toFrameWorld({ x: 0, y: 0, w: screenW, h: screenH }));
    // Four rects covering everything outside `layout` (top/bottom bands full-width, left/right
    // bands only the remaining height) rather than an even-odd cutout path — simpler and this
    // shape has no rotation/skew to worry about.
  }

  private toFrameWorld(layout: ScreenRect): ScreenRect {
    return {
      x: (layout.x - this.frameViewport.x) / this.frameViewport.scale,
      y: (layout.y - this.frameViewport.y) / this.frameViewport.scale,
      w: layout.w / this.frameViewport.scale,
      h: layout.h / this.frameViewport.scale,
    };
  }

  // Pixi centers a stroke on the path — inset the rect outward by half the stroke width so the
  // whole line sits outside the canvas bounds it's marking, instead of eating into the content.
  // Strokes each dash individually (rather than accumulating every moveTo/lineTo pair and calling
  // stroke() once at the end) — mirrors IssueHighlightOverlay's per-segment stroke() pattern, the
  // only other place in this codebase drawing disconnected line segments on one Graphics.
  destroy(): void {
    this.unsubscribe?.();
    this.graphics.destroy();
  }
}
