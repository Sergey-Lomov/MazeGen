import { hexOrientationOf, type FieldConfig } from "../../fieldConfig";

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
// head-on, not running alongside it) — verified numerically from `hexVertices`' own vertex angles
// (GitHub issue #297 follow-up). `flat_top` hex faces run along {0°,60°,120°} so their normals are
// {30°,90°,150°}; `pointy_top` is flat_top rotated 30°, so its faces run along {30°,90°,150°} and
// its normals land back on {0°,60°,120°} — the two orientations do NOT share one axis set.
const AXES_0_60_120: Axis[] = [axisFromDeg(0), axisFromDeg(60), axisFromDeg(120)];
const AXES_30_90_150: Axis[] = [axisFromDeg(30), axisFromDeg(90), axisFromDeg(150)];

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

/** The set of candidate bend axes (unit directions, see `Axis`) an orthogonal teleport connector
 *  may bend along for a given tessellation — perpendicular to that tessellation's own cell faces,
 *  not a fixed 90° (GitHub issue #297). Square keeps the original 2-axis (horizontal/vertical)
 *  behavior; hex and triangle each get 3 axes 60° apart, while Cairo gets four oblique axes from
 *  its quarter-turned pentagon orientations; horizontal/vertical axes are intentionally omitted
 *  because they can coincide with Cairo cell edges. This is a
 *  display-only routing concern (not a tessellation concept core cares about — some tessellations
 *  have no meaningful "face axis" at all), so it lives entirely on the web side. */
export function getConnectorAxes(cfg: FieldConfig): Axis[] {
  switch (cfg.tessellation.kind) {
    case "square":
      return SQUARE_AXES;
    case "hex":
      return hexOrientationOf(cfg) === "pointy_top" ? AXES_0_60_120 : AXES_30_90_150;
    case "tri":
      return AXES_0_60_120;
    case "cairo":
      return CAIRO_AXES;
  }
}
