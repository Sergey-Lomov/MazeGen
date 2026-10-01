import { useMazeStore } from "../../store/mazeStore";
import { EntityChoiceDialog, type EntityChoiceRow } from "./EntityChoiceDialog";
import { formatTargetLabel } from "../../pixi/targetLabel";
import * as m from "~/paraglide/messages";

interface Props {
  onClose: () => void;
}

/** Multi-command picker for the post-edit `reset` tool's cell branch (GitHub issue #549, mirroring
 * the delete tool's own `PostEditEntityDeleteDialog` from #550/#540). Shown whenever the targeted
 * point carries more than one still-relevant command (per compaction) — clicking a row resets only
 * that one command (via `deletePostEditCommand`'s existing single-entry-collapse-or-cascade
 * semantics, GitHub issue #547), not a whole lifeline's history. One row per DISTINCT command, not
 * per lifeline (`l.keys` can list more than one — `removeSplitPoint` names every slot it removes at
 * once, so two lifelines sharing that same command collapse into one row, since resetting either
 * would reset both). "Reset all" resets every lifeline touching the point at once, all the way back
 * to generation state (same as a plain `resetPostEditPoint` call, and what held-Shift does without
 * opening this dialog at all).
 * The row list is snapshotted when the dialog opens. Clicking a row may remove that row, but never
 * promotes an older command from the same entity into a new row while the dialog remains open. */
export function PostEditResetDialog({ onClose }: Props) {
  const prompt = useMazeStore((s) => s.postEditResetPrompt);
  const resetOne = useMazeStore((s) => s.resetPostEditPointLifeline);
  const resetAll = useMazeStore((s) => s.resetAllPostEditPointLifelines);
  const floors = useMazeStore((s) => s.floors);
  const lifelines = prompt?.lifelines ?? [];

  if (!prompt) return null;
  if (lifelines.length === 0) {
    onClose();
    return null;
  }
  const coords = formatTargetLabel(prompt.point, prompt.level ?? 0, floors.length > 1, undefined);

  const rows: EntityChoiceRow[] = lifelines.map((l) => ({
    key: String(l.commandIndex),
    title: l.label.action,
    entityId: l.label.entityId,
    bubbles: l.label.bubbles.map((bubble) => bubble.text),
    showArrow: l.label.showArrow,
    arrow: l.label.arrow,
  }));
  return <EntityChoiceDialog
    title={m["post_edit.reset_dialog_title"]({ coords })}
    hint={m["post_edit.reset_dialog_hint"]()}
    rows={rows}
    deleteAllLabel={m["post_edit.reset_dialog_all"]()}
    onSelect={(row) => {
      const lifeline = lifelines.find((l) => String(l.commandIndex) === row.key);
      if (lifeline) resetOne(lifeline.commandIndex, lifeline.command, lifeline.keys);
    }}
    onDeleteAll={() => { resetAll(); onClose(); }}
    onClose={onClose}
  />;
}
