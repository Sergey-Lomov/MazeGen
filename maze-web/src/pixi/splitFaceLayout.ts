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

/** `"none"` deliberately doesn't exist here — every face always has a real decided-or-default
 *  kind (`wall` for post-edit, `undefined`/optional for presets); "no decision yet" is represented
 *  by `undefined`/`wall` themselves, not a separate absence state. */
export type SplitFaceKind = "wall" | "passage" | "one_way_out" | "one_way_in" | "undefined";

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

/** Computes every face's per-node segment layout (division of the shared edge among connected
 *  nodes, in node-index order, with the active node's own segment always sorted last within its
 *  face so it draws on top) — GitHub issue #234 follow-up ("active node always on top"). Faces are
 *  addressed by array index, matching `faces[i]`/`kindsByFace[i]` 1:1. */
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

    // Active node last (drawn on top) — stable otherwise (node-index order).
    const ordered = [...connected].sort((a, b) => {
      const aActive = a.nodeIndex === activeIndex ? 1 : 0;
      const bActive = b.nodeIndex === activeIndex ? 1 : 0;
      return aActive - bActive || a.nodeIndex - b.nodeIndex;
    });

    const n = ordered.length;
    const segments = ordered.map((entry, i) => {
      const t0 = i / n, t1 = (i + 1) / n;
      return {
        nodeIndex: entry.nodeIndex,
        kind: entry.kind,
        v0: { x: face.v0.x + (face.v1.x - face.v0.x) * t0, y: face.v0.y + (face.v1.y - face.v0.y) * t0 },
        v1: { x: face.v0.x + (face.v1.x - face.v0.x) * t1, y: face.v0.y + (face.v1.y - face.v0.y) * t1 },
      };
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
