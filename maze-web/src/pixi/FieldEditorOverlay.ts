import { Container, Graphics } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import { decodePoint } from "../store/mazeStore";
import { makeProjection } from "./tessellationProjection";
import type { TessellationProjection } from "./tessellationProjection";
import { TILE_SIZE } from "./constants";
import { hexCenter, hexVertices } from "./hexGeometry";
import { triVertices } from "./triGeometry";
import type { TessellationConfig } from "../wasm/types";

const GRID_LINE_COLOR = 0x444444;
const GRID_LINE_ALPHA = 0.8;
const ACTIVE_CELL_COLOR = 0x666666;
const ACTIVE_CELL_ALPHA = 0.7;
const ORIGIN_COLOR = 0xFF6600;
const ORIGIN_ALPHA = 0.9;

export class FieldEditorOverlay {
  private readonly root: Container;
  private readonly gridLayer: Graphics;
  private readonly activeLayer: Graphics;
  private readonly originLayer: Graphics;

  private cfg: TessellationConfig | null = null;
  private projection: TessellationProjection | null = null;

  private vpX = 0;
  private vpY = 0;
  private vpW = 0;
  private vpH = 0;
  private vpScale = 1;

  private unsubscribe: (() => void) | null = null;

  constructor(container: Container) {
    this.root = container;
    this.gridLayer = new Graphics();
    this.activeLayer = new Graphics();
    this.originLayer = new Graphics();
    this.root.addChild(this.gridLayer);
    this.root.addChild(this.activeLayer);
    this.root.addChild(this.originLayer);

    this.root.visible = false;

    this.unsubscribe = useMazeStore.subscribe((state, prev) => {
      const shouldShow = state.isEditingField && state.showFieldOverlay;
      const prevShow = prev.isEditingField && prev.showFieldOverlay;

      if (shouldShow !== prevShow) {
        this.root.visible = shouldShow;
      }

      if (state.isEditingField && !prev.isEditingField) {
        this.cfg = state.tessellationConfig;
        this.projection = makeProjection(state.tessellationConfig);
        this.redrawGrid();
        this.redrawActive(state.fieldPoints);
        this.redrawOrigin();
      }

      if (state.isEditingField && state.showFieldOverlay && !prev.showFieldOverlay) {
        // Overlay just became visible — ensure grid is up to date.
        this.redrawGrid();
        this.redrawActive(state.fieldPoints);
        this.redrawOrigin();
      }

      if (state.isEditingField && state.fieldPoints !== prev.fieldPoints) {
        this.redrawActive(state.fieldPoints);
      }
      if (state.isEditingField && state.tessellationConfig !== prev.tessellationConfig) {
        this.cfg = state.tessellationConfig;
        this.projection = makeProjection(state.tessellationConfig);
        this.redrawGrid();
        this.redrawActive(state.fieldPoints);
        this.redrawOrigin();
      }
    });
  }

  onViewportChanged(x: number, y: number, w: number, h: number, scale: number): void {
    this.vpX = x;
    this.vpY = y;
    this.vpW = w;
    this.vpH = h;
    this.vpScale = scale;
    if (this.root.visible && this.projection) {
      this.redrawGrid();
      this.redrawOrigin();
    }
  }

  private redrawGrid(): void {
    if (!this.projection || !this.cfg) return;
    const g = this.gridLayer;
    g.clear();

    const bounds = this.projection.gridBounds(this.vpX, this.vpY, this.vpW, this.vpH, this.vpScale);
    const cfg = this.cfg;

    g.setStrokeStyle({ width: 1 / this.vpScale, color: GRID_LINE_COLOR, alpha: GRID_LINE_ALPHA });

    for (let xi = bounds.minX; xi <= bounds.maxX; xi++) {
      for (let yi = bounds.minY; yi <= bounds.maxY; yi++) {
        this.drawCellOutline(g, xi, yi, cfg);
      }
    }
  }

  private redrawOrigin(): void {
    if (!this.projection || !this.cfg) return;
    const g = this.originLayer;
    g.clear();

    const { x: cx, y: cy } = this.projection.gridToScreen(0, 0);
    const arm = TILE_SIZE * 0.35 / this.vpScale;
    const w = Math.max(1.5 / this.vpScale, 1.5);
    g.setStrokeStyle({ width: w, color: ORIGIN_COLOR, alpha: ORIGIN_ALPHA });
    g.moveTo(cx - arm, cy).lineTo(cx + arm, cy).stroke();
    g.moveTo(cx, cy - arm).lineTo(cx, cy + arm).stroke();
  }

  private redrawActive(fieldPoints: Set<number>): void {
    if (!this.cfg) return;
    const g = this.activeLayer;
    g.clear();

    const cfg = this.cfg;
    for (const key of fieldPoints) {
      const [x, y] = decodePoint(key);
      this.drawCellFill(g, x, y, cfg);
    }
  }

  private drawCellOutline(g: Graphics, x: number, y: number, cfg: TessellationConfig): void {
    const verts = this.getCellVertices(x, y, cfg);
    if (!verts) return;
    g.moveTo(verts[verts.length - 1].x, verts[verts.length - 1].y);
    for (const v of verts) g.lineTo(v.x, v.y);
    g.stroke();
  }

  private drawCellFill(g: Graphics, x: number, y: number, cfg: TessellationConfig): void {
    const verts = this.getCellVertices(x, y, cfg);
    if (!verts) return;
    g.poly(verts.flatMap(v => [v.x, v.y]));
    g.fill({ color: ACTIVE_CELL_COLOR, alpha: ACTIVE_CELL_ALPHA });
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
    this.activeLayer.destroy();
    this.originLayer.destroy();
  }
}
