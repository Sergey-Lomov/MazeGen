import { Application, Container } from "pixi.js";
import { MazeTileRenderer } from "./MazeTileRenderer";
import { TILE_SIZE } from "./constants";
import { cellCenter, mazeBounds } from "./hexGeometry";
import { MazeGraphRenderer, NavGraphRenderer } from "./MazeRenderer";
import { ComponentRenderer } from "./ComponentRenderer";
import { RouteOverlay } from "./RouteOverlay";
import { useMazeStore } from "../store/mazeStore";
import type { TessellationConfig } from "../wasm/types";

const FIT_PADDING = 0.9;

export class MazeScene {
  private app: Application;
  private viewport: Container;
  private componentOverlay: Container;
  private graphOverlay: Container;
  private navOverlay: Container;
  private tileRenderer: MazeTileRenderer;
  private componentRenderer: ComponentRenderer;
  private graphRenderer: MazeGraphRenderer;
  private navRenderer: NavGraphRenderer;
  private routeOverlay: RouteOverlay;
  private routeOverlayContainer: Container;

  // All containers that must stay in sync with viewport position/scale.
  private syncedLayers: Container[] = [];

  private isDragging = false;
  private dragStart = { x: 0, y: 0 };
  private viewportStart = { x: 0, y: 0 };

  private onBlur = () => { this.isDragging = false; };
  private onWheel: (e: WheelEvent) => void = () => {};
  private unsubscribeFit: (() => void) | null = null;
  private unsubscribeOverlay: (() => void) | null = null;
  private unsubscribeNavOverlay: (() => void) | null = null;
  private unsubscribeComponentOverlay: (() => void) | null = null;
  private unsubscribeMaze: (() => void) | null = null;
  private refitTimerId: ReturnType<typeof setTimeout> | null = null;

  constructor(app: Application) {
    this.app = app;

    this.viewport = new Container();

    // componentOverlay sits above viewport tiles but below graph overlays.
    // Uses same coordinate system as viewport: tile top-left at (x*TILE_SIZE, -y*TILE_SIZE - TILE_SIZE).
    this.componentOverlay = new Container();
    this.componentOverlay.visible = useMazeStore.getState().showComponents;

    this.graphOverlay = new Container();
    this.graphOverlay.visible = useMazeStore.getState().showGraphOverlay;
    const graphInner = new Container();
    this.graphOverlay.addChild(graphInner);

    this.navOverlay = new Container();
    this.navOverlay.visible = useMazeStore.getState().showNavOverlay;
    const navInner = new Container();
    this.navOverlay.addChild(navInner);

    this.routeOverlayContainer = new Container();
    this.syncedLayers = [this.componentOverlay, this.graphOverlay, this.navOverlay, this.routeOverlayContainer];

    this.app.stage.addChild(this.viewport);
    for (const layer of this.syncedLayers) this.app.stage.addChild(layer);

    const cx = app.screen.width / 2;
    const cy = app.screen.height / 2;
    this.viewport.x = cx;
    this.viewport.y = cy;
    for (const layer of this.syncedLayers) { layer.x = cx; layer.y = cy; }

    this.viewport.visible = useMazeStore.getState().showMaze;

    this.tileRenderer = new MazeTileRenderer(this.viewport);
    this.componentRenderer = new ComponentRenderer(this.componentOverlay);
    this.graphRenderer = new MazeGraphRenderer(graphInner);
    this.navRenderer = new NavGraphRenderer(navInner);
    this.routeOverlay = new RouteOverlay(this.routeOverlayContainer);

    this.setupInteraction();
    this.subscribeToFit();
    this.subscribeToOverlay();
    this.subscribeToNavOverlay();
    this.subscribeToComponentOverlay();
    this.subscribeToMaze();
  }

  private subscribeToOverlay(): void {
    let prev = useMazeStore.getState().showGraphOverlay;
    this.unsubscribeOverlay = useMazeStore.subscribe((state) => {
      if (state.showGraphOverlay !== prev) {
        prev = state.showGraphOverlay;
        this.graphOverlay.visible = state.showGraphOverlay;
      }
    });
  }

  private subscribeToNavOverlay(): void {
    let prev = useMazeStore.getState().showNavOverlay;
    this.unsubscribeNavOverlay = useMazeStore.subscribe((state) => {
      if (state.showNavOverlay !== prev) {
        prev = state.showNavOverlay;
        this.navOverlay.visible = state.showNavOverlay;
      }
    });
  }

  private subscribeToComponentOverlay(): void {
    let prev = useMazeStore.getState().showComponents;
    this.unsubscribeComponentOverlay = useMazeStore.subscribe((state) => {
      if (state.showComponents !== prev) {
        prev = state.showComponents;
        this.componentOverlay.visible = state.showComponents;
      }
    });
  }

  private subscribeToMaze(): void {
    let prev = useMazeStore.getState().showMaze;
    this.unsubscribeMaze = useMazeStore.subscribe((state) => {
      if (state.showMaze !== prev) {
        prev = state.showMaze;
        this.viewport.visible = state.showMaze;
      }
    });
  }

  private subscribeToFit(): void {
    let prevNodes = useMazeStore.getState().nodes;
    this.unsubscribeFit = useMazeStore.subscribe((state) => {
      if (state.nodes !== prevNodes) {
        prevNodes = state.nodes;
        if (state.nodes.length > 0) {
          this.app.resize();
          this.fitMaze(state.activeTessellationConfig, state.nodes);
        }
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

  refit(durationMs = 0): void {
    const { nodes, activeTessellationConfig } = useMazeStore.getState();
    if (nodes.length === 0) return;
    if (durationMs <= 0) {
      this.app.resize();
      this.fitMaze(activeTessellationConfig, nodes);
      return;
    }
    if (this.refitTimerId !== null) {
      clearTimeout(this.refitTimerId);
      this.refitTimerId = null;
    }
    const step = 16;
    const steps = Math.ceil(durationMs / step);
    let i = 0;
    const tick = () => {
      this.app.resize();
      this.fitMaze(activeTessellationConfig, nodes);
      if (++i < steps) {
        this.refitTimerId = setTimeout(tick, step);
      } else {
        this.refitTimerId = null;
      }
    };
    tick();
  }

  private setupInteraction(): void {
    const stage = this.app.stage;
    stage.interactive = true;
    stage.hitArea = this.app.screen;

    stage.on("pointerdown", (e) => {
      this.isDragging = true;
      this.dragStart = { x: e.globalX, y: e.globalY };
      this.viewportStart = { x: this.viewport.x, y: this.viewport.y };
    });

    stage.on("pointermove", (e) => {
      if (!this.isDragging) return;
      const dx = e.globalX - this.dragStart.x;
      const dy = e.globalY - this.dragStart.y;
      this.viewport.x = this.viewportStart.x + dx;
      this.viewport.y = this.viewportStart.y + dy;
      this.syncLayersToViewport();
    });

    stage.on("pointerup", () => { this.isDragging = false; });
    stage.on("pointerupoutside", () => { this.isDragging = false; });

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
    if (this.refitTimerId !== null) {
      clearTimeout(this.refitTimerId);
      this.refitTimerId = null;
    }
    this.unsubscribeFit?.();
    this.unsubscribeOverlay?.();
    this.unsubscribeNavOverlay?.();
    this.unsubscribeComponentOverlay?.();
    this.unsubscribeMaze?.();
    this.tileRenderer.destroy();
    this.componentRenderer.destroy();
    this.graphRenderer.destroy();
    this.navRenderer.destroy();
    this.routeOverlay.destroy();
    window.removeEventListener("blur", this.onBlur);
    this.app.canvas.removeEventListener("wheel", this.onWheel);
    this.app.destroy();
  }
}
