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

export interface MazeSnapshot {
  nodes: NodeDto[];
  edges: EdgeDto[];
  start: number | null;
  finish: number | null;
  warnings: string[];
  nav_nodes: NavNodeDto[];
  nav_edges: NavEdgeDto[];
  components: number[][];
  node_stats: NodeStatsDto;
  edge_stats: SpatialEdgeStatsDto;
  route_info: RouteInfoDto | null;
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
}

export interface EdgeBasedParams {
  corridor_length?: number;
  branching?: number;
  depth_first?: number;
  directionality?: number;
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
  strategies: Record<string, StrategyConfig>;
  check_params?: Record<string, Record<string, string>>;
  initial: InitialGenerationConfig;
  elements: ElementsConfig;
  preset_connections?: PresetConnection[];
  locked_nodes?: LockedNodeDto[];
  preset_start?: [number, number];
  preset_finish?: [number, number];
  debug?: boolean;
}
