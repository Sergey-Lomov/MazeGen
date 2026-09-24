# Post-Edit Feature — Web Client

## Current edge model

### Endpoint drag hit area

Post-edit teleport, vertical-passage, and elevator endpoint hit-tests use the tessellation projection's `screenToGrid` result. A pointer press anywhere inside the cell containing an endpoint can therefore start a drag; it is not limited to the rendered marker's radius. If multiple endpoint markers share a cell, the nearest rendered marker is selected. Unresolvable endpoints and endpoints on inactive floors remain excluded as before.

Wall, passage, and one-way are states of a geometric face, not independent entities.
`setEdge`/`setEdgePair` is the only event for changing such a state; changing one-way direction
emits the state again with the opposite directed face. One-way edges have no id, lifecycle,
remove event, or compatibility format. Project files use only the current schema; legacy
one-way ids, counters, and command fields are rejected rather than migrated.

Post-Edit sits between Generation and Analytics in `FeaturesPanel`. It lets users manually modify maze edges after generation before inspecting analytics. Analytics always reads the confirmed post-edited graph.

## Availability

- Card status `"unavailable"` when `nodes.length === 0`
- Card status `"set"` after generation (no warnings from `postEditAnalytics`)
- Card status `"warning"` when `postEditAnalytics.warnings.length > 0`

## Three-State Model

| State | Condition | Analytics source |
|---|---|---|
| Generated | After `generate()`, before any manual confirm | From `generate()` call — `postEditAnalytics` set immediately |
| Post-edit confirmed | After `confirmPostEdit()` (auto or manual) | From `confirmPostEdit()` result |
| Post-edit draft | `autoConfirm=false`, edges/meta changed since last confirm | Frozen at last confirm — canvas shows draft, analytics shows confirmed |

## Command Log (GitHub issue #543)

Post-edit's working state is a single ordered, replayable **command log**, not a set of
independent per-entity draft snapshots. Every manual change (edge tool click, teleport/vertical
passage/elevator add/edit/remove, start/finish assignment, split-node add/remove/rotate/blueprint,
point delete) appends one `PostEditCommand` to the log; the current derived state is always this
log folded over a fixed baseline, never mutated in place.

This replaces an earlier design where each entity kind tracked "changed vs. generation" its own
way (a signature diff against `_generatedEdges` for edges, a suppression set for vertical
passages/elevators, a raw id comparison for start/finish, no tracking at all for teleports) — that
inconsistency was the root cause of a string of reset/delete bugs (each entity kind needing its own
point-release/patch). A single log + replay gives every entity kind the same reset/delete/undo
semantics for free.

### `PostEditCommand` (`store/postEditCommandTypes.ts`)

Every stable post-edit entity id (split point, teleport, vertical passage, elevator — GitHub issue
#564) is a type-prefixed **string**, not a bare number — `"t3"`/`"s1"`/`"v2"`/`"e7"` for
teleport/splitPoint/verticalPassage/elevator respectively
(`formatPostEditId`/`parsePostEditIdNumber`/`PREFIX`, `pixi/postEditIdFormat.ts`), so an id string
alone already says what kind of entity it names — useful in the "Changes" panel, exported project
files, and logs. Each category has its own fully independent counter/namespace (`_nextPostEdit*Id`,
still a plain `number` — only the *minted*/formatted id is a string) — a one-way edge and a split
point can both be "id 3" without colliding, since `"o3"` and `"s3"` never compare equal.
`assignSequentialIds(items: { key: string }[]): Map<string, number>` (`pixi/postEditUtils.ts`) is the
shared deterministic-numbering primitive every category's baseline extraction uses: sort candidate
entities by their own canonical key (an endpoint/edge key, never array/iteration order, which isn't
guaranteed stable across a reload/re-serialization of the same generation snapshot), then number
1..N — so the same generation snapshot always produces the same `canonicalKey → id` mapping
regardless of `edges`/`nodes` input order.

```typescript
// PostEditEdge/PostEditEdgeState — a face state, with no object identity. One-way is a state
// alongside wall and basic passage; it is not a lifecycle-managed entity.
type PostEditEdgeState =
  | { kind: "wall" | "basic"; from: PostEditEndpoint; to: PostEditEndpoint }
  | { kind: "one_way_forward" | "one_way_backward"; from: PostEditEndpoint; to: PostEditEndpoint };

type PostEditCommand =
  | { kind: "setEdge"; edge: PostEditEdgeState }
  // wall/passage/one_way tools set both directed states of a face pair atomically. Direction
  // changes are represented by another setEdgePair with the opposite one-way state.
  | { kind: "setEdgePair"; a: PostEditEndpoint; b: PostEditEndpoint; aToB: PostEditEdgeState; bToA: PostEditEdgeState }
  | { kind: "addTeleport"; id: string; from: PostEditEndpoint; to: PostEditEndpoint; direction: PostEditTeleportDirection }
  // `from`/`to` (GitHub issue #564 follow-up) are this teleport's own endpoints, denormalized onto
  // the command at construction time - same fix already applied to every vertical-passage command;
  // an id-only lookup into the CURRENT draft is correct only for the newest row about this id, and
  // shows a stale (or, once removed, unresolved) location for every OLDER row about it.
  | { kind: "setTeleportDirection"; id: string; direction: PostEditTeleportDirection; from: PostEditEndpoint; to: PostEditEndpoint }
  // `from`/`to`/`direction` (same follow-up) are this teleport's own RESULTING pair/direction after
  // this move - same denormalization reasoning as `setTeleportDirection` above.
  | { kind: "moveTeleportEndpoint"; id: string; end: "from" | "to"; endpoint: PostEditEndpoint; from: PostEditEndpoint; to: PostEditEndpoint; direction: PostEditTeleportDirection }
  // `from`/`to`/`direction` (same follow-up) are the removed teleport's own endpoints/direction,
  // denormalized at construction time - without them the row has nothing left to resolve a
  // location from once the entry is gone from `postEditDraftTeleports`.
  | { kind: "removeTeleport"; id: string; from: PostEditEndpoint; to: PostEditEndpoint; direction: PostEditTeleportDirection }
  // `previousEndpoint` (GitHub issue #564 follow-up) is the slot's own endpoint right before this
  // command, denormalized at construction time - only meaningful (and only ever set) when
  // `endpoint` is `null` (a clear); without it, a "start/finish cleared" row had no coordinates left
  // to show once the slot itself was empty.
  | { kind: "setMeta"; slot: "start" | "finish"; endpoint: PostEditEndpoint | null; previousEndpoint?: PostEditEndpoint }
  // `pointId` (GitHub issue #564) is the split TILE's own stable id (distinct from `slotId`, which
  // addresses one node within the tile) — resolved at command-construction time: the point's
  // current id if it already exists (baseline or created earlier in this same log), else a freshly
  // minted one. Replay checks it against the CURRENT derived state (not baseline) and fails the
  // command on a mismatch, never silently overwriting an existing point's identity.
  | { kind: "addSplitNode"; point: [number, number]; level?: number; slotId: number; pointId: string }
  | { kind: "removeSplitNode"; point: [number, number]; level?: number; slotId: number; pointId: string }
  // Whole-split-point removal for GENERATION-BAKED slots (GitHub issue #550 follow-up,
  // `removePostEditSplitSlots` in `postEditSliceHelpers.ts`) — a slot with no earlier `addSplitNode`/
  // `applySplitBlueprint` in this log can't be undone by cascading a create command away (there is
  // none), so this is an explicit, atomic removal instead: `removedSlotIds` lists every slot this one
  // command takes out. `restoredOriginalFaces`, when present, is the point's ORIGINAL node's own
  // face list at GENERATION time (resolved once at construction via `currentSplitNodeFaces` against
  // the baseline's own edges, same shape `ResolvedSplitEdgeFace[]` `updateSplitNodeFaces.faces`
  // uses) — set only when this removal empties the point completely, so the original node's wiring
  // reverts to exactly what generation produced, "as if never split." Omitted when other slots
  // survive this removal (a shrink, not a full un-split) — the original node's wiring is left alone.
  // A point mixing post-edit-created and generation-baked slots needs both this command AND a
  // cascade over the post-edit-created ones' own lifelines to fully empty — see "delete Tool Detail"
  // above.
  | {
      kind: "removeSplitPoint"; point: [number, number]; level?: number; pointId: string;
      removedSlotIds: number[]; restoredOriginalFaces?: ResolvedSplitEdgeFace[];
    }
  // A split node's face wiring, resolved atomically - every edge-tool click on one of a split
  // point's nodes' faces appends one of these carrying the FULL current face list for that node
  // (like `updateElevatorFloors` carries the full floor list), never a `setEdgePair`/`setEdge` for
  // that face alone. `slotId: undefined` addresses the point's ORIGINAL node (GitHub issue #564
  // follow-up: every node of a split point, the original included, is equally addressable) — same
  // "no entry/id means the original node" convention `postEditActiveSplitNode` uses elsewhere.
  // Shares its lifeline with the slot's own `addSplitNode`/`removeSplitNode` when `slotId` is set,
  // or its own point-scoped key when it's the original node (which has no add/remove command of its
  // own to share a lifeline with).
  | { kind: "updateSplitNodeFaces"; point: [number, number]; level?: number; slotId?: number; faces: ResolvedSplitEdgeFace[]; pointId: string }
  | { kind: "rotateSplitPoint"; point: [number, number]; level?: number; nodes: ResolvedRotateNode[] }
  // `originalFaces` carries the pre-existing node's own faces in the SAME command as the blueprint
  // application, instead of a trailing `setEdge`/`updateSplitNodeFaces` per face - applying a
  // blueprint is one logical action. `blueprintTitleKey` carries the blueprint's own `titleKey`
  // straight onto the command for the Changes panel label; `undefined` for an unnamed blueprint.
  // `pointId` — same resolution/replay-check rule as `addSplitNode`'s own field.
  | {
      kind: "applySplitBlueprint"; point: [number, number]; level?: number;
      resolvedSlots: ResolvedSplitSlot[]; originalFaces?: ResolvedSplitFace[]; blueprintTitleKey?: string;
      pointId: string;
    }
  | { kind: "addVerticalPassage"; id: string; from: PostEditEndpoint; to: PostEditEndpoint; direction: PostEditVerticalPassageDirection }
  // `from`/`to` (GitHub issue #564 follow-up) are this passage's own endpoints at the time of this
  // command, denormalized the same way `removeVerticalPassage` below is - an id-only lookup into
  // `live` (the CURRENT draft) breaks for any OLD row once the referenced entity has since been
  // removed or moved on by a later command, not just for the removal row itself; this used to show
  // as a correct removal row (coordinates present) sitting above stale "?" move/direction rows for
  // the SAME entity. A generation-baked vertical passage is a full baseline draft entry with its own
  // stable id (GitHub issue #564) — editing one is an ordinary edit of an existing draft entry, like
  // any other; there is no separate generation-mesh suppression concept any more.
  | { kind: "setVerticalPassageDirection"; id: string; direction: PostEditVerticalPassageDirection; from: PostEditEndpoint; to: PostEditEndpoint }
  // `from`/`to` (GitHub issue #564 follow-up) are this passage's own RESULTING endpoints after this
  // move (the moved `end` already replaced by `endpoint`) - same denormalization reasoning as
  // `setVerticalPassageDirection`'s own `from`/`to` above. `direction` (same follow-up, second pass)
  // is this passage's own CURRENT direction, unaffected by a plain endpoint move - without it the
  // "Changes" panel's arrow fell back to a `live` id lookup, defaulting a since-removed two-way
  // passage's old move row to a plain one-way "->" arrow.
  | { kind: "moveVerticalPassageEndpoint"; id: string; end: "from" | "to"; endpoint: PostEditEndpoint; from: PostEditEndpoint; to: PostEditEndpoint; direction: PostEditVerticalPassageDirection }
  // `from`/`to`/`direction` are the removed passage's own endpoints, denormalized onto the command
  // at construction time (GitHub issue #564 partial) - without them the "Changes" panel has nothing
  // left to resolve a location from once the entry is gone from `postEditDraftVerticalPassages`
  // (the panel's `live` map is built from the CURRENT draft, which by definition no longer has this
  // id), so a `removeVerticalPassage` row used to render as a bare "Vertical passage removed" with
  // no coordinates at all. Covers a generation-baked passage's removal too (GitHub issue #564
  // follow-up) — since it's a full baseline draft entry with its own id, removing it is this
  // ordinary command, not N raw edge-pair suppressions (see "Changes Panel" below).
  | { kind: "removeVerticalPassage"; id: string; from: PostEditEndpoint; to: PostEditEndpoint; direction: PostEditVerticalPassageDirection }
  | { kind: "addElevator"; id: string; floors: PostEditEndpoint[] }
  | { kind: "updateElevatorFloors"; id: string; floors: PostEditEndpoint[] }
  // `floors` is the removed elevator's own floor list, denormalized onto the command at
  // construction time (GitHub issue #564 partial) - same reasoning as `removeVerticalPassage`'s
  // `from`/`to` above. Covers a generation-baked elevator's removal too (same follow-up) — same
  // "full baseline draft entry with its own id" reasoning as `removeVerticalPassage`.
  | { kind: "removeElevator"; id: string; floors: PostEditEndpoint[] };
```

There is no `deletePoint` command kind - the Delete tool appends ordinary per-entity commands
(`setMeta`/`removeTeleport`/`removeVerticalPassage`/`removeElevator`/etc.), each with its own
lifeline, so a point-reset undoes them through the same per-lifeline cascade as any other edit, with
no dedicated delete lifeline involved.

Every command addresses entities exclusively through the stable identity kinds already used
elsewhere in post-edit — `PostEditEndpoint` (node/split) and each category's own monotonic,
type-prefixed string id (teleport/one-way/splitPoint/vertical-passage/elevator) — no new identity
concept beyond the id-string format itself. All conditional decisions (wall/passage/one-way toggle
outcome, one-way id mint-vs-reuse, split-point id resolution, split-node face assignment) are
resolved **once, at command-construction time**, reading live confirmed/derived state — replay
itself never reads outside its own `PostEditReplayContext`/fold state:

- `rotateSplitPoint.nodes`/`applySplitBlueprint.resolvedSlots` carry pre-computed, fully resolved
  face assignments (`rotateSplitPointNodes`/split-blueprint resolution in `pixi/postEditUtils.ts`)
  — replay has no tessellation/field access, so a rotation's or blueprint's geometric outcome is
  computed once by the store action, not re-derived during replay. `rotateSplitPoint.nodes` is a
  COMPLETE snapshot of every affected node's own face list (`ResolvedRotateNode`, the same shape
  `updateSplitNodeFaces.faces` uses), not a diff of moved edges — every split command that can recur
  against the same node is uniformly a full snapshot, which is what lets compaction
  (`Specs/post-edit.md`'s "Log compaction" section) safely drop an earlier command from the same
  point's log without leaving a later command's own re-keys resolved against a state that no longer
  exists.
- `addSplitNode.slotId` is the already-resolved next id (from `_nextSplitSlotId`'s high-water mark
  for that point, not recomputed at replay time); `addSplitNode.pointId`/`applySplitBlueprint.pointId`
  are resolved the same way from `_nextPostEditSplitPointId`, or reused from the point's existing id.
- One-way is a face state. `setEdge`/`setEdgePair` records the resulting direction directly; there
  is no one-way id, minting, reuse, or lifecycle.

### Replay (`pixi/postEditReplay.ts`)

```typescript
interface PostEditReplayContext {
  nodes: NodeDto[]; // baseline nodes the log's endpoints resolve against — never live confirmed state.nodes
  resolveSplit: (point: [number, number], slotId: number, level?: number) => number | undefined;
}

interface PostEditBaseline {
  revision: number; // bumped on every new generation, never on post-edit reset
  context: PostEditReplayContext;
  derived: PostEditDerivedState; // pristine, empty-log derived state — never overwritten after construction
}

function applyPostEditCommand(context, state: PostEditDerivedState, command): { state: PostEditDerivedState; applied: boolean };
function replayPostEditCommands(baseline: PostEditBaseline, commands: PostEditCommand[]): PostEditDerivedState;
function replayPostEditCommandsFailClosed(baseline: PostEditBaseline, commands: PostEditCommand[]): PostEditDerivedState | undefined;
```

`applyPostEditCommand` is the sole place holding per-entity-kind logic (folded in from the old
`applyPostEditEdgeTool`/teleport/vertical-passage/split-node functions) — never mutates its input
`state` or any nested `Record`/array, always returns fresh references for anything it changes.
`applied: false` signals a structurally invalid command (a reference that doesn't resolve against
`context`+`state`) without throwing — a plain bool a caller can act on. Add-entity cases
(`addTeleport`/`addVerticalPassage`/`addElevator`) additionally guard against a duplicate id already
present in their target collection, returning `applied: false` rather than silently creating a
second entry two different lookups could each resolve differently (mirrors `addSplitNode`'s
existing per-point slot-id guard).

`replayPostEditCommands` folds the full command list over `baseline.derived` via
`applyPostEditCommand`, silently skipping any command that doesn't apply — used for reset,
point-reset, and any replace-the-whole-log operation. `replayPostEditCommandsFailClosed` is the
load-time variant: if *any* command in a loaded log fails to apply, it returns `undefined` instead
of a partially-applied state — the caller (`mazeStore.ts`'s load path) then discards the entire
`postEdit` section rather than risk silent data loss from a half-replayed log (see "Persistence"
below). Ordinary incremental edits don't call `replayPostEditCommands` at all — `appendPostEditCommand`
(below) applies just the new command directly against the current `postEditDerived`, which is
equivalent to but cheaper than a full replay (covered by a parity test).

### Point-reset — fixed-point lifeline pruning

`filterCommandsForPoint(baseline, commands, point, level)` implements the cell branch of the Reset
tool and `deletePostEditPoint`'s undo path. A **lifeline** is the logical entity a command belongs
to. `lifelineKeysOf(command): string[]` (plural — GitHub issue #564: a single `setEdgePair` can
atomically touch up to two independent one-way lifelines at once, one per side, both the side's own
new face state returns the face's spatial lifeline
key a command is relevant to: `` `${kind}:${id}` `` for teleport/vertical-passage/elevator,
`` `oneWay:${id}` `` for a one-way edge (identity is the id, not the face — a face reset from
one-way back to wall/basic ends that lifeline; a later click turning the same face one-way again
starts a new one with a new id), `` `slot:${point}:${level}:${slotId}` `` for a split node addressed
by `slotId`, `` `point:${point}:${level}:${pointId}` `` for the split point's own identity (its
`addSplitNode`/`removeSplitNode`/`applySplitBlueprint`, and `updateSplitNodeFaces` on the original
node where `slotId` is `undefined`), and `` `meta:${slot}` `` for start/finish. A `setEdgePair` that
mints or destroys a one-way on the `a→b` side and/or the `b→a` side returns one `oneWay:${id}` entry
from the face endpoints, never from an object id —
never inferred by scanning neighboring log entries. `removeSplitPoint` (GitHub issue #550 follow-up)
similarly returns one `slot:${point}:${level}:${slotId}` entry per id in its own `removedSlotIds` —
it belongs to every removed slot's lifeline at once, the same "one command, several lifelines"
shape `setEdgePair` already established.
`collectAffectedLifelines` walks the command list once, computing (against the state *before* each
command in sequence) whether that command's entity currently touches `point`/`level` — including
split-structure commands addressing that point directly, move-commands whose old *or* new endpoint
lands there, and any command referencing a slot lifeline already marked affected (so an edge/
teleport hung off a to-be-removed split slot is pulled in too). `filterCommandsForPoint` repeats
this to a fixed point (re-scanning until nothing new gets pulled in) — a single pass can't catch
multi-level dependency chains (slot removed → edge on that slot removed → a teleport that was moved
onto that edge's other endpoint also removed → …).

This also means an entity's lifeline is indivisible across points: resetting point A undoes every
command that lifeline ever received, even one made while the entity's endpoint was at a different
point B — e.g. a generation-time teleport A↔B, moved to end at C, then edited at C: resetting A
removes the whole lifeline, including the edit made at C, because the lifeline's root command
originated at A. This is deliberate UI-level semantics ("resetting a point resets everything that
entity ever touched"), not an implementation accident.

`resetPostEditPoint(point)` = `replacePostEditCommands(get, set, filterCommandsForPoint(baseline,
commands, point, level), /* dirty */ true)`. `resetPostEdit()` (whole graph) is the trivial case:
`replacePostEditCommands(get, set, [], /* dirty */ false)`.

### Per-command Reset/Delete (GitHub issue #547, `pixi/postEditReplay.ts`)

Each Changes-panel row (below) carries two actions, both confirmed via `ConfirmModal` before
running: **Reset** truncates the log to end right after that row's own command
(`resetCommandsAt(commands, index)` = `commands.slice(0, index + 1)`, a plain prefix cut — the
target command survives, every later command of any lifeline is discarded); **Delete** removes
exactly that one command (`deleteCommandAt(baseline, commands, index)`) and resolves what that
leaves behind, which differs by whether the command *mints* a lifeline or just edits one
(`isCreateCommand`, below):

- **Create command** (`addTeleport`/`addVerticalPassage`/`addElevator`/`addSplitNode`/
  `applySplitBlueprint`, or a `setEdge`/`setEdgePair` side that mints a fresh one-way id — not a
  — Delete
  cascades the whole lifeline it started, same fixed-point/slot-reference-cascade shape
  `filterCommandsForPoint` already uses for a point-reset (`cascadeLifelineKeys`, seeded directly
  from `lifelineKeysOf(target)` instead of "whatever touches this point", then run to a fixed point
  through the same `expandSlotReferenceCascade` point-reset shares): there's no entity left for any
  dependent command to describe once its creation is undone.
- **Any other command** (a move/direction-change/removal/face-rewire) — Delete is a single-entry
  collapse by default: only that one entry disappears, every other command (including later ones in
  the *same* lifeline) stays and gets replayed on top of the shorter log. A move chain collapses
  accordingly — `P1→P2` then `P2→P3`, with the `P1→P2` step deleted, replays down to a single
  effective `P1→P3` (`applyPostEditCommand`'s move cases always read the *live* entry from the
  folded state, never a command's own denormalized `from`, so this falls out of the fold for free).
  Deleting a `remove*` command is therefore itself undoable — the entity it removed reappears.
  - **Direction-flip pair cascade (second follow-up)**: if the deleted command is itself a
    direction flip (`isDirectionCommand` — `setTeleportDirection`/`setVerticalPassageDirection`, or
    an edge-state command), deleting it only removes that command from the spatial face log; the
    *next* direction-flip command of that **same lifeline** (`nextDirectionCommandIndex`), if one
    exists later in the log. Rationale: `->` then `<-` then `->` with the middle flip deleted would
    otherwise replay down to two consecutive same-direction flips (`-> ->`), which is meaningless —
    cascading the following flip collapses it back to a single `->`. Any non-direction command of
    the same lifeline in between (e.g. a move) is skipped over, not treated as breaking the pair; a
    direction flip belonging to a *different* lifeline in between is ignored entirely (only that
    lifeline's own next flip counts). Only the immediate next flip is taken — this doesn't chain
    further (deleting a flip never cascades a third or later flip beyond the immediate pair).

`isCreateCommand(command): boolean` and `isDirectionCommand(command): boolean` are pure
classifications over `PostEditCommand.kind` for
`setEdge`/`setEdgePair`) — neither inspects surrounding log entries; pairing up the *next* flip is
`nextDirectionCommandIndex`'s own job, called only when `isDirectionCommand(target)` holds.

`affectedIndicesForReset(commands, index)` / `affectedIndicesForDelete(commands, index)` expose the
exact index sets `resetCommandsAt`/`deleteCommandAt` would remove (`undefined` for an out-of-range
index), without mutating anything — the Changes panel's hover preview (below) calls these same two
functions, so the red preview can never drift from what a click actually does.

**Denormalization after a collapse**: a command's own denormalized from/to/direction/floors/
`previousEndpoint` fields (see the `PostEditCommand` union's own doc comments above) were resolved
once, at ORIGINAL construction time, against whatever the state was back then — deleting an earlier
command in the same lifeline would otherwise leave every later survivor's own denormalized fields
describing a pre-deletion location/direction, even though the derived state itself replays
correctly (the fold reads live state, not the stale fields). `deleteCommandAt` fixes this by
`renormalizeCommand`-ing every surviving command against the state immediately preceding it in the
NEW (post-deletion) sequence, while it re-folds that sequence to compute each `before` state — only
fields a command denormalizes FROM prior state are touched; a field that IS the command's own
authored intent (`endpoint` on a move, the `direction`/`floors` being set) is left exactly as
authored, since re-deriving it from `before` would silently change what the user asked for rather
than just refresh a stale snapshot.

### Log compaction (GitHub issue #548, `pixi/postEditCompaction.ts`)

`compactPostEditCommands(baseline, commands)` drops every command whose effect is no longer
observable in the log's own final state — a stale command superseded by a later one of the same
face/entity/point — then `renormalizeCommand`-s every survivor the same way `deleteCommandAt` does,
so a collapse never leaves a denormalized from/to/direction/floors field describing a
pre-compaction snapshot. Triggered either manually (a "Compact" button pinned below the Changes
panel's row list, sticky to the panel's own bottom edge the same way the entity-id filter is sticky
to its top — opens a `ConfirmModal`, then calls `compactPostEditLog()`) or automatically after every
command/batch when `postEditAutoCompact` (a `ToggleRow` next to the auto-confirm one in the post-edit
panel's Management section, default off) is on — `finalizeAutoCompact` in `postEditSliceHelpers.ts`
runs the same `compactPostEditCommands` call inside `appendPostEditCommand`/`replacePostEditCommands`'s
own `set`, right after the command list would otherwise be committed as-is. The switch's info icon
(GitHub issue #576, `AutoCompactInfoModal`) explains, in plain language, that auto-compact shrinks the
log by dropping superseded entries (e.g. only the start's final position survives repeated moves),
that the exact step-by-step history is lost as a result, and that log size has no real effect on
performance — so the toggle is purely a convenience choice, not a performance one.

Compaction groups all `setEdge`/`setEdgePair` commands by the face's undirected endpoint-pair key.
Wall, passage, and one-way are states of that same face, so a sequence of state changes keeps only
the final state (or drops the whole sequence when it equals generation). There is no one-way
lifeline, creation preservation rule, direction-flip event, or one-way ID. Every other command kind
keeps its own `lifelineKeysOf` grouping (teleport/
vertical passage/elevator by id, a split slot by `slot:point:slotId`/`originalNode:point`, a whole
split point rebuild by `point:point`, start/finish by `meta:slot`).

Per-group staleness rules:

- **Edge group** (wall, passage, and one-way states): each `setEdge`/`setEdgePair` is superseded by
  the NEXT one on the same face — only the group's last command survives, unless that state equals
  generation, in which case the whole sequence is removed.
- **Create/remove groups** (teleport/vertical passage/elevator/split-slot): a `remove*` command
  supersedes every earlier command of its own group (the create and every move/flip in between) —
  none of their effects are observable once the entity is gone. If the group's own first command is
  itself a create (no baseline counterpart), the remove also supersedes *itself*: an entity created
  and destroyed entirely within the log leaves nothing to record. A remove of a *baseline* entity
  (no create command earlier in the log) keeps the remove — "this baseline entity is now gone" is
  still an observable effect. `removeSplitPoint` (GitHub issue #550 follow-up) follows the same rule
  per slot group it belongs to (`compactionGroupsOf` returns one `slot:` group per `removedSlotIds`
  entry): it supersedes each such group's earlier `addSplitNode`/`updateSplitNodeFaces`, same as
  `removeSplitNode` does for its own single slot.
- **Move commands** (`moveTeleportEndpoint`/`moveVerticalPassageEndpoint`/`updateElevatorFloors`/
  `updateSplitNodeFaces`): each move supersedes only the immediately PRECEDING move of the same
  group — never the create, never a direction-flip sitting between two moves. A `P1->P2->P3` chain
  collapses to a single effective `P1->P3`, the same collapse `deleteCommandAt` already performs for
  a single deleted move.
- **Direction-flip pairs** (`setTeleportDirection`/`setVerticalPassageDirection`): a flip toggles the entity's CURRENT direction
  regardless of its own denormalized `direction` field, so two consecutive flips of one group (with
  only non-direction commands of the same group, if any, between them) cancel out — both superseded.
  Pairing runs from the START of the group's own flip-only subsequence: flip 1+2 cancel, flip 3+4
  cancel, and so on; an odd trailing flip survives alone. This is why a *second* direction change
  can make the *first* one stale purely by existing (an even flip count nets to "as if neither
  happened"), and why removing one flip of a cancelling pair (e.g. via the per-row Delete action)
  makes the other flip relevant again — compaction and `deleteCommandAt`'s own flip-pair cascade are
  two sides of the same "an even number of flips is a no-op" fact.
- **`rotateSplitPoint`/`applySplitBlueprint`**: `applySplitBlueprint` rebuilds a split point's entire
  slot list AND node/face structure from scratch (its replay case writes `splitPoints`/
  `splitPointIds`, same as `addSplitNode`/`removeSplitNode`), so a later one supersedes every earlier
  `slot:`/`originalNode:`/`point:` command of the SAME point — across every one of that point's slot
  groups at once, not just the group the rebuild command itself would key under alone.
  `rotateSplitPoint` only re-wires the slots it was given — its replay case never touches
  `splitPoints`/`splitPointIds` at all — so it supersedes an earlier `rotateSplitPoint`/
  `updateSplitNodeFaces` the same way (both pure wiring rebuilds), but never any command that
  registers a slot's existence (`addSplitNode`, `removeSplitNode`, or `applySplitBlueprint`):
  dropping one of those would leave that slot's rotated wiring snapshot with nothing left to attach
  to — the point silently loses that node after compacting (GitHub issue #548 follow-up fix; the
  `applySplitBlueprint` case was the one that actually surfaced in practice, since a split tile is
  normally created via a blueprint, not `addSplitNode` directly).
- **`setMeta`**: a later `setMeta` for the same slot supersedes the earlier one outright — only the
  slot's current value is ever observable.

Runs to a fixed point, re-scanning after every removal pass: dropping a superseded command can
expose a newly-superseded one that wasn't stale while the dropped command still sat between it and
whatever superseded it (an even-numbered flip run becoming odd again once one flip of a pair is
otherwise removed, mirroring the same "deleting a flip un-cancels its old partner" dynamic manual
per-row deletion already has). Terminates because each iteration strictly shrinks the log or leaves
it unchanged. Returns the input array unchanged (by reference) when nothing is superseded.

Split-node commands (`addSplitNode`/`removeSplitNode`/`updateSplitNodeFaces`/`rotateSplitPoint`/
`applySplitBlueprint`) are compacted by the same pass as every other category, not deferred — a
`removeSplitNode` supersedes its own slot's earlier `addSplitNode`/`updateSplitNodeFaces` (or itself
too, if the slot never existed in the baseline) the same way `removeTeleport` does for a teleport.

### Changes-panel row actions (GitHub issue #547)

Each row shows two icon buttons (`RotateCcw`/`Trash2`) inline in the same flex row as that row's
own coordinate bubbles (`styles.bubblesRow`: bubbles on the left, buttons pushed to the right edge
via `marginLeft: auto`) — not a separate absolutely-positioned corner overlay. Reset uses a neutral
tint; Delete is red (`ui.text.error` — it can cascade a whole entity away). Both open a
`ConfirmModal` first (`post_edit.confirm_changes_reset` / `..._delete` / `..._delete_cascade`, the
last one for a create command's own cascade, computed via `isCreateCommand`) before calling
`resetPostEditCommand(commandIndex)` / `deletePostEditCommand(commandIndex)` — store actions that
thin-wrap `resetCommandsAt`/`deleteCommandAt` through `replacePostEditCommands` (`dirty: true`),
same as `resetPostEditPoint`. `commandIndex` is the log's own oldest-to-newest index, stamped onto
each command BEFORE the entity-id filter/reverse the panel applies for display, and carried
alongside its row from there on — never the reversed display position, since the row actions must
resolve the correct command regardless of the entity-id filter or the newest-first display order.

**Hover preview (second follow-up)**: hovering either button sets a local `hoveredPreview: {kind,
commandIndex}` state; a `useMemo` resolves it to the exact index set via
`affectedIndicesForReset`/`affectedIndicesForDelete` (the same functions the click handlers'
underlying store actions use), and every row whose `commandIndex` is in that set — including the
hovered row itself — gets the `rowDeletePreview` style (`background: ui.bg.error`) instead of its
normal/entity-highlight background. Leaving the button clears `hoveredPreview` and the highlight.
Because preview and action share the same index-computing functions, the highlighted set is always
exactly what a click would remove.

### Log-mutation entry points (`store/slices/postEditSliceHelpers.ts`)

`appendPostEditCommand(get, set, command): boolean` and `replacePostEditCommands(get, set,
commands, dirty): void` are the **only** two places allowed to write `postEditCommands`/
`postEditDerived` — every store action builds a command (after its own UX-precondition guards, same
error messages as before) and goes through one of these two, never `set({ postEditCommands: ... })`
directly.

- `appendPostEditCommand` applies the new command directly against the current `postEditDerived`
  (not a full replay); returns `false` (log/state left untouched) if the command didn't apply — the
  calling action must not advance any id counter (`_nextPostEditTeleportId` etc.) unless this
  returns `true`. Bumps `_postEditRequestId` on success, so any in-flight `confirmPostEdit` becomes
  stale regardless of whether the caller remembers to re-trigger confirm.
- `replacePostEditCommands` always does a full `replayPostEditCommands` from `postEditBaseline` —
  used by reset, point-reset, and load. `dirty` is caller-supplied (see the dirty table below), not
  inferred.

### Store fields

| Field | Type | Description |
|---|---|---|
| `postEditCommands` | `PostEditCommand[]` | The command log — single source of truth for every manual post-edit change. |
| `postEditBaseline` | `PostEditBaseline \| null` | Generation-time snapshot (`context`) + revision + pristine (empty-log) derived state. `derived` here is never overwritten after construction. `null` before the first generation. |
| `postEditDerived` | `PostEditDerivedState \| null` | Current derived state — `postEditBaseline.derived` with `postEditCommands` replayed on top; kept in sync by `appendPostEditCommand`/`replacePostEditCommands`. `null` before the first generation. |
| `postEditDraftEdges` / `postEditDraftTeleports` / `postEditDraftMeta` / `postEditDraftSplitPoints` / `postEditDraftSplitPointIds` / `postEditDraftVerticalPassages` / `postEditDraftElevators` | (unchanged shapes, `postEditDraftSplitPointIds` new) | **Derived, not independently mutated.** Mirrored 1:1 from `postEditDerived` via `derivedStateToLegacyFields` on every log mutation, kept as plain fields (not lazy getters) since most of the ~40 read sites subscribe to them individually via zustand selectors. Treat as read-only outside `postEditSlice.ts`/`postEditSliceHelpers.ts` — the log is what gets mutated, these fields just reflect it. `postEditDraftSplitPointIds: Record<string, string>` (GitHub issue #564) mirrors `derived.splitPointIds`, keyed the same as `postEditDraftSplitPoints` — each split point's own stable id. There is no separate suppressed-pairs field any more (GitHub issue #564 removed the suppression mechanism entirely — see "Changes Panel" below); generation-baked vertical passages/elevators are ordinary entries in `postEditDraftVerticalPassages`/`postEditDraftElevators` from the start. |
| `postEditTeleportPendingFrom` | `number \| null` | Node id of the pending teleport's fixed origin during two-click placement, or `null`. |
| `_nextPostEditTeleportId` / `_nextPostEditSplitPointId` / `_nextPostEditVerticalPassageId` / `_nextPostEditElevatorId` | `number` | High-water marks for entity ids; one-way face states have no id or counter. |
| `_nextSplitSlotId` | `Record<string, number>` | Per-point high-water mark for split slot ids, keyed `"x,y"`/`"x,y@level"` — same never-reuse reasoning as the id counters above, needed because a point-reset can prune a high-id slot command out of the log while the mark stays put. |
| `postEditActiveSplitNode` | `Record<string, PostEditEndpoint>` | Which of a split point's nodes edge-tool clicks currently target, keyed by `"x,y"`. No entry means the point's original node. Ephemeral UI state, not in the log. |
| `postEditFocusedPoint` | `[number, number] \| null` | The point currently selected for the "Manage split nodes" panel. |
| `postEditSplitTargetPrompt` | `{ point; level?; nodeIds: number[]; action } \| null` | In-progress "which split node?" prompt (GitHub issue #474) — see "Split-target prompt" below. `null` when no prompt is open. Not persisted. |
| `postEditHoveredEntity` | `PostEditHoveredEntity \| null` | The entity currently hovered in the "Manage split nodes" panel's link bubbles (GitHub issue #237) or the "Changes" panel's entity bubbles (GitHub issue #546) — drives a canvas highlight via `PostEditRenderer`'s `linkHover`/`entityHighlight`, `null` when nothing is hovered. A `point`/`points`/`link` union addressed by raw `[x,y]`+`level` (`PostEditHoverPoint`), not `PostEditEndpoint` — see `pixi/postEditEndpoint.ts`'s doc comment for why. Ephemeral UI state, not persisted; cleared on panel close. Supersedes the old `postEditHoveredLink` (a bare `from`/`to` `PostEditEndpoint` pair). |
| `postEditVerticalPassagePending` / `postEditElevatorPending` | ... | In-progress vertical-passage/elevator placement state — ephemeral, not in the log. |
| `postEditEdges` | `Record<string, PostEditEdge> \| null` | Snapshot of `postEditDraftEdges` at last `confirmPostEdit`. Read by `AnalyticsRenderer`. |
| `postEditTeleportEdges` | `EdgeDto[]` | Snapshot of `postEditDraftTeleports` (converted via `postEditTeleportsToDto`) at last `confirmPostEdit`. Read by `AnalyticsRenderer`. |
| `postEditMeta` | `PostEditMeta \| null` | Snapshot of `postEditDraftMeta` at last `confirmPostEdit`. Read by `AnalyticsRenderer`. |
| `postEditAnalytics` | `PostEditAnalytics \| null` | Analytics over confirmed graph. `null` until first `confirmPostEdit` completes. |
| `postEditTool` | `PostEditTool` | Active tool. Reset to `"wall"` on generate and `resetPostEdit`. |
| `postEditAutoConfirm` | `boolean` | Default `true`. When true, `confirmPostEdit` fires 300ms after each edge edit. |
| `postEditOpen` | `boolean` | Drives canvas layer visibility. |
| `postEditChangesOpen` | `boolean` | Whether the "Changes" panel (GitHub issue #545) is expanded. Default `true` — open by default so the log is visible without an extra click. |
| `_postEditRequestId` | `number` | Versioning for stale async `confirmPostEdit` results; bumped by both `appendPostEditCommand`/`replacePostEditCommands` themselves, not only by an explicit `confirmPostEdit` call. |
| `postEditDirty` | `boolean` | True after any manual post-edit change since the last generate/reset. |

### Changes Panel (GitHub issue #545, bubbles + hover highlight added by #546, per-point bubbles and
row-hover redesign by #546 second follow-up, `pixi/postEditCommandLabels.ts`)

Renders `postEditCommands` as a human-readable list — one row per command, each formatted by
`postEditCommandLabel(command, nodeById, multiFloor)` into a `PostEditCommandLabel`
(`{ action, bubbles, showArrow, arrow, rowHighlight }`). `nodeById` is built from the confirmed node
snapshot (`buildNodeByIdMap`). `multiFloor` is `floors.length > 1`, selecting the coordinate format
below. An endpoint that doesn't resolve (an unconfirmed split node) falls back to a `"?"` bubble
with no highlight, rather than throwing.

Every teleport/vertical-passage command (`setTeleportDirection`/`moveTeleportEndpoint`/
`removeTeleport`, `setVerticalPassageDirection`/`moveVerticalPassageEndpoint`/
`removeVerticalPassage`) and every elevator/`setMeta`-clear row carries its own bubble-relevant
from/to/direction/floors denormalized onto the command at construction time, rather than resolving
through an id-keyed lookup into the CURRENT draft — mirroring every other pre-resolved field in
`PostEditCommand` (the module doc comment in `postEditCommandTypes.ts` calls out
`ResolvedRotateNode`/`applySplitBlueprint`'s `resolvedSlots` as the same pattern). An id-only lookup
into the current draft is correct only for the newest/still-live row about an entity; any OLDER row
about the same id breaks once a later command has moved or removed that entity — this was first
found on `removeVerticalPassage`/`removeElevator` (GitHub issue #564 partial: those two rows
rendered with no coordinates at all, since the entity is by definition already gone from the draft
by the time a removal row renders), then found again (GitHub issue #564 follow-up) on
`setVerticalPassageDirection`/`moveVerticalPassageEndpoint` (an old move/direction row for a
since-removed passage rendered "?" bubbles once the removal row above it started showing correct
coordinates, by contrast) and its own arrow (a second pass — `moveVerticalPassageEndpoint`'s
`direction` had not been denormalized yet, so a since-removed two-way passage's old move row
rendered a plain one-way "->" instead of "<->"), then the identical pattern was found and fixed
across every teleport command and the `setMeta` clear case in one pass. The old `PostEditLiveEntries`/
`buildLiveEntries`/`live` machinery (an id-keyed map built fresh from the CURRENT draft each render)
has been removed entirely — no command kind resolves bubbles that way any more, every one carries
what it needs on itself.

This fix now covers generation-baked entities too (GitHub issue #564): a generation-baked vertical
passage/elevator is a full baseline draft entry with its own stable id from the moment `generate()`
builds the baseline, same as a post-edit-created one — there is no separate generation-mesh concept
any more. Removing one is therefore the same single `removeVerticalPassage`/`removeElevator` command
as removing a post-edit-created entity, denormalized `from`/`to`/`direction`/`floors` and all — never
a per-underlying-edge suppression flood. The old `suppressGenerationPair` command kind, the
`postEditSuppressedVerticalPassagePairs`/`postEditSuppressedElevatorPairs` store fields, and the
`PostEditLiveEntries`-adjacent suppression-set bookkeeping have all been removed.

Each `PostEditEntityBubble` (`{ text, highlight }`) names exactly one point and renders as a
hoverable chip — same monospace bubble style `DebugRefBubble`/`SplitNodesDialogView`'s link bubbles
use — instead of a plain text string. `text` matches the debug event tree's own bubble convention
exactly (`bubbleLabel`, `debugRowText.ts`): `x:y` on a single-floor maze, `Lf:x:y` (1-based floor) on
a multi-floor one — no words, no parens; never a raw `NodeId`/entity id. A point that sits on a
split tile's non-original node also gets the debug tree's own `" (N{n})"` parenthetical suffix
(GitHub issue #546 fourth follow-up, `splitNodeLabelShort` — shared with the debug event tree and
"Manage split nodes"' link bubbles, same `1` = original / `slotId + 2` = extra-slot numbering): a
`node`-kind endpoint resolving to a `NodeDto` with `i > 0` (`endpointBubble`), or a `split`-kind
endpoint (naming its own `slotId` directly, no `nodeById` lookup needed since it isn't resolved to a
real node yet), or a command that addresses one specific slot by its own `slotId`
(`addSplitNode`/`removeSplitNode`/`updateSplitNodeFaces`, `splitSlotBubble`) all show it; a command
that instead rotates/rebuilds the WHOLE split tile at once (`rotateSplitPoint`/`applySplitBlueprint`,
`splitPointBubble`) never does, since naming one slot would misrepresent what the command changed.

The suffix is only ever as good as the `PostEditEndpoint`/`NodeId` a command actually carries for
each of its points, so it depends on every action correctly resolving a split point's clicked slot
in the first place, not silently defaulting to the original node — GitHub issue #546 fifth follow-up
fixed two placement paths that did exactly that: `confirmPostEditElevatorPlacement` (each selected
floor) and `commitPostEditVerticalPassage` (the destination end of a fresh one-click placement) both
used to resolve their point by plain `(x, y, level)` coordinate lookup, which always returns a
split point's ORIGINAL node (index 0, snapshot order) — only a placement's own FIRST/origin point
ever went through `PostEditSplitTargetDialog` (the "which node?" picker for an ambiguous click,
GitHub issue #474), so every other point of that same placement ignored whatever slot the user had
actually picked there. Both now read `postEditActiveSplitNode` (`resolveActiveNodeIdAt`,
`postEditSliceHelpers.ts`) — the same per-point "last picked slot" map
`PostEditController.resolveActiveEndpointAt` already uses for edge-tool clicks — falling back to the
original node only when nothing's been picked at that point yet. `setMeta` (start/finish) was never
affected — it addresses exactly one point, always through the split-target picker directly, with no
second endpoint to default incorrectly.

GitHub issue #546 seventh follow-up fixed a third, UI-layer occurrence of the same anti-pattern:
`PostEditController`'s `onPointerMove` vertical-passage-drag branch called `resolveActiveEndpointAt`
with a bare `{}` in place of `state.postEditActiveSplitNode`, so dragging a passage endpoint onto a
split point always resolved to that point's original node regardless of which slot was actually
active there, both for the live drag-override preview and the endpoint the eventual
`moveVerticalPassageEndpoint` command carries. The marker-drag and teleport-drag branches right above
it already passed the real map; the vertical-passage-drag branch now does too.

GitHub issue #546 eighth follow-up fixed the suffix's OWN gating condition, a second and unrelated
bug that survived every fix above: `endpointBubble` decided whether to show a suffix from
`NodeDto.i > 0` — "is this a non-original node" — instead of "is this point a split tile at all".
A split tile's ORIGINAL node (`i === 0`) is just as much one of that tile's nodes as any extra slot;
there is no such thing as "the first node of a split point isn't split", yet `i > 0` silently
excluded it from every bubble, which is why the suffix only ever seemed to appear for a passage's
non-origin endpoint (whichever end happened to resolve to a non-zero `i`) and never for start/finish,
an elevator's own placement point, or a one-way vertical passage's origin — every one of those
addresses a point through its ORIGINAL node far more often than not. The same follow-up also made the
suffix ITSELF match `ManageSplitNodesDialog`'s own link bubbles exactly, including their semantic
short names (e.g. "Кор"/"Мост" for a recognized "bridge" topology, `splitNodeNames.ts`) instead of
always falling back to the bare numeric `N{n}` — previously the two panels disagreed on how the same
split node reads. Both fixes live in a new shared module, `postEditSplitLabels.ts`:
`resolveSplitNodeShortLabel(ctx, point, level, endpoint)` — `ctx: SplitLabelContext | null` bundles
every primitive the resolution needs (`allNodes`, `splitPoints`, `activeSplitNode`, `draftEdges`,
`cfg`, and a per-floor `inFieldCellsAt`), mirroring `ManageSplitNodesDialog`'s own `facesOf`/
`describeEndpoint`/`semanticNames` almost verbatim (deliberately duplicated rather than importing the
dialog's component-local closures, since those close over React state this pure module has no
business depending on). Returns `undefined` — no suffix at all — when `ctx` is `null` (a caller with
no field/edges context to resolve against, e.g. some direct test calls) or when `point`/`level` has
no entry in `splitPoints` (genuinely not a split tile); otherwise the recognized topology's semantic
short name, falling back to `splitNodeLabelShort` when the topology isn't a named one. Every bubble
builder in `postEditCommandLabels.ts` (`endpointBubble`, `splitSlotBubble`) now takes a
`splitCtx: SplitLabelContext | null` parameter (threaded from `postEditCommandLabel`'s own new,
defaulted-to-`null` parameter) instead of computing the suffix from `NodeDto.i`/a bare `slotId`
directly. `PostEditChangesPanel.tsx` builds the real context once per render from the store's own
`nodes`/`postEditDraftSplitPoints`/`postEditActiveSplitNode`/`postEditDraftEdges`/
`activeTessellationConfig`/`floorFields`, with `inFieldCellsAt` computing (and caching) each floor's
in-field cell set from `buildActiveCells`/`buildCellSet` lazily per level, since a single row's
bubbles can span several floors (an elevator/vertical passage) each potentially needing a different
floor's own field shape.

GitHub issue #546 ninth follow-up fixed a regression the eighth follow-up itself introduced:
`resolveSplitNodeShortLabel` built its `"x,y"`/`"x,y@level"` lookup key straight from whatever
`level` its caller passed, but `endpointBubble`'s caller (`resolveEndpointToHoverPoint`) reads that
level off `NodeDto.level` verbatim — which is a real `0` for floor 0 straight off the wasm snapshot
(`maze-wasm/src/dto.rs`'s `pub level: u32`, never `Option`), not `undefined`. `postEditDraftSplitPoints`
itself always keys floor 0 bare (`"x,y"`, no `"@0"` — `buildMultiFloorPostEditDraft`'s own
`levelKey = level === 0 ? undefined : level`), so an un-normalized `"x,y@0"` lookup missed every
floor-0 split point's entry entirely, which silently deleted the suffix from almost every point on a
single-floor maze — the exact "suffixes disappeared everywhere, even where they used to work"
regression. Fixed by normalizing `rawLevel === 0 ? undefined : rawLevel` at the top of
`resolveSplitNodeShortLabel` itself, mirroring the same normalization every other point-keyed lookup
in post-edit already does at its own call site (`postEditSliceHelpers.ts`'s `levelKey`,
`postEditSlice.ts`'s `resolveActiveNodeIdAt` call, `presetConnectionsSlice.ts`'s `presetEndpoint`
construction) — centralized here since `resolveSplitNodeShortLabel` is the one place actually
building this specific key from a raw `NodeDto.level`.

GitHub issue #550 ninth follow-up fixed the origin-side counterpart of the same bug: unlike teleport
placement (both ends always set by an explicit click through the split-target picker), vertical-
passage/elevator placement used a hard `origin.kind !== "node"` guard in
`startPostEditVerticalPassagePlacement`/`startPostEditElevatorPlacement`/`commitPostEditVerticalPassage`
— any placement STARTED from a split point's numbered slot was silently dropped rather than resolving
the slot correctly, so these two entity kinds only ever placed onto a split tile's original node,
never a chosen slot (teleport was unaffected — it never had this guard). `findPostEditVerticalPassageForPair`
was extended the same way, from a node-only `(passages, aId: number, bId: number)` lookup to
`(passages, a: PostEditEndpoint, b: PostEditEndpoint)` matched via `endpointsEqual`, since the
confirmed-snapshot extraction path (`extractPostEditVerticalPassages`/`extractPostEditElevators`)
already produced split endpoints for these kinds — the interactive placement code was the only piece
still assuming node-only addressing. Fixing this also surfaced a standalone, unrelated pre-existing
bug in `resolverForNodeId` (`postEditEndpoint.ts`): its point-key lookup did `key.split(",")`
directly, but a key for any floor above 0 carries an `"@level"` suffix
(`buildMultiFloorPointNodeMap`'s own convention, e.g. `"0,0@1"`), so `Number("0@1")` silently produced
`NaN` for one coordinate on every floor above the first — fixed by stripping the suffix before
parsing.

GitHub issue #550 tenth follow-up deduplicated the "resolve a raw `NodeId` back to a `PostEditEndpoint`,
re-stamping the correct `level`" sequence that the ninth follow-up above (and the delete-tool work
earlier in the same issue) had left duplicated near-verbatim across four call sites:
`applyPostEditSplitTargetPick`, `commitPostEditVerticalPassage` (`postEditSlice.ts`/
`postEditSliceHelpers.ts`), `confirmPostEditElevatorPlacement`, and `PostEditController.tryTeleportClick`.
Each built its own `buildMultiFloorPointNodeMap` + `resolverForNodeId` + "look up the id's own
`level`, re-inject it onto the resolved split endpoint" chain independently — `resolveNodeIdToEndpoint(nodes,
splitPoints, id)` (`postEditSliceHelpers.ts`) is that chain, once; all four call sites now call it
directly. Also collapsed a matching duplication one layer up: `PostEditEntityDeleteDialog` used to
rebuild the exact same `nodesHere`/`nodeLevel`/`nodeById`/`inFieldCellsAt`/`splitCtx` scaffolding
`buildPostEditPointEntitiesAt` already assembles for `requestPostEditEntityDelete`/
`removePostEditPointEntity`, just wired through its own `useMazeStore` selector hooks instead of a
plain `MazeStore` — `buildPostEditPointEntitiesAt` now takes a narrowed `PostEditPointEntitiesSourceState`
(a `Pick<MazeStore, ...>` of just the fields it reads) so the dialog can assemble that shape from its
own selectors and call the shared function directly, instead of re-deriving the same rows by hand.

`highlight` is a
`PostEditHoveredEntity` (always `point`-kind — GitHub issue #546 second follow-up dropped the earlier
combined `points`-kind bubble an elevator/vertical passage used to render, see below; `null` for a
bubble naming an entity nothing's left in the log to resolve a point from); hovering a bubble passes
its `highlight` straight through to `postEditHoveredEntity`.

Deletion bubbles and their row targets carry `danger: true`, so deletion previews for start/finish,
teleports, vertical passages, elevators, and split entities use the destructive red canvas color —
the marker applies to the bubble itself as well as the row hover. Split-related command bubbles and
row targets (`addSplitNode`, `removeSplitNode`, `removeSplitPoint`, `rotateSplitPoint`,
`applySplitBlueprint`, and `updateSplitNodeFaces`) also carry `highlightMode: "outset"`, matching the
expanded-cell split highlight used elsewhere in post-edit. Ordinary point/entity highlights keep the
default inward/inset mode.

**Elevator/vertical-passage bubbles are now one bubble per floor**, not a single combined bubble
(GitHub issue #546 second follow-up reversed the original #546 follow-up's design) — an elevator's
`addElevator`/`updateElevatorFloors` command renders `L1:x:y`, `L2:x:y`, `L3:x:y`, ... (one bubble per
`floors` entry, via `elevatorBubbles`); a vertical passage's `addVerticalPassage` renders its `from`/
`to` as two separate per-floor bubbles (`verticalPassageBubbles`), same fixed order every other
edge-shaped bubble pair already has (`from`/`to`'s own display order never changes with `direction` —
only `arrow`, below, does). Hovering ONE such bubble highlights only that one floor's own point —
never every floor the entity touches at once, which is what the single combined bubble used to do
(and which read as "highlighted on every floor" once GitHub issue #546's first follow-up fixed the
underlying floor-scoping bug but before this design change removed the combined bubble that was
still drawing every floor's point together).

`showArrow` draws a plain text arrow glyph between exactly two bubbles — purely cosmetic, independent
of `rowHighlight` below; `true` for an edge/teleport/vertical-passage row (they always resolve to
exactly two bubbles), always `false` for an elevator regardless of its own floor count (GitHub issue
#546 third follow-up: an elevator's `floors` is an unordered set of stops, not a directed pair, so it
never has a single "from -> to" direction of its own to show an arrow for — not even when it happens
to span exactly two floors). `arrow` is `"<->"` for a wall/passage face (undirected — the same kind
applies in both directions) or a two-way teleport/vertical passage, `"->"`/`"<-"` for a one-way one
(telling which of the two FIXED bubble positions traffic flows FROM and TO) — same convention
`SplitNodesDialogView`'s own link arrows use, computed by `teleportArrow`/`verticalPassageArrow` (both
map `"forward"`/`"backward"`/`"two_way"` to `"->"`/`"<-"`/`"<->"` — GitHub issue #546 third follow-up
fixed a bug where every non-`"two_way"` direction fell back to `"->"`, so a teleport/vertical passage
whose direction was flipped to `"backward"` via `setTeleportDirection`/`setVerticalPassageDirection`/
`moveTeleportEndpoint`/`moveVerticalPassageEndpoint` never showed the flipped glyph).

`setVerticalPassageDirection` is the one direction-bearing command whose own `command.direction` is
the entry's direction BEFORE the click, not after — `cyclePostEditVerticalPassageDirection`
(`postEditSlice.ts`) logs the *live* entry's current (pre-toggle) direction, and the replay reducer
(`postEditReplay.ts`) ignores `command.direction` entirely, always flipping whatever the entry's
direction already is at replay time (contrast `setTeleportDirection`, whose own `command.direction`
IS the target/post-click value the replay reducer compares against). Feeding that stale pre-click
value straight into `verticalPassageArrow` (GitHub issue #546 fourth follow-up) showed the arrow one
click behind reality — a `forward -> backward` flip displayed the pre-click `"forward"` arrow, and
the row after it (another flip, or `moveVerticalPassageEndpoint`/`removeVerticalPassage`, each
denormalizing their own `direction`, GitHub issue #564 follow-up) then showed what THIS row should
have. `flippedVerticalPassageArrow` fixes this — same `"forward"`<->`"backward"` toggle
`cyclePostEditVerticalPassageDirection` itself applies, reconstructing the actual post-click
direction from the logged pre-click one before mapping it to a glyph — and is used ONLY for
`setVerticalPassageDirection`'s own row; every other vertical-passage/teleport case carries a
genuinely-current `direction` on the command itself and stays on `verticalPassageArrow`/
`teleportArrow` unchanged. `bubbles`' own order never changes with direction (GitHub issue #546
follow-up: flipping a one-way face's/passage's direction used to swap which bubble showed first,
reading as "the points swapped places" instead of "the arrow flipped" — `setEdgePair`'s bubble pair
is always `a, b`, never reordered by `aToB`) — only the glyph does.

`rowHighlight` is what hovering the row's own action text (not one of its bubbles) sets
`postEditHoveredEntity` to (GitHub issue #546 second follow-up moved the row-hover target off the
bubble row itself, since bubbles no longer merge into one "bubble `<arrow>` bubble" span the way the
old combined-bubble/`isLink` design did) — `null` for a row with no natural whole-row target (a
single-bubble point/split-structure row, whose one bubble already covers it). For a same-floor
edge/wall/passage row (`setEdge`/`setEdgePair`, `linkRowHighlight`), it's the
`link`-kind entity connecting both bubbles' points — the connecting line itself reads naturally as
"this row", since that's exactly the straight face/passage segment drawn on the canvas. A teleport row
(GitHub issue #546 third follow-up) uses `pointsRowHighlight` instead, even when both its endpoints
share one floor — `TeleportRenderer`'s own connector is routed (possibly non-straight, grouped,
gap-avoiding) rather than a plain cell-to-cell line, so a straight-line `link` highlight drawn over it
reads as a second, wrong connector; highlighting just the two endpoint points avoids implying a
connector shape the row-hover code doesn't actually know how to draw. A vertical passage/elevator row
(also `pointsRowHighlight`) gathers every bubble's own resolved point into one `points`-kind entity —
deliberately never a `link` (same reasoning `linkRowHighlight`'s restriction to same-floor edges
already has: a straight line needs both ends on one floor, which these entities' own points never
share); `buildHoveredEntityHighlight`'s `activeLevel` gate (below) then collapses this to just the
point(s) actually on the floor being viewed, so the row reads as "highlight whichever of my points is
visible right now" rather than lighting up every floor at once.

Clicking a bubble (GitHub issue #546 second follow-up) calls `navigateToFloor` with that bubble's own
resolved point's `level` (`?? 0`) — no separate `FloorBadgeRow` under the row any more (removed along
with the old `postEditCommandFloors` helper): every bubble already names one specific floor's own
point, so it doubles as that floor's own jump target, the same way the graph overlays' cross-floor
badges (`attachFloorBadgeNavigation`) double as their own navigation target.

`PostEditRenderer.redrawHoveredEntity` matches `state.postEditHoveredEntity` against the *unscoped*
`state.nodes`, not `floorScoped(state).nodes` — a cross-floor entity (a vertical passage/elevator/
teleport whose points sit on different floors) needs every floor's nodes as match candidates, or its
off-floor endpoint could never resolve at all. This is safe against the floor-collision bug it
replaced (GitHub issue #546 follow-up: a floor-1 point/link kept drawing on floor 0 whenever the
coordinates happened to coincide) because `buildHoveredEntityHighlight`'s point-matching
(`pixi/selectors/mazeSelectors/postEdit.ts`, `pointMatchesNode`) checks each `PostEditHoverPoint`'s
own `level` against the candidate node's `level` explicitly — widening the candidate list to every
floor never lets a point match a same-`(x, y)` node on the wrong floor.

`buildHoveredEntityHighlight`/`buildLinkHoverHighlight`/`resolvePointGroup` take an explicit
`activeLevel` (the active floor's own 0-based index, `activeFloorLevel(state) ?? 0`) and gate every
match against it — matching against the unscoped node list finds a candidate on EVERY floor an
entity touches (a vertical passage's/elevator's `from`/`to`/`floors` all share one `(x, y)`,
differing only in level, so `nodes.find` succeeds regardless of which floor is active), and without
this gate every one of those floors' matched nodes would render its highlight at once, on top of
each other, no matter which floor is actually being viewed. With the gate, only the match(es) whose
own `level` equals `activeLevel` are ever fed to `RegionHighlightRenderer`/`NodeEdgeHighlightRenderer`
— an entity never highlights a floor it doesn't actually have a marker on ("не подсвечиваем пустое
место"). For a cross-floor `link` specifically, a straight line needs both ends on the same active
floor to draw at all — `buildLinkHoverHighlight` instead falls back to a single-cell region highlight
(`soloPoints`) for whichever ONE endpoint's own `level` equals `activeLevel`, so switching floors
shows a different single-cell highlight on each of the entity's own floors, never both/neither.

A label choice worth calling out: edge-state labels are derived directly from each command's
resulting face state. There is no direction-change flag or one-way identity to preserve.

#### Entity id filter (GitHub issue #574)

A text input at the top of the panel (sticky within the scrollable log, so it never scrolls out of
view with the rows) narrows `postEditCommands` down to the rows belonging to one entity id, with a
clear (×) button inside the field, on its right edge, that resets back to the full log. `entityIdOf
(command)` (`pixi/postEditCommandLabels.ts`) returns the id a command is associated with — the same
id exposed as `PostEditCommandLabel.entityId` and rendered as the row's own id bubble (`"o5"`, `"t3"`,
... — not a lifeline key: `lifelineKeysOf` in `postEditSliceHelpers.ts` serves point-reset pruning, a
different and broader
purpose that also covers wall/basic edges and start/finish via synthetic keys never shown to the
user) — or `undefined` for a command kind with no id of its own (`setEdge`/`setEdgePair` on a
wall/basic face, `setMeta`, `rotateSplitPoint`). The filter matches a command's `entityIdOf` result
exactly, never a text search over the row's rendered label; a command with no id never matches any
filter value and is hidden whenever a filter is active. A `setEdgePair`'s one-way side (resolved by
both `entityIdOf` and `postEditCommandLabel`'s own `setEdgePair` case) is picked by the shared
`oneWaySideOf(aToB, bToA)` helper, not two independent copies of the same "whichever side is
one-way" check, so the filter and the row's own displayed id can never disagree.

State lives in `postEditChangesEntityFilter: string | null` (`null` = no filter, the default) and
`setPostEditChangesEntityFilter` (`postEditFullTypes.ts`/`postEditSlice.ts`) — ephemeral UI state, not
persisted, reset to `null` on `generate()`/`resetPostEdit()`/the whole-app `reset()` so a stale filter
never silently hides an unrelated new log. This is the filtering mechanism GitHub issue #573's id
bubble click-to-filter action depends on — the click handler just calls
`setPostEditChangesEntityFilter(id)` with the clicked bubble's own entity id.

#### Entity id bubble (GitHub issue #573)

A row that names a stable entity (any row `entityIdOf` resolves an id for) shows that id as its own
bubble, `id: {id}`, pinned to the row's own top-right corner (`position: absolute` against the row's
`position: relative`, `action`'s own `paddingRight` reserving room so wrapped/long action text never
runs under it) rather than flowing inline with the action text or baked into the action string as
`"Action (#id)"` (`withId`, now removed) — `PostEditCommandLabel.entityId: string | undefined`,
stamped onto every branch's label by `postEditCommandLabel`'s own `withEntityId` wrapper so no
per-kind branch has to thread it through its own action-string construction; `undefined` for the same
command kinds `entityIdOf` returns `undefined` for. Styled distinctly from the point/coordinate
bubbles (green `ui.bg.success`/`ui.text.success`, vs. the point bubbles' cyan
`ui.debug.refHighlight`) so the two kinds of chip read as different things at a glance.

Hovering the id bubble highlights every OTHER row in the log sharing that same entity id — tracked as
`hoveredEntityId`, state local to `PostEditChangesPanel` (not the store): this is a within-panel
list highlight, unrelated to `postEditHoveredEntity`'s canvas highlight that point/row hovers already
drive. A highlighted row gets a plain background tint (`ui.bg.hover`, the same generic hover fill
other panels use), independent of and stacked orthogonally to the row's own `rowHighlight`/bubble
canvas-highlight behavior. The bubble's own `title` tooltip (`post_edit.changes_id_bubble_title`) is a
dedicated i18n key describing this hover/click behavior, distinct from the filter input's own
`changes_filter_placeholder`. Clicking the id bubble calls `setPostEditChangesEntityFilter(entityId)`
directly — the minimal ad-hoc use of the #574 filter the issue described, rather than waiting on a
separate generic event-filter ticket.

### Dirty semantics

| Operation | `postEditDirty` |
|---|---|
| append (any user edit) | `true` |
| `resetPostEditPoint` | `true` (log changed, confirm still needed) |
| `resetPostEdit` (whole graph) | `false` |
| load from project file | restored from `file.dirtyFlags.postEdit` |
| `generate()` / new generation | `false` (fresh baseline, empty log) |

### Persistence

`ProjectFilePostEdit`:
```typescript
{
  commands: PostEditCommand[];
  nextTeleportId: number;
  nextSplitPointId: number;
  nextVerticalPassageId: number;
  nextElevatorId: number;
  nextSplitSlotId: Record<string, number>;
}
```
The current schema has no one-way counter. Legacy project files containing one are invalid; there
is no migration path.

High-water marks are persisted **separately** from the log, not read directly off `max(id in
log)+1` — a point-reset can prune high-id commands out of the log while entities elsewhere in the
file (or in an export) may still reference those ids, so a saved mark must never regress on its own.
That said, a saved mark is trusted only as a **floor**, not verbatim (GitHub issue #564 second
follow-up): on load, `mazeStore.ts` recomputes each category's own minimum-safe next id from the
just-replayed baseline+log state itself via `nextPostEditIdCounters(derived)` — a baseline can carry
ids past whatever a stale/hand-edited file's counter says (the counter is a separate, independently
stored value, never cross-checked by replay) — and takes `Math.max(fileValue, recomputed)` per
category. `_nextSplitSlotId` (a per-point `Record`, not a single counter, GitHub issue #569) gets
the same floor treatment per point: `nextSplitSlotIdCounters(derived.splitPoints)`
(`postEditSliceHelpers.ts`) recomputes each split point's own minimum-safe next slot id from the
just-replayed state, and the file's own per-key value (if any) is raised to at least that floor —
a saved file predating this normalization (or one whose point was never opened in the split-node
dialog before saving) can carry an empty or incomplete map for a point the baseline itself already
gave slots, which would otherwise let a fresh `addSplitNode` mint an id that collides with one the
baseline already occupies.

Load is **fail-closed**: `mazeStore.ts` calls `replayPostEditCommandsFailClosed` against the
freshly-rebuilt baseline (generation is re-run deterministically from the persisted seed/config
before the post-edit section loads, so the baseline the log was recorded against is reproduced
exactly). If any command fails to resolve, the entire `postEdit` section — log **and** its
high-water marks — is discarded, and the maze loads in a clean post-generation state (as if
`file.postEdit` were `null`). No partial/corrupted post-edit state is ever surfaced; the marks
never partially apply independent of the log they'd otherwise seed.

### PostEditEndpoint (GitHub issue #221)

```typescript
type PostEditEndpoint =
  | { kind: "node"; id: number }
  | { kind: "split"; point: [number, number]; slotId: number };
```

A tile's point can resolve to more than one graph node ("split point", see `Specs/space.md`/epic #218). `node` is a plain already-resolved `NodeId`; `split` addresses one of a split point's extra nodes by its stable per-point `slotId`, since the JS side never predicts a not-yet-confirmed split node's real `NodeId`.

**Why not a raw `NodeId`:** as of GitHub issue #236, `compute_analytics` rebuilds `Field`/`Graph` directly from the client's own authoritative `state.nodes` list (`Field::from_id_points`) instead of re-minting every id from `tessellation.points` order — so a node's `NodeId` **is** stable across confirms once it exists in that list, including a confirmed split node. What is still not stable is a *not-yet-confirmed* split node: it has no real `NodeId` at all until `apply_split_points` mints one on its first confirm (matched to its slot by its real `NodeDto.i`, never by position — see `apply_split_points` in `maze-wasm/src/analytics.rs` and `NodeDto.i`'s doc comment in `maze-wasm/src/dto.rs`), so the window between `addSplitNode` and that first successful confirm has nothing to reference yet. `PostEditEndpoint`'s `split` variant exists for that window, not because ids are unstable afterward — every place that needs to survive a confirm (`PostEditEdge`/`PostEditTeleportEntry`'s `from`/`to`, `PostEditMeta`'s `start`/`finish`) still stores a `PostEditEndpoint`, resolved to a real id fresh on each use, since nothing upstream can tell in advance whether a given node has been confirmed yet.

Provided by `pixi/postEditEndpoint.ts`: `nodeEndpoint`/`splitEndpoint` (constructors), `endpointsEqual` (structural equality, used regardless of confirm state), `endpointKey`/`edgeKey` (stable string keys — `"n42"` for a node, `"s3,5:7"` for a split, disjoint prefixes), `endpointIsNode`, `resolveEndpoint` (resolves to a real id via a caller-supplied `resolveSplit` lookup, `undefined` if not resolvable yet), `buildSplitNodeResolver` (builds that lookup from a confirmed node snapshot grouped by point, plus `postEditDraftSplitPoints`).

**Unresolved-endpoint contract:** a `split` endpoint doesn't resolve in the window between `addSplitNode` (which writes the slotId to the draft immediately) and the first successful `confirmPostEdit` after that. Canvas/renderer code (`postEditEdgesToDto`/`postEditTeleportsToDto`) silently drops any entry with an unresolved endpoint — nothing to draw yet, same as an ordinary id with no `nodeById` match. `confirmPostEdit`'s WASM call never needs to resolve edges/teleports' `split` endpoints on the JS side at all — `split_points` is sent alongside them in the same call, so WASM always resolves them itself, after creating the node. `start`/`finish` are the one place resolution happens client-side (see below).

### PostEditEdge

```typescript
// Discriminated union: one-way is a face state and carries no identity. Same shape as
// PostEditEdgeState (see the PostEditCommand block above); PostEditEdge is the derived-state
// Record entry, PostEditEdgeState is a command's own resulting-state payload.
type PostEditEdge =
  | { kind: "wall" | "basic"; from: PostEditEndpoint; to: PostEditEndpoint }
  | { kind: "one_way_forward" | "one_way_backward"; from: PostEditEndpoint; to: PostEditEndpoint };
```

`wall` is never stored as an explicit record — `applyPostEditCommand`'s `setEdge`/`setEdgePair` cases always `delete` the record when the resulting kind is `"wall"`, so "no record for this directed edge" and "explicit wall" are the same state on the wire; any reader comparing a face's current kind must fall back to `"wall"` when the lookup misses (`currentEdges[key]?.kind ?? "wall"`), not treat a miss as "unknown"/"unedited". `one_way_forward` and `one_way_backward` always store correct directed fields: `from→to` is the actual passage direction, plus the one-way's own stable `id` (type-prefixed string, `"o5"`) — minted fresh when a face first turns one-way, reused across a plain direction flip on the same face (same entity), and never reused once the face reverts to wall/basic (that lifeline ends; a later re-creation on the same face mints a new id). There is no `"teleport"` kind here — teleport edges never enter `postEditDraftEdges`/`postEditEdges` at all (see `postEditDraftTeleports` above). Keyed in its `Record` by `edgeKey(from, to)`, not a hand-built `${from}-${to}` template literal — spatial addressing (what stands on this face right now), not identity; identity is `` `oneWay:${id}` `` (see the lifeline section above).

### PostEditTeleportEntry

```typescript
type PostEditTeleportDirection = "forward" | "backward" | "two_way";

interface PostEditTeleportEntry {
  id: string;
  from: PostEditEndpoint;
  to: PostEditEndpoint;
  direction: PostEditTeleportDirection;
}
```

Edits teleport links by node/split endpoint (unlike `PresetTeleportEntry`, which edits by cell coordinate on the pre-generation field). `id` is a type-prefixed string (`"t3"`, GitHub issue #564 — `formatPostEditId`/`parsePostEditIdNumber`, `pixi/postEditIdFormat.ts`) assigned from `_nextPostEditTeleportId`, monotonically increasing, never reused within a session. `from`/`to` are the two click points in placement order; for `"backward"`, the actual passage direction runs `to→from` (mirrors `PresetConnectionState::TeleportBackward`). `"two_way"` expands to both directions. Converted to `EdgeDto[]` via `postEditTeleportsToDto`.

`PostEditVerticalPassageEntry`/`PostEditElevatorEntry` (`postEditTypes.ts`) follow the identical
shape/id convention — `id: string` (`"v2"`/`"e7"`), assigned from `_nextPostEditVerticalPassageId`/
`_nextPostEditElevatorId`. Since GitHub issue #564, both are full baseline draft entries from the
moment `generate()` builds the baseline — `extractPostEditVerticalPassages`/`extractPostEditElevators`
(`pixi/postEditVerticalUtils.ts`) extract every generation-time vertical passage/elevator into
id-less entities plus their own canonical key (elevator: sorted joined endpoint keys of its
connected component, mirroring `elevatorComponent`'s existing node-partitioning logic used elsewhere
for image-export marker numbering), and `assignSequentialIds` (`pixi/postEditUtils.ts`, shared with
the one-way/split-point categories) numbers each category by sorting its own canonical keys — never
by input array/iteration order, so the same generation snapshot always produces the same
`canonicalKey → id` mapping regardless of `edges`/`nodes` order. There is no longer a separate
"generation-mesh vs draft" distinction: editing or removing a generation-baked entity is an ordinary
edit of an existing draft entry, like any other.

### PostEditMeta

```typescript
interface PostEditMeta {
  start: PostEditEndpoint | null;
  finish: PostEditEndpoint | null;
}
```

Separate from `state.start/finish` so Generation renderer always shows the originally generated endpoints. `start`/`finish` are `PostEditEndpoint`, not a bare `number` (revised for GitHub issue #221 — see the `PostEditEndpoint` section above for why). On the WASM boundary, `ComputeAnalyticsConfig.start`/`.finish` stay a plain `number | null` (`Maze::meta.start`/`.finish` in `maze-core` are always `Option<NodeId>`, unrelated to the endpoint concept) — `confirmPostEdit` resolves `postEditDraftMeta.start`/`.finish` to a plain id (or `null` if unresolved) client-side before building the WASM request, using the same `resolveEndpoint`/node-map lookup the controller uses for clicks.

## Split Points (GitHub issue #221)

Lets the user manually add extra nodes to a tile's point and wire up edges to them explicitly — e.g. two independent passages (N↔S and E↔W) through what the generator produced as a single 4-way junction. There is no "routing group" concept: the feature only lets the user create additional nodes at a point and connect edges to them like any other manual edge edit; which of a point's nodes ends up connected to what is entirely up to the user, one edge at a time.

The slot-list bookkeeping below (minting/removing/cycling/setting the active slot of a point) is not post-edit-exclusive: it lives in the tessellation-agnostic `pixi/splitPointsCore.ts` module, generic over the endpoint type, and is shared verbatim with the Preset Connections feature's own split-node management (GitHub issue #231 — see `Specs/preset-connections.md`'s "Split nodes" section). `splitPointsCore.ts` only knows about slot existence and the active-slot map; cleaning up references to a removed slot in edges/teleports/presets/locks is the caller's responsibility, done as a separate step right after calling into the shared core (`removeSplitNode` below, and presets' `removePresetSplitNode`).

- **`postEditDraftSplitPoints`** stores the list of slotIds per point (not a count, not a positional index — see the `PostEditEndpoint` section for why a positional scheme doesn't work). Each slotId is unique only **within its own point** — `PostEditEndpoint`'s `split` variant already addresses point+slotId together, so no global counter is needed. `addSplitNode` mints the next slotId as `max(existing slotIds for this point) + 1` (or `0` if the point has none yet).
- **The point's original node can never be removed** — only slotIds added via `addSplitNode` can be.
- **Deleting a split node** (`removeSplitNode(point, slotId)`) first checks (via `endpointsEqual`, not a resolved id — works the same whether or not the node has been confirmed yet) whether `postEditDraftMeta.start`/`.finish` structurally equals the target; if so the removal is rejected outright with an error, no silent reassignment. Otherwise it removes every `postEditDraftEdges`/`postEditDraftTeleports` entry referencing that endpoint (`endpointsEqual`, a plain filter — no reindexing of any sibling slot), removes the slotId from the list, and resets `postEditActiveSplitNode` for that point if the removed slot was the active one.
- **`cycleActiveSplitNode(point)`** cycles `postEditActiveSplitNode[key]` through original → slot 0 → slot 1 → … → back to original (no entry). No-op for a point with no split nodes.
- **`setActiveSplitNode(point, endpoint)`** sets it directly (used by the dialog's per-row "Set active" button); a `node`-kind endpoint clears the entry (meaning the original node).
- **A just-created slot becomes the active one.** `addSplitNode` activates the slot it just minted, and `applySplitBlueprint` activates its first slot (reused or freshly minted) — both so an edge-tool click immediately following node creation targets the new slot rather than falling back to the original node (GitHub issue #545). Without this, a face click right after applying a blueprint would resolve through `PostEditController`'s `resolveActiveEndpointAt` fallback to the plain original-node endpoint (no active entry to prefer), missing `applyPostEditToolAt`'s split-face branch entirely and logging a bare `setEdgePair` ("Set wall"/"Set passage") instead of one `updateSplitNodeFaces` entry for the slot. If the blueprint needs no slots at all, the point's stale active-slot entry (if any) is cleared instead of left pointing at a slot id this same apply may have just dropped.
- **Applying a blueprint on top of an already-split point reuses the point's existing slot ids** for as many of the new blueprint's own nodes as it needs (`existingSlots.slice(0, slotsNeeded)`), only minting fresh ones (from the high-water mark) for any excess the new blueprint requires beyond what already exists (GitHub issue #545). Any existing slot beyond what the new blueprint needs is dropped from the point entirely (not left behind as an empty, all-wall node) — guarded by the same start/finish check as a fresh apply. Minting a brand-new id for every blueprint node regardless of what already existed left a reused-looking node's OLD wiring stranded on an orphaned slot while the blueprint's own face list landed on a separate fresh id — the point then rendered as a plain passage off the original node alone, silently discarding every other node's connections. The high-water mark (`_nextSplitSlotId`) only advances by the count of genuinely fresh ids minted, never by the reused ones.

### WASM boundary

**`ComputeAnalyticsConfig.nodes: Vec<NodeDto>`** (GitHub issue #236) is the client's authoritative node list — real ids from the previous generation/confirm, not just coordinates. `run_compute_analytics` (`maze-wasm/src/analytics/mod.rs`) builds one `Field` per level (via `build_field_from_nodes`, GitHub issue #359 — `ComputeAnalyticsConfig` carries its own `level_fields: Vec<Vec<[i32; 2]>>`, mirroring `GenerateConfig`'s) from these via `Field::from_id_points`, each level populated only from `cfg.nodes` entries whose own `NodeDto.level` matches, grouping entries by point in the order given (a point's first entry is its original node, subsequent entries its existing extra slots, in creation order — same contract `nodes_at()` already documents). This is what makes every node's `NodeId`, including a confirmed split node's, stable across confirms: nothing is re-minted from `tessellation.points` order anymore. See `Specs/floors.md`'s "`compute_analytics` multi-level awareness" section.

`ComputeAnalyticsConfig.split_points: [[number, number], number, number][]` — a flat list of `(point, slotId, level)` triples, built by `confirmPostEdit` from all of `postEditDraftSplitPoints`'s entries (order doesn't matter — see below; `level` is parsed from the entry's own `"x,y"`/`"x,y@level"` key). `NodeDto.i` (see its doc comment in `maze-wasm/src/dto.rs`) is a node's stable per-point index: `0` for the point's original node, `1, 2, ...` for each extra slot in creation order, and — critically — never renumbered when an earlier-created sibling at the same point is removed, so a hole in the `i` sequence is expected and permanent. `slot_id` maps onto `i` as `slot_id + 1`. `apply_split_points` (in `maze-wasm/src/analytics/post_edit.rs`) builds an `existing_by_index: (point, i, level) -> NodeId` map directly from `cfg.nodes` and looks up `(point, slot_id + 1, level)` in it for each declared slot — an exact-match lookup, not a position/count-based reconstruction. Only a `(point, slot_id, level)` with no matching entry (a new `addSplitNode` not yet confirmed) gets freshly minted via `Maze::add_node_at_on_level`. Runs before edges are resolved — some edges may reference a split node. Returns a `(point, slotId, level) -> NodeId` map used to resolve `PostEditEndpointDto::Split` (which itself carries its own `level`, `#[serde(default)]` defaulting to `0`) in `PostEditEdgeDto.from`/`.to`.

**Why not position-based matching:** an earlier version of this fix matched `split_points` entries to `nodes`' per-point extra-node list by array position (`slot_id + 1`'s position among survivors). This breaks the moment a *non-last* split node is removed: `state.nodes` after a confirm following `removeSplitNode` no longer contains the removed node at all, so the *remaining* slots' positions compact down — a surviving later slot silently resolves to a different (or the wrong) node instead of its own. Matching by the real `i` instead of position is immune to this, since `i` never shifts regardless of what else was removed.

**`ComputeAnalyticsConfig.nodes` must be pruned client-side before it's sent** — `apply_split_points`/`run_compute_analytics` never remove a node on their own; every entry in `cfg.nodes` is rebuilt into the graph unconditionally by design (this is exactly what makes a node's `NodeId` stable — see above). When a split slot is removed (`removeSplitNode`, or the cell branch of the unified Reset tool — GitHub issue #327) without also dropping its `NodeDto` from what's sent as `cfg.nodes`, the node stays in the graph and in the point's node count forever — walled off (no edges reference it) but still enough to make `SplitJunctionRenderer` keep treating the point as split even after its last extra slot is gone. `confirmPostEdit` builds a `prunedNodes` list before anything else, via the shared `pixi/postEditUtils.ts`'s `pruneRemovedSplitNodes` (keyed multi-floor, `"x,y"`/`"x,y@level"`): a node survives if it's the point's original (`i === 0`) or its slotId (`i - 1`) is still present in `postEditDraftSplitPoints` for that point; `prunedNodes` (not `state.nodes`) is what's sent as `cfg.nodes` and what `pointNodeMap`/`resolveSplit` are built from.

**The same staleness exists client-side before any confirm lands** (GitHub issue #388) — `state.nodes` is only ever replaced wholesale by a `confirmPostEdit` response, so a slot removed on the draft (`removeSplitNode`/`resetPostEditPoint`) still has its stale `NodeDto` sitting in `state.nodes` until the next confirm resolves. With `postEditAutoConfirm === false`, or simply during the in-flight confirm, the canvas would otherwise keep drawing the point as split even though `postEditDraftSplitPoints` already says only the original node remains. `PostEditRenderer.floorScoped` calls the same `pruneRemovedSplitNodes` helper (bare `"x,y"` key, since its own `postEditDraftSplitPoints` is already floor-scoped) on the nodes it hands to `buildMazeWalls`/`buildClosedCells`/`buildSplitPassages` — the WASM-payload pruning and the on-canvas pruning share one formula so they can't drift apart.

`nodes: Vec<NodeDto>` in the outgoing snapshot is built from `Field::all_points()`/`nodes_at()` (deterministic: a point's original node first, then each extra node in creation order), not `Graph::nodes()`'s insertion order — this makes "which node of a split point is the original one" a real, documented contract, not an incidental observation of `Graph`'s internals. Each node's `i` in the snapshot is looked up from the *previous* call's own `cfg.nodes` where the node already existed there, or is a fresh position-based index for a node this exact call just minted (safe only because a newly minted node can't yet have a hole before it). The web-side node map (grouped by point) relies on this order too. `pixi/splitPointsCore.ts`'s `deriveSplitPointsFromNodes` mirrors the same rule client-side: it reads each node's `i` directly (`slotId = n.i - 1` for `i > 0`) rather than counting/positional derivation, for the same removal-hole reason.

### Controller/UI

- **A dedicated `manage_split_nodes` tool** (toolbar button next to the vertex tools) puts left-clicks in "focus a point" mode: clicking any point sets `postEditFocusedPoint` to that point (or clears it if the click misses), opening the "Manage split nodes" panel. This does **not** touch right-click behavior for the other tools — right-click with an edge tool resets the clicked edge to its generation-time state (GitHub issue #459, see "Controller — PostEditController" below), and right-click with `set_start`/`set_finish`/a teleport tool still clears/removes as before. Works on any point, split or not — it's the only way to create a point's *first* extra node.
- **"Manage split nodes" panel** (`ManageSplitNodesDialog.tsx`, delegating layout to the shared `SplitNodesDialogView.tsx` — GitHub issue #234 redesign, moved from a modal to a resizable docked `SidePanel.tsx` in GitHub issue #237) is the single UI surface for managing a point's extra nodes — no separate always-visible toolbar toggle. Docks to the canvas's right edge (drag-to-resize handle on its left edge, `SidePanel`'s generic shape — same as `DebugPanel`), so editing reads as directly manipulating the canvas rather than a modal floating over it. Stacked vertically, not side-by-side: a tile diagram on top (`TileFaceEditor.tsx`, rendered in the field's own tessellation) showing every node's faces at once, each in its own color, with a kind switcher (Passage/One-way/Wall — GitHub issue #426 added the explicit Wall button, matching every other post-edit tool panel) above it and two rotate buttons (`RotateCcw`/`RotateCw`) below it; below that, a scrolling list of the point's nodes, one card per node — color dot, title (`Node {n}`, `n` 1-based in row order — the point's original node is `Node 1`, a slot's number is its `slotId + 2`; no special "original node" label, GitHub issue #468 — or, when the point's current face configuration matches a recognized special-split topology, the node's semantic name from `splitNodeSemanticNames`, GitHub issue #487; the link-bubble coordinate suffix uses the compact `short` form of the same name), Start/Finish badges, an Active badge when active, and the node's links grouped into three sections (**Required**, always populated for a decided passage/one-way; **Undefined**, always empty for post-edit — presets are the only stage with an optional-connection concept; **Forbidden**, a `wall`-kind edge), each section showing a dash placeholder when empty. A fixed footer below the scrolling card list (outside the scroll area, always reachable) holds "+ Add node"/"Remove" (the latter disabled for the non-removable original node, confirmed via `ConfirmModal`) and a Set/Clear start/finish button pair for the active node. Clicking a non-active card makes it active. Clicking a non-boundary tile face applies the switcher's current kind for the active node (`wall` included); right-clicking a non-boundary face always forbids it (`wall`) for the active node regardless of the switcher's own selection — a redundant shortcut kept alongside the explicit Wall tool, not replaced by it. Hovering a link bubble sets `postEditHoveredLink`, highlighting that specific connection on the canvas (a straight line + circle markers on each end, cell center to cell center — `NodeEdgeHighlightRenderer`, the same primitive `DebugRefHighlightOverlay` uses for its edge-ref highlight) via `PostEditRenderer`'s `linkHover` layer; unhovering clears it. A dismissible warnings strip (`splitNodeDiagnostics`, `pixi/splitNodeDiagnostics.ts`) shows under the header when the point's current node set has a dead node (only wall faces on every non-boundary side) or an unreachable node (no connection at all) — purely informational, re-opens whenever the message set changes even if previously dismissed. Renders whenever `postEditFocusedPoint !== null`, independent of the active tool — switching tools does not close it. Closes on explicit close (✕, clearing `postEditFocusedPoint` and `postEditHoveredLink`) or on leaving the post-edit card.
- **`buildNodeMap`** in `PostEditController` returns `Map<string, number[]>` (every real node at a point, in snapshot order), not one id per cell. **`resolveActiveEndpointAt(point, nodeMap, activeMap)`** resolves which endpoint edge-tool clicks on that point currently target: `activeMap[key]` if set, else the point's original node (`nodeMap`'s first entry); `null` if the point isn't in the field.
- **Vertex tools (`set_start`/`set_finish`) on a split point's active node that isn't confirmed yet** are a no-op (not an error) — the same click works once that node is confirmed by a `confirmPostEdit`. This is a direct consequence of `PostEditEndpoint`'s unresolved-endpoint contract, not special-cased split logic: `resolveActiveEndpointAt` can return a `split` endpoint that doesn't resolve to a real id yet, and there is nothing wrong with assigning `postEditDraftMeta.start`/`.finish` to it (the endpoint itself is always valid) — it just can't be sent to WASM as a plain id until it resolves.

### Split-target prompt (GitHub issue #474)

The current split-node panel presents node-anchored items in an **Elements** section rather than Start/Finish controls or badges. Element rows match preset mode, with post-edit entity IDs rendered after coordinate/floor bubbles; clicking an ID opens the Changes log filtered to that entity. Link bubbles use semantic split-node names (for example `Cor1`) whenever the topology is recognized. Changing floors from a target bubble keeps the panel open.

The split-node panel's connection sections contain only basic connections and hide empty sections. One-way faces remain basic connections. Each node card also has an Elements section for start/finish points, teleports, vertical passages, elevators, and locks, using the deletion-dialog row format with post-edit entity IDs.

Element rows omit the current node's own address: a directed element is rendered as its localized name, direction arrow, and target coordinate bubble. Target bubbles include `L{n}:` on another floor and hover the standard inward-inset cell highlight with an opaque border; elevator rows list every other floor bubble.
Vertical-passage target bubbles contain only `L{n}`; any target-floor bubble is clickable and switches the active floor.

The "active node" concept exists only for the "Manage split nodes" editing context and its edge-tool clicks — it must **not** decide which of a split point's nodes a connection attaches to. Placing any vertex-tool element (`set_start`/`set_finish` marker, a vertical passage, an elevator stop, a teleport endpoint) on a **split point** (a point with more than one confirmed node) does not use `resolveActiveEndpointAt` at all: `PostEditController` defers the placement and calls `requestPostEditSplitTarget({ point, level, nodeIds, action })`, opening `PostEditSplitTargetDialog` (`components/dialogs/`). `nodeIds` are the point's confirmed nodes in snapshot order — index 0 the point's original node, the rest its slots, same order/palette as `ManageSplitNodesDialog`. `PostEditSplitTargetDialog`'s rows are titled `Node {n}` with `n` 1-based in row order (the original node is `Node 1`); no row carries a special "original node" label (GitHub issue #468). When the point's face configuration matches a recognized special-split topology, each row instead shows its semantic name (`splitNodeSemanticNamesFromKinds`, GitHub issue #487 — "Corridor" / "Bridge" / etc.; see `Specs/split-blueprints.md`). An unconfirmed split slot has no real id and is not offered (same no-op as before for an unconfirmed active split node).

### Rotating a split point (`rotateSplitPointNodes`, GitHub issue #580)

Rotating a split point's tile (the panel's rotate buttons) shifts **every one of the point's own nodes' face-wiring independently** by one offset index around the point — not a rigid-body rotation of the whole point as a unit. Each of the point's nodes (original + every slot) that currently has a decided face keeps that face's edge but re-keys it onto the new geometric face one step further in the rotation direction; a node with no decided face on the point is untouched.

**Resolving who owns the newly-vacated/newly-occupied face on the far side.** When a rotated face lands on a *new* neighbor point, `resolveFaceOwner` picks which of that neighbor's own nodes (it may itself be split) the moved edge should now connect to, tried in this priority order:
1. **Existing decided connection** on exactly the target face (`selectExistingFaceOwner`) — if the neighbor already has a standing `basic`/one-way edge toward this exact face, reuse that node; this checks every one of the neighbor's declared nodes, not just its original, since the real partner can live on any of its slots.
2. **Geometry evidence** (`canCompleteOppositePair`, `splitFaceLayout.ts`) — a neighbor candidate whose OWN decided faces already contain one that is geometrically opposite the target face (`circularDist === degree/2`) is picked, since handing it this face completes a recognized bridge/diagonal shape. Guarded by an `assignedThisRotation` map so two different new faces in the same multi-move rotation can't both claim the same neighbor node via evidence — the second one falls through to the next tier instead. Undefined for odd tile degree (a triangle has no "opposite" face).
3. **Neighbor's active UI slot or original node** — the fallback when neither of the above finds anything, restricted to candidates that don't already hold a *complete* opposite pair (`hasCompleteOppositePair`), so the fallback never hands a face to an already-finished bridge/diagonal and silently breaks its recognized shape.

**Wall-compensating a vacated face.** An old neighbor node that used to be `ep`'s partner but isn't picked up as anyone's *new* owner this rotation loses its connection on the face that used to point at `point`. If that old neighbor is itself split (more than one declared node at its point), simply deleting the stale edge would leave the face merely absent — read by the UI as an undecided/optional face — and silently degrade one of the neighbor's *other*, unrelated decided faces into part of a broken bridge/diagonal shape (a recognized shape requires an exact face count, no tolerance for a missing one). So the stale edge is rewritten to an explicit `wall` instead, keyed by the exact `(ep, oldNeighborNode)` pair (not just "is this neighbor node claimed by *some* move" — the same physical neighbor node can simultaneously lose one of `point`'s nodes as an old partner and gain a *different* one of `point`'s nodes as a new partner within one rotation). A plain (non-split) old neighbor has nothing else to protect and keeps the simpler "just vanishes" behavior. Preset connections (`rotatePresetSplitPoint`, `pixi/fieldEditUtils.ts`) mirror this exact algorithm — same tiering, same wall-compensation — over `PresetConnectionEntry`/`PresetConnectionState` instead of `PostEditEdge`.

**Warning before a rotation breaks a neighbor's shape** (GitHub issue #588). Wall-compensation keeps a neighbor's *other* faces internally consistent, but it can still turn a neighbor's own currently-recognized special shape (bridge/diagonal/etc., `detectSplitSpecialShapeKind`) unrecognized — losing a decided face this way is exactly the kind of change that degrades a shape, and this is expected by design (either the rotating tile or its neighbor can lose its shape when a shared face stops matching). `SplitNodesDialogView`'s rotate buttons dry-run the rotation before applying it: `rotateSplitPointBreaksNeighborShape` (`pixi/postEditUtils.ts`) calls the pure `rotateSplitPointNodes`, rebuilds the resulting edges via `applyRotatedNodesToEdges` — the same helper `postEditReplay.ts`'s own `"rotateSplitPoint"` case calls (not a parallel reimplementation, so the dry run and the real replay can never disagree on what a rotation produces) — then compares every one of `point`'s geometric neighbors' `detectSplitSpecialShapeKind` result before/after via `postEditSplitNodeFaceKinds` (the any-point counterpart of `ManageSplitNodesDialog`'s inline `facesOf`). If any split neighbor goes from recognized to unrecognized, the dialog shows a `ConfirmModal` before committing instead of rotating immediately. Preset connections use the mirrored `rotatePresetSplitPointBreaksNeighborShape` (`pixi/fieldEditUtils.ts`), comparing `presetSplitNodeFaceKinds` before/after — simpler there since `rotatePresetSplitPoint` already returns the full post-rotation `presetConnections` map rather than a per-node snapshot. Both wire into `SplitNodesDialogView`'s optional `wouldBreakNeighborShape` prop, shared by `ManageSplitNodesDialog` and `PresetSplitNodesDialog`.

**Resolving a face click's (point-node, neighbor-node) pair** (`ManageSplitNodesDialog.tsx`'s `resolveFaceClickPair`) is asymmetric by design: the `point` side is always the user's explicitly active node (a click edits whichever node the user selected in the panel, never a different one of `point`'s own nodes that evidence might otherwise prefer) — only the `neighbor` side is resolved by evidence (`resolveConnectedNeighborAt`), so a click correctly targets a split neighbor's real connected node even when the neighbor's own active slot isn't the one connected to `point`'s active side.

A small non-interactive Pixi preview on the right of the picker (`SplitPointPixiPreview`) renders **just the split's own geometry** — `buildSplitPassages` + `SplitJunctionRenderer`, plus the special-shape bridge/diagonal paths via `collectSplitWallPaths` + a bare `WallRenderer` (fed an empty edge list, so no `buildMazeWalls` / neighbouring-cell walls) — in a tiny throwaway `Application` scaled to fit, oriented the same way as on the field but with no adjacent cells drawn. It reuses the main canvas's own pipeline so a recognized special shape (bridge/diagonal, `detectSplitSpecialShapeKind`) draws with its real geometry, not an SVG hub-diagram approximation. On a special shape each node additionally gets a marker dot at the exact node-anchor position a marker/teleport endpoint would be drawn there (`buildNodePositions`), in the same color its picker row uses (`splitSlotColor` — fixed palette for the first slots, generated overflow colors past that), so the user can tell the nodes apart by position. The dot radius/stroke are authored in grid units but divided by the preview's `world.scale` before drawing, so the dot renders at a constant on-screen size (~7 px radius) across every tessellation — a hex cell spans more grid units than a square one, so a fixed grid-unit radius would render far smaller on hex. On a plain (non-special) split the per-node line colors alone disambiguate, so no dots are drawn. The dialog computes special-or-not from the point's own draft edges/teleports and passes it as `showMarkers`.

GitHub issue #546 tenth follow-up fixed the preview rendering only the point's original node (no
second node's geometry, no marker dot) on any floor above the first, while the row list above it
stayed fully functional. The dialog resolved each draft edge's/teleport's `split`-kind endpoints
through a `resolveSplit` built from `buildSplitNodeResolver(bareNodeMap, ...)`, but `bareNodeMap`
was built maze-wide from every floor's nodes under bare `"x,y"` keys, while `resolveEndpoint` was
called with the endpoint's own real (non-`undefined`) `level` for a floor above the first —
`buildSplitNodeResolver` deliberately refuses to fall back from an `"x,y@level"` lookup to the bare
key (the GitHub issue #425 fix, to avoid resolving a floor-2 slot against floor 0's own node when
the two share a coordinate), so every such lookup returned `undefined` and its edge was silently
dropped — leaving the slot node with only wall faces (no proper split junction geometry) and no
resolved position for its marker dot. Fixed by scoping `bareNodeMap` to `floorNodes` (already
filtered to the active level) and running each endpoint through `floorScopedEndpoint` (strips the
endpoint's own `level` after confirming it belongs to the active floor) before resolving — the same
bare-keyed, level-stripped pattern `PostEditController`/`ManageSplitNodesDialog` already use.

Picking a node calls `applyPostEditSplitTargetPick(nodeId)`, which clears the prompt and dispatches the deferred `action`'s tool to `nodeEndpoint(nodeId)` via the ordinary store actions (`setPostEditEndpoint`, `startPostEditVerticalPassagePlacement`, `startPostEditElevatorPlacement`, and the teleport two-click machine — first pick sets `postEditTeleportPendingFrom`, a second pick on a different node completes the link). `cancelPostEditSplitTarget` dismisses it (Escape key, dialog Cancel, or leaving the post-edit card). On a non-split point the placement path is unchanged. The prompt is reset by `generate()`/`resetPostEdit()`/`reset()` and is never persisted.

### Persistence

`ProjectFilePostEdit.splitPoints: Record<string, number[]>` mirrors `postEditDraftSplitPoints` — without it, saving/reloading a project would silently lose every manually created split point. `postEditActiveSplitNode` is not persisted (ephemeral UI selection, reset to `{}` on load). Project-file validation (`validatePostEditEndpoint` in `projectExport/validateSections.ts`) checks only the **format** of a `PostEditEndpoint`/`splitPoints` entry — it has no `Field` to check a `split` endpoint's point against at load time. Whether a loaded point still exists in the current tessellation is checked by `apply_split_points` on the WASM side, surfacing as an ordinary `confirmPostEdit` error on first confirm after load, not a load-time failure.

`validatePostEditEndpoint`'s `kind === "split"` branch parses an optional `level` (non-negative integer, same validation as `validatePresetEndpoint`'s own `level` field) — until GitHub issue #425 it silently dropped `level` entirely, so a split endpoint's floor was correctly serialized but never restored on load, collapsing every floor-1+ split reference onto floor 0 after any save/load round-trip even though the on-screen data looked fine right up until reload.

### Rendering (GitHub issue #223)

`PostEditRenderer` draws every node of a split point at once, not just the currently active one — `postEditActiveSplitNode` still governs which endpoint edge-tool clicks/edits target, but no longer filters what's drawn.

A split point (a point with more than one `NodeDto`) is excluded entirely from `buildMazeWalls`'s ordinary wall/passage reading — every geometric edge touching one is skipped there (both interior walls and boundary walls), and rendered instead by `buildSplitPassages` + `SplitJunctionRenderer`:

- For each geometric face a node connects across (`kind !== "teleport"`, matched by node id, not just cell coordinate — a "face" means a neighboring tile, not a specific node of that neighbor), that node draws its own share of the wall on that face (`SplitPassage.wallSegments`, in its own color). When several of the point's nodes connect across the same face, the face's edge is divided evenly among them in slot order, each getting one contiguous sub-segment, so two independent passages sharing a face read as visually distinct rather than overlapping. Every face always has one of `"wall" | "passage" | "one_way_out" | "one_way_in" | "undefined"` — post-edit defaults an undecided face to `"wall"` (no optional-connection concept exists here; see `Specs/preset-connections.md`'s "Split nodes" section for the preset stage's `"undefined"` default). When the neighbor across a face is itself split, each node's *specific* partner among the neighbor's nodes is resolved individually (not a single assumed "the" neighbor node), so a decided connection to one particular neighbor slot is never misread against a different one of that neighbor's nodes.
- Those shares are linked into `connectors`: a node with **exactly 2** connected faces, both plain two-way passages, draws one straight line directly between its two shares' centers — no hub point, since a pure through-passage reads more naturally as one continuous corridor than a bent one via a hub. Any other count (1, or 3+), or exactly 2 but not both plain passages, draws one line per share from the node's own point on a small circle around the tile center (radius = 1/2 of the cell's own radius, i.e. `TILE_SIZE / 4`, evenly distributed among the point's node count — 3 nodes → 0°/120°/240°, etc. — rotated by a per-tessellation starting angle, `getSplitCircleRotationDeg` in `tessellationGeometry.ts` — 45° for square, 0° for hex/tri pending visual tuning) out to that share's center. The circle itself is never drawn. A node with zero connections draws nothing at all. A one-way's arrowhead is drawn on this connector line (never on the along-face segment); an `"undefined"` share/connector renders desaturated (`disabledOf`/`disabledOfNumber`) instead of the node's normal color. A face where every one of the point's nodes explicitly has `"wall"` renders as one plain solid wall spanning the whole face instead of per-node segments.
- The geometric layout itself (face division, hub fan-out, the straightening exception, active-node z-order, arrow placement) lives in the tessellation/stage-agnostic `pixi/splitFaceLayout.ts`, shared with the "Manage split nodes" panel's tile diagram (`TileFaceEditor.tsx`) and the preset stage's own rendering (`Specs/preset-connections.md`) so the three never drift apart.
- **Straightening exception:** the 2-face straight-line case above is skipped (hub point kept instead) for a node passed in `buildSplitPassages`'s `specialNodeIds` — `PostEditRenderer` populates this from `start`/`finish` (resolved node ids) and every teleport edge's endpoints, so a marker/teleport line landing on that node always has a single unambiguous hub point to sit on, instead of an arbitrary spot along a straightened line.
- **Active-node z-order:** `postEditActiveSplitNode` also determines draw order — the active node's own segments/connectors always render on top of every other node's, in both the canvas and the panel's tile diagram (GitHub issue #234 follow-up).
- **Marker/teleport anchoring:** `buildNodePositions` (`tessellationGeometry.ts`) is the single source of truth for where a node-anchored entity draws — the plain cell center for an unsplit node, or that same node's hub point (identical radius/rotation/slot formula to `buildSplitPassages`) for an ordinary split one. `buildMazeMarkers` (start/finish) and `buildTeleportEdges` (teleport endpoints) both build the map once per call and read positions from it instead of resolving `getCellCenter` per node directly, so a marker or teleport line on a split point visibly lands on one specific node, not the tile as a whole; `getSplitAwareNodePosition` (`mazeSelectors.ts`) is a thin single-node wrapper over the same map, kept for callers needing only one lookup (e.g. `exportWarnings.ts`). Every caller still takes the point's full node list — the other nodes needed for the slot index/shape detection come from the caller's own full value set, which is always the complete node list (unsplit callers like `GenerationRenderer` simply never have more than one node per point, so this is a no-op for them).
- **Shape-aware node point (GitHub issue #318):** a node recognized as part of a `SplitSpecialShapeKind` gets a dedicated point from `specialSplitNodePoint` (`tessellationGeometry.ts`) instead of the generic hub-circle position, since a bridge/diagonal reads visually as belonging to a specific half/lane of the tile rather than an evenly-spaced circle slot — applies to every node-anchored entity (marker, teleport endpoint, and the debug/graph overlays' own node position, all funneled through `buildNodePositions`), not just the canvas's own special-shape drawing. Square `"diagonal"`/`"bridge"` retain their hand-authored points. Hex bridge/diagonal/triple-bridge/triple-corridor anchors derive from the tessellation's own face directions: adjacent/skip pairs use their outward bisector, opposite pairs use their corridor axis, all at `0.25 * TILE_SIZE`; the crossing node of a two-node bridge stays at the center. Detection needs `directedPairs` (derived from the caller's `edges`, teleports pre-filtered); a caller with no edge data in hand passes `[]` and always gets the generic hub position.
- Each node's color comes from `splitSlotColor` (`colorUtils.ts`) — the point's node list order (original first, then each `add_node_at` slot in creation order) indexes into `canvas.node.splitSlots` (3 explicit colors) for slots 0-2, falling back to `buildPalette` (the same rotating hue-wheel palette `RegionsRenderer` uses for components) for slot 3+.

Also wired into `GenerationRenderer` (own instance, `maze-web/CLAUDE.md`'s renderer-ownership rule) and `AnalyticsRenderer` (via `MazeOverlayRenderer`, the shared maze-overlay wrapper) — see `maze-web/Specs/renderer.md`'s `SplitJunctionRenderer` section. `PresetConnectionsRenderer` also draws via the same `SplitJunctionRenderer` class for its own declared split points (GitHub issue #231 — see `Specs/preset-connections.md`'s "Split nodes" section), since presets have their own pre-generation split-node data by then.

### Node-list duplication fix (GitHub issue #223)

`Field::all_points()` (`maze-core/src/space/mod.rs`) yields one entry per `NodeId`, not per unique point — for a split point with N nodes it repeats that point N times. `build_analytics_snapshot`'s `nodes` list (`maze-wasm/src/analytics.rs`) used to `flat_map` `nodes_at(p)` over that iterator directly, so a split point's node list appeared once per its own node count (a 2-node split point listed 4 entries instead of 2). Fixed by deduping points (first occurrence, preserving `all_points()`'s NodeId-sorted order) before the `flat_map`. The same `all_points().flat_map(nodes_at)` pattern exists in several `maze-core` repair strategies (node-pool builders) with a milder symptom (skewed random-selection probability, not visible duplication) — tracked separately, out of scope for this fix.

### Out of scope

Generator auto-split (GitHub issue #222), broader serialization work (#224) beyond this feature's own new fields, and a stateful WASM/`Maze` model for post-edit generally (a separate, much larger future conversation — `compute_analytics` stays a pure function taking a full snapshot and returning a fresh one, even though GitHub issue #236 made it rebuild `Field`/`Graph` from the client's given ids rather than re-minting them).

## Lifecycle

### On `generate()`

1. Runs WASM generation.
2. Builds a fresh `postEditBaseline` via `buildPostEditBaseline(nodes, edges, revision, generatedStart, generatedFinish)` (`postEditSliceHelpers.ts`) — bumps `revision`, builds the `PostEditReplayContext` (nodes + `resolveSplit`), and derives the pristine (empty-log) `PostEditDerivedState` via the shared `buildMultiFloorPostEditDraft(nodes, edges)` (groups nodes per floor first via `groupNodesByLevel`, GitHub issue #425/#358, so a same-`(x, y)` node on a different floor is never conflated into the same point's split-slot group; also re-derives any teleport whose two endpoints sit on different floors from the full, unfiltered edge list, GitHub issue #363). Sets `postEditCommands = []`, `postEditDerived = postEditBaseline.derived`, and mirrors the legacy draft fields via `derivedStateToLegacyFields`.
3. Resets `_nextPostEditTeleportId`/`_nextPostEditVerticalPassageId`/`_nextPostEditElevatorId`/`_nextSplitSlotId` to one past whatever the baseline derivation found, and `postEditTeleportPendingFrom = null`.
4. Resets `postEditEdges = null`, `postEditTeleportEdges = []`, `postEditMeta = null`, `postEditAnalytics = null`.
5. Sets `postEditDirty = false`.
6. Resets `postEditTool` to `"wall"`.
7. Calls `confirmPostEdit()` immediately — populates `postEditEdges`, `postEditTeleportEdges`, `postEditMeta`, `postEditAnalytics`.

### On `resetPostEdit()`

Whole-graph reset — the trivial case of "replace the log": `replacePostEditCommands(get, set, [],
/* dirty */ false)`. Since `postEditBaseline.derived` is the pristine, never-mutated empty-log
state, replacing the log with `[]` and replaying is equivalent to (and implemented as) just
reading `postEditBaseline.derived` straight back into `postEditDerived`/the legacy mirror fields —
no separate rebuild-from-generation-snapshot logic distinct from `generate()`'s own baseline
construction. Also resets `postEditEdges = null`, `postEditTeleportEdges = []`, `postEditMeta =
null`, `postEditAnalytics = null`, `postEditTeleportPendingFrom = null`, and `postEditTool` to
`"wall"`, then calls `confirmPostEdit()`.

### On `confirmPostEdit()`

Async, versioned via `_postEditRequestId`:

1. Increments `_postEditRequestId`.
2. Snapshots `postEditDraftEdges`, `postEditDraftTeleports` (converted to `EdgeDto[]` via `postEditTeleportsToDto`, resolving `split` endpoints through a resolver built from the *previous* confirmed node snapshot), and `postEditDraftMeta` at call time.
3. Reads `effectiveStart`/`effectiveFinish` from snapshot (falls back to `state.start/finish`, wrapped as `nodeEndpoint(...)`, when null), then resolves each to a plain id via `resolveEndpoint` — `undefined` (unresolved split endpoint) becomes `null` on the wire, not an error; the same call's `split_points` will make it resolvable on a later confirm.
4. Serializes non-wall edges to `PostEditEdgeWasmDto[]`: `basic` → `"basic"` (bidirectional in WASM); `one_way_forward`/`one_way_backward` → `"one_way"` (WASM adds only one directed edge `from→to`); each converted teleport `EdgeDto` → `"teleport"` (WASM adds one directed `EdgeKind::Teleport` edge — a two-way teleport is sent as two separate `"teleport"` entries, one per direction, not auto-expanded like `"basic"`). Each edge's `from`/`to` is sent as `PostEditEndpointWasmDto` (`toWasmEndpoint`, a trivial passthrough) — WASM resolves any `split` endpoint itself via `split_points` (see "Split Points" below).
4b. Builds `split_points: [[number, number], number][]` — a flat list of `(point, slotId)` pairs from all of `postEditDraftSplitPoints`, no sort on the JS side (Rust sorts internally).
5. Calls WASM `compute_analytics` — QC-only (runs `checks`, no repair). Always sends an empty `check_rules`: rules exist to dispatch repair strategies, and `compute_analytics` discards the `RepairEngine` it builds internally, so a rule referencing a check the caller disabled would only ever produce a spurious "inactive check" validation error for no benefit.
6. If `_postEditRequestId` changed (stale) — discards result.
7. Writes to `postEditAnalytics`, `postEditEdges` (confirmed snapshot), `postEditTeleportEdges` (confirmed snapshot, converted teleport `EdgeDto[]`), `postEditMeta` (confirmed snapshot). Auto-resets `showRouteOverlay` to `false` when `route_info == null`.

Teleport-editing actions (`addPostEditTeleport`, `cyclePostEditTeleportDirection`, `removePostEditTeleport`, `movePostEditTeleportEndpoint`) call `confirmPostEdit()` directly when `postEditAutoConfirm` is true, same as endpoint tools — the controller does not schedule an additional debounced call for these.

## Tools

All tools live in one **Tools** section of the feature card, rendered as a wrapping row of square icon-only buttons (`ToolIconButton` + `ToolGlyph`, GitHub issue #456 — see `Specs/preset-connections.md`'s "## Tool icon buttons" for the shared components). There is no separate Edges / Vertex / Management grouping any more; `reset` and `delete` moved into this row alongside the rest. Each button's pictogram is a live Pixi render of that element in `DEFAULT_MAZE_RENDER_STYLE`. `PostEditFeature`'s `glyphKeyFor` maps the `reset` tool to the synthetic `post_edit_reset` glyph (a counter-clockwise circular arrow, "rewind to the generated state" — distinct from the preset `reset` tool's grey undecided-edge stub); `delete` uses the trash-can glyph. Section content is indented one `indent.tree` level under its label.

`DANGER_TOOLS = { reset, delete }` — these two show a `base.error`-hued selected border (`btn-tool-icon-selected-danger`) instead of the accent one. Their native tooltips: `reset` → "Reset to generated state" ("Сброс до генерации"), `delete` → "Delete an element" ("Удаление элемента").

The **Management** section below the tool row keeps only the whole-graph actions: the "Reset to generated state" destructive button (`resetPostEdit`, confirmed), the "Confirm" button (manual `confirmPostEdit` when not auto-confirming), and the auto-confirm/auto-compact switches — each a `ToggleRow` (`maze-web/src/components/ToggleRow.tsx`) with an info icon (GitHub issue #576) that opens a plain-text `Modal` (`AutoConfirmInfoModal`/`AutoCompactInfoModal`, `maze-web/src/components/features/PostEditModals.tsx`) explaining what the toggle does — same convention as `AnalyticsFeature`'s `ScoreInfoModal`/`SidesInfoModal` (`Specs/analytics-web.md`).

| Tool | Action |
|---|---|
| `wall` | Sets both directions of the face pair to `"wall"` — no-op (nothing appended) if the face already reads as wall in both directions. |
| `passage` | Sets both directions to `"basic"` — no-op if the face already reads as a two-way passage. |
| `one_way` | See "`one_way` Tool Detail" below. |
| `reset` | Hover-sensitive to both edges and cells (GitHub issue #327) — see "Reset Tool Detail" below. |
| `delete` | Cell-only (GitHub issue #386) — see "Delete Tool Detail" below. |
| `set_start` | Click on empty node — sets `postEditDraftMeta.start`, calls `confirmPostEdit` if `autoConfirm`. |
| `set_finish` | Click on empty node — sets `postEditDraftMeta.finish`, calls `confirmPostEdit` if `autoConfirm`. |
| `teleport_one_way` | Two-click placement of a one-way (`"forward"`) teleport link. |
| `teleport_two_way` | Two-click placement of a two-way teleport link. |

`set_start` and `set_finish` are a shared vertex-editing pair. While either is active, drag-to-move and right-click-to-delete apply uniformly to **both** the start and finish markers, regardless of which one is currently selected: right-click on the current start node clears it (`clearPostEditEndpoint`) even while `set_finish` is active, and press-and-drag from either marker's node moves it live to whichever node is under the cursor, even while the other tool is active. Only the plain-click "assign to this empty node" action stays tied to the active tool (`set_start` assigns start, `set_finish` assigns finish).

### Teleport Tools Detail

`teleport_one_way` and `teleport_two_way` share one two-click placement state machine (mirrors `PresetConnectionsController`'s teleport handling, adapted from cell coordinates to node ids):

- **First click on an empty node, no placement pending** → `setPostEditTeleportPendingFrom(nodeId)`. A preview line follows the cursor from that node to the pointer (`PostEditRenderer.updateTeleportPreview`).
- **Second click on a different node, placement pending** → `addPostEditTeleport(pendingFrom, nodeId, direction)` where `direction` is `"two_way"` for the `teleport_two_way` tool, `"forward"` otherwise. Clears the pending state.
- **Click on the pending origin node again** → no-op (does not complete a zero-length link).
- **Escape key, or right-click with a placement pending and no marker/endpoint under the cursor** → cancels the pending placement (`setPostEditTeleportPendingFrom(null)`), clears the preview.
- **Left press-drag starting on an existing teleport endpoint's node** → arms a drag candidate (`draggingTeleportEndpoint`). Each pointer move to a different node calls `movePostEditTeleportEndpoint`; landing back on the link's other endpoint is rejected (would collapse the link to zero length) but still counts as "moved" so release doesn't misread it as a click.
- **Release without ever moving to a different node** → resolves as a plain click: if a placement is already pending, completes it at that endpoint's node; otherwise cycles that entry's direction (`cyclePostEditTeleportDirection` — `"forward"` ↔ `"backward"`; `"two_way"` entries are unaffected, they have no direction to cycle).
- **Right click on an existing teleport endpoint's node (no placement pending)** → `removePostEditTeleport(id)`.

Endpoint hit-testing is done by `pickPostEditTeleportEndpointAt` (in `postEditUtils.ts`), which resolves node id → screen position via `nodeById` before comparing to the cursor — unlike `PresetConnectionsController`'s `pickTeleportEndpointAt`, which works directly in cell coordinates since preset connections predate node ids.

### Vertical Passage / Elevator Drag-to-Move (GitHub issue #566)

Both tools use an override-preview + commit-on-release pattern, distinct from teleport's own live-per-move-write drag: `postEditDragOverride` holds the live preview (set on pointerdown/pointermove, read by `PostEditRenderer` in place of the entry's committed endpoint) and nothing is appended to the command log until pointerup, so an intermediate cell the cursor passes over never produces a command. This lets the whole gesture be reverted cleanly if the release point turns out to be unresolvable, instead of leaving a partial edit behind.

- **Vertical passage** — dragging an existing endpoint moves BOTH ends to the dragged node's `(x, y)`: the two ends are the same column on different floors, so moving only the dragged end would desync them (the original issue #566 bug). On release, `movePostEditVerticalPassageEndpoint` dispatches through `resolveVerticalPassageMove` (`postEditVerticalUtils.ts`), which looks up a node at the target `(x, y)` on the OTHER end's own floor (`findNodeAt`). No such node → the whole drag reverts (no command appended) and `postEditDragFailureMessage` is set so `PostEditFeature` can show an `AlertModal` naming the rejecting floor/point. The dragged end's own floor never rejects, by construction — the drag target is always a real node on the active floor.
- **Elevator** — dragging any one floor's own marker moves EVERY other floor's own endpoint to the same new `(x, y)` (an elevator's whole fan shares one column). `resolveElevatorMove` validates the new point against every OTHER floor in ascending level order, failing on the first floor with no node there (same revert + `postEditDragFailureMessage` shape as vertical passage, `entityKind: "elevator"` picks the "stop" wording). An elevator floor endpoint CAN be split-addressed (`kind: "split"`, see `confirmPostEditElevatorPlacement`) — `resolveElevatorMove` reads a split floor's own `level` directly off the endpoint (no node lookup needed for that part) so it's included in validation/movement like any other floor; the dispatch action (`movePostEditElevatorEndpoint`, `postEditSlice.ts`) re-wraps a floor that was originally split-kind back through `resolveNodeIdToEndpoint` after the move, so its slot identity survives (a plain `nodeEndpoint` would silently drop it).

Both tools' hit-testing (`pickPostEditVerticalPassageEndpointAt`, `pickPostEditElevatorEndpointAt`) mirrors `pickPostEditTeleportEndpointAt`, filtered to the active floor's own endpoints before hit-testing. A plain click (no drag) on an existing vertical-passage endpoint cycles `forward ↔ backward`; a plain click on an elevator's own marker reopens the floor-picker dialog to edit that entry (mirrors `startPostEditElevatorPlacement`'s existing-entry edit path).

### `one_way` Tool Detail

Operates on an edge pair `(from_, to_)`, reading each direction's *effective* current kind
(`?? "wall"`, since wall is never an explicit record):

- Either direction currently reads as one-way (`from_→to_` is `one_way_forward`, or `to_→from_` is
  `one_way_backward`) → this click **flips** the existing one-way passage's direction: swap which
  side is `one_way_forward`/`wall`; the emitted command contains only the resulting face states, so the
  Changes panel labels it as a direction change, not a fresh passage.
- Otherwise (wall or a two-way `basic` passage) → creates a **fresh** forward one-way passage
  (`from_→to_` = `one_way_forward`, `to_→from_` = `wall`). This is the
  branch a `basic` two-way passage takes — the tool never silently drops the reverse direction of an
  existing passage without going through this fresh-creation path first.

A single click always emits exactly one `setEdgePair` (never two `setEdge` commands). Conversion
to/from plain wall and two-way passage requires the `wall`/`passage` tools.

### `reset` Tool Detail (GitHub issue #327)

The unified Reset tool is hover-sensitive to both edges and cells, dispatched in `PostEditController` by
`pickEdgeAtPosition(..., true)` (the same near-edge dead-zone threshold `wall`/`passage`/`one_way`
hover uses):

- **Near-edge zone, and neither endpoint's point is currently split** — edge branch: unlike
  `wall`/`passage`/`one_way`, doesn't append a new "restore to generation state" command at all — it
  **removes** whatever earlier `setEdge`/`setEdgePair` command(s) touched this exact edge pair from
  the log (matched by `lifelineKeyOf`, which keys a `setEdge`/`setEdgePair` purely off its
  endpoints, ignoring `edgeKind`/`aToB`/`bToA`), then replaces the whole command log
  (`replacePostEditCommands`) with the filtered list. With nothing left in the log for this edge, the
  derived state naturally falls back to `postEditBaseline.derived` (generation-time state) for it —
  the same "undo via lifeline removal, not counter-command" approach the cell branch below already
  used. No-op (nothing changes, log kept by reference) if no command in the log touched this edge —
  repeated reset clicks on an already-reset or never-touched edge never pile up duplicate entries.
  Drag-capable, same as `wall`/`passage`.
  A `reset` click that lands on a split node's own face (either endpoint is a `split` kind) is a
  guarded no-op instead — `updateSplitNodeFaces`'s lifeline covers the whole slot, not one face, so
  restoring a single face this way would make a later point-reset wipe every other face of that
  slot too. No caller reaches this combination currently (this dispatch itself only fires for a
  non-split endpoint pair — see the cell branch below for how a split point's faces actually get
  reset), the guard exists purely so a future caller can't silently hit the mismatched semantics.
- **Outside the near-edge zone, or the near-edge hit touches a split point (either endpoint's
  point currently has more than one node)** — cell branch: `resetPostEditPoint(point)` prunes every
  command in the log whose lifeline ever touched `point` (fixed-point cascade, see "Point-reset" in
  the Command Log section above) and replays what remains. This restores the point to
  generation-time state — every edge/teleport/vertical-passage/elevator/start-finish command
  touching any of the point's current *or past* nodes (original plus every split slot ever added
  there, including one added via `addSplitNode` and never confirmed) is dropped, so the derived
  state falls back to `postEditBaseline.derived` for that lifeline. This is the only way to reset a
  split connection — the edge branch refuses it.

  Drag-capable, same as the edge branch (GitHub issue #489): a press-drag paints a reset stroke
  across every in-field cell the cursor enters, deduped per gesture. `BaseController`'s
  `beginCellDrag(point)`/`continueCellDrag(point | null, cb)` (the cell-target counterpart of
  `beginEdgeDrag`/`continueEdgeDrag`) drive it — they share the one `dragVisited` set and the
  `endEdgeDrag`/`isDragActive` teardown with the edge drag, keyed through a private
  `cell:x,y`-prefixed helper so a cell key can never collide with a `FieldEdge` key (a gesture is
  only ever one or the other, since the active tool is fixed for its duration). The near-edge zone
  still hands off to the edge branch mid-drag, so a stroke that grazes an edge resets that grain
  instead of the point there. In auto-confirm mode each painted cell schedules a debounced
  reconfirm on pointer-up, identical to the edge branch.

  Post-edit itself isn't multi-floor-aware (`Specs/floors.md`'s "Non-goals") even though generation
  can be (GitHub issue #337): `filterCommandsForPoint`'s lifeline matching takes an explicit
  `level` alongside `point`, so a floor-1 node sharing the reset point's `(x, y)` is never picked up
  as if it were a second split slot at that point on floor 0 — the same per-floor point key
  (`"x,y"`/`"x,y@level"`) used throughout split-slot bookkeeping.
- Right/middle click has no reset-tool meaning beyond the shared middle-click pan.

**Danger styling:** the Reset icon button uses the `btn-tool-icon-selected-danger` class (red border + inset shadow when selected, `base.error`) instead of the accent `btn-tool-icon-selected` — `reset` is in `PostEditFeature`'s `DANGER_TOOLS` set. Its canvas hover highlight (edge or cell) renders in `canvas.fieldEditor.danger` (red) instead of `canvas.fieldEditor.hover` — `PostEditRenderer.updateHover`/`.updateCellHover` take an optional `danger` flag for this, set whenever `postEditTool === "reset"`. Both cues exist so a destructive tool reads as destructive before the user commits to a click. (`delete` is styled the same way — also in `DANGER_TOOLS`.)

### `delete` Tool Detail (GitHub issue #386, multi-entity picker + split slots added by #550)

Removes generation-placed content anchored to a cell — the counterpart to `wall`/`reset` (which only
edit face states). Always cell-only: clicking anywhere near a cell targets point-anchored content.
The delete tool never edits wall, passage, or one-way face state. Those states are changed only by
the edge tools.

**Entry point:** a left click on any in-field cell calls `requestPostEditEntityDelete(point, level,
bulk)`, mirroring the preset-side `requestPresetEntityDelete` from #540. It counts the live
descriptors `buildPostEditPointEntities` (`pixi/postEditPointEntities.ts`) returns for the point: 0
is a no-op, exactly 1 calls `removePostEditPointEntity` on it directly (no dialog), more than 1
opens `postEditEntityDeletePrompt` — `PostEditEntityDeleteDialog` then lists each entity with a
"Delete all" button, and clicking a row removes just that one entity (dialog stays open, rebuilding
its row list from live state, until the point is empty). Held **Shift** (`bulk: true`, captured at
pointerdown the same way `PresetConnectionsController.bulkDelete` is, so a drag started with Shift
held stays bulk for its whole gesture) bypasses the picker entirely and calls
`deletePostEditPoint(point)` directly — the old pre-#550 one-shot behavior.

**Row shape** (GitHub issue #550 follow-ups): each descriptor (`PostEditPointEntityDescriptor`,
`pixi/postEditPointEntities.ts`) carries `title` (a bare noun label — `post_edit.entity_delete_label_*`
for teleport/vertical-passage, `status.cell_*` for start/finish/elevator/split-point;
direction/target text is never baked into it, unlike the status-bar/cell-inspection selector's own
use of `status.cell_teleport`/`_vertical_passage`, which still show `{arrow}`/`{target}` inline —
this dialog shows that information via `bubbles`/`showArrow`/`arrow` instead), `entityId` (that
entity's own stable id, `undefined` for start/finish/split-point — same convention
`entityIdOf`/`PostEditCommandLabel.entityId` use for the Changes panel), `bubbles`
(`PostEditEntityBubble[]`, one coordinate bubble per endpoint, `bubbles[0]` always the point
currently being edited), and `showArrow`/`arrow` (a plain text arrow glyph between `bubbles[0]`/
`bubbles[1]` for a teleport/vertical-passage row, `false` for every other kind) — built with
the exact same `endpointBubble`/`splitPointBubble` helpers (`pixi/postEditCommandLabels.ts`, exported
for this reuse) and the same `SplitLabelContext` the Changes panel builds, so a dialog row renders
with the same title/id-bubble/coordinate-bubble/arrow vocabulary as that entity's own Changes-panel
row, laid out as a single wrapping flex row (not the panel's own column layout) in a dialog sized via
`dialogSize.approveWide` (`minWidth`/`maxWidth` only, no fixed `width` — grows with its content up to
the cap, then wraps).

A split point contributes exactly **one** row for its whole tile (`kind: "split_point"`, `id:
"split_point"`, no `entityId`), never one row per slot — per-slot removal is "Manage split nodes"'
own job; this dialog only answers "what can I delete from this point", and the split's own on/off
state is the one binary choice that belongs here. Clicking it removes every one of the point's slots
at once via `removePostEditSplitSlots` (below), same as the bulk primitive's own split handling.

`deletePostEditPoint(point)` (the bulk/"Delete all" primitive) removes split content **first**, via
`removePostEditSplitSlots` (see below) if the point has any declared slots, then appends one
ordinary per-entity command for each remaining piece of content (`setMeta`/`removeTeleport`/
`removeVerticalPassage`/`removeElevator`) built against state *after* the split removal — ordering
matters here: computing meta/teleport/vertical/elevator clearing before the split removal would let
the split's own cascade (see below) sweep away commands that were only just appended, discarding
their intended effect. Each of these commands has its own lifeline (same as if the user had removed
that entity directly), so there's no dedicated "delete" lifeline to track. Covers **every** node
currently at the point (original plus every declared split slot — not just the active one).
Drag-capable (GitHub issue #489): a press-drag paints a delete stroke across every in-field cell the
cursor enters, deduped per gesture via `BaseController`'s `beginCellDrag`/`continueCellDrag`; a cell
whose point carries more than one entity opens the picker mid-drag and ends the gesture right there
(same `endEdgeDrag()` guard `PresetConnectionsController` uses for its own `clear`/`reset` drag
branches), so a drag never keeps running "held" underneath an open dialog. Removed per point:

- Every declared split slot (GitHub issue #550 follow-up), via `removePostEditSplitSlots` — see
  below for the two removal strategies it picks between per slot.
- Start/finish, if either currently addresses one of the point's nodes (same effect as
  `clearPostEditEndpoint`, applied to both markers uniformly) — via an implicit `setMeta` outcome
  within the same command's replay.
- Every teleport with an endpoint on one of the point's nodes.
- Every vertical passage/elevator with an endpoint on one of the point's nodes — generation-baked
  ones included (GitHub issue #564): since these are full baseline draft entries with their own
  stable id from the start, removing one is this same single `removeVerticalPassage`/
  `removeElevator` command, not a per-underlying-edge suppression. An elevator's removal command
  denormalizes its *entire* connected component's `floors` (from `extractPostEditElevators`'s own
  BFS at baseline-extraction time, not re-walked here) — a multi-floor elevator's mesh can include
  nodes that never name this point's own node directly, and the single command still covers all of
  them.
**Whole-split-point removal — `removePostEditSplitSlots` (GitHub issue #550 follow-up,
`store/slices/postEditSliceHelpers.ts`)**: `removePostEditSplitSlots(get, set, point, level,
targetSlotIds)` is the single entry point every split-removing surface goes through — the delete
tool's one-entity-direct case, the delete dialog's `split_point` row, the bulk/"Delete all"
primitive, and `removeSplitNode` (the "Manage split nodes" panel's own per-slot remove action, now a
thin wrapper calling this with a one-element `targetSlotIds`). It splits `targetSlotIds` by origin
and applies a different strategy to each group, because "undo the slot's existence" means something
different depending on whether post-edit created that slot or generation did:

- **Post-edit-created slots** (added by `addSplitNode`/`applySplitBlueprint` earlier in *this* log —
  no baseline counterpart) are undone by **cascading** their own lifelines away
  (`cascadeRemoveLifelines`, seeded from each slot's `slot:point:level:slotId` key, plus
  `originalNode:point:level` too when this removal empties the point entirely) — every command that
  ever addressed that slot (its creation, every face rewire, every edge/teleport hung off it) is
  pruned from the log, same fixed-point cascade shape `filterCommandsForPoint`/`deleteCommandAt`
  already use. The net effect reads as "this slot was never created."
- **Generation-baked slots** (already present in `postEditBaseline.derived.splitPoints`) can't be
  cascaded away — there's no earlier "create" command to prune, the slot has existed since
  generation. These are undone by appending one atomic `removeSplitPoint` command (see the
  `PostEditCommand` union above) that removes the targeted slot(s)' edges/teleports and, only when
  this removal empties the point completely, restores the point's ORIGINAL node's edges to its own
  generation-time wiring (`restoredOriginalFaces`, built via `currentSplitNodeFaces` reading the
  baseline's own edges around that endpoint — `postEditUtils.ts`) — as if the point had never been
  split at all. When other slots remain after this removal (a partial multi-slot split shrinking,
  not disappearing), `restoredOriginalFaces` is omitted; the original node's own wiring is left
  untouched.

Both branches can fire from the same call when a point mixes post-edit-created and generation-baked
slots — `removePostEditSplitSlots` runs the cascade for the former and the explicit
`removeSplitPoint` command for the latter, so removing "the whole split" always fully empties the
point regardless of each slot's own origin.

Basic face states (`wall`, `passage`, and `one-way`) are never touched by delete — the complete face
configuration survives a point deletion untouched. Only the edge tools edit those states.

For every other kind, delete never restores anything by itself for a post-edit-created entity — it's
a pure removal, so a piece of content created entirely in post-edit (no generation-time counterpart)
is simply gone. A generation-baked split's removal is the one exception (see `restoredOriginalFaces`
above): the point doesn't just lose its slots, it reverts to the exact wiring generation produced,
since "delete the split" for a generation-time split means "un-split it," not "leave a node with
arbitrary leftover faces." Because every command delete appends for these kinds (the split-slot
cascade included, since cascading only prunes what's already in the log) is an ordinary command with
its own ordinary lifeline (`teleport:${id}`, `vertical_passage:${id}`, `meta:${slot}`,
`slot:point:slotId`, etc. — see "Point-reset" above), a later `resetPostEditPoint`/`resetPostEdit`
**does** undo delete for them, restoring whatever it removed — "reset undoes delete" is a direct
consequence of the fixed-point lifeline cascade over those ordinary per-entity commands.

Uses the same danger styling as `reset` (`toggle-danger`/`toggle-danger-active`, red cell hover via
`updateCellHover`'s `danger` flag).

## Auto-Confirm

The panel's auto-confirm switch has an info icon (GitHub issue #576, `AutoConfirmInfoModal`) explaining, in plain language, that confirming is what makes post-edit changes take effect elsewhere, that auto-confirm applies each change immediately instead of requiring the manual Confirm button, that every confirm recomputes the full analytics (a potential slowdown on large mazes), and recommending auto-confirm be turned off — confirming manually once editing is done — on large mazes.

When `postEditAutoConfirm = true`, `PostEditController` schedules `confirmPostEdit` with 300ms debounce after each edge tool click. For endpoint tools (`set_start`/`set_finish`) and teleport-editing actions (`addPostEditTeleport`, `cyclePostEditTeleportDirection`, `removePostEditTeleport`, `movePostEditTeleportEndpoint`), `confirmPostEdit` is called directly by the store action (only when `autoConfirm = true`) — controller does not schedule an additional call.

When `postEditAutoConfirm = false`:
- Edge tool clicks update `postEditDraftEdges` but do not trigger `confirmPostEdit`.
- Endpoint tool clicks update `postEditDraftMeta` but do not trigger `confirmPostEdit`.
- Teleport-editing actions update `postEditDraftTeleports` but do not trigger `confirmPostEdit`.
- `postEditEdges`, `postEditMeta`, `postEditAnalytics` remain frozen at last confirm.
- Manual Confirm button calls `confirmPostEdit()` explicitly.

Reconfirm on rule change is independent of `postEditAutoConfirm` — see "Reconfirm on QC rule changes" below; that flag only gates edge/endpoint/teleport edits.

## Reconfirm on QC rule changes

See GitHub issue #111. Editing checks/strategies/stages in the Quality panel (`Specs/quality-feature.md`) changes what `confirmPostEdit`'s own `checks` derivation (`postEditSlice.ts`, filtered from `state.rules`/`state.stages` — see "On `confirmPostEdit()`" above) would produce, but by itself does not touch `postEditDraftEdges`/`postEditDraftMeta`, so nothing triggers a recompute. `postEditAnalytics`/`issues` are left stale — still reflecting whichever ruleset was active at the last confirm — until something else calls `confirmPostEdit()`.

`MazeScene.subscribeToQualityRulesReconfirm` (`maze-web/src/pixi/MazeScene.ts`) closes this gap with two triggers, independent of `postEditAutoConfirm`:

- **Debounced reconfirm while the Quality panel is open** — any `state.rules`/`state.stages` reference change (every rule/stage-mutating store action replaces these arrays, so a reference change is a reliable "something changed" signal) while `openCard === "quality"` (re)schedules a `confirmPostEdit()` call 300ms out, same interval `PostEditController.scheduleConfirm` uses for edge edits — batches rapid edits (e.g. dragging a param slider) into one recompute instead of one per keystroke.
- **Immediate flush on leaving the Quality panel** — the moment `openCard` transitions away from `"quality"`, any pending debounce timer is cancelled and `confirmPostEdit()` is called immediately, so the report is never left stale by a pending-but-not-yet-fired debounce once the panel that could have caused the staleness closes.

Both triggers call the same `confirmPostEdit()` used everywhere else — no separate recompute path. `confirmPostEdit` is already a no-op before the first generation (`postEditDraftEdges === null`), so no extra guard against an unstarted maze is needed here.

## Canvas Renderer — PostEditRenderer

Reads from `postEditDraftEdges`, `postEditDraftTeleports`, and `postEditDraftMeta` — always shows the current working state, regardless of `autoConfirm`.

Lives in `postEditContainer` — a synced layer in `MazeScene` (not a viewport child). `TessellationRenderer` hides itself when `postEditOpen` is true.

### Layer Stack (bottom to top)

| # | Container | Content |
|---|---|---|
| 1 | `gridContainer` | `GridRenderer` — always rendered when open |
| 2 | `floorContainer` | `CellFillRenderer` — all nodes in `FLOOR_COLOR` |
| 3 | `closedCellsContainer` | `CellFillRenderer` — isolated nodes (no edges) in `WALL_COLOR` |
| 4 | `wallsContainer` | `WallRenderer` — walls and one-way arrows |
| 5 | `teleportContainer` | `TeleportRenderer` — teleport markers/line, built from `postEditDraftEdges` concatenated with `postEditDraftTeleports` (converted via `postEditTeleportsToDto`) |
| 6 | `markersContainer` | `WaypointsRenderer` — start/finish from `postEditDraftMeta` |
| 7 | `hoverContainer` | `EdgeHighlightRenderer` — hover highlight |
| 8 | `teleportPreviewContainer` | `Graphics` — pending teleport placement preview (fixed-endpoint marker + connector line to cursor), drawn by the shared `drawTeleportPreview` (`pixi/renderers/teleportPreviewGlyph.ts`) — same helper `PresetConnectionsRenderer` uses |

Cell cache (`cachedCells`, `cachedCellSet`) is built once on open and on `activeTessellationConfig` change. Used by `PostEditController` for edge picking.

`updateTeleportPreview(pendingFrom, cursorViewportX, cursorViewportY)` takes `pendingFrom` already resolved to viewport coordinates (the controller resolves node id → screen via `nodeById` before calling in, since the renderer has no node lookup of its own) — unlike `PresetConnectionsRenderer`'s version, which takes a cell coordinate and projects it internally. Both then delegate the actual drawing to the shared `drawTeleportPreview`: the preview marker uses the real `DEFAULT_MAZE_RENDER_STYLE.teleport` shape / size / corner style / border / gap ring at 50% alpha (not a hardcoded 16px square — that was the pre-#456 look), and the connector clips to the marker's full outer footprint (`size*TILE_SIZE + borderWidth + edgeGapWidth`). Unit-tested in `teleportPreviewGlyph.test.ts`.

`PostEditRenderer` extends `BaseFieldRenderer` (shared with `PresetConnectionsRenderer`; see maze-web/CLAUDE.md's Feature-Renderer ownership rule — a shared base class, never a shared instance). `BaseFieldRenderer` owns the `useMazeStore.subscribe` skeleton (open/close detection, cell-cache lifecycle, `getCachedCells`/`getCachedCellSet`, `destroy`). `PostEditRenderer` implements `isCardOpen` (`openCard === "post_edit"`), `getActiveConfig` (`activeTessellationConfig`), `setRootVisible`, `redrawAll`, `clearAll`, `onStoreChange` (the draft-edges/teleports/nodes/meta comparison above, plus clearing the teleport preview when `postEditTool`/`postEditTeleportPendingFrom` changes and no placement is pending), and `destroyChildren`.

## Controller — PostEditController

Extends `BaseController` (shared with `PresetConnectionsController`). `BaseController` owns pan logic (`tryStartPan`, `handlePanMove`, `toViewport`), edge-drag bookkeeping (`beginEdgeDrag`/`continueEdgeDrag`/`endEdgeDrag`/`isDragActive` — dedupe-only, the caller's `onNewEdge` callback owns the store action and any redraw), cell-drag bookkeeping (`beginCellDrag`/`continueCellDrag` — GitHub issue #489, the whole-point counterpart for `reset`/`delete`/`clear`; shares the same visited set and `endEdgeDrag`/`isDragActive` as the edge drag, since a gesture is only ever one or the other), and marker-drag bookkeeping (`draggingMarker`, `armMarkerDrag`/`releaseMarkerDrag` — the latter called automatically from `onPointerUp`). `PostEditController` adds node-map caching, edge picking, tool dispatch, confirm debounce, and teleport pending-placement/drag/cancel state (`draggingTeleportEndpoint`, `teleportDragMoved`, an ESC key listener wired in the constructor and torn down in `destroy()` — mirrors `PresetConnectionsController`).

Handles pointer events when `postEditOpen`. Node map (`Map<"x,y", NodeId[]>` — every real node at a point, GitHub issue #221) is cached per `nodes` reference — rebuilt only when `state.nodes` changes.

- **Left click + edge tool** → resolves both cells' active endpoint (`resolveActiveEndpointAt`) and calls `applyPostEditTool`, schedule confirm if `autoConfirm`.
- **Right click + edge tool** → resets the clicked edge to its generation-time state (`applyPostEditToolAt("reset", …)`, GitHub issue #459), regardless of which edge tool is active — mirrors `PresetConnectionsController`'s own right-click reset. A split connection can't be reset via the edge branch (GitHub issue #327), same as the dedicated Reset tool — it's a no-op there (whole-point reset stays Reset-tool-only). Floor-scoped via the same `level` passed to `cellEdgeToNodeKey` as the left-click path.
- **Left click + endpoint tool (`set_start`/`set_finish`), no start/finish marker under cursor** → `setPostEditEndpoint` with the point's currently active endpoint (confirm called internally by store action when `autoConfirm`); no-op if that endpoint is an unconfirmed split node.
- **Left press-drag + endpoint tool, starting on start's or finish's own node** → arms drag for that marker regardless of which endpoint tool is active; each pointer move over a new node calls `setPostEditEndpoint` again (with that cell's active endpoint) to move it live. A press that never leaves the marker's node resolves as a plain click on release (no-op, node unchanged).
- **Right click + endpoint tool, on the start or finish marker's own node** → `clearPostEditEndpoint` for that marker, regardless of which endpoint tool is active. Right-click elsewhere is a no-op for endpoint tools.
- **Teleport tools (`teleport_one_way`/`teleport_two_way`)** → see Teleport Tools Detail above.
- **Middle click** → pan viewport.

`set_start`/`set_finish`/`teleport_one_way`/`teleport_two_way` are all members of the controller's `VERTEX_TOOLS` set — they share the same node-picking pointerdown branch, dispatching to endpoint vs. teleport handling based on which tool is active and what's under the cursor (marker, teleport endpoint, or empty node).

## `buildPostEditDraftEdgesFromGenerated`

Shared function in `pixi/postEditUtils.ts`, used internally by `buildMultiFloorPostEditDraft`
(`postEditSliceHelpers.ts` — itself called by `buildPostEditBaseline` on `generate()` and by the
trivial `resetPostEdit` case, see "Lifecycle" above). Ignores `kind: "teleport"`, `kind:
"vertical_passage"`, and `kind: "elevator"` entries entirely — teleport edges are tracked
separately (see `extractPostEditTeleports` below); vertical passage/elevator edges are resent
unchanged from the baseline by `confirmPostEdit` (via WASM's `restore_vertical_edges`), so leaking
them into this `Record` too would resend the same physical edge twice — once as a `Basic` draft
entry, once as its own `VerticalPassage`/`Elevator` edge — producing a duplicate parallel nav-edge
that desyncs `link_reverse_edges`'s pairing and gets misread as a phantom cycle (GitHub issue
#370). Detects one_way edges by absence of reverse: if `A→B` exists but `B→A` does not →
`one_way_forward`. If both exist → `basic`.

The "Reset to generation" action uses a compact confirmation alert: the action label is the title, the body is omitted, and the Cancel/OK footer has no divider. This is the shared reset-confirmation layout used by presets.

## `extractPostEditTeleports`

Shared function in `pixi/postEditTeleportUtils.ts`, used internally by `buildMultiFloorPostEditDraft`
alongside `buildPostEditDraftEdgesFromGenerated` (same call sites as above). Filters generation's `EdgeDto[]` down to `kind: "teleport"` entries and rebuilds them as `PostEditTeleportEntry[]`: a forward+backward pair between the same two nodes collapses into one `"two_way"` entry, a lone direction becomes a `"forward"` entry. Returns `{ teleports, nextId }` — `nextId` seeds `_nextPostEditTeleportId` so ids assigned afterward by `addPostEditTeleport` don't collide. Not folded into `buildPostEditDraftEdgesFromGenerated`'s `Record` output because a Teleport and a Basic edge can coexist in the same direction between the same pair — that `Record` has only one slot per `from-to` key and would drop one of the two.

## `postEditTeleportsToDto`

Shared function in `postEditUtils.ts`: `(teleports: PostEditTeleportEntry[], resolveSplit) => EdgeDto[]`. Converts `PostEditTeleportEntry[]` to `EdgeDto[]` at the WASM-call/render boundary: `"forward"` → one edge `from→to`; `"backward"` → one edge `to→from` (actual passage direction, mirrors `PresetConnectionState::TeleportBackward`); `"two_way"` → both directions. Each endpoint is resolved via `resolveEndpoint`/`resolveSplit` first — an entry with an endpoint that doesn't resolve yet (unconfirmed split node) is silently dropped. Used by `confirmPostEdit` (building the confirmed `postEditTeleportEdges` snapshot and the WASM request) and `PostEditRenderer` (building the edges fed to `TeleportRenderer`/`buildTeleportEdges`).

## `pickPostEditTeleportEndpointAt`

Shared function in `postEditUtils.ts`: `(viewportX, viewportY, cfg, teleports, nodeById, resolveSplit) => PostEditTeleportEndpointHit | null`. Hit-tests a viewport position against `PostEditTeleportEntry[]` endpoints, resolving each entry's `from`/`to` endpoint to a real node id (via `resolveEndpoint`/`resolveSplit`) then to a screen position via a `nodeById` map before comparing distance to the cursor — an endpoint that doesn't resolve yet is skipped. Mirrors `pickTeleportEndpointAt` in `fieldEditUtils.ts`, adapted for node-id space (preset connections hit-test directly in cell coordinates).

## `postEditEdgesToDto`

Shared selector in `mazeSelectors.ts`: `(postEditEdges: Record<string, PostEditEdge> | null, resolveSplit) => EdgeDto[]`. Converts to `EdgeDto[]`, filtering out `wall` entries, resolving each remaining entry's `from`/`to` endpoint (dropping the entry if either doesn't resolve yet), and mapping every remaining entry's `kind` to `"basic"` (post-edit's tool-facing distinction between `basic`/`one_way_forward`/`one_way_backward` collapses here — direction is already encoded in each entry's own `from`/`to`, and downstream consumers like `buildMazeWalls` derive one-way vs bidirectional by checking for the reverse pair, not by reading `kind`). Never returns teleport entries — those live in `postEditDraftTeleports`/`postEditTeleportEdges` and must be concatenated in by the caller (converting `postEditDraftTeleports` via `postEditTeleportsToDto` first). Used by both `PostEditRenderer` (passing `postEditDraftEdges`, concatenated with `postEditTeleportsToDto(postEditDraftTeleports, resolveSplit)`) and `AnalyticsRenderer` (passing `postEditEdges`, concatenated with `postEditTeleportEdges`, which is already `EdgeDto[]`). Both renderers build their `resolveSplit` from the confirmed node snapshot via `buildSplitNodeResolver`.

## `buildClosedCells`

Shared selector in `mazeSelectors.ts`. Finds nodes with no connected edges — rendered as `WALL_COLOR` in both `PostEditRenderer` and `GenerationRenderer`.
