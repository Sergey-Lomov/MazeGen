import type { NodeDto, EdgeDto } from "../../../wasm/types";
import type { FieldConfig as TessellationConfig } from "../../../fieldConfig";
import type { SplitPassage, SplitSpecialShape } from "../../renderers/types";
import { getCellVertices, getSplitCircleRotationDeg, buildNodePositions, getCellCenter, getNeighborData, getSharedEdgeSegment, SPLIT_HUB_RADIUS } from "../../tessellationGeometry";
import { computeSplitFaceLayouts, computeSplitConnectors, detectSplitSpecialShapeKind, type SplitFaceKind } from "../../splitFaceLayout";
import { canvas } from "../../colorTokens";
import { splitSlotColor } from "../../colorUtils";
import { resolveEndpoint, buildSplitNodeResolver, type PostEditEndpoint } from "../../postEditEndpoint";

/** Bridge shape proportions (GitHub issue #294) — the taper (narrowing/widening) each take the
 *  first/last 20% of the tile's length; the flat deck spans the middle 60% at 60% of the cross
 *  corridor's full width. */
const BRIDGE_TAPER_FRAC = 0.2;
const BRIDGE_DECK_WIDTH_FRAC = 0.6;

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
 *  color list to what the current maze actually needs. */
export function maxSplitNodeCount(nodes: NodeDto[]): number {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const key = `${n.x},${n.y}`;
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
  cfg: TessellationConfig,
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

export function buildSplitPassagesCore<Id>(
  nodes: SplitPassageNode<Id>[],
  directedPairs: { from: Id; to: Id }[],
  cfg: TessellationConfig,
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
    const specialShapeKind = detectSplitSpecialShapeKind(faceKindsByNode);
    if (specialShapeKind === "diagonal") {
      // The diagonal must run through the two corners where a face of node 0 meets a face of
      // node 1 (so every one of node 0's faces ends up strictly on one side, node 1's on the
      // other) — NOT the corner shared between node 0's own two faces (that corner is where both
      // of node 0's own faces meet each other, putting it on the wrong side of the cut). With the
      // faces split into two adjacent pairs there are exactly two such node0/node1 corners
      // (degree 4: each node's pair borders the other's pair on both sides going around the tile).
      const node0Faces = faceKindsByNode[0].reduce<number[]>((acc, k, i) => (k === "wall" ? acc : [...acc, i]), []);
      const node1Faces = faceKindsByNode[1].reduce<number[]>((acc, k, i) => (k === "wall" ? acc : [...acc, i]), []);
      const verts = getCellVertices(px, py, cfg);
      const cornerIdxs: number[] = [];
      for (const fa of node0Faces) {
        for (const fb of node1Faces) {
          const c = sharedCornerIndex(edgeVerts, fa, fb);
          if (c !== null) cornerIdxs.push(c);
        }
      }
      if (verts && cornerIdxs.length === 2) {
        specialShapes.push({ kind: "diagonal", pointKey, corner0: verts[cornerIdxs[0]], corner1: verts[cornerIdxs[1]] });
      }
    } else if (specialShapeKind === "bridge") {
      // Node 0 is the "through" pair (opposite faces, drawn as nothing — an ordinary passage);
      // node 1 is the "cross" pair, drawn as the bridge's own two edges: full width at the cross
      // faces (100%), narrowing to 60% over the tile's first/last 20% of length, a flat 60%-wide
      // deck across the middle 60%.
      const crossIdx = faceKindsByNode[1].reduce<number[]>((acc, k, i) => (k === "wall" ? acc : [...acc, i]), []);
      const crossFaces: [{ v0: { x: number; y: number }; v1: { x: number; y: number } }, { v0: { x: number; y: number }; v1: { x: number; y: number } }] =
        [faceInputs[crossIdx[0]], faceInputs[crossIdx[1]]];
      // Node 0's own opposite-face pair — the through corridor's real axis (GitHub issue #314),
      // distinct from `crossFaces` (node 1's own pair) computed above.
      const throughIdx = faceKindsByNode[0].reduce<number[]>((acc, k, i) => (k === "wall" ? acc : [...acc, i]), []);
      const throughFace0 = faceInputs[throughIdx[0]];
      const throughFace1 = faceInputs[throughIdx[1]];
      const throughMid0 = { x: (throughFace0.v0.x + throughFace0.v1.x) / 2, y: (throughFace0.v0.y + throughFace0.v1.y) / 2 };
      const throughMid1 = { x: (throughFace1.v0.x + throughFace1.v1.x) / 2, y: (throughFace1.v0.y + throughFace1.v1.y) / 2 };
      const [pairB0, pairB1] = nearestEndpointPairing(crossFaces[0], crossFaces[1]);
      const endsAt = (face: typeof crossFaces[0], slot: 0 | 1) => (slot === 0 ? face.v0 : face.v1);
      const end0 = { v0: endsAt(crossFaces[0], 0), v1: endsAt(crossFaces[0], 1) };
      const end1 = { v0: endsAt(crossFaces[1], pairB0), v1: endsAt(crossFaces[1], pairB1) };

      // Corridor axis: face-midpoint to face-midpoint (not `.v0`, which needn't lie on the axis) —
      // `along(t)` interpolates a point at fraction `t` of the corridor's own length.
      const mid0 = { x: (end0.v0.x + end0.v1.x) / 2, y: (end0.v0.y + end0.v1.y) / 2 };
      const mid1 = { x: (end1.v0.x + end1.v1.x) / 2, y: (end1.v0.y + end1.v1.y) / 2 };
      const along = (t: number) => ({ x: mid0.x + (mid1.x - mid0.x) * t, y: mid0.y + (mid1.y - mid0.y) * t });

      // Each edge's own perpendicular half-width at a given axis point, scaled by `widthFrac`
      // (1.0 at the cross faces, `BRIDGE_DECK_WIDTH_FRAC` on the flat deck) — computed per side
      // (`sideSign` = +1 for edge0, -1 for edge1) from that side's own full-width offset at the
      // matching cross face, so an asymmetric face (off-center split point) still narrows evenly.
      const buildEdge = (endAt0: { x: number; y: number }, endAt1: { x: number; y: number }): [
        { x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number },
      ] => {
        const lerp = (p: { x: number; y: number }, q: { x: number; y: number }, t: number) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
        const axisAt0 = along(0), axisAt20 = along(BRIDGE_TAPER_FRAC), axisAt80 = along(1 - BRIDGE_TAPER_FRAC), axisAt100 = along(1);
        const narrowedAt = (axisPoint: { x: number; y: number }, fullWidthEnd: { x: number; y: number }, fullWidthAxis: { x: number; y: number }) =>
          lerp(axisPoint, { x: axisPoint.x + (fullWidthEnd.x - fullWidthAxis.x), y: axisPoint.y + (fullWidthEnd.y - fullWidthAxis.y) }, BRIDGE_DECK_WIDTH_FRAC);
        return [endAt0, narrowedAt(axisAt20, endAt0, axisAt0), narrowedAt(axisAt80, endAt1, axisAt100), endAt1];
      };

      specialShapes.push({
        kind: "bridge",
        pointKey,
        crossFaces: [end0, end1],
        edge0: buildEdge(end0.v0, end1.v0),
        edge1: buildEdge(end0.v1, end1.v1),
        throughLine: [throughMid0, throughMid1],
      });
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

      result.push({ color, pointKey, center, wallSegments, connectors });
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
  cfg: TessellationConfig,
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
