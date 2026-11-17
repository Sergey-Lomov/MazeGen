import type { Graphics } from "pixi.js";

export interface PaperLayoutRect { x: number; y: number; w: number; h: number; }

export interface PaperLayoutBounds { x: number; y: number; w: number; h: number; }

const FRAME_STROKE_WIDTH = 2;
const MARGIN_STROKE_WIDTH = 1;
const DASH_LENGTH = 10;
const GAP_LENGTH = 6;

/** Dims the area outside the sheet, as the PNG print overlay does. */
export function drawPaperLayoutDim(graphics: Graphics, rect: PaperLayoutRect, bounds: PaperLayoutBounds, alpha = 0.45): void {
  fillIfVisible(graphics, bounds.x, bounds.y, bounds.w, rect.y - bounds.y, alpha);
  fillIfVisible(graphics, bounds.x, rect.y + rect.h, bounds.w, bounds.y + bounds.h - rect.y - rect.h, alpha);
  fillIfVisible(graphics, bounds.x, rect.y, rect.x - bounds.x, rect.h, alpha);
  fillIfVisible(graphics, rect.x + rect.w, rect.y, bounds.x + bounds.w - rect.x - rect.w, rect.h, alpha);
}

function fillIfVisible(graphics: Graphics, x: number, y: number, width: number, height: number, alpha: number): void {
  if (width > 0 && height > 0) graphics.rect(x, y, width, height).fill({ color: 0x000000, alpha });
}

/** Draws the same solid sheet frame used by the PNG print overlay.
 *
 * `screenScale` converts screen-pixel measurements to the graphics' coordinate space. It is one
 * for world-space paper guides, while the export overlay supplies its viewport scale so changing
 * paper sizes cannot make this fixed screen-space frame's stroke appear thicker or thinner. */
export function drawPaperLayoutFrame(graphics: Graphics, rect: PaperLayoutRect, color: number, screenScale = 1): void {
  const strokeWidth = FRAME_STROKE_WIDTH / validScreenScale(screenScale);
  const half = strokeWidth / 2;
  graphics.rect(rect.x - half, rect.y - half, rect.w + strokeWidth, rect.h + strokeWidth)
    .stroke({ width: strokeWidth, color });
}

/** Draws the same dashed printable-area guides used by the PNG print overlay. */
export function drawPaperLayoutMargins(graphics: Graphics, rect: PaperLayoutRect, marginHorizontal: number, marginVertical: number, color: number, screenScale = 1): void {
  if (marginHorizontal <= 0 && marginVertical <= 0) return;
  if (rect.w <= marginHorizontal * 2 || rect.h <= marginVertical * 2) return;
  if (marginHorizontal > 0) {
    drawDashedSegment(graphics, rect.x + marginHorizontal, rect.y, rect.x + marginHorizontal, rect.y + rect.h, color, screenScale);
    drawDashedSegment(graphics, rect.x + rect.w - marginHorizontal, rect.y, rect.x + rect.w - marginHorizontal, rect.y + rect.h, color, screenScale);
  }
  if (marginVertical > 0) {
    drawDashedSegment(graphics, rect.x, rect.y + marginVertical, rect.x + rect.w, rect.y + marginVertical, color, screenScale);
    drawDashedSegment(graphics, rect.x, rect.y + rect.h - marginVertical, rect.x + rect.w, rect.y + rect.h - marginVertical, color, screenScale);
  }
}

function drawDashedSegment(graphics: Graphics, x1: number, y1: number, x2: number, y2: number, color: number, screenScale: number): void {
  const scale = validScreenScale(screenScale);
  const dashLength = DASH_LENGTH / scale;
  const gapLength = GAP_LENGTH / scale;
  const strokeWidth = MARGIN_STROKE_WIDTH / scale;
  const length = Math.hypot(x2 - x1, y2 - y1);
  if (length <= 0) return;
  const ux = (x2 - x1) / length;
  const uy = (y2 - y1) / length;
  for (let travelled = 0; travelled < length; travelled += dashLength + gapLength) {
    const end = Math.min(travelled + dashLength, length);
    graphics.moveTo(x1 + ux * travelled, y1 + uy * travelled);
    graphics.lineTo(x1 + ux * end, y1 + uy * end);
    graphics.stroke({ width: strokeWidth, color });
  }
}

function validScreenScale(scale: number): number {
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}
