import { Container, Graphics } from "pixi.js";
import type { TeleportEdge } from "./types";
import { TILE_SIZE } from "../constants";
import { canvas } from "../colorUtils";

const SQUARE_SIZE = TILE_SIZE * 0.28;
const SQUARE_STROKE_WIDTH = 3;
const SQUARE_CORNER_RADIUS = SQUARE_SIZE * 0.25;

function coordKey(x: number, y: number): string {
  return `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
}

/** A cell reads as half-filled when the markers landing on it disagree: at least one edge wants
 * a filled square there and at least one (a different edge) wants an outline square. Returns the
 * set of coordKey-encoded cells that are mixed. */
export function computeMixedCells(edges: TeleportEdge[]): Set<string> {
  const cellWants = new Map<string, { filled: boolean; outline: boolean }>();
  const want = (cx: number, cy: number, filled: boolean) => {
    const key = coordKey(cx, cy);
    const entry = cellWants.get(key) ?? { filled: false, outline: false };
    if (filled) entry.filled = true; else entry.outline = true;
    cellWants.set(key, entry);
  };
  for (const e of edges) {
    if (e.oneWay) {
      want(e.from[0], e.from[1], true);
      want(e.to[0], e.to[1], false);
    } else {
      want(e.from[0], e.from[1], true);
      want(e.to[0], e.to[1], true);
    }
  }
  const mixed = new Set<string>();
  for (const [key, entry] of cellWants) {
    if (entry.filled && entry.outline) mixed.add(key);
  }
  return mixed;
}

export class TeleportRenderer {
  private readonly g: Graphics;

  constructor(container: Container) {
    this.g = new Graphics();
    container.addChild(this.g);
  }

  render(data: { edges: TeleportEdge[] }): void {
    this.g.clear();

    const mixedCells = computeMixedCells(data.edges);
    const isMixedCell = (cx: number, cy: number): boolean => mixedCells.has(coordKey(cx, cy));

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
        this.drawSquare(fx, fy, true, isMixedCell(fx, fy));
        this.drawSquare(tx, ty, false, isMixedCell(tx, ty));
      } else {
        // Two-way teleport: no single "origin" — both ends get the same solid marker.
        this.drawSquare(fx, fy, true, isMixedCell(fx, fy));
        this.drawSquare(tx, ty, true, isMixedCell(tx, ty));
      }
    }
  }

  private drawSquare(cx: number, cy: number, filled: boolean, half: boolean): void {
    const size = SQUARE_SIZE;
    const s = size / 2;
    if (half) {
      // Diagonal split: upper-left triangle filled, lower-right left as outline-only — reads as
      // "this cell hosts two different links' markers", distinct from a fully filled square
      // (one link's own entry+exit, e.g. a two-way teleport's endpoint).
      this.g.roundRect(cx - s, cy - s, size, size, SQUARE_CORNER_RADIUS);
      this.g.stroke({ width: SQUARE_STROKE_WIDTH, color: canvas.teleport.default, alignment: 0 });
      this.g
        .moveTo(cx - s, cy - s)
        .lineTo(cx + s, cy - s)
        .lineTo(cx - s, cy + s)
        .closePath()
        .fill(canvas.teleport.default);
      return;
    }

    this.g.roundRect(cx - s, cy - s, size, size, SQUARE_CORNER_RADIUS);
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
