import type { PostEditEndpoint } from "../pixi/postEditEndpoint";
import type { PostEditEdgeKind, PostEditTeleportDirection, PostEditVerticalPassageDirection } from "./postEditTypes";

/** One resolved slot of an `applySplitBlueprint` command — `slotId` and `faces`' neighbor
 * endpoints are pre-resolved at command-construction time (see `postEditCommandTypes.ts`'s module
 * doc, issue #543 plan section 2); replay never allocates ids or re-derives geometry. */
export interface ResolvedSplitFace {
  faceIndex: number;
  neighbor: PostEditEndpoint;
}

export interface ResolvedSplitSlot {
  slotId: number;
  faces: ResolvedSplitFace[];
}

/** One face wired on an `updateSplitNodeFaces` command (GitHub issue #545) — same
 * neighbor-plus-outcome shape `setEdgePair` carries per direction, since a manually-wired split
 * face (unlike a blueprint's, always `basic`) can be `wall`/`basic`/one-way in either direction. */
export interface ResolvedSplitEdgeFace {
  neighbor: PostEditEndpoint;
  toNeighbor: PostEditEdgeKind;
  fromNeighbor: PostEditEdgeKind;
}

/** One edge re-key resulting from a `rotateSplitPoint` command, pre-computed at construction time
 * from live tessellation geometry (`rotateSplitPointMoves`'s own move-list, `postEditUtils.ts`)
 * — replay has no tessellation/field access (`PostEditReplayContext` is identity-only, plan
 * section 1/4), so the rotation's resulting edge moves are resolved once by the store action and
 * carried on the command itself, exactly like `applySplitBlueprint`'s `resolvedSlots`. */
export interface ResolvedRotateMove {
  oldKey: string;
  from: PostEditEndpoint;
  to: PostEditEndpoint;
  edgeKind: PostEditEdgeKind;
}

/** Ordered, replayable command log entry for post-edit (GitHub issue #543) — replaces the old
 * per-entity draft-snapshot fields. Every command references entities exclusively through the
 * three stable identity kinds `PostEditEndpoint`/monotonic store ids already provide (see the
 * plan's "Идентичность сущностей" section) — no new identity concept. All conditional decisions
 * (wall/passage/one_way toggle outcome, vertical-passage/elevator seed detection) are resolved
 * once at construction time, reading live confirmed state — replay never reads outside its own
 * `PostEditReplayContext`/fold state. */
export type PostEditCommand =
  | { kind: "setEdge"; from: PostEditEndpoint; to: PostEditEndpoint; edgeKind: PostEditEdgeKind }
  // Wall/passage/one-way/reset edge tools (GitHub issue #545) always set both directed edges of a
  // face pair at once — the graph model is directed, but a click on a face is always one logical
  // action, not two. `setEdgePair` carries both outcomes atomically instead of two separate
  // `setEdge` commands; `aToB.edgeKind` is `a -> b`, `bToA.edgeKind` is `b -> a`. `setEdge` itself
  // stays for the rare single-direction case (`applySplitBlueprint`'s per-face wiring, GitHub issue
  // #235, which sets one direction from a freshly-minted slot and its own reverse as two
  // independently-timed commands against different lifelines).
  // `directionFlip` (GitHub issue #545): true when the `one_way` tool clicked a face that was
  // ALREADY one-way, flipping its direction rather than creating a fresh one-way passage from a
  // wall/passage — the "Changes" panel must label these differently ("changed direction" vs. "set
  // one-way passage"), mirroring `setVerticalPassageDirection` vs. `addVerticalPassage`. `false`/
  // `undefined` for every other pair outcome (wall/passage/new-one-way).
  | { kind: "setEdgePair"; a: PostEditEndpoint; b: PostEditEndpoint; aToB: PostEditEdgeKind; bToA: PostEditEdgeKind; directionFlip?: boolean }
  | { kind: "addTeleport"; id: number; from: PostEditEndpoint; to: PostEditEndpoint; direction: PostEditTeleportDirection }
  | { kind: "setTeleportDirection"; id: number; direction: PostEditTeleportDirection }
  | { kind: "moveTeleportEndpoint"; id: number; end: "from" | "to"; endpoint: PostEditEndpoint }
  | { kind: "removeTeleport"; id: number }
  | { kind: "setMeta"; slot: "start" | "finish"; endpoint: PostEditEndpoint | null }
  | { kind: "addSplitNode"; point: [number, number]; level?: number; slotId: number }
  | { kind: "removeSplitNode"; point: [number, number]; level?: number; slotId: number }
  // A split slot's face wiring, resolved atomically (GitHub issue #545) — every edge-tool click on
  // one of a split node's faces (`ManageSplitNodesDialog`'s per-face controls, or a general edge
  // click that happens to land on an already-placed slot) appends one of these carrying the FULL
  // current face list, exactly like `updateElevatorFloors` carries the full floor list rather than
  // a diff — never a `setEdgePair`/`setEdge` command for that face, which would fragment one
  // logical "reconfigure this slot's wiring" edit into one log entry per face touched. Shares its
  // lifeline with the slot's own `addSplitNode`/`removeSplitNode` (`slot:${point}:${slotId}`,
  // `lifelineKeyOf`) — same "one entity, one lifeline across every command kind touching it"
  // convention `addElevator`/`updateElevatorFloors`/`removeElevator` already established.
  | { kind: "updateSplitNodeFaces"; point: [number, number]; level?: number; slotId: number; faces: ResolvedSplitEdgeFace[] }
  | { kind: "rotateSplitPoint"; point: [number, number]; level?: number; moves: ResolvedRotateMove[] }
  // `originalFaces` (GitHub issue #545) carries the pre-existing node's own blueprint faces in the
  // SAME command, instead of a `setEdge` pair per face appended right after — applying a blueprint
  // is one logical action (one click, one shape), and splitting the original node's wiring into N
  // extra log entries (`Specs/post-edit.md`'s command-log contract) doesn't reflect that. The
  // original node has no `slotId` to be keyed under `resolvedSlots`, hence the separate field.
  // `undefined`/`[]` when the point had no pre-existing node (a fresh split with nothing to wire).
  // `blueprintTitleKey` (GitHub issue #545) carries the applied `SplitNodeBlueprint`'s own
  // `titleKey` (`splitBlueprints.ts`), if it has one, straight onto the command — the "Changes"
  // panel label needs it and a command must never look anything up outside its own fields at
  // format time (same reasoning as every other pre-resolved field here). `undefined` for a
  // blueprint with no recognizable name; the panel falls back to a generic label.
  | {
      kind: "applySplitBlueprint"; point: [number, number]; level?: number;
      resolvedSlots: ResolvedSplitSlot[]; originalFaces?: ResolvedSplitFace[]; blueprintTitleKey?: string;
    }
  | { kind: "addVerticalPassage"; id: number; from: PostEditEndpoint; to: PostEditEndpoint; direction: PostEditVerticalPassageDirection }
  // `suppressPair` (GitHub issue #545) folds this direction-cycle's own generation-time (or
  // previously-confirmed draft) mesh edge into the SAME command, rather than a trailing separate
  // `suppressGenerationPair` command — one click is one logical edit, mirrors `addElevator`'s
  // `suppressPairs`. `undefined` when nothing needs suppressing.
  | { kind: "setVerticalPassageDirection"; id: number; direction: PostEditVerticalPassageDirection; suppressPair?: [PostEditEndpoint, PostEditEndpoint] }
  | { kind: "moveVerticalPassageEndpoint"; id: number; end: "from" | "to"; endpoint: PostEditEndpoint }
  | { kind: "removeVerticalPassage"; id: number }
  // `suppressPairs` (GitHub issue #545) folds the generation-time mesh pairs this elevator edit
  // replaces into the SAME command, rather than one separate `suppressGenerationPair` command per
  // pair — a lifts's floor edit is one logical action, and splitting it into N+1 log entries
  // (`Specs/post-edit.md`'s command-log contract) doesn't reflect that. `undefined`/`[]` when no
  // generation-time (or previously-confirmed draft) mesh needs suppressing, e.g. a brand-new
  // elevator with no prior confirmed state.
  | { kind: "addElevator"; id: number; floors: PostEditEndpoint[]; suppressPairs?: [PostEditEndpoint, PostEditEndpoint][] }
  | { kind: "updateElevatorFloors"; id: number; floors: PostEditEndpoint[]; suppressPairs?: [PostEditEndpoint, PostEditEndpoint][] }
  | { kind: "removeElevator"; id: number }
  // A generation-time vertical-passage/elevator mesh edge has been edited via a *seed* draft
  // entry derived from it (`startPostEditVerticalPassagePlacement`'s guard-1 branch, or the
  // equivalent elevator seed) — `confirmPostEdit` must stop re-emitting the original generation
  // pair once a draft entry exists for it, otherwise the pair reads as two-way regardless of the
  // draft's own direction. The pair (`a`/`b`, node endpoints, order-independent) is recorded on
  // the baseline's derived state rather than mirrored via a suppression *set* field on the store,
  // so it survives point-reset/replay like any other log-derived fact.
  | { kind: "suppressGenerationPair"; entity: "verticalPassage" | "elevator"; a: PostEditEndpoint; b: PostEditEndpoint };
