import { getWasm } from "./wasmLoader";
import type { NodeDto, EdgeDto, NavNodeDto, NavEdgeDto, IssueDto, MazeSnapshot, CheckDescriptor, StrategyDescriptor, GenerateConfig, ComputeAnalyticsConfig } from "./types";

function isNodeDto(v: unknown): v is NodeDto {
  return typeof v === "object" && v !== null &&
    typeof (v as NodeDto).id === "number" &&
    typeof (v as NodeDto).x === "number" &&
    typeof (v as NodeDto).y === "number";
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
 *  `snapshotTable`/`snapshotPayload` (GitHub issue #128) carry intermediate snapshot checkpoints
 *  — present exactly when the core recorded at least the checkpoint infrastructure for this run
 *  (i.e. whenever `nodeTable`/`payload` are, since both come from the same Recursive Backtracker
 *  run); `undefined` otherwise. Independent buffers, not folded into `nodeTable`/`payload`, per
 *  `maze-core/src/event_log/checkpoint.rs`'s `CheckpointLog` living apart from the event arena. */
export interface DebugTape {
  nodeTable: Uint8Array;
  payload: Uint8Array;
  snapshotTable?: Uint8Array;
  snapshotPayload?: Uint8Array;
}

export interface GenerateMazeResult {
  snapshot: MazeSnapshot;
  debugTape: DebugTape | undefined;
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
  if (!Array.isArray(s.debug_steps) || !(s.debug_steps as unknown[]).every(
    (step: unknown) => typeof step === "object" && step !== null &&
      Array.isArray((step as Record<string, unknown>).edges) &&
      Array.isArray((step as Record<string, unknown>).active_nodes)
  )) throw new Error("WASM snapshot: invalid debug_steps");
  return s as unknown as MazeSnapshot;
}

export function getAvailableChecks(): CheckDescriptor[] {
  return getWasm().available_checks() as CheckDescriptor[];
}

export function getAvailableStrategies(): StrategyDescriptor[] {
  return getWasm().available_strategies() as StrategyDescriptor[];
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
    // Checkpoint buffers (GitHub issue #128) — copied only when present; no empty-array
    // placeholders are created when the core recorded no checkpoints.
    const snapshotTable = result.debugSnapshotTable();
    const snapshotPayload = result.debugSnapshotPayload();
    const debugTape: DebugTape | undefined = nodeTable && payload
      ? {
          nodeTable: nodeTable.slice(),
          payload: payload.slice(),
          ...(snapshotTable && snapshotPayload
            ? { snapshotTable: snapshotTable.slice(), snapshotPayload: snapshotPayload.slice() }
            : {}),
        }
      : undefined;

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

/// Canonical (unrotated, unit-tile-scale) Cartesian projection of each point, in the same order
/// as `config.points` -- see `cartesian_coords`'s doc comment in `maze-wasm/src/lib.rs`. Single
/// source of truth for tile geometry: `tessellationGeometry.ts`'s `getCellCenter` scales and
/// (for hex/tri) rotates this per the caller's tessellation config, rather than duplicating the
/// per-tessellation projection formulas in TypeScript.
export function getCartesianCoords(config: { tessellation_type: "square" | "hex" | "tri"; points: [number, number][] }): [number, number][] {
  return getWasm().cartesian_coords(config) as [number, number][];
}
