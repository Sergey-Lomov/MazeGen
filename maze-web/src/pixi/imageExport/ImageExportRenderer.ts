import { Container } from "pixi.js";
import { useMazeStore } from "../../store/mazeStore";
import { VectorByWallsRenderer } from "./VectorByWallsRenderer";
import type { RenderModeId } from "../../store/storeTypes";
import type { ViewportListener } from "../sceneTypes";

interface ModeRenderer extends ViewportListener {
  destroy(): void;
}

/** Owns the Image Export feature's rendering modes (GitHub issue #287). Exactly one mode
 * renderer is active at a time, matching `activeRenderMode` — each mode gets its own container
 * and its own renderer instance (never shared across modes, following the same feature-renderer
 * ownership rule this ownership boundary itself exists to enforce, just one level down: one
 * renderer per mode instead of one renderer per feature). Adding a new mode means adding one
 * entry to `createModeRenderer` and one `RenderModeId` variant — no other change here. */
export class ImageExportRenderer implements ViewportListener {
  private readonly container: Container;
  private readonly modeContainers = new Map<RenderModeId, Container>();
  private readonly modeRenderers = new Map<RenderModeId, ModeRenderer>();
  private unsubscribe: (() => void) | null = null;
  private lastViewport = { x: 0, y: 0, w: 0, h: 0, scale: 1 };

  constructor(container: Container) {
    this.container = container;
    const initialMode = useMazeStore.getState().activeRenderMode;
    if (initialMode) this.ensureMode(initialMode);
    this.syncVisibility(initialMode);
    this.subscribe();
  }

  private createModeRenderer(mode: RenderModeId, container: Container): ModeRenderer {
    switch (mode) {
      case "vector_by_walls":
        return new VectorByWallsRenderer(container);
    }
  }

  private ensureMode(mode: RenderModeId): void {
    if (this.modeRenderers.has(mode)) return;
    const modeContainer = new Container();
    this.container.addChild(modeContainer);
    this.modeContainers.set(mode, modeContainer);
    this.modeRenderers.set(mode, this.createModeRenderer(mode, modeContainer));
  }

  private syncVisibility(activeMode: RenderModeId | null): void {
    for (const [mode, modeContainer] of this.modeContainers) {
      modeContainer.visible = mode === activeMode;
    }
  }

  private subscribe(): void {
    let prevMode = useMazeStore.getState().activeRenderMode;
    this.unsubscribe = useMazeStore.subscribe((state) => {
      if (state.activeRenderMode !== prevMode) {
        prevMode = state.activeRenderMode;
        if (prevMode) this.ensureMode(prevMode);
        this.syncVisibility(prevMode);
        if (prevMode) {
          this.modeRenderers.get(prevMode)?.onViewportChanged(
            this.lastViewport.x, this.lastViewport.y, this.lastViewport.w, this.lastViewport.h, this.lastViewport.scale,
          );
        }
      }
    });
  }

  onViewportChanged(x: number, y: number, w: number, h: number, scale: number): void {
    this.lastViewport = { x, y, w, h, scale };
    const activeMode = useMazeStore.getState().activeRenderMode;
    if (activeMode) this.modeRenderers.get(activeMode)?.onViewportChanged(x, y, w, h, scale);
  }

  destroy(): void {
    this.unsubscribe?.();
    for (const renderer of this.modeRenderers.values()) renderer.destroy();
    for (const modeContainer of this.modeContainers.values()) modeContainer.destroy();
  }
}
