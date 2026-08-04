import { Container, Graphics } from "pixi.js";
import type { MarkerData } from "./types";
import { drawMarkerShape } from "./markerShapes";

export class WaypointsRenderer {
  private readonly g: Graphics;

  constructor(container: Container) {
    this.g = new Graphics();
    container.addChild(this.g);
  }

  render(data: { markers: MarkerData[] }): void {
    this.g.clear();
    for (const m of data.markers) {
      const shape = m.shape ?? "circle";
      drawMarkerShape(this.g, shape, m.pos[0], m.pos[1], m.radius);
      this.g.fill(m.color);
      if (m.borderWidth) {
        this.g.stroke({ color: m.borderColor ?? m.color, width: m.borderWidth });
      }
    }
  }

  destroy(): void {
    this.g.destroy();
  }
}
