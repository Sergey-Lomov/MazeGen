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

export interface StrategyDescriptor {
  id: string;
  handles: string;
}

export interface GenerateConfig {
  checks: string[];
  strategies: Record<string, string>;
}
