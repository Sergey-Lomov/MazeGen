import React, { useCallback, useEffect, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, ChevronUp, ChevronDown, Trash2 } from "lucide-react";
import { useMazeStore } from "../../store/mazeStore";
import { selectFloorRemovalLosesFieldData, selectFloorChangeLosesGenerationData } from "../../pixi/selectors/mazeSelectors";
import { ConfirmModal } from "../ConfirmModal";
import { SidePanel } from "../SidePanel";
import { Stack } from "../Layout";
import { ListCell, ListCellAction } from "../ListCell";
import { CopyFloorDialog } from "../dialogs/CopyFloorDialog";
import { CopyFieldToFloorsDialog } from "../dialogs/CopyFieldToFloorsDialog";
import { ui, radius, typography, spacing } from "../../styles/theme";
import { sharedStyles } from "../../styles/shared";
import { Button } from "../Button";
import { EditIconButton } from "../EditIconButton";
import { useFieldHint } from "../FieldHint";
import * as m from "~/paraglide/messages";

type PendingAction =
  | { kind: "add" }
  | { kind: "remove"; floorId: string; message: string }
  | { kind: "move"; floorId: string; direction: "up" | "down" };

/** Floors side panel of the field setup card (GitHub issue #1010): the floor list (add / remove /
 * reorder / rename) and the actions that copy the field between floors. */
export function FloorsPanel({ onClose }: { onClose: () => void }) {
  const floors = useMazeStore((s) => s.floors);
  const floorFields = useMazeStore((s) => s.floorFields);
  const mazeDirty = useMazeStore((s) => s.mazeDirty);
  const postEditDirty = useMazeStore((s) => s.postEditDirty);
  const addFloor = useMazeStore((s) => s.addFloor);
  const removeFloor = useMazeStore((s) => s.removeFloor);
  const renameFloor = useMazeStore((s) => s.renameFloor);
  const moveFloor = useMazeStore((s) => s.moveFloor);
  const reset = useMazeStore((s) => s.reset);
  const copyFloorFieldToFloors = useMazeStore((s) => s.copyFloorFieldToFloors);
  const activeFloorId = useMazeStore((s) => s.activeFloorId);
  const setActiveFloorId = useMazeStore((s) => s.setActiveFloorId);
  const fieldEditLocked = useMazeStore((s) => s.backgroundAutoFillPreview !== null);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [pending, setPending] = useState<PendingAction | null>(null);
  // The floor that receives a copy (dialog open) / the source floor whose field goes to other floors
  // (dialog open).
  const [copyTargetId, setCopyTargetId] = useState<string | null>(null);
  const [spreadSourceId, setSpreadSourceId] = useState<string | null>(null);
  // An empty rename is reverted on commit, which unmounts the input — the hint is therefore shown on
  // the floor's title text once it is mounted (`revertedFloorId` + `titleEl`), not on the input.
  const [revertedFloorId, setRevertedFloorId] = useState<string | null>(null);
  const [hintPending, setHintPending] = useState(false);
  const [titleEl, setTitleEl] = useState<HTMLElement | null>(null);
  const hint = useFieldHint();
  const setHintAnchor = hint.anchorRef;
  const attachTitle = useCallback((el: HTMLElement | null) => {
    setHintAnchor(el);
    setTitleEl(el);
  }, [setHintAnchor]);
  const hintTargetId = renamingId ?? revertedFloorId;

  const lossGen = selectFloorChangeLosesGenerationData({ mazeDirty, postEditDirty });

  function startRename(id: string, title: string) {
    hint.dismiss();
    setRevertedFloorId(null);
    setRenamingId(id);
    setRenameDraft(title);
  }

  function commitRename() {
    if (renamingId) {
      if (renameDraft.trim()) {
        hint.dismiss();
        setRevertedFloorId(null);
        renameFloor(renamingId, renameDraft);
      } else {
        setRevertedFloorId(renamingId);
        setHintPending(true);
      }
    }
    setRenamingId(null);
  }

  useEffect(() => {
    if (!hintPending || !titleEl) return;
    hint.show({ key: "empty_floor_title", message: () => m["floors.empty_title_hint"]() });
    setHintPending(false);
  }, [hintPending, titleEl, hint]);

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

  function handleAddClick() {
    if (lossGen) setPending({ kind: "add" });
    else addFloor();
  }

  function handleConfirm() {
    if (!pending) return;
    // Confirming here always means the generation/post-edit warning was showing (the field-only
    // message never needs confirmation to also reset the maze) — the user was told the result
    // would be invalidated, so it must actually be cleared, not just left stale with a dangling
    // `mazeDirty` flag. `reset()` wipes nodes/edges/analytics/post-edit state the same way the
    // "Generate" panel's own reset does.
    if (lossGen) reset();
    if (pending.kind === "add") addFloor();
    else if (pending.kind === "remove") removeFloor(pending.floorId);
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
    <>
      <SidePanel title={m["floors.title"]()} stackKey="floors" onClose={onClose}>
        <div style={styles.list}>
          {displayFloors.map((floor, displayIndex) => {
            const isFirst = displayIndex === 0;
            const isLast = displayIndex === displayFloors.length - 1;
            const isRenaming = renamingId === floor.id;
            return (
              <ListCell
                key={floor.id}
                className="hoverable"
                data-testid="floor-row"
                onClick={() => setActiveFloorId(floor.id)}
                actionsPlacement="title"
                title={isRenaming ? (
                  <input
                    style={{ ...styles.titleInput, ...(floor.id === hintTargetId ? hint.fieldStyle : undefined) }}
                    name="floor-title"
                    ref={floor.id === hintTargetId ? attachTitle : undefined}
                    aria-describedby={hint.describedBy}
                    value={renameDraft}
                    autoFocus
                    onChange={(e) => {
                      setRenameDraft(e.target.value);
                      hint.dismiss();
                    }}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") {
                        // The panel must stay open: Escape only cancels the rename.
                        e.preventDefault();
                        setRenamingId(null);
                      }
                    }}
                  />
                ) : (
                  <span ref={floor.id === hintTargetId ? attachTitle : undefined}>{floor.title}</span>
                )}
                truncateTitle
                current={floor.id === activeFloorId}
                actions={(
                  <>
                    <ListCellAction title={m["floors.move_floor_up"]()} disabled={isFirst} onAction={() => handleMoveClick(floor.id, "down")}>
                      <ChevronUp size={16} />
                    </ListCellAction>
                    <ListCellAction title={m["floors.move_floor_down"]()} disabled={isLast} onAction={() => handleMoveClick(floor.id, "up")}>
                      <ChevronDown size={16} />
                    </ListCellAction>
                    {floors.length > 1 && (
                      <>
                        <ListCellAction
                          title={m["field.copy_floor"]()}
                          description={m["floors.copy_floor_description"]()}
                          disabled={fieldEditLocked}
                          onAction={() => setCopyTargetId(floor.id)}
                        >
                          <ArrowDownToLine size={16} />
                        </ListCellAction>
                        <ListCellAction
                          title={m["floors.copy_to_floors"]()}
                          description={m["floors.copy_to_floors_description"]()}
                          disabled={fieldEditLocked}
                          onAction={() => setSpreadSourceId(floor.id)}
                        >
                          <ArrowUpFromLine size={16} />
                        </ListCellAction>
                      </>
                    )}
                    <EditIconButton title={m["floors.rename_floor"]()} fontSize={15} onClick={() => startRename(floor.id, floor.title)} />
                    <ListCellAction
                      title={m["floors.remove_floor"]()}
                      description={floors.length === 1 ? m["floors.remove_last_floor_hint"]() : undefined}
                      danger
                      disabled={floors.length === 1}
                      onAction={() => handleRemoveClick(floor.id)}
                    >
                      <Trash2 size={16} />
                    </ListCellAction>
                  </>
                )}
              />
            );
          })}
        </div>
        <Stack gap="groupGap" style={styles.panelBody}>
          <Button variant="primary" layoutStyle={styles.fullWidth} onClick={handleAddClick}>
            {m["floors.add_floor"]()}
          </Button>
        </Stack>
        {hint.hint}
      </SidePanel>
      {pending !== null && (
        <ConfirmModal
          message={pending.kind === "remove" ? pending.message : pending.kind === "add" ? m["floors.confirm_add_generation"]() : m["floors.confirm_reorder"]()}
          onConfirm={handleConfirm}
          onCancel={() => setPending(null)}
        />
      )}
      {spreadSourceId !== null && (
        <CopyFieldToFloorsDialog
          sourceFloorId={spreadSourceId}
          onSubmit={(targetIds, includeTopology) => {
            copyFloorFieldToFloors(spreadSourceId, targetIds, includeTopology);
            setSpreadSourceId(null);
          }}
          onClose={() => setSpreadSourceId(null)}
        />
      )}
      {copyTargetId !== null && <CopyFloorDialog targetFloorId={copyTargetId} onClose={() => setCopyTargetId(null)} />}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  list: { display: "flex", flexDirection: "column", borderTop: `1px solid ${ui.border.default}` },
  panelBody: { padding: spacing.groupGap },
  titleInput: {
    ...typography.body,
    background: ui.bg.input,
    border: `1px solid ${ui.border.strong}`,
    borderRadius: radius.sm,
    padding: sharedStyles.inputSm.padding,
    width: 160,
    minWidth: 0,
  },
  fullWidth: { width: "100%" },
};
