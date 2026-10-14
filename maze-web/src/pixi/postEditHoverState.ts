import type { FieldEdge } from "./fieldEditUtils";

export interface PostEditHoverState {
  edge: FieldEdge | null;
  edgeDanger: boolean;
  cell: [number, number] | null;
  cellDanger: boolean;
}

export function emptyPostEditHoverState(): PostEditHoverState {
  return { edge: null, edgeDanger: false, cell: null, cellDanger: false };
}

export function sameHoverCell(a: [number, number] | null, b: [number, number] | null): boolean {
  if (a === null || b === null) return a === b;
  return a[0] === b[0] && a[1] === b[1];
}

export function sameHoverEdge(a: FieldEdge | null, b: FieldEdge | null): boolean {
  if (a === null || b === null) return a === b;
  return a.key === b.key && sameHoverCell(a.from, b.from) && sameHoverCell(a.to, b.to);
}

/** Draft edits redraw the scene without changing the geometry under the pointer. */
export interface PostEditHoverContext {
  postEditTool: string;
  activeFloorId: string | number;
  nodes: unknown;
  edges: unknown;
}

export function shouldClearPostEditHover(
  state: PostEditHoverContext,
  previous: PostEditHoverContext,
): boolean {
  return state.postEditTool !== previous.postEditTool
    || state.activeFloorId !== previous.activeFloorId;
}
