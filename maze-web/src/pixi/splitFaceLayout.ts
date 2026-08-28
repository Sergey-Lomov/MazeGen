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

/** Recognizes a degree-4 split point's two-node topology as `"bridge"` (each node an
 *  opposite-face pair) or `"diagonal"` (each node an adjacent-face pair) — GitHub issue #294 — or
 *  a degree-6 (hex) split point's topology as one of the hex-specific kinds — GitHub issue #319:
 *  `"hex_bridge"` (two nodes, each an opposite-face pair), `"hex_triple_bridge"` (three nodes, all
 *  opposite-face pairs), `"hex_diagonal"` (two nodes, neither an opposite-face pair — adjacent
 *  and/or skip-face pairs), `"hex_triple_corridor"` (three nodes: one opposite-face pair plus two
 *  adjacent-face pairs). `faceKindsByNode[nodeIndex]` is that node's kind on every one of the
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
export function detectSplitSpecialShapeKind(faceKindsByNode: SplitFaceKind[][]): SplitSpecialShapeKind | null {
  const degree = faceKindsByNode[0]?.length ?? 0;
  const nodeCount = faceKindsByNode.length;
  if (faceKindsByNode.some((kinds) => kinds.some((k) => k === "one_way_out" || k === "one_way_in"))) return null;
  if (degree !== 4 && degree !== 6) return null;
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
    return aOpposite ? "bridge" : "diagonal";
  }

  // degree === 6
  const oppositeFlags = connectedIndices.map(isOpposite);
  const oppositeCount = oppositeFlags.filter(Boolean).length;

  if (nodeCount === 2) {
    if (oppositeCount === 2) return "hex_bridge";
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

export interface SplitFaceInput {
  v0: { x: number; y: number };
  v1: { x: number; y: number };
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
    const segmentsByNodeIndex = byNodeIndex.map((entry, i) => {
      const t0 = i / n, t1 = (i + 1) / n;
      return {
        nodeIndex: entry.nodeIndex,
        kind: entry.kind,
        v0: { x: face.v0.x + (face.v1.x - face.v0.x) * t0, y: face.v0.y + (face.v1.y - face.v0.y) * t0 },
        v1: { x: face.v0.x + (face.v1.x - face.v0.x) * t1, y: face.v0.y + (face.v1.y - face.v0.y) * t1 },
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

/** Computes every node's connector lines from its own face segments (built by
 *  `computeSplitFaceLayouts`, filtered to one node via `nodeIndex`) — a node with exactly 2
 *  connected faces, both ordinary two-way passages, draws one straight line directly between the
 *  two share centers (no hub point, reads as one continuous corridor); any other case (0, 1, or
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
        point: { x: (s.v0.x + s.v1.x) / 2, y: (s.v0.y + s.v1.y) / 2 },
        kind: s.kind,
      }));

    const bothPassages = shares.length === 2 && shares.every((s) => s.kind === "passage") && !forceHub?.(nodeIndex);
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
