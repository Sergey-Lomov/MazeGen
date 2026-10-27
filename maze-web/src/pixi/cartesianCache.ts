import type { FieldConfig, TessellationConfig } from "../fieldConfig";
import { configAllCells } from "./tessellationCells";
import {
  getCellAt,
  getCellsInRegion,
  getGeometrySnapshot,
  type PathCellGeometry,
  type RegionMode,
  type WorldPoint,
} from "../wasm/mazeService";
import type { WireTopology } from "../wasm/types";
import { flattenCommands } from "./geometry/pathFlatten";

/// Geometry access layer over `maze-core`'s geometry snapshot (`Specs/space.md`, "Geometry
/// snapshot lifecycle"). Every coordinate here is in core's world units (math convention, cell
/// area 1) -- the display transform (orientation, pixel scale) is applied by callers and never
/// invalidates anything cached here.
///
/// The snapshot is bound to two things and rebuilt when either changes: the tessellation instance
/// (the serialized `{ kind, params }` -- equal configs build equal instances) and the field
/// version, a counter this module bumps whenever the field's cell set changes. Render loops read
/// geometry synchronously every frame, so reads are served from the cached snapshot; a wasm call
/// happens only on a warm-up or for a cell outside the field.

/// Identity of one cell of a tessellation: its wire coordinates, branded so a stray `[x, y]`
/// (a world point, a pixel position) cannot be passed where a cell is expected.
export type CellId = readonly [number, number] & { readonly __brand: "CellId" };

export function cellId(x: number, y: number): CellId {
  return [x, y] as unknown as CellId;
}

/// Flatten tolerance of the derived polylines, in world units (a cell's area is 1).
export const GEOMETRY_TOLERANCE = 1e-3;

/// A cell's snapshot entry: core's exact path boundary (drawing) plus its polyline flattened at
/// `GEOMETRY_TOLERANCE` (geometric operations). No consumer inspects the segment kinds.
export type CellGeometryEntry = PathCellGeometry & { polyline: WorldPoint[] };

function withPolyline(geometry: PathCellGeometry): CellGeometryEntry {
  return { ...geometry, polyline: flattenCommands(geometry.boundary.commands, GEOMETRY_TOLERANCE) };
}

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

/// Cells of the current field: filled by one snapshot, never evicted until the field changes.
const fieldCache = new Map<string, CellGeometryEntry>();
/// Cells outside the field (grid margin, hover, invalid endpoints): bounded, least recently used
/// first out. `Map` iteration order is insertion order, so re-inserting on a hit keeps it LRU.
const outsideCache = new Map<string, CellGeometryEntry>();
export const DEFAULT_MAX_OUTSIDE_CELLS = 100_000;
let maxOutsideCells = DEFAULT_MAX_OUTSIDE_CELLS;

/// Resizes the outside-cell LRU (tests use a tiny limit); evicts down to the new limit at once.
export function setMaxOutsideCells(limit: number): void {
  maxOutsideCells = limit;
  while (outsideCache.size > limit) outsideCache.delete(outsideCache.keys().next().value!);
}
let cachedInstance: string | null = null;
let fieldVersion = 0;
let fieldSignature = "";
/// The folds the snapshot was built with (by reference) and a counter bumped whenever they change.
let cachedTopology: WireTopology | null = null;
let topologyVersion = 0;

/// Identity of a tessellation instance. Memoized per config object: reads run on render hot
/// paths and must not serialize on every call.
const instanceKeys = new WeakMap<TessellationConfig, string>();

function instanceKey(cfg: FieldConfig): string {
  let key = instanceKeys.get(cfg.tessellation);
  if (key === undefined) {
    key = JSON.stringify(cfg.tessellation);
    instanceKeys.set(cfg.tessellation, key);
  }
  return key;
}

function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

/// Field version: incremented on every change of the cached cell set or tessellation instance.
export function getFieldVersion(): number {
  return fieldVersion;
}

/// Topology version: incremented whenever the folds the cached snapshot carries change. Together
/// with the field version it keys the snapshot (`Specs/space.md`, "Geometry snapshot lifecycle").
export function getTopologyVersion(): number {
  return topologyVersion;
}

/// Whether the cache holds the snapshot of `cfg`'s tessellation instance (the test `getCellGeometry`
/// uses before it warms lazily). Lets a reader that needs the topology the snapshot was built with
/// -- which a lazy warm cannot know -- avoid triggering that warm.
export function isCacheWarmFor(cfg: FieldConfig): boolean {
  return instanceKey(cfg) === cachedInstance;
}

/// Batched prewarm -- call when the field, tessellation or the floor's folds change
/// (confirmTessellation, project load, generateWithSeed, a topology edit), not per frame. One
/// snapshot call covers every field cell and carries `topology` (`null` = no folds; compared by
/// reference). Does nothing when neither the instance, the cell set nor the folds changed, so
/// repeated calls keep the cache. A topology core refuses falls back to the plain snapshot.
export function warmCartesianCache(cfg: FieldConfig, topology: WireTopology | null = null): void {
  const instance = instanceKey(cfg);
  const cells = configAllCells(cfg);
  const signature = cells.map(([x, y]) => cellKey(x, y)).join(";");
  if (instance === cachedInstance && signature === fieldSignature && topology === cachedTopology) return;
  fieldCache.clear();
  outsideCache.clear();
  cachedInstance = instance;
  fieldSignature = signature;
  if (topology !== cachedTopology) topologyVersion++;
  cachedTopology = topology;
  fieldVersion++;
  if (cells.length === 0) return;
  const request = { tessellation: cfg.tessellation, cells, boundary: { kind: "path" } as const, fieldVersion, topologyVersion };
  let snapshot;
  try {
    snapshot = getGeometrySnapshot(
      topology === null
        ? request
        : {
            ...request,
            topology: {
              field_cells: cells,
              folds: topology.folds.map((fold) => ({ ...fold, twist: fold.twist === true })),
              groups: topology.groups,
            },
          },
    );
  } catch (error) {
    if (topology === null) throw error;
    snapshot = getGeometrySnapshot(request);
  }
  for (const geometry of snapshot.cells) fieldCache.set(cellKey(geometry.cell[0], geometry.cell[1]), withPolyline(geometry));
}

/// Geometry of one cell. Served from the cache for any cell of the current field; a cell outside
/// it (an invalid preset connection's endpoint, a boundary neighbor) costs one single-cell
/// snapshot call and is cached in a bounded LRU (`DEFAULT_MAX_OUTSIDE_CELLS`), so hovering the same cell every
/// frame pays only once and field cells are never evicted.
export function getCellGeometry(x: number, y: number, cfg: FieldConfig): CellGeometryEntry {
  if (instanceKey(cfg) !== cachedInstance) {
    // Defensive: queried before the cache was warmed for this tessellation.
    warmCartesianCache(cfg);
  }
  const key = cellKey(x, y);
  const inField = fieldCache.get(key);
  if (inField) return inField;
  const outside = outsideCache.get(key);
  if (outside) {
    outsideCache.delete(key);
    outsideCache.set(key, outside);
    return outside;
  }
  const [raw] = getGeometrySnapshot({
    tessellation: cfg.tessellation,
    cells: [[x, y]],
    boundary: { kind: "path" },
    fieldVersion,
  }).cells;
  const geometry = withPolyline(raw);
  outsideCache.set(key, geometry);
  if (outsideCache.size > maxOutsideCells) outsideCache.delete(outsideCache.keys().next().value!);
  return geometry;
}

/// Signed-area magnitude of a polygon, in world units (a unit cell has area 1 in the square tessellation).
function polygonArea(points: readonly WorldPoint[]): number {
  let twice = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    twice += x1 * y2 - x2 * y1;
  }
  return Math.abs(twice) / 2;
}

const areaCache = new WeakMap<CellGeometryEntry, number>();

/// Area of one cell in world units, computed once per cached geometry entry.
export function getCellArea(x: number, y: number, cfg: FieldConfig): number {
  const geometry = getCellGeometry(x, y, cfg);
  let area = areaCache.get(geometry);
  if (area === undefined) {
    area = polygonArea(geometry.polyline);
    areaCache.set(geometry, area);
  }
  return area;
}

/// Area statistics of the current field's cells.
export interface CellAreaStats {
  mean: number;
  min: number;
  max: number;
}

let areaStats: { version: number; stats: CellAreaStats | null } | null = null;

/// Mean/min/max cell area of the field, computed once per field version (the cache rebuilds on
/// every tessellation or cell-set change, which bumps the version); `null` for an empty field.
export function getFieldAreaStats(cfg: FieldConfig): CellAreaStats | null {
  if (instanceKey(cfg) !== cachedInstance) warmCartesianCache(cfg);
  if (areaStats?.version === fieldVersion) return areaStats.stats;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const geometry of fieldCache.values()) {
    let area = areaCache.get(geometry);
    if (area === undefined) {
      area = polygonArea(geometry.polyline);
      areaCache.set(geometry, area);
    }
    sum += area;
    if (area < min) min = area;
    if (area > max) max = area;
  }
  const stats = fieldCache.size === 0 ? null : { mean: sum / fieldCache.size, min, max };
  areaStats = { version: fieldVersion, stats };
  return stats;
}

/// World-unit center of one cell.
export function getCartesian(x: number, y: number, cfg: FieldConfig): WorldPoint {
  return getCellGeometry(x, y, cfg).center;
}

/// Bounding box of the field's flattened cell boundaries, in world units; `null` for an empty field.
export function getFieldWorldBounds(cfg: FieldConfig): Bounds | null {
  const cells = configAllCells(cfg);
  if (cells.length === 0) return null;
  const bounds: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const [x, y] of cells) {
    for (const [px, py] of getCellGeometry(x, y, cfg).polyline) {
      bounds.minX = Math.min(bounds.minX, px);
      bounds.minY = Math.min(bounds.minY, py);
      bounds.maxX = Math.max(bounds.maxX, px);
      bounds.maxY = Math.max(bounds.maxY, py);
    }
  }
  return bounds;
}

/// The field cell whose closed boundary contains the world point (minimal `CellId` on a shared
/// boundary), or `null`. Scoped to the field's own cells, so it never touches the unbounded space.
export function cellAtWorldPoint(point: WorldPoint, cfg: FieldConfig): CellId | null {
  const cells = configAllCells(cfg);
  if (cells.length === 0) return null;
  const hit = getCellAt({ tessellation: cfg.tessellation, point, scope: cells });
  return hit ? cellId(hit[0], hit[1]) : null;
}

/// The cell of the whole tessellation space whose closed boundary contains the world point
/// (minimal `CellId` on a shared boundary). A point query touches a handful of candidate cells,
/// so it never meets core's `MAX_REGION_CANDIDATES` bound.
export function cellAtSpacePoint(point: WorldPoint, cfg: FieldConfig): CellId | null {
  const hit = getCellAt({ tessellation: cfg.tessellation, point, scope: null });
  return hit ? cellId(hit[0], hit[1]) : null;
}

/// The field cells matching the closed polygon `region` under `mode`. Scoped to a cell set --
/// the field's own cells unless `scope` narrows it -- so a selection drawn over a zoomed-out
/// canvas never reaches core's `MAX_REGION_CANDIDATES` bound on an unscoped query.
export function cellsInWorldRegion(
  region: WorldPoint[],
  mode: RegionMode,
  cfg: FieldConfig,
  scope: readonly CellId[] = configAllCells(cfg).map(([x, y]) => cellId(x, y)),
): CellId[] {
  if (scope.length === 0) return [];
  const hits = getCellsInRegion({
    tessellation: cfg.tessellation,
    region,
    mode,
    scope: scope.map(([x, y]) => [x, y]),
  });
  return hits.map(([x, y]) => cellId(x, y));
}
