import { squareCenter, squareVertices } from "./squareGeometry";
import { hexCenter, hexVertices } from "./hexGeometry";
import { triCenter, triVertices } from "./triGeometry";
import type { TriOrientation } from "./triGeometry";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { TILE_SIZE } from "./constants";
import type { SplitPattern } from "../wasm/types";

export type Pos = { x: number; y: number };

// Square: tl=0, tr=1, br=2, bl=3. E=v1→v2, N=v0→v1, W=v3→v0, S=v2→v3
export const SQUARE_NEIGHBOR_OFFSETS: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]];
export const SQUARE_EDGE_VERTS: [number, number][] = [[1, 2], [0, 1], [3, 0], [2, 3]];
export const HEX_NEIGHBOR_OFFSETS_FLAT: [number, number][] = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
export const HEX_NEIGHBOR_OFFSETS_POINTY: [number, number][] = [[-1, 1], [-1, 0], [0, -1], [1, -1], [1, 0], [0, 1]];
export const HEX_EDGE_VERTS: [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0]];
export const TRI_NEIGHBOR_OFFSETS_UP: [number, number][] = [[-1, 0], [1, 0], [0, -1]];
export const TRI_NEIGHBOR_OFFSETS_DOWN: [number, number][] = [[-1, 0], [1, 0], [0, 1]];
export const TRI_EDGE_VERTS_UP: [number, number][] = [[0, 2], [0, 1], [1, 2]];
export const TRI_EDGE_VERTS_DOWN: [number, number][] = [[0, 2], [1, 2], [0, 1]];

/** Starting rotation (degrees, clockwise) added to a split point's per-node circle-point angles
 *  (GitHub issue #223) before evenly distributing them — a per-tessellation constant so the first
 *  node's point doesn't land exactly on a tile vertex/edge-midpoint by coincidence. Square: 45°
 *  (halfway between its 4 edge directions). Hex: 30° (halfway between its 6 edge directions).
 *  Triangle: 60° (halfway between its 3 edge directions). */
export function getSplitCircleRotationDeg(cfg: TessellationConfig): number {
  switch (cfg.type) {
    case "square":
    case "square_custom":
      return 45;
    case "hex_parallelogram":
    case "hex_hexagon":
    case "hex_custom":
      return 30;
    case "triangle_rect":
    case "triangle_triangle":
    case "triangle_hexagon":
    case "tri_custom":
      return 60;
    default:
      cfg satisfies never;
      return 0;
  }
}

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

/** Builds a node-id -> screen position map, placing nodes that share the same tile (split-tile
 * siblings, GitHub issue #263) on their point's hub circle (`splitHubPoint`) instead of stacking
 * them on top of each other at the shared `getCellCenter` — the exact same radius/rotation/slot
 * formula the post-generation canvas uses to draw split passages (`buildSplitPassagesCore` in
 * `mazeSelectors.ts`) and node-anchored markers (`getSplitAwareNodePosition`), so a split node's
 * graph position always matches where its passages/markers are actually drawn. Lives here (not in
 * `BaseGraphRenderer.ts`) since it's pure tessellation geometry consumed by several unrelated
 * overlays, not just the graph-renderer hierarchy. */
export function buildNodePositions(nodes: { id: number; x: number; y: number }[], cfg: TessellationConfig): Map<number, Pos> {
  const byTile = new Map<string, typeof nodes>();
  for (const node of nodes) {
    const key = `${node.x}:${node.y}`;
    let group = byTile.get(key);
    if (!group) { group = []; byTile.set(key, group); }
    group.push(node);
  }

  const nodePos = new Map<number, Pos>();
  for (const group of byTile.values()) {
    const center = getCellCenter(group[0].x, group[0].y, cfg);
    if (group.length <= 1) {
      nodePos.set(group[0].id, center);
      continue;
    }
    for (let i = 0; i < group.length; i++) {
      nodePos.set(group[i].id, splitHubPoint(center, i, group.length, cfg));
    }
  }
  return nodePos;
}

export function getCellVertices(x: number, y: number, cfg: TessellationConfig): Pos[] | null {
  switch (cfg.type) {
    case "square":
    case "square_custom": {
      const c = squareCenter(x, y, cfg);
      return squareVertices(c.x, c.y);
    }
    case "hex_parallelogram":
    case "hex_hexagon":
    case "hex_custom": {
      const ori = (cfg as { orientation?: "flat_top" | "pointy_top" }).orientation ?? "flat_top";
      const c = hexCenter(x, y, ori, cfg);
      return hexVertices(c.x, c.y, ori);
    }
    case "triangle_rect":
    case "triangle_triangle":
    case "triangle_hexagon":
    case "tri_custom": {
      const ori = (cfg as { orientation?: TriOrientation }).orientation ?? "r0";
      return triVertices(x, y, ori);
    }
    default:
      return null;
  }
}

/** Exact bounding box of every node's own cell polygon (via `getCellVertices`) — unlike
 * `hexGeometry.ts`'s `mazeBounds`, which pads each center by a single `halfTileSize` uniformly on
 * all 4 sides (correct only for squares), this reflects each tessellation's real per-axis extent
 * (e.g. a flat-top hex's vertical half-extent is `TILE_SIZE * sin(60°)`, not `TILE_SIZE`) — needed
 * wherever a tight, gap-free fit around the maze matters (PNG export's "edge to edge" canvas). */
export function exactCellBounds(nodes: { x: number; y: number; id: number }[], cfg: TessellationConfig): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const vertices = getCellVertices(n.x, n.y, cfg);
    if (!vertices) continue;
    for (const v of vertices) {
      if (v.x < minX) minX = v.x;
      if (v.y < minY) minY = v.y;
      if (v.x > maxX) maxX = v.x;
      if (v.y > maxY) maxY = v.y;
    }
  }
  return { minX, minY, maxX, maxY };
}

export function getCellCenter(x: number, y: number, cfg: TessellationConfig): Pos {
  switch (cfg.type) {
    case "square":
    case "square_custom":
      return squareCenter(x, y, cfg);
    case "hex_parallelogram":
    case "hex_hexagon":
    case "hex_custom": {
      const ori = (cfg as { orientation?: "flat_top" | "pointy_top" }).orientation ?? "flat_top";
      return hexCenter(x, y, ori, cfg);
    }
    case "triangle_rect":
    case "triangle_triangle":
    case "triangle_hexagon":
    case "tri_custom": {
      const ori = (cfg as { orientation?: TriOrientation }).orientation ?? "r0";
      return triCenter(x, y, ori, cfg);
    }
    default:
      return { x: 0, y: 0 };
  }
}

export function getNeighborData(
  cfg: TessellationConfig,
  x: number,
  y: number,
): { offsets: [number, number][]; edgeVerts: [number, number][] } {
  switch (cfg.type) {
    case "square":
    case "square_custom":
      return { offsets: SQUARE_NEIGHBOR_OFFSETS, edgeVerts: SQUARE_EDGE_VERTS };
    case "hex_parallelogram":
    case "hex_hexagon":
    case "hex_custom": {
      const ori = (cfg as { orientation?: string }).orientation ?? "flat_top";
      return {
        offsets: ori === "flat_top" ? HEX_NEIGHBOR_OFFSETS_FLAT : HEX_NEIGHBOR_OFFSETS_POINTY,
        edgeVerts: HEX_EDGE_VERTS,
      };
    }
    case "triangle_rect":
    case "triangle_triangle":
    case "triangle_hexagon":
    case "tri_custom": {
      const up = (x + y) % 2 === 0;
      return {
        offsets: up ? TRI_NEIGHBOR_OFFSETS_UP : TRI_NEIGHBOR_OFFSETS_DOWN,
        edgeVerts: up ? TRI_EDGE_VERTS_UP : TRI_EDGE_VERTS_DOWN,
      };
    }
    default:
      return { offsets: [], edgeVerts: [] };
  }
}

export function getCellNeighborOffsets(cfg: TessellationConfig, x: number, y: number): [number, number][] {
  return getNeighborData(cfg, x, y).offsets;
}

/** Web-authored `face_index` values (GitHub issue #222's `SplitPattern`, authored/edited via
 *  `TileFaceEditor` against `getNeighborData`'s offset ordering) use a different per-tessellation
 *  face ordering than `maze-core`'s `Tessellation::faces()` (`SquareFace::faces() = [N, S, E, W]`,
 *  `HexFace::faces() = [E, NE, NW, W, SW, SE]`) — confirmed via delta-by-delta comparison, GitHub
 *  issue #273. Triangle's web/core orderings already agree (identity), so no entry is needed there.
 *  Maps a web-order `face_index` to core's ordering; both sides keep their own internal ordering
 *  (canvas geometry/hit-testing on the web side, `step`/`face_at`/wire format on the core side). */
const SPLIT_FACE_INDEX_WEB_TO_CORE: Record<string, number[]> = {
  square: [2, 0, 3, 1],
  hex_flat_top: [0, 5, 4, 3, 2, 1],
  hex_pointy_top: [4, 3, 2, 1, 0, 5],
};

/** Converts a `SplitPattern.faces[].face_index` value from web ordering (`TileFaceEditor`'s
 *  authoring order) to `maze-core`'s `Tessellation::faces()` ordering — the one conversion point
 *  at the wasm-config-serialization boundary (`buildGenerateConfig`), so neither side's internal
 *  ordering has to change (GitHub issue #273). Identity for triangle tessellations. */
export function splitFaceIndexToCore(cfg: TessellationConfig, faceIndex: number): number {
  const t = cfg.type;
  if (t.startsWith("hex")) {
    const ori = (cfg as { orientation?: "flat_top" | "pointy_top" }).orientation ?? "flat_top";
    return SPLIT_FACE_INDEX_WEB_TO_CORE[`hex_${ori}`][faceIndex];
  }
  if (t === "square" || t === "square_custom") {
    return SPLIT_FACE_INDEX_WEB_TO_CORE.square[faceIndex];
  }
  return faceIndex;
}

/** Converts a `SplitPattern[]` from web `face_index` ordering (`TileFaceEditor`'s authoring order)
 *  to `maze-core`'s `Tessellation::faces()` ordering, via `splitFaceIndexToCore` — the single
 *  conversion point every wasm-bound `SplitPattern[]` payload must go through (GitHub issue #273):
 *  `buildGenerateConfig`'s `split_generation.patterns` (generation's own store-backed patterns) and
 *  `ParamFields.tsx`'s `pattern_list`/`split_generation_config` param editors (a repair/check
 *  strategy's own patterns, round-tripped as a raw JSON param string, entirely independent of
 *  `state.splitPatterns`). Neither the project file (`serializeProject`) nor the param string's own
 *  *stored* value are converted — only the moment a pattern list is stringified/sent to wasm. */
export function splitPatternsToCore(patterns: SplitPattern[], cfg: TessellationConfig): SplitPattern[] {
  return mapSplitPatternFaceIndices(patterns, (i) => splitFaceIndexToCore(cfg, i));
}

/** Inverse of `splitFaceIndexToCore` — core `Tessellation::faces()` ordering back to web
 *  (`TileFaceEditor`'s authoring order). Used when a `SplitPattern[]` that was already converted to
 *  core ordering (a repair/check strategy's `pattern_list`/`split_generation_config` param, GitHub
 *  issue #273) needs to be shown/edited again in `TileFaceEditor`-based UI, which only ever reads
 *  web ordering. Built once per tessellation instead of inverting per-call — each table is its own
 *  permutation, so this is just the array's own inverse index mapping. */
export function splitFaceIndexToWeb(cfg: TessellationConfig, faceIndex: number): number {
  const t = cfg.type;
  let table: number[] | undefined;
  if (t.startsWith("hex")) {
    const ori = (cfg as { orientation?: "flat_top" | "pointy_top" }).orientation ?? "flat_top";
    table = SPLIT_FACE_INDEX_WEB_TO_CORE[`hex_${ori}`];
  } else if (t === "square" || t === "square_custom") {
    table = SPLIT_FACE_INDEX_WEB_TO_CORE.square;
  }
  if (!table) return faceIndex;
  const webIndex = table.indexOf(faceIndex);
  return webIndex === -1 ? faceIndex : webIndex;
}

/** Inverse of `splitPatternsToCore` — converts a `SplitPattern[]` already in core ordering back to
 *  web ordering, for display/editing in `TileFaceEditor`-based UI (GitHub issue #273). */
export function splitPatternsToWeb(patterns: SplitPattern[], cfg: TessellationConfig): SplitPattern[] {
  return mapSplitPatternFaceIndices(patterns, (i) => splitFaceIndexToWeb(cfg, i));
}

function mapSplitPatternFaceIndices(patterns: SplitPattern[], convert: (faceIndex: number) => number): SplitPattern[] {
  return patterns.map((p) => ({
    ...p,
    faces: p.faces.map((nodeFaces) =>
      nodeFaces.map((f) => ({ ...f, face_index: convert(f.face_index) })),
    ),
  }));
}

export interface TileSide {
  /** Index into `getNeighborData`'s `offsets`/`edgeVerts` for this cell. */
  index: number;
  offset: [number, number];
  v0: Pos;
  v1: Pos;
}

/** Vertices and per-side segments of a single cell's tile shape, translated so the tile's own
 * centroid sits at the origin — used to render an isolated "large tile" diagram (GitHub issue
 * #234's split-node dialog) independent of the cell's actual position in the field. Uses the
 * cell's real `(x, y)` (not just its config) because a triangle tile's shape depends on
 * `(x+y) % 2` (up vs down) — see `getNeighborData`.
 *
 * Each side's `v0`/`v1` direction matches `getSharedEdgeSegment`'s own choice for that same
 * shared edge, not just this cell's own `edgeVerts` — `getSharedEdgeSegment` canonicalizes on the
 * *lower*-coordinate of the two cells sharing an edge and derives `v0`/`v1` from that cell's
 * vertices, which for a non-square tessellation (hex/triangle, whose vertex winding isn't
 * guaranteed to agree between two neighboring cells) can run opposite to this cell's own
 * `edgeVerts` for that side whenever this cell isn't the lower one. Both the split-node dialog's
 * tile diagram (`TileFaceEditor`, via this function) and the post-generation canvas
 * (`SplitJunctionRenderer`/`buildSplitPassagesCore`, via `getSharedEdgeSegment`) feed the same
 * `computeSplitFaceLayouts`, which divides a face's segment along `v0 -> v1` in node order — a
 * disagreement here made the two sides split a multi-node face in mirrored order (GitHub issue
 * #235 follow-up: reported as differing node positions on a shared hex face between the dialog
 * and the canvas for the exact same data). */
export function getTileDiagram(x: number, y: number, cfg: TessellationConfig): { vertices: Pos[]; sides: TileSide[] } | null {
  const verts = getCellVertices(x, y, cfg);
  if (!verts) return null;
  const center = getCellCenter(x, y, cfg);
  const centered = verts.map((v) => ({ x: v.x - center.x, y: v.y - center.y }));
  const { offsets, edgeVerts } = getNeighborData(cfg, x, y);
  const sides: TileSide[] = edgeVerts.map(([vi, vj], index) => {
    const [dx, dy] = offsets[index];
    const nx = x + dx, ny = y + dy;
    const selfIsLower = x < nx || (x === nx && y < ny);
    if (selfIsLower) {
      return { index, offset: offsets[index], v0: centered[vi], v1: centered[vj] };
    }
    // The neighbor is the canonical-lower cell for this shared edge — mirror
    // `getSharedEdgeSegment`'s choice by deriving `v0`/`v1` from its own (absolute-coordinate)
    // vertices/edgeVerts, then translating into this tile's own centered coordinate space.
    const shared = getSharedEdgeSegment([x, y], [nx, ny], cfg);
    if (!shared) return { index, offset: offsets[index], v0: centered[vi], v1: centered[vj] };
    return {
      index,
      offset: offsets[index],
      v0: { x: shared.v0.x - center.x, y: shared.v0.y - center.y },
      v1: { x: shared.v1.x - center.x, y: shared.v1.y - center.y },
    };
  });
  return { vertices: centered, sides };
}

export function getSharedEdgeSegment(
  a: [number, number],
  b: [number, number],
  cfg: TessellationConfig,
): { v0: Pos; v1: Pos } | null {
  const less = a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  const [fa, fb] = less ? [a, b] : [b, a];
  const verts = getCellVertices(fa[0], fa[1], cfg);
  if (!verts) return null;
  const { offsets, edgeVerts } = getNeighborData(cfg, fa[0], fa[1]);
  const dx = fb[0] - fa[0];
  const dy = fb[1] - fa[1];
  for (let i = 0; i < offsets.length; i++) {
    if (offsets[i][0] === dx && offsets[i][1] === dy) {
      const [vi, vj] = edgeVerts[i];
      return { v0: verts[vi], v1: verts[vj] };
    }
  }
  return null;
}
