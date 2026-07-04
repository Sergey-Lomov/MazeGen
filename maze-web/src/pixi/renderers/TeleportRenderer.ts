import { Container, Graphics } from "pixi.js";
import type { TeleportEdge } from "./types";
import { TILE_SIZE } from "../constants";
import { canvas } from "../colorUtils";

const SQUARE_SIZE = TILE_SIZE * 0.28;
const SQUARE_STROKE_WIDTH = 3;
const SQUARE_CORNER_RADIUS = SQUARE_SIZE * 0.25;

export class TeleportRenderer {
  private readonly g: Graphics;

  constructor(container: Container) {
    this.g = new Graphics();
    container.addChild(this.g);
  }

  render(data: { edges: TeleportEdge[] }): void {
    this.g.clear();
    for (const e of data.edges) {
      const [fx, fy] = e.from;
      const [tx, ty] = e.to;

      const dx = tx - fx;
      const dy = ty - fy;
      const len = Math.sqrt(dx * dx + dy * dy);
      // Stop the line at each square's border (half the square's size), not inside it.
      const half = SQUARE_SIZE / 2;
      if (len > half * 2) {
        const ux = dx / len;
        const uy = dy / len;
        this.g
          .moveTo(fx + ux * half, fy + uy * half)
          .lineTo(tx - ux * half, ty - uy * half)
          .stroke({ width: SQUARE_STROKE_WIDTH, color: canvas.teleport.default, cap: "round" });
      }

      if (e.oneWay) {
        // Both ends get the same-size outline, filled solid at the origin only, so the
        // destination's inward border reads as the same size as the origin's square.
        this.drawSquare(fx, fy, true);
        this.drawSquare(tx, ty, false);
      } else {
        // Two-way teleport: no single "origin" — both ends get the same solid marker.
        this.drawSquare(fx, fy, true);
        this.drawSquare(tx, ty, true);
      }
    }
  }

  private drawSquare(cx: number, cy: number, filled: boolean): void {
    const half = SQUARE_SIZE / 2;
    this.g.roundRect(cx - half, cy - half, SQUARE_SIZE, SQUARE_SIZE, SQUARE_CORNER_RADIUS);
    if (filled) {
      this.g.fill(canvas.teleport.default);
    }
    // alignment: 0 draws the stroke entirely inward from the shape's border, so the
    // outline square never reads as visually larger than the filled square (same outer edge).
    this.g.stroke({ width: SQUARE_STROKE_WIDTH, color: canvas.teleport.default, alignment: 0 });
  }

  destroy(): void {
    this.g.destroy();
  }
}
