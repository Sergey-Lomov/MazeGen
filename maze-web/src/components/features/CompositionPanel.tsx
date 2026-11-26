import { useState, type CSSProperties } from "react";
import { Eye, EyeOff, Lock, LockOpen } from "lucide-react";
import { useMazeStore } from "../../store/mazeStore";
import { SidePanel } from "../SidePanel";
import { ConfirmModal } from "../ConfirmModal";
import { Stack } from "../Layout";
import { Button } from "../Button";
import { ListCell, ListCellAction } from "../ListCell";
import { EditIconButton } from "../EditIconButton";
import { ui, radius, typography, spacing } from "../../styles/theme";
import { sharedStyles } from "../../styles/shared";
import { ELEMENT_TYPES, resolveElementType } from "../../composition/elementTypes";
import * as m from "~/paraglide/messages";

/** Side panel of the export composition (GitHub issue #1099): the add buttons and the element list. The elements
 *  themselves are drawn on the main canvas by `CompositionLayer`. The list shows the top-most element first. */
export function CompositionPanel() {
  const composition = useMazeStore((s) => s.compositions.find((c) => c.id === s.activeCompositionId));
  const selectedId = useMazeStore((s) => s.selectedCompositionElementId);
  const setOpen = useMazeStore((s) => s.setCompositionPanelOpen);
  const addElement = useMazeStore((s) => s.addCompositionElement);
  const removeElement = useMazeStore((s) => s.removeCompositionElement);
  const moveElement = useMazeStore((s) => s.moveCompositionElement);
  const renameElement = useMazeStore((s) => s.renameCompositionElement);
  const setVisible = useMazeStore((s) => s.setCompositionElementVisible);
  const setLocked = useMazeStore((s) => s.setCompositionElementLocked);
  const select = useMazeStore((s) => s.selectCompositionElement);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);

  if (!composition) return null;
  const pendingRemove = composition.elements.find((e) => e.id === pendingRemoveId);
  const rows = composition.elements.map((element, index) => ({ element, index })).reverse();

  function commitRename() {
    if (renamingId !== null) renameElement(renamingId, renameDraft);
    setRenamingId(null);
  }

  return (
    <>
    <SidePanel title={m["composition.title"]()} stackKey="composition" onClose={() => setOpen(false)}>
      <div role="list" aria-label={m["composition.list_label"]()} style={styles.list}>
        {rows.map(({ element, index }) => (
          <ListCell
            key={element.id}
            role="listitem"
            className="hoverable"
            data-testid="composition-row"
            data-element-id={element.id}
            onClick={() => select(element.id)}
            current={element.id === selectedId}
            actionsPlacement="title"
            truncateTitle
            title={renamingId === element.id ? (
              <input
                style={styles.titleInput}
                name="composition-element-name"
                aria-label={m["composition.rename"]()}
                value={renameDraft}
                autoFocus
                onChange={(e) => setRenameDraft(e.target.value)}
                onBlur={commitRename}
                onClick={(e) => e.stopPropagation()}
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
              <span title={resolveElementType(element.type)?.label()}>{element.name}</span>
            )}
            actions={(
              <>
                <ListCellAction action="move-up" title={m["composition.move_up"]()} disabled={element.locked || index === composition.elements.length - 1} onAction={() => moveElement(element.id, index + 1)} />
                <ListCellAction action="move-down" title={m["composition.move_down"]()} disabled={element.locked || index === 0} onAction={() => moveElement(element.id, index - 1)} />
                <ListCellAction title={element.visible ? m["composition.hide"]() : m["composition.show"]()} onAction={() => setVisible(element.id, !element.visible)}>
                  {element.visible ? <Eye size={16} /> : <EyeOff size={16} />}
                </ListCellAction>
                <ListCellAction title={element.locked ? m["composition.unlock"]() : m["composition.lock"]()} selected={element.locked} onAction={() => setLocked(element.id, !element.locked)}>
                  {element.locked ? <Lock size={16} /> : <LockOpen size={16} />}
                </ListCellAction>
                <EditIconButton
                  title={m["composition.edit"]()}
                  fontSize={15}
                  disabled={element.locked}
                  onClick={(e) => {
                    e.stopPropagation();
                    setRenamingId(element.id);
                    setRenameDraft(element.name);
                  }}
                />
                <ListCellAction action="delete" title={m["composition.remove"]()} danger disabled={element.locked} onAction={() => setPendingRemoveId(element.id)} />
              </>
            )}
          />
        ))}
      </div>
      <Stack gap="itemGap" style={styles.panelBody}>
        {rows.length === 0 && <span style={styles.empty}>{m["composition.empty"]()}</span>}
        {ELEMENT_TYPES.map((type) => (
          <Button key={type.id} variant="primary" layoutStyle={styles.fullWidth} onClick={() => addElement(type.id)}>
            {m["composition.add_element"]({ type: type.label() })}
          </Button>
        ))}
      </Stack>
    </SidePanel>
    {pendingRemove && (
      <ConfirmModal
        message={m["composition.confirm_remove"]({ name: pendingRemove.name })}
        onConfirm={() => {
          removeElement(pendingRemove.id);
          setPendingRemoveId(null);
        }}
        onCancel={() => setPendingRemoveId(null)}
      />
    )}
    </>
  );
}

const styles: Record<string, CSSProperties> = {
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
  empty: { ...typography.body, color: ui.text.secondary },
  fullWidth: { width: "100%" },
};
