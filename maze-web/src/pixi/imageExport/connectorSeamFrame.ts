import { CUBIC_SAMPLE_STEPS } from "../../domain/renderers/teleportConnectorManual";
import type { UnfoldedPath } from "../renderers/teleportConnectorRouting";

type Point = [number, number];

/** One drawn part of a path segment; `far` parts are drawn on the partner side of a seam. */
export type DrawnPiece = { from: Point; to: Point; far: boolean };

/** The anchor an editable point follows: itself, or for a cubic handle (curve mode keeps an anchor, two
 *  handles, an anchor, ...) the anchor it belongs to. */
function anchorOf(index: number, count: number, curve: boolean): number {
  if (!curve || index % 3 === 0) return index;
  return Math.min(index % 3 === 1 ? index - 1 : index + 1, count - 1);
}

/** Whether an editable point is drawn beyond the seam, on the partner side. Points are judged by their
 *  position along the path (against the cut), not by geometry, so a bend lying in the seam face's line
 *  extension is never mistaken for a far point. Editable curve anchors sit every `CUBIC_SAMPLE_STEPS`
 *  samples of the path the cut was found in. */
export function isFarPoint(seam: UnfoldedPath | undefined, index: number, count: number, curve: boolean): boolean {
  if (!seam) return false;
  const anchor = anchorOf(index, count, curve);
  return (curve ? anchor / 3 * CUBIC_SAMPLE_STEPS : anchor) >= seam.firstFar;
}

/** Where every editable point is drawn. */
export function placedPoints(seam: UnfoldedPath | undefined, points: readonly number[], curve: boolean): Point[] {
  const count = points.length / 2, result: Point[] = [];
  for (let index = 0; index < count; index++) {
    const point: Point = [points[index * 2], points[index * 2 + 1]];
    result.push(seam && isFarPoint(seam, index, count, curve) ? seam.toPartner(point) : point);
  }
  return result;
}

/** The drawn parts of segment `segment` of the path (`a` to `b`): the segment that reaches across the
 *  seam is split at it into a near and a far part. */
export function segmentPieces(seam: UnfoldedPath | undefined, segment: number, a: Point, b: Point): DrawnPiece[] {
  if (!seam || segment + 1 < seam.firstFar) return [{ from: a, to: b, far: false }];
  const far = (from: Point, to: Point): DrawnPiece => ({ from: seam.toPartner(from), to: seam.toPartner(to), far: true });
  if (segment >= seam.firstFar) return [far(a, b)];
  const cut = seam.cutAt ?? b;
  return [{ from: a, to: cut, far: false }, far(cut, b)];
}

/** Maps a point under the pointer into the frame the path is edited in; `through` is the seam of a far point. */
export function toEditFrame(through: UnfoldedPath | null, point: Point): Point {
  return through ? through.fromPartner(point) : point;
}
