import { Container, Graphics } from "pixi.js";
import type { MarkerData } from "./types";
import { drawMarkerUnderlay, drawMarkerWithBorder } from "./markerShapes";
import { makeCenteredLabel, msdfFontFamily } from "./msdfFont";
import { DEFAULT_MARKER_TEXT_SIZE } from "../renderConstants";

export class WaypointsRenderer {
  private readonly g: Graphics;
  private readonly labels: Container;

  constructor(container: Container) {
    this.g = new Graphics();
    container.addChild(this.g);
    this.labels = new Container();
    container.addChild(this.labels);
  }

  render(data: { markers: MarkerData[] }): void {
    this.g.clear();
    this.labels.removeChildren().forEach((c) => c.destroy({ children: true }));
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
        drawMarkerUnderlay(this.g, shape, m.pos[0], m.pos[1], m.radius, rounded, borderWidth + gapWidth, m.gapColor ?? m.color, borderWidth);
      }
      drawMarkerWithBorder(this.g, shape, m.pos[0], m.pos[1], m.radius, rounded, m.color, m.borderColor ?? m.color, borderWidth);
      if (m.text) {
        const label = makeCenteredLabel(m.text, msdfFontFamily(m.textFontWeight ?? "bold"), m.textSize ?? DEFAULT_MARKER_TEXT_SIZE, m.textColor ?? m.color);
        label.x = m.pos[0];
        label.y = m.pos[1];
        this.labels.addChild(label);
      }
    }
  }

  destroy(): void {
    this.g.destroy();
    this.labels.destroy({ children: true });
  }
}
