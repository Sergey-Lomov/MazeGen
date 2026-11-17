import type { WorldPoint } from "../../wasm/mazeService";
import { flattenSegments } from "../geometry/pathFlatten";
import { applyAffine, type Affine, type HalfEdge, type Seam, type SeamModel } from "./seams";

/// Shortest way between two points through a seam, as if the field continued beyond the glue (GitHub issue #873, `Specs/teleport_connectors.md`). The partner side is unfolded into this
/// side's frame with the half-edge's `fromPartner`; the straight line to the unfolded target crosses
/// the glued face at `at`, which corresponds to `partnerAt` on the other side. All world units.

export interface SeamCrossing {
  /// Where the line leaves the source side, on the source side's face.
  at: WorldPoint;
  /// The same point on the target side's face.
  partnerAt: WorldPoint;
  /// Length of the unfolded path.
  length: number;
  /// The target unfolded into the source side's frame: the point the routed connector aims at.
  unfolded: WorldPoint;
  /// Every face glued by the same unfold (the crossed one included), in the source side's frame: a routed
  /// shape may leave the field through a neighbouring face of the same glue.
  chains: readonly (readonly WorldPoint[])[];
  /// Maps a point of the source side's frame (the unfolded side) back into the target's own frame.
  toTarget: (point: WorldPoint) => WorldPoint;
}

const FLATTEN_TOLERANCE = 1e-3;
const chains = new WeakMap<HalfEdge, WorldPoint[]>();

function chainOf(half: HalfEdge): WorldPoint[] {
  let chain = chains.get(half);
  if (!chain) {
    chain = flattenSegments(half.segments, FLATTEN_TOLERANCE);
    chains.set(half, chain);
  }
  return chain;
}

function invertAffine(m: Affine): Affine {
  const det = m[0] * m[3] - m[1] * m[2];
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

/// The end of a half-edge's chain that meets `partnerEnd` of the partner's chain.
function endOf(seam: Seam, half: HalfEdge, partnerEnd: "start" | "end"): "start" | "end" {
  const pair = seam.endpoints.find((p) => (half.side === "a" ? p.b : p.a) === partnerEnd)!;
  return half.side === "a" ? pair.a : pair.b;
}

const unfolds = new WeakMap<HalfEdge, Affine>();

/// Maps the partner side into `half`'s frame. An isometric seam carries its transform; a topological-only
/// seam has none, so the partner's face is glued on: the rigid motion that lays its chain ends on the ends
/// of this chain they meet (`Seam.endpoints`), with the partner's cell on the far side of the glue.
function unfoldOf(seam: Seam, half: HalfEdge): Affine | null {
  if (half.fromPartner !== null) return half.fromPartner;
  let cached = unfolds.get(half);
  if (cached) return cached;
  const partner = half.side === "a" ? seam.b : seam.a;
  const own = chainOf(half);
  const theirs = chainOf(partner);
  if (own.length < 2 || theirs.length < 2) return null;
  const ownAt = (end: "start" | "end"): WorldPoint => (end === "start" ? own[0] : own[own.length - 1]);
  const theirAt = (end: "start" | "end"): WorldPoint => (end === "start" ? theirs[0] : theirs[theirs.length - 1]);
  // Partner end `x` meets this chain's end `endOf(x)`.
  const p0 = theirAt("start");
  const p1 = theirAt("end");
  const q0 = ownAt(endOf(seam, half, "start"));
  const q1 = ownAt(endOf(seam, half, "end"));
  const theta = Math.atan2(q1[1] - q0[1], q1[0] - q0[0]) - Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const rotation: Affine = [cos, sin, -sin, cos, 0, 0];
  const place = (m: Affine): Affine => {
    const moved = applyAffine(m, p0);
    return [m[0], m[1], m[2], m[3], q0[0] - moved[0], q0[1] - moved[1]];
  };
  const proper = place(rotation);
  // Reflection across the line through the partner's chain ends, applied first, for the other candidate.
  const ux = p1[0] - p0[0];
  const uy = p1[1] - p0[1];
  const len2 = ux * ux + uy * uy;
  if (len2 === 0) return null;
  const reflect: Affine = [(2 * ux * ux) / len2 - 1, (2 * ux * uy) / len2, (2 * ux * uy) / len2, (2 * uy * uy) / len2 - 1, 0, 0];
  const reflectedAbout = (point: WorldPoint): Affine => {
    const moved = applyAffine(reflect, point);
    return [reflect[0], reflect[1], reflect[2], reflect[3], point[0] - moved[0], point[1] - moved[1]];
  };
  const compose = (outer: Affine, inner: Affine): Affine => [
    outer[0] * inner[0] + outer[2] * inner[1], outer[1] * inner[0] + outer[3] * inner[1],
    outer[0] * inner[2] + outer[2] * inner[3], outer[1] * inner[2] + outer[3] * inner[3],
    outer[0] * inner[4] + outer[2] * inner[5] + outer[4], outer[1] * inner[4] + outer[3] * inner[5] + outer[5],
  ];
  const mirrored = compose(proper, reflectedAbout(p0));
  const sideOf = (point: WorldPoint): number => Math.sign(cross(q0[0], q0[1], q1[0], q1[1], point[0], point[1]));
  const own0 = sideOf(half.center);
  cached = sideOf(applyAffine(proper, partner.center)) === -own0 ? proper : mirrored;
  unfolds.set(half, cached);
  return cached;
}

const cross = (ox: number, oy: number, ax: number, ay: number, bx: number, by: number): number => (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);

/// Where the segment `a`-`b` crosses `half`'s face chain with `a` on the cell's own side and `b` on
/// the far side, or `null`.
function crossingOf(half: HalfEdge, a: WorldPoint, b: WorldPoint): WorldPoint | null {
  const chain = chainOf(half);
  for (let i = 1; i < chain.length; i++) {
    const [px, py] = chain[i - 1];
    const [qx, qy] = chain[i];
    const side = (x: number, y: number): number => Math.sign(cross(px, py, qx, qy, x, y));
    const own = side(half.center[0], half.center[1]);
    if (own === 0 || side(a[0], a[1]) !== own || side(b[0], b[1]) !== -own) continue;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const ex = qx - px;
    const ey = qy - py;
    const denom = dx * ey - dy * ex;
    if (denom === 0) continue;
    const t = ((px - a[0]) * ey - (py - a[1]) * ex) / denom;
    const u = ((px - a[0]) * dy - (py - a[1]) * dx) / denom;
    if (t < 0 || t > 1 || u < 0 || u > 1) continue;
    return [a[0] + t * dx, a[1] + t * dy];
  }
  return null;
}

/// The shortest crossing from `a` to `b` through one seam that beats the direct distance
/// `limit`, or `null` when no seam gives a shorter way.
export function shortestSeamCrossing(model: SeamModel, a: WorldPoint, b: WorldPoint, limit: number = Math.hypot(b[0] - a[0], b[1] - a[1])): SeamCrossing | null {
  let best: SeamCrossing | null = null;
  let bound = limit;
  for (const seam of model.seams) {
    for (const half of [seam.a, seam.b]) {
      const unfold = unfoldOf(seam, half);
      if (unfold === null) continue;
      const unfolded = applyAffine(unfold, b);
      const length = Math.hypot(unfolded[0] - a[0], unfolded[1] - a[1]);
      if (length >= bound) continue;
      const at = crossingOf(half, a, unfolded);
      if (!at) continue;
      const inverse = invertAffine(unfold);
      const sameGlue = (other: Affine): boolean => other.every((v, k) => Math.abs(v - unfold[k]) < 1e-6);
      const chains: WorldPoint[][] = [chainOf(half)];
      for (const s2 of model.seams) {
        for (const h2 of [s2.a, s2.b]) {
          if (h2 === half) continue;
          const u2 = unfoldOf(s2, h2);
          if (u2 !== null && sameGlue(u2)) chains.push(chainOf(h2));
        }
      }
      best = { at, partnerAt: applyAffine(inverse, at), length, unfolded, chains, toTarget: (point) => applyAffine(inverse, point) };
      bound = length;
    }
  }
  return best;
}

/// Cuts a routed polyline (in the source side's frame, from the source to the unfolded target) at its
/// first crossing of any of `chains`: the part up to the crossing and the part after it, both ending/starting
/// at the crossing point `at`. `null` when the polyline never crosses them.
export function cutPolylineAtChain(chains: readonly (readonly WorldPoint[])[], polyline: readonly WorldPoint[]): { before: WorldPoint[]; after: WorldPoint[]; at: WorldPoint } | null {
  for (let i = 1; i < polyline.length; i++) {
    const [ax, ay] = polyline[i - 1];
    const [bx, by] = polyline[i];
    const dx = bx - ax;
    const dy = by - ay;
    let bestT = Infinity;
    for (const chain of chains) {
      for (let j = 1; j < chain.length; j++) {
        const [px, py] = chain[j - 1];
        const ex = chain[j][0] - px;
        const ey = chain[j][1] - py;
        const denom = dx * ey - dy * ex;
        if (denom === 0) continue;
        const t = ((px - ax) * ey - (py - ay) * ex) / denom;
        const u = ((px - ax) * dy - (py - ay) * dx) / denom;
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1 && t < bestT) bestT = t;
      }
    }
    if (bestT !== Infinity) {
      const at: WorldPoint = [ax + bestT * dx, ay + bestT * dy];
      return { before: [...polyline.slice(0, i), at], after: [at, ...polyline.slice(i)], at };
    }
  }
  return null;
}
