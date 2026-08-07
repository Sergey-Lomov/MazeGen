/** `i` is a node's stable index among its point's nodes (GitHub issue #236) — `0` is always the
 * point's original node (never removable by post-edit), `1, 2, ...` are extra split-point slots in
 * creation order. Unlike a position in a rebuilt list, `i` never shifts or gets compacted when an
 * earlier-created sibling at the same point is removed. */
export interface NodeDto {
  id: number;
  x: number;
  y: number;
  i: number;
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
  split_count: number;
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
  /** Raw count of all simple cycles (composite-inclusive) — always >= cycle_count. */
  simple_cycle_count: number;
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

/** One maze-wide group of split tiles sharing the same canonical topology (the same pattern
 *  applied at any rotation/mirror, node creation order ignored — see
 *  `maze_core::graph::split_topology`). `topology[i]` is one node's per-face-position requirement
 *  list (length = tessellation degree, `SplitFaceRequirement` — see below), reconstructed from the
 *  built graph rather than authored (`unspecified` never appears in practice, indistinguishable
 *  from a plain absent edge after the fact). The outer list is sorted (order-independent), so it
 *  also serves as a stable key for a client-side title registry (e.g. `JSON.stringify(topology)`).
 *  Declared here, ahead of `SplitFaceRequirement`'s own declaration further down this file, since
 *  both describe the same wire shape and belong together conceptually. */
export interface SplitGroupDto {
  topology: SplitFaceRequirement[][];
  count: number;
}

/** Maze-wide split totals, independent of any route (contrast `RouteInfoDto.split_count`, which
 *  counts split occurrences along one specific route) — see GitHub issue #262. */
export interface SplitAnalyticsDto {
  /** Number of field points with 2+ nodes. */
  tile_count: number;
  /** Sum, over every split point, of its full node count (including the original node). */
  node_count: number;
  /** Every distinct canonical topology found on the field, with how many tiles share it. */
  groups: SplitGroupDto[];
}

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
    }
  | {
      kind: "invalid_split_tile";
      /** Keyed by source check id — each entry is the flat list of flagged extra split-node maze
       * ids (never a point's slot-0 node). Flat rather than list-of-lists (unlike
       * `region_needs_expansion`'s `nodes`) since a split-tile flag has no group structure — every
       * flagged node highlights independently. */
      nodes: Record<string, number[]>;
    }
  | {
      kind: "invalid_split_route";
      /** Keyed by source check id — each entry is one flagged route: an ordered sequence of
       * [from, to, is_split_edge] triples, one per edge on the path, in traversal order (a route
       * is a path, not a set — order carries meaning, unlike every other variant above).
       * `is_split_edge` marks an edge incident to the split tile the route was found for. */
      routes: Record<string, [number, number, boolean][][]>;
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

/** One node in the hierarchical timing tree — see GitHub issue #285. `id` is a stage id, rule id,
 *  check type id, or strategy id depending on nesting depth; `children` is empty for a leaf
 *  (check/strategy) node. */
export interface TimingNodeDto {
  id: string;
  total_ms: number;
  calls: number;
  children: TimingNodeDto[];
}

/** Hierarchical timing breakdown for one generation run — only present on snapshots from
 *  `runGenerate` (the full generate→QC→repair pipeline). Post-edit/compute-analytics snapshots
 *  never run generation, so `MazeSnapshot.timing` is `null` there. */
export interface GenerationTimingDto {
  initial_build_ms: number;
  /** One entry per stage that ran at least one rule — each stage node's `children` are its own
   *  rules, each rule node's `children` are its checks and (if dispatched) its strategy. */
  qc: TimingNodeDto[];
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
  split_analytics: SplitAnalyticsDto;
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
  | { type: "interval"; default_min: number; default_max: number; min: number; max: number }
  /** A split-pattern list (GitHub issue #247) — value round-trips as a JSON-serialized
   *  `SplitPattern[]` string (same wire shape `SplitGenerationConfigDto.patterns` uses; see
   *  `maze-runner`'s `parse_split_patterns_param`). `with_weights` distinguishes a check's own
   *  plain membership filter (no weights) from a strategy's own weighted selection pool. */
  | { type: "pattern_list"; with_weights: boolean }
  /** A full split-generation config (pattern mode toggle, `max_split_nodes`, weighted pattern
   *  list) bundled behind one settings button opening the same dialog generation's own split
   *  settings use (`AddSplitStrategy`'s `split_config` param, GitHub issue #247). Value
   *  round-trips as a JSON-serialized `SplitGenerationConfigDto` string (same wire shape
   *  `GenerateConfig.split_generation` uses; see `maze-runner`'s `parse_split_config_param`). */
  | { type: "split_generation_config" };

export interface ParamDescriptor {
  id: string;
  label: string;
  kind: ParamKind;
}

/** A rule-level parameter descriptor (GitHub issue #253) — same shape as `ParamDescriptor` plus
 * `applies_to`, the check `type_id`s / strategy `id`s that actually consume it. A rule only shows
 * this parameter when at least one of its own checks or its strategy appears in `applies_to` —
 * see `RuleParamsSection`. */
export interface RuleParamDescriptor {
  id: string;
  label: string;
  kind: ParamKind;
  applies_to: string[];
}

/** Mirrors core's `NestedSlot` — one nested-strategy slot a strategy accepts. `slot_id` is a
 * stable, opaque identifier (part of the strategy's public config API — see
 * `Specs/repair.md`'s nested-strategy pattern), not meant for display. */
/** Mirrors `maze_core::repair::NestedDispatchKind` — how the parent strategy picks which of a
 * slot's several nested candidates to run. Drives which controls/labels `NestedStrategyPanel`
 * renders per candidate (weight vs. priority-rank vs. neither). */
export type NestedDispatchKind = "unordered" | "weighted" | "priority";

export interface NestedSlotDescriptor {
  slot_id: string;
  kind: string;
  min: number;
  max: number | null;
  dispatch_kind: NestedDispatchKind;
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
  /** Rule-level parameters (e.g. `protect_route`) — shared by every check/strategy in this rule
   * that has been migrated to consume it, see GitHub issue #253. */
  params: Record<string, string>;
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
  /** CustomVertexBased-only (GitHub issue #222): probability, rolled at the start of every
   * step, that the step's tile is split into several graph nodes instead of merged into one. */
  split_chance?: number;
}

/** Mirrors Rust's `SplitFaceRequirementDto` (GitHub issue #222). */
export type SplitFaceRequirement =
  | { kind: "passage" }
  | { kind: "one_way"; direction: "forward" | "backward" }
  | { kind: "wall" }
  | { kind: "unspecified" };

/** Mirrors Rust's `SplitPatternFaceDto` in shape, but NOT in `face_index` ordering while held in
 * `MazeStore`/the project file: here it's a position into `tessellationGeometry.ts`'s
 * `getNeighborData` offsets (`TileFaceEditor`'s authoring order), not `Tessellation::faces()`'s
 * order — the two differ for square/hex (GitHub issue #273). Converted to core's ordering only at
 * the wasm-config-serialization boundary (`generateConfigBuilder.ts`'s `splitPatternsToCore`). */
export interface SplitPatternFace {
  face_index: number;
  requirement: SplitFaceRequirement;
  /** `Some(i)`: this face connects to pattern-local node `i` (an inter-split edge). */
  sibling_target?: number;
}

/** Mirrors Rust's `SplitPatternDto` — an abstract, tessellation-relative split template. */
export interface SplitPattern {
  node_count: number;
  /** `faces[i]` is pattern-local node `i`'s face list; node 0 is the tile's pre-existing node. */
  faces: SplitPatternFace[][];
  weight?: number;
}

/** Mirrors Rust's `SplitGenerationConfigDto` — CustomVertexBased-only automatic split-point
 * assignment settings (GitHub issue #222). */
export interface SplitGenerationConfig {
  pattern_mode?: boolean;
  max_split_nodes?: number;
  patterns?: SplitPattern[];
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
  /** CustomVertexBased-only automatic split-point assignment settings (GitHub issue #222). */
  split_generation?: SplitGenerationConfig;
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
  /** The client's authoritative node list (real ids from the previous generation/confirm) —
   * `Field`/`Graph` are rebuilt directly from these ids on the Rust side (GitHub issue #236)
   * instead of re-minting them from `tessellation.points` order, so a rebuild always reproduces
   * exactly the ids the client already holds, including auto-split nodes (#222). */
  nodes: NodeDto[];
  /** Passage edges only (walls = absence of edge). */
  edges: PostEditEdgeWasmDto[];
  /** Extra nodes to add to split points before edges are resolved — each entry is one
   * `(point, slotId)` pair (GitHub issue #221). `slotId` maps onto `NodeDto.i` as `slotId + 1`
   * (`i = 0` is always the point's original node) — a slot whose `i` already exists in `nodes`
   * (confirmed by an earlier call) resolves to that same existing id, matched by `i` directly, not
   * by array position; only a genuinely new slot (just `addSplitNode`'d, not yet confirmed) gets a
   * freshly minted one — see `apply_split_points` in `maze-wasm/src/analytics.rs`. This array's own
   * order doesn't matter (unlike an earlier version of this fix, matching was position-based and
   * did require the client's creation order — no longer the case). */
  split_points?: [[number, number], number][];
  /** Plain resolved node id — NOT a `PostEditEndpointWasmDto`. `Maze::meta.start`/`.finish` in
   * `maze-core` are always `Option<NodeId>`; the frontend resolves `PostEditEndpoint` to a
   * concrete id (or `null` if it doesn't resolve yet) before building this config — see
   * `confirmPostEdit` in `postEditSlice.ts`. */
  start: number | null;
  finish: number | null;
  checks: CheckInstanceConfig[];
}
