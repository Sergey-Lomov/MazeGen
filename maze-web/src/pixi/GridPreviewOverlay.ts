import { Container, Graphics } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import { makeProjection } from "./tessellationProjection";
import type { TessellationProjection } from "./tessellationProjection";
import { TILE_SIZE } from "./constants";
import { hexCenter, hexVertices } from "./hexGeometry";
import { triVertices } from "./triGeometry";
import type { TessellationConfig } from "../wasm/types";

const GRID_LINE_COLOR = 0x383838;
const GRID_LINE_ALPHA = 1.0;

export class GridPreviewOverlay {
  private readonly root: Container;
  private readonly gridLayer: Graphics;

  private cfg: TessellationConfig;
  private projection: TessellationProjection;

  private vpX = 0;
  private vpY = 0;
  private vpW = 0;
  private vpH = 0;
  private vpScale = 1;

  private unsubscribe: (() => void) | null = null;

  constructor(container: Container) {
    this.root = container;
    this.gridLayer = new Graphics();
    this.root.addChild(this.gridLayer);

    const initialCfg = useMazeStore.getState().previewTessellationConfig;
    this.cfg = initialCfg;
    this.projection = makeProjection(initialCfg);

    const initialState = useMazeStore.getState();
    this.root.visible = initialState.nodes.length === 0 && !initialState.isEditingField;

    this.unsubscribe = useMazeStore.subscribe((state, prev) => {
      const wasVisible = prev.nodes.length === 0 && !prev.isEditingField;
      const shouldBeVisible = state.nodes.length === 0 && !state.isEditingField;

      if (shouldBeVisible !== wasVisible) {
        this.root.visible = shouldBeVisible;
      }

      if (shouldBeVisible && state.previewTessellationConfig !== prev.previewTessellationConfig) {
        this.cfg = state.previewTessellationConfig;
        this.projection = makeProjection(state.previewTessellationConfig);
        this.redrawGrid();
      }
    });
  }

  onViewportChanged(x: number, y: number, w: number, h: number, scale: number): void {
    this.vpX = x;
    this.vpY = y;
    this.vpW = w;
    this.vpH = h;
    this.vpScale = scale;
    if (this.root.visible) {
      this.redrawGrid();
    }
  }

  private redrawGrid(): void {
    const g = this.gridLayer;
    g.clear();

    const bounds = this.projection.gridBounds(this.vpX, this.vpY, this.vpW, this.vpH, this.vpScale);
    const cfg = this.cfg;

    g.setStrokeStyle({ width: 1 / this.vpScale, color: GRID_LINE_COLOR, alpha: GRID_LINE_ALPHA });

    for (let xi = bounds.minX; xi <= bounds.maxX; xi++) {
      for (let yi = bounds.minY; yi <= bounds.maxY; yi++) {
        const verts = this.getCellVertices(xi, yi, cfg);
        if (!verts) continue;
        g.moveTo(verts[verts.length - 1].x, verts[verts.length - 1].y);
        for (const v of verts) g.lineTo(v.x, v.y);
        g.stroke();
      }
    }
  }

  private getCellVertices(x: number, y: number, cfg: TessellationConfig) {
    switch (cfg.type) {
      case "square":
      case "square_custom": {
        const h = TILE_SIZE / 2;
        const cx = x * TILE_SIZE + TILE_SIZE / 2;
        const cy = -y * TILE_SIZE - TILE_SIZE / 2;
        return [
          { x: cx - h, y: cy - h },
          { x: cx + h, y: cy - h },
          { x: cx + h, y: cy + h },
          { x: cx - h, y: cy + h },
        ];
      }
      case "hex_parallelogram":
      case "hex_hexagon":
      case "hex_custom": {
        const orientation = (cfg as { orientation?: "flat_top" | "pointy_top" }).orientation ?? "flat_top";
        const center = hexCenter(x, y, orientation);
        return hexVertices(center.x, center.y, orientation);
      }
      case "triangle_rect":
      case "triangle_triangle":
      case "triangle_hexagon":
      case "tri_custom": {
        const orientation = (cfg as { orientation?: "r0" | "r90" | "r180" | "r270" }).orientation ?? "r0";
        return triVertices(x, y, orientation);
      }
      default:
        return null;
    }
  }

  destroy(): void {
    this.unsubscribe?.();
    this.gridLayer.destroy();
  }
}
