import type { NodeDto, EdgeDto } from "../../../wasm/types";
import type { FieldConfig } from "../../../fieldConfig";
import { getCellCenter, getCellVertices, getFaceEdgeSegment, getNeighborData, getSharedEdgeSegment } from "../../tessellationGeometry";
import { buildCellSet } from "../sharedSelectors";
import { getSeamModel } from "../seams";
import { buildSplitPointKeys } from "./split";
import { selectFloorScopedMaze } from "./state";

/** One `buildCorridorSegments` result entry — `oneWayDir` mirrors `WallEdge.oneWayDir`'s own
 *  convention (GitHub issue #312): unset for a bidirectional passage, else a unit vector along the
 *  segment pointing in the passage's actual allowed direction (from `v0`'s cell to `v1`'s, or the
 *  reverse), for `VectorByCorridorsRenderer`'s one-way chevron-row indicator. `fromNode`/`toNode`
 *  (GitHub issue #312 follow-up) are the two cells' own node ids, matching `v0`/`v1` respectively —
 *  lets `computeVectorByCorridorsWarnings`' overflow check flag exactly the edges this function
 *  actually draws a segment for (geometric neighbors, not split points, per this function's own
 *  exclusions) instead of re-deriving a looser approximation from the raw edge list. */
export type CorridorSegment = {
  v0: { x: number; y: number };
  v1: { x: number; y: number };
  /** Centre of the actual shared face used as the corridor mouth. */
  faceMidpoint?: { x: number; y: number };
  /** Unit normal to the shared face, pointing out of `v0`'s cell. */
  faceNormal?: { x: number; y: number };
  /** Real shared-face length, used by contour width clamping. */
  faceLength?: number;
  /** The shared face's flattened boundary; three or more points mark a curved face. */
  facePolyline?: { x: number; y: number }[];
  /** Cell polygons (arc sides flattened, so possibly concave), used by the contour engine's containment guard. */
  cellVertices0?: { x: number; y: number }[];
  cellVertices1?: { x: number; y: number }[];
  oneWayDir?: { dx: number; dy: number };
  fromNode: number;
  toNode: number;
  /** `v1` lands on a shared face's own midpoint instead of the neighbor cell's center, because that
   *  neighbor is a split point (GitHub issue #314 follow-up) or the face is a glued seam face (the
   *  segment is this side's own copy, `fromNode`/`toNode` still name both cells) — the renderer needs this to cap that
   *  end `butt` instead of its usual round/square cap, since the diagonal/bridge shape drawn there
   *  by `buildSplitPassages` can bow or narrow away from this segment's own straight axis, uncovering
   *  a round/square cap's extra reach past the tile boundary. */
  v1TouchesSplit?: boolean;
};

/** Center-to-center line segments for every basic passage between geometrically adjacent cells —
 *  the "Vector by corridors" render mode's own maze reading (GitHub issue #310), the inverse of
 *  `buildMazeWalls`' "gap in the wall" reading. `oneWayDir` (GitHub issue #312) distinguishes a
 *  one-way passage from a bidirectional one, same directed-set approach `buildMazeWalls` uses for
 *  its own `oneWayDir`. A split-to-split passage is skipped entirely — drawn instead by
 *  `buildSplitPassages`' own connector geometry (GitHub issue #314). A plain-to-split passage still
 *  draws its plain side's own segment, but shortened from the plain cell's center to the shared
 *  face's own midpoint (`getSharedEdgeSegment`) instead of running all the way to the split cell's
 *  center — that midpoint is exactly where `buildSplitPassages`' own per-node face share is
 *  centered (`SplitPassage.wallSegments[*].center`), so the two renderer's own line stubs meet
 *  edge-to-edge with no gap and no overlap. Teleport edges are never geometric neighbors of each
 *  other in `getNeighborData`'s sense, so they're naturally excluded without any extra `kind`
 *  check. */
export function buildCorridorSegments(
  nodes: NodeDto[],
  edges: EdgeDto[],
  cfg: FieldConfig,
): CorridorSegment[] {
  const nodeById = new Map<number, NodeDto>();
  const nodeByCoord = new Map<string, NodeDto>();
  for (const n of nodes) {
    nodeById.set(n.id, n);
    nodeByCoord.set(`${n.x},${n.y}`, n);
  }

  const directed = new Set<string>();
  for (const e of edges) {
    if (e.kind === "teleport") continue;
    const from = nodeById.get(e.from);
    const to = nodeById.get(e.to);
    if (!from || !to) continue;
    directed.add(`${from.x},${from.y}->${to.x},${to.y}`);
  }

  const cells: [number, number][] = nodes.map((n) => [n.x, n.y]);
  const cellSet = buildCellSet(cells);
  const splitPointKeys = buildSplitPointKeys(nodes);
  const seams = getSeamModel(cfg);
  const result: CorridorSegment[] = [];

  for (const n of nodes) {
    const selfKey = `${n.x},${n.y}`;
    const selfSplit = splitPointKeys.has(selfKey);
    const { offsets } = getNeighborData(cfg, n.x, n.y);
    for (const [dx, dy] of offsets) {
      const nx = n.x + dx;
      const ny = n.y + dy;
      const neighborKey = `${nx},${ny}`;
      if (!cellSet.has(neighborKey)) continue;
      const neighborSplit = splitPointKeys.has(neighborKey);
      if (selfSplit && neighborSplit) continue; // split-to-split — drawn by buildSplitPassages instead
      if (selfSplit) continue; // the plain neighbor's own pass below draws this face instead

      // A face with a split cell on either side is always drawn from the plain cell's own pass,
      // regardless of `x`/`y` ordering — the split side never contributes a "half" of its own
      // (its whole face-to-center span belongs to `buildSplitPassages`' per-node share instead), so
      // the usual `ownsEdge` dedup (which assumes both sides draw identical geometry and only one
      // should) doesn't apply here.
      const ownsEdge = neighborSplit || n.x < nx || (n.x === nx && n.y < ny);
      if (!ownsEdge) continue;

      const fwd = directed.has(`${n.x},${n.y}->${nx},${ny}`);
      const bwd = directed.has(`${nx},${ny}->${n.x},${n.y}`);
      if (!fwd && !bwd) continue;

      const neighborNode = nodeByCoord.get(neighborKey);
      if (!neighborNode) continue;

      const v0 = getCellCenter(n.x, n.y, cfg);
      // A plain cell neighboring a split point stops at the shared face's own midpoint instead of
      // reaching all the way to the split cell's center — `buildSplitPassages`' own per-node share
      // (`SplitPassage.wallSegments[*].center`) picks up from there.
      let v1 = getCellCenter(nx, ny, cfg);
      // Every production segment carries its real shared face and both convex cell polygons. This
      // keeps the renderer on the tessellation-independent contour engine for square, hex, triangle,
      // Cairo, and future convex cell families alike.
      const sharedFace = getSharedEdgeSegment([n.x, n.y], [nx, ny], cfg);
      const faceMidpoint = sharedFace?.contact;
      const faceLength = sharedFace
        ? Math.hypot(sharedFace.v1.x - sharedFace.v0.x, sharedFace.v1.y - sharedFace.v0.y)
        : undefined;
      let faceNormal: { x: number; y: number } | undefined;
      if (sharedFace && faceMidpoint && faceLength && faceLength > 0) {
        let nx = -(sharedFace.v1.y - sharedFace.v0.y) / faceLength;
        let ny = (sharedFace.v1.x - sharedFace.v0.x) / faceLength;
        if (nx * (faceMidpoint.x - v0.x) + ny * (faceMidpoint.y - v0.y) < 0) {
          nx = -nx;
          ny = -ny;
        }
        faceNormal = { x: nx, y: ny };
      }
      if (neighborSplit) {
        if (faceMidpoint) v1 = faceMidpoint;
      }

      let oneWayDir: { dx: number; dy: number } | undefined;
      if (fwd !== bwd) {
        const tdx = fwd ? v1.x - v0.x : v0.x - v1.x;
        const tdy = fwd ? v1.y - v0.y : v0.y - v1.y;
        const len = Math.sqrt(tdx * tdx + tdy * tdy);
        if (len > 0) oneWayDir = { dx: tdx / len, dy: tdy / len };
      }

      result.push({
        v0,
        v1,
        ...(faceMidpoint && faceNormal ? {
          faceMidpoint,
          faceNormal,
          faceLength,
          ...(sharedFace && sharedFace.polyline.length >= 3 ? { facePolyline: sharedFace.polyline.map(([px, py]) => ({ x: px, y: py })) } : {}),
          cellVertices0: getCellVertices(n.x, n.y, cfg) ?? undefined,
          cellVertices1: getCellVertices(nx, ny, cfg) ?? undefined,
        } : {}),
        oneWayDir,
        fromNode: n.id,
        toNode: neighborNode.id,
        v1TouchesSplit: neighborSplit,
      });
    }

    // A passage through a glued face is drawn once per side: from this cell's center to the contact
    // point of its own face, as a segment that belongs to this cell alone (like the plain side of a
    // split neighbor). No segment runs to the partner's center and the partner is not duplicated.
    if (selfSplit) continue;
    for (const half of seams.halfEdgesOf([n.x, n.y])) {
      const [px, py] = half.partnerCell;
      const partnerNode = nodeByCoord.get(`${px},${py}`);
      if (!partnerNode || splitPointKeys.has(`${px},${py}`)) continue;
      const fwd = directed.has(`${selfKey}->${px},${py}`);
      const bwd = directed.has(`${px},${py}->${selfKey}`);
      if (!fwd && !bwd) continue;
      const face = getFaceEdgeSegment([n.x, n.y], half.faceIdx, cfg);
      if (!face) continue;
      const v0 = getCellCenter(n.x, n.y, cfg);
      const v1 = face.contact;
      const faceLength = Math.hypot(face.v1.x - face.v0.x, face.v1.y - face.v0.y);
      let faceNormal: { x: number; y: number } | undefined;
      if (faceLength > 0) {
        faceNormal = { x: -(face.v1.y - face.v0.y) / faceLength, y: (face.v1.x - face.v0.x) / faceLength };
        if (faceNormal.x * (v1.x - v0.x) + faceNormal.y * (v1.y - v0.y) < 0) faceNormal = { x: -faceNormal.x, y: -faceNormal.y };
      }
      let oneWayDir: { dx: number; dy: number } | undefined;
      const len = Math.hypot(v1.x - v0.x, v1.y - v0.y);
      if (fwd !== bwd && len > 0) {
        // Along `v0 -> v1` is out of this cell: the source side points out, the partner side in.
        const sign = fwd ? 1 : -1;
        oneWayDir = { dx: (sign * (v1.x - v0.x)) / len, dy: (sign * (v1.y - v0.y)) / len };
      }
      result.push({
        v0,
        v1,
        ...(faceNormal ? {
          faceMidpoint: face.contact,
          faceNormal,
          faceLength,
          ...(face.polyline.length >= 3 ? { facePolyline: face.polyline.map(([x, y]) => ({ x, y })) } : {}),
          cellVertices0: getCellVertices(n.x, n.y, cfg) ?? undefined,
        } : {}),
        oneWayDir,
        fromNode: n.id,
        toNode: partnerNode.id,
        v1TouchesSplit: true,
      });
    }
  }

  return result;
}

/** World positions of every one-way corridor chevron row's own center (`VectorByCorridorsRenderer`'s
 *  chevron-row indicator, centered on `CorridorSegment.oneWayDir`'s own segment midpoint — GitHub
 *  issue #518) — for the teleport connector router's own avoidance set, mirroring
 *  `buildOneWayWallIndicatorPositions`'s equivalent for "Vector by walls"' plain wall indicator. */
export function buildOneWayCorridorIndicatorPositions(segments: CorridorSegment[]): [number, number][] {
  const result: [number, number][] = [];
  for (const seg of segments) {
    if (!seg.oneWayDir) continue;
    result.push([(seg.v0.x + seg.v1.x) / 2, (seg.v0.y + seg.v1.y) / 2]);
  }
  return result;
}

/** Length of the shortest face carrying a passage, or `Infinity` when there is none. The contour
 *  engine never draws a corridor wider than this face. */
export function shortestCorridorFace(segments: readonly CorridorSegment[]): number {
  let shortest = Infinity;
  for (const segment of segments) {
    if (segment.faceLength !== undefined && segment.faceLength > 0) shortest = Math.min(shortest, segment.faceLength);
  }
  return shortest;
}

/** `shortestCorridorFace` over every floor, so all floors draw one corridor width. */
export function shortestCorridorFaceAcrossFloors(
  nodes: NodeDto[],
  edges: EdgeDto[],
  floors: { id: string }[],
  cfg: FieldConfig,
): number {
  let shortest = Infinity;
  for (const floor of floors) {
    const scoped = selectFloorScopedMaze(nodes, edges, floors, floor.id);
    shortest = Math.min(shortest, shortestCorridorFace(buildCorridorSegments(scoped.nodes, scoped.edges, cfg)));
  }
  return shortest;
}
