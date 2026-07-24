import { Container, Graphics } from "pixi.js";
import type { SplitPassage } from "./types";
import { drawDirectionArrow } from "./wallUtils";
import { WALL_THICKNESS } from "../renderConstants";
import { TILE_SIZE } from "../constants";
import { canvas } from "../colorTokens";
import { disabledOfNumber } from "../../styles/palette";

/** Draws a split point's independent passages (GitHub issue #223, arrow moved onto the connector
 *  for #234) — for each node, its own share of the wall on every geometric face it connects across
 *  (`wallSegments`), plus `connectors` linking those shares together: a straight line between the
 *  two shares for a node with exactly 2 plain two-way connections, or one line per share from a
 *  small circle point otherwise (never drawn itself). A one-way's arrowhead is drawn on its
 *  connector line, at the midpoint, pointing along the line's own direction (`oneWayOut`) — never
 *  on the along-face segment. An optional/tentative share (`undefined`) draws in a disabled
 *  (desaturated) version of the node's color, both on the segment and its connector — see
 *  `buildSplitPassages`/`splitFaceLayout.ts`. `wallFaces` (faces every node explicitly walls off)
 *  draw once as a plain solid wall, same color as an ordinary non-split wall. */
export class SplitJunctionRenderer {
  private readonly g: Graphics;

  constructor(container: Container) {
    this.g = new Graphics();
    container.addChild(this.g);
  }

  render(data: { passages: SplitPassage[]; wallFaces: { v0: { x: number; y: number }; v1: { x: number; y: number } }[] }): void {
    this.g.clear();
    for (const face of data.wallFaces) {
      this.g
        .moveTo(face.v0.x, face.v0.y)
        .lineTo(face.v1.x, face.v1.y)
        .stroke({ width: WALL_THICKNESS, color: canvas.wall.default, cap: "round", join: "round" });
    }

    for (const passage of data.passages) {
      // Computed once per passage, not per segment/connector — `disabledOfNumber` round-trips
      // through hex/HSL conversion, and every share of the same node always disables to the same
      // color.
      const disabledColor = disabledOfNumber(passage.color);

      for (const connector of passage.connectors) {
        const color = connector.isUndefined ? disabledColor : passage.color;
        this.g
          .moveTo(connector.from.x, connector.from.y)
          .lineTo(connector.to.x, connector.to.y)
          .stroke({ width: WALL_THICKNESS, color, cap: "round", join: "round" });

        if (connector.oneWayOut !== undefined) {
          const dx = connector.to.x - connector.from.x, dy = connector.to.y - connector.from.y;
          const len = Math.hypot(dx, dy) || 1;
          const dir = connector.oneWayOut ? 1 : -1;
          const cx = (connector.from.x + connector.to.x) / 2, cy = (connector.from.y + connector.to.y) / 2;
          drawDirectionArrow(this.g, cx, cy, (dx / len) * dir, (dy / len) * dir, TILE_SIZE * 0.18, color);
        }
      }

      for (const seg of passage.wallSegments) {
        const color = seg.isUndefined ? disabledColor : passage.color;
        this.g
          .moveTo(seg.v0.x, seg.v0.y)
          .lineTo(seg.v1.x, seg.v1.y)
          .stroke({ width: WALL_THICKNESS, color, cap: "round", join: "round" });
      }
    }
  }

  destroy(): void {
    this.g.destroy();
  }
}
