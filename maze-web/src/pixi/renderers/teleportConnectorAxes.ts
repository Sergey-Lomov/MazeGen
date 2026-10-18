import type { FieldConfig, TessellationKind } from "../../fieldConfig";
import { TESSELLATION_UI } from "../geometry/tessellationUi";

/** A connector bend axis, as a unit direction vector — a segment along this axis can run either
 *  way (`(ux, uy)` and `(-ux, -uy)` are the same axis). */
export type Axis = { ux: number; uy: number };

// Exact values for the axis-aligned angles (0°/90°) instead of `Math.cos`/`Math.sin`, which land on
// e.g. `6.123e-17` rather than `0` — square's routing/offset math relies on an exactly-zero
// component to keep bend/offset coordinates exact integers for axis-aligned input.
function axisFromDeg(deg: number): Axis {
  if (deg === 0) return { ux: 1, uy: 0 };
  if (deg === 90) return { ux: 0, uy: 1 };
  const rad = (deg * Math.PI) / 180;
  return { ux: Math.cos(rad), uy: Math.sin(rad) };
}

export const SQUARE_AXES: Axis[] = [axisFromDeg(0), axisFromDeg(90)];

// Bend axes must run *perpendicular* to a cell's own face directions (a connector crossing a wall
// head-on, not running alongside it) -- GitHub issue #297 follow-up. The canonical (`flat_top`)
// hex faces run along {0°,60°,120°}, so their normals are {30°,90°,150°}; the display orientation
// (`pointy_top` turns the lattice 30°) turns the axes with it, see `orientedAxes`.
const HEX_CANONICAL_AXES_DEG = [30, 90, 150];
const TRI_AXES: Axis[] = [axisFromDeg(0), axisFromDeg(60), axisFromDeg(120)];

/** `degrees` (canonical directions) turned by the display orientation of `cfg`, as undirected
 *  axes in ascending angle order. */
function orientedAxes(cfg: FieldConfig, degrees: readonly number[]): Axis[] {
  const o = TESSELLATION_UI[cfg.tessellation.kind].orientation(cfg.orientation);
  return degrees
    .map((deg) => {
      const rad = (deg * Math.PI) / 180;
      const turned = (Math.atan2(o.b * Math.cos(rad) + o.d * Math.sin(rad), o.a * Math.cos(rad) + o.c * Math.sin(rad)) * 180) / Math.PI;
      return Math.round((((turned % 180) + 180) % 180) * 1e9) / 1e9 % 180;
    })
    .sort((a, b) => a - b)
    .map(axisFromDeg);
}

// Cairo's base pentagon has edge slopes 0 and +/-atan(1/3). Its four tile orientations produce
// four useful oblique axes. The horizontal/vertical normals are deliberately excluded: on the
// Cairo lattice those directions can land exactly on another orientation's shared edge. Keep the
// angles derived from the actual 3:1 edge slope rather than treating Cairo as a regular pentagon
// (whose sides would be 72 degrees apart).
const CAIRO_SLOPE_DEG = (Math.atan(1 / 3) * 180) / Math.PI;
const CAIRO_AXES: Axis[] = [
  axisFromDeg(CAIRO_SLOPE_DEG),
  axisFromDeg(90 - CAIRO_SLOPE_DEG),
  axisFromDeg(90 + CAIRO_SLOPE_DEG),
  axisFromDeg(180 - CAIRO_SLOPE_DEG),
];

// Octagon and square faces face the eight compass directions, so the face normals give four axes
// 45 degrees apart; the display transform is a reflection, which keeps this set unchanged.
const SQUARE_OCTAGON_AXES: Axis[] = [0, 45, 90, 135].map(axisFromDeg);

// Bricks have vertical side edges and horizontal (half) top and bottom edges, so the face normals
// are the horizontal and vertical axes.
const BRICK_AXES: Axis[] = [0, 90].map(axisFromDeg);

// Hexagon and triangle faces are the sides of a flat-top hexagon, whose normals are 30, 90 and 150
// degrees; the display transform is a reflection, which keeps this set unchanged.
const TRIHEXAGONAL_AXES: Axis[] = [30, 90, 150].map(axisFromDeg);

/** The set of candidate bend axes (unit directions, see `Axis`) an orthogonal teleport connector
 *  may bend along for a given tessellation — perpendicular to that tessellation's own cell faces,
 *  not a fixed 90° (GitHub issue #297). Square keeps the original 2-axis (horizontal/vertical)
 *  behavior; hex and triangle each get 3 axes 60° apart, while Cairo gets four oblique axes from
 *  its quarter-turned pentagon orientations; horizontal/vertical axes are intentionally omitted
 *  because they can coincide with Cairo cell edges. This is a
 *  display-only routing concern (not a tessellation concept core cares about — some tessellations
 *  have no meaningful "face axis" at all), so it lives entirely on the web side. */
export function getConnectorAxes(cfg: FieldConfig): Axis[] {
  return CONNECTOR_AXES[cfg.tessellation.kind](cfg);
}

/** Connector axes per kind -- a registry lookup, not a branch on the kind. */
const CONNECTOR_AXES: Record<TessellationKind, (cfg: FieldConfig) => Axis[]> = {
  square: () => SQUARE_AXES,
  hex: (cfg) => orientedAxes(cfg, HEX_CANONICAL_AXES_DEG),
  tri: () => TRI_AXES,
  cairo: () => CAIRO_AXES,
  square_octagon: () => SQUARE_OCTAGON_AXES,
  brick: () => BRICK_AXES,
  trihexagonal: () => TRIHEXAGONAL_AXES,
  // Every edge is a unit step of the triangular lattice, so the face normals are the trihexagonal ones.
  snub_hexagonal: () => TRIHEXAGONAL_AXES,
};
