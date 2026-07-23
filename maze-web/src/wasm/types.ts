export interface NodeDto {
  id: number;
  x: number;
  y: number;
}

// Note: (from, to) is not unique across MazeSnapshot.edges — a Basic and a Teleport edge
// can coexist in the same direction between the same pair, each as its own entry.
export interface EdgeDto {
  from: number;
  to: number;
  kind: "basic" | "teleport";
}

export interface NavNodeDto {
  node_id: number;
}

export interface NavEdgeDto {
  from: number;
  to: number;
  path: number[];
}

export interface JunctionBucket {
  degree: number;
  count: number;
}

export interface NodeStatsDto {
  dead_ends: number;
  straight: number;
  turns: number;
  junctions: JunctionBucket[];
  teleport_entries: number;
}

export interface SpatialEdgeStatsDto {
  bidirectional: number;
  one_way_passages: number;
  walls: number;
}

export interface TeleportEdgeStatsDto {
  two_way: number;
  one_way: number;
}

export interface RouteInfoDto {
  path_length: number;
  junction_count: number;
  one_way_count: number;
  score: number | null;
  path: number[];
}

export interface GraphAnalyticsDto {
  node_count: number;
  edge_count: number;
  component_count: number;
  /** Number of independent cycles (E - V + C on the pure-cycle core). */
  cycle_count: number;
  /** Number of connected cyclic regions. */
  cycle_region_count: number;
  /** maze node id (as string key) → component_id. Covers junctions and corridor nodes. */
  node_component: Record<string, number>;
  /** maze node ids in the pure-cycle core (real cycles only, no bridges). */
  pure_cycle_node_ids: number[];
  /** nav-edge pairs [from_maze_id, to_maze_id] in the pure-cycle core. */
  pure_cycle_edge_pairs: [number, number][];
  /** True if cycle enumeration aborted (graph has too many simple cycles to analyze) — when
   *  true, cycle_count/cycle_region_count/pure_cycle_node_ids/pure_cycle_edge_pairs are empty
   *  placeholders, not real results. */
  cycle_analysis_overflowed: boolean;
  /** SCC region class relative to start/finish — "path" | "alternative" | "unreachable" |
   *  "trap" — keyed by component_id (string key). Empty when start or finish is unset. */
  region_classes: Record<string, RegionClass>;
}

export type RegionClass = "path" | "alternative" | "unreachable" | "trap";

/** Tagged payload for `IssueDto` — a real discriminated union (narrow on `kind`) mirroring
 * Rust's `IssuePayloadDto`. `IssueDto.kind` remains the source of truth for UI filtering/labels;
 * `payload.kind` is only a narrowing discriminant for which payload fields are present. */
export type IssuePayloadDto =
  | { kind: "none" }
  | {
      kind: "invalid_loop";
      /** Keyed by source check id — each entry is one invalid cycle's base-graph edges as
       * [from, to] maze node-id pairs, for highlight rendering. Keyed per check (not one flat
       * list) so hovering one check's bubble highlights only the cycles that check flagged, not
       * every contributing check's cycles combined. */
      edges: Record<string, [number, number][][]>;
    }
  | {
      kind: "region_needs_expansion";
      /** Keyed by source check id — each entry is one flagged SCC region's member maze node ids
       * (not edges — the UI derives the region's perimeter client-side from this node set, the
       * same way preset boundary walls are derived from a cell set). Keyed per check for the same
       * reason as the `invalid_loop` variant's `edges`. */
      nodes: Record<string, number[][]>;
    }
  | {
      kind: "region_needs_shrink";
      /** Mirrors `region_needs_expansion`'s `nodes` shape, for an oversized region flagged for
       * shrinking instead (`max_region_size`/`max_region_ratio`). */
      nodes: Record<string, number[][]>;
    }
  | {
      kind: "invalid_teleport";
      /** Keyed by source check id — each entry is one flagged teleport "group", expressed as
       * [from, to] maze node-id pairs, one pair per teleport edge in the group. A single invalid
       * teleport (`invalid_teleport`) is a group of size one; a proximity pair
       * (`invalid_teleport_group`) is a group of size two — both share this payload shape. Keyed
       * per check for the same reason as the `invalid_loop` variant's `edges`. */
      groups: Record<string, [number, number][][]>;
    }
  | {
      kind: "invalid_one_way";
      /** Keyed by source check id — each entry is one flagged one-way "group", expressed as
       * [from, to] maze node-id pairs, one pair per one-way edge in the group. A single invalid
       * one-way (`invalid_one_way`) is a group of size one; a proximity/super-hub/count-excess
       * group (`invalid_one_way_group`) can be any size — both share this payload shape. Keyed
       * per check for the same reason as the `invalid_loop` variant's `edges`. */
      groups: Record<string, [number, number][][]>;
    };

export interface IssueDto {
  kind: string;
  payload: IssuePayloadDto;
  /** Opaque per-instance check id(s) that produced or contributed to this issue — lets the UI
   * render one bubble per contributing check rather than one per `kind`. Not a check type id by
   * itself (see GitHub issue #60) — resolve the type id via `source_check_types`. */
  source_checks: string[];
  /** `source_checks` entry -> check type id (`CheckDescriptor.id`) — needed because
   * `source_checks` entries are opaque per-instance ids, not type ids, so per-check-type lookups
   * (`DETAIL_LABELS` in `issueRegistry.ts`) can't key off them directly. */
  source_check_types: Record<string, string>;
  /** Raw display values keyed by source check id then by detail key, e.g.
   * `{"max_loop_length": {"max_loop_length": "100"}}`. Never assembled messages — only used
   * to fill in i18n templates keyed by check id (see `issueRegistry.ts`). */
  details: Record<string, Record<string, string>>;
}

export interface TimingEntryDto {
  total_ms: number;
  calls: number;
}

/** Per-stage and per-check/per-strategy timing breakdown for one generation run — only present
 *  on snapshots from `runGenerate` (the full generate→QC→repair pipeline). Post-edit/
 *  compute-analytics snapshots never run generation, so `MazeSnapshot.timing` is `null` there. */
export interface GenerationTimingDto {
  initial_build_ms: number;
  qc_total_ms: number;
  repair_total_ms: number;
  /** Keyed by check type id (e.g. "min_loop_length"), aggregated across every active instance. */
  per_check: Record<string, TimingEntryDto>;
  /** Keyed by strategy id (e.g. "invalid_loop_random"). */
  per_strategy: Record<string, TimingEntryDto>;
}

export interface MazeSnapshot {
  nodes: NodeDto[];
  edges: EdgeDto[];
  start: number | null;
  finish: number | null;
  issues: IssueDto[];
  nav_nodes: NavNodeDto[];
  nav_edges: NavEdgeDto[];
  node_stats: NodeStatsDto;
  edge_stats: SpatialEdgeStatsDto;
  teleport_edge_stats: TeleportEdgeStatsDto;
  route_info: RouteInfoDto | null;
  graph_analytics: GraphAnalyticsDto;
  timing: GenerationTimingDto | null;
}

export interface CheckDescriptor {
  id: string;
  label: string;
  description: string;
  issue_kinds: string[];
  params: ParamDescriptor[];
  /** Whether more than one independent instance of this check type may be active at once
   * (across rules, or within the same rule) — see GitHub issue #60, retired: no check currently
   * sets this `true` (`min_region_count` now evaluates all four region classes in one instance
   * instead of needing one instance per class). */
  allow_multiple_instances: boolean;
}

export type ParamKind =
  | { type: "float"; default: number; min: number; max: number }
  | { type: "integer"; default: number; min: number; max: number }
  | { type: "bool"; default: boolean }
  | { type: "enum"; options: string[]; default: string }
  | { type: "interval"; default_min: number; default_max: number; min: number; max: number };

export interface ParamDescriptor {
  id: string;
  label: string;
  kind: ParamKind;
}

/** Mirrors core's `NestedSlot` — one nested-strategy slot a strategy accepts. `slot_id` is a
 * stable, opaque identifier (part of the strategy's public config API — see
 * `Specs/repair.md`'s nested-strategy pattern), not meant for display. */
export interface NestedSlotDescriptor {
  slot_id: string;
  kind: string;
  min: number;
  max: number | null;
}

export interface StrategyDescriptor {
  id: string;
  handles: string;
  params: ParamDescriptor[];
  /** Strategy's results/performance may be unpredictable — UI shows a warning. */
  experimental: boolean;
  /** Nested-strategy slots this strategy accepts, if any — empty for every strategy without
   * nested slots (the overwhelming majority). */
  nested_slots: NestedSlotDescriptor[];
}

export interface StrategyConfig {
  id: string;
  params: Record<string, string>;
  /** Which parent slot this fills — required when this `StrategyConfig` is nested inside
   * another one's `nested`, must be absent for a rule's top-level strategy. */
  slot_id?: string;
  /** Nested strategy assignments, in configured order — empty for strategies without nested
   * slots. Recursive. */
  nested?: StrategyConfig[];
}

/** One active check, declared inline inside the `QcRuleConfig` it belongs to — see GitHub issue
 * #60. `local_id` is unique only within this rule's `checks`, not globally; `type_id` is the
 * check type's wire id (`CheckDescriptor.id`). */
export interface CheckInstanceConfig {
  local_id: string;
  type_id: string;
  params: Record<string, string>;
}

export interface QcRuleConfig {
  id: string;
  checks: CheckInstanceConfig[];
  strategy: StrategyConfig | null;
}

/** A named, ordered group of rules — see `Specs/repair.md`'s "Stages" section and GitHub issue
 * #65. `RepairEngine` dispatches one stage at a time, in `GenerateConfig.stages` array order. */
export interface StageConfig {
  id: string;
  name: string;
  rules: QcRuleConfig[];
}

export type TessellationKindWasm = "square" | "hex" | "tri";

export interface WasmTessellationConfig {
  tessellation_type: TessellationKindWasm;
  points: [number, number][];
}

export interface GenerationParams {
  depth_first?: number;
  corridor_chance?: number;
  branching?: number;
  directionality?: number;
  cyclicity?: number;
}

export interface EdgeBasedParams {
  corridor_length?: number;
  branching?: number;
  depth_first?: number;
  directionality?: number;
  cyclicity?: number;
}

export interface ElementsConfig {
  one_way_chance?: number;
  teleport_chance?: number;
  teleport_one_way_chance?: number;
}

export type InitialGenerationConfig =
  | ({ method: "custom_vertex_based" } & GenerationParams)
  | ({ method: "custom_edge_based" } & EdgeBasedParams)
  | { method: "recursive_backtracker" }
  | { method: "wilson_algorithm" }
  | { method: "kruskal_algorithm" };

export type PresetConnectionState = "wall" | "passage" | "one_way_forward" | "one_way_backward" | "teleport_forward" | "teleport_backward" | "teleport_two_way";

/** Wire shape for a preset endpoint (GitHub issue #231) — a point plus an optional slot
 * addressing one of that point's declared extra ("split") nodes. `slot: undefined` means the
 * point's original node. Mirrors Rust's `PresetEndpointDto`/`PresetEndpoint`. */
export interface PresetEndpointDto {
  point: [number, number];
  slot?: number;
}

export interface PresetConnection {
  from: PresetEndpointDto;
  to: PresetEndpointDto;
  state: PresetConnectionState;
}

export type NodeLockKind = "in" | "out" | "both";

export interface LockedNodeDto {
  point: PresetEndpointDto;
  kind: NodeLockKind;
}

export interface GenerateConfig {
  tessellation: WasmTessellationConfig;
  stages: StageConfig[];
  repair_max_iterations?: number;
  repair_time_budget_secs?: number;
  initial: InitialGenerationConfig;
  elements: ElementsConfig;
  preset_connections?: PresetConnection[];
  locked_nodes?: LockedNodeDto[];
  preset_start?: PresetEndpointDto;
  preset_finish?: PresetEndpointDto;
  preset_gen_source?: PresetEndpointDto;
  /** Extra nodes to create at declared points before any preset above is resolved (GitHub issue
   * #231) — `[[x, y], slotId]` pairs. Mirrors Rust's `GenerateConfig.split_points`. */
  split_points?: [[number, number], number][];
  debug_events?: boolean;
  qc_experiment?: boolean;
}

export type PostEditEdgeKind = "basic" | "one_way" | "teleport";

/** Mirrors Rust's `PostEditEndpointDto` — either a plain existing node id, or a reference to one
 * of a split point's extra nodes by its stable `slotId` (GitHub issue #221). WASM resolves `split`
 * endpoints itself via `split_points`, applied before edges in the same call. */
export type PostEditEndpointWasmDto =
  | { kind: "node"; id: number }
  | { kind: "split"; point: [number, number]; slot_id: number };

export interface PostEditEdgeWasmDto {
  from: PostEditEndpointWasmDto;
  to: PostEditEndpointWasmDto;
  /** Direction already normalized: from→to is the actual passage/teleport direction. "teleport"
   * adds only that one direction — a two-way teleport is sent as two separate entries. */
  kind: PostEditEdgeKind;
}

export interface ComputeAnalyticsConfig {
  tessellation: WasmTessellationConfig;
  /** Node coordinates — mirrors tessellation.points for API clarity. */
  nodes: ReadonlyArray<[number, number]>;
  /** Passage edges only (walls = absence of edge). */
  edges: PostEditEdgeWasmDto[];
  /** Extra nodes to add to split points before edges are resolved — each entry is one
   * `(point, slotId)` pair (GitHub issue #221). Applied via `Maze::add_node_at` in a deterministic
   * `(point, slotId)`-sorted order on the Rust side — this array's own order doesn't matter. */
  split_points?: [[number, number], number][];
  /** Plain resolved node id — NOT a `PostEditEndpointWasmDto`. `Maze::meta.start`/`.finish` in
   * `maze-core` are always `Option<NodeId>`; the frontend resolves `PostEditEndpoint` to a
   * concrete id (or `null` if it doesn't resolve yet) before building this config — see
   * `confirmPostEdit` in `postEditSlice.ts`. */
  start: number | null;
  finish: number | null;
  checks: CheckInstanceConfig[];
}
