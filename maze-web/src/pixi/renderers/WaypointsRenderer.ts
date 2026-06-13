import { Container, Graphics } from "pixi.js";
import type { MarkerData } from "./types";

export class WaypointsRenderer {
  private readonly g: Graphics;

  constructor(container: Container) {
    this.g = new Graphics();
    container.addChild(this.g);
  }

  render(data: { markers: MarkerData[] }): void {
    this.g.clear();
    for (const m of data.markers) {
      this.g.circle(m.pos[0], m.pos[1], m.radius).fill(m.color);
    }
  }

  destroy(): void {
    this.g.destroy();
  }
}
