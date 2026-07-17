import { Application, Container } from "pixi.js";
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
import { fitFieldViewport } from "./FieldEditorOverlay";
import { fitMazeViewport } from "./viewportFit";
import { makeProjection } from "./tessellationProjection";
import type { TessellationProjection } from "./tessellationProjection";
import { useMazeStore } from "../store/mazeStore";
import type { ViewportListener, PointerHandler } from "./sceneTypes";
import { SceneInteraction } from "./SceneInteraction";
import type { HoverInfo, HoverProvider } from "./hoverTypes";
import { DefaultHoverProvider } from "./hoverProviders";
import type { FeatureId } from "../store/storeTypes";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";

type ConfigResolver = (st: ReturnType<typeof useMazeStore.getState>) => TessellationConfig;

export const TESSELLATION_CONFIG_BY_CARD: Record<FeatureId, ConfigResolver> = {
  basic_config: (st) => st.previewTessellationConfig,
  field_setup: (st) => st.tessellationConfig,
  preset_connections: (st) => st.tessellationConfig,
  quality: (st) => st.tessellationConfig,
  generation: (st) => st.activeTessellationConfig,
  post_edit: (st) => st.activeTessellationConfig,
  analytics: (st) => st.activeTessellationConfig,
};

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
  private interaction: SceneInteraction;
  private hoverProvider: DefaultHoverProvider;
  private hoverCallback: ((info: HoverInfo | null) => void) | null = null;
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

    this.syncedLayers = [
      this.fieldEditorOverlayContainer,
      this.primitivePreviewContainer,
      this.presetConnectionsContainer,
      this.postEditContainer,
      this.tessellationContainer,
      this.analyticsContainer,
    ];

    this.app.stage.addChild(this.viewport);
    for (const layer of this.syncedLayers) this.app.stage.addChild(layer);

    const cx = app.screen.width / 2;
    const cy = app.screen.height / 2;
    this.viewport.x = cx;
    this.viewport.y = cy;
    for (const layer of this.syncedLayers) { layer.x = cx; layer.y = cy; }

    this.generationRenderer = new GenerationRenderer(this.viewport);
    this.tessellationRenderer = new TessellationRenderer(this.tessellationContainer);
    this.analyticsRenderer = new AnalyticsRenderer(this.analyticsContainer);

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
    });

    this.fieldEditController = new FieldEditController(
      app.canvas,
      () => {
        const cfg = useMazeStore.getState().tessellationConfig;
        return makeProjection(cfg);
      },
      () => this.viewport,
      {
        startPan: (x, y) => this.interaction.defaultPan.begin(x, y),
        movePan: (x, y) => this.interaction.defaultPan.move(x, y),
        endPan: () => this.interaction.defaultPan.end(),
      },
      {
        onPreviewUpdate: (cells, btn, kind, cfg) => {
          this.primitivePreviewOverlay.update(cells, btn, kind, cfg);
        },
        onPreviewClear: () => {
          this.primitivePreviewOverlay.clear();
        },
        onPrimitiveCommit: (cells, btn) => {
          const store = useMazeStore.getState();
          if (btn === 0) store.addFieldPoints(cells);
          else if (btn === 2) store.removeFieldPoints(cells);
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
    if (st.openCard === "field_setup" && st.fieldEditMode === "custom") return this.fieldEditController;
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
    let prevCard = useMazeStore.getState().openCard;
    let prevMode = useMazeStore.getState().fieldEditMode;
    this.unsubscribeEditField = useMazeStore.subscribe((state) => {
      const isFieldSetup = state.openCard === "field_setup";
      const openChanged = state.openCard !== prevCard;
      const modeChanged = state.fieldEditMode !== prevMode;
      prevCard = state.openCard;
      prevMode = state.fieldEditMode;
      if (!isFieldSetup) {
        if (openChanged) this.primitivePreviewOverlay.clear();
        return;
      }
      if (openChanged) return;
      if (modeChanged && state.fieldEditMode === "default") {
        this.primitivePreviewOverlay.clear();
        this.fieldEditorOverlay.updateHover(null, state.tessellationConfig);
      }
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
  }

  refit(): void {
    this.app.resize();
    const { nodes, activeTessellationConfig, tessellationConfig, previewTessellationConfig, openCard } = useMazeStore.getState();
    const showsMaze = (openCard === "generation" || openCard === "post_edit" || openCard === "analytics") && nodes.length > 0;
    const fieldCfg = openCard === "basic_config" ? previewTessellationConfig : tessellationConfig;
    const { x, y, scale } = showsMaze
      ? fitMazeViewport(activeTessellationConfig, nodes, this.app.screen.width, this.app.screen.height)
      : fitFieldViewport(fieldCfg, this.app.screen.width, this.app.screen.height);
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
