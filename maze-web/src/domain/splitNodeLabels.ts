import * as m from "~/paraglide/messages";

/** 1-based node number for a split point's node, in row order (GitHub issue #468). Slot 0 is not a
 *  special node any more — every node of a split point, the point's original node included, gets the
 *  same numbering: the original node is `1`, a slot's number is its `slotId + 2` (matching
 *  `NodeDto.i + 1`, since `slotId` is `i - 1`). Shared by `ManageSplitNodesDialog` and
 *  `PresetSplitNodesDialog`. */
export const splitNodeNumber = (slotId: number | undefined): number => (slotId === undefined ? 1 : slotId + 2);

/** Full "Node N" label — for a row title / the cell-inspector-style status readout. */
export const splitNodeLabel = (slotId: number | undefined): string =>
  m["post_edit.split_node_label"]({ slotId: splitNodeNumber(slotId) });

/** Compact "N{N}" label — for the link-bubble coordinate suffix, where space is tight. */
export const splitNodeLabelShort = (slotId: number | undefined): string =>
  m["post_edit.split_node_label_short"]({ slotId: splitNodeNumber(slotId) });
