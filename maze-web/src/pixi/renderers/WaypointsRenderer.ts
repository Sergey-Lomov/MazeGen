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
      const rounded = m.cornerStyle === "round";
      const borderWidth = m.borderWidth ?? 0;
      const gapWidth = m.gapWidth ?? 0;
      // The border is drawn `alignment: 0` (pixi's outer alignment, grows entirely outward from
      // `radius` — same convention every border/gap in this codebase now uses, GitHub issue #302
      // follow-up), so the marker's true outer edge is always `radius + borderWidth`, never just
      // `radius` — the gap ring (drawn first, underneath) must start there, not at
      // `radius + borderWidth/2` (a centered-border assumption that let a large enough `borderWidth`
      // visually eat into the gap).
      if (gapWidth > 0) {
        drawMarkerShape(this.g, shape, m.pos[0], m.pos[1], m.radius + borderWidth + gapWidth, rounded);
        this.g.fill(m.gapColor ?? m.color);
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
