import { Container, Graphics } from "pixi.js";
import type { WallEdge, WallStyleOverride, OneWayStyleOverride } from "./types";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { getCellVertices, getNeighborData } from "../tessellationGeometry";
import { drawOneWayTriangle, drawOneWayChevron, drawOneWayArrow, computeSquareCapPatch } from "./wallUtils";
import { WALL_THICKNESS } from "../renderConstants";
import { canvas } from "../colorTokens";
import { DEFAULT_MAZE_RENDER_STYLE } from "../defaultMazeRenderStyle";

const WALL_STYLES = {
  solid:      { color: DEFAULT_MAZE_RENDER_STYLE.wall.color, cap: DEFAULT_MAZE_RENDER_STYLE.wall.cap, join: DEFAULT_MAZE_RENDER_STYLE.wall.join },
  faint:      { color: canvas.wall.undecided,   cap: "round" as const, join: "round" as const },
  background: { color: canvas.stage.background, cap: "round" as const, join: "round" as const },
};

type Point = { x: number; y: number };
type Segment = { v0: Point; v1: Point };

const pointKeyOf = (p: Point) => `${Math.round(p.x * 100)},${Math.round(p.y * 100)}`;

/** A `join` (round/miter) only renders where two paths meet inside the same continuous stroked
 *  path — separate `moveTo`/`stroke` calls at a shared vertex draw independent caps, not a join
 *  (GitHub issue #291 follow-up: "corner join does nothing"; generalized from 2-point segments to
 *  arbitrary polylines in GitHub issue #319 follow-up, so a multi-point shape like a bridge's own
 *  taper/deck edge can join with an ordinary wall at its own outer vertex without being split into
 *  sub-segments first — splitting it just moves the same no-shared-join seam to the new sub-segment
 *  boundary). Chains paths into longer polylines wherever exactly two path-ends meet at a vertex (an
 *  ordinary corridor corner) so the join shows up there; a vertex touched by any other path-end
 *  count (T-junctions, isolated dead-ends) is left as a path endpoint, where `cap` applies instead —
 *  both maze-cell shapes with such junctions and plain corners are common, so neither case is
 *  treated as an error. Only a path's own two outer ends (`points[0]`/`points[length - 1]`) are
 *  ever checked for chaining; interior points never participate in the shared-vertex degree count. */
export function chainPathsAtSharedVertices(paths: Point[][]): Point[][] {
  const byVertex = new Map<string, { path: Point[]; end: 0 | 1 }[]>();
  for (const path of paths) {
    for (const end of [0, 1] as const) {
      const p = end === 0 ? path[0] : path[path.length - 1];
      const k = pointKeyOf(p);
      const list = byVertex.get(k);
      if (list) list.push({ path, end });
      else byVertex.set(k, [{ path, end }]);
    }
  }

  const used = new Set<Point[]>();
  const chained: Point[][] = [];
  for (const path of paths) {
    if (used.has(path)) continue;
    used.add(path);
    const points: Point[] = [...path];

    // Extend forward from path's current tail — only when that vertex's total degree is exactly 2
    // (a plain corner), checked against the full unfiltered list so a T-junction's third branch
    // still blocks chaining even after one of its other two paths has already been consumed by an
    // earlier iteration (processing order must not change the result).
    for (;;) {
      const tail = points[points.length - 1];
      const atVertex = byVertex.get(pointKeyOf(tail))!;
      if (atVertex.length !== 2) break;
      const next = atVertex.find((t) => !used.has(t.path))?.path;
      if (!next) break;
      used.add(next);
      const nextPoints = pointKeyOf(next[0]) === pointKeyOf(tail) ? next : [...next].reverse();
      points.push(...nextPoints.slice(1));
    }
    // Extend backward from path's current head, same rule.
    for (;;) {
      const head = points[0];
      const atVertex = byVertex.get(pointKeyOf(head))!;
      if (atVertex.length !== 2) break;
      const prev = atVertex.find((t) => !used.has(t.path))?.path;
      if (!prev) break;
      used.add(prev);
      const prevPoints = pointKeyOf(prev[prev.length - 1]) === pointKeyOf(head) ? prev : [...prev].reverse();
      points.unshift(...prevPoints.slice(0, -1));
    }

    chained.push(points);
  }
  return chained;
}

/** `chainPathsAtSharedVertices` specialized to plain 2-point segments — kept for callers that only
 *  ever deal in segments (`VectorByCorridorsRenderer`, `SplitJunctionRenderer`'s passage segments). */
export function chainSegmentsAtSharedVertices(segs: Segment[]): Point[][] {
  return chainPathsAtSharedVertices(segs.map((s) => [s.v0, s.v1]));
}

/** Total path-end count touching each vertex across `paths` — same counting `chainPathsAtSharedVertices`
 *  does internally, exposed separately so a caller can tell a chained path's own outer end apart:
 *  degree 1 is a genuine free end (nothing else meets it, a rounded/square cap is safe there),
 *  degree >= 3 is a triple/T-junction (multiple unrelated lines converge at an angle, so any
 *  protruding cap pokes across one of the others — GitHub issue #319 follow-up: this was previously
 *  left at the caller's own cap unconditionally, visible as a "star" bulge at triple-points). Degree
 *  2 never appears as a chained path's own endpoint — `chainPathsAtSharedVertices` always extends
 *  through those. */
function vertexDegrees(paths: Point[][]): Map<string, number> {
  const degrees = new Map<string, number>();
  for (const path of paths) {
    for (const end of [0, 1] as const) {
      const k = pointKeyOf(end === 0 ? path[0] : path[path.length - 1]);
      degrees.set(k, (degrees.get(k) ?? 0) + 1);
    }
  }
  return degrees;
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
    extraWalls?: Point[][],
    extraWallsNoCap?: Point[],
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
    //
    // `extraWalls` (GitHub issue #319 follow-up) — joinable paths from an external source (a
    // feature-renderer's own split-junction special shapes/wallFaces, see
    // `SplitJunctionRenderer.collectSplitWallPaths`) that must chain and join with this renderer's
    // own solid walls exactly as if they were native `solidSegs` — a split bridge/diagonal shape's
    // line meeting an ordinary wall at an angled hex vertex has no shared Pixi `join` otherwise,
    // visibly poking across it. `WallRenderer` treats them as opaque geometry: it never needs to
    // know they came from a split shape. Always chained (even with no `solidStyleOverride`) since a
    // caller only ever passes `extraWalls` when it wants this join behavior for them.
    // `extraWallsNoCap` — the subset of those paths' endpoints that must never get a protruding
    // cap even if they otherwise look like a genuine free end (synthetic clip-cut points, see
    // `SplitJunctionRenderer.collectSplitWallPaths`'s `noCapPoints`).
    if (!solidStyleOverride && !extraWalls?.length) {
      // No caller-supplied style and nothing external to join with: keep every other
      // feature-renderer's exact prior per-segment draw (independent round caps, no join) —
      // vertex-chaining below is only meaningful once a caller actually asks for a `join`/`cap` or
      // supplies `extraWalls`, so it must not change GenerationRenderer's rendering by default.
      for (const seg of solidSegs) {
        this.g.moveTo(seg.v0.x, seg.v0.y).lineTo(seg.v1.x, seg.v1.y).stroke({ width: WALL_THICKNESS, ...WALL_STYLES.solid });
      }
    } else {
      const width = solidStyleOverride?.width ?? WALL_THICKNESS;
      const color = solidStyleOverride?.color ?? WALL_STYLES.solid.color;
      const join = solidStyleOverride?.join ?? WALL_STYLES.solid.join;
      const realCap = solidStyleOverride?.cap ?? WALL_STYLES.solid.cap;
      const allPaths = [...solidSegs.map((s) => [s.v0, s.v1]), ...(extraWalls ?? [])];
      const chainedPaths = chainPathsAtSharedVertices(allPaths);
      // A chained path's own two outer ends land either on a genuine free end (degree 1 — nothing
      // else meets it there) or a T-/triple-junction (degree >= 3 — other unrelated paths converge
      // at an angle). A protruding cap (`"round"`/`"square"`) has no shared join with those other
      // paths and pokes across them (GitHub issue #319 follow-up: visible as a "star" bulge at
      // triple-points). `"butt"` never protrudes, so every path draws with it unconditionally, then
      // each individual free end gets its own real cap patched in separately (same technique
      // `SplitJunctionRenderer`'s wallSegment free-end handling already uses).
      const degrees = vertexDegrees(allPaths);
      // Synthetic clip-cut points (GitHub issue #319 follow-up, `SplitJunctionRenderer`'s
      // `noCapPoints`) can coincidentally round to the same vertex key as an unrelated real
      // wallFace end nearby, making them look like a genuine degree-1 free end when they aren't
      // one — never give those a protruding cap regardless of what `degrees` says about them.
      const noCapKeys = new Set((extraWallsNoCap ?? []).map(pointKeyOf));
      for (const path of chainedPaths) {
        const startFree = degrees.get(pointKeyOf(path[0])) === 1 && !noCapKeys.has(pointKeyOf(path[0]));
        const endFree = degrees.get(pointKeyOf(path[path.length - 1])) === 1 && !noCapKeys.has(pointKeyOf(path[path.length - 1]));
        const bothFree = startFree && endFree;
        const strokeCap = bothFree ? realCap : "butt";

        this.g.moveTo(path[0].x, path[0].y);
        for (let i = 1; i < path.length; i++) this.g.lineTo(path[i].x, path[i].y);
        this.g.stroke({ width, color, join, cap: strokeCap });

        if (!bothFree && (realCap === "round" || realCap === "square")) {
          for (const [isFree, p, neighbor] of [
            [startFree, path[0], path[1]],
            [endFree, path[path.length - 1], path[path.length - 2]],
          ] as const) {
            if (!isFree) continue;
            if (realCap === "round") {
              this.g.circle(p.x, p.y, width / 2).fill(color);
            } else {
              const [p0, p1, p2, p3] = computeSquareCapPatch(p, neighbor, width);
              this.g.moveTo(p0.x, p0.y).lineTo(p1.x, p1.y).lineTo(p2.x, p2.y).lineTo(p3.x, p3.y).closePath().fill(color);
            }
          }
        }
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
    const effective = override ?? DEFAULT_MAZE_RENDER_STYLE.oneWay;
    const style = {
      color: effective.color,
      gapColor: effective.gapColor,
      gapWidth: effective.gapWidth,
      size: effective.size,
      thickness: effective.thickness,
      join: effective.join,
      cap: effective.cap,
    };
    switch (effective.pattern) {
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
