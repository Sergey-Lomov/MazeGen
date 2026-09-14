import { Container, Graphics } from "pixi.js";
import type { WallEdge, WallStyleOverride, OneWayStyleOverride, RandomWallColorMode } from "./types";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { getSharedEdgeSegment } from "../tessellationGeometry";
import { drawOneWayTriangle, drawOneWayChevron, drawOneWayArrow, computeSquareCapPatch } from "./wallUtils";
import { WALL_THICKNESS } from "../renderConstants";
import { canvas } from "../colorTokens";
import { DEFAULT_MAZE_RENDER_STYLE } from "../defaultMazeRenderStyle";

const WALL_STYLES = {
  solid:      { color: DEFAULT_MAZE_RENDER_STYLE.wall.color, cap: DEFAULT_MAZE_RENDER_STYLE.wall.cap, join: DEFAULT_MAZE_RENDER_STYLE.wall.join },
  faint:      { color: canvas.wall.undecided,   cap: "round" as const, join: "round" as const },
  background: { color: canvas.stage.background, cap: "round" as const, join: "round" as const },
};

function channel(color: number, shift: number): number {
  return (color >> shift) & 0xff;
}

function relativeLuminance(color: number): number {
  const linear = (value: number) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(channel(color, 16)) + 0.7152 * linear(channel(color, 8)) + 0.0722 * linear(channel(color, 0));
}

function contrastRatio(a: number, b: number): number {
  const light = Math.max(relativeLuminance(a), relativeLuminance(b));
  const dark = Math.min(relativeLuminance(a), relativeLuminance(b));
  return (light + 0.05) / (dark + 0.05);
}

function hslToColor(hue: number, saturation: number, lightness: number): number {
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs((hue / 60) % 2 - 1));
  const m = lightness - c / 2;
  const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] :
    hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return (Math.round((r + m) * 255) << 16) | (Math.round((g + m) * 255) << 8) | Math.round((b + m) * 255);
}

export function randomContrastingWallColor(index: number, floorColor: number, backgroundColor: number): number {
  const hue = (index * 137.508) % 360;
  const candidates = [0.28, 0.4, 0.6, 0.72].map((lightness) => hslToColor(hue, 0.78, lightness));
  return candidates.reduce((best, color) => {
    const score = Math.min(contrastRatio(color, floorColor), contrastRatio(color, backgroundColor));
    const bestScore = Math.min(contrastRatio(best, floorColor), contrastRatio(best, backgroundColor));
    return score > bestScore ? color : best;
  });
}

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
    randomColorMode: RandomWallColorMode = "off",
    randomColorContext?: { floorColor: number; backgroundColor: number },
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
    // `extraWallsNoCap` — the subset of those paths' endpoints that must not get a protruding
    // square cap even if they otherwise look like a genuine free end (synthetic clip-cut points,
    // see `SplitJunctionRenderer.collectSplitWallPaths`'s `noCapPoints`). Round Vector-by-walls
    // caps intentionally remain rounded at these endpoints.
    if (!solidStyleOverride && !extraWalls?.length && randomColorMode !== "per_segment") {
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
      const noCapKeys = new Set((extraWallsNoCap ?? []).map(pointKeyOf));
      if (randomColorMode === "per_segment" && randomColorContext) {
        let segmentIndex = 0;
        for (const path of allPaths) {
          for (let i = 1; i < path.length; i++) {
            const segmentColor = randomContrastingWallColor(segmentIndex++, randomColorContext.floorColor, randomColorContext.backgroundColor);
            const cap = realCap === "round" || (
              !noCapKeys.has(pointKeyOf(path[i - 1])) && !noCapKeys.has(pointKeyOf(path[i]))
            ) ? realCap : "butt";
            this.g.moveTo(path[i - 1].x, path[i - 1].y).lineTo(path[i].x, path[i].y)
              .stroke({ width, color: segmentColor, join, cap });
          }
        }
        for (const { cx, cy, dx, dy } of oneWays) {
          this.drawOneWayIndicator(cx, cy, dx, dy, oneWayStyleOverride);
        }
        return;
      }
      const chainedPaths = chainPathsAtSharedVertices(allPaths);
      // A chained path's own two outer ends land either on a genuine free end (degree 1 — nothing
      // else meets it there) or a T-/triple-junction (degree >= 3 — other unrelated paths converge
      // at an angle). For the miter/square style, a protruding cap has no shared join with those
      // other paths and pokes across them, visibly creating a star bulge at triple-points (GitHub
      // issue #319 follow-up). The rounded Vector-by-walls style intentionally keeps round caps at
      // every endpoint. `"butt"` never protrudes, so square-ended paths still patch each individual
      // free end separately. Synthetic no-cap points remain protected for square caps, while round
      // caps intentionally follow the Vector-by-walls setting's "all endpoints" behavior.
      const degrees = vertexDegrees(allPaths);
      // Synthetic clip-cut points (GitHub issue #319 follow-up, `SplitJunctionRenderer`'s
      // `noCapPoints`) can coincidentally round to the same vertex key as an unrelated real
      // wallFace end nearby, making them look like a genuine degree-1 free end when they aren't
      // one — never give those a protruding square cap regardless of what `degrees` says about
      // them. Round Vector-by-walls caps intentionally remain rounded.
      for (const [pathIndex, path] of chainedPaths.entries()) {
        const startFree = degrees.get(pointKeyOf(path[0])) === 1 && !noCapKeys.has(pointKeyOf(path[0]));
        const endFree = degrees.get(pointKeyOf(path[path.length - 1])) === 1 && !noCapKeys.has(pointKeyOf(path[path.length - 1]));
        const bothFree = startFree && endFree;
        const strokeCap = realCap === "round" || bothFree ? realCap : "butt";

        this.g.moveTo(path[0].x, path[0].y);
        for (let i = 1; i < path.length; i++) this.g.lineTo(path[i].x, path[i].y);
        const strokeColor = randomColorMode === "per_pass" && randomColorContext
          ? randomContrastingWallColor(pathIndex, randomColorContext.floorColor, randomColorContext.backgroundColor)
          : color;
        this.g.stroke({ width, color: strokeColor, join, cap: strokeCap });

        if (!bothFree && realCap === "square") {
          for (const [isFree, p, neighbor] of [
            [startFree, path[0], path[1]],
            [endFree, path[path.length - 1], path[path.length - 2]],
          ] as const) {
            if (!isFree) continue;
            const [p0, p1, p2, p3] = computeSquareCapPatch(p, neighbor, width);
            this.g.moveTo(p0.x, p0.y).lineTo(p1.x, p1.y).lineTo(p2.x, p2.y).lineTo(p3.x, p3.y).closePath().fill(strokeColor);
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
    return getSharedEdgeSegment(edge.a, edge.b, cfg);
  }

  destroy(): void {
    this.g.destroy();
  }
}
