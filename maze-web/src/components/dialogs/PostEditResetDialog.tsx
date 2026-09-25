import React from "react";
import { useMazeStore } from "../../store/mazeStore";
import { Modal } from "../Modal";
import { Button } from "../Button";
import { ui, radius, dialogSpacing, spacing, typography, inset, muted } from "../../styles/theme";
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
  const lifelines = prompt?.lifelines ?? [];

  if (!prompt) return null;
  if (lifelines.length === 0) {
    onClose();
    return null;
  }
  const [x, y] = prompt.point;

  return (
    <Modal title={m["post_edit.reset_dialog_title"]({ x, y })} size="approveWide" onClose={onClose}>
      <p style={styles.hint}>{m["post_edit.reset_dialog_hint"]()}</p>
      <div style={styles.list}>
        {lifelines.map((l) => (
          <Button
            key={l.commandIndex}
            variant="secondary"
            layoutStyle={styles.item}
            onClick={() => resetOne(l.commandIndex, l.command, l.keys)}
          >
            <span style={styles.action}>{l.label.action}</span>
            {l.label.entityId !== undefined && <span style={styles.idBubble}>id: {l.label.entityId}</span>}
            <div style={styles.bubbles}>
              {l.label.bubbles.map((bubble, j) => (
                <span key={j} style={styles.bubbleGroup}>
                  {j > 0 && l.label.showArrow && <span style={styles.arrow}>{l.label.arrow}</span>}
                  <span style={styles.bubble}>{bubble.text}</span>
                </span>
              ))}
            </div>
          </Button>
        ))}
      </div>
      <div style={styles.footer}>
        <Button variant="secondary" layoutStyle={styles.btnCancel} onClick={onClose}>{m["common.cancel"]()}</Button>
        <Button variant="destructive" layoutStyle={styles.btnCancel} onClick={() => { resetAll(); onClose(); }}>
          {m["post_edit.reset_dialog_all"]()}
        </Button>
      </div>
    </Modal>
  );
}

const styles: Record<string, React.CSSProperties> = {
  hint: {
    ...typography.control,
    color: ui.text.secondary,
    margin: 0,
    paddingBottom: dialogSpacing.paddingY,
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: dialogSpacing.gap,
  },
  item: {
    ...typography.control,
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: spacing.rowGap,
    width: "100%",
    justifyContent: "flex-start",
    padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`,
    borderRadius: radius.sm,
  },
  action: {
    ...typography.body,
    whiteSpace: "nowrap",
  },
  idBubble: {
    ...typography.caption,
    fontFamily: "Consolas, Menlo, Monaco, monospace",
    display: "inline-flex",
    alignItems: "center",
    borderStyle: "solid",
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: `0 ${spacing.itemGap}px`,
    background: ui.bg.success,
    borderColor: ui.text.success,
    color: ui.text.success,
    whiteSpace: "nowrap",
  },
  bubbles: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: spacing.itemGap / 2,
  },
  bubbleGroup: {
    display: "inline-flex",
    alignItems: "center",
    gap: spacing.itemGap,
  },
  arrow: {
    ...muted(typography.caption),
  },
  bubble: {
    ...typography.caption,
    fontFamily: "Consolas, Menlo, Monaco, monospace",
    display: "inline-flex",
    alignItems: "center",
    borderStyle: "solid",
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: `0 ${spacing.itemGap}px`,
    background: ui.debug.refHighlight.bg,
    borderColor: ui.debug.refHighlight.text,
    color: ui.debug.refHighlight.text,
    whiteSpace: "nowrap",
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: dialogSpacing.gap,
    paddingTop: dialogSpacing.paddingY,
    borderTop: `1px solid ${ui.border.default}`,
  },
  btnCancel: {
    ...typography.control,
    padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`,
    cursor: "default",
    borderRadius: radius.sm,
  },
};
