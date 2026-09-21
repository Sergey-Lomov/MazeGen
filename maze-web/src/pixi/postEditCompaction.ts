import type { PostEditCommand } from "../store/postEditCommandTypes";
import type { PostEditBaseline } from "./postEditReplay";
import {
  applyPostEditCommand, isCreateCommand, isDirectionCommand, renormalizeCommand,
} from "./postEditReplay";
import { endpointKey, type PostEditEndpoint } from "./postEditEndpoint";

/** Groups a command belongs to for compaction purposes (`Specs/post-edit.md`'s "Command Log
 * Compaction" section) — coarser than `lifelineKeysOf` for a plain wall/basic face: every
 * `setEdge`/`setEdgePair` whose resulting side(s) are wall/basic (never one-way) shares one `edge:`
 * group keyed by the face's own undirected endpoint-pair key, since a plain wall<->passage toggle
 * sequence on one face is what repeated clicks there produce and only the LAST such toggle is ever
 * observable. A one-way side is never folded into this group — creating a one-way passage is an
 * entity creation the user can see and expect to survive compaction unless the entity is actually
 * later destroyed (the user's own call: "technically a flip is equivalent, but creation must stay
 * unless the entity is removed"), so a `setEdge`/`setEdgePair` with a one-way side is instead keyed
 * by that side's own `oneWay:${id}` — the SAME per-id lifeline `lifelineKeysOf` already uses — and
 * collapsed by `collapseEntityGroup` exactly like a teleport/vertical-passage lifeline (create,
 * flip-pair, remove). Every other command kind keeps its own `lifelineKeysOf` key(s) unchanged.
 * Returns an array for the same reason `lifelineKeysOf` does — a `setEdgePair` can touch up to two
 * independent one-way lifelines (one per side) plus/instead of the plain wall/basic edge group. */
function compactionGroupsOf(command: PostEditCommand): string[] {
  if (command.kind === "setEdge") {
    return command.edge.kind === "one_way_forward" || command.edge.kind === "one_way_backward"
      ? [`oneWay:${command.edge.id}`]
      : [`edge:${undirectedEdgeKey(command.edge.from, command.edge.to)}`];
  }
  if (command.kind === "setEdgePair") {
    const groups: string[] = [];
    const aToBIsOneWay = command.aToB.kind === "one_way_forward" || command.aToB.kind === "one_way_backward";
    const bToAIsOneWay = command.bToA.kind === "one_way_forward" || command.bToA.kind === "one_way_backward";
    if (aToBIsOneWay) groups.push(`oneWay:${(command.aToB as { id: string }).id}`);
    if (bToAIsOneWay) groups.push(`oneWay:${(command.bToA as { id: string }).id}`);
    // A one-way side this command DESTROYS (`replacedOneWayIds`) is also folded in — that old
    // entity's own lifeline must see this command as its terminating "remove" step, exactly the way
    // `lifelineKeysOf` already includes a destroyed id so a point-reset cascades it too.
    if (command.replacedOneWayIds?.aToB !== undefined) groups.push(`oneWay:${command.replacedOneWayIds.aToB}`);
    if (command.replacedOneWayIds?.bToA !== undefined) groups.push(`oneWay:${command.replacedOneWayIds.bToA}`);
    // Only when NEITHER side is one-way does this command belong to the plain wall/basic edge group
    // — a face transitioning TO or FROM one-way is entity creation/destruction, not a plain toggle.
    if (groups.length === 0) groups.push(`edge:${undirectedEdgeKey(command.a, command.b)}`);
    return groups;
  }
  if (command.kind === "updateSplitNodeFaces") {
    return [command.slotId === undefined
      ? `originalNode:${pointKeyOf(command.point, command.level)}`
      : `slot:${pointKeyOf(command.point, command.level)}:${command.slotId}`];
  }
  if (command.kind === "addSplitNode" || command.kind === "removeSplitNode") {
    return [`slot:${pointKeyOf(command.point, command.level)}:${command.slotId}`];
  }
  if (command.kind === "rotateSplitPoint" || command.kind === "applySplitBlueprint") {
    return [`point:${pointKeyOf(command.point, command.level)}`];
  }
  if (command.kind === "addTeleport" || command.kind === "setTeleportDirection"
    || command.kind === "moveTeleportEndpoint" || command.kind === "removeTeleport") {
    return [`teleport:${command.id}`];
  }
  if (command.kind === "addVerticalPassage" || command.kind === "setVerticalPassageDirection"
    || command.kind === "moveVerticalPassageEndpoint" || command.kind === "removeVerticalPassage") {
    return [`vertical:${command.id}`];
  }
  if (command.kind === "addElevator" || command.kind === "updateElevatorFloors" || command.kind === "removeElevator") {
    return [`elevator:${command.id}`];
  }
  return [`meta:${command.slot}`];
}

function pointKeyOf(point: [number, number], level?: number): string {
  return level === undefined ? `${point[0]},${point[1]}` : `${point[0]},${point[1]}@${level}`;
}

function undirectedEdgeKey(a: PostEditEndpoint, b: PostEditEndpoint): string {
  const ka = endpointKey(a);
  const kb = endpointKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

/** True for a command that mints/destroys/moves one addressable entity as a whole — every kind
 * compaction treats as "one step of that entity's history" (as opposed to a group's own
 * `edge:`/`point:`-level commands, which have their own dedicated collapsing rules below). */
function isRemoveCommand(command: PostEditCommand): boolean {
  return command.kind === "removeTeleport" || command.kind === "removeVerticalPassage"
    || command.kind === "removeElevator" || command.kind === "removeSplitNode";
}

function isMoveCommand(command: PostEditCommand): boolean {
  return command.kind === "moveTeleportEndpoint" || command.kind === "moveVerticalPassageEndpoint"
    || command.kind === "updateElevatorFloors" || command.kind === "updateSplitNodeFaces";
}

/** True when `command` (already known to belong to `oneWay:${id}`'s own group) is the step that
 * DESTROYS that specific id — either a plain wall/basic result overwriting the face the one-way sat
 * on, or a fresh one-way created on the SAME face replacing it (`replacedOneWayIds` names the old id
 * on the side no longer carrying it). Never true for a `directionFlip`, which keeps the same id
 * alive under a new direction — that is this group's own "move/flip" step, not its remove. */
function isOneWayRemoveCommand(command: PostEditCommand, id: string): boolean {
  if (command.kind === "setEdge") {
    return command.edge.kind !== "one_way_forward" && command.edge.kind !== "one_way_backward";
  }
  if (command.kind === "setEdgePair") {
    if (command.directionFlip) return false;
    return command.replacedOneWayIds?.aToB === id || command.replacedOneWayIds?.bToA === id;
  }
  return false;
}

/** True when `command` mints `id` fresh (the "create" step of an `oneWay:${id}` group) — a
 * `setEdge`/`setEdgePair` whose resulting one-way side carries `id` and isn't a `directionFlip`
 * (a flip reuses an existing id, it never mints one). */
function isOneWayCreateCommand(command: PostEditCommand, id: string): boolean {
  if (command.kind === "setEdge") {
    return (command.edge.kind === "one_way_forward" || command.edge.kind === "one_way_backward") && command.edge.id === id;
  }
  if (command.kind === "setEdgePair") {
    if (command.directionFlip) return false;
    const aId = command.aToB.kind === "one_way_forward" || command.aToB.kind === "one_way_backward" ? command.aToB.id : undefined;
    const bId = command.bToA.kind === "one_way_forward" || command.bToA.kind === "one_way_backward" ? command.bToA.id : undefined;
    return aId === id || bId === id;
  }
  return false;
}

/** Collapsing pass for one `oneWay:${id}` group (GitHub issue #548 follow-up) — same create/
 * flip-pair/remove shape `collapseEntityGroup` gives a teleport/vertical-passage lifeline, but a
 * one-way's own "create" is deliberately NEVER folded away by a plain later toggle the way a
 * teleport's `addTeleport` never is either: only an actual destroy of this id (`isOneWayRemoveCommand`)
 * supersedes the id's own creation — a user reads "set one-way passage" as a real action worth
 * keeping visible even though a later direction flip is technically equivalent to having created it
 * facing the other way to begin with. */
function collapseOneWayGroup(commands: PostEditCommand[], indices: number[], id: string, superseded: Set<number>): void {
  const removeIdx = indices.find((i) => isOneWayRemoveCommand(commands[i], id));
  if (removeIdx !== undefined) {
    const before = indices.filter((i) => i < removeIdx);
    for (const i of before) superseded.add(i);
    // The remove step itself is only superseded (dropped entirely) when this id was created AND
    // destroyed within this same log — never when the remove command is ALSO the create step of a
    // DIFFERENT one-way id on the same physical face (e.g. replacing o1 with a fresh o2 in one
    // click): that command must survive to record o2's own creation, even though it simultaneously
    // ends o1's lifeline.
    const firstIsCreate = indices.length > 0 && isOneWayCreateCommand(commands[indices[0]], id);
    const mintsAnotherId = isCreateCommand(commands[removeIdx]);
    if (firstIsCreate && !mintsAnotherId) superseded.add(removeIdx);
    return;
  }

  // No remove in this log — only direction-flip pairs collapse; the create itself always survives.
  const flipIndices = indices.filter((i) => {
    const c = commands[i];
    return c.kind === "setEdgePair" && c.directionFlip === true;
  });
  for (let k = 0; k + 1 < flipIndices.length; k += 2) {
    superseded.add(flipIndices[k]);
    superseded.add(flipIndices[k + 1]);
  }
}

/** One pass over `commands`, collecting the index set of every command whose own effect is fully
 * superseded by a LATER command — the compaction rules from `Specs/post-edit.md`:
 *
 * - **Edge group** (`edge:...`, GitHub issue #548): a face's plain wall<->passage toggle sequence
 *   (never one-way) — each `setEdge`/`setEdgePair` in the group is superseded by the NEXT one in
 *   the same group (whatever it set is immediately overwritten); only the group's last command
 *   survives.
 * - **One-way groups** (`oneWay:${id}`, GitHub issue #548 follow-up): a one-way passage's own
 *   create/flip/destroy history, kept SEPARATE from the plain edge group above — creating a one-way
 *   passage is a visible action the user expects to survive compaction even though a later
 *   direction flip is technically equivalent to having created it facing the other way; only an
 *   actual destroy of this id (the face reverting to wall/basic, or a fresh one-way replacing it)
 *   supersedes its own creation. See `collapseOneWayGroup`.
 * - **Create/remove groups** (teleport/vertical passage/elevator/split-slot): a `remove*` command
 *   supersedes EVERY earlier command of its own group (the create and every move/direction-flip in
 *   between) — none of their effects are observable once the entity is gone. If the group's very
 *   first command is itself a create (the entity has no baseline counterpart), the remove also
 *   supersedes ITSELF — the entity was created and destroyed entirely within this log, so nothing
 *   about it needs recording at all.
 * - **Move commands**: a move supersedes only the immediately PRECEDING move of the same group
 *   (never the create, never a direction-flip in between) — a `P1->P2->P3` chain collapses to a
 *   single effective `P1->P3` in the same "single-entry collapse" sense `deleteCommandAt` already
 *   uses for a manually deleted move.
 * - **Direction-flip pairs**: within one group's own flip-only subsequence, PAIRS collapse from the
 *   start — flip 1 + flip 2 cancel out (both superseded) if there's nothing but non-direction
 *   commands of the same group between them, flip 3 + flip 4 likewise, etc.; a trailing unpaired
 *   flip (odd count) survives. A flip toggles the entity's CURRENT direction regardless of the
 *   command's own denormalized `direction` field, so any two consecutive flips of one group cancel
 *   regardless of what's denormalized on them.
 * - **`rotateSplitPoint`/`applySplitBlueprint`** rebuild a split point's entire node/face structure
 *   from scratch — a later one supersedes every earlier `slot:`/`originalNode:`/`point:` command of
 *   the SAME point (across every one of that point's slot groups at once), the same "whole point
 *   rebuilt" reasoning `removeSplitNode` uses for a single slot.
 * - **`setMeta`**: a later `setMeta` for the same slot supersedes the earlier one outright (only the
 *   slot's current value is ever observable).
 */
function collectSuperseded(commands: PostEditCommand[]): Set<number> {
  const superseded = new Set<number>();
  const groupIndices = new Map<string, number[]>();
  for (let i = 0; i < commands.length; i++) {
    for (const g of compactionGroupsOf(commands[i])) {
      const list = groupIndices.get(g);
      if (list) list.push(i);
      else groupIndices.set(g, [i]);
    }
  }

  // Point-level rebuild supersedes every earlier slot/originalNode/point command of that SAME point
  // (GitHub issue #548) — collected first since it can supersede commands belonging to several
  // DIFFERENT slot groups (`slot:point:0`, `slot:point:1`, `originalNode:point`) at once, which the
  // per-group loop below (keyed one group at a time) can't express on its own.
  const pointGroups = new Map<string, number[]>();
  for (let i = 0; i < commands.length; i++) {
    const c = commands[i];
    if (c.kind === "rotateSplitPoint" || c.kind === "applySplitBlueprint"
      || c.kind === "addSplitNode" || c.kind === "removeSplitNode" || c.kind === "updateSplitNodeFaces") {
      const key = pointKeyOf(c.point, c.level);
      const list = pointGroups.get(key);
      if (list) list.push(i);
      else pointGroups.set(key, [i]);
    }
  }
  // A command at position i (within this point's own indices) is superseded whenever a rebuild
  // command exists LATER among those same indices — a rebuild supersedes everything before it,
  // including another point command that isn't itself a rebuild. `applySplitBlueprint` recreates
  // the point's entire slot list AND wiring from scratch (replay's `applySplitBlueprint` case
  // writes `splitPoints`/`splitPointIds` — see `postEditReplay.ts`), so it can supersede an
  // `addSplitNode`/`removeSplitNode`/earlier `applySplitBlueprint` too. `rotateSplitPoint` only
  // re-wires the SLOTS IT WAS GIVEN — its own replay case never writes `splitPoints`/
  // `splitPointIds` at all — so it must never supersede ANY command that registers a slot's
  // existence (`addSplitNode`, `removeSplitNode`, `applySplitBlueprint`): dropping that command
  // would leave the rotated wiring snapshot with no slot left to attach to (the point silently
  // loses that node after compacting). A `rotateSplitPoint` may still supersede an earlier
  // `rotateSplitPoint`/`updateSplitNodeFaces` — both are pure wiring rebuilds, never existence.
  for (const indices of pointGroups.values()) {
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      const isSlotExistenceCommand = commands[i].kind === "addSplitNode" || commands[i].kind === "removeSplitNode"
        || commands[i].kind === "applySplitBlueprint";
      const laterRebuild = indices.slice(k + 1).some((j) => {
        const c = commands[j];
        if (c.kind === "applySplitBlueprint") return true;
        return c.kind === "rotateSplitPoint" && !isSlotExistenceCommand;
      });
      if (laterRebuild) superseded.add(i);
    }
  }

  for (const [group, indices] of groupIndices) {
    if (group.startsWith("point:")) continue; // handled above
    if (group.startsWith("edge:")) {
      // Plain wall/basic toggle sequence on one face — every command but the group's last is
      // immediately overwritten. A one-way side never reaches this group (see `compactionGroupsOf`).
      for (let k = 0; k < indices.length - 1; k++) superseded.add(indices[k]);
      continue;
    }
    if (group.startsWith("oneWay:")) {
      collapseOneWayGroup(commands, indices, group.slice("oneWay:".length), superseded);
      continue;
    }
    if (group.startsWith("meta:")) {
      for (let k = 0; k < indices.length - 1; k++) superseded.add(indices[k]);
      continue;
    }
    if (group.startsWith("slot:") || group.startsWith("originalNode:")) {
      // A point-level rebuild already marked everything before it superseded (handled above); here
      // we only add the slot's own create/remove/move/flip collapsing among whatever's left
      // unmarked, same as the teleport/vertical/elevator groups below. `slot:`/`originalNode:` only
      // ever carry `addSplitNode`/`removeSplitNode`/`updateSplitNodeFaces` — `updateSplitNodeFaces`
      // is registered as a move kind in `isMoveCommand` (it carries the node's full face list, a
      // snapshot, so a later one fully supersedes an earlier one the same way a later
      // moveTeleportEndpoint supersedes its predecessor — each collapses only its immediate
      // predecessor of the same group, never the create).
      collapseEntityGroup(commands, indices, superseded, { hasDirectionFlip: false });
      continue;
    }
    // teleport:/vertical:/elevator: groups.
    collapseEntityGroup(commands, indices, superseded, { hasDirectionFlip: true });
  }

  return superseded;
}

/** Shared collapsing pass for an entity group (teleport/vertical passage/elevator/split-slot) —
 * handles remove-supersedes-everything-before-it, move-supersedes-only-its-predecessor, and
 * (when `hasDirectionFlip`) direction-flip pair cancellation, all within `indices` (already sorted
 * ascending, this group's own command indices only). Mutates `superseded`. */
function collapseEntityGroup(
  commands: PostEditCommand[],
  indices: number[],
  superseded: Set<number>,
  opts: { hasDirectionFlip: boolean },
): void {
  // Remove: supersedes every earlier command of this group. If the group's own first command is a
  // create, the remove also supersedes itself (created-and-destroyed entirely within this log).
  const removeIdx = indices.find((i) => isRemoveCommand(commands[i]));
  if (removeIdx !== undefined) {
    const before = indices.filter((i) => i < removeIdx);
    for (const i of before) superseded.add(i);
    const firstIsCreate = indices.length > 0 && isCreateCommand(commands[indices[0]]);
    if (firstIsCreate) superseded.add(removeIdx);
    // Nothing after a remove can exist in a well-formed log (the entity is gone) — no further
    // collapsing needed for this group.
    return;
  }

  // Move: each move supersedes only the immediately preceding move of the same group (never the
  // create, never a flip in between).
  let lastMoveIdx: number | undefined;
  for (const i of indices) {
    if (superseded.has(i)) continue;
    if (isMoveCommand(commands[i])) {
      if (lastMoveIdx !== undefined) superseded.add(lastMoveIdx);
      lastMoveIdx = i;
    }
  }

  if (!opts.hasDirectionFlip) return;

  // Direction-flip pairs, collapsed from the start of this group's own flip-only subsequence —
  // non-flip commands of the same group (moves, the create) are skipped over, never treated as
  // breaking a pair.
  const flipIndices = indices.filter((i) => !superseded.has(i) && isDirectionCommand(commands[i]));
  for (let k = 0; k + 1 < flipIndices.length; k += 2) {
    superseded.add(flipIndices[k]);
    superseded.add(flipIndices[k + 1]);
  }
}

/** Compacts `commands` (`Specs/post-edit.md`'s "Command Log Compaction" section, GitHub issue #548)
 * — drops every command whose effect is no longer observable in the log's own final state, per
 * `collectSuperseded`'s rules, then renormalizes every surviving command's own denormalized fields
 * against the state immediately preceding it in the NEW sequence (same `renormalizeCommand` step
 * `deleteCommandAt` already performs, needed for the same reason: dropping an earlier command in a
 * lifeline can leave a later survivor's own denormalized from/to/direction/floors field describing
 * a pre-compaction snapshot even though the derived state itself replays correctly).
 *
 * Runs to a fixed point: dropping a superseded command can itself expose a NEW superseded command
 * that wasn't superseded while the dropped one still sat between it and whatever superseded it (a
 * removed lifeline reappearing makes an even-numbered flip run odd again, etc. — same reasoning the
 * user's own "deleting the second flip makes the first useful again" example describes for manual
 * deletion). Terminates because each iteration strictly shrinks the log or leaves it unchanged. */
export function compactPostEditCommands(
  baseline: PostEditBaseline,
  commands: PostEditCommand[],
): PostEditCommand[] {
  let current = commands;
  for (;;) {
    const superseded = collectSuperseded(current);
    if (superseded.size === 0) break;
    current = current.filter((_, i) => !superseded.has(i));
  }
  if (current === commands || current.length === commands.length) return commands;

  const renormalized: PostEditCommand[] = [];
  let state = baseline.derived;
  for (const command of current) {
    renormalized.push(renormalizeCommand(state, command));
    const result = applyPostEditCommand(baseline.context, state, renormalized[renormalized.length - 1]);
    if (result.applied) state = result.state;
  }
  return renormalized;
}
