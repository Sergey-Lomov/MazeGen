import { Application, Container } from "pixi.js";
import { GenerationRenderer } from "./GenerationRenderer";
import { TessellationRenderer } from "./TessellationRenderer";
import { AnalyticsRenderer } from "./AnalyticsRenderer";
import { TILE_SIZE } from "./constants";
import { cellCenter, mazeBounds } from "./hexGeometry";
import { FieldEditorOverlay } from "./FieldEditorOverlay";
import { FieldEditController } from "./FieldEditController";
import { PrimitivePreviewOverlay } from "./PrimitivePreviewOverlay";
import { PresetConnectionsRenderer } from "./PresetConnectionsRenderer";
import { PresetConnectionsController } from "./PresetConnectionsController";
import { fitFieldViewport } from "./FieldEditorOverlay";
import { makeProjection } from "./tessellationProjection";
import { useMazeStore } from "../store/mazeStore";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";

const FIT_PADDING = 0.9;

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
  private analyticsRenderer: AnalyticsRenderer;
  private analyticsContainer: Container;

  // All containers that must stay in sync with viewport position/scale.
  private syncedLayers: Container[] = [];

  private isDragging = false;
  private dragStart = { x: 0, y: 0 };
  private viewportStart = { x: 0, y: 0 };

  private onBlur = () => { this.isDragging = false; };
  private onWheel: (e: WheelEvent) => void = () => {};
  private unsubscribeFit: (() => void) | null = null;
  private unsubscribeEditField: (() => void) | null = null;
  private unsubscribePreview: (() => void) | null = null;
  private unsubscribePresetOpen: (() => void) | null = null;
  private unsubscribeQualityOpen: (() => void) | null = null;


  constructor(app: Application) {
    this.app = app;

    this.viewport = new Container();

    this.fieldEditorOverlayContainer = new Container();
    this.primitivePreviewContainer = new Container();
    this.presetConnectionsContainer = new Container();
    this.tessellationContainer = new Container();
    this.analyticsContainer = new Container();

    this.syncedLayers = [
      this.fieldEditorOverlayContainer,
      this.primitivePreviewContainer,
      this.presetConnectionsContainer,
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

    const self = this;
    this.presetConnectionsController = new PresetConnectionsController(
      () => self.viewport,
      this.presetConnectionsRenderer,
      (x, y) => {
        self.viewport.x = x;
        self.viewport.y = y;
        self.syncLayersToViewport();
      },
    );
    this.fieldEditController = new FieldEditController(
      app.canvas,
      () => {
        const cfg = useMazeStore.getState().tessellationConfig;
        return makeProjection(cfg);
      },
      () => self.viewport,
      {
        startPan: (x, y) => {
          self.isDragging = true;
          self.dragStart = { x, y };
          self.viewportStart = { x: self.viewport.x, y: self.viewport.y };
        },
        movePan: (x, y) => {
          if (!self.isDragging) return;
          const dx = x - self.dragStart.x;
          const dy = y - self.dragStart.y;
          self.viewport.x = self.viewportStart.x + dx;
          self.viewport.y = self.viewportStart.y + dy;
          self.syncLayersToViewport();
        },
        endPan: () => { self.isDragging = false; },
      },
      {
        onPreviewUpdate: (cells, btn, kind, cfg) => {
          self.primitivePreviewOverlay.update(cells, btn, kind, cfg);
        },
        onPreviewClear: () => {
          self.primitivePreviewOverlay.clear();
        },
        onPrimitiveCommit: (cells, btn) => {
          const store = useMazeStore.getState();
          if (btn === 0) store.addFieldPoints(cells);
          else if (btn === 2) store.removeFieldPoints(cells);
        },
      },
    );

    this.setupInteraction();
    this.subscribeToFit();
    this.subscribeToEditField();
    this.subscribeToPreview();
    this.subscribeToPresetOpen();
    this.subscribeToQualityOpen();
    this.syncLayersToViewport();
  }

  private subscribeToPreview(): void {
    let prevPreview = useMazeStore.getState().previewTessellationConfig;
    let prevOpen = useMazeStore.getState().fieldSetupOpen;
    this.unsubscribePreview = useMazeStore.subscribe((state) => {
      const previewChanged = state.previewTessellationConfig !== prevPreview;
      const openChanged = state.fieldSetupOpen !== prevOpen;
      prevPreview = state.previewTessellationConfig;
      prevOpen = state.fieldSetupOpen;
      if (previewChanged || openChanged) {
        this.syncLayersToViewport();
      }
    });
  }

  private subscribeToQualityOpen(): void {
    let prev = useMazeStore.getState().qualityOpen;
    this.unsubscribeQualityOpen = useMazeStore.subscribe((state) => {
      if (state.qualityOpen !== prev) {
        prev = state.qualityOpen;
        if (state.qualityOpen) this.app.ticker.stop();
        else this.app.ticker.start();
      }
    });
  }

  private subscribeToPresetOpen(): void {
    this.unsubscribePresetOpen = useMazeStore.subscribe(() => {});
  }

  private subscribeToEditField(): void {
    let prevOpen = useMazeStore.getState().fieldSetupOpen;
    let prevMode = useMazeStore.getState().fieldEditMode;
    this.unsubscribeEditField = useMazeStore.subscribe((state) => {
      const openChanged = state.fieldSetupOpen !== prevOpen;
      const modeChanged = state.fieldEditMode !== prevMode;
      prevOpen = state.fieldSetupOpen;
      prevMode = state.fieldEditMode;
      if (!state.fieldSetupOpen) {
        if (openChanged) this.primitivePreviewOverlay.clear();
        return;
      }
      if (openChanged) return;
      if (modeChanged && state.fieldEditMode === "default") this.primitivePreviewOverlay.clear();
    });
  }

  private subscribeToFit(): void {
    this.unsubscribeFit = useMazeStore.subscribe(() => {});
  }

  private syncLayersToViewport(): void {
    for (const layer of this.syncedLayers) {
      layer.x = this.viewport.x;
      layer.y = this.viewport.y;
      layer.scale.x = this.viewport.scale.x;
      layer.scale.y = this.viewport.scale.y;
    }
    this.generationRenderer.onViewportChanged(
      this.viewport.x,
      this.viewport.y,
      this.app.screen.width,
      this.app.screen.height,
      this.viewport.scale.x,
    );
    this.fieldEditorOverlay.onViewportChanged(
      this.viewport.x,
      this.viewport.y,
      this.app.screen.width,
      this.app.screen.height,
      this.viewport.scale.x,
    );
    this.primitivePreviewOverlay.onViewportChanged(
      this.viewport.x,
      this.viewport.y,
      this.app.screen.width,
      this.app.screen.height,
      this.viewport.scale.x,
    );
    this.presetConnectionsRenderer.onViewportChanged(
      this.viewport.x,
      this.viewport.y,
      this.app.screen.width,
      this.app.screen.height,
      this.viewport.scale.x,
    );
    this.tessellationRenderer.onViewportChanged(
      this.viewport.x,
      this.viewport.y,
      this.app.screen.width,
      this.app.screen.height,
      this.viewport.scale.x,
    );
    this.analyticsRenderer.onViewportChanged(
      this.viewport.x,
      this.viewport.y,
      this.app.screen.width,
      this.app.screen.height,
      this.viewport.scale.x,
    );
  }

  private fitMaze(cfg: TessellationConfig, nodes: { x: number; y: number; id: number }[]): void {
    const centers = nodes.map(n => cellCenter(n, cfg));
    const halfTile = TILE_SIZE;
    const { minX, minY, maxX, maxY } = mazeBounds(centers, halfTile);
    const W = maxX - minX;
    const H = maxY - minY;
    const screenW = this.app.screen.width;
    const screenH = this.app.screen.height;
    const scale = Math.min(FIT_PADDING * screenW / W, FIT_PADDING * screenH / H);

    this.viewport.scale.set(scale);
    this.viewport.x = screenW / 2 - scale * (minX + W / 2);
    this.viewport.y = screenH / 2 - scale * (minY + H / 2);

    this.syncLayersToViewport();
  }


  refit(): void {
    this.app.resize();
    const { nodes, activeTessellationConfig, tessellationConfig } = useMazeStore.getState();
    if (nodes.length > 0) {
      this.fitMaze(activeTessellationConfig, nodes);
    } else {
      const { x, y, scale } = fitFieldViewport(tessellationConfig, this.app.screen.width, this.app.screen.height);
      this.viewport.scale.set(scale);
      this.viewport.x = x;
      this.viewport.y = y;
      this.syncLayersToViewport();
    }
  }

  private setupInteraction(): void {
    const stage = this.app.stage;
    stage.interactive = true;
    stage.hitArea = this.app.screen;

    stage.on("pointerdown", (e) => {
      const st = useMazeStore.getState();
      if (st.fieldSetupOpen && st.fieldEditMode === "custom") {
        this.fieldEditController.onPointerDown(e.globalX, e.globalY, e.button);
        return;
      }
      if (st.presetConnectionsOpen) {
        this.presetConnectionsController.onPointerDown(e.globalX, e.globalY, e.button);
        return;
      }
      this.isDragging = true;
      this.dragStart = { x: e.globalX, y: e.globalY };
      this.viewportStart = { x: this.viewport.x, y: this.viewport.y };
    });

    stage.on("pointermove", (e) => {
      const st = useMazeStore.getState();
      if (st.fieldSetupOpen && st.fieldEditMode === "custom") {
        this.fieldEditController.onPointerMove(e.globalX, e.globalY, e.buttons);
        const hoverCell = this.fieldEditController.getHoverCell(e.globalX, e.globalY);
        this.fieldEditorOverlay.updateHover(hoverCell, st.tessellationConfig);
        return;
      }
      if (st.fieldSetupOpen && st.fieldEditMode === "custom") {
        const hoverCell = this.fieldEditController.getHoverCell(e.globalX, e.globalY);
        this.fieldEditorOverlay.updateHover(hoverCell, st.tessellationConfig);
      }
      if (st.presetConnectionsOpen) {
        this.presetConnectionsController.onPointerMove(e.globalX, e.globalY);
        return;
      }
      if (!this.isDragging) return;
      const dx = e.globalX - this.dragStart.x;
      const dy = e.globalY - this.dragStart.y;
      this.viewport.x = this.viewportStart.x + dx;
      this.viewport.y = this.viewportStart.y + dy;
      this.syncLayersToViewport();
    });

    stage.on("pointerup", (e) => {
      const st = useMazeStore.getState();
      if (st.fieldSetupOpen && st.fieldEditMode === "custom") {
        this.fieldEditController.onPointerUp();
        return;
      }
      if (st.presetConnectionsOpen) {
        this.presetConnectionsController.onPointerUp(e.button);
        return;
      }
      this.isDragging = false;
    });
    stage.on("pointerupoutside", () => {
      const st = useMazeStore.getState();
      if (st.fieldSetupOpen && st.fieldEditMode === "custom") {
        this.fieldEditController.onPointerUp();
      }
      if (st.fieldSetupOpen) {
        this.fieldEditorOverlay.updateHover(null, st.tessellationConfig);
      }
      this.isDragging = false;
    });

    window.addEventListener("blur", this.onBlur);

    this.onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const rect = this.app.canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      this.viewport.x = mouseX + (this.viewport.x - mouseX) * factor;
      this.viewport.y = mouseY + (this.viewport.y - mouseY) * factor;
      this.viewport.scale.x *= factor;
      this.viewport.scale.y *= factor;
      this.syncLayersToViewport();
    };
    this.app.canvas.addEventListener("wheel", this.onWheel, { passive: false });
  }

  destroy(): void {
    this.unsubscribeFit?.();
    this.unsubscribeEditField?.();
    this.unsubscribePreview?.();
    this.unsubscribePresetOpen?.();
    this.unsubscribeQualityOpen?.();
    this.generationRenderer.destroy();
    this.tessellationRenderer.destroy();
    this.analyticsRenderer.destroy();
    this.fieldEditorOverlay.destroy();
    this.primitivePreviewOverlay.destroy();
    this.presetConnectionsRenderer.destroy();
    this.fieldEditController.destroy();
    window.removeEventListener("blur", this.onBlur);
    this.app.canvas.removeEventListener("wheel", this.onWheel);
    this.app.destroy();
  }
}
