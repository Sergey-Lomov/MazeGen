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
import { useMazeStore } from "../store/mazeStore";
import type { ViewportListener, PointerHandler } from "./sceneTypes";
import { SceneInteraction } from "./SceneInteraction";

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

  // All containers that must stay in sync with viewport position/scale.
  private syncedLayers: Container[] = [];
  // All renderers/overlays that must be notified when the viewport changes.
  private viewportListeners: ViewportListener[] = [];

  private unsubscribeEditField: (() => void) | null = null;
  private unsubscribePreview: (() => void) | null = null;
  private unsubscribeQualityOpen: (() => void) | null = null;

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

    this.interaction = new SceneInteraction({
      app: this.app,
      viewport: this.viewport,
      getFieldEditController: () => this.fieldEditController,
      fieldEditorOverlay: this.fieldEditorOverlay,
      getController: (st) => this.getController(st),
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
    this.syncLayersToViewport();
  }

  /** Resolves the controller that owns pointer interaction for the current card, or null for default pan. */
  private getController(st: ReturnType<typeof useMazeStore.getState>): PointerHandler | null {
    if (st.openCard === "field_setup" && st.fieldEditMode === "custom") return this.fieldEditController;
    if (st.openCard === "preset_connections") return this.presetConnectionsController;
    if (st.openCard === "post_edit") return this.postEditController;
    return null;
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
    this.unsubscribeEditField?.();
    this.unsubscribePreview?.();
    this.unsubscribeQualityOpen?.();
    this.generationRenderer.destroy();
    this.tessellationRenderer.destroy();
    this.analyticsRenderer.destroy();
    this.fieldEditorOverlay.destroy();
    this.primitivePreviewOverlay.destroy();
    this.presetConnectionsRenderer.destroy();
    this.postEditRenderer.destroy();
    this.postEditController.destroy();
    this.fieldEditController.destroy();
    this.interaction.destroy();
    this.app.destroy();
  }
}
