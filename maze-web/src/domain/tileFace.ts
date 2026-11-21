import type { SplitFaceKind } from "./splitFaceLayout";

/** What a tile's face currently shows for one node, for the "Manage split nodes" dialog's
 * large-tile diagram (GitHub issue #234). `"one_way_out"`/`"one_way_in"` are relative to that
 * node — `out` means the node is the passage's source. */
export type TileFaceKind = SplitFaceKind;

export interface TileFace {
  kind: TileFaceKind;
  /** No neighboring tile exists on this side — clicking reports a refusal notice in editors.
   * Identical for every node at this point (a property of the side itself), but carried per-face
   * for convenience at the call site. */
  boundary: boolean;
}

export interface TileFaceNode {
  color: string;
  /** One entry per `getNeighborData` offset index for this cell. */
  faces: TileFace[];
}
