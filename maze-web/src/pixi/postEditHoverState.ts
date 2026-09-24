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
