import type { FieldConfig } from "../fieldConfig";
import type { WireFoldEnd } from "../wasm/types";
import { getCellGeometry, GEOMETRY_TOLERANCE } from "./cartesianCache";
import { applyTransform } from "./geometry/worldTransform";
import { flattenSegments } from "./geometry/pathFlatten";
import { displayTransform } from "./tessellationGeometry";

/// A face's open polyline in display space (the space the canvas draws in), both ends included.
export function faceDisplayPolyline(end: WireFoldEnd, cfg: FieldConfig): [number, number][] {
  const geometry = getCellGeometry(end.cell[0], end.cell[1], cfg);
  const face = geometry.faces[end.face_idx];
  if (!face) return [];
  const transform = displayTransform(cfg);
  return flattenSegments(face.segments, GEOMETRY_TOLERANCE).map((point) => applyTransform(transform, point));
}

function distanceToPolyline(point: readonly [number, number], polyline: readonly [number, number][]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < polyline.length; i++) {
    const [ax, ay] = polyline[i];
    const [bx, by] = polyline[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - ax) * dx + (point[1] - ay) * dy) / lengthSquared));
    best = Math.min(best, Math.hypot(point[0] - (ax + t * dx), point[1] - (ay + t * dy)));
  }
  return best;
}

export interface ContourFaceHit {
  contour: number;
  face: number;
}

/// The boundary face nearest to a display-space point, or `null` when none lies within
/// `maxDistance`. Faces are compared by the distance to their drawn polyline.
export function nearestContourFace(
  contours: readonly (readonly WireFoldEnd[])[],
  point: readonly [number, number],
  cfg: FieldConfig,
  maxDistance: number,
): ContourFaceHit | null {
  let best: ContourFaceHit | null = null;
  let bestDistance = maxDistance;
  contours.forEach((faces, contour) => {
    faces.forEach((end, face) => {
      const distance = distanceToPolyline(point, faceDisplayPolyline(end, cfg));
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = { contour, face };
      }
    });
  });
  return best;
}

type Polyline = [number, number][];

const near = (a: readonly [number, number], b: readonly [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/// Joins polylines that touch end to end into one, reversing any whose stored direction disagrees.
/// A face's own direction is the cell template's, not the contour's, so each piece is oriented by
/// which of its ends meets the chain.
function joinChain(pieces: Polyline[]): Polyline {
  if (pieces.length === 1) return pieces[0];
  const [first, second] = pieces;
  const ends = (p: Polyline) => [p[0], p[p.length - 1]] as const;
  let best = { distance: Infinity, flipFirst: false };
  for (const [i, a] of ends(first).entries()) {
    for (const b of ends(second)) {
      const distance = near(a, b);
      // The first piece must end where the second begins, so its end is index 1 unless flipped.
      if (distance < best.distance) best = { distance, flipFirst: i === 0 };
    }
  }
  let chain = best.flipFirst ? [...first].reverse() : [...first];
  for (const piece of pieces.slice(1)) {
    const tail = chain[chain.length - 1];
    const forward = near(tail, piece[0]) <= near(tail, piece[piece.length - 1]);
    const oriented = forward ? piece : [...piece].reverse();
    chain = [...chain, ...(near(tail, oriented[0]) < 1e-6 ? oriented.slice(1) : oriented)];
  }
  return chain;
}

const TOUCH_EPSILON = 1e-6;

/// Joins `b` onto `a` when they meet end to end; `null` when they do not touch.
function joinTouching(a: Polyline, b: Polyline): Polyline | null {
  const touch = (p: readonly [number, number], q: readonly [number, number]) => near(p, q) < TOUCH_EPSILON;
  const [aStart, aEnd, bStart, bEnd] = [a[0], a[a.length - 1], b[0], b[b.length - 1]];
  if (touch(aEnd, bStart)) return [...a, ...b.slice(1)];
  if (touch(aEnd, bEnd)) return [...a, ...[...b].reverse().slice(1)];
  if (touch(aStart, bStart)) return [...[...a].reverse(), ...b.slice(1)];
  if (touch(aStart, bEnd)) return [...b, ...a.slice(1)];
  return null;
}

/// Merges polylines that touch end to end into longer ones, so faces that left the boundary
/// (and so are not consecutive on a contour) still read as one band when they are adjacent.
function mergeTouching(polylines: Polyline[]): Polyline[] {
  const result = [...polylines];
  for (let i = 0; i < result.length; i++) {
    for (let j = i + 1; j < result.length; j++) {
      const joined = joinTouching(result[i], result[j]);
      if (joined === null) continue;
      result[i] = joined;
      result.splice(j, 1);
      i = -1;
      break;
    }
  }
  return result;
}

/// Display-space polylines covering `ends`, where faces that are consecutive on a boundary contour
/// are merged into one polyline, so a highlight over several neighbouring faces reads as one band.
/// Faces off every contour (no longer boundary faces) are merged by geometry when they touch.
export function mergedFacePolylines(
  ends: readonly WireFoldEnd[],
  contours: readonly (readonly WireFoldEnd[])[],
  cfg: FieldConfig,
): Polyline[] {
  const position = new Map<string, { contour: number; index: number }>();
  contours.forEach((faces, contour) => faces.forEach((end, index) => position.set(`${end.cell[0]},${end.cell[1]}:${end.face_idx}`, { contour, index })));
  const selected = new Map<number, Set<number>>();
  const loose: Polyline[] = [];
  for (const end of ends) {
    const found = position.get(`${end.cell[0]},${end.cell[1]}:${end.face_idx}`);
    if (!found) {
      const polyline = faceDisplayPolyline(end, cfg);
      if (polyline.length >= 2) loose.push(polyline);
      continue;
    }
    const set = selected.get(found.contour) ?? new Set<number>();
    set.add(found.index);
    selected.set(found.contour, set);
  }
  const merged: Polyline[] = [];
  for (const [contour, indices] of selected) {
    const faces = contours[contour];
    const length = faces.length;
    // Start every chain at a selected face whose predecessor is not selected (any face when the
    // whole contour is selected).
    const starts = [...indices].filter((index) => !indices.has((index + length - 1) % length));
    for (const start of starts.length > 0 ? starts : [Math.min(...indices)]) {
      const pieces: Polyline[] = [];
      for (let step = 0, index = start; step < length && indices.has(index); step++, index = (index + 1) % length) {
        const polyline = faceDisplayPolyline(faces[index], cfg);
        if (polyline.length >= 2) pieces.push(polyline);
      }
      if (pieces.length > 0) merged.push(joinChain(pieces));
    }
  }
  return mergeTouching([...merged, ...loose]);
}
