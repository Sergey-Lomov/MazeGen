import type { CorridorPoint } from "./vectorByCorridorsContour";

export type Pt = CorridorPoint;

export const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });

export const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });

export const mul = (a: Pt, scalar: number): Pt => ({ x: a.x * scalar, y: a.y * scalar });

export const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export const len = (a: Pt): number => Math.hypot(a.x, a.y);

export const norm = (a: Pt): Pt => {
  const length = len(a) || 1;
  return { x: a.x / length, y: a.y / length };
};

export const leftN = (direction: Pt): Pt => ({ x: -direction.y, y: direction.x });

export const cross = (a: Pt, b: Pt): number => a.x * b.y - a.y * b.x;

export const dot = (a: Pt, b: Pt): number => a.x * b.x + a.y * b.y;

export const angleOf = (point: Pt): number => Math.atan2(point.y, point.x);

export function pointsEqual(a: Pt, b: Pt): boolean {
  return Math.abs(a.x - b.x) <= 1e-7 && Math.abs(a.y - b.y) <= 1e-7;
}

export function polylineLength(points: readonly Pt[]): number {
  let result = 0;
  for (let index = 1; index < points.length; index++) result += len(sub(points[index], points[index - 1]));
  return result;
}

export function pointAtPolylineDistance(points: readonly Pt[], distance: number): { point: Pt; tangent: Pt } {
  if (points.length === 0) return { point: { x: 0, y: 0 }, tangent: { x: 1, y: 0 } };
  if (points.length === 1) return { point: points[0], tangent: { x: 1, y: 0 } };
  let remaining = Math.max(0, distance);
  for (let index = 1; index < points.length; index++) {
    const segment = sub(points[index], points[index - 1]);
    const segmentLength = len(segment);
    if (segmentLength <= 1e-8) continue;
    if (remaining <= segmentLength || index === points.length - 1) {
      const amount = Math.max(0, Math.min(1, remaining / segmentLength));
      return { point: add(points[index - 1], mul(segment, amount)), tangent: norm(segment) };
    }
    remaining -= segmentLength;
  }
  return { point: points[points.length - 1], tangent: norm(sub(points[points.length - 1], points[points.length - 2])) };
}

/** Distance along `points` to the polyline point nearest `target`. */
export function distanceAlongPolyline(points: readonly Pt[], target: Pt): number {
  let best = { distance: 0, gap: Number.POSITIVE_INFINITY };
  let travelled = 0;
  for (let index = 1; index < points.length; index++) {
    const segment = sub(points[index], points[index - 1]);
    const segmentLength = len(segment);
    if (segmentLength <= 1e-9) continue;
    const amount = Math.max(0, Math.min(1, dot(sub(target, points[index - 1]), segment) / (segmentLength * segmentLength)));
    const gap = len(sub(target, add(points[index - 1], mul(segment, amount))));
    if (gap < best.gap) best = { distance: travelled + amount * segmentLength, gap };
    travelled += segmentLength;
  }
  return best.distance;
}

export function polylineTangentAt(points: readonly Pt[], index: number): Pt {
  if (points.length < 2) return { x: 1, y: 0 };
  if (index <= 0) return norm(sub(points[1], points[0]));
  if (index >= points.length - 1) return norm(sub(points[points.length - 1], points[points.length - 2]));
  return norm(sub(points[index + 1], points[index - 1]));
}
