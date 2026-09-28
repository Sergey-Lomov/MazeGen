import type { Graphics } from "pixi.js";
import { TILE_SIZE } from "../constants";
import { canvas } from "../colorTokens";
import { getSharedEdgeSegment, getCellCenter } from "../tessellationGeometry";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import { drawRoundedPolygon } from "./markerShapes";
import { WALL_THICKNESS } from "../renderConstants";

/** Shared style knobs for every one-way indicator pattern (`drawOneWayTriangle`/`Chevron`/`Arrow`)
 *  — GitHub issue #292 (renamed border->gap in #302 follow-up, consistent with the marker/connector
 *  gap convention: this is a floor-colored separation gap, not a real border). `color` defaults to
 *  `canvas.edge.oneWay` (the indicator's own fill/stroke color), `gapColor`/`gapWidth` draw a gap
 *  ring around the indicator (a filled triangle's own stroke; a second, wider stroke pass
 *  underneath a line-based pattern's stroke so the gap reads as an outline around the whole shape)
 *  — `gapWidth: 0` (falls back to no gap) skips the second pass entirely. `join`/`cap` are pixi
 *  stroke options applied to the pattern's own strokes (never to a filled triangle's fill, only its
 *  gap stroke). */
export type OneWayDrawStyle = {
  pattern?: "triangle" | "chevron" | "arrow";
  color?: number;
  gapColor?: number;
  gapWidth?: number;
  size?: number;
  /** Line thickness for chevron/arrow's own stroke — independent of `size` (the indicator's
   *  geometric scale). Has no effect on `drawOneWayTriangle`, a filled shape with no line stroke
   *  of its own. GitHub issue #292 follow-up: size used to also drive stroke thickness. */
  thickness?: number;
  join?: "round" | "miter";
  cap?: "round" | "square";
  /** Chevron opening half-width, world units — independent of `size` (GitHub issue #312, "Vector
   *  by corridors" one-way settings need length and width as separate knobs, unlike this pattern's
   *  original single-`size`-drives-both convention). Defaults to `size * 1.4` (the pre-#312
   *  opening), so every existing caller (`VectorByWallsRenderer`'s plain single chevron) is
   *  unaffected. Only read by `drawOneWayChevron`. */
  width?: number;
};

// The normal map's own one-way indicator size (`WallRenderer`'s default, no override) — shared
// so any caller wanting to visually match the map's marker (e.g. the wall-highlight overlays)
// reads the same constant instead of re-hardcoding `TILE_SIZE * 0.3`.
export const MAP_ONE_WAY_SIZE = TILE_SIZE * 0.3;
/** Extra room around a boundary highlight, per side. Shared by one-way, wall and passage
 * highlights so their transverse span uses the same visual clearance. */
export const BOUNDARY_HIGHLIGHT_PADDING = 5;
/** Span for post-edit wall/passage highlights: the actual wall plus the same per-side padding. */
export const WALL_HIGHLIGHT_SPAN = WALL_THICKNESS + BOUNDARY_HIGHLIGHT_PADDING * 2;

/** Stable, direction-independent key for one shared cell boundary. */
export function cellBoundaryKey(a: [number, number], b: [number, number]): string {
  const first = `${a[0]},${a[1]}`;
  const second = `${b[0]},${b[1]}`;
  return first < second ? `${first}|${second}` : `${second}|${first}`;
}

function resolvedSize(style?: OneWayDrawStyle): number {
  return style?.size ?? TILE_SIZE * 0.18;
}

function resolvedThickness(style?: OneWayDrawStyle): number {
  return style?.thickness ?? 4;
}

/** Full transverse span occupied by one wall one-way indicator, including its gap. Keep this
 * geometry-derived so overlays can follow the live renderer style instead of using a cell-sized
 * fallback or a viewport-specific constant. */
export function oneWayIndicatorSpan(style?: OneWayDrawStyle): number {
  const size = resolvedSize(style);
  const gap = style?.gapWidth ?? 0;
  switch (style?.pattern ?? "triangle") {
    case "triangle":
      // drawOneWayTriangle uses an equilateral triangle with R = 2/3 * size.
      return Math.sqrt(3) * (2 / 3) * size + gap + BOUNDARY_HIGHLIGHT_PADDING * 2;
    case "chevron":
      return 2 * (style?.width ?? size * 1.4) + resolvedThickness(style) + gap * 2 + BOUNDARY_HIGHLIGHT_PADDING * 2;
    case "arrow":
      return size + resolvedThickness(style) + gap * 2 + BOUNDARY_HIGHLIGHT_PADDING * 2;
    default:
      return 0;
  }
}

// Draws a direction arrow triangle centered at (cx, cy), pointing in (dx, dy) direction.
// size controls the scale. Color defaults to canvas.edge.oneWay.
export function drawDirectionArrow(
  g: Graphics,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
  size: number,
  color?: number,
  alpha = 1,
): void {
  const px = -dy;
  const py = dx;
  const tipX = cx + dx * size;
  const tipY = cy + dy * size;
  const baseX = cx - dx * size * 0.5;
  const baseY = cy - dy * size * 0.5;
  g.poly([
    tipX, tipY,
    baseX + px * size * 0.6, baseY + py * size * 0.6,
    baseX - px * size * 0.6, baseY - py * size * 0.6,
  ]);
  g.fill({ color: color ?? canvas.edge.oneWay, alpha });
}

// Draws a filled equilateral triangle one-way indicator, optionally gapped, centered at
// (cx, cy), pointing in (dx, dy) direction. Uses `Graphics.roundPoly` (a regular-polygon
// primitive with a per-corner rounding radius) rather than a hand-built `poly` path, since
// `join` on an open/closed stroke never rounds a filled shape's own corners — only `roundPoly`'s
// `corner` radius can (GitHub issue #292 follow-up: "join doesn't round the triangle itself").
export function drawOneWayTriangle(
  g: Graphics,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
  style?: OneWayDrawStyle,
): void {
  const size = resolvedSize(style) * 0.5;
  const length = size * 2; // full tip-to-base length
  // roundPoly's circumradius R relates to an equilateral triangle's tip-to-base length as
  // length = 1.5*R (tip sits at +R from the centroid, base at -0.5*R). Solved so the tip lands at
  // +0.65*length and the base at -0.35*length from the wall's midpoint (cx, cy) — GitHub issue
  // #292 follow-up ("tip 65% ahead, base 35% behind").
  const radius = (2 / 3) * length;
  const centroidOffset = 0.65 * length - radius;
  const centroidX = cx + dx * centroidOffset;
  const centroidY = cy + dy * centroidOffset;
  const rotation = Math.atan2(dy, dx) + Math.PI / 2; // roundPoly's first vertex points "up" at rotation 0
  const corner = (style?.join ?? "round") === "round" ? size * 0.3 : 0;

  const outline = () => g.roundPoly(centroidX, centroidY, radius, 3, corner, rotation);
  outline().fill(style?.color ?? canvas.edge.oneWay);
  if (style?.gapWidth) {
    // `alignment: 0` (outside) so the gap grows outward only — the triangle's own size never
    // shrinks as gapWidth increases (GitHub issue #292 follow-up).
    outline().stroke({
      width: style.gapWidth,
      color: style.gapColor ?? canvas.floor.default,
      join: style.join ?? "round",
      alignment: 0,
    });
  }
}

/** Draws a hovered one-way issue's wall highlight — the shared wall segment between `from`/`to`
 *  (cell coords) plus the map's own gapless direction triangle on top (GitHub issue #377 follow-
 *  up) — shared by `IssueHighlightOverlay` and `DebugRefHighlightOverlay`, which otherwise
 *  duplicated this exact stroke+triangle sequence. Returns `false` (drawing nothing) when the two
 *  cells aren't tessellation-adjacent, so the caller can fall back to a plain line. */
export function drawOneWayWallHighlight(
  g: Graphics,
  from: [number, number],
  to: [number, number],
  cfg: TessellationConfig,
  color: number,
  width: number,
  alpha: number,
): boolean {
  const seg = getSharedEdgeSegment(from, to, cfg);
  if (!seg) return false;

  g.moveTo(seg.v0.x, seg.v0.y);
  g.lineTo(seg.v1.x, seg.v1.y);
  g.stroke({ width, color, alpha });

  const fromCenter = getCellCenter(from[0], from[1], cfg);
  const toCenter = getCellCenter(to[0], to[1], cfg);
  const tdx = toCenter.x - fromCenter.x;
  const tdy = toCenter.y - fromCenter.y;
  const len = Math.sqrt(tdx * tdx + tdy * tdy);
  if (len > 0) {
    const cx = (seg.v0.x + seg.v1.x) / 2;
    const cy = (seg.v0.y + seg.v1.y) / 2;
    drawOneWayTriangle(g, cx, cy, tdx / len, tdy / len, { color, size: MAP_ONE_WAY_SIZE });
  }
  return true;
}

/** Clamps a boundary highlight's tangential inset to `[0, edgeLength / 2 - 1]` — never negative (an
 *  outward inset isn't supported by this style, see GitHub issue #627) and never past the edge's
 *  own midpoint (leaves at least 2px of span so the quad can't collapse or cross over itself on a
 *  short edge). Exported standalone so the clamp math is unit-testable without reconstructing a
 *  `Graphics` mock's draw calls. */
export function clampBoundaryInset(inset: number, edgeLength: number): number {
  return Math.max(0, Math.min(inset, edgeLength / 2 - 1));
}

/** Draws a filled quad centred on a shared cell boundary. Its span can follow the rendered marker,
 * while the same construction still works for square, hexagonal and triangular tiles.
 *
 * `inset` (GitHub issue #627) shrinks the quad along the edge's own tangent only — the
 * perpendicular span (`spanWidth`) is untouched — so the highlight pulls back from the two
 * corners where this boundary meets its neighbors, matching the inward gap cell/region
 * highlights already use, without narrowing the highlight across the wall. Clamped so it never
 * collapses the quad to zero or negative length. */
export function drawCellBoundaryHighlight(
  g: Graphics,
  from: [number, number],
  to: [number, number],
  cfg: TessellationConfig,
  color: number,
  fillAlpha = 0.25,
  borderWidth = 3,
  spanWidth?: number,
  inset = 0,
): boolean {
  const seg = getSharedEdgeSegment(from, to, cfg);
  if (!seg) return false;
  const fromCenter = getCellCenter(from[0], from[1], cfg);
  const toCenter = getCellCenter(to[0], to[1], cfg);
  const dx = toCenter.x - fromCenter.x;
  const dy = toCenter.y - fromCenter.y;
  const centerDistance = Math.hypot(dx, dy);
  const edgeLength = Math.hypot(seg.v1.x - seg.v0.x, seg.v1.y - seg.v0.y);
  if (centerDistance === 0 || edgeLength === 0) return false;

  // Derive the normal from the shared edge itself. The centre-to-centre vector is only used to
  // choose the normal's sign; for triangular/hexagonal coordinates it is not guaranteed to be
  // exactly perpendicular to the edge after the tessellation transform.
  const tx = (seg.v1.x - seg.v0.x) / edgeLength;
  const ty = (seg.v1.y - seg.v0.y) / edgeLength;
  let nx = -ty;
  let ny = tx;
  if (nx * dx + ny * dy < 0) {
    nx = -nx;
    ny = -ny;
  }
  const halfWidth = (spanWidth ?? centerDistance) / 2;
  const clampedInset = clampBoundaryInset(inset, edgeLength);
  const v0x = seg.v0.x + tx * clampedInset, v0y = seg.v0.y + ty * clampedInset;
  const v1x = seg.v1.x - tx * clampedInset, v1y = seg.v1.y - ty * clampedInset;
  const insetLength = Math.hypot(v1x - v0x, v1y - v0y);
  const points = [
    v0x + nx * halfWidth, v0y + ny * halfWidth,
    v1x + nx * halfWidth, v1y + ny * halfWidth,
    v1x - nx * halfWidth, v1y - ny * halfWidth,
    v0x - nx * halfWidth, v0y - ny * halfWidth,
  ];
  const cornerRadius = Math.min(insetLength, centerDistance) * 0.18;
  drawRoundedPolygon(g, points, cornerRadius);
  g.fill({ color, alpha: fillAlpha });
  if (borderWidth > 0) {
    drawRoundedPolygon(g, points, cornerRadius);
    g.stroke({ color, alpha: 1, width: borderWidth, join: "round" });
  }
  return true;
}

/** Splits `edges` into wall-drawn ones (GitHub issue #377's `asWall`, e.g. a flagged
 *  `invalid_one_way`) and line-drawn ones, drawing every wall edge as the shared boundary rect
 *  between its two cells into `g` — shared by `IssueHighlightOverlay` (Analytics) and
 *  `DebugRefHighlightOverlay` (debug-tree, GitHub issue #619 follow-up) so both draw the exact
 *  same wall style instead of two independently-drifting copies. A wall edge whose endpoints
 *  aren't tessellation-adjacent (no shared boundary to draw, e.g. a cross-floor edge) falls back
 *  to a line, same as a non-wall edge. Returns the edges that still need line rendering, in the
 *  same shape as `edges` (generic over the id type — `number` for Analytics, `bigint` for
 *  debug-tree). */
export function splitWallAndLineEdges<TId>(
  g: Graphics,
  edges: { from: TId; to: TId; asWall: boolean }[],
  cellOf: (id: TId) => [number, number] | undefined,
  cfg: TessellationConfig,
  color: number,
  fillAlpha = 0.25,
  borderWidth = 3,
  spanWidth?: number,
  inset = 0,
): { from: TId; to: TId }[] {
  const lineEdges: { from: TId; to: TId }[] = [];
  const drawnBoundaryEdges = new Set<string>();
  for (const edge of edges) {
    if (!edge.asWall) {
      lineEdges.push(edge);
      continue;
    }
    const fromCell = cellOf(edge.from);
    const toCell = cellOf(edge.to);
    if (!fromCell || !toCell) {
      lineEdges.push(edge);
      continue;
    }
    const key = cellBoundaryKey(fromCell, toCell);
    if (drawnBoundaryEdges.has(key)) continue;
    const drew = drawCellBoundaryHighlight(g, fromCell, toCell, cfg, color, fillAlpha, borderWidth, spanWidth, inset);
    if (drew) drawnBoundaryEdges.add(key);
    else lineEdges.push(edge);
  }
  return lineEdges;
}

// Draws a "chevron" one-way indicator (two open strokes forming a shallow `>` shape) centered at
// (cx, cy), pointing in (dx, dy) direction — an outline alternative to the filled
// `drawOneWayTriangle`. A wider gap pass is drawn first (when gapWidth is set), the main
// stroke on top, so the gap reads as an outline around the whole shape.
export function drawOneWayChevron(
  g: Graphics,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
  style?: OneWayDrawStyle,
): void {
  const size = resolvedSize(style);
  const px = -dy;
  const py = dx;
  const tipX = cx + dx * size;
  const tipY = cy + dy * size;
  const backX = cx - dx * size * 0.6;
  const backY = cy - dy * size * 0.6;
  const width = style?.width ?? size * 1.4; // shallow: twice the original opening angle
  const color = style?.color ?? canvas.edge.oneWay;
  const strokeWidth = resolvedThickness(style);
  const join = style?.join ?? "round";
  const cap = style?.cap ?? "round";

  const path = (g: Graphics) =>
    g.moveTo(backX + px * width, backY + py * width)
      .lineTo(tipX, tipY)
      .lineTo(backX - px * width, backY - py * width);

  if (style?.gapWidth) {
    path(g).stroke({ width: strokeWidth + style.gapWidth * 2, color: style.gapColor ?? canvas.floor.default, cap, join });
  }
  path(g).stroke({ width: strokeWidth, color, cap, join });
}

/** Center-to-center distance between two adjacent chevrons in a row — `length + gap + strokeWidth`,
 *  the stroke's own `strokeWidth` folded into the spacing so a thick stroke doesn't visibly eat
 *  into a small `gap` (GitHub issue #312 follow-up). Shared by `drawOneWayChevronRow`'s row-spacing
 *  math and `computeVectorByCorridorsWarnings`' overflow check so neither can drift from what
 *  actually gets drawn. */
export function chevronRowStep(length: number, gap: number, strokeWidth: number): number {
  return length + gap + strokeWidth;
}

/** Draws `count` chevrons in a row along the `(dx, dy)` direction, evenly spaced around
 *  `(cx, cy)` — the "Vector by corridors" one-way indicator (GitHub issue #312), a break in the
 *  corridor line rendered as a series of chevrons instead of `WallRenderer`'s single indicator.
 *  Reuses `drawOneWayChevron` per chevron rather than a hand-rolled multi-chevron path, so both
 *  callers draw the exact same chevron shape/gap handling. `length` is passed straight through as
 *  `drawOneWayChevron`'s own `size`. `gap` is the actual visible gap in pixels between two adjacent
 *  chevrons' own stroked edges — see `chevronRowStep`. The whole row is centered on `(cx, cy)`,
 *  mirroring `drawOneWayChevron`'s own single-indicator centering. */
export function drawOneWayChevronRow(
  g: Graphics,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
  count: number,
  length: number,
  gap: number,
  style?: OneWayDrawStyle,
): void {
  const step = chevronRowStep(length, gap, resolvedThickness(style));
  const rowLength = (count - 1) * step;
  const startOffset = -rowLength / 2;
  for (let i = 0; i < count; i++) {
    const offset = startOffset + i * step;
    drawOneWayChevron(g, cx + dx * offset, cy + dy * offset, dx, dy, { ...style, size: length });
  }
}

/** Computes the square-cap "restore" patch geometry for a `cap: "butt"`-stroked path's own free
 *  end (GitHub issue #314 follow-up, moved here from `VectorByCorridorsRenderer` in #317 for
 *  `SplitJunctionRenderer` to share too — pure geometry, no feature-renderer state) — pure
 *  function, directly unit-testable rather than only reachable through mocked-`Graphics`
 *  draw-call assertions. `freeEnd` is the path's own free endpoint, `neighbor` is the adjacent
 *  path point one step in from it (used only to find the path's own local direction there),
 *  `width` is the stroke's own full width. Returns the four corners of a `width`-square cap
 *  extending `width/2` past `freeEnd` along the path's own direction, in draw order (a simple
 *  quad, not self-intersecting) — the same shape Pixi's own `cap: "square"` would draw at an
 *  ordinary (non-`butt`) stroke end. */
export function computeSquareCapPatch(
  freeEnd: { x: number; y: number },
  neighbor: { x: number; y: number },
  width: number,
): [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }] {
  const dx = freeEnd.x - neighbor.x, dy = freeEnd.y - neighbor.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const half = width / 2;
  const nx = -uy * half, ny = ux * half;
  const tipX = freeEnd.x + ux * half, tipY = freeEnd.y + uy * half;
  return [
    { x: freeEnd.x + nx, y: freeEnd.y + ny },
    { x: tipX + nx, y: tipY + ny },
    { x: tipX - nx, y: tipY - ny },
    { x: freeEnd.x - nx, y: freeEnd.y - ny },
  ];
}

// Draws a one-way indicator as a line with a line-only arrowhead (two short strokes, no filled
// triangle) at its tip, centered at (cx, cy), pointing in (dx, dy) direction — a thin-line
// alternative to the filled `drawOneWayTriangle`. A wider gap pass is drawn first (when
// gapWidth is set), the main stroke on top, so the gap reads as an outline around the whole
// shape (shaft + arrowhead).
export function drawOneWayArrow(
  g: Graphics,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
  style?: OneWayDrawStyle,
): void {
  const size = resolvedSize(style);
  const tailX = cx - dx * size;
  const tailY = cy - dy * size;
  const tipX = cx + dx * size;
  const tipY = cy + dy * size;
  const px = -dy;
  const py = dx;
  const headSize = size * 0.5;
  const headBackX = tipX - dx * headSize;
  const headBackY = tipY - dy * headSize;
  const color = style?.color ?? canvas.edge.oneWay;
  const strokeWidth = resolvedThickness(style);
  const join = style?.join ?? "round";
  const cap = style?.cap ?? "round";

  const path = (g: Graphics) =>
    // Shaft ends at the arrowhead's own base (not the tip) — otherwise a square cap makes the
    // shaft's flat end protrude past the narrower arrowhead strokes (GitHub issue #292 follow-up).
    g.moveTo(tailX, tailY).lineTo(headBackX, headBackY)
      .moveTo(headBackX + px * headSize * 0.6, headBackY + py * headSize * 0.6).lineTo(tipX, tipY)
      .lineTo(headBackX - px * headSize * 0.6, headBackY - py * headSize * 0.6);

  if (style?.gapWidth) {
    path(g).stroke({ width: strokeWidth + style.gapWidth * 2, color: style.gapColor ?? canvas.floor.default, cap, join });
  }
  path(g).stroke({ width: strokeWidth, color, cap, join });
}
