export interface NodeDto {
  id: number;
  x: number;
  y: number;
}

export interface EdgeDto {
  from: number;
  to: number;
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
}

export interface SpatialEdgeStatsDto {
  bidirectional: number;
  one_way: number;
  walls: number;
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

export interface IssueDto {
  kind: string;
  /** Present only for `invalid_loop` issues, keyed by source check id — each entry is one
   * invalid cycle's base-graph edges as [from, to] maze node-id pairs, for highlight rendering.
   * Keyed per check (not one flat list) so hovering one check's bubble highlights only the
   * cycles that check flagged, not every contributing check's cycles combined. */
  invalid_loop_edges: Record<string, [number, number][][]>;
  /** Present only for `region_needs_expansion` issues, keyed by source check id — each entry is
   * one flagged SCC region's member maze node ids (not edges — the UI derives the region's
   * perimeter client-side from this node set, the same way preset boundary walls are derived from
   * a cell set). Keyed per check for the same reason as `invalid_loop_edges`. */
  region_needs_expansion_nodes: Record<string, number[][]>;
  /** Check id(s) that produced or contributed to this issue — lets the UI render one bubble
   * per contributing check rather than one per `kind` (e.g. `min_loop_length` vs `max_loop_length`,
   * both `invalid_loop`). */
  source_checks: string[];
  /** Raw display values keyed by source check id then by detail key, e.g.
   * `{"max_loop_length": {"max_loop_length": "100"}}`. Never assembled messages — only used
   * to fill in i18n templates keyed by check id (see `issueRegistry.ts`). */
  details: Record<string, Record<string, string>>;
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
  route_info: RouteInfoDto | null;
  graph_analytics: GraphAnalyticsDto;
  debug_steps: GenerationStepDto[];
}

export interface CheckDescriptor {
  id: string;
  label: string;
  description: string;
  issue_kinds: string[];
  params: ParamDescriptor[];
}

export type ParamKind =
  | { type: "float"; default: number; min: number; max: number }
  | { type: "integer"; default: number; min: number; max: number }
  | { type: "bool"; default: boolean }
  | { type: "enum"; options: string[]; default: string };

export interface ParamDescriptor {
  id: string;
  label: string;
  kind: ParamKind;
}

export interface StrategyDescriptor {
  id: string;
  handles: string;
  params: ParamDescriptor[];
}

export interface StrategyConfig {
  id: string;
  params: Record<string, string>;
}

export interface QcRuleConfig {
  id: string;
  checks: string[];
  strategy: StrategyConfig | null;
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
}

export interface GenerationStepDto {
  edges: EdgeDto[];
  active_nodes: number[];
  current_src: number | null;
}

export interface GenerationStepsSnapshot {
  nodes: NodeDto[];
  steps: GenerationStepDto[];
}

export type InitialGenerationConfig =
  | ({ method: "custom_vertex_based" } & GenerationParams)
  | ({ method: "custom_edge_based" } & EdgeBasedParams)
  | { method: "recursive_backtracker" }
  | { method: "wilson_algorithm" }
  | { method: "kruskal_algorithm" };

export type PresetConnectionState = "wall" | "passage" | "one_way_forward" | "one_way_backward";

export interface PresetConnection {
  from: [number, number];
  to: [number, number];
  state: PresetConnectionState;
}

export type NodeLockKind = "in" | "out" | "both";

export interface LockedNodeDto {
  point: [number, number];
  kind: NodeLockKind;
}

export interface GenerateConfig {
  tessellation: WasmTessellationConfig;
  checks: string[];
  check_rules: QcRuleConfig[];
  check_params?: Record<string, Record<string, string>>;
  repair_max_iterations?: number;
  repair_time_budget_secs?: number;
  initial: InitialGenerationConfig;
  elements: ElementsConfig;
  preset_connections?: PresetConnection[];
  locked_nodes?: LockedNodeDto[];
  preset_start?: [number, number];
  preset_finish?: [number, number];
  preset_gen_source?: [number, number];
  debug?: boolean;
}

export type PostEditEdgeKind = "basic" | "one_way";

export interface PostEditEdgeWasmDto {
  from: number;
  to: number;
  /** Direction already normalized: from→to is the actual passage direction. */
  kind: PostEditEdgeKind;
}

export interface ComputeAnalyticsConfig {
  tessellation: WasmTessellationConfig;
  /** Node coordinates — mirrors tessellation.points for API clarity. */
  nodes: ReadonlyArray<[number, number]>;
  /** Passage edges only (walls = absence of edge). */
  edges: PostEditEdgeWasmDto[];
  start: number | null;
  finish: number | null;
  checks: string[];
  check_params: Record<string, Record<string, string>>;
}
