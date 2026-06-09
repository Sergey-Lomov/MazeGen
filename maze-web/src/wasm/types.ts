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

export interface MazeSnapshot {
  nodes: NodeDto[];
  edges: EdgeDto[];
  start: number | null;
  finish: number | null;
  warnings: string[];
  nav_nodes: NavNodeDto[];
  nav_edges: NavEdgeDto[];
  components: number[][];
}

export interface CheckDescriptor {
  id: string;
  issue_kinds: string[];
}

export type ParamKind =
  | { type: "float"; default: number; min: number; max: number }
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

export type TessellationConfig =
  | { type: "square"; width: number; height: number }
  | { type: "hex_parallelogram"; cols: number; rows: number; orientation?: "flat_top" | "pointy_top" }
  | { type: "hex_hexagon"; radius: number; orientation?: "flat_top" | "pointy_top" }
  | { type: "triangle_rect"; cols: number; rows: number; orientation?: "r0" | "r90" | "r180" | "r270" }
  | { type: "triangle_triangle"; side: number; orientation?: "r0" | "r90" | "r180" | "r270" }
  | { type: "triangle_hexagon"; radius: number; orientation?: "r0" | "r90" | "r180" | "r270" };

export interface GenerationParams {
  depth_first?: number;
  corridor_chance?: number;
  branching?: number;
  directionality?: number;
  one_way_chance?: number;
}

export interface GenerationStepDto {
  edges: EdgeDto[];
}

export interface GenerationStepsSnapshot {
  nodes: NodeDto[];
  steps: GenerationStepDto[];
}

export interface GenerateConfig {
  tessellation: TessellationConfig;
  checks: string[];
  strategies: Record<string, StrategyConfig>;
  generation?: GenerationParams;
}
