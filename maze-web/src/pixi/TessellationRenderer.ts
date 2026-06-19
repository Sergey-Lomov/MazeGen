import { Container } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import { GridRenderer } from "./renderers/GridRenderer";
import type { Viewport } from "./renderers/types";

export class TessellationRenderer {
  private readonly root: Container;
  private readonly gridContainer: Container;
  private readonly grid: GridRenderer;

  private viewport: Viewport = { x: 0, y: 0, w: 0, h: 0, scale: 1 };
  private unsubscribe: (() => void) | null = null;

  constructor(container: Container) {
    this.root = container;
    this.gridContainer = new Container();
    this.root.addChild(this.gridContainer);
    this.grid = new GridRenderer(this.gridContainer);

    this.root.visible = false;

    this.unsubscribe = useMazeStore.subscribe((state, prev) => {
      const openChanged = state.openCard !== prev.openCard;
      const shouldShow = state.openCard === "basic_config";
      if (openChanged) {
        this.root.visible = shouldShow;
        if (shouldShow) this.redraw(state.previewTessellationConfig);
      }

      if (shouldShow && state.previewTessellationConfig !== prev.previewTessellationConfig) {
        this.redraw(state.previewTessellationConfig);
      }
    });

    const s = useMazeStore.getState();
    const shouldShow = s.openCard === "basic_config";
    this.root.visible = shouldShow;
    // Viewport not yet set; onViewportChanged will trigger first real draw.
  }

  onViewportChanged(x: number, y: number, w: number, h: number, scale: number): void {
    this.viewport = { x, y, w, h, scale };
    if (this.root.visible) {
      const cfg = useMazeStore.getState().previewTessellationConfig;
      this.redraw(cfg);
    }
  }

  private redraw(cfg: Parameters<GridRenderer["render"]>[1]): void {
    this.grid.render({ viewport: this.viewport }, cfg);
  }

  destroy(): void {
    this.unsubscribe?.();
    this.grid.destroy();
    this.gridContainer.destroy();
  }
}
