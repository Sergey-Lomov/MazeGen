/** Semantic per-node names for a split point whose current face configuration matches a recognized
 *  special-split topology (GitHub issue #487) — replaces the generic "Node N" / "N{N}" numbering in
 *  `ManageSplitNodesDialog`/`PresetSplitNodesDialog` row titles and link bubbles, the split-target
 *  pickers, and the status-bar cell inspector, when the node roles are meaningful.
 *
 *  Reuses `detectSplitSpecialShapeKind` (`splitFaceLayout.ts`) — the same recognition the canvas
 *  renderer and node-point positioning already use — so a point named here is exactly one the canvas
 *  draws as that special shape. Per-node roles are then derived from `faceKindsByNode` alone (which
 *  face indices each node owns), no tile geometry needed. For any other topology, any one-way
 *  connection, or any node that isn't a recognized slot, the caller falls back to "Node N".
 *
 *  Named topologies and node order (matching `buildSplitPassagesCore`'s own per-kind branches):
 *
 *  - degree-4 `"bridge"` — node 0 through passage "Corridor", node 1 crossing passage "Bridge".
 *  - degree-4 `"diagonal"` (divider) — two symmetric adjacent-face halves, "Corridor 1" / "Corridor 2".
 *  - `"hex_bridge"` — node 0 through "Corridor", node 1 crossing "Bridge".
 *  - `"hex_diagonal"` — two pairs, neither opposite, "Corridor 1" / "Corridor 2".
 *  - `"hex_diagonal_divider"` — two three-face halves, "Fork 1" / "Fork 2".
 *  - `"hex_triple_bridge"` — node 0 through "Corridor", node 1 "Lower bridge", node 2 "Upper bridge"
 *    (row order — the through node is always row 0, the two bridges follow).
 *  - `"hex_triple_corridor"` — the single opposite-face pair is the "Middle corridor"; the two
 *    adjacent-face nodes are "Side corridor 1" / "Side corridor 2" by ascending lowest face index. */

import { detectSplitSpecialShapeKind, connectedFaceIndices, circularDist, type SplitFaceKind } from "./splitFaceLayout";
import type { SplitSpecialShapeKind } from "./renderers/types";
import * as m from "~/paraglide/messages";

/** Minimal shape this module needs from a `TileFaceNode` — its per-face kinds, in `offsets` order. */
export interface SplitNodeFaces {
  faces: { kind: SplitFaceKind }[];
}

interface SemanticName {
  /** Full label for a dialog row title / picker row / inspector block — replaces "Node N". */
  full: string;
  /** Compact tag for a link-bubble coordinate suffix — replaces "N{N}". */
  short: string;
}

const corridor = (): SemanticName => ({
  full: m["post_edit.split_node_name_corridor"](),
  short: m["post_edit.split_node_name_corridor_short"](),
});
const bridge = (): SemanticName => ({
  full: m["post_edit.split_node_name_bridge"](),
  short: m["post_edit.split_node_name_bridge_short"](),
});
const corridorN = (n: number): SemanticName => ({
  full: m["post_edit.split_node_name_corridor_n"]({ n }),
  short: m["post_edit.split_node_name_corridor_n_short"]({ n }),
});
const forkN = (n: number): SemanticName => ({
  full: m["post_edit.split_node_name_fork_n"]({ n }),
  short: m["post_edit.split_node_name_fork_n_short"]({ n }),
});
const lowerBridge = (): SemanticName => ({
  full: m["post_edit.split_node_name_lower_bridge"](),
  short: m["post_edit.split_node_name_lower_bridge_short"](),
});
const upperBridge = (): SemanticName => ({
  full: m["post_edit.split_node_name_upper_bridge"](),
  short: m["post_edit.split_node_name_upper_bridge_short"](),
});
const middleCorridor = (): SemanticName => ({
  full: m["post_edit.split_node_name_middle_corridor"](),
  short: m["post_edit.split_node_name_middle_corridor_short"](),
});
const sideCorridorN = (n: number): SemanticName => ({
  full: m["post_edit.split_node_name_side_corridor_n"]({ n }),
  short: m["post_edit.split_node_name_side_corridor_n_short"]({ n }),
});

/** Per-node semantic names for `faceKindsByNode` (each node's kind on every one of the point's
 *  faces, in `offsets`/row order — original node first, then each slot), or `null` if this point's
 *  topology has no registered names. A non-`null` result always has exactly one entry per node. */
export function splitNodeSemanticNamesFromKinds(faceKindsByNode: SplitFaceKind[][]): SemanticName[] | null {
  const kind = detectSplitSpecialShapeKind(faceKindsByNode);
  if (kind === null) return null;

  const degree = faceKindsByNode[0]?.length ?? 0;
  const facesByNode = faceKindsByNode.map(connectedFaceIndices);
  const isOpposite = (faces: number[]) => faces.length === 2 && circularDist(faces[0], faces[1], degree) === degree / 2;

  switch (kind) {
    case "bridge":
    case "hex_bridge":
      // Node 0 is the through pair (drawn as a plain passage), node 1 the crossing pair (the
      // bridge silhouette) — same order the renderer's `"bridge"`/`"hex_bridge"` branch assumes.
      return [corridor(), bridge()];

    case "diagonal":
    case "hex_diagonal":
      return [corridorN(1), corridorN(2)];

    case "hex_diagonal_divider":
      return [forkN(1), forkN(2)];

    case "hex_triple_bridge":
      // Node 0 is the through corridor (never drawn as a bridge); the other two are bridges, named
      // by row order per the user's spec (lower then upper).
      return [corridor(), lowerBridge(), upperBridge()];

    case "hex_triple_corridor": {
      // The single opposite-face pair is the through/middle corridor; the two adjacent-face nodes
      // are the side corridors, ordered by their lowest owned face index.
      const throughIdx = facesByNode.findIndex(isOpposite);
      if (throughIdx < 0) return null;
      const sideIdxs = facesByNode
        .map((faces, i) => ({ i, minFace: Math.min(...faces) }))
        .filter(({ i }) => i !== throughIdx)
        .sort((a, b) => a.minFace - b.minFace)
        .map(({ i }) => i);
      const names: SemanticName[] = new Array(faceKindsByNode.length);
      names[throughIdx] = middleCorridor();
      names[sideIdxs[0]] = sideCorridorN(1);
      names[sideIdxs[1]] = sideCorridorN(2);
      return names;
    }

    default: {
      // Exhaustive over `SplitSpecialShapeKind` today — this guard makes adding a new kind a
      // compile error here (rather than silently returning `undefined`, which the callers'
      // `?? "Node N"` fallback would swallow) until it gets its own `case` above.
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

/** Per-node semantic names for `nodes` (in row order: original node first, then each slot), or
 *  `null` if this point's topology has no registered names. */
export function splitNodeSemanticNames(nodes: SplitNodeFaces[]): SemanticName[] | null {
  return splitNodeSemanticNamesFromKinds(nodes.map((n) => n.faces.map((f) => f.kind)));
}

/** One name for the whole split point's recognized shape (not per-node) — e.g. for
 *  `PostEditElevatorFloorDialog`'s floor-status label, which names the SHAPE a floor's split point
 *  draws as, not which of its nodes an elevator stop would land on. */
export function splitPointShapeName(kind: SplitSpecialShapeKind): string {
  switch (kind) {
    case "bridge":
    case "hex_bridge":
      return m["post_edit.split_node_name_bridge"]();
    case "diagonal":
    case "hex_diagonal":
      return m["post_edit.split_shape_name_diagonal"]();
    case "hex_diagonal_divider":
      return m["post_edit.split_shape_name_diagonal_divider"]();
    case "hex_triple_bridge":
      return m["post_edit.split_shape_name_triple_bridge"]();
    case "hex_triple_corridor":
      return m["post_edit.split_shape_name_triple_corridor"]();
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}
