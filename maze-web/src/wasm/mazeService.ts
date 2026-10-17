import { getWasm } from "./wasmLoader";
import type { NodeDto, EdgeDto, NavNodeDto, NavEdgeDto, IssueDto, MazeSnapshot, CheckDescriptor, StrategyDescriptor, RuleParamDescriptor, GenerateConfig, ComputeAnalyticsConfig, WasmTessellationConfig } from "./types";
import type { DebugValueDescriptor, DebugValueKind } from "../debug/eventTape";

function isNodeDto(v: unknown): v is NodeDto {
  return typeof v === "object" && v !== null &&
    typeof (v as NodeDto).id === "number" &&
    typeof (v as NodeDto).x === "number" &&
    typeof (v as NodeDto).y === "number" &&
    typeof (v as NodeDto).i === "number";
}

function isEdgeDto(v: unknown): v is EdgeDto {
  return typeof v === "object" && v !== null &&
    typeof (v as EdgeDto).from === "number" &&
    typeof (v as EdgeDto).to === "number";
}

function isNavNodeDto(v: unknown): v is NavNodeDto {
  return typeof v === "object" && v !== null &&
    typeof (v as NavNodeDto).node_id === "number";
}

function isNavEdgeDto(v: unknown): v is NavEdgeDto {
  return typeof v === "object" && v !== null &&
    typeof (v as NavEdgeDto).from === "number" &&
    typeof (v as NavEdgeDto).to === "number" &&
    Array.isArray((v as NavEdgeDto).path) &&
    (v as NavEdgeDto).path.every((n: unknown) => typeof n === "number");
}

function isIssueDto(v: unknown): v is IssueDto {
  return typeof v === "object" && v !== null &&
    typeof (v as IssueDto).kind === "string";
}

/** Debug event tape (GitHub issue #124) — node table + payload byte arena, both eagerly copied
 *  out of WASM linear memory at read time. The WASM-side buffers are zero-copy views that get
 *  invalidated by the next call into the WASM module (see `GenerateResult` doc comments in
 *  `maze-wasm/src/result.rs`), so this is the point where that constraint is discharged — every
 *  consumer downstream of `generateMaze` gets a plain owned `Uint8Array`, safe to hold onto.
 *
 *  Intermediate snapshot checkpoints (GitHub issue #128) are computed entirely on the web side
 *  from this tape (see `eventTape.ts`'s `resolveDebugArenaMetadata`) — the core has no notion of
 *  "snapshot" and never crosses the WASM boundary with one. */
export interface DebugTape {
  nodeTable: Uint8Array;
  payload: Uint8Array;
  /** Name of each top-level source scope in the merged tape's tree (GitHub issue #169), same
   *  order as `sourceEventKinds`, sourced from `GenerateResult::sourceScopeNames()` — e.g.
   *  `["generation"]` today. */
  sourceScopeNames: string[];
  /** Parallel to `sourceScopeNames` — which concrete event enum each source scope's subtree was
   *  encoded from (GitHub issue #146, generalized by #169), sourced from
   *  `GenerateResult::sourceEventKinds()`. Tells downstream consumers
   *  (`generateConfigBuilder.ts`, `debugSelectors.ts`, `DebugEventTree.tsx`) which decoder/apply/
   *  narration function to dispatch to — see `DebugArenaHandle.sources` in `storeTypes.ts` (GitHub
   *  issue #147: a merged tape may now carry more than one top-level source, e.g. `"generation"`
   *  + `"quality_control"`). */
  sourceEventKinds: EventedEventKind[];
  /** Debug values (GitHub issue #131, e.g. `"recursion_stack"`) declared by the instrumented
   *  algorithm, each with its rendering `kind` — the static list from
   *  `GenerateResult::debugValueNames()`/`debugValueKinds()` (zipped together, see
   *  `generateMaze()` below), not derived from what this particular run happened to emit (a
   *  trivial run that never triggers a delta would otherwise silently omit a name the algorithm
   *  still supports). Empty when the algorithm isn't instrumented for debug values yet. Plain
   *  array, not a WASM buffer — no copy-before-free concern like `nodeTable`/`payload`. */
  debugValueNames: DebugValueDescriptor[];
  /** Nodes minted mid-run (preset split, pattern-mode split, QC/repair mint), including ones
   *  later removed or replaced by QC/repair (GitHub issue #271) — sourced from
   *  `GenerateResult::debugAllNodes()`. Not itself a full "every node that ever existed" union —
   *  see `DebugArenaHandle.allNodes` in `storeTypes.ts` for the full rationale and what consumers
   *  must do to get the actual union. Separate from `MazeSnapshot.nodes` (final survivors only). */
  allNodes: NodeDto[];
}

/** Mirrors `event_kind_wire_str` in `maze-wasm/src/result.rs` — which concrete event enum a
 *  tape's bytes were encoded from. */
export type EventedEventKind = "preset_setup" | "recursive_backtracker" | "kruskal" | "wilson" | "vertex_based" | "quality_control";

function toEventedEventKind(raw: string): EventedEventKind {
  if (
    raw !== "preset_setup" && raw !== "recursive_backtracker" && raw !== "kruskal" && raw !== "wilson" &&
    raw !== "vertex_based" && raw !== "quality_control"
  ) {
    throw new Error(`unknown event kind "${raw}"`);
  }
  return raw;
}

export interface GenerateMazeResult {
  snapshot: MazeSnapshot;
  debugTape: DebugTape | undefined;
}

/** Runs generation off the main thread so long WASM calls can provide responsive UI feedback. */
export function generateMazeAsync(seed: number, config: GenerateConfig): Promise<GenerateMazeResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./generationWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<GenerateMazeResult | { error: string }>) => {
      worker.terminate();
      if ("error" in event.data) reject(new Error(event.data.error));
      else resolve(event.data);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || "Generation worker failed"));
    };
    worker.postMessage({ seed, config });
  });
}

interface AnalyticsWorkerResponse {
  error: string;
}

interface ActiveAnalyticsRequest {
  worker: Worker;
  reject: (reason?: unknown) => void;
  settled: boolean;
}

let activeAnalyticsRequest: ActiveAnalyticsRequest | null = null;

/** Runs the expensive analytics-only WASM call off the UI thread. A newer request supersedes the
 * previous one, so rapid rule edits do not leave a pool of stale cycle analyses running in the
 * background. `confirmPostEdit`'s request id still protects the store from a result that raced
 * with another state change after the worker completed. */
export function computeAnalyticsAsync(config: ComputeAnalyticsConfig): Promise<MazeSnapshot> {
  if (activeAnalyticsRequest !== null) {
    const previous = activeAnalyticsRequest;
    activeAnalyticsRequest = null;
    previous.settled = true;
    previous.worker.terminate();
    previous.reject(new Error("Analytics request superseded"));
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./analyticsWorker.ts", import.meta.url), { type: "module" });
    const request: ActiveAnalyticsRequest = { worker, reject, settled: false };
    activeAnalyticsRequest = request;

    const finish = (callback: () => void): void => {
      if (request.settled) return;
      request.settled = true;
      if (activeAnalyticsRequest === request) activeAnalyticsRequest = null;
      worker.terminate();
      callback();
    };

    worker.onmessage = (event: MessageEvent<unknown>) => {
      if (isAnalyticsWorkerResponse(event.data)) {
        const message = event.data.error;
        finish(() => reject(new Error(message)));
        return;
      }
      try {
        const snapshot = validateSnapshot(event.data);
        finish(() => resolve(snapshot));
      } catch (error) {
        finish(() => reject(error));
      }
    };
    worker.onerror = (event) => {
      finish(() => reject(new Error(event.message || "Analytics worker failed")));
    };
    try {
      worker.postMessage({ config });
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

function isAnalyticsWorkerResponse(value: unknown): value is AnalyticsWorkerResponse {
  return typeof value === "object" && value !== null &&
    typeof (value as AnalyticsWorkerResponse).error === "string";
}

/** Zips `GenerateResult::debugValueNames()`/`debugValueKinds()`'s parallel arrays (see
 *  `maze-wasm/src/result.rs`'s `kind_wire_str`) into `DebugValueDescriptor`s. Both arrays are
 *  always the same length by construction on the Rust side — asserted here so a mismatch (e.g.
 *  a future wire-format change on one side but not the other) fails loudly instead of silently
 *  truncating or misaligning names against kinds. */
function zipDebugValueNames(names: string[], kinds: string[]): DebugValueDescriptor[] {
  if (names.length !== kinds.length) {
    throw new Error(`debugValueNames/debugValueKinds length mismatch: ${names.length} vs ${kinds.length}`);
  }
  return names.map((name, i) => {
    const kind = kinds[i];
    if (kind !== "region" && kind !== "sequence" && kind !== "map" && kind !== "vertex") {
      throw new Error(`unknown debug value kind "${kind}" for "${name}"`);
    }
    return { name, kind: kind as DebugValueKind };
  });
}

function validateSnapshot(raw: unknown): MazeSnapshot {
  if (typeof raw !== "object" || raw === null) throw new Error("WASM returned invalid snapshot");
  const s = raw as Record<string, unknown>;
  if (!Array.isArray(s.nodes) || !s.nodes.every(isNodeDto))
    throw new Error("WASM snapshot: invalid nodes");
  if (!Array.isArray(s.edges) || !s.edges.every(isEdgeDto))
    throw new Error("WASM snapshot: invalid edges");
  if (!Array.isArray(s.issues) || !s.issues.every(isIssueDto))
    throw new Error("WASM snapshot: invalid issues");
  if (!Array.isArray(s.nav_nodes) || !s.nav_nodes.every(isNavNodeDto))
    throw new Error("WASM snapshot: invalid nav_nodes");
  if (!Array.isArray(s.nav_edges) || !s.nav_edges.every(isNavEdgeDto))
    throw new Error("WASM snapshot: invalid nav_edges");
  const nodeIds = new Set<number>((s.nodes as NodeDto[]).map(n => n.id));
  for (const e of s.edges as EdgeDto[]) {
    if (!nodeIds.has(e.from)) throw new Error(`WASM snapshot: edge.from ${e.from} not in nodes`);
    if (!nodeIds.has(e.to)) throw new Error(`WASM snapshot: edge.to ${e.to} not in nodes`);
  }
  return s as unknown as MazeSnapshot;
}

export function getAvailableChecks(): CheckDescriptor[] {
  return getWasm().available_checks() as CheckDescriptor[];
}

export function getAvailableStrategies(): StrategyDescriptor[] {
  return getWasm().available_strategies() as StrategyDescriptor[];
}

export function getAvailableRuleParams(): RuleParamDescriptor[] {
  return getWasm().available_rule_params() as RuleParamDescriptor[];
}

export function generateMaze(seed: number, config: GenerateConfig): GenerateMazeResult {
  const result = getWasm().generate(BigInt(seed), config);
  try {
    const snapshot = validateSnapshot(result.snapshot());

    // Copy the debug tape buffers out of WASM linear memory now — the WASM-side views are
    // invalidated by the next call into the module (see `GenerateResult` doc comments in
    // `maze-wasm/src/result.rs`), so this is the only safe place to read them.
    const nodeTable = result.debugTapeNodeTable();
    const payload = result.debugTapePayload();
    let debugTape: DebugTape | undefined;
    if (nodeTable && payload) {
      const sourceScopeNames = result.sourceScopeNames();
      const rawSourceEventKinds = result.sourceEventKinds();
      if (sourceScopeNames.length === 0 || rawSourceEventKinds.length === 0) {
        throw new Error("generateMaze: debug tape present but sourceScopeNames/sourceEventKinds is empty");
      }
      if (sourceScopeNames.length !== rawSourceEventKinds.length) {
        throw new Error(`generateMaze: sourceScopeNames/sourceEventKinds length mismatch: ${sourceScopeNames.length} vs ${rawSourceEventKinds.length}`);
      }
      const rawAllNodes = result.debugAllNodes();
      const allNodes = Array.isArray(rawAllNodes) && rawAllNodes.every(isNodeDto) ? rawAllNodes : [];
      debugTape = {
        nodeTable: nodeTable.slice(),
        payload: payload.slice(),
        sourceScopeNames,
        sourceEventKinds: rawSourceEventKinds.map(toEventedEventKind),
        debugValueNames: zipDebugValueNames(result.debugValueNames(), result.debugValueKinds()),
        allNodes,
      };
    }

    return { snapshot, debugTape };
  } finally {
    // `GenerateResult` is a wasm-bindgen class — its Rust-side allocation (including the debug
    // tape buffers) is only released on an explicit `free()`, not by JS garbage collection.
    result.free();
  }
}

export function computeAnalytics(config: ComputeAnalyticsConfig): MazeSnapshot {
  const raw = getWasm().compute_analytics(config);
  return validateSnapshot(raw);
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
  boundary: B;
  faces: FaceGeometry[];
}

export type PolylineCellGeometry = CellGeometry<PolylineBoundary>;
export type PathCellGeometry = CellGeometry<PathBoundary>;

export interface GeometrySnapshot<B extends PathBoundary | PolylineBoundary = PathBoundary | PolylineBoundary> {
  instance: string;
  field_version: number;
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
}): GeometrySnapshot<PolylineBoundary>;
export function getGeometrySnapshot(config: {
  tessellation: WasmTessellationConfig;
  cells: [number, number][];
  boundary: { kind: "path" };
  fieldVersion: number;
}): GeometrySnapshot<PathBoundary>;
export function getGeometrySnapshot(config: {
  tessellation: WasmTessellationConfig;
  cells: [number, number][];
  boundary: BoundaryRequest;
  fieldVersion: number;
}): GeometrySnapshot {
  return getWasm().geometry_snapshot({
    tessellation: config.tessellation,
    cells: config.cells,
    boundary: config.boundary,
    field_version: config.fieldVersion,
  }) as GeometrySnapshot;
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

/** Why a field operation failed — mirrors `maze-runner`'s `FieldOpWireError`. */
export type FieldOpError =
  | { kind: "unavailable" | "not_a_symmetry" | "outside_tessellation" | "connectivity_broken" }
  | { kind: "invalid_preset" | "invalid_request"; message: string };

/** Mirrors `maze-runner`'s `FieldCapabilities` — see `field_capabilities`'s doc comment. */
export interface FieldCapabilities {
  operations: ("translate" | "reflect")[];
  presets: { key: string; params: { name: string; min: number }[] }[];
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

/// Cells moved by a world-unit vector that must be a translation symmetry of the tessellation.
export function translateFieldCells(
  tessellation: WasmTessellationConfig,
  cells: [number, number][],
  vector: [number, number],
): [number, number][] {
  return getWasm().field_translate_cells({ tessellation, cells, vector }) as [number, number][];
}

/// Cells mirrored across the world line through two points; it must be a reflection symmetry.
export function reflectFieldCells(
  tessellation: WasmTessellationConfig,
  cells: [number, number][],
  axis: [[number, number], [number, number]],
): [number, number][] {
  return getWasm().field_reflect_cells({ tessellation, cells, axis }) as [number, number][];
}
