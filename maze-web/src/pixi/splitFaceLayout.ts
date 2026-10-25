/** Shared geometric layout for a split point's per-node faces (GitHub issue #223/#231/#234) — the
 * pure "divide a face among connected nodes, straighten a 2-passage connector, fan the rest out
 * from a hub point, order the arrow only on the connector line, keep the active node's drawing on
 * top" algorithm used by both the post-generation canvas (`SplitJunctionRenderer`, via
 * `buildSplitPassagesCore`) and the "Manage split nodes" dialog's tile diagram (`TileFaceEditor`).
 * Those two callers differ in *what* faces/kinds exist (the canvas only ever sees `passage`/
 * `one_way_out`/`one_way_in` on faces with a real connection; the dialog also has `undefined`/
 * `wall`/`none`/boundary faces) and in *how* they render a segment/connector (Pixi.Graphics vs
 * SVG) — but the division/hub/straightening/z-order/arrow-placement rules are identical, so they
 * live here once. */

import type { SplitSpecialShapeKind } from "./renderers/types";
import { canonicalFaceKinds, type SplitShapeBinding } from "./splitShape";

/** `"none"` deliberately doesn't exist here — every face always has a real decided-or-default
 *  kind (`wall` for post-edit, `undefined`/optional for presets); "no decision yet" is represented
 *  by `undefined`/`wall` themselves, not a separate absence state. */
export type SplitFaceKind = "wall" | "passage" | "one_way_out" | "one_way_in" | "undefined";

/** This point's connected face indices for one node, ascending. */
function connectedIndicesOf(kinds: SplitFaceKind[]): number[] {
  return kinds.reduce<number[]>((acc, k, i) => (k === "wall" ? acc : [...acc, i]), []);
}

/** Circular distance between two face indices around a `degree`-sided tile (0..floor(degree/2)). */
export function circularDist(a: number, b: number, degree: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, degree - d);
}

/** True if a candidate node holding `decidedFaces` should own a brand-new face at `targetFace`
 * because doing so completes a recognized bridge/diagonal pair (GitHub issue #580's rotation
 * counterpart, shared by post-edit's `rotateSplitPointNodes` and preset's `rotatePresetSplitPoint`)
 * — `targetFace` isn't already decided, AND the face geometrically opposite it
 * (`circularDist(targetFace, opposite, degree) === degree / 2`) already **is** decided. A `wall`/
 * undecided opposite face does not count — only a real decided connection forms a bridge pair.
 * Bridge/diagonal shapes are only defined for even degree (square=4, hex=6) —
 * `detectSplitSpecialShapeKind`'s own guard — so this is unconditionally `false` for odd degree
 * (triangle=3, Cairo=5). The candidate's total decided-face count elsewhere is irrelevant to this
 * check. */
export function canCompleteOppositePair(decidedFaces: ReadonlySet<number>, targetFace: number, degree: number): boolean {
  if (degree % 2 !== 0) return false;
  if (decidedFaces.has(targetFace)) return false;
  for (const face of decidedFaces) if (circularDist(targetFace, face, degree) === degree / 2) return true;
  return false;
}

/** True if `decidedFaces` already forms a complete opposite pair (2 decided faces, geometrically
 * opposite each other) — a finished bridge/diagonal. Handing such a candidate a 3rd decided face
 * unconditionally destroys its recognized shape (`detectSplitSpecialShapeKind` requires an exact
 * 2-face count per node for degree 4/6, no tolerance for a 3rd), regardless of which face the 3rd
 * one is or whether it's geometrically opposite anything — checked independently of
 * `canCompleteOppositePair` so a rotate's fallback path can avoid picking an already-finished
 * candidate when a less committed one is available. */
export function hasCompleteOppositePair(decidedFaces: ReadonlySet<number>, degree: number): boolean {
  if (degree % 2 !== 0 || decidedFaces.size !== 2) return false;
  const [a, b] = [...decidedFaces];
  return circularDist(a, b, degree) === degree / 2;
}

/** True if a node holding `decidedFaces` is a finished bridge/diagonal that must not gain a face:
 * a complete opposite pair on a point with more than one node. A plain point's only node has no
 * recognized shape to protect, so a straight corridor through it can always be extended. */
export function isFinishedSplitPair(decidedFaces: ReadonlySet<number>, degree: number, nodeCount: number): boolean {
  return nodeCount > 1 && hasCompleteOppositePair(decidedFaces, degree);
}

/** The two outer faces of three consecutive faces on a circular tile, excluding the middle. */
export function adjacentTripleOuterFaces(faces: number[], degree: number): [number, number] | null {
  if (faces.length !== 3) return null;
  const set = new Set(faces);
  for (const start of faces) {
    if ([0, 1, 2].every((step) => set.has((start + step) % degree))) {
      return [start, (start + 2) % degree];
    }
  }
  return null;
}

/** Recognizes a split point's topology by its cell's shape template (`binding`; a cell without one
 *  is never recognized). `localFaceKindsByNode` is in the cell's `faces_of` order; recognition runs
 *  on the template's canonical faces, so it holds for every cell of the template. The `regular:4`
 *  template and four-face radial ring template: a two-node topology as `"bridge"` (each node an
 *  opposite-face pair) or `"diagonal"` (each node an adjacent-face pair) — GitHub issue #294/#845 — or
 *  a degree-6 (hex) split point's topology as one of the hex-specific kinds — GitHub issue #319:
 *  `"hex_bridge"` (two nodes, each an opposite-face pair), `"hex_triple_bridge"` (three nodes, all
 *  opposite-face pairs), `"hex_diagonal"` (two nodes, neither an opposite-face pair — adjacent
 *  and/or skip-face pairs), `"hex_triple_corridor"` (three nodes: one opposite-face pair plus two
 *  adjacent-face pairs). `localFaceKindsByNode[nodeIndex]` is that node's kind on every one of the
 *  point's faces, in the same order as `offsets`/`faceInputs`; a node only counts as "connected" on
 *  a face for `passage`/`one_way_out`/`one_way_in` (mirrors `NO_OWN_SEGMENT_KINDS`). Returns `null`
 *  for anything else (wrong degree/node count, not exactly 2 connected faces per node, or a
 *  face-pair combination with no recognized shape). Shared by `buildSplitPassagesCore`
 *  (`mazeSelectors.ts`, drawing) and `getSplitAwareNodePosition`/`buildNodePositions` (GitHub issue
 *  #318, node-point positioning) so both agree on what counts as a recognized shape.
 *
 *  A one-way connection (`one_way_out`/`one_way_in`) on any face disqualifies the point entirely
 *  (GitHub issue #477): every special shape draws a symmetric two-way silhouette with no arrowhead,
 *  so a recognized shape would hide the directionality. Falling back to `null` makes the caller
 *  render the ordinary per-node hub connectors, which draw the one-way arrow. */
export function detectSplitSpecialShapeKind(
  localFaceKindsByNode: SplitFaceKind[][],
  binding: SplitShapeBinding | null,
): SplitSpecialShapeKind | null {
  if (binding === null) return null;
  const faceKindsByNode = localFaceKindsByNode.map((kinds) => canonicalFaceKinds(binding, kinds));
  const degree = faceKindsByNode[0]?.length ?? 0;
  const nodeCount = faceKindsByNode.length;
  if (faceKindsByNode.some((kinds) => kinds.some((k) => k === "one_way_out" || k === "one_way_in"))) return null;
  if (binding.shape === "cairo_pentagon") {
    if (nodeCount !== 2) return null;
    const connectedIndices = faceKindsByNode.map((kinds) => connectedIndicesOf(kinds));
    const hasPair = (faces: number[], a: number, b: number) => faces.length === 2 && faces.includes(a) && faces.includes(b);
    const hasTriple = (faces: number[], expected: number[]) => faces.length === expected.length && expected.every((face) => faces.includes(face));
    if ((hasTriple(connectedIndices[0], [0, 2, 3]) && hasPair(connectedIndices[1], 1, 4)) ||
      (hasTriple(connectedIndices[1], [0, 2, 3]) && hasPair(connectedIndices[0], 1, 4))) {
      return "cairo_bridge_2x3";
    }
    if ((hasPair(connectedIndices[0], 2, 3) && hasPair(connectedIndices[1], 1, 4)) ||
      (hasPair(connectedIndices[0], 1, 4) && hasPair(connectedIndices[1], 2, 3))) {
      return "cairo_diagonal_divider";
    }
    return (hasPair(connectedIndices[0], 1, 2) && hasPair(connectedIndices[1], 3, 4)) ||
      (hasPair(connectedIndices[0], 3, 4) && hasPair(connectedIndices[1], 1, 2))
      ? "cairo_adjacent_divider" : null;
  }
  // Radial ring cells with one inner and one outer neighbor have the same four-face topology as
  // a square: outer/inner and previous/next form the two opposite pairs. Reuse the square bridge
  // and diagonal-divider treatment while keeping every other registered template opt-in.
  const isFourFaceTemplate = binding.shape === "regular:4" || binding.shape === "radial:ring_1_1";
  if (!isFourFaceTemplate && binding.shape !== "regular:6") return null;
  if (degree === 4 && nodeCount !== 2) return null;
  if (degree === 6 && nodeCount !== 2 && nodeCount !== 3) return null;

  const connectedIndices = faceKindsByNode.map((kinds) => connectedIndicesOf(kinds));
  if (degree === 6 && nodeCount === 2 && connectedIndices.every((idxs) => idxs.length === 3)) {
    const allFaces = connectedIndices.flat();
    return new Set(allFaces).size === degree && connectedIndices.every((faces) => adjacentTripleOuterFaces(faces, degree) !== null)
      ? "hex_diagonal_divider"
      : null;
  }

  if (connectedIndices.some((idxs) => idxs.length !== 2)) return null;

  const isOpposite = (idxs: number[]) => circularDist(idxs[0], idxs[1], degree) === degree / 2;

  if (degree === 4) {
    const aOpposite = isOpposite(connectedIndices[0]);
    const bOpposite = isOpposite(connectedIndices[1]);
    if (aOpposite !== bOpposite) return null; // one node opposite, the other adjacent — not recognized
    if (!aOpposite) return "diagonal";
    // Both nodes span an opposite-face pair, but a "bridge" needs the two pairs to be the
    // *different* axis (e.g. N/S crossing E/W) — two nodes both claiming the same axis (both
    // {0,2} or both {1,3}) is a degenerate double-coverage of one pair, not a real bridge
    // (GitHub issue #591).
    const samePair = connectedIndices[0][0] === connectedIndices[1][0] && connectedIndices[0][1] === connectedIndices[1][1];
    return samePair ? null : "bridge";
  }

  // degree === 6
  const oppositeFlags = connectedIndices.map(isOpposite);
  const oppositeCount = oppositeFlags.filter(Boolean).length;

  if (nodeCount === 2) {
    if (oppositeCount === 2) {
      // Same distinct-pair requirement as degree 4's "bridge" above (GitHub issue #591).
      const samePair = connectedIndices[0][0] === connectedIndices[1][0] && connectedIndices[0][1] === connectedIndices[1][1];
      return samePair ? null : "hex_bridge";
    }
    if (oppositeCount === 0) return "hex_diagonal";
    return null; // one opposite, one not — not recognized
  }

  // nodeCount === 3 — every face must be used exactly once (3 nodes × 2 faces = the full degree)
  const allFaces = connectedIndices.flat();
  if (new Set(allFaces).size !== 6) return null;

  if (oppositeCount === 3) return "hex_triple_bridge";
  if (oppositeCount === 1) {
    const adjacentCount = connectedIndices.filter((idxs) => circularDist(idxs[0], idxs[1], degree) === 1).length;
    if (adjacentCount === 2) return "hex_triple_corridor";
  }
  return null;
}

/** This node's own connected face indices, as recognized by `detectSplitSpecialShapeKind` (exactly
 *  2, in ascending order) — GitHub issue #318. */
export function connectedFaceIndices(kinds: SplitFaceKind[]): number[] {
  return kinds.reduce<number[]>((acc, k, i) => (k === "wall" ? acc : [...acc, i]), []);
}

/** Kinds that get no own colored segment/connector — `wall` (this node's face explicitly
 *  forbidden, whether by an explicit decision or by post-edit's default). */
const NO_OWN_SEGMENT_KINDS = new Set<SplitFaceKind>(["wall"]);

type Pt = { x: number; y: number };

export interface SplitFaceInput {
  v0: Pt;
  v1: Pt;
  /** The face's flattened boundary from `v0` to `v1` (both included). Absent for a straight face,
   *  which is the chord `v0 -> v1`; present for a curved one, so a node's share follows the arc. */
  polyline?: readonly Pt[];
}

/** `face`'s boundary as a point list from `v0` to `v1`. */
export function facePolyline(face: SplitFaceInput): readonly Pt[] {
  return face.polyline && face.polyline.length >= 2 ? face.polyline : [face.v0, face.v1];
}

/** The point at fraction `t` (0..1) of `polyline`'s length. */
export function pointAlongPolyline(polyline: readonly Pt[], t: number): Pt {
  return subPolyline(polyline, t, t)[0];
}

/** The part of `polyline` between the fractions `t0 <= t1` of its length, end points exact. */
export function subPolyline(polyline: readonly Pt[], t0: number, t1: number): Pt[] {
  if (polyline.length === 2) {
    const [a, b] = polyline;
    const lerp = (t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    return [lerp(t0), lerp(t1)];
  }
  const lengths: number[] = [0];
  for (let i = 1; i < polyline.length; i++) {
    lengths.push(lengths[i - 1] + Math.hypot(polyline[i].x - polyline[i - 1].x, polyline[i].y - polyline[i - 1].y));
  }
  const total = lengths[lengths.length - 1];
  if (total === 0) return [polyline[0], polyline[polyline.length - 1]];
  const at = (distance: number): Pt => {
    let i = 1;
    while (i < polyline.length - 1 && lengths[i] < distance) i++;
    const span = lengths[i] - lengths[i - 1];
    const f = span === 0 ? 0 : (distance - lengths[i - 1]) / span;
    return {
      x: polyline[i - 1].x + (polyline[i].x - polyline[i - 1].x) * f,
      y: polyline[i - 1].y + (polyline[i].y - polyline[i - 1].y) * f,
    };
  };
  const d0 = t0 * total, d1 = t1 * total;
  const inner: Pt[] = [];
  for (let i = 1; i < polyline.length - 1; i++) {
    if (lengths[i] > d0 && lengths[i] < d1) inner.push(polyline[i]);
  }
  return [t0 <= 0 ? polyline[0] : at(d0), ...inner, t1 >= 1 ? polyline[polyline.length - 1] : at(d1)];
}

/** One node's kind on one face, alongside the node's own index (its position in the node list —
 *  determines hub angle and z-order isn't derived from this, see `activeIndex`). */
export interface SplitNodeFaceKind {
  nodeIndex: number;
  kind: SplitFaceKind;
}

export interface SplitFaceSegment {
  nodeIndex: number;
  kind: SplitFaceKind;
  v0: { x: number; y: number };
  v1: { x: number; y: number };
  /** The share's boundary from `v0` to `v1` — two points for a straight face, the flattened arc
   *  for a curved one. */
  polyline: Pt[];
  /** The middle of the share along `polyline`, where its connector ends. */
  mid: Pt;
  /** `true` when `v0`/`v1` lands exactly on the face's own real endpoint (`face.v0`/`face.v1`, the
   *  boundary shared with a neighboring tile/wall) rather than an internal division point between
   *  two nodes sharing this face (GitHub issue #317) — a shape sharing this face with another node
   *  divides it into contiguous sub-segments in slot order, so only the first share's `v0` and the
   *  last share's `v1` ever touch the face's real ends; a lone node on the face gets both. Lets
   *  `SplitJunctionRenderer` cap a "free" end (no neighbor sub-segment to butt against) with the
   *  caller's own join/cap style instead of the always-`"butt"` internal-division ends. */
  atFaceStart: boolean;
  atFaceEnd: boolean;
}

export interface SplitFaceLayout {
  /** `null` when no node is connected on this face — draws as a single shared neutral segment
   *  instead (`nodeIndex: -1` sentinel isn't used here; callers render the neutral case
   *  themselves when `segments` is empty). */
  segments: SplitFaceSegment[];
  /** `true` when every one of the point's nodes explicitly has `wall` on this face (not merely
   *  unconnected/`undefined`) — callers draw this as one plain solid wall spanning the whole face,
   *  same as an ordinary (non-split) wall, instead of the neutral placeholder line. */
  allWall: boolean;
}

export interface SplitConnectorLine {
  from: { x: number; y: number };
  to: { x: number; y: number };
  /** Set only for a one-way face: `true` if this node's passage runs outward (away from the hub,
   *  toward the face — draw the arrowhead pointing `from -> to`), `false` if inward. `undefined`
   *  for a two-way passage or an optional/no connection (no arrow). */
  oneWayOut?: boolean;
  /** This line's own face kind is `"undefined"` (an optional/tentative connection) — callers draw
   *  it in a disabled/desaturated color instead of the node's normal color, same rule as the
   *  matching face segment. */
  isUndefined: boolean;
}

export interface SplitNodeConnectors {
  nodeIndex: number;
  lines: SplitConnectorLine[];
}

/** Computes every face's per-node segment layout — division of the shared edge among connected
 *  nodes is always in stable node-index order (GitHub issue #422: geometry must not depend on
 *  which node is active, or switching the active node reshuffles every other node's segment
 *  position too), with the returned `segments` array itself additionally reordered so the active
 *  node's own entry comes last (drawn on top) — GitHub issue #234 follow-up ("active node always
 *  on top"). Faces are addressed by array index, matching `faces[i]`/`kindsByFace[i]` 1:1. */
export function computeSplitFaceLayouts(
  faces: SplitFaceInput[],
  kindsByFace: SplitNodeFaceKind[][],
  activeIndex: number | null,
): SplitFaceLayout[] {
  return faces.map((face, faceIndex) => {
    const allKinds = kindsByFace[faceIndex] ?? [];
    const allWall = allKinds.length > 0 && allKinds.every((k) => k.kind === "wall");
    const connected = allKinds.filter((k) => !NO_OWN_SEGMENT_KINDS.has(k.kind));
    if (connected.length === 0) return { segments: [], allWall };

    // Geometric division is always by stable node-index order — which node's sub-segment sits
    // where along the face must not depend on which node is currently active, or picking a
    // different active node reshuffles every other node's segment position too (GitHub issue
    // #422). Active-last is a separate, draw-order-only concern applied after the geometry is
    // fixed, so switching the active node only changes z-order, not layout.
    const byNodeIndex = [...connected].sort((a, b) => a.nodeIndex - b.nodeIndex);
    const n = byNodeIndex.length;
    const boundary = facePolyline(face);
    const segmentsByNodeIndex = byNodeIndex.map((entry, i) => {
      const polyline = subPolyline(boundary, i / n, (i + 1) / n);
      return {
        nodeIndex: entry.nodeIndex,
        kind: entry.kind,
        v0: polyline[0],
        v1: polyline[polyline.length - 1],
        polyline,
        mid: pointAlongPolyline(boundary, (i + 0.5) / n),
        atFaceStart: i === 0,
        atFaceEnd: i === n - 1,
      };
    });

    // Active node's own segment last (drawn on top) — reorders only the returned draw sequence,
    // never the geometry computed above.
    const segments = [...segmentsByNodeIndex].sort((a, b) => {
      const aActive = a.nodeIndex === activeIndex ? 1 : 0;
      const bActive = b.nodeIndex === activeIndex ? 1 : 0;
      return aActive - bActive || a.nodeIndex - b.nodeIndex;
    });
    return { segments, allWall };
  });
}

/** Minimum angle (degrees) between a face and the straight line leading to the other face's share.
 *  A smaller angle means the straight connector hugs the face (e.g. a half face of a brick
 *  tessellation), so the node falls back to its hub point instead. Must stay below the smallest
 *  angle of an existing tessellation (22.5° between adjacent octagon faces in 4.8.8). */
export const MIN_STRAIGHT_CONNECTOR_ANGLE_DEG = 20;

type ConnectorShare = { point: { x: number; y: number }; face: { dx: number; dy: number } };

/** True if the straight line between two shares runs closer than `MIN_STRAIGHT_CONNECTOR_ANGLE_DEG`
 *  to either share's own face. */
function straightLineDegenerates(a: ConnectorShare, b: ConnectorShare): boolean {
  const lx = b.point.x - a.point.x, ly = b.point.y - a.point.y;
  const lineLen = Math.hypot(lx, ly);
  const sinMin = Math.sin((MIN_STRAIGHT_CONNECTOR_ANGLE_DEG * Math.PI) / 180);
  return [a, b].some((s) => {
    const faceLen = Math.hypot(s.face.dx, s.face.dy);
    if (lineLen === 0 || faceLen === 0) return false;
    return Math.abs(s.face.dx * ly - s.face.dy * lx) / (faceLen * lineLen) < sinMin;
  });
}

/** Computes every node's connector lines from its own face segments (built by
 *  `computeSplitFaceLayouts`, filtered to one node via `nodeIndex`) — a node with exactly 2
 *  connected faces, both ordinary two-way passages, draws one straight line directly between the
 *  two share centers (no hub point, reads as one continuous corridor) unless that line makes an
 *  angle below `MIN_STRAIGHT_CONNECTOR_ANGLE_DEG` with either face; any other case (0, 1, or
 *  3+ shares, or exactly 2 but not both plain passages) fans out from a hub point on a small
 *  circle around `hubCenter`, one node per slot, evenly spaced starting at `rotationRad`. Returns
 *  nodes in `nodeCount` order with the active one moved last (drawn on top).
 *
 *  `forceHub(nodeIndex)`, if given, keeps a node on its hub point even at exactly 2 plain-passage
 *  connections — the post-generation canvas's exception for a node carrying a start/finish marker
 *  or teleport endpoint, since a marker/teleport line drawn on a straight-through connector would
 *  otherwise sit on it with nothing marking which point along it is actually special. The dialog's
 *  tile diagram has no such concept and never passes it. */
export function computeSplitConnectors(
  faceLayouts: SplitFaceLayout[],
  nodeCount: number,
  activeIndex: number | null,
  hubCenter: { x: number; y: number },
  hubRadius: number,
  rotationRad: number,
  forceHub?: (nodeIndex: number) => boolean,
): SplitNodeConnectors[] {
  const order = Array.from({ length: nodeCount }, (_, i) => i)
    .sort((a, b) => (a === activeIndex ? 1 : 0) - (b === activeIndex ? 1 : 0) || a - b);

  return order.map((nodeIndex) => {
    const shares = faceLayouts
      .flatMap((layout) => layout.segments.filter((s) => s.nodeIndex === nodeIndex))
      .map((s) => ({
        point: s.mid,
        kind: s.kind,
        face: { dx: s.v1.x - s.v0.x, dy: s.v1.y - s.v0.y },
      }));

    const bothPassages = shares.length === 2 && shares.every((s) => s.kind === "passage") && !forceHub?.(nodeIndex)
      && !straightLineDegenerates(shares[0], shares[1]);
    if (bothPassages) {
      return { nodeIndex, lines: [{ from: shares[0].point, to: shares[1].point, isUndefined: false }] };
    }

    const angle = rotationRad + (nodeIndex / nodeCount) * Math.PI * 2;
    const hub = { x: hubCenter.x + Math.cos(angle) * hubRadius, y: hubCenter.y + Math.sin(angle) * hubRadius };
    const lines = shares.map((share) => ({
      from: hub,
      to: share.point,
      oneWayOut: share.kind === "one_way_out" ? true : share.kind === "one_way_in" ? false : undefined,
      isUndefined: share.kind === "undefined",
    }));
    return { nodeIndex, lines };
  });
}
