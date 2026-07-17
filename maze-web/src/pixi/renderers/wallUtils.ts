import type { Graphics } from "pixi.js";
import { TILE_SIZE } from "../constants";
import { canvas } from "../colorTokens";

// Draws a direction arrow triangle centered at (cx, cy), pointing in (dx, dy) direction.
// size controls the scale. Color defaults to canvas.edge.oneWay.
export function drawDirectionArrow(
  g: Graphics,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
  size: number,
  color?: number,
): void {
  const px = -dy;
  const py = dx;
  const tipX = cx + dx * size;
  const tipY = cy + dy * size;
  const baseX = cx - dx * size * 0.5;
  const baseY = cy - dy * size * 0.5;
  g.poly([
    tipX, tipY,
    baseX + px * size * 0.6, baseY + py * size * 0.6,
    baseX - px * size * 0.6, baseY - py * size * 0.6,
  ]);
  g.fill(color ?? canvas.edge.oneWay);
}

export function drawOneWayTriangle(
  g: Graphics,
  wallCx: number,
  wallCy: number,
  pointingDx: number,
  pointingDy: number,
  color?: number,
): void {
  drawDirectionArrow(g, wallCx, wallCy, pointingDx, pointingDy, TILE_SIZE * 0.18, color);
}
