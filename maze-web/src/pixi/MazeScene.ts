import { Application, Container, Rectangle } from "pixi.js";
import { GenerationRenderer } from "./GenerationRenderer";
import { TessellationRenderer } from "./TessellationRenderer";
import { AnalyticsRenderer } from "./AnalyticsRenderer";
import { FieldEditorOverlay } from "./FieldEditorOverlay";
import { FieldEditController } from "./FieldEditController";
import { PrimitivePreviewOverlay } from "./PrimitivePreviewOverlay";
import { PresetConnectionsRenderer } from "./PresetConnectionsRenderer";
import { PresetConnectionsController } from "./PresetConnectionsController";
import { PostEditRenderer } from "./PostEditRenderer";
import { PostEditController } from "./PostEditController";
import { ImageExportRenderer } from "./imageExport/ImageExportRenderer";
import { ExportFrameOverlay } from "./imageExport/ExportFrameOverlay";
import { PngExporter } from "./imageExport/PngExporter";
import { fitFieldViewport } from "./FieldEditorOverlay";
import { fitMazeViewport } from "./viewportFit";
import { makeProjection } from "./tessellationProjection";
import type { TessellationProjection } from "./tessellationProjection";
import { useMazeStore } from "../store/mazeStore";
import type { ViewportListener, PointerHandler } from "./sceneTypes";
import { SceneInteraction } from "./SceneInteraction";
import type { HoverInfo, HoverProvider } from "./hoverTypes";
import { DefaultHoverProvider } from "./hoverProviders";
import type { FeatureId, PngExportSettings } from "../store/storeTypes";
import type { FieldPrimitive } from "../store/tessellationTypes";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";

type ConfigResolver = (st: ReturnType<typeof useMazeStore.getState>) => TessellationConfig;

export const TESSELLATION_CONFIG_BY_CARD: Record<FeatureId, ConfigResolver> = {
  basic_config: (st) => st.previewTessellationConfig,
  floors: (st) => st.floorFields[st.activeFloorId].tessellationConfig,
  field_setup: (st) => st.floorFields[st.activeFloorId].tessellationConfig,
  preset_connections: (st) => st.floorFields[st.activeFloorId].tessellationConfig,
  quality: (st) => st.floorFields[st.activeFloorId].tessellationConfig,
  generation: (st) => st.activeTessellationConfig,
  post_edit: (st) => st.activeTessellationConfig,
  analytics: (st) => st.activeTessellationConfig,
  image_export: (st) => st.activeTessellationConfig,
};

export function shouldCancelFieldEditGesture(args: {
  openChanged: boolean;
  floorChanged: boolean;
  modeChanged: boolean;
  primitiveChanged: boolean;
  configChanged: boolean;
  fieldPointsChanged: boolean;
  fieldEditMode: "default" | "custom";
  fieldPrimitive: FieldPrimitive;
}): boolean {
  const pointBrushUpdate = args.fieldEditMode === "custom"
    && args.fieldPrimitive === "point"
    && args.fieldPointsChanged;
  return args.openChanged
    || args.floorChanged
    || args.modeChanged
    || args.primitiveChanged
    || (args.configChanged && !pointBrushUpdate);
}

export class MazeScene {
  private app: Application;
  private viewport: Container;
  private generationRenderer: GenerationRenderer;
  private tessellationRenderer: TessellationRenderer;
  private tessellationContainer: Container;
  private fieldEditorOverlay: FieldEditorOverlay;
  private fieldEditorOverlayContainer: Container;
  private fieldEditController: FieldEditController;
  private primitivePreviewOverlay: PrimitivePreviewOverlay;
  private primitivePreviewContainer: Container;
  private presetConnectionsRenderer: PresetConnectionsRenderer;
  private presetConnectionsContainer: Container;
  private presetConnectionsController: PresetConnectionsController;
  private postEditRenderer: PostEditRenderer;
  private postEditContainer: Container;
  private postEditController: PostEditController;
  private analyticsRenderer: AnalyticsRenderer;
  private analyticsContainer: Container;
  private imageExportRenderer: ImageExportRenderer;
  private imageExportContainer: Container;
  private imageExportFrameContainer: Container;
  private exportFrameOverlay: ExportFrameOverlay;
  private pngExporter: PngExporter;
  private interaction: SceneInteraction;
  private hoverProvider: DefaultHoverProvider;
  private hoverCallback: ((info: HoverInfo | null) => void) | null = null;
  private viewportScaleCallback: ((scale: number) => void) | null = null;
  private cachedProjection: { cfg: TessellationConfig; projection: TessellationProjection } | null = null;

  // All containers that must stay in sync with viewport position/scale.
  private syncedLayers: Container[] = [];
  // All renderers/overlays that must be notified when the viewport changes.
  private viewportListeners: ViewportListener[] = [];

  private unsubscribeEditField: (() => void) | null = null;
  private unsubscribePreview: (() => void) | null = null;
  private unsubscribeQualityOpen: (() => void) | null = null;
  private unsubscribeQualityRules: (() => void) | null = null;
  private qualityRulesConfirmTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(app: Application) {
    this.app = app;

    this.viewport = new Container();

    this.fieldEditorOverlayContainer = new Container();
    this.primitivePreviewContainer = new Container();
    this.presetConnectionsContainer = new Container();
    this.postEditContainer = new Container();
    this.tessellationContainer = new Container();
    this.analyticsContainer = new Container();
    this.imageExportContainer = new Container();
    // Deliberately NOT in syncedLayers — hosts ExportFrameOverlay, which draws in screen space.
    // Print mode's frame is a fixed rect (the sheet stays put while the maze content underneath
    // keeps panning/zooming with the normal viewport); digital mode's frame instead recomputes its
    // screen rect from the live viewport transform on every change. See ExportFrameOverlay.
    this.imageExportFrameContainer = new Container();

    this.syncedLayers = [
      this.fieldEditorOverlayContainer,
      this.primitivePreviewContainer,
      this.presetConnectionsContainer,
      this.postEditContainer,
      this.tessellationContainer,
      this.analyticsContainer,
      this.imageExportContainer,
    ];

    this.app.stage.addChild(this.viewport);
    for (const layer of this.syncedLayers) this.app.stage.addChild(layer);
    this.app.stage.addChild(this.imageExportFrameContainer);

    const cx = app.screen.width / 2;
    const cy = app.screen.height / 2;
    this.viewport.x = cx;
    this.viewport.y = cy;
    for (const layer of this.syncedLayers) { layer.x = cx; layer.y = cy; }

    this.generationRenderer = new GenerationRenderer(this.viewport);
    this.tessellationRenderer = new TessellationRenderer(this.tessellationContainer);
    this.analyticsRenderer = new AnalyticsRenderer(this.analyticsContainer);
    this.imageExportRenderer = new ImageExportRenderer(this.imageExportContainer);
    this.exportFrameOverlay = new ExportFrameOverlay(
      this.imageExportFrameContainer,
      (x, y, scale) => this.setViewportTransform(x, y, scale),
      () => ({ width: this.app.screen.width, height: this.app.screen.height }),
      this.imageExportRenderer,
    );
    this.pngExporter = new PngExporter(this.app);

    this.fieldEditorOverlay = new FieldEditorOverlay(this.fieldEditorOverlayContainer);
    this.primitivePreviewOverlay = new PrimitivePreviewOverlay(this.primitivePreviewContainer);
    this.presetConnectionsRenderer = new PresetConnectionsRenderer(this.presetConnectionsContainer);
    this.postEditRenderer = new PostEditRenderer(this.postEditContainer);

    this.viewportListeners = [
      this.generationRenderer,
      this.fieldEditorOverlay,
      this.primitivePreviewOverlay,
      this.presetConnectionsRenderer,
      this.postEditRenderer,
      this.tessellationRenderer,
      this.analyticsRenderer,
      this.imageExportRenderer,
      this.exportFrameOverlay,
    ];

    this.presetConnectionsController = new PresetConnectionsController(
      () => this.viewport,
      this.presetConnectionsRenderer,
      (x, y) => { this.viewport.x = x; this.viewport.y = y; this.syncLayersToViewport(); },
    );
    this.postEditController = new PostEditController(
      () => this.viewport,
      this.postEditRenderer,
      (x, y) => { this.viewport.x = x; this.viewport.y = y; this.syncLayersToViewport(); },
    );

    this.hoverProvider = new DefaultHoverProvider(
      () => this.viewport,
      () => this.getProjectionFor(this.getActiveTessellationConfig(useMazeStore.getState())),
    );

    this.interaction = new SceneInteraction({
      app: this.app,
      viewport: this.viewport,
      getFieldEditController: () => this.fieldEditController,
      fieldEditorOverlay: this.fieldEditorOverlay,
      getController: (st) => this.getController(st),
      getHoverProvider: (st) => this.getHoverProvider(st),
      onHoverChanged: (info) => this.hoverCallback?.(info),
      onViewportChanged: () => this.syncLayersToViewport(),
      onResetZoom: () => this.resetZoomToOne(),
    });

    this.fieldEditController = new FieldEditController(
      app.canvas,
      () => {
        const state = useMazeStore.getState();
        const cfg = state.floorFields[state.activeFloorId].tessellationConfig;
        return makeProjection(cfg);
      },
      () => this.viewport,
      {
        startPan: (x, y) => this.interaction.defaultPan.begin(x, y),
        movePan: (x, y) => this.interaction.defaultPan.move(x, y),
        endPan: () => this.interaction.defaultPan.end(),
      },
      {
        onPreviewUpdate: (cells, btn, kind, cfg, geometry) => {
          this.primitivePreviewOverlay.update(cells, btn, kind, cfg, geometry);
        },
        onPreviewClear: () => {
          this.primitivePreviewOverlay.clear();
        },
        onPrimitiveCommit: (cells, btn) => {
          const store = useMazeStore.getState();
          if (btn === 0) store.addFieldPoints(cells);
          else if (btn === 2) store.removeFieldPoints(cells);
        },
        onSymmetryPreviewUpdate: (axis, polygon) => {
          this.fieldEditorOverlay.updateSymmetryPreview(axis, polygon);
        },
      },
    );

    this.subscribeToEditField();
    this.subscribeToPreview();
    this.subscribeToQualityOpen();
    this.subscribeToQualityRulesReconfirm();
    this.syncLayersToViewport();
  }

  /** Resolves the controller that owns pointer interaction for the current card, or null for default pan. */
  private getController(st: ReturnType<typeof useMazeStore.getState>): PointerHandler | null {
    if (st.openCard === "field_setup" && st.floorFields[st.activeFloorId].fieldEditMode === "custom") return this.fieldEditController;
    if (st.openCard === "preset_connections") return this.presetConnectionsController;
    if (st.openCard === "post_edit") return this.postEditController;
    return null;
  }

  /** Which TessellationConfig represents "the current field" for hover purposes, per open card.
   * NOT reused by refit() — refit()'s fieldCfg answers a different question (what to fit when the
   * maze view is NOT shown), which only partially overlaps with this table. */
  private getActiveTessellationConfig(st: ReturnType<typeof useMazeStore.getState>): TessellationConfig {
    return TESSELLATION_CONFIG_BY_CARD[st.openCard](st);
  }

  private getProjectionFor(cfg: TessellationConfig): TessellationProjection {
    if (this.cachedProjection?.cfg !== cfg) {
      this.cachedProjection = { cfg, projection: makeProjection(cfg) };
    }
    return this.cachedProjection.projection;
  }

  /** Resolves the active hover provider for the current card. Currently every card uses the same
   * generic cell-lookup provider; a future per-feature override (e.g. edge hit-testing) would
   * branch on st.openCard here the same way getController() does. `st` is unused today — kept for
   * signature symmetry with getController() and because that future branch will need it. */
  private getHoverProvider(st: ReturnType<typeof useMazeStore.getState>): HoverProvider {
    void st;
    return this.hoverProvider;
  }

  /** Supports exactly one listener — HoverInfoPanel. Calling this while a different listener is
   * already registered clears it (sends null) before attaching the new one, so no stale value
   * survives a hot-swap (e.g. React StrictMode double-invoke, or panel remount). Re-passing the
   * same callback instance is a no-op. */
  setHoverListener(cb: ((info: HoverInfo | null) => void) | null): void {
    if (cb === this.hoverCallback) return;
    this.hoverCallback?.(null);
    this.hoverCallback = cb;
  }

  /** Same one-listener contract as `setHoverListener` — HoverInfoPanel's viewport-scale readout,
   * fired from `syncLayersToViewport()` on every pan/zoom (not just hover-triggered pointer
   * moves), since a wheel-zoom without pointer movement wouldn't otherwise notify it. */
  setViewportScaleListener(cb: ((scale: number) => void) | null): void {
    if (cb === this.viewportScaleCallback) return;
    this.viewportScaleCallback = cb;
    this.viewportScaleCallback?.(this.viewport.scale.x);
  }

  /** Resets the current viewport transform back to a 1:1 scale while keeping the same world point
   * under the screen center. */
  resetZoomToOne(): void {
   const currentScale = this.viewport.scale.x;
   if (!Number.isFinite(currentScale) || currentScale === 0 || Math.abs(currentScale - 1) < 1e-9) return;
   const cx = this.app.screen.width / 2;
   const cy = this.app.screen.height / 2;
   this.viewport.x = cx + (this.viewport.x - cx) / currentScale;
   this.viewport.y = cy + (this.viewport.y - cy) / currentScale;
   this.viewport.scale.set(1);
   this.syncLayersToViewport();
  }

  private subscribeToPreview(): void {
    let prevPreview = useMazeStore.getState().previewTessellationConfig;
    let prevCard = useMazeStore.getState().openCard;
    this.unsubscribePreview = useMazeStore.subscribe((state) => {
      const previewChanged = state.previewTessellationConfig !== prevPreview;
      const openChanged = state.openCard !== prevCard;
      prevPreview = state.previewTessellationConfig;
      prevCard = state.openCard;
      if (previewChanged || openChanged) {
        this.syncLayersToViewport();
      }
    });
  }

  private subscribeToQualityOpen(): void {
    let prevCard = useMazeStore.getState().openCard;
    this.unsubscribeQualityOpen = useMazeStore.subscribe((state) => {
      if (state.openCard !== prevCard) {
        const wasQuality = prevCard === "quality";
        const isQuality = state.openCard === "quality";
        prevCard = state.openCard;
        if (isQuality) this.app.ticker.stop();
        else if (wasQuality) this.app.ticker.start();
      }
    });
  }

  /** Keeps post-edit's QC report/analytics in sync with the active ruleset (GitHub issue #111) —
   * editing checks/strategies/stages in the Quality panel while a maze is loaded otherwise leaves
   * `postEditAnalytics` stale, still reflecting whatever ruleset was active at the last confirm.
   * Debounces a `confirmPostEdit()` (~300ms, same interval `PostEditController.scheduleConfirm`
   * uses for edge edits) on every `rules`/`stages` change, and flushes immediately — bypassing the
   * debounce — the moment the user leaves the Quality panel, so the report is never left stale
   * once the panel that could have caused the staleness closes. `confirmPostEdit` itself is a
   * no-op before the first generation (`postEditDraftEdges === null`), so no extra guard is needed
   * here for that case. */
  private subscribeToQualityRulesReconfirm(): void {
    let prevRules = useMazeStore.getState().rules;
    let prevStages = useMazeStore.getState().stages;
    let prevCard = useMazeStore.getState().openCard;
    this.unsubscribeQualityRules = useMazeStore.subscribe((state) => {
      const rulesChanged = state.rules !== prevRules || state.stages !== prevStages;
      prevRules = state.rules;
      prevStages = state.stages;
      const wasQuality = prevCard === "quality";
      const leftQuality = wasQuality && state.openCard !== "quality";
      prevCard = state.openCard;

      if (leftQuality) {
        if (this.qualityRulesConfirmTimer !== null) {
          clearTimeout(this.qualityRulesConfirmTimer);
          this.qualityRulesConfirmTimer = null;
        }
        void useMazeStore.getState().confirmPostEdit();
        return;
      }
      if (rulesChanged && state.openCard === "quality") {
        if (this.qualityRulesConfirmTimer !== null) clearTimeout(this.qualityRulesConfirmTimer);
        this.qualityRulesConfirmTimer = setTimeout(() => {
          this.qualityRulesConfirmTimer = null;
          void useMazeStore.getState().confirmPostEdit();
        }, 300);
      }
    });
  }

  private subscribeToEditField(): void {
    const initial = useMazeStore.getState();
    let prevCard = initial.openCard;
    let prevFloorId = initial.activeFloorId;
    let prevMode = initial.floorFields[initial.activeFloorId].fieldEditMode;
    let prevPrimitive = initial.floorFields[initial.activeFloorId].fieldPrimitive;
    let prevFieldPoints = initial.floorFields[initial.activeFloorId].fieldPoints;
    let prevConfig = initial.floorFields[initial.activeFloorId].tessellationConfig;
    let prevFrameVisible = initial.showPrimitiveFrame;
    this.primitivePreviewOverlay.setFrameVisible(initial.showPrimitiveFrame);
    this.unsubscribeEditField = useMazeStore.subscribe((state) => {
      const field = state.floorFields[state.activeFloorId];
      const isFieldSetup = state.openCard === "field_setup";
      const openChanged = state.openCard !== prevCard;
      const floorChanged = state.activeFloorId !== prevFloorId;
      const modeChanged = field.fieldEditMode !== prevMode;
      const primitiveChanged = field.fieldPrimitive !== prevPrimitive;
      const fieldPointsChanged = field.fieldPoints !== prevFieldPoints;
      const configChanged = field.tessellationConfig !== prevConfig;
      const frameVisibilityChanged = state.showPrimitiveFrame !== prevFrameVisible;
      prevCard = state.openCard;
      prevFloorId = state.activeFloorId;
      prevMode = field.fieldEditMode;
      prevPrimitive = field.fieldPrimitive;
      prevFieldPoints = field.fieldPoints;
      prevConfig = field.tessellationConfig;
      prevFrameVisible = state.showPrimitiveFrame;
      if (frameVisibilityChanged) this.primitivePreviewOverlay.setFrameVisible(state.showPrimitiveFrame);
      if (shouldCancelFieldEditGesture({
        openChanged,
        floorChanged,
        modeChanged,
        primitiveChanged,
        configChanged,
        fieldPointsChanged,
        fieldEditMode: field.fieldEditMode,
        fieldPrimitive: field.fieldPrimitive,
      })) {
        this.fieldEditController.cancelPointerGesture();
        this.primitivePreviewOverlay.clear();
        this.fieldEditorOverlay.updateHover(null, field.tessellationConfig);
      }
      if (!isFieldSetup) {
        return;
      }
      if (openChanged) return;
    });
  }

  private syncLayersToViewport(): void {
    for (const layer of this.syncedLayers) {
      layer.x = this.viewport.x;
      layer.y = this.viewport.y;
      layer.scale.x = this.viewport.scale.x;
      layer.scale.y = this.viewport.scale.y;
    }
    for (const listener of this.viewportListeners) {
      listener.onViewportChanged(
        this.viewport.x,
        this.viewport.y,
        this.app.screen.width,
        this.app.screen.height,
        this.viewport.scale.x,
      );
    }
    this.viewportScaleCallback?.(this.viewport.scale.x);
  }

  exportPng(settings: PngExportSettings): Promise<Blob | null> {
    return this.pngExporter.export(settings);
  }

  getViewportScale(): number {
    return this.viewport.scale.x;
  }

  /** The live on-screen Pixi canvas element (GitHub issue #507's eyedropper) — used only to
   *  resolve its screen rect. Its own WebGL buffer isn't `preserveDrawingBuffer`, so pixels are
   *  always read back through `extract.pixels()` (`sampleColorAt` / `sampleRegionAt`), never via
   *  a raw `drawImage` of the element. */
  get canvas(): HTMLCanvasElement {
    return this.app.canvas;
  }

  /** Converts client (viewport) coordinates to the canvas's own physical-pixel space (canvas rect
   *  + device pixel ratio, same conversion `SceneInteraction`'s wheel handler applies). Returns
   *  `null` for a point outside the canvas. */
  private clientToCanvasPx(clientX: number, clientY: number): { px: number; py: number } | null {
    const rect = this.app.canvas.getBoundingClientRect();
    if (clientX < rect.left || clientX >= rect.right || clientY < rect.top || clientY >= rect.bottom) return null;
    return {
      px: Math.floor((clientX - rect.left) * (this.app.canvas.width / rect.width)),
      py: Math.floor((clientY - rect.top) * (this.app.canvas.height / rect.height)),
    };
  }

  /** Reads the rendered color at the given client (viewport) coordinates via
   *  `renderer.extract.pixels()` (GitHub issue #507's eyedropper) — samples the actual on-screen
   *  stage, not the maze model, so it picks up backgrounds, grid, and anything else drawn.
   *  Returns `null` for a point outside the canvas. Packed 24-bit RGB. */
  sampleColorAt(clientX: number, clientY: number): number | null {
    const canvasPx = this.clientToCanvasPx(clientX, clientY);
    if (!canvasPx) return null;
    const resolution = this.app.renderer.resolution;
    const unit = Math.max(1, 1 / resolution);
    const { pixels, width, height } = this.app.renderer.extract.pixels({
      target: this.app.stage,
      frame: new Rectangle(canvasPx.px / resolution, canvasPx.py / resolution, unit, unit),
    });
    if (width === 0 || height === 0) return null;
    return (pixels[0] << 16) | (pixels[1] << 8) | pixels[2];
  }

  /** Reads a square of raw RGBA pixels (canvas physical pixels) around the given client
   *  coordinates, for the eyedropper's magnified loupe (GitHub issue #507) — the loupe can't
   *  `drawImage` the live canvas directly (see `canvas` getter), so it reads the same way
   *  `sampleColorAt` does and paints the region itself. `radiusPx` is how many whole pixels to
   *  include on each side of the sampled pixel, so the region is always `2*radiusPx + 1` pixels
   *  wide/tall — an odd count with the sampled pixel exactly centered (an even-width region has no
   *  single center pixel, so a crosshair drawn at its middle would sit on the boundary between two
   *  pixels instead of inside one). Returns `null` for a point outside the canvas; the region is
   *  clamped to the canvas bounds, so it can come back smaller near an edge (off-center there, but
   *  edge pixels are rarely picked). */
  sampleRegionAt(clientX: number, clientY: number, radiusPx: number): { pixels: Uint8ClampedArray; width: number; height: number; centerX: number; centerY: number } | null {
    const canvasPx = this.clientToCanvasPx(clientX, clientY);
    if (!canvasPx) return null;
    const resolution = this.app.renderer.resolution;
    const left = Math.max(0, canvasPx.px - radiusPx);
    const top = Math.max(0, canvasPx.py - radiusPx);
    const right = Math.min(this.app.canvas.width, canvasPx.px + radiusPx + 1);
    const bottom = Math.min(this.app.canvas.height, canvasPx.py + radiusPx + 1);
    const w = right - left;
    const h = bottom - top;
    if (w <= 0 || h <= 0) return null;
    const { pixels, width, height } = this.app.renderer.extract.pixels({
      target: this.app.stage,
      frame: new Rectangle(left / resolution, top / resolution, w / resolution, h / resolution),
    });
    if (width === 0 || height === 0) return null;
    return { pixels, width, height, centerX: canvasPx.px - left, centerY: canvasPx.py - top };
  }

  /** Physical 1:1 request from the print settings panel (GitHub issue #476) — a pure viewport
   * command: zoom the editor to `targetScale`, keeping the point under the print frame's centre
   * fixed on screen. Does NOT touch print placement (`print.scale`/`anchor`/`offset`) — that
   * stays the export contract; a later real pan/zoom moves placement as usual. */
  applyPrintPhysicalZoom(targetScale: number): void {
    this.exportFrameOverlay.applyViewportScaleAroundFrameCentre(targetScale);
  }

  /** Re-notifies every `viewportListeners` entry (and `ExportFrameOverlay`'s screen-space frame,
   * via `syncLayersToViewport`'s fresh `app.screen.width/height` read) with the current viewport
   * transform, without changing it — for a real canvas-size change (the DOM element itself
   * resized, e.g. a side panel opening/closing, DevTools toggling) that isn't already followed by
   * a pan/zoom/refit. Pixi's own `resizeTo` updates `app.screen` on such a resize, but it's driven
   * by its own internal `ResizeObserver` on the same element — independent of, and not ordered
   * relative to, the caller's own observer that triggers this method, so `app.screen` can still be
   * one tick stale here. `app.resize()` forces Pixi to resync `app.screen` to the canvas element's
   * actual current size synchronously before anything reads it. */
  notifyScreenResized(): void {
    this.app.resize();
    this.syncLayersToViewport();
    this.exportFrameOverlay.notifyExternalResize();
  }

  /** Directly sets the editor viewport's transform (used by `ExportFrameOverlay` to push
   * print-settings-panel edits — scale/offset/anchor — back onto the canvas, the inverse
   * direction of its own pan/zoom-to-settings sync). */
  setViewportTransform(x: number, y: number, scale: number): void {
    this.viewport.x = x;
    this.viewport.y = y;
    this.viewport.scale.set(scale);
    this.syncLayersToViewport();
  }

  refit(): void {
    this.app.resize();
    const { nodes, previewTessellationConfig, openCard, floors, floorFields, activeFloorId } = useMazeStore.getState();
    const showsMaze = (openCard === "generation" || openCard === "post_edit" || openCard === "analytics" || openCard === "image_export") && nodes.length > 0;
    const activeFloorIndex = Math.max(floors.findIndex((f) => f.id === activeFloorId), 0);
    const { x, y, scale } = showsMaze
      ? fitMazeViewport(
        floors.map((f) => floorFields[f.id].tessellationConfig),
        nodes,
        activeFloorIndex,
        this.app.screen.width,
        this.app.screen.height,
      )
      : fitFieldViewport(
        openCard === "basic_config" ? previewTessellationConfig : floorFields[activeFloorId].tessellationConfig,
        openCard === "basic_config" ? [previewTessellationConfig] : floors.map((f) => floorFields[f.id].tessellationConfig),
        this.app.screen.width,
        this.app.screen.height,
      );
    this.viewport.scale.set(scale);
    this.viewport.x = x;
    this.viewport.y = y;
    this.syncLayersToViewport();
  }

  destroy(): void {
    this.hoverCallback?.(null);
    this.unsubscribeEditField?.();
    this.unsubscribePreview?.();
    this.unsubscribeQualityOpen?.();
    this.unsubscribeQualityRules?.();
    if (this.qualityRulesConfirmTimer !== null) clearTimeout(this.qualityRulesConfirmTimer);
    this.generationRenderer.destroy();
    this.tessellationRenderer.destroy();
    this.analyticsRenderer.destroy();
    this.imageExportRenderer.destroy();
    this.exportFrameOverlay.destroy();
    this.fieldEditorOverlay.destroy();
    this.primitivePreviewOverlay.destroy();
    this.presetConnectionsRenderer.destroy();
    this.presetConnectionsController.destroy();
    this.postEditRenderer.destroy();
    this.postEditController.destroy();
    this.fieldEditController.destroy();
    this.interaction.destroy();
    this.app.destroy();
  }
}
