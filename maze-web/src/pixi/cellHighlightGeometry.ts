import type { Graphics } from "pixi.js";
import { drawRoundedPolygon } from "./renderers/markerShapes";
import { getCellPath, getCellVertices, type Pos } from "./tessellationGeometry";
import { tracePath } from "./geometry/pathRenderer";
import type { FieldConfig } from "../fieldConfig";
import { WALL_THICKNESS } from "./renderConstants";

/** World-space gap kept between a cell highlight and its cell boundary. */
/** Computes the world-space inset from the wall style used by the owning renderer. */
export function getCellHighlightInset(wallThickness = WALL_THICKNESS): number {
  return wallThickness / 2 + 3;
}

export type CellHighlightCornerStyle = "round" | "sharp";

/** Drops consecutive coincident vertices (a flattened curved tile repeats the point where two
 * segments meet): a zero-length edge has no normal, so its corner would stay un-inset. */
function withoutRepeats(vertices: Pos[]): Pos[] {
  const unique = vertices.filter((v, i) => {
    const previous = vertices[(i + vertices.length - 1) % vertices.length];
    return Math.hypot(v.x - previous.x, v.y - previous.y) > 1e-9;
  });
  return unique;
}

export function insetPolygon(rawVertices: Pos[], inset: number): Pos[] {
  const vertices = withoutRepeats(rawVertices);
  const area = vertices.reduce((sum, a, i) => {
    const b = vertices[(i + 1) % vertices.length];
    return sum + a.x * b.y - b.x * a.y;
  }, 0);
  const ccw = area >= 0;
  const lines = vertices.map((a, i) => {
    const b = vertices[(i + 1) % vertices.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const length = Math.hypot(dx, dy) || 1;
    const nx = ccw ? -dy / length : dy / length;
    const ny = ccw ? dx / length : -dx / length;
    return { point: { x: a.x + nx * inset, y: a.y + ny * inset }, direction: { x: dx, y: dy } };
  });
  return vertices.map((_, i) => {
    const previous = lines[(i + vertices.length - 1) % vertices.length];
    const next = lines[i];
    const denominator = previous.direction.x * next.direction.y - previous.direction.y * next.direction.x;
    if (Math.abs(denominator) < 1e-6) return next.point;
    const dx = next.point.x - previous.point.x, dy = next.point.y - previous.point.y;
    const t = (dx * next.direction.y - dy * next.direction.x) / denominator;
    return { x: previous.point.x + previous.direction.x * t, y: previous.point.y + previous.direction.y * t };
  });
}

/** Draws a cell highlight inset from every edge. Scaling around the polygon centroid by the
 * apothem-derived factor gives a constant edge gap for square, hexagonal, triangular, and custom
 * convex tessellations alike. Rounded corners are applied after the inset, so the highlight never
 * grows back over a wall or touches a neighbouring highlight. */
export function drawCellHighlight(
  g: Graphics,
  vertices: Pos[],
  color: number,
  alpha: number,
  inset = getCellHighlightInset(),
  cornerStyle: CellHighlightCornerStyle = "round",
  borderWidth = inset > 0 ? 3 : 0,
): void {
  if (vertices.length < 3) return;
  if (inset === 0) {
    const points = vertices.flatMap(({ x, y }) => [x, y]);
    g.poly(points).fill({ color, alpha });
    if (borderWidth > 0) g.poly(points).stroke({ color, alpha: 1, width: borderWidth });
    return;
  }

  const points = insetPolygon(vertices, inset).flatMap(({ x, y }) => [x, y]);
  const effectiveInset = inset;
  const apothem = Math.min(...vertices.map((_, i) => Math.hypot(
    vertices[(i + 1) % vertices.length].x - vertices[i].x,
    vertices[(i + 1) % vertices.length].y - vertices[i].y,
  ))) / 2;
  if (cornerStyle === "round") {
    drawRoundedPolygon(g, points, Math.min(Math.abs(effectiveInset) * 0.9, apothem * 0.18));
  } else {
    g.poly(points);
  }
  g.fill({ color, alpha });
  if (borderWidth > 0) {
    if (cornerStyle === "round") {
      drawRoundedPolygon(g, points, Math.min(Math.abs(effectiveInset) * 0.9, apothem * 0.18));
    } else {
      g.poly(points);
    }
    g.stroke({ color, alpha: 1, width: borderWidth });
  }
}

/** Adds an inset/rounded contour to the current Graphics path without filling or stroking it. */
export function drawCellHighlightPath(g: Graphics, vertices: Pos[], inset = getCellHighlightInset(), cornerStyle: CellHighlightCornerStyle = "round"): void {
  if (vertices.length < 3) return;
  if (inset === 0) {
    g.poly(vertices.flatMap(({ x, y }) => [x, y]));
    return;
  }
  const insetVertices = insetPolygon(vertices, inset);
  const points = insetVertices.flatMap(({ x, y }) => [x, y]);
  const minEdgeHalf = Math.min(...insetVertices.map((_, i) => Math.hypot(
    insetVertices[(i + 1) % insetVertices.length].x - insetVertices[i].x,
    insetVertices[(i + 1) % insetVertices.length].y - insetVertices[i].y,
  ))) / 2;
  if (cornerStyle === "round") drawRoundedPolygon(g, points, Math.min(Math.abs(inset) * 0.9, minEdgeHalf * 0.18));
  else g.poly(points);
}

/** `drawCellHighlight` for the cell `(x, y)`: an uninset highlight follows the cell's exact path
 * (arcs stay arcs); an inset one works on the flattened polygon. */
export function drawCellHighlightAt(
  g: Graphics,
  x: number,
  y: number,
  cfg: FieldConfig,
  color: number,
  alpha: number,
  inset = getCellHighlightInset(),
  cornerStyle: CellHighlightCornerStyle = "round",
  borderWidth = inset > 0 ? 3 : 0,
): void {
  if (inset !== 0) {
    drawCellHighlight(g, getCellVertices(x, y, cfg), color, alpha, inset, cornerStyle, borderWidth);
    return;
  }
  const path = getCellPath(x, y, cfg);
  tracePath(g, path);
  g.closePath().fill({ color, alpha });
  if (borderWidth > 0) {
    tracePath(g, path);
    g.closePath().stroke({ color, alpha: 1, width: borderWidth });
  }
}
