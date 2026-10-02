import { Container, Graphics } from "pixi.js";
import { TILE_SIZE } from "./constants";
import { hexCenter, hexVertices } from "./hexGeometry";
import { triVertices } from "./triGeometry";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import type { PrimitiveWorldGeometry, TessellationKind } from "./primitiveGeometry";
import { canvas } from "./colorTokens";

const ADD_COLOR = canvas.fieldEditor.previewAdd;
const REMOVE_COLOR = canvas.fieldEditor.previewRemove;
const PREVIEW_ALPHA = 0.5;
const FRAME_ALPHA = 0.9;
const FRAME_WIDTH = 1.25;
const NODE_RADIUS = TILE_SIZE * 0.16;
const DASH_LENGTH = TILE_SIZE * 0.35;
const GAP_LENGTH = TILE_SIZE * 0.22;

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
    const color = geometry.kind === "polygon" && geometry.cellColor !== undefined
      ? geometry.cellColor
      : geometry.kind === "boundary" && geometry.cellColor !== undefined
        ? geometry.cellColor
        : button === 0 ? ADD_COLOR : REMOVE_COLOR;
    const alpha = geometry.kind !== "ellipse" ? geometry.cellAlpha ?? PREVIEW_ALPHA : PREVIEW_ALPHA;
    for (const [x, y] of cells) {
      const verts = getCellVertices(x, y, kind, cfg);
      if (!verts) continue;
      g.poly(verts.flatMap(v => [v.x, v.y]));
      g.fill({ color, alpha });
    }
    if (this.frameVisible) {
      const frameColor = geometry.kind === "boundary"
        ? 0xffffff
        : geometry.kind === "polygon" && geometry.frameColor !== undefined
          ? geometry.frameColor
          : button === 0 ? ADD_COLOR : REMOVE_COLOR;
      if (geometry.kind === "ellipse") {
        g.ellipse(geometry.center.x, -geometry.center.y, geometry.width / 2, geometry.height / 2);
        g.stroke({ color: frameColor, alpha: FRAME_ALPHA, width: FRAME_WIDTH });
      } else if (geometry.kind === "boundary") {
        for (const [start, end] of geometry.segments) {
          drawDashedSegment(g, { x: start.x, y: -start.y }, { x: end.x, y: -end.y }, frameColor);
        }
      } else {
        const points = geometry.points;
        const interactivePolygon = geometry.vertexCount !== undefined;
        if (interactivePolygon) {
          const hasCursorPoint = points.length > (geometry.vertexCount ?? 0);
          const confirmedVertexCount = geometry.vertexCount ?? points.length;
          const pointCount = hasCursorPoint
            ? (confirmedVertexCount >= 2 ? points.length : 0)
            : (confirmedVertexCount >= 3 ? points.length : 0);
          if (geometry.dashedAll && pointCount >= 2) {
            for (let i = 1; i < pointCount; i++) {
              drawDashedSegment(g, { x: points[i - 1].x, y: -points[i - 1].y }, { x: points[i].x, y: -points[i].y }, frameColor);
            }
          } else if (pointCount >= 2) {
            g.moveTo(points[0].x, -points[0].y);
            for (let i = 1; i < pointCount; i++) g.lineTo(points[i].x, -points[i].y);
            g.stroke({ color: frameColor, alpha: FRAME_ALPHA, width: FRAME_WIDTH });
          }
          if (geometry.dashedClosing && points.length >= 2) {
            const first = points[0];
            const last = points[points.length - 1];
            drawDashedSegment(g, { x: last.x, y: -last.y }, { x: first.x, y: -first.y }, frameColor);
          }
          const vertexCount = Math.min(geometry.vertexCount ?? points.length, points.length);
          for (let i = 0; i < vertexCount; i++) {
            const point = points[i];
            g.circle(point.x, -point.y, NODE_RADIUS);
            g.fill({ color: frameColor, alpha: 0.95 });
            g.stroke({ color: 0xffffff, alpha: 0.95, width: FRAME_WIDTH });
          }
        } else {
          if (points.length === 2) {
            g.moveTo(points[0].x, -points[0].y);
            g.lineTo(points[1].x, -points[1].y);
          } else {
            g.poly(points.flatMap((point) => [point.x, -point.y]));
          }
          g.stroke({ color: frameColor, alpha: FRAME_ALPHA, width: FRAME_WIDTH });
        }
      }
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

function drawDashedSegment(
  g: Graphics,
  start: { x: number; y: number },
  end: { x: number; y: number },
  color: number,
): void {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return;
  const ux = dx / length;
  const uy = dy / length;
  const step = DASH_LENGTH + GAP_LENGTH;
  for (let travelled = 0; travelled < length; travelled += step) {
    const dashEnd = Math.min(travelled + DASH_LENGTH, length);
    g.moveTo(start.x + ux * travelled, start.y + uy * travelled);
    g.lineTo(start.x + ux * dashEnd, start.y + uy * dashEnd);
    g.stroke({ color, alpha: FRAME_ALPHA, width: FRAME_WIDTH });
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
