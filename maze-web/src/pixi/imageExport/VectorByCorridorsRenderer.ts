import { Container } from "pixi.js";
import { canvas } from "../colorTokens";
import type { ModeRenderer } from "./modeRendererFactory";
import { uniform, type ExportMargin } from "./exportMargins";

/** "Vector by corridors" render mode's own renderer (GitHub issue #315) — empty scaffolding, per
 * `maze-web/CLAUDE.md`'s feature-renderer ownership rule: its own `Container`, never shared with
 * `VectorByWallsRenderer` or any other feature's renderer. Follow-up sub-issues fill in the actual
 * drawing; any logic that ends up identical to `VectorByWallsRenderer`'s own should move into a
 * shared base class or utility at that point, not be copy-pasted. */
export class VectorByCorridorsRenderer implements ModeRenderer {
  constructor(_container: Container) {}

  onViewportChanged(_x: number, _y: number, _w: number, _h: number, _scale: number): void {}

  getRequiredExportMargin(): ExportMargin {
    return uniform(0);
  }

  getRequiredWallExportMargin(): ExportMargin {
    return uniform(0);
  }

  getBackgroundColor(): number {
    return canvas.stage.background;
  }

  destroy(): void {}
}
