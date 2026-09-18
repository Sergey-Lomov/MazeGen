import type { SplitFaceRequirement } from "./generated/dto";

export type {
  NodeDto,
  EdgeKindDto,
  EdgeDto,
  NavNodeDto,
  NavEdgeDto,
  IssueEdgeGroupPayload,
  IssueSplitTilePayload,
  IssueSplitGroupPayload,
  IssueRegionPayload,
  IssueRouteEdge,
  IssueRoutePayload,
  IssuePayloadDto,
  IssueDto,
  TimingNodeDto,
  GenerationTimingDto,
  JunctionBucket,
  NodeStatsDto,
  SpatialEdgeStatsDto,
  ElementsStatsDto,
  VerticalStatsDto,
  RouteInfoDto,
  GraphStatsDto,
  SplitFaceRequirement,
  OneWayDirectionDto,
  SplitGroupDto,
  FloorScoped,
  MazeStatisticsDto,
  PostEditEndpointWasmDto,
  PostEditEdgeWasmDto,
  VerticalEdgeDto,
  AnalyticsRuleGroupConfig,
  ComputeAnalyticsConfig,
  MazeSnapshot,
} from "./generated/dto";

export type RegionClass = "path" | "alternative" | "unreachable" | "trap";

export interface CheckDescriptor {
  id: string;
  label: string;
  description: string;
  issue_kinds: string[];
  params: ParamDescriptor[];
  /** `undefined` means always offered — see `EntityVisibility`. */
  visibility?: EntityVisibility;
}

export type ParamKind =
  | { type: "float"; default: number; min: number; max: number }
  | { type: "integer"; default: number; min: number; max: number }
  | { type: "bool"; default: boolean }
  | { type: "enum"; options: string[]; default: string }
  | { type: "interval"; default_min: number; default_max: number; min: number; max: number }
  /** A fixed 5-value priority enum between two candidate groups (GitHub issue #381 follow-up) —
   *  see `maze_core::repair::PriorityLevel`'s own doc comment. Rendered with one shared, hardcoded
   *  set of `priority.*` i18n labels/explanations, not per-param entries like a plain `enum`. */
  | { type: "priority"; default: string }
  /** A split-pattern list (GitHub issue #247) — value round-trips as a JSON-serialized
   *  `SplitPattern[]` string (same wire shape `SplitGenerationConfigDto.patterns` uses; see
   *  `maze-runner`'s `parse_split_patterns_param`). `with_weights` distinguishes a check's own
   *  plain membership filter (no weights) from a strategy's own weighted selection pool. */
  | { type: "pattern_list"; with_weights: boolean }
  /** A full split-generation config (pattern mode toggle, `max_split_nodes`, weighted pattern
   *  list) bundled behind one settings button opening the same dialog generation's own split
   *  settings use (`GenerateConfig.split_generation`'s own equivalent param). Value
   *  round-trips as a JSON-serialized `SplitGenerationConfigDto` string (same wire shape
   *  `GenerateConfig.split_generation` uses; see `maze-runner`'s `parse_split_config_param`). */
  | { type: "split_generation_config" }
  /** `AddSplitStrategy`'s own construction-time param (GitHub issue #389) — pattern topology moved
   *  to the rule-level `split_patterns` param; this only carries `max_split_nodes`'s default. The
   *  control shown depends on whether the owning rule's own `split_patterns` is empty: a plain
   *  integer input for `max_split_nodes` (value round-trips as a plain integer string) when empty,
   *  or a locked pattern-list editor for `pattern_weights` (value round-trips as a JSON `number[]`,
   *  indexed against `split_patterns`) when non-empty — see `maze-runner`'s
   *  `parse_add_split_config_param` and `RuleStrategyPanel`'s own switch. */
  | { type: "add_split_config"; max_split_nodes_default: number };

/** Conditional-visibility tag (GitHub issue #349) — shared by `ParamDescriptor`, `CheckDescriptor`
 *  and `StrategyDescriptor`. On a param, the UI hides that param's whole row (label + control)
 *  when the condition doesn't hold, leaving its stored value untouched (so e.g. re-adding a floor
 *  doesn't force the user to reconfigure it). On a check/strategy, the UI omits it from the
 *  *selection* dialogs only (`IssueSelectDialog`/`CheckSelectDialog`/`StrategySelectDialog`/
 *  `AddCheckToRuleDialog`/`NestedStrategySelectDialog`/`NewRuleStrategyDialog`) — a rule already built on a now-hidden
 *  check/strategy stays exactly as configured, visible on its own card, and still runs at
 *  generation time; only the ability to newly pick it is gated. See `isEntityVisible`. */
export type EntityVisibility =
  /** Hidden whenever the maze has fewer than 2 floors. First consumers: `scored_endpoints`'s
   *  `cross_floor_weight`/`elevator_stop_weight` params (GitHub issue #390), and every
   *  check/strategy that only makes sense with vertical passages/elevators, which don't exist on
   *  a single-floor maze (GitHub issue #349 follow-up). */
  { type: "multi_floor_only" };

export interface ParamDescriptor {
  id: string;
  label: string;
  kind: ParamKind;
  /** `undefined` means always visible — see `EntityVisibility`. */
  visibility?: EntityVisibility;
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
  /** Param ids the UI must hide when this strategy runs *nested under a dispatcher* — the
   * dispatcher owns them (`reserve_percent`/`attempts_limit`, GitHub issue #486). Empty for
   * strategies without dispatcher-owned params. At the top level every param stays visible.
   * Always emitted by wasm; optional here only so test fixtures need not spell it out — treat
   * `undefined` as `[]`. */
  nested_suppressed_params?: string[];
  /** `undefined` means always offered — see `EntityVisibility`. */
  visibility?: EntityVisibility;
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
}

export interface GenerationParams {
  depth_first?: number;
  corridor_chance?: number;
  branching?: number;
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
  /** CustomVertexBased-only (GitHub issue #337), multi-floor mazes: balance between preferring a
   * teleport target on another floor (1) vs. the same floor (0). */
  cross_floor_teleport_balance?: number;
  /** CustomVertexBased-only (GitHub issue #337): probability, rolled on every growth-opportunity
   * on multi-floor mazes, of attempting a vertical connection (VerticalPassage or Elevator). */
  vertical_chance?: number;
  /** Balance between VerticalPassage (0) and Elevator (1) once a vertical connection fires. */
  vertical_passage_elevator_balance?: number;
  /** VerticalPassage-only: probability the edge is one-way instead of two-way. */
  one_way_vertical_passage_chance?: number;
  /** Direction balance (0=down, 1=up) for one-way VerticalPassage edges. */
  vertical_up_down_balance?: number;
  /** Elevator floor-count clamp (inclusive), counting the source floor itself. */
  elevator_span_min?: number;
  elevator_span_max?: number;
  /** Elevator floor-count branching factor, from `elevator_span_min` toward `elevator_span_max`. */
  elevator_branching?: number;
  /** Allow an elevator to skip floors instead of only connecting a contiguous run. */
  allow_non_consecutive_elevator_floors?: boolean;
}

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
  | { method: "recursive_backtracker" }
  | { method: "wilson_algorithm" }
  | { method: "kruskal_algorithm" };

export type PresetConnectionState = "wall" | "passage" | "one_way_forward" | "one_way_backward" | "teleport_forward" | "teleport_backward" | "teleport_two_way";

/** Wire shape for a preset endpoint (GitHub issue #231) — a point plus an optional slot
 * addressing one of that point's declared extra ("split") nodes. `slot: undefined` means the
 * point's original node. `level` (GitHub issue #340) is the endpoint's 0-based `level_fields`
 * index; `undefined` means level 0 — meaningful on both `GenerateConfig` and
 * `ComputeAnalyticsConfig` (the post-edit path is genuinely multi-level as of GitHub issue #359,
 * see `Specs/floors.md`). Mirrors Rust's `PresetEndpointDto`/`PresetEndpoint`. */
export interface PresetEndpointDto {
  point: [number, number];
  slot?: number;
  level?: number;
}

export interface PresetConnection {
  from: PresetEndpointDto;
  to: PresetEndpointDto;
  state: PresetConnectionState;
}

export type VerticalPassageDirectionDto = "forward" | "backward";

/** Wire shape for a preset `VerticalPassage` (GitHub issue #357) — sent as its own
 * `GenerateConfig.preset_vertical_passages` entry, not folded into `preset_connections`, since its
 * endpoints live on different (adjacent) floors rather than a geometrically-adjacent cell pair.
 * Mirrors Rust's `PresetVerticalPassageDto`. */
export interface PresetVerticalPassageDto {
  from: PresetEndpointDto;
  to: PresetEndpointDto;
  one_way?: VerticalPassageDirectionDto;
}

/** Wire shape for a preset `Elevator` (GitHub issue #357) — mirrors Rust's `PresetElevatorDto`. */
export interface PresetElevatorDto {
  floors: PresetEndpointDto[];
}

export type NodeLockKind = "in" | "out" | "both";

export interface LockedNodeDto {
  point: PresetEndpointDto;
  kind: NodeLockKind;
}

export interface GenerateConfig {
  /** Tessellation kind/orientation — maze-wide, shared by every level (GitHub issue #338: kind is
   * confirmed once, not per floor; see `Specs/field-editor.md`). */
  tessellation: WasmTessellationConfig;
  /** Each level's own field points, in `floors` order (GitHub issue #338 — per-floor field shape).
   * The number of levels to generate across (GitHub issue #337) is `level_fields.length` — there
   * is no separate count field on the wire. */
  level_fields: [number, number][][];
  stages: StageConfig[];
  repair_max_iterations?: number;
  repair_time_budget_secs?: number;
  initial: InitialGenerationConfig;
  elements: ElementsConfig;
  preset_connections?: PresetConnection[];
  preset_vertical_passages?: PresetVerticalPassageDto[];
  preset_elevators?: PresetElevatorDto[];
  locked_nodes?: LockedNodeDto[];
  preset_start?: PresetEndpointDto;
  preset_finish?: PresetEndpointDto;
  preset_gen_source?: PresetEndpointDto;
  /** Extra nodes to create at declared points before any preset above is resolved (GitHub issue
   * #231) — `[[x, y], slotId, level]` triples; `level` added by GitHub issue #340 (0-based
   * `level_fields` index). Mirrors Rust's `GenerateConfig.split_points`. */
  split_points?: [[number, number], number, number][];
  /** CustomVertexBased-only automatic split-point assignment settings (GitHub issue #222). */
  split_generation?: SplitGenerationConfig;
  debug_events?: boolean;
  qc_experiment?: boolean;
}
