import type { Container } from "pixi.js";
import type { TessellationProjection } from "./tessellationProjection";
import type { HoverInfo, HoverProvider } from "./hoverTypes";

/** Shared canvas-space → grid-space conversion, used by FieldEditController.toGrid and the
 * default hover provider. Both need identical math: undo the viewport's pan/zoom transform,
 * then hand off to the tessellation projection for the actual grid quantization. */
export function canvasToGrid(
  canvasX: number,
  canvasY: number,
  viewport: Container,
  projection: TessellationProjection,
): { x: number; y: number } {
  const vx = (canvasX - viewport.x) / viewport.scale.x;
  const vy = (canvasY - viewport.y) / viewport.scale.y;
  return projection.screenToGrid(vx, vy);
}

/** Default hover provider: reports the grid cell under the cursor for any feature that has no
 * custom hover behavior. Parameterized by viewport + projection getters (not raw values) since
 * the resolving code picks a different tessellation config per open card, and both change over
 * the object's lifetime. */
export class DefaultHoverProvider implements HoverProvider {
  constructor(
    private getViewport: () => Container,
    private getProjection: () => TessellationProjection | null,
  ) {}

  getHoverInfo(canvasX: number, canvasY: number): HoverInfo | null {
    const projection = this.getProjection();
    if (!projection) return null;
    return canvasToGrid(canvasX, canvasY, this.getViewport(), projection);
  }
}
