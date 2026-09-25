import type { NodeDto } from "../wasm/types";
import type { PostEditCommand } from "../store/postEditCommandTypes";
import type { PostEditBaseline } from "./postEditReplay";
import { collectAffectedLifelineKeys, lifelineKeysOf } from "./postEditReplay";
import { postEditCommandLabel, type PostEditCommandLabel } from "./postEditCommandLabels";
import type { SplitLabelContext } from "./postEditSplitLabels";

/** One row of the post-edit Reset tool's multi-lifeline picker dialog (GitHub issue #549, mirroring
 *  the delete tool's own picker from #550/#540): one entry per DISTINCT command a click would
 *  actually reset, labeled with the exact same `postEditCommandLabel` vocabulary the "Changes"
 *  panel uses, built from that command (its denormalized fields are always kept current by every
 *  log mutation's own `renormalizeCommand` pass — see `Specs/post-edit.md`'s "Denormalization
 *  after a collapse" — so the latest command of a lifeline always describes its current state). A
 *  row's action resets only THAT one command, not a whole lifeline's history (GitHub issue #549
 *  follow-up) — `commandIndex` is the log's own oldest-to-newest index of that command, passed
 *  straight to `deletePostEditCommand` (GitHub issue #547's existing per-row Delete action, same
 *  single-entry-collapse semantics the Changes panel's own Delete button uses: a plain
 *  move/direction-change/removal collapses away leaving the rest of the lifeline's history intact;
 *  a command that MINTS a lifeline cascades the whole thing away, since there's nothing left for a
 *  dependent to describe once its creation is undone). `keys` lists every lifeline this one row's
 *  command covers — normally one, but `removeSplitPoint` names every one of its own
 *  `removedSlotIds`' lifelines AT ONCE (`lifelineKeysOf`'s own "one command, several lifelines"
 *  shape, GitHub issue #564) — so two lifelines whose LATEST command is the same shared
 *  `removeSplitPoint` collapse into one row here, not two separate rows that would both delete the
 *  same command (and so both un-remove every slot in it, not just one). */
export interface PostEditResetLifelineDescriptor {
  keys: string[];
  commandIndex: number;
  /** Snapshot of the command represented by this row when the dialog was opened. */
  command: PostEditCommand;
  label: PostEditCommandLabel;
}

/** Builds the reset-dialog row list for `point`/`level` — one row per DISTINCT command among the
 *  latest commands of every lifeline `collectAffectedLifelineKeys` reports as currently touching
 *  the point, in the log's own oldest-to-newest command order. Returns `[]` when nothing touches
 *  the point (the caller's own no-op case, mirroring `buildPostEditPointEntitiesAt` returning
 *  `[]`). */
export function buildPostEditResetLifelines(
  baseline: PostEditBaseline,
  commands: PostEditCommand[],
  point: [number, number],
  level: number | undefined,
  nodeById: ReadonlyMap<number, NodeDto>,
  multiFloor: boolean,
  splitCtx: SplitLabelContext | null,
): PostEditResetLifelineDescriptor[] {
  const affected = collectAffectedLifelineKeys(baseline, commands, point, level);
  if (affected.size === 0) return [];

  // One entry per key, keeping the LAST command index in log order that names it — a lifeline's
  // most recent command is both the one whose denormalized fields best describe its current state
  // AND the one a row's click should actually undo.
  const latestIndexByKey = new Map<string, number>();
  commands.forEach((command, i) => {
    for (const key of lifelineKeysOf(command)) {
      if (affected.has(key)) latestIndexByKey.set(key, i);
    }
  });

  // Group affected keys by their shared latest `commandIndex` — a command naming several lifelines
  // at once (`removeSplitPoint`) must produce exactly ONE row, not one per lifeline it names,
  // otherwise two rows would both delete the same shared command.
  const keysByIndex = new Map<number, string[]>();
  for (const [key, commandIndex] of latestIndexByKey) {
    const group = keysByIndex.get(commandIndex);
    if (group) group.push(key);
    else keysByIndex.set(commandIndex, [key]);
  }

  const rows: PostEditResetLifelineDescriptor[] = [];
  for (const [commandIndex, keys] of keysByIndex) {
    rows.push({
      keys,
      commandIndex,
      command: commands[commandIndex],
      label: postEditCommandLabel(commands[commandIndex], nodeById, multiFloor, splitCtx),
    });
  }
  // Sort by log order (a row's position follows its own command's position), same reading order
  // the "Changes" panel's own oldest-to-newest indices give.
  rows.sort((a, b) => a.commandIndex - b.commandIndex);
  return rows;
}
