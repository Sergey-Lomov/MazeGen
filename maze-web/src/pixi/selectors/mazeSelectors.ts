import type { NodeDto, EdgeDto, IssueDto } from "../../wasm/types";
import type { MazeState, PostEditEdge } from "../../store/mazeStore";
import type { FieldConfig as TessellationConfig } from "../../fieldConfig";
import type { WallEdge, MarkerData, MarkerShape, PassageKind, TeleportEdge, SplitPassage, SplitSpecialShape, SplitSpecialShapeKind } from "../renderers/types";
import type { NodeEdgeHighlight } from "../renderers/NodeEdgeHighlightRenderer";
import { getCellCenter, getCellVertices, getNeighborData, getSplitCircleRotationDeg, getSharedEdgeSegment, splitHubPoint, SPLIT_HUB_RADIUS } from "../tessellationGeometry";
import { computeSplitFaceLayouts, computeSplitConnectors, type SplitFaceKind } from "../splitFaceLayout";
import { buildCellSet } from "./sharedSelectors";
import { NODE_RADIUS, WALL_THICKNESS } from "../renderConstants";
import { canvas } from "../colorTokens";
import { splitSlotColor } from "../colorUtils";
import { resolveEndpoint, buildSplitNodeResolver, type PostEditEndpoint } from "../postEditEndpoint";

/** Bridge shape proportions (GitHub issue #294) — the taper (narrowing/widening) each take the
 *  first/last 20% of the tile's length; the flat deck spans the middle 60% at 60% of the cross
 *  corridor's full width. */
const BRIDGE_TAPER_FRAC = 0.2;
const BRIDGE_DECK_WIDTH_FRAC = 0.6;

// Teleport edges are never part of `postEditEdges` — they're tracked separately (see
// `postEditDraftTeleportEdges`/`postEditTeleportEdges` in storeTypes.ts) since a Teleport and a
// Basic edge can coexist in the same direction between the same pair, which the `Record<from-to,
// PostEditEdge>` shape used here can't represent. Callers needing both must concatenate
// `postEditEdgesToDto(...)` with the teleport list themselves.
//
// `resolveSplit` resolves a `split` endpoint to a real node id (see `postEditEndpoint.ts`'s doc
// comment) — an entry with an unresolved endpoint (a split node added but not yet confirmed) is
// silently dropped, same "nothing to draw yet" pattern used elsewhere on this boundary.
export function postEditEdgesToDto(
  postEditEdges: Record<string, PostEditEdge> | null,
  resolveSplit: (point: [number, number], slotId: number) => number | undefined,
): EdgeDto[] {
  if (postEditEdges === null) return [];
  const result: EdgeDto[] = [];
  for (const e of Object.values(postEditEdges)) {
    if (e.kind === "wall") continue;
    const from = resolveEndpoint(e.from, resolveSplit);
    const to = resolveEndpoint(e.to, resolveSplit);
    if (from === undefined || to === undefined) continue;
    result.push({ from, to, kind: "basic" });
  }
  return result;
}

// A cell is "closed" (filled as a wall) only when it has no connection at all — including a
// teleport-only connection. A teleport in/out is a valid way to enter/exit the cell even though
// it renders no wall opening on any geometric side (see buildMazeWalls, which deliberately
// ignores teleport edges for the opposite reason: a teleport must not fake an open passage
// between geometric neighbors). Both kinds count as "connected" here.
//
// A split point (GitHub issue #221) can have more than one `NodeDto` at the same (x,y) — the
// original node plus each extra split node. Grouping by cell before checking connectivity is
// required: filtering `nodes` directly (one entry per *node*, not per *cell*) would mark the cell
// closed whenever any single one of its nodes happens to have no edges (e.g. the original node's
// direct passage was walled off, but a split node added at the same point has a passage of its
// own) — the point as a whole is still open, so the cell must not render as a wall.
export function buildClosedCells(nodes: NodeDto[], edges: EdgeDto[]): [number, number][] {
  const connected = new Set<number>();
  for (const e of edges) { connected.add(e.from); connected.add(e.to); }
  const anyConnectedByCell = new Map<string, boolean>();
  const cellCoords = new Map<string, [number, number]>();
  for (const n of nodes) {
    const key = `${n.x},${n.y}`;
    cellCoords.set(key, [n.x, n.y]);
    anyConnectedByCell.set(key, (anyConnectedByCell.get(key) ?? false) || connected.has(n.id));
  }
  const closed: [number, number][] = [];
  for (const [key, isConnected] of anyConnectedByCell) {
    if (!isConnected) closed.push(cellCoords.get(key)!);
  }
  return closed;
}

/** Points with more than one `NodeDto` (split points, GitHub issue #221/#223) — geometric edges
 *  touching one of these are excluded from `buildMazeWalls`'s ordinary reading entirely; they
 *  render exclusively via `buildSplitPassages`'s colored per-node lines instead. */
function buildSplitPointKeys(nodes: NodeDto[]): Set<string> {
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

export function buildMazeWalls(
  nodes: NodeDto[],
  edges: EdgeDto[],
  cfg: TessellationConfig,
): WallEdge[] {
  const nodeById = new Map<number, NodeDto>();
  for (const n of nodes) nodeById.set(n.id, n);

  const directed = new Set<string>();
  for (const e of edges) {
    // Teleport edges are rendered by TeleportRenderer, not as a wall opening -- a teleport
    // between geometrically adjacent cells must not read as an open passage here. `edges` may
    // contain both kinds mixed together (see EdgeDto's coexistence note), so this must filter,
    // not just trust the caller passed a basic-only list.
    if (e.kind === "teleport") continue;
    const from = nodeById.get(e.from);
    const to = nodeById.get(e.to);
    if (!from || !to) continue;
    directed.add(`${from.x},${from.y}->${to.x},${to.y}`);
  }

  const cells: [number, number][] = nodes.map(n => [n.x, n.y]);
  const cellSet = buildCellSet(cells);
  const splitPointKeys = buildSplitPointKeys(nodes);
  const result: WallEdge[] = [];

  for (const n of nodes) {
    const selfKey = `${n.x},${n.y}`;
    if (splitPointKeys.has(selfKey)) continue; // rendered by buildSplitPassages instead
    const { offsets } = getNeighborData(cfg, n.x, n.y);
    for (const [dx, dy] of offsets) {
      const nx = n.x + dx;
      const ny = n.y + dy;
      if (!cellSet.has(`${nx},${ny}`)) continue;
      if (splitPointKeys.has(`${nx},${ny}`)) continue; // rendered by buildSplitPassages instead
      const ownsEdge = n.x < nx || (n.x === nx && n.y < ny);
      if (!ownsEdge) continue;

      const fwd = directed.has(`${n.x},${n.y}->${nx},${ny}`);
      const bwd = directed.has(`${nx},${ny}->${n.x},${n.y}`);

      let kind: PassageKind;
      if (fwd && bwd) kind = "both";
      else if (fwd) kind = "forward";
      else if (bwd) kind = "backward";
      else kind = "none";

      if (kind === "both") continue; // bidirectional passage — no wall

      let oneWayDir: { dx: number; dy: number } | undefined;
      if (kind === "forward" || kind === "backward") {
        const fromCenter = getCellCenter(n.x, n.y, cfg);
        const toCenter = getCellCenter(nx, ny, cfg);
        const tdx = kind === "forward" ? toCenter.x - fromCenter.x : fromCenter.x - toCenter.x;
        const tdy = kind === "forward" ? toCenter.y - fromCenter.y : fromCenter.y - toCenter.y;
        const len = Math.sqrt(tdx * tdx + tdy * tdy);
        if (len > 0) oneWayDir = { dx: tdx / len, dy: tdy / len };
      }

      result.push({
        a: [n.x, n.y],
        b: [nx, ny],
        kind,
        style: "solid",
        oneWayDir,
      });
    }
  }

  // Boundary walls (no neighbor in cellSet) — drawn even for split points: a field-edge side is
  // never one of a split node's connected faces (`buildSplitPassagesCore` only draws segments
  // toward faces the point's nodes actually connect across), so skipping it here would leave the
  // point's outer edge with no wall at all.
  const boundaryDrawn = new Set<string>();
  for (const n of nodes) {
    const { offsets } = getNeighborData(cfg, n.x, n.y);
    for (const [dx, dy] of offsets) {
      const nx = n.x + dx;
      const ny = n.y + dy;
      if (cellSet.has(`${nx},${ny}`)) continue;
      // A split point has several nodes at the same (x,y) — dedupe so its boundary side isn't
      // pushed once per node.
      const boundaryKey = `${n.x},${n.y}->${nx},${ny}`;
      if (boundaryDrawn.has(boundaryKey)) continue;
      boundaryDrawn.add(boundaryKey);
      result.push({ a: [n.x, n.y], b: [nx, ny], kind: "none", style: "solid" });
    }
  }

  return result;
}

/** Position to draw a node-anchored entity (start/finish marker, teleport endpoint) at — the
 *  cell's own center for an ordinary (unsplit) node, or that node's hub point on the small circle
 *  `buildSplitPassages` places split-point nodes on (`splitHubPoint`, same formula), so a
 *  marker landing on a split point reads as belonging to one specific node of it, not the tile as
 *  a whole (GitHub issue #223). `nodes` must include every node of the point (not just `nodeId`)
 *  for the slot index to be computed correctly. */
export function getSplitAwareNodePosition(
  nodes: NodeDto[],
  nodeId: number,
  cfg: TessellationConfig,
): { x: number; y: number } | null {
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return null;

  const pointNodes = nodes.filter((n) => n.x === node.x && n.y === node.y);
  const center = getCellCenter(node.x, node.y, cfg);
  if (pointNodes.length <= 1) return center;

  const slotIndex = pointNodes.findIndex((n) => n.id === nodeId);
  return splitHubPoint(center, slotIndex, pointNodes.length, cfg);
}

/** Colored passages for every split point (GitHub issue #223). Each node of a split point gets
 *  its own share of the wall on every geometric face it connects across (`wallSegments`) — when
 *  several of the point's nodes connect across the same face, that face's edge is divided evenly
 *  among them in slot order, each getting one contiguous sub-segment, so independent passages
 *  sharing a face read as visually distinct rather than overlapping.
 *
 *  Those shares are then linked into `connectors`: a node with exactly 2 connected faces draws one
 *  straight line directly between its two shares' centers — no hub point, since a pure through-
 *  passage reads more naturally as one continuous corridor. Any other count (1 or 3+) draws one
 *  line per share from the node's own point on a small circle (radius = 1/2 of the cell, i.e.
 *  `TILE_SIZE / 4`, evenly distributed among the point's node count, rotated by the tessellation's
 *  own starting angle — `getSplitCircleRotationDeg`) out to that share's center; the circle itself
 *  is never drawn. A node with zero connections produces no `SplitPassage` entry at all.
 *
 *  **Straightening exception:** a node whose only two connections are both ordinary geometric
 *  faces still gets the straight 2-face connector described above — but a node carrying a
 *  start/finish marker or a teleport endpoint (`specialNodeIds`) always keeps its hub point even
 *  at exactly 2 connections, since a marker/teleport line drawn on that node's hub point would
 *  otherwise sit on a straight line with nothing marking which point along it is actually special. */
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

/** Recognizes a degree-4 split point's two-node topology as `"bridge"` (each node an
 *  opposite-face pair) or `"diagonal"` (each node an adjacent-face pair) — GitHub issue #294.
 *  `faceKindsByNode[nodeIndex]` is that node's kind on every one of the point's faces, in the same
 *  order as `offsets`/`faceInputs`; a node only counts as "connected" on a face for `passage`/
 *  `one_way_out`/`one_way_in` (mirrors `NO_OWN_SEGMENT_KINDS`). Returns `null` for anything else
 *  (wrong degree/node count, not exactly 2 connected faces per node, or connected faces that are
 *  neither opposite nor adjacent). */
function detectSplitSpecialShapeKind(faceKindsByNode: SplitFaceKind[][]): SplitSpecialShapeKind | null {
  const degree = faceKindsByNode[0]?.length ?? 0;
  if (degree !== 4 || faceKindsByNode.length !== 2) return null;

  const connectedIndices = faceKindsByNode.map((kinds) =>
    kinds.reduce<number[]>((acc, k, i) => (k === "wall" ? acc : [...acc, i]), []),
  );
  if (connectedIndices.some((idxs) => idxs.length !== 2)) return null;

  const [a0, a1] = connectedIndices[0];
  const [b0, b1] = connectedIndices[1];
  const aOpposite = Math.abs(a0 - a1) === 2;
  const bOpposite = Math.abs(b0 - b1) === 2;
  if (aOpposite !== bOpposite) return null; // one node opposite, the other adjacent — not a recognized shape
  return aOpposite ? "bridge" : "diagonal";
}

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
        .flatMap((layout) => layout.segments.filter((s) => s.nodeIndex === nodeIndex))
        .map((s) => ({
          v0: s.v0, v1: s.v1,
          center: { x: (s.v0.x + s.v1.x) / 2, y: (s.v0.y + s.v1.y) / 2 },
          isUndefined: s.kind === "undefined",
        }));
      const connectors = lines.map((line) => ({ from: line.from, to: line.to, oneWayOut: line.oneWayOut, isUndefined: line.isUndefined }));

      result.push({ color, pointKey, wallSegments, connectors });
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

  return buildSplitPassagesCore(nodes, directedPairs, cfg, specialNodeIds, activeId, "wall", new Set(), nodeColors);
}

// --- Loss-detection predicates ---
// When adding a new feature that produces user data (not analytics/read-only),
// add a predicate here and wire it into the relevant confirmation dialogs.

/** True when the user has made manual post-edit changes since the last generate/reset. */
export function selectPostEditDirty(s: Pick<MazeState, "postEditDirty">): boolean {
  return s.postEditDirty;
}

/** True when confirming tessellation would destroy data the user has entered. */
export function selectTessellationWouldLoseData(s: Pick<MazeState,
  "previewKind" | "tessellationKind" | "fieldDirty" | "presetsDirty" | "mazeDirty" | "postEditDirty"
>): boolean {
  if (s.previewKind === s.tessellationKind) return false;
  return s.fieldDirty || s.presetsDirty || s.mazeDirty || s.postEditDirty;
}

const PIPELINE_ONLY_ISSUE_KINDS = ["repair_limit_reached"];

/** Issues shown by the Analytics card/feature — `postEditAnalytics.issues` when present
 * (recomputed by `confirmPostEdit`'s `computeAnalytics`, which always re-runs right after
 * generation, even with no user edits), else `issues` (the raw post-generation snapshot).
 * `computeAnalytics` runs QC alone, with no `RepairLimits` concept, so `repair_limit_reached`
 * (pushed only by `build_maze`'s repair loop — see `Specs/repair.md`) can never appear in
 * `postEditAnalytics.issues`; carried forward from `issues` regardless of which source otherwise
 * wins, so it survives the post-generation `confirmPostEdit` recompute. Single source of truth
 * for both the bubble list (`AnalyticsFeature`) and the card status (`FeaturesPanel`) — they must
 * agree on what counts as "this maze has issues". */
export function selectAnalyticsIssues(s: Pick<MazeState, "issues" | "postEditAnalytics">): IssueDto[] {
  return [
    ...s.issues.filter((i) => PIPELINE_ONLY_ISSUE_KINDS.includes(i.kind)),
    ...(s.postEditAnalytics?.issues ?? s.issues),
  ];
}

// Collapses opposite-direction teleport-edge pairs into one entity so a two-way teleport never
// renders as two overlapping lines/arrows. `oneWay: false` when both directions exist between
// the pair; `oneWay: true` (with from/to = that edge's actual direction) when only one does.
//
// A teleport endpoint on a split point (GitHub issue #223) anchors to that node's own hub point
// (`getSplitAwareNodePosition`), not the tile's plain center — `nodeById`'s full value set stands
// in for `nodes` here (unsplit callers, e.g. GenerationRenderer, never have more than one node per
// point, so this is a no-op for them; only PostEditRenderer's split points actually differ).
export function buildTeleportEdges(
  nodeById: Map<number, NodeDto>,
  edges: EdgeDto[],
  cfg: TessellationConfig,
): TeleportEdge[] {
  const teleports = edges.filter((e) => e.kind === "teleport");
  const byPair = new Set(teleports.map((e) => `${e.from}->${e.to}`));
  const seenPairKey = new Set<string>();
  const result: TeleportEdge[] = [];
  const allNodes = Array.from(nodeById.values());

  for (const e of teleports) {
    const pairKey = e.from < e.to ? `${e.from},${e.to}` : `${e.to},${e.from}`;
    if (seenPairKey.has(pairKey)) continue;
    seenPairKey.add(pairKey);

    const reverseExists = byPair.has(`${e.to}->${e.from}`);
    const fromPos = getSplitAwareNodePosition(allNodes, e.from, cfg);
    const toPos = getSplitAwareNodePosition(allNodes, e.to, cfg);
    if (!fromPos || !toPos) continue;

    result.push({
      from: [fromPos.x, fromPos.y],
      to: [toPos.x, toPos.y],
      oneWay: !reverseExists,
      fromNode: e.from,
      toNode: e.to,
    });
  }

  return result;
}

/** Highlight for `postEditHoveredLink` (GitHub issue #237) — same "node-to-node" style
 *  `DebugRefHighlightOverlay` uses for an edge ref (`NodeEdgeHighlightRenderer`: a straight line
 *  + circle markers on each end), cell center to cell center — not the shared geometric wall
 *  segment (a teleport link has no shared face at all to draw on), and not a split point's hub
 *  point either (kept simple: this highlight only needs to say "these two cells", not distinguish
 *  which of a split point's several nodes). Silently renders nothing if either endpoint doesn't
 *  resolve (an unconfirmed split node — same "nothing to draw yet" contract as
 *  `postEditEdgesToDto`). */
export function buildLinkHoverHighlight(
  link: { from: PostEditEndpoint; to: PostEditEndpoint } | null,
  nodes: NodeDto[],
  resolveSplit: (point: [number, number], slotId: number) => number | undefined,
  cfg: TessellationConfig,
): NodeEdgeHighlight[] {
  if (!link) return [];
  const fromId = resolveEndpoint(link.from, resolveSplit);
  const toId = resolveEndpoint(link.to, resolveSplit);
  if (fromId === undefined || toId === undefined) return [];
  const fromNode = nodes.find((n) => n.id === fromId);
  const toNode = nodes.find((n) => n.id === toId);
  if (!fromNode || !toNode) return [];
  return [{
    from: getCellCenter(fromNode.x, fromNode.y, cfg),
    to: getCellCenter(toNode.x, toNode.y, cfg),
    color: canvas.fieldEditor.hover,
    alpha: 1.0,
    width: WALL_THICKNESS * 2,
    nodeRadius: NODE_RADIUS,
  }];
}

/** Same field shape as `MarkerSettings` (`storeTypes.ts`) by design — kept as its own type since
 *  this lower-level selector module must not depend on the store layer, but the identical field
 *  names let a `VectorByWallsSettings` marker be passed straight through without manual zipping. */
export interface MarkerStyle {
  shape: MarkerShape;
  fillColor: number;
  borderColor: number;
  borderWidth: number;
}

const DEFAULT_START_STYLE: MarkerStyle = { shape: "circle", fillColor: canvas.node.start, borderColor: canvas.node.start, borderWidth: 0 };
const DEFAULT_FINISH_STYLE: MarkerStyle = { shape: "circle", fillColor: canvas.node.finish, borderColor: canvas.node.finish, borderWidth: 0 };

/** A start/finish marker on a split point (GitHub issue #223) anchors to that node's own hub
 *  point (`getSplitAwareNodePosition`), not the tile's plain center — `nodeById`'s full value set
 *  stands in for `nodes` (see `buildTeleportEdges`'s doc comment for why this is safe for
 *  unsplit callers). `startStyle`/`finishStyle` default to a plain circle with no border (every
 *  caller except `VectorByWallsRenderer`, whose marker appearance is user-configurable — see
 *  GitHub issue #296), so passing them is opt-in. */
export function buildMazeMarkers(
  nodeById: Map<number, NodeDto>,
  start: number | null,
  finish: number | null,
  cfg: TessellationConfig,
  startStyle: MarkerStyle = DEFAULT_START_STYLE,
  finishStyle: MarkerStyle = DEFAULT_FINISH_STYLE,
): MarkerData[] {
  const markers: MarkerData[] = [];
  const allNodes = Array.from(nodeById.values());
  if (start !== null) {
    const c = getSplitAwareNodePosition(allNodes, start, cfg);
    if (c) {
      markers.push({
        pos: [c.x, c.y], radius: NODE_RADIUS * 1.5,
        shape: startStyle.shape, color: startStyle.fillColor, borderColor: startStyle.borderColor, borderWidth: startStyle.borderWidth,
      });
    }
  }
  if (finish !== null) {
    const c = getSplitAwareNodePosition(allNodes, finish, cfg);
    if (c) {
      markers.push({
        pos: [c.x, c.y], radius: NODE_RADIUS * 1.5,
        shape: finishStyle.shape, color: finishStyle.fillColor, borderColor: finishStyle.borderColor, borderWidth: finishStyle.borderWidth,
      });
    }
  }
  return markers;
}

