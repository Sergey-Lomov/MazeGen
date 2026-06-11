import { Container, Graphics } from "pixi.js";
import { useMazeStore } from "../store/mazeStore";
import { decodePoint } from "../store/mazeStore";
import { makeProjection } from "./tessellationProjection";
import type { TessellationProjection } from "./tessellationProjection";
import { getCellVertices } from "./tessellationGeometry";
import { TILE_SIZE } from "./constants";
import type { TessellationConfig } from "../wasm/types";
import { configAllCells } from "./tessellationCells";

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
    const verts = getCellVertices(x, y, cfg);
    if (!verts) return;
    g.poly(verts.flatMap(v => [v.x, v.y]));
    g.fill({ color: ACTIVE_CELL_COLOR, alpha: ACTIVE_CELL_ALPHA });
  }

  destroy(): void {
    this.unsubscribe?.();
    this.activeLayer.destroy();
    this.originLayer.destroy();
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
