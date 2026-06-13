import { Container, Graphics } from "pixi.js";
import type { EdgeHL } from "./types";

export class EdgeHighlightRenderer {
  private readonly g: Graphics;

  constructor(container: Container) {
    this.g = new Graphics();
    container.addChild(this.g);
  }

  render(data: { highlights: EdgeHL[] }): void {
    this.g.clear();
    for (const hl of data.highlights) {
      this.g
        .moveTo(hl.from[0], hl.from[1])
        .lineTo(hl.to[0], hl.to[1])
        .stroke({ width: hl.width, color: hl.color, alpha: hl.alpha, cap: "round" });
    }
  }

  destroy(): void {
    this.g.destroy();
  }
}
