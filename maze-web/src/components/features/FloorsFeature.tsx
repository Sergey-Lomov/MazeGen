import React, { useState } from "react";
import { X, ChevronUp, ChevronDown } from "lucide-react";
import { useMazeStore } from "../../store/mazeStore";
import { selectFloorRemovalLosesFieldData, selectFloorChangeLosesGenerationData } from "../../pixi/selectors/mazeSelectors";
import { ConfirmModal } from "../ConfirmModal";
import { Stack } from "../Layout";
import { ui, radius, typography, muted, spacing, inset } from "../../styles/theme";
import { sharedStyles } from "../../styles/shared";
import * as m from "~/paraglide/messages";

type PendingAction =
  | { kind: "remove"; floorId: string; message: string }
  | { kind: "move"; floorId: string; direction: "up" | "down" };

export function FloorsFeature() {
  const floors = useMazeStore((s) => s.floors);
  const floorFields = useMazeStore((s) => s.floorFields);
  const mazeDirty = useMazeStore((s) => s.mazeDirty);
  const postEditDirty = useMazeStore((s) => s.postEditDirty);
  const addFloor = useMazeStore((s) => s.addFloor);
  const removeFloor = useMazeStore((s) => s.removeFloor);
  const renameFloor = useMazeStore((s) => s.renameFloor);
  const moveFloor = useMazeStore((s) => s.moveFloor);
  const reset = useMazeStore((s) => s.reset);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [pending, setPending] = useState<PendingAction | null>(null);

  const lossGen = selectFloorChangeLosesGenerationData({ mazeDirty, postEditDirty });

  function startRename(id: string, title: string) {
    setRenamingId(id);
    setRenameDraft(title);
  }

  function commitRename() {
    if (renamingId) renameFloor(renamingId, renameDraft);
    setRenamingId(null);
  }

  function handleRemoveClick(floorId: string) {
    const lossField = selectFloorRemovalLosesFieldData({ floorFields }, floorId);
    const message =
      lossField && lossGen ? m["floors.confirm_remove_both"]() :
      lossField ? m["floors.confirm_remove_field"]() :
      lossGen ? m["floors.confirm_remove_generation"]() :
      null;
    if (message === null) {
      removeFloor(floorId);
    } else {
      setPending({ kind: "remove", floorId, message });
    }
  }

  function handleMoveClick(floorId: string, direction: "up" | "down") {
    if (lossGen) {
      setPending({ kind: "move", floorId, direction });
    } else {
      moveFloor(floorId, direction);
    }
  }

  function handleConfirm() {
    if (!pending) return;
    // Confirming here always means the generation/post-edit warning was showing (the field-only
    // message never needs confirmation to also reset the maze) — the user was told the result
    // would be invalidated, so it must actually be cleared, not just left stale with a dangling
    // `mazeDirty` flag. `reset()` wipes nodes/edges/analytics/post-edit state the same way the
    // "Generate" panel's own reset does.
    if (lossGen) reset();
    if (pending.kind === "remove") removeFloor(pending.floorId);
    else moveFloor(pending.floorId, pending.direction);
    setPending(null);
  }

  // `floors` is stored bottom-to-top (floors[0] = "Floor 1" = bottom, last = newest = top) —
  // addFloor pushes to the end, which is exactly "top" in that convention. The row list itself
  // renders top-to-bottom on screen, i.e. the reverse of storage order, so the visual "up" arrow
  // (toward the top of the screen / newest floors) moves an entry toward the *end* of the
  // `floors` array, not the start — this is why the button below wires "up" to
  // `moveFloor(id, "down")` and vice versa; see storeTypes.ts's `FloorsState.floors` doc comment.
  const displayFloors = [...floors].reverse();

  return (
    <Stack gap="itemGap">
      {displayFloors.map((floor, displayIndex) => {
        const isFirst = displayIndex === 0;
        const isLast = displayIndex === displayFloors.length - 1;
        const isRenaming = renamingId === floor.id;
        return (
          <div key={floor.id} style={styles.floorRow}>
            {isRenaming ? (
              <input
                style={styles.titleInput}
                value={renameDraft}
                autoFocus
                onChange={(e) => setRenameDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") setRenamingId(null);
                }}
              />
            ) : (
              <span style={styles.titleText}>{floor.title}</span>
            )}
            <div style={styles.tools}>
              <button
                className={isFirst ? undefined : "hoverable"}
                style={{ ...styles.moveBtn, ...(isFirst ? styles.moveBtnDisabled : {}) }}
                title={m["floors.move_floor_up"]()}
                disabled={isFirst}
                onClick={() => handleMoveClick(floor.id, "down")}
              >
                <ChevronUp size={16} color={ui.text.tertiary} />
              </button>
              <button
                className={isLast ? undefined : "hoverable"}
                style={{ ...styles.moveBtn, ...(isLast ? styles.moveBtnDisabled : {}) }}
                title={m["floors.move_floor_down"]()}
                disabled={isLast}
                onClick={() => handleMoveClick(floor.id, "up")}
              >
                <ChevronDown size={16} color={ui.text.tertiary} />
              </button>
              <button className="hoverable" style={{ ...styles.editBtn, fontSize: 15 }} title={m["floors.rename_floor"]()} onClick={() => startRename(floor.id, floor.title)}>✎</button>
              <button
                className={floors.length === 1 ? undefined : "hoverable"}
                style={{ ...styles.removeBtn, ...(floors.length === 1 ? styles.removeBtnDisabled : {}) }}
                title={m["floors.remove_floor"]()}
                disabled={floors.length === 1}
                onClick={() => handleRemoveClick(floor.id)}
              >
                <X size={18} color={ui.text.tertiary} />
              </button>
            </div>
          </div>
        );
      })}
      <button className="hoverable" style={styles.addFloorBtn} onClick={() => addFloor()}>
        {m["floors.add_floor"]()}
      </button>
      {pending !== null && (
        <ConfirmModal
          message={pending.kind === "remove" ? pending.message : m["floors.confirm_reorder"]()}
          onConfirm={handleConfirm}
          onCancel={() => setPending(null)}
        />
      )}
    </Stack>
  );
}

const styles: Record<string, React.CSSProperties> = {
  floorRow: {
    display: "flex",
    alignItems: "center",
    gap: spacing.itemGap,
    padding: "7px 6px 7px 10px",
    background: ui.bg.panel,
    borderRadius: radius.md,
    border: `1px solid ${ui.border.default}`,
  },
  titleText: {
    ...muted(typography.field),
    fontWeight: 600,
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  titleInput: {
    ...typography.field,
    fontWeight: 600,
    background: ui.bg.input,
    border: `1px solid ${ui.border.strong}`,
    borderRadius: radius.sm,
    padding: sharedStyles.inputSm.padding,
    flex: 1,
    minWidth: 0,
  },
  tools: {
    display: "flex",
    alignItems: "center",
    gap: spacing.elementsGap,
    flexShrink: 0,
  },
  moveBtn: {
    background: "none",
    border: "none",
    color: ui.text.tertiary,
    padding: 0,
    cursor: "default",
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
  },
  moveBtnDisabled: {
    opacity: 0.25,
    cursor: "default",
  },
  editBtn: {
    ...typography.icon,
    background: "none",
    border: "none",
    color: ui.text.tertiary,
    padding: `0 ${inset.iconButtonInset}px`,
    cursor: "default",
    lineHeight: 1,
    flexShrink: 0,
  },
  removeBtn: {
    background: "none",
    border: "none",
    cursor: "default",
    padding: 0,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
  },
  removeBtnDisabled: {
    opacity: 0.25,
    cursor: "default",
  },
  addFloorBtn: {
    ...typography.control,
    background: "none",
    border: `1px solid ${ui.border.strong}`,
    color: ui.text.tertiary,
    cursor: "default",
    padding: `${inset.buttonInsetY}px 0`,
    borderRadius: radius.md,
    textAlign: "center",
    width: "100%",
  },
};
