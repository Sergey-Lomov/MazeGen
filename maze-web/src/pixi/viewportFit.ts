import { TILE_SIZE } from "./constants";
import { cellCenter, mazeBounds } from "./hexGeometry";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";

const FIT_PADDING = 0.9;

/** Computes the viewport transform that fits all generated maze nodes onto the screen. */
export function fitMazeViewport(
  cfg: TessellationConfig,
  nodes: { x: number; y: number; id: number }[],
  screenW: number,
  screenH: number,
): { x: number; y: number; scale: number } {
  const centers = nodes.map(n => cellCenter(n, cfg));
  const { minX, minY, maxX, maxY } = mazeBounds(centers, TILE_SIZE);
  const W = maxX - minX;
  const H = maxY - minY;
  const scale = Math.min(FIT_PADDING * screenW / W, FIT_PADDING * screenH / H);

  return {
    scale,
    x: screenW / 2 - scale * (minX + W / 2),
    y: screenH / 2 - scale * (minY + H / 2),
  };
}
