import { Container, Graphics } from "pixi.js";
import type { MarkerData } from "./types";
import { drawMarkerShape, drawMarkerUnderlay } from "./markerShapes";

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
      const rounded = m.cornerStyle === "round";
      const borderWidth = m.borderWidth ?? 0;
      const gapWidth = m.gapWidth ?? 0;
      // Single true outward offset of the fill path (`radius`) by `borderWidth + gapWidth` — see
      // `drawMarkerUnderlay`'s own doc comment (GitHub issue #552 ninth follow-up) for the full
      // rationale; the marker's own border (drawn on top, below) covers the ring's inner
      // `borderWidth`-wide band, leaving only the outer `gapWidth`-wide band visible.
      if (gapWidth > 0) {
        drawMarkerUnderlay(this.g, shape, m.pos[0], m.pos[1], m.radius, rounded, borderWidth + gapWidth, m.gapColor ?? m.color);
      }
      drawMarkerShape(this.g, shape, m.pos[0], m.pos[1], m.radius, rounded);
      this.g.fill(m.color);
      if (borderWidth > 0) {
        this.g.stroke({ color: m.borderColor ?? m.color, width: borderWidth, alignment: 0 });
      }
    }
  }

  destroy(): void {
    this.g.destroy();
  }
}
