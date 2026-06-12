import { Container, Graphics } from "pixi.js";
import { TILE_SIZE } from "./constants";
import { hexCenter, hexVertices } from "./hexGeometry";
import { triVertices } from "./triGeometry";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import type { TessellationKind } from "./primitiveGeometry";

const ADD_COLOR = 0x4488ff;
const REMOVE_COLOR = 0xff4444;
const PREVIEW_ALPHA = 0.5;

export class PrimitivePreviewOverlay {
  private readonly root: Container;
  private readonly layer: Graphics;
  private rafPending = false;
  private pendingCells: [number, number][] | null = null;
  private pendingButton = 0;
  private pendingKind: TessellationKind = "square";
  private pendingCfg: TessellationConfig | null = null;

  constructor(container: Container) {
    this.root = container;
    this.layer = new Graphics();
    this.root.addChild(this.layer);
  }

  update(cells: [number, number][], button: number, kind: TessellationKind, cfg: TessellationConfig): void {
    this.pendingCells = cells;
    this.pendingButton = button;
    this.pendingKind = kind;
    this.pendingCfg = cfg;
    if (!this.rafPending) {
      this.rafPending = true;
      requestAnimationFrame(() => {
        this.rafPending = false;
        if (this.pendingCells && this.pendingCfg) this.redraw(this.pendingCells, this.pendingButton, this.pendingKind, this.pendingCfg);
      });
    }
  }

  private redraw(cells: [number, number][], button: number, kind: TessellationKind, cfg: TessellationConfig): void {
    const g = this.layer;
    g.clear();
    const color = button === 0 ? ADD_COLOR : REMOVE_COLOR;
    for (const [x, y] of cells) {
      const verts = getCellVertices(x, y, kind, cfg);
      if (!verts) continue;
      g.poly(verts.flatMap(v => [v.x, v.y]));
      g.fill({ color, alpha: PREVIEW_ALPHA });
    }
  }

  clear(): void {
    this.pendingCells = null;
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
      const center = hexCenter(x, y, orientation);
      return hexVertices(center.x, center.y, orientation);
    }
    case "triangle": {
      const orientation = (cfg as { orientation?: "r0" | "r90" | "r180" | "r270" }).orientation ?? "r0";
      return triVertices(x, y, orientation);
    }
  }
}

