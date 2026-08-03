import { Container, Graphics } from "pixi.js";
import type { MarkerData, MarkerShape } from "./types";

/** Regular-polygon corner points for `square`/`diamond`/`triangle`/`star5`, first vertex pointing
 *  up — `star5` alternates outer/inner radius (inner = 0.5x outer) across 10 points. `circle` is
 *  drawn via `Graphics.circle` directly, not through this. */
export function polygonPoints(shape: Exclude<MarkerShape, "circle">, cx: number, cy: number, r: number): number[] {
  const sides = shape === "square" ? 4 : shape === "diamond" ? 4 : shape === "triangle" ? 3 : 10;
  const rotation = shape === "square" ? Math.PI / 4 : -Math.PI / 2;
  const points: number[] = [];
  for (let i = 0; i < sides; i++) {
    const angle = rotation + (i / sides) * Math.PI * 2;
    const radius = shape === "star5" && i % 2 === 1 ? r * 0.5 : r;
    points.push(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
  }
  return points;
}

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
      if (shape === "circle") {
        this.g.circle(m.pos[0], m.pos[1], m.radius);
      } else {
        this.g.poly(polygonPoints(shape, m.pos[0], m.pos[1], m.radius));
      }
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
