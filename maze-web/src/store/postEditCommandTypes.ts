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
  | { kind: "addTeleport"; id: number; from: PostEditEndpoint; to: PostEditEndpoint; direction: PostEditTeleportDirection }
  | { kind: "setTeleportDirection"; id: number; direction: PostEditTeleportDirection }
  | { kind: "moveTeleportEndpoint"; id: number; end: "from" | "to"; endpoint: PostEditEndpoint }
  | { kind: "removeTeleport"; id: number }
  | { kind: "setMeta"; slot: "start" | "finish"; endpoint: PostEditEndpoint | null }
  | { kind: "addSplitNode"; point: [number, number]; level?: number; slotId: number }
  | { kind: "removeSplitNode"; point: [number, number]; level?: number; slotId: number }
  | { kind: "rotateSplitPoint"; point: [number, number]; level?: number; moves: ResolvedRotateMove[] }
  | { kind: "applySplitBlueprint"; point: [number, number]; level?: number; resolvedSlots: ResolvedSplitSlot[] }
  | { kind: "addVerticalPassage"; id: number; from: PostEditEndpoint; to: PostEditEndpoint; direction: PostEditVerticalPassageDirection }
  | { kind: "setVerticalPassageDirection"; id: number; direction: PostEditVerticalPassageDirection }
  | { kind: "moveVerticalPassageEndpoint"; id: number; end: "from" | "to"; endpoint: PostEditEndpoint }
  | { kind: "removeVerticalPassage"; id: number }
  | { kind: "addElevator"; id: number; floors: PostEditEndpoint[] }
  | { kind: "updateElevatorFloors"; id: number; floors: PostEditEndpoint[] }
  | { kind: "removeElevator"; id: number }
  | { kind: "deletePoint"; point: [number, number]; level?: number }
  // A generation-time vertical-passage/elevator mesh edge has been edited via a *seed* draft
  // entry derived from it (`startPostEditVerticalPassagePlacement`'s guard-1 branch, or the
  // equivalent elevator seed) — `confirmPostEdit` must stop re-emitting the original generation
  // pair once a draft entry exists for it, otherwise the pair reads as two-way regardless of the
  // draft's own direction. The pair (`a`/`b`, node endpoints, order-independent) is recorded on
  // the baseline's derived state rather than mirrored via a suppression *set* field on the store,
  // so it survives point-reset/replay like any other log-derived fact.
  | { kind: "suppressGenerationPair"; entity: "verticalPassage" | "elevator"; a: PostEditEndpoint; b: PostEditEndpoint };
