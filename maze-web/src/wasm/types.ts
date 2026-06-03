export interface NodeDto {
  id: number;
  x: number;
  y: number;
}

export interface EdgeDto {
  a: number;
  b: number;
}

export interface MazeSnapshot {
  nodes: NodeDto[];
  edges: EdgeDto[];
}
