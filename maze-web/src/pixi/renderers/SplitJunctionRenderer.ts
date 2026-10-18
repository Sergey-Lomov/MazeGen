import { Container, Graphics } from "pixi.js";
import type { SplitPassage, SplitSpecialShape, SplitStyleOverride, WallStyleOverride } from "./types";
import { drawDirectionArrow } from "./wallUtils";
import { chainSegmentsAtSharedVertices } from "./WallRenderer";
import { WALL_THICKNESS } from "../renderConstants";
import { TILE_SIZE } from "../constants";
import { disabledOfNumber } from "../../styles/palette";
import { facePolyline } from "../splitFaceLayout";

const pointKeyOf = (p: { x: number; y: number }) => `${Math.round(p.x * 100)},${Math.round(p.y * 100)}`;

type Point = { x: number; y: number };
type Segment = { v0: Point; v1: Point; polyline?: readonly Point[] };

/** `segment` as consecutive straight pieces along its polyline (the chord when it has none). */
function straightPieces(segment: Segment): { v0: Point; v1: Point }[] {
  const line = facePolyline(segment);
  return line.slice(1).map((end, i) => ({ v0: line[i], v1: end }));
}

const DEFAULT_JOIN = "round" as const;

/** Every joinable path from `wallFaces` plus special shapes (`specialShapeJoinablePaths`) folded
 *  into one list — passed to `WallRenderer.render`'s `extraWalls` param (GitHub issue #319
 *  follow-up) so it can chain/join them with its own solid walls in one shared stroked pass instead
 *  of `SplitJunctionRenderer` drawing them itself into its own separate `Graphics` (a join can only
 *  render within one continuous stroke of a single `Graphics` object, never across two independent
 *  ones — see `collectSplitWallPaths`). Plain `Point[][]` geometry only, no style. */
function collectJoinablePaths(
  wallFaces: Segment[],
  specialShapes: SplitSpecialShape[],
  syntheticEnds: Point[],
): Point[][] {
  return [...wallFaces.map((f) => [...facePolyline(f)]), ...specialShapeJoinablePaths(specialShapes, syntheticEnds)];
}

/** A `"bridge"` shape's own silhouette polygon — `edge0` forward + `edge1` reversed. Used to find
 *  where an earlier-drawn bridge at the same `hex_triple_bridge` point crosses underneath this one,
 *  so that earlier bridge's own line can be cut open there instead of relying on an opaque fill to
 *  hide it (GitHub issue #319 follow-up: a fill drawn once for all shapes before any stroke can no
 *  longer sit "between" two bridges once both bridges' edges are joined into `wallFaces`'s own
 *  shared stroked pass). */
function bridgeSilhouette(shape: Extract<SplitSpecialShape, { kind: "bridge" }>): Point[] {
  return [...shape.edge0, ...[...shape.edge1].reverse()];
}

/** Point-in-polygon via the standard ray-casting parity test. */
function pointInPolygon(p: Point, polygon: Point[]): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i], pj = polygon[j];
    if (pi.y > p.y !== pj.y > p.y && p.x < ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x) hit = !hit;
  }
  return hit;
}

/** Exact intersection parameter `t` (0..1 along `a -> b`) where segment `a -> b` crosses segment
 *  `c -> d`, or `null` if they don't cross within both segments' bounds. Standard 2D
 *  segment-segment intersection via the determinant/cross-product method. */
function segmentIntersectionT(a: Point, b: Point, c: Point, d: Point): number | null {
  const rX = b.x - a.x, rY = b.y - a.y;
  const sX = d.x - c.x, sY = d.y - c.y;
  const denom = rX * sY - rY * sX;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((c.x - a.x) * sY - (c.y - a.y) * sX) / denom;
  const u = ((c.x - a.x) * rY - (c.y - a.y) * rX) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return t;
}

/** Splits `points` (a polyline) into the sub-polylines lying outside `polygon` — used to cut a
 *  `hex_triple_bridge` point's earlier bridge open exactly where a later-drawn bridge's own
 *  silhouette crosses over it (GitHub issue #319 follow-up), replacing the old opaque-fill
 *  occlusion (which stopped working once both bridges' edges were joined into one shared stroked
 *  pass with `wallFaces` — the fill, drawn once for all shapes before any stroke, could no longer
 *  sit between one bridge's own fill and the other's line). For each polyline segment, finds every
 *  exact crossing with every polygon edge, sorts those crossing points along the segment, and keeps
 *  only the parts whose midpoint falls outside the polygon.
 *
 *  Also collects into `syntheticEnds` every cut piece's own new endpoint that is *not* one of the
 *  original `points`' two outer ends — a fresh intersection point created by the cut itself (GitHub
 *  issue #319 follow-up: such a point can coincidentally round to the same `pointKeyOf` as some
 *  unrelated real tile vertex nearby, e.g. one of `polygon`'s own corners; `WallRenderer` must never
 *  give it a protruding round/square cap even if that coincidence makes it look like a genuine
 *  degree-1 free end — it was reported specifically around a `hex_triple_bridge` tile fully
 *  surrounded by corridors, where fewer competing wallFace ends around the tile made that
 *  coincidental degree-1 match more likely). */
function clipPolylineOutsidePolygon(points: Point[], polygon: Point[], syntheticEnds: Point[]): Point[][] {
  const result: Point[][] = [];
  let current: Point[] = [];
  const origStart = points[0];
  const origEnd = points[points.length - 1];
  const isOriginalEnd = (p: Point) => pointKeyOf(p) === pointKeyOf(origStart) || pointKeyOf(p) === pointKeyOf(origEnd);

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const ts = [0, 1];
    for (let j = 0, k = polygon.length - 1; j < polygon.length; k = j++) {
      const t = segmentIntersectionT(a, b, polygon[k], polygon[j]);
      if (t !== null) ts.push(t);
    }
    ts.sort((x, y) => x - y);

    if (current.length === 0 && !pointInPolygon(a, polygon)) current.push(a);
    for (let s = 1; s < ts.length; s++) {
      const t0 = ts[s - 1], t1 = ts[s];
      if (t1 - t0 < 1e-9) continue;
      const mid = { x: a.x + (b.x - a.x) * (t0 + t1) / 2, y: a.y + (b.y - a.y) * (t0 + t1) / 2 };
      const p0 = { x: a.x + (b.x - a.x) * t0, y: a.y + (b.y - a.y) * t0 };
      const p1 = { x: a.x + (b.x - a.x) * t1, y: a.y + (b.y - a.y) * t1 };
      if (pointInPolygon(mid, polygon)) {
        if (current.length > 1) result.push(current);
        current = [];
      } else {
        // A fresh outer stretch starting mid-segment (the previous interval was inside the
        // polygon, so `current` was just reset to empty) needs its own start point (`p0`, the exit
        // boundary) pushed first — otherwise the line resumes one interval late, past where it
        // actually crosses back outside (the bug this fixes: a bridge's line failed to continue on
        // the far side of a crossing bridge).
        if (current.length === 0) {
          if (!isOriginalEnd(p0)) syntheticEnds.push(p0);
          current.push(p0);
        }
        if (!isOriginalEnd(p1)) syntheticEnds.push(p1);
        current.push(p1);
      }
    }
  }
  if (current.length > 1) result.push(current);
  return result;
}

/** Every joinable path a `specialShapes` list contributes, with each `"bridge"` edge already cut
 *  open wherever a *later* bridge entry at the same `pointKey` crosses over it (GitHub issue #319
 *  follow-up) — a `hex_triple_bridge` point's earlier-drawn crossing bridge must not show through
 *  the later one's silhouette, and once both bridges' edges are joined into one shared stroked pass
 *  with `wallFaces`, an opaque fill drawn once for all shapes can no longer sit "between" them (it
 *  draws before every stroke, including the later bridge's own). Cutting the earlier line open
 *  instead works regardless of draw order. A cut piece's own new endpoints are synthetic
 *  intersection points, never real tile vertices, so they never join with anything else — exactly
 *  the same non-joining behavior an occluded stretch of line had before (it wasn't visible/joinable
 *  either). `"diagonal"` shapes are untouched (they never cross another special shape at this
 *  point). */
function specialShapeJoinablePaths(specialShapes: SplitSpecialShape[], syntheticEnds: Point[]): Point[][] {
  const bridgesByPoint = new Map<string, Extract<SplitSpecialShape, { kind: "bridge" }>[]>();
  for (const shape of specialShapes) {
    if (shape.kind !== "bridge") continue;
    const list = bridgesByPoint.get(shape.pointKey);
    if (list) list.push(shape); else bridgesByPoint.set(shape.pointKey, [shape]);
  }

  const paths: Point[][] = [];
  for (const shape of specialShapes) {
    if (shape.kind === "diagonal") {
      paths.push(shape.wallPath ?? [shape.corner0, shape.corner1]);
      continue;
    }
    const laterBridges = bridgesByPoint.get(shape.pointKey)!.slice(bridgesByPoint.get(shape.pointKey)!.indexOf(shape) + 1);
    for (const edge of [shape.edge0, shape.edge1]) {
      let pieces: Point[][] = [[...edge]];
      for (const later of laterBridges) {
        const polygon = bridgeSilhouette(later);
        pieces = pieces.flatMap((piece) => clipPolylineOutsidePolygon(piece, polygon, syntheticEnds));
      }
      paths.push(...pieces);
    }
  }
  return paths;
}

/** Public entry point for the provider pattern (GitHub issue #319 follow-up) — a feature-renderer
 *  collects a split point set's `wallFaces`/`specialShapes` geometry through this function and
 *  passes the result straight into `WallRenderer.render`'s `extraWalls`/`extraWallsNoCap` params, so
 *  special-shape lines join with ordinary walls in `WallRenderer`'s own single `Graphics` stroke
 *  pass. `SplitJunctionRenderer` itself no longer draws this geometry at all — only passages (see
 *  `render` below). `includeSpecialShapes` mirrors `SplitStyleOverride.specialShapes` (default on)
 *  so a caller that turns the dedicated bridge/diagonal look off (`VectorByWallsRenderer`'s user
 *  toggle) gets plain wallFaces-only geometry instead.
 *
 *  `noCapPoints` — every synthetic cut-point created by a `hex_triple_bridge` point's earlier-bridge
 *  clipping (GitHub issue #319 follow-up) — must be passed through to `WallRenderer`'s
 *  `extraWallsNoCap` param, not folded into `extraWalls`' plain degree count: such a point can
 *  coincidentally round to the same vertex key as some unrelated nearby wallFace end (reported
 *  specifically on a tile fully surrounded by corridors, where fewer competing ends made the
 *  coincidence more likely), which would otherwise make `WallRenderer` treat it as a genuine
 *  degree-1 free end and give it a protruding cap it must never have. */
export function collectSplitWallPaths(
  wallFaces: Segment[],
  specialShapes: SplitSpecialShape[] | undefined,
  includeSpecialShapes = true,
): { paths: Point[][]; noCapPoints: Point[] } {
  const syntheticEnds: Point[] = [];
  const paths = collectJoinablePaths(wallFaces, includeSpecialShapes ? specialShapes ?? [] : [], syntheticEnds);
  return { paths, noCapPoints: syntheticEnds };
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
      wallFaces: Segment[];
      specialShapes?: SplitSpecialShape[];
    },
    wallFaceStyleOverride?: WallStyleOverride,
    splitStyleOverride?: SplitStyleOverride,
  ): void {
    this.g.clear();

    // `wallFaces`/`specialShapes` are no longer drawn by this renderer at all (GitHub issue #319
    // follow-up) — a feature-renderer collects that geometry via `collectSplitWallPaths` and feeds
    // it to `WallRenderer.render`'s `extraWalls` param instead, so it joins with ordinary walls in
    // one shared stroke pass (a join can only render within one continuous stroke of a single
    // `Graphics`, never across this renderer's own separate one). Only passages draw here.
    //
    // Sharp style (`join: "miter"`) forces `cap: "butt"` everywhere in this renderer — a
    // `"square"`/`"round"` cap protrudes past its own endpoint (by half the line width, or a
    // curved radius), and two independently-stroked lines meeting at a non-90°/non-180° vertex
    // (any hex tile corner, 120°) have no shared `join` to reconcile that protrusion between
    // them — one line's cap visibly pokes across the other's edge instead of stopping flush at
    // the shared point. `"butt"` never protrudes, so it's the only cap safe at an angled meeting
    // point regardless of which two lines happen to meet there. Only a rounded style (`join`
    // unset or `"round"`) keeps a rounded cap.
    const isSharpStyle = wallFaceStyleOverride?.join === "miter";

    // Special-shapes toggle (GitHub issue #294, on by default) — recognized bridge/diagonal-divider
    // points are excluded from the ordinary per-node passage loop below (`specialPointKeys`); their
    // geometry is drawn by `WallRenderer` via `collectSplitWallPaths` instead. Defaults on
    // (`specialShapes` unset) so every split-drawing feature — not just `VectorByWallsRenderer`, the
    // only caller that ever passes an explicit override — skips them here automatically; pass
    // `{ specialShapes: false }` to opt out (then those points fall back to ordinary passages).
    const specialShapes = splitStyleOverride?.specialShapes !== false ? data.specialShapes ?? [] : [];
    const specialPointKeys = new Set(specialShapes.map((s) => s.pointKey));

    // Width follows `wallFaceStyleOverride` same as `wallFaces`/special shapes — only a passage's
    // own node-identity *color* stays fixed (GitHub issue #304: width was previously hardcoded to
    // `WALL_THICKNESS`, ignoring the caller's wall style entirely).
    //
    // `cap: "butt"` by default (GitHub issue #304 follow-up) — a connector's `to` end always sits
    // on a shared face-division point, same reasoning as the special-shape fix (GitHub issue #294):
    // a round or square cap would protrude past it into the neighboring segment. Its `from` end can
    // instead be a genuine free hub point (GitHub issue #421, see `hasHub` below) or a wallSegment
    // end can be a genuine free end (GitHub issue #317, see `freeEndCap` below) — both follow the
    // caller's own cap since there's nothing to protrude into there.
    const passageStrokeBase = {
      width: wallFaceStyleOverride?.width ?? WALL_THICKNESS,
      cap: "butt",
    } as const;
    // `join` only follows the caller's own style for wallSegments, and only where it can actually
    // apply — two of the *same* node's own segments meeting at a shared tile vertex under an angle
    // (adjacent faces on a hexagon, say) need a real join there, not a cap, or the outer side of
    // that angle opens into a visible gap (GitHub issue #304 follow-up). Segments are chained per
    // node via `chainSegmentsAtSharedVertices` (same helper `wallFaces` uses) so a `join` renders
    // at that interior vertex; a chained path's own two outer ends are cap-checked separately (see
    // `freeEndCap` below). Connectors never chain with anything (fan-out lines meet only at the
    // hub, radiating at unrelated angles with no shared path to join along) — `cap: "butt"` only,
    // same as before.
    const wallSegmentJoin = wallFaceStyleOverride?.join ?? DEFAULT_JOIN;
    // The free-end cap for a wallSegment end that sits on the face's own real endpoint (GitHub
    // issue #317) — that end has no neighboring sub-segment to butt against (unlike a division
    // point between two nodes sharing the same face, still always `"butt"`), so it reads as a
    // genuine free end. Sharp style still forces `"butt"` here too (same reasoning as
    // `isSharpStyle` above) — this free end can sit on a tile corner shared with a neighboring
    // special shape or another node's own segment meeting it at an angled (non-hex-perpendicular)
    // vertex, where a protruding cap would poke across that other line.
    const freeEndCap = isSharpStyle ? "butt" : "round";

    for (const passage of data.passages) {
      if (specialPointKeys.has(passage.pointKey)) continue;

      // Computed once per passage, not per segment/connector — `disabledOfNumber` round-trips
      // through hex/HSL conversion, and every share of the same node always disables to the same
      // color.
      const disabledColor = disabledOfNumber(passage.color);

      // A connector's `to` end always sits on a shared face-division point (another node's own
      // share may butt against it, or the face's own boundary is handled by wallSegments instead)
      // — always `"butt"`. Its `from` end is a hub point only when the node fans out from one
      // (`connectors.length > 1`, GitHub issue #421) — a genuine free end with nothing to butt
      // against (the hub itself is never drawn). Unlike a wallSegment's free end, this end can have
      // several other connectors of the *same* node converging on it at arbitrary angles — a
      // per-connector square-cap patch there overlaps its neighbors and pokes out as a visible
      // star/spike (GitHub issue #421 follow-up). A round patch never has that problem (it never
      // extends past its own radius no matter how many lines share the point), so the hub end
      // always gets a round patch, ignoring the caller's own free-end cap style. The 2-share
      // straight-line case (`connectors.length === 1`) has no hub — both ends are division points,
      // `"butt"` throughout, unchanged.
      const hasHub = passage.connectors.length > 1;
      for (const connector of passage.connectors) {
        const color = connector.isUndefined ? disabledColor : passage.color;
        this.g
          .moveTo(connector.from.x, connector.from.y)
          .lineTo(connector.to.x, connector.to.y)
          .stroke({ ...passageStrokeBase, color });

        if (hasHub) {
          this.g.circle(connector.from.x, connector.from.y, passageStrokeBase.width / 2).fill(color);
        }

        if (connector.oneWayOut !== undefined) {
          const dx = connector.to.x - connector.from.x, dy = connector.to.y - connector.from.y;
          const len = Math.hypot(dx, dy) || 1;
          const dir = connector.oneWayOut ? 1 : -1;
          const cx = (connector.from.x + connector.to.x) / 2, cy = (connector.from.y + connector.to.y) / 2;
          drawDirectionArrow(this.g, cx, cy, (dx / len) * dir, (dy / len) * dir, TILE_SIZE * 0.18, color);
        }
      }

      // Free-end lookup (GitHub issue #317) — points where some segment's `v0`/`v1` lands on the
      // face's own real endpoint (`atFaceStart`/`atFaceEnd`), keyed the same way
      // `chainSegmentsAtSharedVertices` keys its own vertices so a chained path's first/last point
      // can be looked up directly. A chained path's *interior* points (division points between two
      // nodes sharing a face) are never in this set, so they keep `cap: "butt"` implicitly (the
      // chain draws as one continuous stroke; only its two outer ends are ever cap-checked below).
      const freeEnds = new Set<string>();
      for (const s of passage.wallSegments) {
        if (s.atFaceStart) freeEnds.add(pointKeyOf(s.v0));
        if (s.atFaceEnd) freeEnds.add(pointKeyOf(s.v1));
      }

      const definedSegments = passage.wallSegments.filter((s) => !s.isUndefined);
      const undefinedSegments = passage.wallSegments.filter((s) => s.isUndefined);
      for (const [segs, color] of [
        [definedSegments, passage.color],
        [undefinedSegments, disabledColor],
      ] as const) {
        for (const path of chainSegmentsAtSharedVertices(segs.flatMap(straightPieces))) {
          const startsFree = freeEnds.has(pointKeyOf(path[0]));
          const endsFree = freeEnds.has(pointKeyOf(path[path.length - 1]));
          // Pixi's `stroke()` applies one `cap` to both of a path's ends. Both free (e.g. a lone
          // node's single segment spanning the whole face): draw once with the real cap directly.
          // Otherwise: draw `butt` (safe for any non-free end), then patch each individual free
          // end's own cap in separately as a standalone filled shape (same technique as
          // `VectorByCorridorsRenderer`'s free-end restore).
          const bothFree = startsFree && endsFree;
          const strokeCap = bothFree ? freeEndCap : "butt";

          this.g.moveTo(path[0].x, path[0].y);
          for (let i = 1; i < path.length; i++) this.g.lineTo(path[i].x, path[i].y);
          this.g.stroke({ ...passageStrokeBase, color, join: wallSegmentJoin, cap: strokeCap });

          if (!bothFree && freeEndCap === "round") {
            for (const [isFree, freeEnd] of [
              [startsFree, path[0]],
              [endsFree, path[path.length - 1]],
            ] as const) {
              if (!isFree) continue;
              this.g.circle(freeEnd.x, freeEnd.y, passageStrokeBase.width / 2).fill(color);
            }
          }
        }
      }
    }
  }

  destroy(): void {
    this.g.destroy();
  }
}
