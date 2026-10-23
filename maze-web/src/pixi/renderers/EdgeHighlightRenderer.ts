import { Container, Graphics } from "pixi.js";
import type { EdgeHL } from "./types";
import { drawDirectionArrow } from "./wallUtils";
import { tracePath } from "../geometry/pathRenderer";

export class EdgeHighlightRenderer {
  private readonly g: Graphics;

  constructor(container: Container) {
    this.g = new Graphics();
    container.addChild(this.g);
  }

  render(data: { highlights: EdgeHL[] }): void {
    this.g.clear();
    for (const hl of data.highlights) {
      if (hl.path) tracePath(this.g, hl.path);
      else this.g.moveTo(hl.from[0], hl.from[1]).lineTo(hl.to[0], hl.to[1]);
      this.g.stroke({ width: hl.width, color: hl.color, alpha: hl.alpha, cap: "round" });

      if (hl.bidirectional === false) {
        const dx = hl.to[0] - hl.from[0];
        const dy = hl.to[1] - hl.from[1];
        const len = Math.hypot(dx, dy);
        if (len > 0) {
          const midX = (hl.from[0] + hl.to[0]) / 2;
          const midY = (hl.from[1] + hl.to[1]) / 2;
          drawDirectionArrow(this.g, midX, midY, dx / len, dy / len, hl.width * 2, hl.color);
        }
      }
    }
  }

  destroy(): void {
    this.g.destroy();
  }
}
