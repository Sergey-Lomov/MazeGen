import { Container, Graphics } from "pixi.js";
import { WALL_THICKNESS } from "../renderConstants";

/// One crease line in display space. `preview` marks the segment being drawn (its end follows the pointer).
export interface CreaseLine {
  from: readonly [number, number];
  to: readonly [number, number];
  color: number;
  preview?: boolean;
  /** Drawn thicker, with larger end dots (the crease hovered in the panel). */
  emphasized?: boolean;
}

const WIDTH = WALL_THICKNESS / 2;
const DASH = 10;
const GAP = 6;
const END_RADIUS = 3.5;
const EMPHASIS_SCALE = 1.8;

/// Crease lines of the topology editor (GitHub issue #898): a dashed segment with a dot at each end, opaque and
/// sized in display units, so it zooms with the field like any other element. Display only; nothing here is
/// part of the field or export.
export class CreaseRenderer {
  private readonly g = new Graphics();

  constructor(container: Container) {
    container.addChild(this.g);
  }

  render(lines: readonly CreaseLine[]): void {
    this.g.clear();
    for (const { from, to, color, emphasized } of lines) {
      const scale = emphasized ? EMPHASIS_SCALE : 1;
      const dx = to[0] - from[0];
      const dy = to[1] - from[1];
      const length = Math.hypot(dx, dy);
      if (length > 0) {
        const ux = dx / length;
        const uy = dy / length;
        for (let at = 0; at < length; at += DASH + GAP) {
          const end = Math.min(at + DASH, length);
          this.g.moveTo(from[0] + ux * at, from[1] + uy * at).lineTo(from[0] + ux * end, from[1] + uy * end);
        }
        this.g.stroke({ color, width: WIDTH * scale, cap: "round" });
      }
      for (const end of [from, to]) this.g.circle(end[0], end[1], END_RADIUS * scale).fill({ color });
    }
  }

  destroy(): void {
    this.g.destroy();
  }
}
