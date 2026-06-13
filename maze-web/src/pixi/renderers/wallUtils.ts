import type { Graphics } from "pixi.js";
import { TILE_SIZE } from "../constants";
import { ONE_WAY_COLOR } from "../colorUtils";

export function drawOneWayTriangle(
  g: Graphics,
  wallCx: number,
  wallCy: number,
  pointingDx: number,
  pointingDy: number,
): void {
  const size = TILE_SIZE * 0.18;
  const px = -pointingDy;
  const py = pointingDx;
  const tipX = wallCx + pointingDx * size;
  const tipY = wallCy + pointingDy * size;
  const baseX = wallCx - pointingDx * size * 0.5;
  const baseY = wallCy - pointingDy * size * 0.5;
  g.poly([
    tipX, tipY,
    baseX + px * size * 0.6, baseY + py * size * 0.6,
    baseX - px * size * 0.6, baseY - py * size * 0.6,
  ]);
  g.fill(ONE_WAY_COLOR);
}
