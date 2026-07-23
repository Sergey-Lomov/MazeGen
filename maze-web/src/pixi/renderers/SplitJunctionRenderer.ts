import { Container, Graphics } from "pixi.js";
import type { SplitPassage } from "./types";
import { drawOneWayTriangle } from "./wallUtils";
import { WALL_THICKNESS } from "../renderConstants";

/** Draws a split point's independent passages (GitHub issue #223) — for each node, its own share
 *  of the wall on every geometric face it connects across (`wallSegments`), plus `connectors`
 *  linking those shares together: a straight line between the two shares for a 2-connection node,
 *  or one line per share from a small circle point otherwise (never drawn itself). All in the
 *  node's own color — see `buildSplitPassages`. */
export class SplitJunctionRenderer {
  private readonly g: Graphics;

  constructor(container: Container) {
    this.g = new Graphics();
    container.addChild(this.g);
  }

  render(data: { passages: SplitPassage[] }): void {
    this.g.clear();
    for (const passage of data.passages) {
      for (const connector of passage.connectors) {
        this.g
          .moveTo(connector.from.x, connector.from.y)
          .lineTo(connector.to.x, connector.to.y)
          .stroke({ width: WALL_THICKNESS, color: passage.color, cap: "round", join: "round" });
      }

      for (const seg of passage.wallSegments) {
        this.g
          .moveTo(seg.v0.x, seg.v0.y)
          .lineTo(seg.v1.x, seg.v1.y)
          .stroke({ width: WALL_THICKNESS, color: passage.color, cap: "round", join: "round" });

        if (seg.oneWayDir) {
          drawOneWayTriangle(this.g, seg.center.x, seg.center.y, seg.oneWayDir.dx, seg.oneWayDir.dy, passage.color);
        }
      }
    }
  }

  destroy(): void {
    this.g.destroy();
  }
}
