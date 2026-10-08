import { squareCenter, squareVertices } from "./squareGeometry";
import { hexCenter, hexVertices } from "./hexGeometry";
import { triCenter, triVertices, TRI_TILE_SIZE } from "./triGeometry";
import type { TriOrientation } from "./triGeometry";
import type { FieldConfig as TessellationConfig } from "../fieldConfig";
import { TILE_SIZE } from "./constants";
import type { SplitPattern } from "../wasm/types";
import { cairoCenter, CAIRO_CENTER_SCALE, cairoEdgeVerts, cairoNeighborOffsets, cairoVertices, isCairoPoint } from "./cairoGeometry";

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
    case "square_circle":
    case "square_triangle":
    case "square_custom":
      return 45;
    case "hex_rectangle":
    case "hex_circle":
    case "hex_triangle":
    case "hex_parallelogram":
    case "hex_hexagon":
    case "hex_custom":
      return 30;
    case "triangle_rect":
    case "triangle_triangle":
    case "triangle_circle":
    case "triangle_hexagon":
    case "tri_custom":
      return 60;
    case "cairo":
    case "cairo_circle":
    case "cairo_triangle":
    case "cairo_hexagon":
    case "cairo_custom":
      return 36;
    default:
      cfg satisfies never;
      return 0;
  }
}

export {
  SPLIT_HUB_RADIUS,
  splitHubPoint,
  specialSplitNodePoint,
  splitPointFaceKindsByNode,
  buildNodePositions,
} from "./splitNodeGeometry";

export function getCellVertices(x: number, y: number, cfg: TessellationConfig): Pos[] | null {
  switch (cfg.type) {
    case "square":
    case "square_circle":
    case "square_triangle":
    case "square_custom": {
      const c = squareCenter(x, y, cfg);
      return squareVertices(c.x, c.y);
    }
    case "hex_rectangle":
    case "hex_circle":
    case "hex_triangle":
    case "hex_parallelogram":
    case "hex_hexagon":
    case "hex_custom": {
      const ori = (cfg as { orientation?: "flat_top" | "pointy_top" }).orientation ?? "flat_top";
      const c = hexCenter(x, y, ori, cfg);
      return hexVertices(c.x, c.y, ori);
    }
    case "triangle_rect":
    case "triangle_triangle":
    case "triangle_circle":
    case "triangle_hexagon":
    case "tri_custom": {
      const ori = (cfg as { orientation?: TriOrientation }).orientation ?? "r0";
      return triVertices(x, y, ori);
    }
    case "cairo":
    case "cairo_circle":
    case "cairo_triangle":
    case "cairo_hexagon":
    case "cairo_custom":
      return cairoVertices(x, y);
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

/** Bounding box of every node's own cell **center** (`getCellCenter`), not its full polygon
 * (`exactCellBounds`) — needed wherever the drawn content never reaches a cell's outer boundary
 * (PNG export's "edge to edge" canvas for the "Vector by corridors" render mode: a corridor line
 * runs center-to-center, so a border cell's own segment stops well short of the tile edge — using
 * `exactCellBounds` there leaves a visible gap between the tight canvas edge and the actual line
 * work, GitHub issue #324). Every `CorridorSegment` endpoint (`buildCorridorSegments`) is either a
 * cell center or the midpoint between two adjacent cell centers (a split-neighbor's shared-face
 * midpoint), so it always lies within the convex hull of all cell centers — this bbox safely
 * bounds every segment endpoint too, not just the centers themselves. */
export function cellCenterBounds(nodes: { x: number; y: number; id: number }[], cfg: TessellationConfig): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const c = getCellCenter(n.x, n.y, cfg);
    if (c.x < minX) minX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.x > maxX) maxX = c.x;
    if (c.y > maxY) maxY = c.y;
  }
  return { minX, minY, maxX, maxY };
}

export function getCellCenter(x: number, y: number, cfg: TessellationConfig): Pos {
  switch (cfg.type) {
    case "square":
    case "square_circle":
    case "square_triangle":
    case "square_custom":
      return squareCenter(x, y, cfg);
    case "hex_rectangle":
    case "hex_circle":
    case "hex_triangle":
    case "hex_parallelogram":
    case "hex_hexagon":
    case "hex_custom": {
      const ori = (cfg as { orientation?: "flat_top" | "pointy_top" }).orientation ?? "flat_top";
      return hexCenter(x, y, ori, cfg);
    }
    case "triangle_rect":
    case "triangle_triangle":
    case "triangle_circle":
    case "triangle_hexagon":
    case "tri_custom": {
      const ori = (cfg as { orientation?: TriOrientation }).orientation ?? "r0";
      return triCenter(x, y, ori, cfg);
    }
    case "cairo":
    case "cairo_circle":
    case "cairo_triangle":
    case "cairo_hexagon":
    case "cairo_custom":
      return cairoCenter(x, y);
    default:
      return { x: 0, y: 0 };
  }
}

/// Inverse rotation matrix of `hexGeometry.ts`'s `rotateDeg` — same isometry, negated angle.
function rotateDegInverse(x: number, y: number, deg: number): Pos {
  const a = (-deg * Math.PI) / 180;
  return { x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) };
}

/// Undoes `triGeometry.ts`'s `rotate` — every one of its four cases (r0/r90/r180/r270) happens to
/// be its own inverse (each is a 180°-order isometry: applying it twice is the identity), so this
/// is textually identical to that function, just spelled out here to keep the inverse direction
/// explicit at the call site rather than relying on the reader noticing the self-inverse property.
function triRotateInverse(x: number, y: number, orientation: TriOrientation): Pos {
  switch (orientation) {
    case "r0": return { x, y };
    case "r90": return { x: -y, y: -x };
    case "r180": return { x: -x, y: -y };
    case "r270": return { x: y, y: x };
  }
}

/// Nearest square grid coordinate to a world point (GitHub issue #337 follow-up: snapping a
/// cross-floor teleport badge onto the grid, not a free-floating world point that could sit
/// mid-wall) — exact inversion of `squareCenter`, `Tessellation::cartesian` being the identity for
/// square (`maze-core/src/space/square.rs`), so this never needs rounding-candidate disambiguation
/// the way hex/tri do below.
function nearestSquareCoord(worldX: number, worldY: number): [number, number] {
  return [Math.round(worldX / TILE_SIZE - 0.5), Math.round(-worldY / TILE_SIZE - 0.5)];
}

/// Nearest hex axial coordinate to a world point — undoes `hexCenter`'s own rotation/scale to
/// recover the canonical (flat_top) unit-scale point, algebraically inverts
/// `HexTessellation::cartesian` (`ux = q*1.5`, `uy = -(r*inradius*2 + q*inradius)`,
/// `maze-core/src/space/hex.rs`) to get real-valued `(q, r)`, then rounds via the standard
/// cube-coordinate rounding algorithm (round `(q, r, s=-q-r)` independently, then fix up whichever
/// axis had the largest rounding error so `q+r+s` stays exactly 0) — a naive per-axis round can
/// snap to the wrong hex near a cell boundary, which cube-rounding avoids.
function nearestHexCoord(worldX: number, worldY: number, orientation: "flat_top" | "pointy_top"): [number, number] {
  const { x: rx, y: ry } = rotateDegInverse(worldX, worldY, orientation === "pointy_top" ? 30 : 0);
  const ux = rx / TILE_SIZE;
  const uy = ry / TILE_SIZE;
  const inradius = Math.sqrt(3) / 2;
  const qf = ux / 1.5;
  // uy = -(r*inradius*2 + q*inradius)  =>  r = (-uy/inradius - q) / 2
  const rf = (-uy / inradius - qf) / 2;
  const sf = -qf - rf;
  let q = Math.round(qf);
  let r = Math.round(rf);
  const s = Math.round(sf);
  const qDiff = Math.abs(q - qf);
  const rDiff = Math.abs(r - rf);
  const sDiff = Math.abs(s - sf);
  if (qDiff > rDiff && qDiff > sDiff) q = -r - s;
  else if (rDiff > sDiff) r = -q - s;
  return [q, r];
}

/// Nearest triangle (col, row) grid coordinate to a world point — undoes `triCenter`'s own
/// rotation/scale to recover the canonical (r0) unit-scale point, then inverts
/// `TriTessellation::cartesian` (`maze-core/src/space/triangle.rs`). `col` inverts directly
/// (`cx = col + 0.5` at canonical `S = 2`, no parity dependence). `row` does depend on parity
/// (`pointing_up = (col+row) % 2 === 0` picks between two different `cy` formulas), which is
/// itself derived from `row` — solved by computing both parity candidates' own `row`, then keeping
/// whichever is *self-consistent* (its own rounded value actually produces the parity its formula
/// assumed); on the rare tie/mismatch (both or neither self-consistent — can happen only very near
/// a triangle's own base edge, at the boundary between the two formulas), the candidate whose
/// fractional `row` is closer to an integer wins, since that's the one the world point actually sat
/// nearest to before rounding.
function nearestTriCoord(worldX: number, worldY: number, orientation: TriOrientation): [number, number] {
  const { x: rx, y: ry } = triRotateInverse(worldX, worldY, orientation);
  const scale = TRI_TILE_SIZE / 2;
  const ux = rx / scale;
  const uy = ry / scale;
  const h = 2 * Math.sqrt(3) / 2; // canonical S = 2, H = S*sqrt(3)/2
  const col = Math.round(ux - 0.5);

  const rowUpF = -(uy + h / 3) / h;
  const rowDownF = -(uy + 2 * h / 3) / h;
  const rowUp = Math.round(rowUpF);
  const rowDown = Math.round(rowDownF);
  const upConsistent = (col + rowUp) % 2 === 0; // pointing_up formula requires even parity
  const downConsistent = (col + rowDown) % 2 !== 0;

  if (upConsistent && !downConsistent) return [col, rowUp];
  if (downConsistent && !upConsistent) return [col, rowDown];
  // Both/neither consistent — fall back to whichever real-valued row landed closer to its own
  // rounded integer (closer to an exact grid line means the world point genuinely sat nearer it).
  const upDist = Math.abs(rowUpF - rowUp);
  const downDist = Math.abs(rowDownF - rowDown);
  return upDist <= downDist ? [col, rowUp] : [col, rowDown];
}

/// Nearest grid coordinate (not necessarily an actual field cell — the math grid extends
/// infinitely) to a world point, for whichever tessellation `cfg` names (GitHub issue #337
/// follow-up: snapping a cross-floor teleport badge onto the grid so its connector never crosses a
/// wall unpredictably). Deterministic and symmetric by construction — the same world point always
/// resolves to the same grid coordinate regardless of caller/context, so a badge computed once from
/// a world-space midpoint reads identically from either floor it's drawn on.
export function nearestCellCoord(worldX: number, worldY: number, cfg: TessellationConfig): [number, number] {
  const [x, y] = nearestCellCoordRaw(worldX, worldY, cfg);
  // `Math.round` can produce a signed `-0` for a world point that lands exactly on a coordinate's
  // own negative-side boundary — a real grid coordinate is never negative zero, and leaving it in
  // would make `-0`/`0` compare unequal to a caller doing strict identity (e.g. a coordinate-key
  // string, or `Object.is`-based dedup), so it's normalized away here rather than at every call
  // site.
  return [x === 0 ? 0 : x, y === 0 ? 0 : y];
}

function nearestCairoCoord(worldX: number, worldY: number): [number, number] {
  const x = worldX / (CAIRO_CENTER_SCALE * TILE_SIZE);
  const y = -worldY / (CAIRO_CENTER_SCALE * TILE_SIZE);
  const baseX = Math.floor(x);
  const baseY = Math.floor(y);
  let best: { x: number; y: number; distance: number } | null = null;
  for (let candidateX = baseX - 2; candidateX <= baseX + 2; candidateX++) {
    for (let candidateY = baseY - 2; candidateY <= baseY + 2; candidateY++) {
      if (!isCairoPoint(candidateX, candidateY)) continue;
      const dx = candidateX - x;
      const dy = candidateY - y;
      const distance = dx * dx + dy * dy;
      if (!best || distance < best.distance
        || (distance === best.distance && (candidateX < best.x
          || (candidateX === best.x && candidateY < best.y)))) {
        best = { x: candidateX, y: candidateY, distance };
      }
    }
  }
  return best ? [best.x, best.y] : [Math.round(x), Math.round(y)];
}

function nearestCellCoordRaw(worldX: number, worldY: number, cfg: TessellationConfig): [number, number] {
  switch (cfg.type) {
    case "square":
    case "square_circle":
    case "square_triangle":
    case "square_custom":
      return nearestSquareCoord(worldX, worldY);
    case "hex_rectangle":
    case "hex_circle":
    case "hex_triangle":
    case "hex_parallelogram":
    case "hex_hexagon":
    case "hex_custom": {
      const ori = (cfg as { orientation?: "flat_top" | "pointy_top" }).orientation ?? "flat_top";
      return nearestHexCoord(worldX, worldY, ori);
    }
    case "triangle_rect":
    case "triangle_triangle":
    case "triangle_circle":
    case "triangle_hexagon":
    case "tri_custom": {
      const ori = (cfg as { orientation?: TriOrientation }).orientation ?? "r0";
      return nearestTriCoord(worldX, worldY, ori);
    }
    case "cairo":
    case "cairo_circle":
    case "cairo_triangle":
    case "cairo_hexagon":
    case "cairo_custom":
      return nearestCairoCoord(worldX, worldY);
    default:
      cfg satisfies never;
      return [0, 0];
  }
}

export function getNeighborData(
  cfg: TessellationConfig,
  x: number,
  y: number,
): { offsets: [number, number][]; edgeVerts: [number, number][] } {
  switch (cfg.type) {
    case "square":
    case "square_circle":
    case "square_triangle":
    case "square_custom":
      return { offsets: SQUARE_NEIGHBOR_OFFSETS, edgeVerts: SQUARE_EDGE_VERTS };
    case "hex_rectangle":
    case "hex_circle":
    case "hex_triangle":
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
    case "triangle_circle":
    case "triangle_hexagon":
    case "tri_custom": {
      const up = (x + y) % 2 === 0;
      return {
        offsets: up ? TRI_NEIGHBOR_OFFSETS_UP : TRI_NEIGHBOR_OFFSETS_DOWN,
        edgeVerts: up ? TRI_EDGE_VERTS_UP : TRI_EDGE_VERTS_DOWN,
      };
    }
    case "cairo":
    case "cairo_circle":
    case "cairo_triangle":
    case "cairo_hexagon":
    case "cairo_custom":
      return { offsets: cairoNeighborOffsets(x, y), edgeVerts: cairoEdgeVerts(x, y) };
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
