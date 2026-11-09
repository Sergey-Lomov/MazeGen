import { getWasm } from "./wasmLoader";
import type { CheckDescriptor, StrategyDescriptor, RuleParamDescriptor, WasmTessellationConfig, WireTopology, WireFoldEnd } from "./types";

export * from "./mazeGeneration";
export { generateMazeAsync, computeAnalyticsAsync, disposeWorkers } from "./workerClients";

export function getAvailableChecks(): CheckDescriptor[] {
  return getWasm().available_checks() as CheckDescriptor[];
}

export function getAvailableStrategies(): StrategyDescriptor[] {
  return getWasm().available_strategies() as StrategyDescriptor[];
}

export function getAvailableRuleParams(): RuleParamDescriptor[] {
  return getWasm().available_rule_params() as RuleParamDescriptor[];
}

/** Mirrors `maze-runner`'s geometry wire types (`runner::geometry`): world units, math convention
 *  (Y up, counter-clockwise positive), no display transform. */
export type WorldPoint = [number, number];

export type PathCommand =
  | { op: "move_to"; to: WorldPoint }
  | { op: "line_to"; to: WorldPoint }
  | { op: "arc_to"; center: WorldPoint; radius: number; start_angle: number; end_angle: number; ccw: boolean };

export type SegmentDto =
  | { kind: "line"; from: WorldPoint; to: WorldPoint }
  | { kind: "arc"; from: WorldPoint; to: WorldPoint; center: WorldPoint; radius: number; start_angle: number; sweep: number };

export interface FaceGeometry {
  /// The cell across this face; `null` at the tessellation's edge. Not necessarily a field cell.
  neighbor: [number, number] | null;
  /// The face's index in the cell's shape template (the index split patterns use); `null` for a
  /// cell without a template.
  canonical_face: number | null;
  contact_point: WorldPoint;
  segments: SegmentDto[];
  /// Present when an active fold is glued to this face; the face is then unpaired (its own
  /// `segments` and `contact_point`). Core resolves all of it; never derive it from coordinates.
  fold?: FoldFace | null;
}

/// An active fold seen from one of its faces (`runner::geometry::FoldFaceDto`).
export interface FoldFace {
  /// The fold's index in the request's `topology.folds`.
  fold: number;
  partner_cell: [number, number];
  /// The partner's glued face, as a position in its `faces_of`.
  partner_face_idx: number;
  twist: boolean;
  /// Which end of the partner's face chain this face's chain start meets.
  start_meets: "start" | "end";
  /// `false` for a topological-only fold (not passed to a distance algorithm).
  isometric: boolean;
  /// Affine `[a, b, c, d, e, f]` (`x' = a*x + c*y + e`, `y' = b*x + d*y + f`) mapping the partner's
  /// face geometry into this cell's coordinates; `null` unless `isometric`.
  transform: [number, number, number, number, number, number] | null;
}

export interface FoldEndRequest {
  cell: [number, number];
  face_idx: number;
}

/// The folds of one floor plus the floor's whole cell set (which decides fold activity).
export interface TopologyRequest {
  field_cells: [number, number][];
  folds: { a: FoldEndRequest; b: FoldEndRequest; twist: boolean; group: number }[];
  groups: { id: number; folds: number[] }[];
}

/// The boundary representation of a snapshot: exactly one per request, never both.
export interface PathBoundary {
  kind: "path";
  commands: PathCommand[];
}

export interface PolylineBoundary {
  kind: "polyline";
  /// The boundary flattened at the requested tolerance, first point not repeated.
  points: WorldPoint[];
}

export type BoundaryRequest = { kind: "path" } | { kind: "polyline"; tolerance: number };

export interface CellGeometry<B extends PathBoundary | PolylineBoundary = PathBoundary | PolylineBoundary> {
  cell: [number, number];
  center: WorldPoint;
  cell_scale: number;
  /// The key of the cell's shape template; `null` for a cell without one.
  shape: string | null;
  /** Allowed transform group: permutations of canonical face indices, identity first. */
  allowed_group: number[][] | null;
  /** Per face in `faces_of` order: the neighbor's coordinates minus the cell's, `[0, 0]` for a face
   *  without a neighbor. Present with or without `faces`. */
  neighbor_offsets: [number, number][];
  boundary: B;
  /// `false` when the request's `faces` mode left this cell's `faces` empty.
  has_faces: boolean;
  faces: FaceGeometry[];
}

/// Which cells of a snapshot carry their faces (`runner::geometry::FacesRequest`): `boundary` keeps
/// them for the cells with a face that has no neighbor among the requested cells or carries a fold.
export type FacesMode = "all" | "none" | "boundary";

export type PolylineCellGeometry = CellGeometry<PolylineBoundary>;
export type PathCellGeometry = CellGeometry<PathBoundary>;

export interface GeometrySnapshot<B extends PathBoundary | PolylineBoundary = PathBoundary | PolylineBoundary> {
  instance: string;
  field_version: number;
  /// Echo of the request's `topologyVersion`; the snapshot is valid for this field and topology
  /// version pair.
  topology_version: number;
  cells: CellGeometry<B>[];
}

export type RegionMode = "intersects" | "contained" | "center_inside";

/// Immutable geometry of `cells` under one tessellation instance (`geometry_snapshot`). The
/// snapshot echoes `fieldVersion`; `cartesianCache.ts` owns that counter.
export function getGeometrySnapshot(config: {
  tessellation: WasmTessellationConfig;
  cells: [number, number][];
  boundary: { kind: "polyline"; tolerance: number };
  fieldVersion: number;
  topologyVersion?: number;
  topology?: TopologyRequest;
  faces?: FacesMode;
}): GeometrySnapshot<PolylineBoundary>;
export function getGeometrySnapshot(config: {
  tessellation: WasmTessellationConfig;
  cells: [number, number][];
  boundary: { kind: "path" };
  fieldVersion: number;
  topologyVersion?: number;
  topology?: TopologyRequest;
  faces?: FacesMode;
}): GeometrySnapshot<PathBoundary>;
export function getGeometrySnapshot(config: {
  tessellation: WasmTessellationConfig;
  cells: [number, number][];
  boundary: BoundaryRequest;
  fieldVersion: number;
  topologyVersion?: number;
  topology?: TopologyRequest;
  faces?: FacesMode;
}): GeometrySnapshot {
  // A path boundary is not sent when every cell has faces: it is their segments chained, rebuilt
  // here. Cells without faces get the path itself.
  const wasPath = config.boundary.kind === "path" && (config.faces ?? "all") === "all";
  const raw = getWasm().geometry_snapshot({
    tessellation: config.tessellation,
    cells: config.cells,
    boundary: wasPath ? { kind: "faces" } : config.boundary.kind === "path" ? { kind: "path_templated" } : config.boundary,
    field_version: config.fieldVersion,
    topology_version: config.topologyVersion ?? 0,
    topology: config.topology ?? null,
    faces: config.faces ?? "all",
  }) as WireGeometrySnapshot;
  return restoreSnapshot(raw, wasPath);
}

/// A snapshot as the wire carries it: allowed groups interned in a shared list, no boundary
/// when the faces carry it (`runner::geometry::GeometrySnapshot`).
type WireGeometrySnapshot = Omit<GeometrySnapshot, "cells"> & {
  allowed_groups: number[][][];
  offset_tables: [number, number][][];
  boundary_templates: PathCommand[][];
  cells: (Omit<CellGeometry, "allowed_group" | "neighbor_offsets" | "boundary"> & { allowed_group: number | null; offsets: number; boundary: PolylineBoundary | { kind: "faces" } | { kind: "path_template"; template: number } })[];
};

function restoreSnapshot(raw: WireGeometrySnapshot, pathBoundary: boolean): GeometrySnapshot {
  const { allowed_groups, offset_tables, boundary_templates, cells, ...rest } = raw;
  return {
    ...rest,
    cells: cells.map(({ offsets, ...cell }) => ({
      ...cell,
      neighbor_offsets: offset_tables[offsets],
      allowed_group: cell.allowed_group === null ? null : allowed_groups[cell.allowed_group],
      boundary:
        cell.boundary.kind === "path_template"
          ? { kind: "path", commands: translateCommands(boundary_templates[cell.boundary.template], cell.center) }
          : pathBoundary && cell.boundary.kind === "faces"
            ? { kind: "path", commands: pathCommandsOfFaces(cell.faces) }
            : (cell.boundary as PolylineBoundary),
    })),
  };
}

/// A shared boundary template (relative to the cell's center) placed at `center`.
function translateCommands(template: readonly PathCommand[], [cx, cy]: WorldPoint): PathCommand[] {
  return template.map((command): PathCommand =>
    command.op === "arc_to"
      ? { ...command, center: [command.center[0] + cx, command.center[1] + cy] }
      : { op: command.op, to: [command.to[0] + cx, command.to[1] + cy] },
  );
}

/// `MoveTo` the first segment's start, then one command per segment (`BoundaryPath::path_commands`).
export function pathCommandsOfFaces(faces: readonly FaceGeometry[]): PathCommand[] {
  const commands: PathCommand[] = [];
  for (const face of faces) {
    for (const segment of face.segments) {
      if (commands.length === 0) commands.push({ op: "move_to", to: segment.from });
      commands.push(
        segment.kind === "line"
          ? { op: "line_to", to: segment.to }
          : { op: "arc_to", center: segment.center, radius: segment.radius, start_angle: segment.start_angle, end_angle: segment.start_angle + segment.sweep, ccw: segment.sweep > 0 },
      );
    }
  }
  return commands;
}

/// A cell's boundary and nothing else (`geometry_outlines`).
export interface CellOutline {
  cell: [number, number];
  commands: PathCommand[];
}

/// Boundary path commands of `cells` without faces, shapes or contact points: the cheap request
/// for painting many cells (the viewport grid).
export function getCellOutlines(tessellation: WasmTessellationConfig, cells: [number, number][]): CellOutline[] {
  return getWasm().geometry_outlines({ tessellation, cells }) as CellOutline[];
}

/// The floor a topology query or edit is about: the tessellation, the floor's whole cell set and
/// its current topology (`null` = no folds). Mirrors `runner::topology_edit::TopologyFloor`.
export interface TopologyFloorRequest {
  tessellation: WasmTessellationConfig;
  field_cells: [number, number][];
  topology: WireTopology | null;
}

export type InactiveFoldReason = "missing_cell" | "interior_neighbor" | "duplicate_neighbor";

export type FoldActivityDto = { state: "active" } | { state: "inactive"; reason: InactiveFoldReason };

/// Why core refused an edit (`runner::topology_edit::TopologyErrorDto`), with the sides
/// it concerns. `internal` is raised on the client for an error that carries no structure.
export type TopologyErrorDto =
  | { code: "empty_run" }
  | { code: "run_length_mismatch"; a: number; b: number }
  | { code: "open_contour"; face: WireFoldEnd }
  | { code: "inactive_fold"; reason: InactiveFoldReason; a: WireFoldEnd; b: WireFoldEnd; existing: boolean; connections?: [WireFoldEnd, WireFoldEnd][] }
  | { code: "face_in_use"; face: WireFoldEnd }
  | { code: "self_glued"; a: WireFoldEnd; b: WireFoldEnd }
  | { code: "unknown_group"; group: number }
  | { code: "inconsistent"; message: string }
  | { code: "internal"; message: string };

/// Activity and boundary contours of one floor (`topology_info`).
export interface TopologyInfo {
  /// One entry per fold, in `topology.folds` order; empty without folds.
  activity: FoldActivityDto[];
  /// Closed chains of boundary faces in traversal order (the field's cells stay on the left).
  contours: WireFoldEnd[][];
  /// Set when a boundary walk does not close (`contours` is then empty).
  contours_error?: TopologyErrorDto | null;
}

/// One topology edit; applied as a whole or not at all (`runner::topology_edit::TopologyOp`).
export type TopologyOp =
  /** `replace` glues in place of that existing group (keeping its id) instead of adding a new one. */
  | { kind: "glue"; a: WireFoldEnd[]; b: WireFoldEnd[]; twist: boolean; replace?: number }
  | { kind: "remove_group"; id: number };

export interface TopologyEditResult {
  topology: WireTopology;
  /// The id of the group the edit created; absent for remove / replace.
  group?: number | null;
}

/// Raised by `getTopologyInfo` / `editTopology`; `problem` is core's structured reason.
export class TopologyError extends Error {
  constructor(readonly problem: TopologyErrorDto) {
    super("message" in problem ? problem.message : problem.code);
  }
}

/// Core's refusals arrive as the JSON of a `TopologyErrorDto`; anything else (a malformed request)
/// has no structure and is wrapped as `internal`.
function parseTopologyError(text: string): TopologyErrorDto {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as { code?: unknown }).code === "string") {
      return parsed as TopologyErrorDto;
    }
  } catch {
    // Not JSON: fall through.
  }
  return { code: "internal", message: text };
}

function topologyCall<T>(call: () => unknown): T {
  try {
    return call() as T;
  } catch (error) {
    throw new TopologyError(parseTopologyError(typeof error === "string" ? error : error instanceof Error ? error.message : String(error)));
  }
}

/// Fold activity and boundary contours of one floor (GitHub issue #839).
export function getTopologyInfo(floor: TopologyFloorRequest): TopologyInfo {
  return topologyCall(() => getWasm().topology_info(floor));
}

/// One transactional edit of a floor's topology. On failure nothing changes: the thrown
/// `TopologyError` names the reason.
export function editTopology(floor: TopologyFloorRequest, op: TopologyOp): TopologyEditResult {
  return topologyCall(() => getWasm().topology_edit({ ...floor, op }));
}

/// The cell at a world point within `scope` (`null` = the whole tessellation space).
export function getCellAt(config: {
  tessellation: WasmTessellationConfig;
  point: WorldPoint;
  scope: [number, number][] | null;
}): [number, number] | null {
  return (getWasm().geometry_cell_at(config) as [number, number] | null | undefined) ?? null;
}

/// Cells matching the closed polygon `region` under `mode`. An unscoped (`scope: null`) region
/// whose bounding box holds more than core's `MAX_REGION_CANDIDATES` cells is an error.
export function getCellsInRegion(config: {
  tessellation: WasmTessellationConfig;
  region: WorldPoint[];
  mode: RegionMode;
  scope: [number, number][] | null;
}): [number, number][] {
  return getWasm().geometry_cells_in_region(config) as [number, number][];
}

/** Cells matching a region and their path boundaries, computed by core in one WASM call. */
/// The edges of the cells in a region, each shared edge once, as one flat command list
/// (`geometry_region_edges`).
export function getRegionEdges(config: {
  tessellation: WasmTessellationConfig;
  region: WorldPoint[];
  mode: RegionMode;
  scope: [number, number][] | null;
}): PathCommand[] {
  return getWasm().geometry_region_edges(config) as PathCommand[];
}

/** Mirrors `maze-wasm`'s `TessellationShapes` — see `tessellation_shapes`'s doc comment. A cell
 *  without a template comes back as `undefined` in `point_shapes`. */
export interface TessellationShapes {
  keys: string[];
  point_shapes: (string | undefined)[];
}

/// Shape templates of the tessellation instance `config.tessellation` builds (GitHub issue #758):
/// every template key it provides plus the template of each of `config.points`. The single source
/// for shape keys on the web side — `shapeTemplates.ts` memoizes it per tessellation config.
export function getTessellationShapes(config: { tessellation: WasmTessellationConfig; points: [number, number][] }): TessellationShapes {
  return getWasm().tessellation_shapes(config) as TessellationShapes;
}

/** Mirrors `maze-wasm`'s `TessellationCellTypes` — see `tessellation_cell_types`'s doc comment.
 *  Configs that parametrize generation or quality control by cell type name types by these keys. */
export interface TessellationCellTypes {
  keys: string[];
  point_types: string[];
}

/// Cell types of the tessellation instance `config.tessellation` builds (GitHub issue #822): every
/// type key it provides plus the type of each of `config.points`.
export function getTessellationCellTypes(config: { tessellation: WasmTessellationConfig; points: [number, number][] }): TessellationCellTypes {
  return getWasm().tessellation_cell_types(config) as TessellationCellTypes;
}

/** Why a field operation failed — mirrors `maze-runner`'s `FieldOpWireError`. */
export type FieldOpError =
  | { kind: "unavailable" | "not_a_symmetry" | "outside_tessellation" }
  | { kind: "invalid_preset" | "invalid_request"; message: string };

/** Mirrors `maze-runner`'s `FieldCapabilities` — see `field_capabilities`'s doc comment. */
export interface FieldCapabilities {
  operations: ("translate" | "reflect")[];
  presets: { key: string; params: { name: string; min: number; max?: number }[] }[];
}

export function getFieldCapabilities(tessellation: WasmTessellationConfig): FieldCapabilities {
  return getWasm().field_capabilities({ tessellation }) as FieldCapabilities;
}

/// Cells of a preset field shape built by `maze-core` (`field_preset`, GitHub issue #760), around
/// the tessellation origin. Throws the wire `FieldOpError` when core refuses the request.
export function getFieldPreset(
  tessellation: WasmTessellationConfig,
  preset: string,
  params: Record<string, number>,
): [number, number][] {
  return getWasm().field_preset({ tessellation, preset, params }) as [number, number][];
}

/// The topology a preset shape defines together with its cells (`field_preset_topology`, GitHub
/// issue #858); `null` for a preset that is only a shape. Throws the wire `FieldOpError`.
export function getFieldPresetTopology(
  tessellation: WasmTessellationConfig,
  preset: string,
  params: Record<string, number>,
): WireTopology | null {
  return (getWasm().field_preset_topology({ tessellation, preset, params }) as WireTopology | undefined) ?? null;
}

/// The crease lines a preset shape defines (`field_preset_creases`, GitHub issue #899): world-unit
/// segments `[[x, y], [x, y]]`, empty for a preset without any. Throws the wire `FieldOpError`.
export function getFieldPresetCreases(
  tessellation: WasmTessellationConfig,
  preset: string,
  params: Record<string, number>,
): [[number, number], [number, number]][] {
  return getWasm().field_preset_creases({ tessellation, preset, params }) as [[number, number], [number, number]][];
}

/// `[[min, max], [min, max]]` of a preset shape's cell boundaries along two world directions.
export function getFieldPresetExtents(
  tessellation: WasmTessellationConfig,
  preset: string,
  params: Record<string, number>,
  directions: [[number, number], [number, number]],
): [[number, number], [number, number]] {
  return getWasm().field_preset_extents({ tessellation, preset, params, directions }) as [[number, number], [number, number]];
}

/// Size of a preset shape that fills a printable area with the most cells (GitHub issue #939): the
/// search runs in core. `null` when nothing fits. `width`/`height` are the result in cell sides.
export interface PrintSizingRequest {
  tessellation: WasmTessellationConfig;
  preset: string;
  params: Record<string, number>;
  directions: [[number, number], [number, number]];
  cellSide: number;
  usableWidthMm: number;
  usableHeightMm: number;
  cellSideMm: number;
  axisAligned: boolean;
}

/// `limit` is the search cap the answer sits on (the sheet may hold a larger field), else `null`.
export interface PrintSizingAnswer {
  params: Record<string, number>;
  width: number;
  height: number;
  limit: number | null;
}

export function getFieldPrintSizing(request: PrintSizingRequest): PrintSizingAnswer | null {
  return getWasm().field_print_sizing({
    tessellation: request.tessellation,
    preset: request.preset,
    params: request.params,
    directions: request.directions,
    cell_side: request.cellSide,
    usable_width_mm: request.usableWidthMm,
    usable_height_mm: request.usableHeightMm,
    cell_side_mm: request.cellSideMm,
    axis_aligned: request.axisAligned,
  }) as PrintSizingAnswer | null;
}

/// Sizes of the cells of one cell type (`field_cell_sizes`, GitHub issue #948), in world units.
/// `sides` and `diameter` are empty / `0` when the type's cells differ in size (`regular` false).
export interface CellTypeSizes {
  key: string;
  count: number;
  sides: number[];
  diameter: number;
  regular: boolean;
}

/// What `field_cell_sizes` reports: numbers only, never cells.
export interface CellSizesReport {
  types: CellTypeSizes[];
  /** Cells of one floor of each requested preset, in request order (`0` for a refused preset). */
  presetCounts: number[];
}

/// The count, sides and diameter of the cells of each cell type among the cells of `presets` (built
/// by core, so they never cross the wasm boundary) and the hand-given `cells`, measured by core.
export function getFieldCellSizes(
  tessellation: WasmTessellationConfig,
  source: { presets: { preset: string; params: Record<string, number>; times: number }[]; cells: [number, number][] },
): CellSizesReport {
  const report = getWasm().field_cell_sizes({ tessellation, presets: source.presets, cells: source.cells }) as {
    types: CellTypeSizes[];
    preset_counts: number[];
  };
  return { types: report.types, presetCounts: report.preset_counts };
}

/// Cells moved by a world-unit vector that must be a translation symmetry of the tessellation.
export function translateFieldCells(
  tessellation: WasmTessellationConfig,
  cells: [number, number][],
  vector: [number, number],
): [number, number][] {
  // Core re-verifies that `vector` is a translation symmetry on every call, which is slow on dense
  // tessellations; a drag repeats the same request on every pointer event inside one cell and
  // again at commit, so the latest results are reused.
  const key = JSON.stringify([tessellation, cells, vector]);
  const hit = translateCache.get(key);
  if (hit) return hit.map(([x, y]) => [x, y]);
  const result = getWasm().field_translate_cells({ tessellation, cells, vector }) as [number, number][];
  translateCache.set(key, result);
  if (translateCache.size > TRANSLATE_CACHE_SIZE) translateCache.delete(translateCache.keys().next().value!);
  return result.map(([x, y]) => [x, y]);
}

const TRANSLATE_CACHE_SIZE = 16;
/// Only successful results are stored: a refused translation throws and is recomputed.
const translateCache = new Map<string, [number, number][]>();

/// Cells mirrored across the world line through two points; it must be a reflection symmetry.
export function reflectFieldCells(
  tessellation: WasmTessellationConfig,
  cells: [number, number][],
  axis: [[number, number], [number, number]],
): [number, number][] {
  return getWasm().field_reflect_cells({ tessellation, cells, axis }) as [number, number][];
}
