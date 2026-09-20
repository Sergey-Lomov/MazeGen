import type { PostEditEndpoint } from "../pixi/postEditEndpoint";
import type { PostEditEdgeState, PostEditTeleportDirection, PostEditVerticalPassageDirection } from "./postEditTypes";

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
 * face (unlike a blueprint's, always `basic`) can be `wall`/`basic`/one-way in either direction.
 * `toNeighbor`/`fromNeighbor` are `PostEditEdgeState` (GitHub issue #564), not a bare
 * `PostEditEdgeKind` — a one-way face gets the same stable id treatment as `setEdgePair`'s own
 * `aToB`/`bToA`, resolved at construction time in `applyPostEditToolAt`. */
export interface ResolvedSplitEdgeFace {
  neighbor: PostEditEndpoint;
  toNeighbor: PostEditEdgeState;
  fromNeighbor: PostEditEdgeState;
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
  edge: PostEditEdgeState;
}

/** Ordered, replayable command log entry for post-edit (GitHub issue #543) — replaces the old
 * per-entity draft-snapshot fields. Every command references entities exclusively through the
 * three stable identity kinds `PostEditEndpoint`/monotonic store ids already provide (see the
 * plan's "Идентичность сущностей" section) — no new identity concept. All conditional decisions
 * (wall/passage/one_way toggle outcome, vertical-passage/elevator seed detection) are resolved
 * once at construction time, reading live confirmed state — replay never reads outside its own
 * `PostEditReplayContext`/fold state. */
export type PostEditCommand =
  // `edge` (GitHub issue #564) is a `PostEditEdgeState` — same discriminated union as `PostEditEdge`
  // — carrying its own `id` when one-way, instead of a bare `from`/`to`/`edgeKind`. `setEdge` has no
  // real caller in current store-action code (`setEdgePair` covers every two-directional edge-tool
  // click, `applySplitBlueprint`'s per-face wiring is always `basic` and writes edges directly) —
  // kept as a general single-direction primitive with its own replay/label support.
  | { kind: "setEdge"; edge: PostEditEdgeState }
  // Wall/passage/one-way/reset edge tools (GitHub issue #545) always set both directed edges of a
  // face pair at once — the graph model is directed, but a click on a face is always one logical
  // action, not two. `setEdgePair` carries both outcomes atomically instead of two separate
  // `setEdge` commands; `aToB` is `a -> b`'s resulting state, `bToA` is `b -> a`'s. `setEdge` itself
  // stays for the rare single-direction case (`applySplitBlueprint`'s per-face wiring, GitHub issue
  // #235, which sets one direction from a freshly-minted slot and its own reverse as two
  // independently-timed commands against different lifelines).
  // `directionFlip` (GitHub issue #545): true when the `one_way` tool clicked a face that was
  // ALREADY one-way, flipping its direction rather than creating a fresh one-way passage from a
  // wall/passage — the "Changes" panel must label these differently ("changed direction" vs. "set
  // one-way passage"), mirroring `setVerticalPassageDirection` vs. `addVerticalPassage`. `false`/
  // `undefined` for every other pair outcome (wall/passage/new-one-way).
  // `aToB`/`bToA` (GitHub issue #564) are `PostEditEdgeState` — the same discriminated union as
  // `PostEditEdge` — instead of a bare `PostEditEdgeKind` plus optional id fields, so "one-way
  // carries an id, wall/basic doesn't" is a type-level invariant on the command payload itself, not
  // just on stored state. `replacedOneWayIds` records which one-way id(s), if any, this command
  // DESTROYS on each side — resolved at command-construction time in the store action (pre-state is
  // available then; a post-state-only payload can't tell what a side USED to be). Per-side, not a
  // flat array, since each side's old one-way (if any) is independent of the other's. `undefined`
  // for a side that wasn't previously a one-way (nothing to destroy there).
  | { kind: "setEdgePair"; a: PostEditEndpoint; b: PostEditEndpoint; aToB: PostEditEdgeState; bToA: PostEditEdgeState; directionFlip?: boolean; replacedOneWayIds?: { aToB?: string; bToA?: string } }
  | { kind: "addTeleport"; id: string; from: PostEditEndpoint; to: PostEditEndpoint; direction: PostEditTeleportDirection }
  // `from`/`to` (GitHub issue #564 follow-up) are this teleport's own endpoints, denormalized onto
  // the command at construction time — same fix already applied to every vertical-passage command;
  // an id-only lookup into `live` (the CURRENT draft) is correct only for the newest row about this
  // id, and shows a stale (or, once the entity is removed, unresolved) location for every OLDER row
  // about the same teleport.
  | { kind: "setTeleportDirection"; id: string; direction: PostEditTeleportDirection; from: PostEditEndpoint; to: PostEditEndpoint }
  // `from`/`to`/`direction` (same follow-up) are this teleport's own RESULTING pair/direction after
  // this move — same denormalization reasoning as `setTeleportDirection` above.
  | { kind: "moveTeleportEndpoint"; id: string; end: "from" | "to"; endpoint: PostEditEndpoint; from: PostEditEndpoint; to: PostEditEndpoint; direction: PostEditTeleportDirection }
  // `from`/`to`/`direction` (same follow-up) are the removed teleport's own endpoints/direction,
  // denormalized onto the command at construction time — without them the "Changes" panel has
  // nothing left to resolve a location from once the entry is gone from `postEditDraftTeleports`.
  | { kind: "removeTeleport"; id: string; from: PostEditEndpoint; to: PostEditEndpoint; direction: PostEditTeleportDirection }
  // `previousEndpoint` (GitHub issue #564 follow-up) is the slot's own endpoint right before this
  // command, denormalized at construction time — only meaningful (and only ever set) when
  // `endpoint` is `null` (a clear); without it, the "Changes" panel had no coordinates left to show
  // for a "start/finish cleared" row once the slot itself is empty. `undefined` when setting rather
  // than clearing (`endpoint` is non-null then, so the row already has its own location to show).
  | { kind: "setMeta"; slot: "start" | "finish"; endpoint: PostEditEndpoint | null; previousEndpoint?: PostEditEndpoint }
  // `pointId` (GitHub issue #564) is the split TILE's own stable id (distinct from `slotId`, which
  // addresses one node within the tile) — resolved at command-construction time in the store
  // action: the point's current id if it already exists (in the baseline or created earlier in this
  // same log), else a freshly-minted one from `_nextPostEditSplitPointId`. Replay checks it against
  // `state.splitPointIds[key]` (the CURRENT derived state, not baseline) and fails the command on a
  // mismatch — never silently overwrites an existing point's identity. A string (`"s{n}"`, GitHub
  // issue #564 second follow-up), unlike `slotId` — `slotId` is a per-point LOCAL index (its own
  // counter reset per point, `_nextSplitSlotId`), not a globally-unique entity id, so it stays a
  // bare `number`; only `pointId` (one global counter, `_nextPostEditSplitPointId`) gets the
  // type-letter-prefixed string id every OTHER entity category has.
  | { kind: "addSplitNode"; point: [number, number]; level?: number; slotId: number; pointId: string }
  | { kind: "removeSplitNode"; point: [number, number]; level?: number; slotId: number; pointId: string }
  // A split node's face wiring, resolved atomically (GitHub issue #545) — every edge-tool click on
  // one of a split point's nodes' faces (`ManageSplitNodesDialog`'s per-face controls, or a general
  // edge click that happens to land on any node of an already-split point) appends one of these
  // carrying the FULL current face list, exactly like `updateElevatorFloors` carries the full floor
  // list rather than a diff — never a `setEdgePair`/`setEdge` command for that face, which would
  // fragment one logical "reconfigure this node's wiring" edit into one log entry per face touched.
  // `slotId` is `undefined` for the point's original node — same "no entry/id means the original
  // node" convention `postEditActiveSplitNode`/`PresetEndpoint.slotId` already use (GitHub issue
  // #564 follow-up) — the original node is just as much a face-editable node of the split point as
  // any of its slots, and both must log this same command kind. Shares its lifeline with the split
  // node's own `addSplitNode`/`removeSplitNode` when `slotId` is set (`slot:${point}:${slotId}`,
  // `lifelineKeysOf`), or its own point-scoped key when it's the original node
  // (`originalNode:${point}` — the original has no add/remove command of its own to share a
  // lifeline with, since it can never be removed) — same "one entity, one lifeline across every
  // command kind touching it" convention `addElevator`/`updateElevatorFloors`/`removeElevator`
  // already established.
  | { kind: "updateSplitNodeFaces"; point: [number, number]; level?: number; slotId?: number; faces: ResolvedSplitEdgeFace[]; pointId: string }
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
  // `pointId` (GitHub issue #564) — same resolution/replay-check rule as `addSplitNode`'s own field.
  | {
      kind: "applySplitBlueprint"; point: [number, number]; level?: number;
      resolvedSlots: ResolvedSplitSlot[]; originalFaces?: ResolvedSplitFace[]; blueprintTitleKey?: string;
      pointId: string;
    }
  | { kind: "addVerticalPassage"; id: string; from: PostEditEndpoint; to: PostEditEndpoint; direction: PostEditVerticalPassageDirection }
  // `from`/`to` (GitHub issue #564 follow-up) are this passage's own endpoints AT THE TIME of this
  // command, denormalized the same way `removeVerticalPassage` below is — the "Changes" panel's
  // bubbles must not resolve through `live` (the CURRENT draft) for an id-only command, since an
  // older row's own id can outlive the entity (removed, or churned) by the time that row renders;
  // reading the live entry then produces stale coordinates for a still-existing entity, or a bare
  // unresolved "?" bubble for a removed one, for every row about it, not just the removal row
  // itself. Generation-baked vertical passages are full baseline draft entries with their own
  // stable id (GitHub issue #564) — there is no separate generation-mesh suppression concept any
  // more; editing one is an ordinary edit of an existing draft entry, like any other.
  | { kind: "setVerticalPassageDirection"; id: string; direction: PostEditVerticalPassageDirection; from: PostEditEndpoint; to: PostEditEndpoint }
  // `from`/`to` (GitHub issue #564 follow-up) are this passage's own RESULTING endpoints after this
  // move (i.e. `end`'s side already replaced by `endpoint`) — same denormalization reasoning as
  // `setVerticalPassageDirection`'s own `from`/`to` above. `direction` (same follow-up, second pass)
  // is the passage's own CURRENT direction (unaffected by a plain endpoint move) — without it the
  // "Changes" panel's arrow fell back to `live.verticalPassages.get(id)?.direction`, which reads
  // `undefined` once a later command removes the entity, defaulting the arrow to a plain "->" even
  // for a two-way passage; an id-only lookup breaks for an old row exactly like the bubbles did
  // before this same denormalization fix was applied to them.
  | { kind: "moveVerticalPassageEndpoint"; id: string; end: "from" | "to"; endpoint: PostEditEndpoint; from: PostEditEndpoint; to: PostEditEndpoint; direction: PostEditVerticalPassageDirection }
  // `from`/`to` (GitHub issue #564 partial) are the removed passage's own endpoints, denormalized
  // onto the command at construction time — mirrors every other pre-resolved field in this file
  // (`ResolvedRotateMove`, ...). Without them, the "Changes" panel has nothing left to resolve a
  // location from once the entry is gone from `postEditDraftVerticalPassages` — `live` (built from
  // the CURRENT draft) can only answer for entities that still exist, so a `removeVerticalPassage`
  // row rendered as a bare "Vertical passage removed" with no coordinates at all. Covers a
  // generation-baked passage's removal too (GitHub issue #564 follow-up) — since it's a full
  // baseline draft entry with its own id, removing it is this ordinary command, not N raw edge-pair
  // suppressions.
  | { kind: "removeVerticalPassage"; id: string; from: PostEditEndpoint; to: PostEditEndpoint; direction: PostEditVerticalPassageDirection }
  | { kind: "addElevator"; id: string; floors: PostEditEndpoint[] }
  | { kind: "updateElevatorFloors"; id: string; floors: PostEditEndpoint[] }
  // `floors` (GitHub issue #564 partial) is the removed elevator's own floor list, denormalized
  // onto the command at construction time — same reasoning as `removeVerticalPassage`'s `from`/`to`
  // above; `live` can't answer for an entity no longer in `postEditDraftElevators`. Covers a
  // generation-baked elevator's removal too (GitHub issue #564 follow-up) — same "full baseline
  // draft entry with its own id" reasoning as `removeVerticalPassage`.
  | { kind: "removeElevator"; id: string; floors: PostEditEndpoint[] };
