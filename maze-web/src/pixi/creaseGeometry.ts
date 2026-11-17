import type { FieldConfig } from "../fieldConfig";
import type { SegmentDto } from "../wasm/mazeService";
import { cellAtSpacePoint, getCellGeometry } from "./cartesianCache";
import { applyTransform, invertTransform } from "./geometry/worldTransform";
import { displayTransform } from "./tessellationGeometry";

/// Distance (canvas pixels) within which a crease end snaps to a cell corner or a cell center.
export const CREASE_SNAP_RADIUS_PX = 14;

type Point = readonly [number, number];

const segmentLength = (segment: SegmentDto) =>
  segment.kind === "line"
    ? Math.hypot(segment.to[0] - segment.from[0], segment.to[1] - segment.from[1])
    : Math.abs(segment.radius * segment.sweep);

const segmentPointAt = (segment: SegmentDto, t: number): [number, number] => {
  if (segment.kind === "line") {
    return [segment.from[0] + (segment.to[0] - segment.from[0]) * t, segment.from[1] + (segment.to[1] - segment.from[1]) * t];
  }
  const angle = segment.start_angle + segment.sweep * t;
  return [segment.center[0] + segment.radius * Math.cos(angle), segment.center[1] + segment.radius * Math.sin(angle)];
};

/// The point halfway along a face's boundary (by path length, so a curved face gives a point on the curve), in
/// world units; `null` for a face without segments.
export function faceMidpoint(segments: readonly SegmentDto[]): [number, number] | null {
  const total = segments.reduce((sum, segment) => sum + segmentLength(segment), 0);
  let remaining = total / 2;
  for (const segment of segments) {
    const length = segmentLength(segment);
    if (remaining <= length || segment === segments[segments.length - 1]) {
      return segmentPointAt(segment, length > 0 ? Math.min(1, remaining / length) : 0);
    }
    remaining -= length;
  }
  return null;
}

/// The corner, face midpoint or center of the cell under `displayPoint` nearest to it, within `maxDistance`
/// (display units), in world units; `null` when none is that close. Corners are the ends of the cell's face
/// segments; a face midpoint is the point halfway along the face's boundary (`faceMidpoint`).
export function nearestCreaseAnchor(displayPoint: Point, cfg: FieldConfig, maxDistance: number): [number, number] | null {
  const toDisplay = displayTransform(cfg);
  const world = applyTransform(invertTransform(toDisplay), [displayPoint[0], displayPoint[1]]);
  const cell = cellAtSpacePoint(world, cfg);
  if (cell === null) return null;
  const geometry = getCellGeometry(cell[0], cell[1], cfg);
  const candidates: [number, number][] = [[geometry.center[0], geometry.center[1]]];
  for (const face of geometry.faces) {
    for (const segment of face.segments) {
      candidates.push([segment.from[0], segment.from[1]], [segment.to[0], segment.to[1]]);
    }
    const midpoint = faceMidpoint(face.segments);
    if (midpoint !== null) candidates.push(midpoint);
  }
  let best: [number, number] | null = null;
  let bestDistance = maxDistance;
  for (const candidate of candidates) {
    const shown = applyTransform(toDisplay, candidate);
    const distance = Math.hypot(shown[0] - displayPoint[0], shown[1] - displayPoint[1]);
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

/// The world point a crease end takes at `displayPoint`: the nearest anchor (cell corner or center) unless `free`
/// is set or none is in range, otherwise the pointer position itself.
export function creasePointAt(displayPoint: Point, cfg: FieldConfig, maxDistance: number, free: boolean): [number, number] {
  if (!free) {
    const anchor = nearestCreaseAnchor(displayPoint, cfg, maxDistance);
    if (anchor !== null) return anchor;
  }
  return applyTransform(invertTransform(displayTransform(cfg)), [displayPoint[0], displayPoint[1]]);
}

/// A crease end as the panel shows it: relative to the center of the origin cell `0:0`, in world units (a cell
/// has area 1), with the axes as drawn (x to the right, y down), so a cell center of a square field reads as a
/// whole number. Display only; the stored point stays in world units.
export function creaseLabelPoint(point: Point, cfg: FieldConfig): [number, number] {
  const toDisplay = displayTransform(cfg);
  const origin = applyTransform(toDisplay, [...getCellGeometry(0, 0, cfg).center]);
  const shown = applyTransform(toDisplay, [point[0], point[1]]);
  const unit = Math.hypot(toDisplay.a, toDisplay.b);
  return [(shown[0] - origin[0]) / unit, (shown[1] - origin[1]) / unit];
}

/// A crease end in display space (the space the canvas draws in).
export function creaseDisplayPoint(point: Point, cfg: FieldConfig): [number, number] {
  return applyTransform(displayTransform(cfg), [point[0], point[1]]);
}
