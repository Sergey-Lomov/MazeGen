import { Container, Graphics } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import { decodePoint } from "../store/mazeStore";
import { makeProjection } from "./tessellationProjection";
import type { TessellationProjection } from "./tessellationProjection";
import { TILE_SIZE } from "./constants";
import { hexCenter, hexVertices } from "./hexGeometry";
import { triVertices } from "./triGeometry";
import type { TessellationConfig } from "../wasm/types";

const ACTIVE_CELL_COLOR = 0x666666;
const ACTIVE_CELL_ALPHA = 0.7;
const ORIGIN_COLOR = 0xFF6600;
const ORIGIN_ALPHA = 0.9;

export class FieldEditorOverlay {
  private readonly root: Container;
  private readonly activeLayer: Graphics;
  private readonly originLayer: Graphics;

  private cfg: TessellationConfig | null = null;
  private projection: TessellationProjection | null = null;

  private vpScale = 1;

  private unsubscribe: (() => void) | null = null;

  constructor(container: Container) {
    this.root = container;
    this.activeLayer = new Graphics();
    this.originLayer = new Graphics();
    this.root.addChild(this.activeLayer);
    this.root.addChild(this.originLayer);

    this.root.visible = false;

    this.unsubscribe = useMazeStore.subscribe((state, prev) => {
      if (state.fieldSetupOpen !== prev.fieldSetupOpen) {
        this.root.visible = state.fieldSetupOpen;
      }

      if (state.fieldSetupOpen && !prev.fieldSetupOpen) {
        this.cfg = state.tessellationConfig;
        this.projection = makeProjection(state.tessellationConfig);
        this.redrawActive(state.fieldPoints, state.fieldEditMode);
        this.redrawOrigin(state.fieldEditMode === "custom");
      }

      if (state.fieldSetupOpen && state.fieldPoints !== prev.fieldPoints) {
        this.redrawActive(state.fieldPoints, state.fieldEditMode);
      }

      if (state.fieldSetupOpen && state.tessellationConfig !== prev.tessellationConfig) {
        this.cfg = state.tessellationConfig;
        this.projection = makeProjection(state.tessellationConfig);
        this.redrawActive(state.fieldPoints, state.fieldEditMode);
        this.redrawOrigin(state.fieldEditMode === "custom");
      }

      if (state.fieldSetupOpen && state.fieldEditMode !== prev.fieldEditMode) {
        this.redrawOrigin(state.fieldEditMode === "custom");
        this.redrawActive(state.fieldPoints, state.fieldEditMode);
      }
    });
  }

  onViewportChanged(_x: number, _y: number, _w: number, _h: number, scale: number): void {
    this.vpScale = scale;
    if (this.root.visible && this.projection) {
      const state = useMazeStore.getState();
      this.redrawOrigin(state.fieldEditMode === "custom");
    }
  }

  private redrawOrigin(show: boolean): void {
    const g = this.originLayer;
    g.clear();
    if (!show || !this.projection || !this.cfg) return;

    const { x: cx, y: cy } = this.projection.gridToScreen(0, 0);
    const arm = TILE_SIZE * 0.35 / this.vpScale;
    const w = Math.max(1.5 / this.vpScale, 1.5);
    g.setStrokeStyle({ width: w, color: ORIGIN_COLOR, alpha: ORIGIN_ALPHA });
    g.moveTo(cx - arm, cy).lineTo(cx + arm, cy).stroke();
    g.moveTo(cx, cy - arm).lineTo(cx, cy + arm).stroke();
  }

  private redrawActive(fieldPoints: Set<number>, fieldEditMode: "default" | "custom"): void {
    if (!this.cfg) return;
    const g = this.activeLayer;
    g.clear();

    const cfg = this.cfg;
    if (fieldEditMode === "default") {
      for (const [x, y] of configAllCells(cfg)) {
        this.drawCellFill(g, x, y, cfg);
      }
    } else {
      for (const key of fieldPoints) {
        const [x, y] = decodePoint(key);
        this.drawCellFill(g, x, y, cfg);
      }
    }
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
    this.activeLayer.destroy();
    this.originLayer.destroy();
  }
}

function configAllCells(cfg: TessellationConfig): [number, number][] {
  switch (cfg.type) {
    case "square": {
      const ox = Math.floor(cfg.width / 2);
      const oy = Math.floor(cfg.height / 2);
      const cells: [number, number][] = [];
      for (let x = 0; x < cfg.width; x++)
        for (let y = 0; y < cfg.height; y++)
          cells.push([x - ox, y - oy]);
      return cells;
    }
    case "hex_parallelogram": {
      const ox = Math.floor(cfg.cols / 2);
      const oy = Math.floor(cfg.rows / 2);
      const cells: [number, number][] = [];
      for (let x = 0; x < cfg.cols; x++)
        for (let y = 0; y < cfg.rows; y++)
          cells.push([x - ox, y - oy]);
      return cells;
    }
    case "hex_hexagon": {
      const r = cfg.radius;
      const cells: [number, number][] = [];
      for (let x = -r; x <= r; x++)
        for (let y = -r; y <= r; y++)
          if (Math.abs(x + y) <= r) cells.push([x, y]);
      return cells;
    }
    case "triangle_rect": {
      let ox = Math.floor(cfg.cols / 2);
      let oy = Math.floor(cfg.rows / 2);
      // preserve parity: (ox+oy) must be even so (col-ox+row-oy)%2 == (col+row)%2
      if ((ox + oy) % 2 !== 0) oy = Math.max(0, oy - 1);
      const cells: [number, number][] = [];
      for (let x = 0; x < cfg.cols; x++)
        for (let y = 0; y < cfg.rows; y++)
          cells.push([x - ox, y - oy]);
      return cells;
    }
    case "triangle_triangle": {
      const n = cfg.side;
      const shift = n % 2;
      const raw: [number, number][] = [];
      for (let row = 0; row < n; row++) {
        const indent = n - 1 - row + shift;
        for (let col = indent; col <= indent + 2 * row; col++)
          raw.push([col, row]);
      }
      const cols = raw.map(c => c[0]), rows = raw.map(c => c[1]);
      let ox = Math.round((Math.min(...cols) + Math.max(...cols)) / 2);
      let oy = Math.round((Math.min(...rows) + Math.max(...rows)) / 2);
      if ((ox + oy) % 2 !== 0) oy = Math.max(0, oy - 1);
      return raw.map(([x, y]) => [x - ox, y - oy]);
    }
    case "triangle_hexagon": {
      const r = cfg.radius;
      const odd_base = r % 2 === 0 ? r - 1 : r;
      const raw: [number, number][] = [];
      for (let row = 0; row < 2 * r; row++) {
        const k = Math.min(row, 2 * r - 1 - row);
        const indent = odd_base - k;
        const width = 2 * (k + r) + 1;
        for (let col = indent; col < indent + width; col++)
          raw.push([col, row]);
      }
      const cols = raw.map(c => c[0]), rows = raw.map(c => c[1]);
      let ox = Math.round((Math.min(...cols) + Math.max(...cols)) / 2);
      let oy = Math.round((Math.min(...rows) + Math.max(...rows)) / 2);
      if ((ox + oy) % 2 !== 0) oy = Math.max(0, oy - 1);
      return raw.map(([x, y]) => [x - ox, y - oy]);
    }
    case "square_custom":
    case "hex_custom":
    case "tri_custom":
      return cfg.points.map(([x, y]) => [x, y]);
  }
}

export function configScreenCenter(cfg: TessellationConfig): { x: number; y: number } {
  const cells = configAllCells(cfg);
  if (cells.length === 0) return { x: 0, y: 0 };
  const proj = makeProjection(cfg);
  let sx = 0, sy = 0;
  for (const [col, row] of cells) {
    const { x, y } = proj.gridToScreen(col, row);
    sx += x; sy += y;
  }
  return { x: sx / cells.length, y: sy / cells.length };
}
