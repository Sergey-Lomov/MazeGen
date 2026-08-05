import { Container, Graphics } from "pixi.js";
import type { WallEdge, WallStyleOverride, OneWayStyleOverride } from "./types";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { getCellVertices, getNeighborData } from "../tessellationGeometry";
import { drawOneWayTriangle, drawOneWayChevron, drawOneWayArrow } from "./wallUtils";
import { WALL_THICKNESS } from "../renderConstants";
import { canvas } from "../colorTokens";
import { TILE_SIZE } from "../constants";

const WALL_STYLES = {
  solid:      { color: canvas.wall.default,     cap: "round" as const, join: "round" as const },
  faint:      { color: canvas.wall.undecided,   cap: "round" as const, join: "round" as const },
  background: { color: canvas.stage.background, cap: "round" as const, join: "round" as const },
};

type Point = { x: number; y: number };
type Segment = { v0: Point; v1: Point };

/** A `join` (round/miter) only renders where two segments meet inside the same continuous stroked
 *  path — separate `moveTo`/`stroke` calls at a shared vertex draw independent caps, not a join
 *  (GitHub issue #291 follow-up: "corner join does nothing"). Chains wall segments into polylines
 *  wherever exactly two segments meet at a vertex (an ordinary corridor corner) so the join shows
 *  up there; a vertex touched by any other segment count (T-junctions, isolated dead-ends) is left
 *  as a path endpoint, where `cap` applies instead — both maze-cell shapes with such junctions and
 *  plain corners are common, so neither case is treated as an error. */
export function chainSegmentsAtSharedVertices(segs: Segment[]): Point[][] {
  const key = (p: Point) => `${Math.round(p.x * 100)},${Math.round(p.y * 100)}`;
  const byVertex = new Map<string, { seg: Segment; end: 0 | 1 }[]>();
  for (const seg of segs) {
    for (const end of [0, 1] as const) {
      const p = end === 0 ? seg.v0 : seg.v1;
      const k = key(p);
      const list = byVertex.get(k);
      if (list) list.push({ seg, end });
      else byVertex.set(k, [{ seg, end }]);
    }
  }

  const used = new Set<Segment>();
  const paths: Point[][] = [];
  for (const seg of segs) {
    if (used.has(seg)) continue;
    used.add(seg);
    const path: Point[] = [seg.v0, seg.v1];

    // Extend forward from path's current tail — only when that vertex's total degree is exactly 2
    // (a plain corner), checked against the full unfiltered list so a T-junction's third branch
    // still blocks chaining even after one of its other two segments has already been consumed
    // by an earlier iteration (processing order must not change the result).
    for (;;) {
      const tail = path[path.length - 1];
      const atVertex = byVertex.get(key(tail))!;
      if (atVertex.length !== 2) break;
      const next = atVertex.find((t) => !used.has(t.seg))?.seg;
      if (!next) break;
      used.add(next);
      path.push(key(next.v0) === key(tail) ? next.v1 : next.v0);
    }
    // Extend backward from path's current head, same rule.
    for (;;) {
      const head = path[0];
      const atVertex = byVertex.get(key(head))!;
      if (atVertex.length !== 2) break;
      const prev = atVertex.find((t) => !used.has(t.seg))?.seg;
      if (!prev) break;
      used.add(prev);
      path.unshift(key(prev.v0) === key(head) ? prev.v1 : prev.v0);
    }

    paths.push(path);
  }
  return paths;
}

export class WallRenderer {
  private readonly g: Graphics;

  constructor(container: Container) {
    this.g = new Graphics();
    container.addChild(this.g);
  }

  render(
    data: { edges: WallEdge[] },
    cfg?: TessellationConfig,
    solidStyleOverride?: WallStyleOverride,
    oneWayStyleOverride?: OneWayStyleOverride,
  ): void {
    this.g.clear();
    if (!cfg) return;

    const solidSegs: { v0: { x: number; y: number }; v1: { x: number; y: number } }[] = [];
    const oneWays: { cx: number; cy: number; dx: number; dy: number }[] = [];
    for (const edge of data.edges) {
      const seg = this.getEdgeSegment(edge, cfg);
      if (!seg) continue;

      if (edge.style === "solid") {
        solidSegs.push(seg);
      } else {
        const styleBase = WALL_STYLES[edge.style];
        this.g.moveTo(seg.v0.x, seg.v0.y).lineTo(seg.v1.x, seg.v1.y).stroke({ width: WALL_THICKNESS, ...styleBase });
      }

      if (edge.oneWayDir) {
        oneWays.push({
          cx: (seg.v0.x + seg.v1.x) / 2,
          cy: (seg.v0.y + seg.v1.y) / 2,
          dx: edge.oneWayDir.dx,
          dy: edge.oneWayDir.dy,
        });
      }
    }

    // Walls are stroked before one-way indicators (drawn further below) so the indicator always
    // renders on top of the wall it sits on, not underneath it.
    if (!solidStyleOverride) {
      // No caller-supplied style: keep every other feature-renderer's exact prior per-segment
      // draw (independent round caps, no join) — vertex-chaining below is only meaningful once a
      // caller actually asks for a `join`/`cap`, so it must not change GenerationRenderer's,
      // PostEditRenderer's, PresetConnectionsRenderer's, or MazeOverlayRenderer's rendering.
      for (const seg of solidSegs) {
        this.g.moveTo(seg.v0.x, seg.v0.y).lineTo(seg.v1.x, seg.v1.y).stroke({ width: WALL_THICKNESS, ...WALL_STYLES.solid });
      }
    } else {
      const strokeOpts = {
        width: solidStyleOverride.width ?? WALL_THICKNESS,
        color: solidStyleOverride.color ?? WALL_STYLES.solid.color,
        join: solidStyleOverride.join ?? WALL_STYLES.solid.join,
        cap: solidStyleOverride.cap ?? WALL_STYLES.solid.cap,
      };
      for (const path of chainSegmentsAtSharedVertices(solidSegs)) {
        this.g.moveTo(path[0].x, path[0].y);
        for (let i = 1; i < path.length; i++) this.g.lineTo(path[i].x, path[i].y);
        this.g.stroke(strokeOpts);
      }
    }

    for (const { cx, cy, dx, dy } of oneWays) {
      this.drawOneWayIndicator(cx, cy, dx, dy, oneWayStyleOverride);
    }
  }

  private drawOneWayIndicator(
    cx: number,
    cy: number,
    dx: number,
    dy: number,
    override?: OneWayStyleOverride,
  ): void {
    if (!override) {
      // Default look (GenerationRenderer/PostEditRenderer/PresetConnectionsRenderer/
      // MazeOverlayRenderer, none of which pass an override): a triangle gapped in the floor
      // color — GitHub issue #292 follow-up.
      drawOneWayTriangle(this.g, cx, cy, dx, dy, { gapColor: canvas.floor.default, gapWidth: 3, size: TILE_SIZE * 0.3 });
      return;
    }
    const style = {
      color: override.color,
      gapColor: override.gapColor,
      gapWidth: override.gapWidth,
      size: override.size,
      thickness: override.thickness,
      join: override.join,
      cap: override.cap,
    };
    switch (override.pattern) {
      case "chevron":
        drawOneWayChevron(this.g, cx, cy, dx, dy, style);
        break;
      case "arrow":
        drawOneWayArrow(this.g, cx, cy, dx, dy, style);
        break;
      default:
        drawOneWayTriangle(this.g, cx, cy, dx, dy, style);
    }
  }

  private getEdgeSegment(
    edge: WallEdge,
    cfg: TessellationConfig,
  ): { v0: { x: number; y: number }; v1: { x: number; y: number } } | null {
    const [ax, ay] = edge.a;
    const [bx, by] = edge.b;
    const less = ax < bx || (ax === bx && ay < by);
    const [fx, fy] = less ? [ax, ay] : [bx, by];
    const [tx, ty] = less ? [bx, by] : [ax, ay];

    const verts = getCellVertices(fx, fy, cfg);
    if (!verts) return null;

    const { offsets, edgeVerts } = getNeighborData(cfg, fx, fy);
    const dx = tx - fx;
    const dy = ty - fy;
    for (let i = 0; i < offsets.length; i++) {
      if (offsets[i][0] === dx && offsets[i][1] === dy) {
        const [vi, vj] = edgeVerts[i];
        return { v0: verts[vi], v1: verts[vj] };
      }
    }
    return null;
  }

  destroy(): void {
    this.g.destroy();
  }
}
