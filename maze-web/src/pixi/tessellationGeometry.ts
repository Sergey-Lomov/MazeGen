import type { FieldConfig } from "../fieldConfig";
import { cellAtSpacePoint, getCellGeometry, type CellGeometryEntry } from "./cartesianCache";
import { getCellsInRegion, type RegionMode } from "../wasm/mazeService";
import type { PathCommand } from "../wasm/mazeService";
import { rotationTransform, splitShapeBinding } from "./splitShape";
import { TESSELLATION_UI } from "./geometry/tessellationUi";
import { flattenSegments, segmentsToCommands } from "./geometry/pathFlatten";
import { GEOMETRY_TOLERANCE } from "./cartesianCache";
import {
  applyTransform,
  invertTransform,
  isReflection,
  transformCommand,
  type WorldTransform,
} from "./geometry/worldTransform";

export type Pos = { x: number; y: number };

/// Geometry in this module is in display space: `maze-core`'s world-unit geometry (served by the
/// snapshot in `cartesianCache.ts`) under the field's display transform. No function here knows
/// which tessellation it serves -- everything comes from the snapshot and the UI registry.

const transforms = new Map<string, WorldTransform>();

/// The display transform of `cfg`: pixel scale, screen flip and display orientation of its kind
/// (`TESSELLATION_UI`) applied to core's world units.
export function displayTransform(cfg: FieldConfig): WorldTransform {
  const kind = cfg.tessellation.kind;
  const key = `${kind}|${cfg.orientation ?? ""}`;
  let t = transforms.get(key);
  if (!t) {
    const ui = TESSELLATION_UI[kind];
    const o = ui.orientation(cfg.orientation);
    const b = ui.base;
    const s = ui.pixelsPerUnit;
    t = {
      a: s * (o.a * b.a + o.c * b.b),
      b: s * (o.b * b.a + o.d * b.b),
      c: s * (o.a * b.c + o.c * b.d),
      d: s * (o.b * b.c + o.d * b.d),
      tx: 0,
      ty: 0,
    };
    transforms.set(key, t);
  }
  return t;
}

/** Starting rotation (degrees, clockwise) added to a split point's per-node circle-point angles
 *  (GitHub issue #223) before evenly distributing them -- see `TessellationUi.splitCircleRotationDeg`. */
export function getSplitCircleRotationDeg(cfg: FieldConfig): number {
  return TESSELLATION_UI[cfg.tessellation.kind].splitCircleRotationDeg;
}

export {
  SPLIT_HUB_RADIUS,
  splitHubPoint,
  specialSplitNodePoint,
  splitPointFaceKindsByNode,
  buildNodePositions,
} from "./splitNodeGeometry";

/// Display-independent topology of one cell: for every face (in core's `faces_of` order) the
/// neighbor offset and the indices of the boundary vertices its segments run between.
interface CellTopology {
  offsets: [number, number][];
  edgeVerts: [number, number][];
}

const topologies = new WeakMap<CellGeometryEntry, CellTopology>();
const ENDPOINT_EPS = 1e-6;

function vertexIndex(polyline: CellGeometryEntry["polyline"], [x, y]: [number, number]): number {
  const index = polyline.findIndex(([px, py]) => Math.abs(px - x) <= ENDPOINT_EPS && Math.abs(py - y) <= ENDPOINT_EPS);
  if (index === -1) throw new Error(`face endpoint (${x}, ${y}) is not a vertex of the cell boundary`);
  return index;
}

function topologyOf(geometry: CellGeometryEntry): CellTopology {
  let topology = topologies.get(geometry);
  if (!topology) {
    const [cx, cy] = geometry.cell;
    const offsets: [number, number][] = [];
    const edgeVerts: [number, number][] = [];
    for (const face of geometry.faces) {
      // A face without a neighbor (a tessellation's edge) is its own offset, `[0, 0]`.
      offsets.push(face.neighbor ? [face.neighbor[0] - cx, face.neighbor[1] - cy] : [0, 0]);
      const first = face.segments[0];
      const last = face.segments[face.segments.length - 1];
      edgeVerts.push([vertexIndex(geometry.polyline, first.from), vertexIndex(geometry.polyline, last.to)]);
    }
    topology = { offsets, edgeVerts };
    topologies.set(geometry, topology);
  }
  return topology;
}

const vertexCache = new WeakMap<CellGeometryEntry, Map<WorldTransform, Pos[]>>();

/// The cell's boundary polygon in display space (arcs flattened at the cache tolerance). Vertex
/// order follows core's boundary; `getNeighborData`'s `edgeVerts` index into it.
export function getCellVertices(x: number, y: number, cfg: FieldConfig): Pos[] {
  const geometry = getCellGeometry(x, y, cfg);
  const t = displayTransform(cfg);
  let byTransform = vertexCache.get(geometry);
  if (!byTransform) {
    byTransform = new Map();
    vertexCache.set(geometry, byTransform);
  }
  let vertices = byTransform.get(t);
  if (!vertices) {
    vertices = geometry.polyline.map((point) => {
      const [px, py] = applyTransform(t, point);
      return { x: px, y: py };
    });
    byTransform.set(t, vertices);
  }
  return vertices;
}

const pathCache = new WeakMap<CellGeometryEntry, Map<WorldTransform, PathCommand[]>>();

/// The cell's boundary as path commands in display space (arcs stay arcs), ready for
/// `tracePath`/`pathToSvg` with the identity transform. Cached per cell geometry and transform.
export function getCellPath(x: number, y: number, cfg: FieldConfig): readonly PathCommand[] {
  const geometry = getCellGeometry(x, y, cfg);
  const t = displayTransform(cfg);
  let byTransform = pathCache.get(geometry);
  if (!byTransform) {
    byTransform = new Map();
    pathCache.set(geometry, byTransform);
  }
  let commands = byTransform.get(t);
  if (!commands) {
    commands = geometry.boundary.commands.map((command) => transformCommand(t, command));
    byTransform.set(t, commands);
  }
  return commands;
}

export function getCellCenter(x: number, y: number, cfg: FieldConfig): Pos {
  const [px, py] = applyTransform(displayTransform(cfg), getCellGeometry(x, y, cfg).center);
  return { x: px, y: py };
}

/** Exact bounding box of every node's own cell polygon (via `getCellVertices`) -- needed wherever a
 * tight, gap-free fit around the maze matters (PNG export's "edge to edge" canvas). */
export function exactCellBounds(nodes: { x: number; y: number; id: number }[], cfg: FieldConfig): { minX: number; minY: number; maxX: number; maxY: number } {
  return cellBounds(nodes.map(({ x, y }) => [x, y]), cfg);
}

/** Exact display-space bounds of a cell-coordinate set. */
export function cellBounds(
  cells: readonly [number, number][],
  cfg: FieldConfig,
): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of cells) {
    for (const v of getCellVertices(x, y, cfg)) {
      if (v.x < minX) minX = v.x;
      if (v.y < minY) minY = v.y;
      if (v.x > maxX) maxX = v.x;
      if (v.y > maxY) maxY = v.y;
    }
  }
  return { minX, minY, maxX, maxY };
}

/** Inclusive point-in-polygon test shared by background classification and field containment. */
export function pointInPolygon(point: Pos, vertices: Pos[]): boolean {
  return pointInPolygonBy(point.x, point.y, vertices, (v) => v.x, (v) => v.y);
}

/** The inclusive point-in-polygon test for vertices of any shape: `xOf` / `yOf` read a vertex's coordinates, so a
 *  `[x, y]` tuple ring needs no conversion. */
export function pointInPolygonBy<V>(px: number, py: number, vertices: readonly V[], xOf: (vertex: V) => number, yOf: (vertex: V) => number): boolean {
  if (vertices.length < 3) return false;
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const ax = xOf(vertices[j]);
    const ay = yOf(vertices[j]);
    const bx = xOf(vertices[i]);
    const by = yOf(vertices[i]);
    const abx = bx - ax;
    const aby = by - ay;
    const cross = abx * (py - ay) - aby * (px - ax);
    const scale = Math.max(1, Math.abs(abx) + Math.abs(aby));
    if (Math.abs(cross) <= 1e-9 * scale
      && px >= Math.min(ax, bx) - 1e-9
      && px <= Math.max(ax, bx) + 1e-9
      && py >= Math.min(ay, by) - 1e-9
      && py <= Math.max(ay, by) + 1e-9) return true;
    if ((ay > py) !== (by > py)
      && px < (bx - ax) * (py - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside;
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
export function cellCenterBounds(nodes: { x: number; y: number; id: number }[], cfg: FieldConfig): { minX: number; minY: number; maxX: number; maxY: number } {
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

/** The cell of the tessellation at a display-space point (GitHub issue #337 follow-up: snapping a
 * cross-floor teleport badge onto the grid, not a free-floating point that could sit mid-wall).
 * The grid extends infinitely, so the answer is not necessarily a field cell. Deterministic: the
 * same point always resolves to the same cell, whichever floor asks. */
export function nearestCellCoord(worldX: number, worldY: number, cfg: FieldConfig): [number, number] {
  const point = applyTransform(invertTransform(displayTransform(cfg)), [worldX, worldY]);
  const cell = cellAtSpacePoint(point, cfg);
  // `-0` never leaks out of a coordinate: it would compare unequal to `0` under `Object.is`.
  if (!cell) {
    const [ox, oy] = TESSELLATION_UI[cfg.tessellation.kind].originCell;
    return [ox, oy];
  }
  return [cell[0] === 0 ? 0 : cell[0], cell[1] === 0 ? 0 : cell[1]];
}

/// Cells of the whole tessellation space matching the closed display-space polygon under `mode`.
/// Core refuses a region whose bounding box holds more than `MAX_REGION_CANDIDATES` cells, so the
/// polygon must stay near the working area (a shape's own bounds, not an unbounded canvas).
export function cellsInDisplayPolygon(points: Pos[], mode: RegionMode, cfg: FieldConfig): [number, number][] {
  const inverse = invertTransform(displayTransform(cfg));
  return getCellsInRegion({
    tessellation: cfg.tessellation,
    region: points.map(({ x, y }) => applyTransform(inverse, [x, y])),
    mode,
    scope: null,
  });
}

/// Cells per side of one chunk of `cellsInDisplayRect`: a chunk's lattice bounding box stays far
/// below core's `MAX_REGION_CANDIDATES` even after the display transform's rotation.
const RECT_CHUNK_CELLS = 150;

/// Cells of the whole tessellation space matching the closed display-space rectangle under `mode`.
/// Unlike `cellsInDisplayPolygon`, the rectangle may be arbitrarily large: it is queried in chunks
/// that each stay within core's candidate bound. Sorted by cell id, without duplicates.
export function cellsInDisplayRect(
  rect: { minX: number; minY: number; maxX: number; maxY: number },
  mode: RegionMode,
  cfg: FieldConfig,
): [number, number][] {
  const chunk = RECT_CHUNK_CELLS * TESSELLATION_UI[cfg.tessellation.kind].pixelsPerUnit;
  const columns = Math.max(1, Math.ceil((rect.maxX - rect.minX) / chunk));
  const rows = Math.max(1, Math.ceil((rect.maxY - rect.minY) / chunk));
  const width = (rect.maxX - rect.minX) / columns;
  const height = (rect.maxY - rect.minY) / rows;
  const found = new Map<string, [number, number]>();
  for (let column = 0; column < columns; column++) {
    for (let row = 0; row < rows; row++) {
      const minX = rect.minX + column * width, minY = rect.minY + row * height;
      const corners = [
        { x: minX, y: minY },
        { x: minX + width, y: minY },
        { x: minX + width, y: minY + height },
        { x: minX, y: minY + height },
      ];
      for (const cell of cellsInDisplayPolygon(corners, mode, cfg)) found.set(`${cell[0]},${cell[1]}`, cell);
    }
  }
  return [...found.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/// Offsets of a cell's neighbors and the boundary-vertex indices of each face, one entry per face
/// in core's `faces_of` order -- the order every face index in the web follows.
export function getNeighborData(
  cfg: FieldConfig,
  x: number,
  y: number,
): { offsets: [number, number][]; edgeVerts: [number, number][] } {
  const { offsets, edgeVerts } = topologyOf(getCellGeometry(x, y, cfg));
  return { offsets, edgeVerts };
}

export function getCellNeighborOffsets(cfg: FieldConfig, x: number, y: number): [number, number][] {
  return topologyOf(getCellGeometry(x, y, cfg)).offsets;
}

/** The face reached by one rotation step around the cell: `direction` 1 is counter-clockwise on
 * screen, -1 clockwise. The step is the template group element that moves each canonical face to
 * its neighbor in canonical (counter-clockwise in core space) order; the display transform
 * reverses it when it does not reflect (core is Y-up, the screen Y-down). A cell whose allowed
 * group has no such element (Cairo) keeps the face unchanged. */
export function rotateFaceIndex(
  cfg: FieldConfig,
  x: number,
  y: number,
  faceIndex: number,
  direction: 1 | -1,
): number {
  const binding = splitShapeBinding(cfg, x, y);
  if (binding === null || faceIndex < 0 || faceIndex >= binding.canonicalOfLocal.length) return faceIndex;
  const transform = rotationTransform(binding, isReflection(displayTransform(cfg)) ? direction : (-direction as 1 | -1));
  if (transform === null) return faceIndex;
  return binding.localOfCanonical[transform[binding.canonicalOfLocal[faceIndex]]];
}

/** The shape template's canonical face index of each side of the pattern anchor tile
 *  (`TessellationUi.originCell`), by the side's position in the tile `TileFaceEditor` draws. A
 *  pattern's `face_index` is canonical; this is the one place the drawn tile is read in those terms. */
export function anchorCanonicalFaces(cfg: FieldConfig): number[] {
  const [ax, ay] = TESSELLATION_UI[cfg.tessellation.kind].originCell;
  return getCellGeometry(ax, ay, cfg).faces.map((face, local) => face.canonical_face ?? local);
}

export interface TileSide {
  /** Index into `getNeighborData`'s `offsets`/`edgeVerts` for this cell. */
  index: number;
  offset: [number, number];
  v0: Pos;
  v1: Pos;
  /** The side's flattened boundary from `v0` to `v1`, relative to the tile's center: the chord's
   *  two end points for a straight side, the arc for a curved one. */
  polyline: Pos[];
  /** Core's contact point of the face, relative to the tile's center. */
  contact: Pos;
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
export function getTileDiagram(x: number, y: number, cfg: FieldConfig): { vertices: Pos[]; sides: TileSide[] } | null {
  const verts = getCellVertices(x, y, cfg);
  if (!verts) return null;
  const center = getCellCenter(x, y, cfg);
  const centered = verts.map((v) => ({ x: v.x - center.x, y: v.y - center.y }));
  const { offsets, edgeVerts } = getNeighborData(cfg, x, y);
  const sides: TileSide[] = edgeVerts.map(([vi, vj], index) => {
    const [dx, dy] = offsets[index];
    const nx = x + dx, ny = y + dy;
    const shared = getSharedEdgeSegment([x, y], [nx, ny], cfg);
    const selfIsLower = x < nx || (x === nx && y < ny);
    const ownEdge = getFaceEdgeSegment([x, y], index, cfg);
    const own = { v0: centered[vi], v1: centered[vj] };
    // The neighbor is the canonical-lower cell for this shared edge unless this cell is: mirror
    // `getSharedEdgeSegment`'s choice, translated into this tile's own centered coordinate space.
    const ends = !selfIsLower && shared
      ? { v0: { x: shared.v0.x - center.x, y: shared.v0.y - center.y }, v1: { x: shared.v1.x - center.x, y: shared.v1.y - center.y } }
      : own;
    const contact = shared
      ? { x: shared.contact.x - center.x, y: shared.contact.y - center.y }
      : { x: (own.v0.x + own.v1.x) / 2, y: (own.v0.y + own.v1.y) / 2 };
    const edge = !selfIsLower && shared ? shared : ownEdge;
    const polyline = edge
      ? edge.polyline.map(([px, py]) => ({ x: px - center.x, y: py - center.y }))
      : [ends.v0, ends.v1];
    return { index, offset: offsets[index], ...ends, polyline, contact };
  });
  return { vertices: centered, sides };
}

/// The shared boundary of two adjacent cells in display space: `v0 -> v1` are its end points, `path`
/// its exact commands (for drawing) and `polyline` its flattening as coordinate pairs (for geometric operations).
/// Consumers never inspect the segment kinds.
export interface SharedEdge {
  v0: Pos;
  v1: Pos;
  path: readonly PathCommand[];
  polyline: readonly [number, number][];
  /// Core's contact point of the face: where a passage crosses the edge, and where markers sit.
  contact: Pos;
}

const sharedEdgeCache = new WeakMap<CellGeometryEntry, Map<WorldTransform, (SharedEdge | undefined)[]>>();

export function getSharedEdgeSegment(
  a: [number, number],
  b: [number, number],
  cfg: FieldConfig,
): SharedEdge | null {
  const less = a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  const [fa, fb] = less ? [a, b] : [b, a];
  const geometry = getCellGeometry(fa[0], fa[1], cfg);
  const { offsets } = topologyOf(geometry);
  const dx = fb[0] - fa[0];
  const dy = fb[1] - fa[1];
  const face = offsets.findIndex(([ox, oy]) => ox === dx && oy === dy);
  if (face === -1) return null;
  return faceEdgeSegment(geometry, face, cfg);
}

/// The edge of `cell`'s `face` (core's `faces_of` order). Serves a face with no neighbor, whose
/// offset `[0,0]` cannot address it through `getSharedEdgeSegment`.
export function getFaceEdgeSegment(cell: [number, number], face: number, cfg: FieldConfig): SharedEdge | null {
  const geometry = getCellGeometry(cell[0], cell[1], cfg);
  if (face < 0 || face >= geometry.faces.length) return null;
  return faceEdgeSegment(geometry, face, cfg);
}

function faceEdgeSegment(geometry: CellGeometryEntry, face: number, cfg: FieldConfig): SharedEdge {
  const t = displayTransform(cfg);
  let byTransform = sharedEdgeCache.get(geometry);
  if (!byTransform) {
    byTransform = new Map();
    sharedEdgeCache.set(geometry, byTransform);
  }
  let edges = byTransform.get(t);
  if (!edges) {
    edges = [];
    byTransform.set(t, edges);
  }
  let edge = edges[face];
  if (!edge) {
    const { segments } = geometry.faces[face];
    const toPos = (point: [number, number]): Pos => {
      const [px, py] = applyTransform(t, point);
      return { x: px, y: py };
    };
    const points = flattenSegments(segments, GEOMETRY_TOLERANCE).map((point) => applyTransform(t, point));
    const v0 = toPos(segments[0].from);
    const v1 = toPos(segments[segments.length - 1].to);
    const [cx, cy] = applyTransform(t, geometry.faces[face].contact_point);
    edge = {
      v0,
      v1,
      path: segmentsToCommands(segments).map((command) => transformCommand(t, command)),
      polyline: points,
      contact: { x: cx, y: cy },
    };
    edges[face] = edge;
  }
  return edge;
}
