import { Container, Graphics } from "pixi.js";
import { TILE_SIZE } from "./constants";
import { hexCenter, hexVertices } from "./hexGeometry";
import { triVertices } from "./triGeometry";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import type { PrimitiveWorldGeometry, TessellationKind } from "./primitiveGeometry";
import { canvas } from "./colorTokens";

const ADD_COLOR = canvas.debug.active;
const REMOVE_COLOR = 0xff4444;
const PREVIEW_ALPHA = 0.5;
const FRAME_ALPHA = 0.9;
const FRAME_WIDTH = 1.25;

export class PrimitivePreviewOverlay {
  private readonly root: Container;
  private readonly layer: Graphics;
  private rafPending = false;
  private pendingCells: [number, number][] | null = null;
  private pendingButton = 0;
  private pendingKind: TessellationKind = "square";
  private pendingCfg: TessellationConfig | null = null;
  private pendingGeometry: PrimitiveWorldGeometry | null = null;
  private frameVisible = true;

  constructor(container: Container) {
    this.root = container;
    this.layer = new Graphics();
    this.root.addChild(this.layer);
  }

  update(cells: [number, number][], button: number, kind: TessellationKind, cfg: TessellationConfig, geometry: PrimitiveWorldGeometry): void {
    this.pendingCells = cells;
    this.pendingButton = button;
    this.pendingKind = kind;
    this.pendingCfg = cfg;
    this.pendingGeometry = geometry;
    if (!this.rafPending) {
      this.rafPending = true;
      requestAnimationFrame(() => {
        this.rafPending = false;
        if (this.pendingCells && this.pendingCfg && this.pendingGeometry) this.redraw(this.pendingCells, this.pendingButton, this.pendingKind, this.pendingCfg, this.pendingGeometry);
      });
    }
  }

  setFrameVisible(visible: boolean): void {
    this.frameVisible = visible;
    if (this.pendingCells && this.pendingCfg && this.pendingGeometry) {
      this.redraw(this.pendingCells, this.pendingButton, this.pendingKind, this.pendingCfg, this.pendingGeometry);
    }
  }

  private redraw(cells: [number, number][], button: number, kind: TessellationKind, cfg: TessellationConfig, geometry: PrimitiveWorldGeometry): void {
    const g = this.layer;
    g.clear();
    const color = button === 0 ? ADD_COLOR : REMOVE_COLOR;
    for (const [x, y] of cells) {
      const verts = getCellVertices(x, y, kind, cfg);
      if (!verts) continue;
      g.poly(verts.flatMap(v => [v.x, v.y]));
      g.fill({ color, alpha: PREVIEW_ALPHA });
    }
    if (this.frameVisible) {
      const frameColor = button === 0 ? ADD_COLOR : REMOVE_COLOR;
      if (geometry.kind === "ellipse") {
        g.ellipse(geometry.center.x, -geometry.center.y, geometry.width / 2, geometry.height / 2);
      } else {
        g.poly(geometry.points.flatMap((point) => [point.x, -point.y]));
      }
      g.stroke({ color: frameColor, alpha: FRAME_ALPHA, width: FRAME_WIDTH });
    }
  }

  clear(): void {
    this.pendingCells = null;
    this.pendingGeometry = null;
    this.layer.clear();
  }

  onViewportChanged(_x: number, _y: number, _w: number, _h: number, _scale: number): void {}

  destroy(): void {
    this.layer.destroy();
  }
}

function getCellVertices(x: number, y: number, kind: TessellationKind, cfg: TessellationConfig) {
  switch (kind) {
    case "square": {
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
    case "hex": {
      const orientation = (cfg as { orientation?: "flat_top" | "pointy_top" }).orientation ?? "flat_top";
      const center = hexCenter(x, y, orientation, cfg);
      return hexVertices(center.x, center.y, orientation);
    }
    case "triangle": {
      const orientation = (cfg as { orientation?: "r0" | "r90" | "r180" | "r270" }).orientation ?? "r0";
      return triVertices(x, y, orientation);
    }
  }
}
