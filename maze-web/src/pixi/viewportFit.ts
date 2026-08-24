import { TILE_SIZE } from "./constants";
import { cellCenter, mazeBounds, type Pos } from "./hexGeometry";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";

const FIT_PADDING = 0.9;

/** Shared by `fitMazeViewport` (maze node centers) and `fitFieldViewport` (field cell centers) —
 *  same bounding-box + padding + centering math for both, so "Field" and "Generation" fit the same
 *  maze at the same zoom instead of drifting apart from two independently-tuned implementations. */
export function fitViewportToCenters(
  centers: Pos[],
  screenW: number,
  screenH: number,
): { x: number; y: number; scale: number } {
  if (centers.length === 0) return { x: screenW / 2, y: screenH / 2, scale: 1 };
  const { minX, minY, maxX, maxY } = mazeBounds(centers, TILE_SIZE);
  const W = maxX - minX;
  const H = maxY - minY;
  if (W <= 0 || H <= 0) return { x: screenW / 2, y: screenH / 2, scale: 1 };
  const scale = Math.min(FIT_PADDING * screenW / W, FIT_PADDING * screenH / H);

  return {
    scale,
    x: screenW / 2 - scale * (minX + W / 2),
    y: screenH / 2 - scale * (minY + H / 2),
  };
}

/** Computes the viewport transform that fits all generated maze nodes onto the screen. */
export function fitMazeViewport(
  cfg: TessellationConfig,
  nodes: { x: number; y: number; id: number }[],
  screenW: number,
  screenH: number,
): { x: number; y: number; scale: number } {
  return fitViewportToCenters(nodes.map(n => cellCenter(n, cfg)), screenW, screenH);
}
