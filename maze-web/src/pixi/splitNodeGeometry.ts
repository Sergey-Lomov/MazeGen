import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { TILE_SIZE } from "./constants";
import type { SplitSpecialShapeKind } from "./renderers/types";
import { adjacentTripleOuterFaces, detectSplitSpecialShapeKind, connectedFaceIndices, type SplitFaceKind } from "./splitFaceLayout";
import { getSplitCircleRotationDeg, getCellCenter, getCellVertices, getNeighborData, type Pos } from "./tessellationGeometry";

/** A split point's hub-point circle radius (GitHub issue #223) — 1/2 of the cell's own radius. */
export const SPLIT_HUB_RADIUS = TILE_SIZE / 4;

/** A split point's per-slot point on its hub circle — shared by every renderer/selector that draws
 *  or positions a split-tile's individual nodes (`getSplitAwareNodePosition`, `buildSplitPassages`,
 *  the graph renderers' `buildNodePositions`, GitHub issue #263) so they never drift apart (same
 *  radius/rotation/slot formula). `slotIndex`/`slotCount` are a node's position and count within
 *  its own point's node group, not `NodeDto.i` (a stable creation-order id that can leave gaps
 *  after a sibling removal — using it directly would space remaining siblings unevenly). */
export function splitHubPoint(
  center: Pos,
  slotIndex: number,
  slotCount: number,
  cfg: TessellationConfig,
): Pos {
  const rotationRad = (getSplitCircleRotationDeg(cfg) * Math.PI) / 180;
  const angle = rotationRad + (2 * Math.PI * slotIndex) / slotCount;
  return { x: center.x + SPLIT_HUB_RADIUS * Math.cos(angle), y: center.y + SPLIT_HUB_RADIUS * Math.sin(angle) };
}

/** Per-tessellation, per-shape-kind node-point offsets for a split point recognized as a "special
 *  shape" (`SplitSpecialShapeKind`, GitHub issue #294/#318) — a node whose two connected faces
 *  match a recognized bridge/diagonal topology gets a point matching where that shape visually
 *  reads as "belonging" to it, instead of `splitHubPoint`'s generic evenly-spaced circle position.
 *  Square shapes use hand-authored constants matching their fixed visual designs (GitHub issue
 *  #318). A hex `hex_diagonal` node lies on the bisector between the two faces its corridor
 *  connects, at the same inner radius as the midpoint of a skip-face pair (GitHub issue #442).
 *  `null` for a tessellation/kind/pair with no dedicated rule — callers fall back to
 *  `splitHubPoint`.
 *
 *  Square face order is `getNeighborData`'s `offsets` index: `0=E, 1=N, 2=W, 3=S` (screen
 *  coordinates, Y down). `TILE_SIZE = 1` (scaled by the caller).
 *
 *  `"diagonal"`: the node's point is offset toward the centroid of its own half of the tile — the
 *  triangle formed by its two connected faces' midpoints and the tile corner between them, scaled
 *  down to `1/4 * TILE_SIZE` (GitHub issue #318 follow-up: `1/3` sat too close to the corner, `1/6`
 *  overcorrected too close to center, `1/5` still slightly too close to center).
 *
 *  `"bridge"`: keyed by slot index (`0` or `1`, not face identity) — slot 1 sits at the plain tile
 *  center; slot 0 sits offset `0.25 * TILE_SIZE` from center along *its own* face-pair axis (toward
 *  its first face), landing the point on the bridge's own lane instead of the crossing point at
 *  tile center (GitHub issue #318, follow-up: slot 0/1 were swapped, then the offset axis was
 *  fixed to use slot 0's own faces instead of slot 1's — the bridge's own lane runs along slot 0's
 *  own face-pair axis, not slot 1's). */
const SQUARE_DIAGONAL_NODE_OFFSET: Record<string, Pos> = {
  "0,1": { x: 1 / 4, y: -1 / 4 }, // E,N
  "1,2": { x: -1 / 4, y: -1 / 4 }, // N,W
  "2,3": { x: -1 / 4, y: 1 / 4 }, // W,S
  "3,0": { x: 1 / 4, y: 1 / 4 }, // S,E
};

/** Unit direction vector for each square face index (`0=E,1=N,2=W,3=S`), screen coordinates. */
const SQUARE_FACE_DIRECTION: Pos[] = [{ x: 1, y: 0 }, { x: 0, y: -1 }, { x: -1, y: 0 }, { x: 0, y: 1 }];

const SQUARE_BRIDGE_CROSS_OFFSET_FRAC = 0.25;

/** Absolute node point for a node recognized as part of a `SplitSpecialShapeKind` — `null` if this
 *  tessellation/kind/face-pair combination has no dedicated rule (caller falls back to
 *  `splitHubPoint`). `center` is the split point's own tile center (`getCellCenter`). `faces` is
 *  this node's own two connected face indices (`getNeighborData`'s ordering), `slotIndex` this
 *  node's position within its point's node list (only meaningful/needed for square `"bridge"`). */
export function specialSplitNodePoint(
  cfg: TessellationConfig,
  center: Pos,
  kind: SplitSpecialShapeKind,
  faces: number[],
  slotIndex: number,
  allFaces?: number[][],
): Pos | null {
  if (cfg.type === "hex_parallelogram" || cfg.type === "hex_hexagon" || cfg.type === "hex_custom") {
    const vertices = getCellVertices(0, 0, cfg);
    const { edgeVerts } = getNeighborData(cfg, 0, 0);
    if (!vertices) return null;
    const faceCenter = (face: number): Pos => {
      const [a, b] = edgeVerts[face];
      return {
        x: (vertices[a].x + vertices[b].x) / 2,
        y: (vertices[a].y + vertices[b].y) / 2,
      };
    };

    const localCenter = getCellCenter(0, 0, cfg);
    if (kind === "hex_diagonal_divider") {
      const outerFaces = adjacentTripleOuterFaces(faces, 6);
      if (!outerFaces) return null;
      faces = outerFaces;
      kind = "hex_diagonal";
    }

    if (kind === "hex_bridge") {
      // Node 1 is the bridge deck rendered on top; its anchor stays at the crossing. Node 0 is
      // underneath and moves toward the nearer of the two vertices midway around the perimeter
      // between the deck's opposite sides.
      if (slotIndex === 1) return center;
      const upperFaces = allFaces?.[1];
      if (!upperFaces) return null;
      const firstUpperFace = Math.min(...upperFaces);
      const candidateIndices = [(firstUpperFace + 2) % 6, (firstUpperFace + 5) % 6];
      const lowerFaceCenter = faceCenter(faces[0]);
      const vertexIndex = candidateIndices.reduce((best, candidate) => {
        const distance = (index: number) => Math.hypot(
          vertices[index].x - lowerFaceCenter.x,
          vertices[index].y - lowerFaceCenter.y,
        );
        return distance(candidate) < distance(best) ? candidate : best;
      });
      const vertex = vertices[vertexIndex];
      return {
        x: center.x + (vertex.x - localCenter.x) * 2 / 3,
        y: center.y + (vertex.y - localCenter.y) * 2 / 3,
      };
    }

    if (kind === "hex_triple_corridor") {
      // The axis joins the two tile corners at which each side corridor's adjacent faces meet, so
      // it rotates with the topology instead of being tied to one fixed pair of global faces.
      const sidePairs = allFaces?.filter(([a, b]) => {
        const distance = Math.abs(a - b);
        return Math.min(distance, 6 - distance) === 1;
      });
      if (sidePairs?.length !== 2) return null;
      const sharedVertex = ([a, b]: number[]): Pos | null => {
        const [a0, a1] = edgeVerts[a], [b0, b1] = edgeVerts[b];
        const index = a0 === b0 || a0 === b1 ? a0 : a1 === b0 || a1 === b1 ? a1 : null;
        return index === null ? null : vertices[index];
      };
      const from = sharedVertex(sidePairs[0]), to = sharedVertex(sidePairs[1]);
      if (!from || !to) return null;
      const throughIndex = allFaces?.findIndex(([a, b]) => Math.abs(a - b) === 3) ?? -1;
      if (throughIndex < 0) return null;
      const positions = [1 / 6, 1 / 2, 5 / 6];
      [positions[throughIndex], positions[1]] = [positions[1], positions[throughIndex]];
      const t = positions[slotIndex];
      if (t === undefined) return null;
      return {
        x: center.x + from.x + (to.x - from.x) * t - localCenter.x,
        y: center.y + from.y + (to.y - from.y) * t - localCenter.y,
      };
    }

    if (kind === "hex_triple_bridge") {
      const reversed = slotIndex === 0 || slotIndex === 2;
      const from = faceCenter(faces[reversed ? 1 : 0]);
      const to = faceCenter(faces[reversed ? 0 : 1]);
      const t = 5 / 6;
      return {
        x: center.x + from.x + (to.x - from.x) * t - localCenter.x,
        y: center.y + from.y + (to.y - from.y) * t - localCenter.y,
      };
    }

    if (kind !== "hex_diagonal") return null;

    const a = faceCenter(faces[0]);
    const b = faceCenter(faces[1]);
    const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const midpointOffset = { x: midpoint.x - localCenter.x, y: midpoint.y - localCenter.y };
    const skipA = faceCenter(0);
    const skipB = faceCenter(2);
    const skipRadius = Math.hypot(
      (skipA.x + skipB.x) / 2 - localCenter.x,
      (skipA.y + skipB.y) / 2 - localCenter.y,
    );
    const midpointRadius = Math.hypot(midpointOffset.x, midpointOffset.y);
    if (midpointRadius === 0) return null;
    const scale = skipRadius / midpointRadius;
    return {
      x: center.x + midpointOffset.x * scale,
      y: center.y + midpointOffset.y * scale,
    };
  }

  if (cfg.type !== "square" && cfg.type !== "square_custom") return null;

  if (kind === "diagonal") {
    const [a, b] = [...faces].sort((x, y) => x - y);
    const offset = SQUARE_DIAGONAL_NODE_OFFSET[`${a},${b}`];
    return offset ? { x: center.x + offset.x * TILE_SIZE, y: center.y + offset.y * TILE_SIZE } : null;
  }

  // "bridge" — slot 1 sits at plain tile center; slot 0 offsets along its own face-pair axis.
  if (slotIndex === 1) return center;

  const dir = SQUARE_FACE_DIRECTION[faces[0]];
  return { x: center.x + dir.x * SQUARE_BRIDGE_CROSS_OFFSET_FRAC * TILE_SIZE, y: center.y + dir.y * SQUARE_BRIDGE_CROSS_OFFSET_FRAC * TILE_SIZE };
}

/** A degree-4 split point's two nodes' per-face kinds (`getNeighborData`'s ordering) — a face's
 *  kind for a node comes from the directed edge(s) between it and any node at the geometrically
 *  neighboring point across that face: `passage` (edges both ways), `one_way_out` (only this
 *  node -> neighbor), `one_way_in` (only neighbor -> this node), `wall` (no edge). Distinguishes
 *  one-way from two-way (GitHub issue #477 — a one-way connection disqualifies the point from every
 *  special shape, so `detectSplitSpecialShapeKind` must see it), but never emits `undefined`,
 *  unlike `buildSplitPassagesCore`'s own `kindsByFace`/`resolveOther`. Shared
 *  by `getSplitAwareNodePosition` (`mazeSelectors.ts`) and `buildNodePositions` below (GitHub issue
 *  #318). `byTile` (keyed `"${x}:${y}"`, same convention as `buildNodePositions`' own grouping) and
 *  `directed` are precomputed once by the caller and reused across every split point in a single
 *  `buildNodePositions` call, instead of each call re-scanning the full node list / rebuilding the
 *  edge-pair Set from scratch (GitHub issue #318 follow-up: this was previously O(nodes) /
 *  O(edges) per split point, turning a single `buildNodePositions` call into O(splitPoints ×
 *  (nodes + edges)) work). */
export function splitPointFaceKindsByNode<Id extends string | number>(
  pointNodes: { id: Id; x: number; y: number }[],
  byTile: ReadonlyMap<string, { id: Id; x: number; y: number }[]>,
  directed: ReadonlySet<string>,
  cfg: TessellationConfig,
): SplitFaceKind[][] {
  const { offsets } = getNeighborData(cfg, pointNodes[0].x, pointNodes[0].y);
  return pointNodes.map((pn) =>
    offsets.map(([dx, dy]) => {
      const neighbors = byTile.get(`${pn.x + dx}:${pn.y + dy}`) ?? [];
      let fwd = false;
      let bwd = false;
      for (const nb of neighbors) {
        if (directed.has(`${pn.id}->${nb.id}`)) fwd = true;
        if (directed.has(`${nb.id}->${pn.id}`)) bwd = true;
      }
      return fwd && bwd ? "passage" : fwd ? "one_way_out" : bwd ? "one_way_in" : "wall";
    }),
  );
}

/** Builds a node-id -> screen position map, placing nodes that share the same tile (split-tile
 * siblings, GitHub issue #263) on their point's hub circle (`splitHubPoint`) instead of stacking
 * them on top of each other at the shared `getCellCenter` — the exact same radius/rotation/slot
 * formula the post-generation canvas uses to draw split passages (`buildSplitPassagesCore` in
 * `mazeSelectors.ts`) and node-anchored markers (`getSplitAwareNodePosition`), so a split node's
 * graph position always matches where its passages/markers are actually drawn. A node recognized
 * as part of a `SplitSpecialShapeKind` (bridge/diagonal, GitHub issue #318) gets
 * `specialSplitNodePoint`'s dedicated point instead, same rule `getSplitAwareNodePosition` applies
 * — needs `directedPairs` (from `edges`, teleports pre-filtered by the caller) to detect it;
 * omit/pass `[]` to always use the generic hub position. Lives here (not in `BaseGraphRenderer.ts`)
 * since it's pure tessellation geometry consumed by several unrelated overlays, not just the
 * graph-renderer hierarchy. */
export function buildNodePositions<Id extends string | number>(
  nodes: { id: Id; x: number; y: number }[],
  cfg: TessellationConfig,
  directedPairs: { from: Id; to: Id }[] = [],
): Map<Id, Pos> {
  const byTile = new Map<string, typeof nodes>();
  for (const node of nodes) {
    const key = `${node.x}:${node.y}`;
    let group = byTile.get(key);
    if (!group) { group = []; byTile.set(key, group); }
    group.push(node);
  }

  // Built once per call, reused across every split point below — `splitPointFaceKindsByNode`
  // previously rebuilt an equivalent Set (and re-scanned the full node list) once *per split
  // point*, turning this into O(splitPoints × (nodes + edges)) work (GitHub issue #318 follow-up).
  const directed = directedPairs.length > 0
    ? new Set(directedPairs.map(({ from, to }) => `${from}->${to}`))
    : null;

  const nodePos = new Map<Id, Pos>();
  for (const group of byTile.values()) {
    const center = getCellCenter(group[0].x, group[0].y, cfg);
    if (group.length <= 1) {
      nodePos.set(group[0].id, center);
      continue;
    }

    let faceKindsByNode: SplitFaceKind[][] | null = null;
    let kind: SplitSpecialShapeKind | null = null;
    if ((group.length === 2 || group.length === 3) && directed) {
      faceKindsByNode = splitPointFaceKindsByNode(group, byTile, directed, cfg);
      kind = detectSplitSpecialShapeKind(faceKindsByNode);
    }

    const connectedFacesByNode = kind && faceKindsByNode
      ? faceKindsByNode.map(connectedFaceIndices)
      : null;

    for (let i = 0; i < group.length; i++) {
      if (kind && connectedFacesByNode) {
        const p = specialSplitNodePoint(cfg, center, kind, connectedFacesByNode[i], i, connectedFacesByNode);
        if (p) { nodePos.set(group[i].id, p); continue; }
      }
      nodePos.set(group[i].id, splitHubPoint(center, i, group.length, cfg));
    }
  }
  return nodePos;
}
