export interface NodeDto {
  id: number;
  x: number;
  y: number;
}

export interface EdgeDto {
  from: number;
  to: number;
}

export interface MazeSnapshot {
  nodes: NodeDto[];
  edges: EdgeDto[];
}
