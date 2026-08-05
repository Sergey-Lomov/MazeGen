import { Container, Graphics } from "pixi.js";
import type { SplitPassage, SplitSpecialShape, SplitStyleOverride, WallStyleOverride } from "./types";
import { drawDirectionArrow } from "./wallUtils";
import { chainSegmentsAtSharedVertices } from "./WallRenderer";
import { WALL_THICKNESS } from "../renderConstants";
import { TILE_SIZE } from "../constants";
import { canvas } from "../colorTokens";
import { disabledOfNumber } from "../../styles/palette";

const DEFAULT_JOIN = "round" as const;

/** Draws one degree-4 split point recognized as a "bridge" or "diagonal divider" (GitHub issue
 *  #294) instead of the generic per-node segment/connector reading — drawn in the plain wall
 *  style (`strokeOpts`, same one `wallFaces` uses), never a node's own identity color: neither
 *  shape reads as "belonging" to one node over the other.
 *
 *  `"diagonal"`: a single straight wall segment, `corner0 -> corner1`, the tile's real opposite
 *  corners.
 *
 *  `"bridge"`: the through corridor draws nothing (an ordinary passage straight across the tile);
 *  the cross corridor draws as its own two 4-point polyline edges (`edge0`/`edge1`) — the classic
 *  card-map bridge silhouette (full width, narrows in, flat deck, widens back out). */
function drawSplitSpecialShape(
  g: Graphics,
  shape: SplitSpecialShape,
  strokeOpts: { width: number; color: number; cap: "round" | "square" | "butt"; join: "round" | "miter" },
): void {
  if (shape.kind === "diagonal") {
    g.moveTo(shape.corner0.x, shape.corner0.y).lineTo(shape.corner1.x, shape.corner1.y).stroke(strokeOpts);
    return;
  }

  for (const edge of [shape.edge0, shape.edge1]) {
    g.moveTo(edge[0].x, edge[0].y);
    for (let i = 1; i < edge.length; i++) g.lineTo(edge[i].x, edge[i].y);
    g.stroke(strokeOpts);
  }
}

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

  render(
    data: {
      passages: SplitPassage[];
      wallFaces: { v0: { x: number; y: number }; v1: { x: number; y: number } }[];
      specialShapes?: SplitSpecialShape[];
    },
    wallFaceStyleOverride?: WallStyleOverride,
    splitStyleOverride?: SplitStyleOverride,
  ): void {
    this.g.clear();

    // wallFaces draw first, special shapes (below) draw on top — GitHub issue #294 follow-up: an
    // ordinary neighboring wall's own join (miter/square, e.g. at a T-junction or tile corner) can
    // protrude slightly into this tile past the shared face boundary; drawing a special shape
    // afterward, with its own end sitting exactly on that boundary, paints over the protrusion
    // instead of being cut off by it. The reverse order (special shape first, walls after) is
    // what previously caused the walls' own corners to visibly poke past the special shape's line.
    if (!wallFaceStyleOverride) {
      // No caller-supplied style: keep every other feature-renderer's exact prior per-segment
      // draw — see the matching guard in WallRenderer.render for why.
      for (const face of data.wallFaces) {
        this.g
          .moveTo(face.v0.x, face.v0.y)
          .lineTo(face.v1.x, face.v1.y)
          .stroke({ width: WALL_THICKNESS, color: canvas.wall.default, cap: "round", join: "round" });
      }
    } else {
      const wallFaceStrokeOpts = {
        width: wallFaceStyleOverride.width ?? WALL_THICKNESS,
        color: wallFaceStyleOverride.color ?? canvas.wall.default,
        cap: wallFaceStyleOverride.cap ?? "round",
        join: wallFaceStyleOverride.join ?? DEFAULT_JOIN,
      } as const;
      for (const path of chainSegmentsAtSharedVertices(data.wallFaces)) {
        this.g.moveTo(path[0].x, path[0].y);
        for (let i = 1; i < path.length; i++) this.g.lineTo(path[i].x, path[i].y);
        this.g.stroke(wallFaceStrokeOpts);
      }
    }

    // Special-shapes toggle (GitHub issue #294, on by default) — recognized bridge/diagonal-divider
    // points draw via `drawSplitSpecialShape` instead of their ordinary per-node passages; every
    // other point is unaffected. `specialPointKeys` lets the ordinary passage loop below skip them.
    // Drawn in the same plain wall style `wallFaces` uses (never a node's own identity color).
    // Defaults on (`specialShapes` unset) so every split-drawing feature — not just
    // `VectorByWallsRenderer`, the only caller that ever passes an explicit override — gets the
    // dedicated bridge/diagonal look automatically; pass `{ specialShapes: false }` to opt out.
    const specialShapes = splitStyleOverride?.specialShapes !== false ? data.specialShapes ?? [] : [];
    const specialPointKeys = new Set(specialShapes.map((s) => s.pointKey));
    // `cap: "butt"` (never `"round"`/`"square"`, regardless of the caller's own wall style) — every
    // special shape's own free ends (the diagonal's two corners, a bridge edge's two cross-face
    // ends) sit exactly on the tile's own face boundary already; a round or square cap would
    // protrude past it into the neighboring tile/wall. `join` still follows the caller's own style
    // (a bridge edge's internal taper/deck corners aren't on any tile boundary, so a miter join
    // there reads as a real sharp corner with no protrusion issue).
    const specialShapeStrokeOpts = {
      width: wallFaceStyleOverride?.width ?? WALL_THICKNESS,
      color: wallFaceStyleOverride?.color ?? canvas.wall.default,
      cap: "butt",
      join: wallFaceStyleOverride?.join ?? DEFAULT_JOIN,
    } as const;
    for (const shape of specialShapes) drawSplitSpecialShape(this.g, shape, specialShapeStrokeOpts);

    // Width follows `wallFaceStyleOverride` same as `wallFaces`/special shapes — only a passage's
    // own node-identity *color* stays fixed (GitHub issue #304: width was previously hardcoded to
    // `WALL_THICKNESS`, ignoring the caller's wall style entirely).
    //
    // `cap: "butt"` at a path's own free ends (GitHub issue #304 follow-up), never the caller's
    // own cap — every wallSegment/connector free end sits exactly on a shared point (a
    // face-division boundary, a tile corner, or the hub point several other nodes' own connectors
    // also meet at), same reasoning as the special-shape fix (GitHub issue #294): a round or
    // square cap would protrude past that shared point into the neighboring segment/wall.
    const passageStrokeBase = {
      width: wallFaceStyleOverride?.width ?? WALL_THICKNESS,
      cap: "butt",
    } as const;
    // `join` only follows the caller's own style for wallSegments, and only where it can actually
    // apply — two of the *same* node's own segments meeting at a shared tile vertex under an angle
    // (adjacent faces on a hexagon, say) need a real join there, not a `butt` cap, or the outer
    // side of that angle opens into a visible gap (GitHub issue #304 follow-up). Segments are
    // chained per node via `chainSegmentsAtSharedVertices` (same helper `wallFaces` uses) so a
    // `join` renders at that interior vertex; `cap: "butt"` still applies at each chained path's
    // own two free ends (a boundary shared with another node/wallFace, never colinear with this
    // node's own next segment). Connectors never chain with anything (fan-out lines meet only at
    // the hub, radiating at unrelated angles with no shared path to join along) — `cap: "butt"`
    // only, same as before.
    const wallSegmentJoin = wallFaceStyleOverride?.join ?? DEFAULT_JOIN;

    for (const passage of data.passages) {
      if (specialPointKeys.has(passage.pointKey)) continue;

      // Computed once per passage, not per segment/connector — `disabledOfNumber` round-trips
      // through hex/HSL conversion, and every share of the same node always disables to the same
      // color.
      const disabledColor = disabledOfNumber(passage.color);

      for (const connector of passage.connectors) {
        const color = connector.isUndefined ? disabledColor : passage.color;
        this.g
          .moveTo(connector.from.x, connector.from.y)
          .lineTo(connector.to.x, connector.to.y)
          .stroke({ ...passageStrokeBase, color });

        if (connector.oneWayOut !== undefined) {
          const dx = connector.to.x - connector.from.x, dy = connector.to.y - connector.from.y;
          const len = Math.hypot(dx, dy) || 1;
          const dir = connector.oneWayOut ? 1 : -1;
          const cx = (connector.from.x + connector.to.x) / 2, cy = (connector.from.y + connector.to.y) / 2;
          drawDirectionArrow(this.g, cx, cy, (dx / len) * dir, (dy / len) * dir, TILE_SIZE * 0.18, color);
        }
      }

      const definedSegments = passage.wallSegments.filter((s) => !s.isUndefined);
      const undefinedSegments = passage.wallSegments.filter((s) => s.isUndefined);
      for (const [segs, color] of [
        [definedSegments, passage.color],
        [undefinedSegments, disabledColor],
      ] as const) {
        for (const path of chainSegmentsAtSharedVertices(segs)) {
          this.g.moveTo(path[0].x, path[0].y);
          for (let i = 1; i < path.length; i++) this.g.lineTo(path[i].x, path[i].y);
          this.g.stroke({ ...passageStrokeBase, color, join: wallSegmentJoin });
        }
      }
    }
  }

  destroy(): void {
    this.g.destroy();
  }
}
