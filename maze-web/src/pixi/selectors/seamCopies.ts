import type { FieldConfig } from "../../fieldConfig";
import { applyTransform, invertTransform, isSimilarity, type WorldTransform } from "../geometry/worldTransform";
import { flattenSegments } from "../geometry/pathFlatten";
import { displayTransform } from "../tessellationGeometry";
import { getSeamModel, type Affine, type HalfEdge } from "./seams";

/// Seam copies (GitHub issue #981, `Specs/topology.md`, "Elements that cross a seam"): an element anchored
/// in one cell may reach past a glued face. The export cuts the artwork at the face, so the part beyond it
/// is carried over to the partner's side: drawn again in the partner's frame, brought there by the seam's
/// own isometry, and shown only in a strip inside the partner's cell along the glued face. Pure, display
/// space; the caller draws.

/// A circle that bounds an element: its anchor and the farthest reach of its artwork from that anchor.
export interface SeamDisk {
  x: number;
  y: number;
  r: number;
}

export interface SeamCopy {
  /// The side the elements stand on.
  from: HalfEdge;
  /// The partner side the copy is drawn on.
  to: HalfEdge;
  /// Display-space isometry taking `from`'s frame into `to`'s: a rotation or a reflection (twisted seam)
  /// plus a shift, so a copy reads as the element continuing across the glue.
  transform: WorldTransform;
  /// Display-space polygons: the strip inside `to`'s cell along its glued face. The copy shows only there.
  clip: number[][];
  /// Indices of the input disks that reach the glued face of `from`.
  indices: number[];
}

type Vec = [number, number];

const asTransform = (m: Affine): WorldTransform => ({ a: m[0], b: m[1], c: m[2], d: m[3], tx: m[4], ty: m[5] });

/// `outer` after `inner`.
function compose(outer: WorldTransform, inner: WorldTransform): WorldTransform {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    tx: outer.a * inner.tx + outer.c * inner.ty + outer.tx,
    ty: outer.b * inner.tx + outer.d * inner.ty + outer.ty,
  };
}

const FLATTEN_TOLERANCE = 1e-3;
const polylines = new WeakMap<WorldTransform, WeakMap<HalfEdge, Vec[]>>();

/// The face of a half-edge as a display-space polyline.
function displayPolyline(half: HalfEdge, display: WorldTransform): Vec[] {
  let byHalf = polylines.get(display);
  if (!byHalf) {
    byHalf = new WeakMap();
    polylines.set(display, byHalf);
  }
  let line = byHalf.get(half);
  if (!line) {
    line = flattenSegments(half.segments, FLATTEN_TOLERANCE).map((p) => applyTransform(display, p) as Vec);
    byHalf.set(half, line);
  }
  return line;
}

function distanceToSegment(px: number, py: number, [x0, y0]: Vec, [x1, y1]: Vec): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lengthSq = dx * dx + dy * dy;
  const u = lengthSq === 0 ? 0 : Math.min(1, Math.max(0, ((px - x0) * dx + (py - y0) * dy) / lengthSq));
  return Math.hypot(px - (x0 + dx * u), py - (y0 + dy * u));
}

function distanceToPolyline(px: number, py: number, line: readonly Vec[]): number {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) best = Math.min(best, distanceToSegment(px, py, line[i - 1], line[i]));
  return best;
}

/// A quad per segment of `line`, reaching `depth` toward `center`.
function stripAlong(line: readonly Vec[], center: Vec, depth: number): number[][] {
  const polygons: number[][] = [];
  for (let i = 1; i < line.length; i++) {
    const [x0, y0] = line[i - 1];
    const [x1, y1] = line[i];
    const length = Math.hypot(x1 - x0, y1 - y0);
    if (length === 0) continue;
    let nx = -(y1 - y0) / length;
    let ny = (x1 - x0) / length;
    if (nx * (center[0] - (x0 + x1) / 2) + ny * (center[1] - (y0 + y1) / 2) < 0) {
      nx = -nx;
      ny = -ny;
    }
    polygons.push([x0, y0, x1, y1, x1 + nx * depth, y1 + ny * depth, x0 + nx * depth, y0 + ny * depth]);
  }
  return polygons;
}

/// One copy per glued side that has an element reaching its face. Only an isometric seam carries a map; a
/// topological-only one has no common geometry, so its elements stay cut at the face.
export function planSeamCopies(cfg: FieldConfig, disks: readonly SeamDisk[]): SeamCopy[] {
  if (disks.length === 0) return [];
  const model = getSeamModel(cfg);
  if (model.isEmpty) return [];
  const display = displayTransform(cfg);
  const copies: SeamCopy[] = [];
  for (const seam of model.seams) {
    if (!seam.isometric) continue;
    for (const from of [seam.a, seam.b]) {
      const to = model.partnerOf(from);
      // `to.fromPartner` carries `from`'s frame into `to`'s: it lays `from`'s cell on the far side of the
      // glued face, so the part of an element beyond `from`'s face lands inside `to`'s cell.
      if (!to.fromPartner) continue;
      const transform = compose(display, compose(asTransform(to.fromPartner), invertTransform(display)));
      if (!isSimilarity(transform)) continue;
      const faceLine = displayPolyline(from, display);
      const indices: number[] = [];
      let depth = 0;
      disks.forEach((disk, index) => {
        if (distanceToPolyline(disk.x, disk.y, faceLine) > disk.r) return;
        indices.push(index);
        depth = Math.max(depth, disk.r);
      });
      if (indices.length === 0) continue;
      const clip = stripAlong(displayPolyline(to, display), applyTransform(display, to.center) as Vec, depth + 1);
      if (clip.length > 0) copies.push({ from, to, transform, clip, indices });
    }
  }
  return copies;
}
