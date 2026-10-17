import type { NodeDto, EdgeDto } from "../../../wasm/types";
import type { FieldConfig } from "../../../fieldConfig";
import type { SplitPassage, SplitSpecialShape } from "../../renderers/types";
import { getCellVertices, getSplitCircleRotationDeg, buildNodePositions, getCellCenter, getNeighborData, getSharedEdgeSegment, specialSplitNodePoint, SPLIT_HUB_RADIUS } from "../../tessellationGeometry";
import { splitShapeBinding, canonicalFaceKinds } from "../../splitShape";
import { adjacentTripleOuterFaces, computeSplitFaceLayouts, computeSplitConnectors, detectSplitSpecialShapeKind, circularDist, type SplitFaceKind } from "../../splitFaceLayout";
import { canvas } from "../../colorTokens";
import { splitSlotColor } from "../../colorUtils";
import { resolveEndpoint, buildSplitNodeResolver, type PostEditEndpoint } from "../../postEditEndpoint";

const BRIDGE_DECK_WIDTH_FRAC = 0.6;

/** Sharper/narrower proportions for `hex_triple_bridge`'s two crossing edges (issue #319 follow-up)
 *  — the taper takes only the first/last 8% of the tile's length and the deck is 40% of the cross
 *  corridor's width, since three corridors meeting at one point need extra visual separation. */
const TRIPLE_BRIDGE_TAPER_FRAC = 0.08;
const TRIPLE_BRIDGE_DECK_WIDTH_FRAC = 0.4;

/** Square bridges retain their original gradual narrowing/widening section. */
const SQUARE_BRIDGE_TAPER_FRAC = 0.2;

/** A hex bridge keeps its wider 60% deck, but uses the same taper angle as the narrower triple
 *  bridge. Each edge moves inward by `(1 - deckWidth) / 2`; preserving the ratio of that transverse
 *  movement to the axial taper length gives a short ~5.33% narrowing/widening section. */
const HEX_BRIDGE_TAPER_FRAC = TRIPLE_BRIDGE_TAPER_FRAC
  * (1 - BRIDGE_DECK_WIDTH_FRAC)
  / (1 - TRIPLE_BRIDGE_DECK_WIDTH_FRAC);

/** Points with more than one `NodeDto` (split points, GitHub issue #221/#223) — geometric edges
 *  touching one of these are excluded from `buildMazeWalls`'s ordinary reading entirely; they
 *  render exclusively via `buildSplitPassages`'s colored per-node lines instead. */
export function buildSplitPointKeys(nodes: NodeDto[]): Set<string> {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const key = `${n.x},${n.y}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const keys = new Set<string>();
  for (const [key, count] of counts) if (count > 1) keys.add(key);
  return keys;
}

/** Largest node count at any one split point in `nodes` (0 if there's no split point at all) —
 *  used by `VectorByWallsSettingsPanel`'s Splits section (GitHub issue #294) to size its per-slot
 *  color list to what the current maze actually needs. Nodes are grouped by `(level, x, y)`, not
 *  `(x, y)` alone — the same cell on two different floors is two unrelated nodes, not a split
 *  point (GitHub issue #294 follow-up: the panels feed the *unscoped* project-wide node list so
 *  the section doesn't flicker on a floor switch, so the count must be level-aware to not mistake
 *  a stack of one-node-per-floor cells for a split). Every renderer/warning caller passes an
 *  already floor-scoped list, where every node shares one `level`, so this is a no-op for them. */
export function maxSplitNodeCount(nodes: NodeDto[]): number {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const key = `${n.level ?? 0}:${n.x},${n.y}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let max = 0;
  for (const count of counts.values()) if (count > 1 && count > max) max = count;
  return max;
}

/** Position to draw a node-anchored entity (start/finish marker, teleport endpoint) at — the
 *  cell's own center for an ordinary (unsplit) node; for a split point, a node recognized as part
 *  of a `SplitSpecialShapeKind` (bridge/diagonal, GitHub issue #318) gets `specialSplitNodePoint`'s
 *  dedicated point instead of the generic hub-circle position, since a bridge/diagonal reads
 *  visually as belonging to a specific half/lane of the tile, not an evenly-spaced slot on a
 *  circle; every other split node still gets `splitHubPoint`'s small-circle position. Thin wrapper
 *  over `buildNodePositions` (`tessellationGeometry.ts`) — same shape detection, just resolving one
 *  node id instead of building the whole map. `nodes` must include every node of the point (not
 *  just `nodeId`) for the slot index/shape detection to be computed correctly. `edges` (directed
 *  pairs only — teleports pre-filtered by the caller, same contract `buildSplitPassages` uses)
 *  drives shape detection; omit it to always fall back to the generic hub position (e.g. a caller
 *  with no edge data in hand). */
export function getSplitAwareNodePosition(
  nodes: NodeDto[],
  nodeId: number,
  cfg: FieldConfig,
  edges: EdgeDto[] = [],
): { x: number; y: number } | null {
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return null;

  const directedPairs = edges.filter((e) => e.kind !== "teleport").map((e) => ({ from: e.from, to: e.to }));
  return buildNodePositions(nodes, cfg, directedPairs).get(nodeId) ?? null;
}

/** A split point's node, abstracted over the identity type `Id` — `NodeDto`'s `id: number` for the
 *  post-generation callers, `PresetEndpoint`'s `(point, slotId?)` (via `presetEndpointKey`) for the
 *  preset-stage caller (GitHub issue #231), compared with `===`. */
export type SplitPassageNode<Id> = { id: Id; x: number; y: number };

/** Generic core of `buildSplitPassages` (GitHub issue #223/#231/#234) — parameterized over an
 *  opaque, comparable `Id` type so it has no notion of `NodeDto`/`EdgeDto`/resolved `NodeId`.
 *  `directedPairs` is the flat list of `(from, to)` id pairs this point's nodes may connect across
 *  (teleports must already be filtered out by the caller — a teleport must not read as an open
 *  passage here, same rule as `buildMazeWalls`). The geometric layout itself (dividing a face
 *  among connected nodes, straightening a 2-passage connector, hub-point fan-out, active-node
 *  z-order, one-way arrow on the connector not the face segment) is `splitFaceLayout.ts`'s shared
 *  algorithm — the same one the "Manage split nodes" dialog's tile diagram (`TileFaceEditor`) uses,
 *  so the two never drift apart. `activeId(pointKey)` resolves which of a point's nodes currently
 *  draws on top (mirrors `postEditActiveSplitNode`/`presetActiveSplitNode` — absence means the
 *  point's first/original node). `buildSplitPassages` (NodeDto/EdgeDto) and
 *  `buildPresetSplitPassages` (PresetEndpoint, presetSelectors.ts) are both thin adapters over
 *  this. */
export type SplitPassagesResult = {
  passages: SplitPassage[];
  /** Faces where every one of a split point's nodes explicitly has `wall` — drawn as one plain
   *  solid wall spanning the whole face, same as an ordinary (non-split) wall, since it isn't
   *  attributable to any single node's color. Mirrors `TileFaceEditor`'s `allWall` case. */
  wallFaces: { v0: { x: number; y: number }; v1: { x: number; y: number } }[];
  /** One entry per split point recognized as a "bridge"/"diagonal divider" topology (GitHub issue
   *  #294) — always populated regardless of `SplitStyleOverride.specialShapes`, so the renderer
   *  decides whether to use it without a second geometry pass. Empty unless the point is degree-4
   *  with exactly 2 nodes, each a straight-through opposite-face (bridge) or adjacent-face
   *  (diagonal) pair — see `SplitSpecialShapeKind`. */
  specialShapes: SplitSpecialShape[];
};

/** The tile's own vertex index shared by two adjacent faces (GitHub issue #294's diagonal-divider
 *  shape needs the real tile corner, not a face-midpoint-to-center bend) — `edgeVerts[i]` is that
 *  face's `[vi, vj]` vertex-index pair; two adjacent faces share exactly one of those four indices.
 *  Returns `null` if the faces don't actually share a vertex (shouldn't happen for the adjacent
 *  pair `detectSplitSpecialShapeKind` already validated, but keeps this total). */
function sharedCornerIndex(edgeVerts: [number, number][], faceA: number, faceB: number): number | null {
  const [a0, a1] = edgeVerts[faceA];
  const [b0, b1] = edgeVerts[faceB];
  if (a0 === b0 || a0 === b1) return a0;
  if (a1 === b0 || a1 === b1) return a1;
  return null;
}

/** Pairs `facesA`'s two endpoints with `facesB`'s two endpoints by nearest distance (GitHub issue
 *  #294's bridge shape) — for two parallel opposite faces of a tile, this picks the "same side"
 *  pairing (left edge to left edge, right to right) so the two resulting bridge edges run side by
 *  side instead of crossing through the middle. Returns `[bIndexForA0, bIndexForA1]`. */
function nearestEndpointPairing(
  a: { v0: { x: number; y: number }; v1: { x: number; y: number } },
  b: { v0: { x: number; y: number }; v1: { x: number; y: number } },
): [0 | 1, 0 | 1] {
  const dist = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y);
  const straight = dist(a.v0, b.v0) + dist(a.v1, b.v1);
  const crossed = dist(a.v0, b.v1) + dist(a.v1, b.v0);
  return straight <= crossed ? [0, 1] : [1, 0];
}

type Seg = { v0: { x: number; y: number }; v1: { x: number; y: number } };
type Point = { x: number; y: number };

/** Builds the "diagonal" `SplitSpecialShape` for a straight-through/hex-diagonal wall cut, given
 *  its two real geometric endpoints — shared by the degree-4 `"diagonal"` kind and every degree-6
 *  `"hex_diagonal"` sub-case (GitHub issue #319), which differ only in *how* `corner0`/`corner1`
 *  are computed (see `buildHexDiagonalEndpoints`), not in the resulting shape's own drawing. */
function buildDiagonalShape(
  pointKey: string,
  corner0: Point,
  corner1: Point,
  throughLine?: [Point, Point],
  wallPath?: Point[],
  dividerJunctions?: Point[],
  topNodeIndex?: number,
): SplitSpecialShape {
  return {
    kind: "diagonal", pointKey, corner0, corner1, throughLine, wallPath, dividerJunctions,
    ...(topNodeIndex === undefined ? {} : { topNodeIndex }),
  };
}

/** Builds the "bridge" `SplitSpecialShape` for a through corridor (`throughFaces`, drawn as nothing
 *  — an ordinary passage) crossed by a cross corridor (`crossFaces`, drawn as the card-map bridge
 *  silhouette) — GitHub issue #294, generalized for degree-6 in #319 (a hex bridge is the exact
 *  same construction at 60° instead of 90°, `crossFaces`/`throughFaces` are just this node's own
 *  opposite-face pair either way). Both corridors' own axes pass through the same tile center (any
 *  face-midpoint to its opposite face-midpoint line always does, regular polygon or square alike),
 *  so the taper/deck geometry — centered on the corridor's own 50% point — lands exactly on the
 *  crossing point without needing the caller to say where that is. */
function buildBridgeShape(
  pointKey: string,
  throughFaces: [Seg, Seg] | null,
  crossFaces: [Seg, Seg],
  taperFrac: number = SQUARE_BRIDGE_TAPER_FRAC,
  deckWidthFrac: number = BRIDGE_DECK_WIDTH_FRAC,
): SplitSpecialShape {
  const throughLine = throughFaces ? [
    { x: (throughFaces[0].v0.x + throughFaces[0].v1.x) / 2, y: (throughFaces[0].v0.y + throughFaces[0].v1.y) / 2 },
    { x: (throughFaces[1].v0.x + throughFaces[1].v1.x) / 2, y: (throughFaces[1].v0.y + throughFaces[1].v1.y) / 2 },
  ] as [Point, Point] : undefined;
  const [pairB0, pairB1] = nearestEndpointPairing(crossFaces[0], crossFaces[1]);
  const endsAt = (face: Seg, slot: 0 | 1) => (slot === 0 ? face.v0 : face.v1);
  const end0 = { v0: endsAt(crossFaces[0], 0), v1: endsAt(crossFaces[0], 1) };
  const end1 = { v0: endsAt(crossFaces[1], pairB0), v1: endsAt(crossFaces[1], pairB1) };

  const mid0 = { x: (end0.v0.x + end0.v1.x) / 2, y: (end0.v0.y + end0.v1.y) / 2 };
  const mid1 = { x: (end1.v0.x + end1.v1.x) / 2, y: (end1.v0.y + end1.v1.y) / 2 };
  const along = (t: number) => ({ x: mid0.x + (mid1.x - mid0.x) * t, y: mid0.y + (mid1.y - mid0.y) * t });

  const buildEdge = (endAt0: Point, endAt1: Point): [Point, Point, Point, Point] => {
    const lerp = (p: Point, q: Point, t: number) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
    const axisAt0 = along(0), axisAt20 = along(taperFrac), axisAt80 = along(1 - taperFrac), axisAt100 = along(1);
    const narrowedAt = (axisPoint: Point, fullWidthEnd: Point, fullWidthAxis: Point) =>
      lerp(axisPoint, { x: axisPoint.x + (fullWidthEnd.x - fullWidthAxis.x), y: axisPoint.y + (fullWidthEnd.y - fullWidthAxis.y) }, deckWidthFrac);
    return [endAt0, narrowedAt(axisAt20, endAt0, axisAt0), narrowedAt(axisAt80, endAt1, axisAt100), endAt1];
  };

  return {
    kind: "bridge",
    pointKey,
    crossFaces: [end0, end1],
    edge0: buildEdge(end0.v0, end1.v0),
    edge1: buildEdge(end0.v1, end1.v1),
    throughLine,
  };
}

/** This node's own connected face indices against the dense `faceKindsByNode[nodeIndex]` matrix —
 *  same convention `connectedFaceIndices`/`detectSplitSpecialShapeKind` use ("wall" = not connected). */
function connectedFaces(kinds: SplitFaceKind[]): number[] {
  return kinds.reduce<number[]>((acc, k, i) => (k === "wall" ? acc : [...acc, i]), []);
}

/** Real geometric endpoints for a `"hex_diagonal"` wall cut between `node0`'s and `node1`'s own
 *  face pairs (GitHub issue #319) — unlike the degree-4 `"diagonal"` case (always exactly 2 shared
 *  tile corners between the two nodes' faces, since each node's pair is always adjacent to the
 *  other's on both sides), a hex 2-node non-opposite split has 3 possible layouts depending on how
 *  many real corners the two nodes' faces actually share:
 *
 *  - **2 shared corners** (both pairs adjacent, e.g. faces `{1,2}`/`{4,5}`): identical to the
 *    degree-4 case — the wall runs corner-to-corner, the two "gap" faces (unused by either node,
 *    `{0,3}` in the example) sit untouched as plain walls on either side.
 *  - **1 shared corner** (one pair adjacent, one a skip-pair, e.g. faces `{0,2}`/`{4,5}`): only one
 *    of the two gap faces (`{1,3}` in the example) actually borders both nodes — the other (face
 *    `1`, between node 0's own two faces `0`/`2`) is entirely inside node 0's own territory, not a
 *    real node0/node1 boundary. The wall runs from that one real corner, through the tile center,
 *    to the opposite point on the tile boundary (the midpoint of the far side, mirroring the
 *    corner-through-center construction the degree-4 diagonal doesn't need but a lone corner does
 *    to still reach across the whole tile).
 *  - **0 shared corners** (both pairs skip-pairs, e.g. faces `{0,2}`/`{3,5}`): neither gap face
 *    borders both nodes on its own — each gap face (`1` and `4`) sits entirely inside one node's own
 *    territory. By the same left-right symmetry that makes every opposite-face axis pass through
 *    the tile center, the two gap faces' own midpoints sit symmetric about the center too — the
 *    wall runs directly between them.
 *
 *  Returns `null` if `getCellVertices` has no data for this tessellation (shouldn't happen for a
 *  hex point, kept total for symmetry with the degree-4 caller). */
function buildHexDiagonalEndpoints(
  px: number,
  py: number,
  cfg: FieldConfig,
  edgeVerts: [number, number][],
  faceInputs: Seg[],
  node0Faces: number[],
  node1Faces: number[],
): [Point, Point] | null {
  const verts = getCellVertices(px, py, cfg);
  if (!verts) return null;

  const cornerIdxs: number[] = [];
  for (const fa of node0Faces) {
    for (const fb of node1Faces) {
      const c = sharedCornerIndex(edgeVerts, fa, fb);
      if (c !== null) cornerIdxs.push(c);
    }
  }

  if (cornerIdxs.length === 2) return [verts[cornerIdxs[0]], verts[cornerIdxs[1]]];

  const degree = faceInputs.length;
  const usedFaces = new Set([...node0Faces, ...node1Faces]);
  const gapFaces = Array.from({ length: degree }, (_, i) => i).filter((i) => !usedFaces.has(i));
  const faceMid = (i: number) => ({ x: (faceInputs[i].v0.x + faceInputs[i].v1.x) / 2, y: (faceInputs[i].v0.y + faceInputs[i].v1.y) / 2 });

  if (cornerIdxs.length === 1 && gapFaces.length === 2) {
    const center = getCellCenter(px, py, cfg);
    const corner = verts[cornerIdxs[0]];
    // The far endpoint mirrors `corner` through the tile center — same distance, opposite side —
    // landing on the tile's own boundary regardless of which gap face happens to sit there.
    const far = { x: center.x * 2 - corner.x, y: center.y * 2 - corner.y };
    return [corner, far];
  }

  if (cornerIdxs.length === 0 && gapFaces.length === 2) {
    return [faceMid(gapFaces[0]), faceMid(gapFaces[1])];
  }

  return null;
}

export function buildSplitPassagesCore<Id>(
  nodes: SplitPassageNode<Id>[],
  directedPairs: { from: Id; to: Id }[],
  cfg: FieldConfig,
  specialNodeIds: ReadonlySet<Id> = new Set(),
  activeId: (pointKey: string) => Id | undefined = () => undefined,
  defaultKind: SplitFaceKind = "wall",
  wallPairs: ReadonlySet<string> = new Set(),
  nodeColors: readonly number[] = canvas.node.splitSlots,
  /** When set (GitHub issue #314 follow-up, "Vector by corridors" only), each `wallSegments[i]`'s
   *  own `center` is repositioned to divide this width — the ordinary corridor's own `thickness`,
   *  not the whole shared face — evenly among every node sharing that face, centered on the face's
   *  own midpoint. Corridor mode has no wall geometry to visually divide a face into per-node
   *  shares in the first place, so several connections leaving the same face should read as sitting
   *  side by side within the corridor that actually runs through it, not spread across the face's
   *  full (often much wider) span. `undefined` (every other caller) keeps the original
   *  divide-the-whole-face behavior `computeSplitFaceLayouts` already computes. */
  corridorConnectorWidth?: number,
): SplitPassagesResult {
  const nodeById = new Map<Id, SplitPassageNode<Id>>();
  for (const n of nodes) nodeById.set(n.id, n);

  const directed = new Set<string>();
  for (const { from, to } of directedPairs) {
    if (!nodeById.has(from) || !nodeById.has(to)) continue;
    directed.add(`${String(from)}->${String(to)}`);
  }

  const byPoint = new Map<string, SplitPassageNode<Id>[]>();
  for (const n of nodes) {
    const key = `${n.x},${n.y}`;
    const list = byPoint.get(key);
    if (list) list.push(n); else byPoint.set(key, [n]);
  }

  // The neighboring point across a face may itself be split — several of its nodes can each have
  // their own independent connection across that same geometric face. Picking a single "the"
  // neighbor node per face (as opposed to per node-pair) would check `node`'s directed/wall state
  // against the wrong neighbor whenever `node`'s real partner isn't that neighbor point's first
  // node, silently falling back to `defaultKind` even though a real decided connection exists
  // (reported bug: a passage added to a specific slot rendered as still-optional because the
  // lookup checked the neighbor's original node instead). `other` must be resolved per node pair.
  //
  // A directed (passage/one-way) match wins outright over a `wall` match — a blueprint apply
  // explicitly walls off every neighbor candidate the resolved partner didn't pick (GitHub issue
  // #243 follow-up), so the *first* candidate in iteration order with a `wall` entry isn't
  // necessarily `node`'s real connecting neighbor; a later candidate might still hold the real
  // passage. Only fall back to a `wall` match if no candidate has a directed entry at all.
  const resolveOther = (node: SplitPassageNode<Id>, neighbors: SplitPassageNode<Id>[]): SplitPassageNode<Id> => {
    let wallFallback: SplitPassageNode<Id> | null = null;
    for (const candidate of neighbors) {
      if (
        directed.has(`${String(node.id)}->${String(candidate.id)}`) ||
        directed.has(`${String(candidate.id)}->${String(node.id)}`)
      ) {
        return candidate;
      }
      if (wallPairs.has(`${String(node.id)}<->${String(candidate.id)}`)) wallFallback ??= candidate;
    }
    return wallFallback ?? neighbors[0];
  };

  const result: SplitPassage[] = [];
  const wallFaces: { v0: { x: number; y: number }; v1: { x: number; y: number } }[] = [];
  const specialShapes: SplitSpecialShape[] = [];

  for (const [pointKey, pointNodes] of byPoint) {
    if (pointNodes.length <= 1) continue; // unsplit point — rendered by buildMazeWalls instead

    const [px, py] = [pointNodes[0].x, pointNodes[0].y];
    const center = getCellCenter(px, py, cfg);
    const count = pointNodes.length;
    const { offsets, edgeVerts } = getNeighborData(cfg, px, py);

    // Per-offset-index face geometry + per-node kind, mirroring TileFaceEditor's model exactly —
    // a face this point has no actual geometric neighbor for (or whose neighbor isn't in `nodes`)
    // is skipped entirely (empty per-node kinds list, not a `SplitFaceKind` value — "none" doesn't
    // exist as a per-node decision state, see `splitFaceLayout.ts`).
    const faceInputs: { v0: { x: number; y: number }; v1: { x: number; y: number } }[] = [];
    const kindsByFace: { nodeIndex: number; kind: SplitFaceKind }[][] = [];

    for (const [dx, dy] of offsets) {
      const neighbors = byPoint.get(`${px + dx},${py + dy}`);
      const anyNeighbor = neighbors?.[0];
      const seg = anyNeighbor ? getSharedEdgeSegment([px, py], [anyNeighbor.x, anyNeighbor.y], cfg) : null;
      if (!neighbors || !seg) { faceInputs.push({ v0: center, v1: center }); kindsByFace.push([]); continue; }

      faceInputs.push(seg);
      kindsByFace.push(pointNodes.map((node, nodeIndex) => {
        const other = resolveOther(node, neighbors);
        const fwd = directed.has(`${String(node.id)}->${String(other.id)}`);
        const bwd = directed.has(`${String(other.id)}->${String(node.id)}`);
        const isWallPair = wallPairs.has(`${String(node.id)}<->${String(other.id)}`);
        const kind: SplitFaceKind = fwd && bwd ? "passage" : fwd ? "one_way_out" : bwd ? "one_way_in" : isWallPair ? "wall" : defaultKind;
        return { nodeIndex, kind };
      }));
    }

    // Per-node face-kind matrix (dense, `"wall"` for a face this point has no geometric neighbor
    // for) — only needed for special-shape detection, not the ordinary segment/connector layout,
    // which works off the sparse `kindsByFace` above.
    const faceKindsByNode: SplitFaceKind[][] = pointNodes.map((_, nodeIndex) =>
      kindsByFace.map((faceKinds) => faceKinds.find((k) => k.nodeIndex === nodeIndex)?.kind ?? "wall"),
    );
    const shapeBinding = splitShapeBinding(cfg, px, py);
    const specialShapeKind = detectSplitSpecialShapeKind(faceKindsByNode, shapeBinding);
    // Template-specific faces below are canonical; `lc` maps one to the cell's own face.
    const lc = (canonical: number): number => shapeBinding?.localOfCanonical[canonical] ?? canonical;
    const canonicalConnectedFaces = (kinds: SplitFaceKind[]): number[] =>
      shapeBinding ? connectedFaces(canonicalFaceKinds(shapeBinding, kinds)) : connectedFaces(kinds);
    if (specialShapeKind === "cairo_diagonal_divider") {
      // Cairo's canonical template separates canonical faces 1-2 from 3-4. Its divider is a
      // deliberately bent wall: from the corner shared by 1/2 to the tile centre, then to the
      // corner shared by 3/4. The node assignments themselves are independent of row order.
      const verts = getCellVertices(px, py, cfg);
      if (verts) {
        const cornerFor = (faceA: number, faceB: number): Point | null => {
          const index = sharedCornerIndex(edgeVerts, faceA, faceB);
          return index === null ? null : verts[index];
        };
        const corner12 = cornerFor(lc(1), lc(2));
        const corner34 = cornerFor(lc(3), lc(4));
        if (corner12 && corner34) {
          const topNodeIndex = faceKindsByNode.findIndex((kinds) => {
            const faces = canonicalConnectedFaces(kinds);
            return faces.length === 2 && faces.includes(2) && faces.includes(3);
          });
          specialShapes.push(buildDiagonalShape(
            pointKey, corner12, corner34, undefined, [corner12, center, corner34], undefined,
            topNodeIndex >= 0 ? topNodeIndex : undefined,
          ));
        }
      }
    } else if (specialShapeKind === "cairo_adjacent_divider") {
      // The adjacent Cairo template has two wall pieces: the complete canonical side 0 and a
      // straight segment from the corner shared by faces 2/3 to the midpoint of side 0.
      const verts = getCellVertices(px, py, cfg);
      if (verts) {
        const edge0 = edgeVerts[lc(0)];
        const corner23Index = sharedCornerIndex(edgeVerts, lc(2), lc(3));
        if (edge0 && corner23Index !== null) {
          const side0Start = verts[edge0[0]], side0End = verts[edge0[1]];
          const side0Mid = { x: (side0Start.x + side0End.x) / 2, y: (side0Start.y + side0End.y) / 2 };
          const corner23 = verts[corner23Index];
          specialShapes.push(buildDiagonalShape(pointKey, side0Start, side0End, undefined, [side0Start, side0End]));
          specialShapes.push(buildDiagonalShape(pointKey, corner23, side0Mid, undefined, [corner23, side0Mid]));
        }
      }
    } else if (specialShapeKind === "cairo_bridge_2x3") {
      // The Cairo 2x3 bridge is a tapered bridge from canonical face 1 to face 4. The other node
      // owns three faces. The corridor renderer keeps that three-face fork as an underlay and
      // emits only the bridge node's deck as the dedicated special shape.
      const perNodeFaces = faceKindsByNode.map(canonicalConnectedFaces);
      const isPair = (faces: number[], a: number, b: number) => faces.length === 2 && faces.includes(a) && faces.includes(b);
      const bridgeNodeIndex = perNodeFaces.findIndex((faces) => isPair(faces, 1, 4));
      if (bridgeNodeIndex >= 0) {
        const bridgeFaces = [faceInputs[lc(1)], faceInputs[lc(4)]] as [Seg, Seg];
        specialShapes.push(buildBridgeShape(
          pointKey,
          null,
          bridgeFaces,
          SQUARE_BRIDGE_TAPER_FRAC,
          BRIDGE_DECK_WIDTH_FRAC,
        ));
      }
    } else if (specialShapeKind === "diagonal") {
      // The diagonal must run through the two corners where a face of node 0 meets a face of
      // node 1 (so every one of node 0's faces ends up strictly on one side, node 1's on the
      // other) — NOT the corner shared between node 0's own two faces (that corner is where both
      // of node 0's own faces meet each other, putting it on the wrong side of the cut). With the
      // faces split into two adjacent pairs there are exactly two such node0/node1 corners
      // (degree 4: each node's pair borders the other's pair on both sides going around the tile).
      const node0Faces = connectedFaces(faceKindsByNode[0]);
      const node1Faces = connectedFaces(faceKindsByNode[1]);
      const verts = getCellVertices(px, py, cfg);
      const cornerIdxs: number[] = [];
      for (const fa of node0Faces) {
        for (const fb of node1Faces) {
          const c = sharedCornerIndex(edgeVerts, fa, fb);
          if (c !== null) cornerIdxs.push(c);
        }
      }
      if (verts && cornerIdxs.length === 2) {
        specialShapes.push(buildDiagonalShape(pointKey, verts[cornerIdxs[0]], verts[cornerIdxs[1]]));
      }
    } else if (specialShapeKind === "bridge" || specialShapeKind === "hex_bridge") {
      // Node 0 is the "through" pair (opposite faces, drawn as nothing — an ordinary passage);
      // node 1 is the "cross" pair, drawn as the bridge's own two edges: full width at the cross
      // faces (100%), narrowing to a flat 60%-wide deck. Square bridges use their original gradual
      // 20% taper; hex bridges use the sharper triple-bridge angle (GitHub issue #446).
      const throughIdx = connectedFaces(faceKindsByNode[0]);
      const crossIdx = connectedFaces(faceKindsByNode[1]);
      specialShapes.push(buildBridgeShape(
        pointKey,
        [faceInputs[throughIdx[0]], faceInputs[throughIdx[1]]],
        [faceInputs[crossIdx[0]], faceInputs[crossIdx[1]]],
        specialShapeKind === "hex_bridge" ? HEX_BRIDGE_TAPER_FRAC : SQUARE_BRIDGE_TAPER_FRAC,
      ));
    } else if (specialShapeKind === "hex_diagonal") {
      // GitHub issue #319 — two nodes, neither an opposite-face pair. `buildHexDiagonalEndpoints`
      // picks the right construction (corner-to-corner / corner-through-center / gap-to-gap)
      // depending on how many real tile corners the two nodes' faces actually share.
      const node0Faces = connectedFaces(faceKindsByNode[0]);
      const node1Faces = connectedFaces(faceKindsByNode[1]);
      const endpoints = buildHexDiagonalEndpoints(px, py, cfg, edgeVerts, faceInputs, node0Faces, node1Faces);
      if (endpoints) specialShapes.push(buildDiagonalShape(pointKey, endpoints[0], endpoints[1]));
    } else if (specialShapeKind === "hex_diagonal_divider") {
      // The middle face of each adjacent triple does not change its boundary. Use the exact same
      // separator as the equivalent two skip-face passages (0-2 / 3-5 and their rotations).
      const outerFaces = (kinds: SplitFaceKind[]): number[] | null =>
        adjacentTripleOuterFaces(canonicalConnectedFaces(kinds), offsets.length)?.map(lc) ?? null;
      const node0Faces = outerFaces(faceKindsByNode[0]);
      const node1Faces = outerFaces(faceKindsByNode[1]);
      if (node0Faces && node1Faces) {
        const endpoints = buildHexDiagonalEndpoints(px, py, cfg, edgeVerts, faceInputs, node0Faces, node1Faces);
        const allFaces = faceKindsByNode.map(connectedFaces);
        const dividerJunctions = allFaces.map((faces, slot) =>
          specialSplitNodePoint(cfg, center, "hex_diagonal_divider", faces, slot, allFaces, [px, py]),
        );
        if (endpoints && dividerJunctions.every((point): point is Point => point !== null)) {
          specialShapes.push(buildDiagonalShape(
            pointKey, endpoints[0], endpoints[1], undefined, undefined, dividerJunctions,
          ));
        }
      }
    } else if (specialShapeKind === "hex_triple_bridge") {
      // GitHub issue #319 — three nodes, all opposite-face pairs, three corridors crossing at the
      // same tile center point (every opposite-face axis of a regular hexagon passes through its
      // own center). Node 0 is the "through" pair for node 1's bridge (drawn first, plain); node 1
      // is in turn the "through" pair for node 2's bridge — since both crossings sit at the exact
      // same point, node 2's own bridge silhouette (drawn last, on top) already reads as clearing
      // both of the corridors underneath it, without needing to know about node 0 separately.
      const idx0 = connectedFaces(faceKindsByNode[0]);
      const idx1 = connectedFaces(faceKindsByNode[1]);
      const idx2 = connectedFaces(faceKindsByNode[2]);
      const faces0: [Seg, Seg] = [faceInputs[idx0[0]], faceInputs[idx0[1]]];
      const faces1: [Seg, Seg] = [faceInputs[idx1[0]], faceInputs[idx1[1]]];
      const faces2: [Seg, Seg] = [faceInputs[idx2[0]], faceInputs[idx2[1]]];
      specialShapes.push(buildBridgeShape(pointKey, faces0, faces1, TRIPLE_BRIDGE_TAPER_FRAC, TRIPLE_BRIDGE_DECK_WIDTH_FRAC));
      specialShapes.push(buildBridgeShape(pointKey, faces0, faces2, TRIPLE_BRIDGE_TAPER_FRAC, TRIPLE_BRIDGE_DECK_WIDTH_FRAC));
    } else if (specialShapeKind === "hex_triple_corridor") {
      // GitHub issue #319 — three nodes: one opposite-face pair (the "through" corridor, drawn as
      // an ordinary passage, same role as `"bridge"`'s node 0) plus two adjacent-face pairs, each
      // separated from the through corridor by the straight chord joining the two real tile
      // corners where those nodes meet. For faces `{0,3}` through, `{1,2}` and `{4,5}` adjacent,
      // these are chords `1-3` and `4-0`; reflecting one corner through the center incorrectly
      // collapses both boundaries onto the single opposite-corner diagonal `0-3`.
      const perNodeFaces = faceKindsByNode.map((kinds) => connectedFaces(kinds));
      const degree = offsets.length;
      const throughNodeIdx = faceKindsByNode.map(canonicalConnectedFaces)
        .findIndex(([a, b]) => circularDist(a, b, degree) === degree / 2);
      const verts = getCellVertices(px, py, cfg);
      if (verts && throughNodeIdx >= 0) {
        let diameter = 0;
        for (let a = 0; a < verts.length; a++) {
          for (let b = a + 1; b < verts.length; b++) {
            diameter = Math.max(diameter, Math.hypot(verts[b].x - verts[a].x, verts[b].y - verts[a].y));
          }
        }
        const centerOffset = diameter / 6;
        const bendTowardCenter = (a: Point, b: Point): Point => {
          const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
          const dx = mx - center.x, dy = my - center.y;
          const len = Math.hypot(dx, dy) || 1;
          return { x: center.x + dx / len * centerOffset, y: center.y + dy / len * centerOffset };
        };
        const throughFaces = perNodeFaces[throughNodeIdx];
        const throughFace0 = faceInputs[throughFaces[0]];
        const throughFace1 = faceInputs[throughFaces[1]];
        const throughLine: [Point, Point] = [
          { x: (throughFace0.v0.x + throughFace0.v1.x) / 2, y: (throughFace0.v0.y + throughFace0.v1.y) / 2 },
          { x: (throughFace1.v0.x + throughFace1.v1.x) / 2, y: (throughFace1.v0.y + throughFace1.v1.y) / 2 },
        ];
        let firstEntry = true;
        for (let i = 0; i < 3; i++) {
          if (i === throughNodeIdx) continue;
          const cornerFaces = perNodeFaces[i];
          const cornerIndices: number[] = [];
          for (const fa of cornerFaces) {
            for (const fb of throughFaces) {
              const c = sharedCornerIndex(edgeVerts, fa, fb);
              if (c !== null && !cornerIndices.includes(c)) cornerIndices.push(c);
            }
          }
          if (cornerIndices.length !== 2) continue;
          const corner0 = verts[cornerIndices[0]], corner1 = verts[cornerIndices[1]];
          specialShapes.push(buildDiagonalShape(
            pointKey,
            corner0,
            corner1,
            firstEntry ? throughLine : undefined,
            [corner0, bendTowardCenter(corner0, corner1), corner1],
          ));
          firstEntry = false;
        }
      }
    }

    const activeNodeId = activeId(pointKey);
    const activeIndexRaw = activeNodeId === undefined ? -1 : pointNodes.findIndex((n) => n.id === activeNodeId);
    const activeIndex = activeIndexRaw < 0 ? null : activeIndexRaw;
    const faceLayouts = computeSplitFaceLayouts(faceInputs, kindsByFace, activeIndex);
    faceLayouts.forEach((layout, i) => { if (layout.allWall) wallFaces.push(faceInputs[i]); });
    const hubRadius = SPLIT_HUB_RADIUS;
    const rotationRad = (getSplitCircleRotationDeg(cfg) * Math.PI) / 180;
    const nodeConnectors = computeSplitConnectors(
      faceLayouts, count, activeIndex, center, hubRadius, rotationRad,
      (nodeIndex) => specialNodeIds.has(pointNodes[nodeIndex].id),
    );

    for (const { nodeIndex, lines } of nodeConnectors) {
      if (lines.length === 0) continue; // no connections — draws nothing

      const color = splitSlotColor(nodeIndex, nodeColors);
      const wallSegments = faceLayouts
        .flatMap((layout, faceIndex) => layout.segments
          .map((s, indexInFace) => ({ s, faceIndex, indexInFace, faceCount: layout.segments.length }))
          .filter((entry) => entry.s.nodeIndex === nodeIndex))
        .map(({ s, faceIndex, indexInFace, faceCount }) => {
          let center = { x: (s.v0.x + s.v1.x) / 2, y: (s.v0.y + s.v1.y) / 2 };
          if (corridorConnectorWidth !== undefined) {
            // Divide the ordinary corridor's own width (not the whole face) evenly among every
            // node sharing this face, centered on the face's own midpoint — see this function's
            // own `corridorConnectorWidth` doc comment.
            const face = faceInputs[faceIndex];
            const faceMid = { x: (face.v0.x + face.v1.x) / 2, y: (face.v0.y + face.v1.y) / 2 };
            const fdx = face.v1.x - face.v0.x, fdy = face.v1.y - face.v0.y;
            const flen = Math.hypot(fdx, fdy) || 1;
            const ux = fdx / flen, uy = fdy / flen;
            const t = (indexInFace + 0.5) / faceCount - 0.5; // -0.5..0.5, centered
            const offset = t * corridorConnectorWidth;
            center = { x: faceMid.x + ux * offset, y: faceMid.y + uy * offset };
          }
          return {
            v0: s.v0, v1: s.v1, center,
            isUndefined: s.kind === "undefined",
            oneWayOut: s.kind === "one_way_out" ? true : s.kind === "one_way_in" ? false : undefined,
            atFaceStart: s.atFaceStart,
            atFaceEnd: s.atFaceEnd,
          };
        });
      const connectors = lines.map((line) => ({ from: line.from, to: line.to, oneWayOut: line.oneWayOut, isUndefined: line.isUndefined }));

      result.push({ color, nodeIndex, pointKey, center, wallSegments, connectors });
    }
  }

  return { passages: result, wallFaces, specialShapes };
}

/** Post-generation adapter over `buildSplitPassagesCore` — `NodeDto`'s own `id: number` is the
 *  identity, `EdgeDto`'s teleport-kind entries are filtered out before reaching the core (a
 *  teleport must not read as an open passage, same rule as `buildMazeWalls`). `activeSplitNode`
 *  (mirrors `postEditActiveSplitNode`) resolves which of a point's nodes draws on top (GitHub
 *  issue #234 follow-up) — a `split` entry is resolved to its real `NodeId` via
 *  `buildSplitNodeResolver` (needs `postEditDraftSplitPoints` for the point's sorted slotId
 *  order); absence for a point means its original (first) node. `nodeColors` (default
 *  `canvas.node.splitSlots`) overrides `splitSlotColor`'s per-slot palette — GitHub issue #294,
 *  used by `VectorByWallsRenderer` to expose split-node colors as a user setting. See
 *  `buildSplitPassagesCore`'s doc comment for the shared algorithm. */
export function buildSplitPassages(
  nodes: NodeDto[],
  edges: EdgeDto[],
  cfg: FieldConfig,
  specialNodeIds: ReadonlySet<number> = new Set(),
  activeSplitNode: Record<string, PostEditEndpoint> = {},
  postEditDraftSplitPoints: Record<string, number[]> = {},
  nodeColors: readonly number[] = canvas.node.splitSlots,
  /** See `buildSplitPassagesCore`'s own doc comment — "Vector by corridors" only. */
  corridorConnectorWidth?: number,
): SplitPassagesResult {
  const directedPairs = edges.filter((e) => e.kind !== "teleport").map((e) => ({ from: e.from, to: e.to }));

  const nodeMap = new Map<string, number[]>();
  for (const n of nodes) {
    const key = `${n.x},${n.y}`;
    const list = nodeMap.get(key);
    if (list) list.push(n.id); else nodeMap.set(key, [n.id]);
  }
  const resolveSplit = buildSplitNodeResolver(nodeMap, postEditDraftSplitPoints);
  const activeId = (pointKey: string): number | undefined => {
    const active = activeSplitNode[pointKey];
    if (!active) return undefined;
    return resolveEndpoint(active, resolveSplit);
  };

  return buildSplitPassagesCore(nodes, directedPairs, cfg, specialNodeIds, activeId, "wall", new Set(), nodeColors, corridorConnectorWidth);
}

/** World positions of every split junction's own tile center (`SplitPassage.center`, one per
 *  distinct `pointKey` — GitHub issue #518) — for the teleport connector router's own avoidance set,
 *  so an orthogonal connector doesn't visibly cut through a split junction's hub the same way it
 *  used to cut through start/finish before GitHub issue #300/#516. */
export function buildSplitJunctionPositions(passages: SplitPassage[]): [number, number][] {
  const seen = new Set<string>();
  const result: [number, number][] = [];
  for (const p of passages) {
    if (seen.has(p.pointKey)) continue;
    seen.add(p.pointKey);
    result.push([p.center.x, p.center.y]);
  }
  return result;
}
