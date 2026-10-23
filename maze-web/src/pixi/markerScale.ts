import type { FieldConfig } from "../fieldConfig";
import type { MarkerShape } from "./renderers/types";
import { circlePolygonPoints, markerPolygonPoints } from "./renderers/markerShapes";
import { getCellArea, getFieldAreaStats } from "./cartesianCache";
import { getCellVertices, nearestCellCoord, pointInPolygon, type Pos } from "./tessellationGeometry";

/** Marker size adaptation (GitHub issue #819): markers scale with the area of the cell they sit in,
 *  `S = (A_cell / A_mean)^(k / 2)`, `k` being the adaptation strength in [0, 1]. The setting is only
 *  offered when the field's cell areas differ noticeably. */
export const AREA_SPREAD_THRESHOLD = 1.2;

/** Whether the field's largest cell is noticeably larger than its smallest one. */
export function hasCellAreaSpread(cfg: FieldConfig): boolean {
  const stats = getFieldAreaStats(cfg);
  return stats !== null && stats.max / stats.min > AREA_SPREAD_THRESHOLD;
}

/** Scale factor of a cell of `area`, before the fit cap. `1` for a cell of the mean area. */
export function areaScaleFactor(area: number, meanArea: number, adaptation: number): number {
  return (area / meanArea) ** (adaptation / 2);
}

/** A marker's geometry as it competes for space in its cell. `radius` is the fill radius (the part
 *  that scales); `outset` is the border plus gap ring around it (the part that does not);
 *  `adaptation` is the marker kind's own size-adaptation fraction. */
export interface MarkerFootprint {
  pos: readonly [number, number];
  shape: MarkerShape;
  radius: number;
  outset: number;
  /** Whether `outset` scales with the factor too (a marker scaled as a whole, content included). */
  outsetScales?: boolean;
  adaptation: number;
}

/** Resolves the size factor of a marker by its position and its kind's own adaptation. Markers of
 *  different kinds in one cell may therefore get different factors. */
export interface MarkerScaler {
  factorAt(pos: readonly [number, number], adaptation: number): number;
  /** Largest factor any marker got (at least 1) — for clearances that must hold for every marker. */
  readonly maxFactor: number;
}

export const NO_MARKER_SCALING: MarkerScaler = { factorAt: () => 1, maxFactor: 1 };

const DISTANCE_EPS = 1e-9;
const FIT_BISECTION_STEPS = 16;

function distanceToSegment(p: Pos, a: Pos, b: Pos): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Whether `footprint` drawn at `factor` times its radius lies inside `polygon`, its border/gap
 *  ring included — checked on the actual shape outline at the actual position. */
function fitsInCell(footprint: MarkerFootprint, factor: number, polygon: Pos[]): boolean {
  const [cx, cy] = footprint.pos;
  const r = footprint.radius * factor;
  const outline = footprint.shape === "circle" ? circlePolygonPoints(cx, cy, r) : markerPolygonPoints(footprint.shape, cx, cy, r);
  for (let i = 0; i < outline.length; i += 2) {
    const p = { x: outline[i], y: outline[i + 1] };
    if (!pointInPolygon(p, polygon)) return false;
    for (let j = 0; j < polygon.length; j++) {
      if (distanceToSegment(p, polygon[j], polygon[(j + 1) % polygon.length]) < footprint.outset * (footprint.outsetScales ? factor : 1) - DISTANCE_EPS) return false;
    }
  }
  return true;
}

/** The factor `footprint` may grow to in a cell that asks for `wanted`: `wanted` itself when it
 *  fits, else the largest factor in [1, wanted] that does (never below 1 — a marker that already
 *  overflows at its configured size is not shrunk by this setting). Shrinking never needs a check. */
function cappedFactor(footprint: MarkerFootprint, wanted: number, polygon: Pos[]): number {
  if (wanted <= 1 || footprint.radius <= 0) return wanted;
  if (fitsInCell(footprint, wanted, polygon)) return wanted;
  let lo = 1;
  let hi = wanted;
  for (let i = 0; i < FIT_BISECTION_STEPS; i++) {
    const mid = (lo + hi) / 2;
    if (fitsInCell(footprint, mid, polygon)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Builds the scaler for one render pass from every marker footprint on the drawn floor. Identity
 *  when the field has no area spread or no footprint asks for adaptation. */
export function buildMarkerScaler(cfg: FieldConfig, footprints: readonly MarkerFootprint[]): MarkerScaler {
  const stats = getFieldAreaStats(cfg);
  if (stats === null || stats.max / stats.min <= AREA_SPREAD_THRESHOLD || footprints.every((f) => f.adaptation <= 0)) return NO_MARKER_SCALING;

  const wantedOf = (cell: readonly [number, number], adaptation: number) => areaScaleFactor(getCellArea(cell[0], cell[1], cfg), stats.mean, adaptation);
  const keyOf = (pos: readonly [number, number], adaptation: number) => `${pos[0]},${pos[1]},${adaptation}`;
  // Footprints sharing a position and an adaptation share one factor — the tightest of their caps.
  const fitted = new Map<string, number>();
  let maxFactor = 1;
  for (const footprint of footprints) {
    if (footprint.adaptation <= 0) continue;
    const cell = nearestCellCoord(footprint.pos[0], footprint.pos[1], cfg);
    const capped = cappedFactor(footprint, wantedOf(cell, footprint.adaptation), getCellVertices(cell[0], cell[1], cfg));
    const key = keyOf(footprint.pos, footprint.adaptation);
    fitted.set(key, Math.min(fitted.get(key) ?? capped, capped));
  }
  for (const factor of fitted.values()) maxFactor = Math.max(maxFactor, factor);

  return {
    maxFactor,
    factorAt(pos, adaptation) {
      if (adaptation <= 0) return 1;
      return fitted.get(keyOf(pos, adaptation)) ?? Math.min(wantedOf(nearestCellCoord(pos[0], pos[1], cfg), adaptation), maxFactor);
    },
  };
}
