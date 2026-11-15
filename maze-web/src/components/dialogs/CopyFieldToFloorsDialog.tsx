import React, { useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { Modal } from "../Modal";
import { Button } from "../Button";
import { Switch } from "../Switch";
import { CopyDialogText, CopyDialogSection, CopyTopologyOption, copyDialogListStyle } from "./CopyFieldDialogParts";
import { ui, radius, dialogSpacing, typography, inset, indent } from "../../styles/theme";
import * as m from "~/paraglide/messages";

interface Props {
  /** The floor whose field is copied. */
  sourceFloorId: string;
  /** Called with the chosen floors (for "copy to all", every floor but the source) and the
   *  "include topology" switch. */
  onSubmit: (targetFloorIds: string[], includeTopology: boolean) => void;
  onClose: () => void;
}

/** Picks the floors that receive the field of `sourceFloorId` (GitHub issue #1010). The primary
 *  button needs at least one floor chosen and shows how many; "copy to all" works regardless of the
 *  switches. */
export function CopyFieldToFloorsDialog({ sourceFloorId, onSubmit, onClose }: Props) {
  const floors = useMazeStore((s) => s.floors);

  // Topmost floor first.
  const targets = [...floors].reverse().filter((floor) => floor.id !== sourceFloorId);
  const sourceTitle = floors.find((floor) => floor.id === sourceFloorId)?.title ?? "";
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [includeTopology, setIncludeTopology] = useState(true);

  function toggle(id: string, on: boolean) {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
  }

  function handleConfirm() {
    if (selected.size === 0) return;
    onSubmit(targets.filter((floor) => selected.has(floor.id)).map((floor) => floor.id), includeTopology);
  }

  return (
    <Modal
      title={m["floors.copy_to_floors_title"]()}
      size="approve"
      onClose={onClose}
      onConfirm={selected.size > 0 ? handleConfirm : undefined}
    >
      <CopyDialogText>{m["floors.copy_to_floors_text"]({ floor: sourceTitle })}</CopyDialogText>
      <CopyDialogSection label={m["floors.copy_to_label"]()}>
        <div style={copyDialogListStyle}>
          {targets.map((floor) => (
            // The whole row toggles; the switch only mirrors the state (its own click must not toggle twice).
            <div key={floor.id} className="hoverable" style={styles.row} onClick={() => toggle(floor.id, !selected.has(floor.id))}>
              <span style={styles.floorTitle}>{floor.title}</span>
              <span onClick={(event) => event.stopPropagation()}>
                <Switch checked={selected.has(floor.id)} onChange={(on) => toggle(floor.id, on)} ariaLabel={floor.title} />
              </span>
            </div>
          ))}
        </div>
      </CopyDialogSection>
      <CopyTopologyOption checked={includeTopology} onChange={setIncludeTopology} />
      <div style={styles.footer}>
        <Button variant="primary" dialogAction layoutStyle={styles.btn} disabled={selected.size === 0} onClick={handleConfirm}>
          {selected.size > 0 ? `${m["floors.copy_confirm"]()} (${selected.size})` : m["floors.copy_confirm"]()}
        </Button>
        <Button
          variant="secondary"
          dialogAction
          layoutStyle={styles.btn}
          onClick={() => onSubmit(targets.map((floor) => floor.id), includeTopology)}
        >
          {m["floors.copy_to_all"]()}
        </Button>
      </div>
    </Modal>
  );
}

// Button styling mirrors `ConfirmModal`; the rows mirror the indented compact dialog rows of `SelectableRow`
// (the switch, not the padding, sets their height).
const styles: Record<string, React.CSSProperties> = {
  row: {
    ...typography.control,
    color: ui.text.secondary,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: dialogSpacing.gap,
    padding: `1px ${dialogSpacing.paddingX}px 1px ${dialogSpacing.paddingX + indent.tree}px`,
    cursor: "default",
  },
  floorTitle: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  footer: { display: "flex", flexDirection: "column", gap: dialogSpacing.gap / 2, marginTop: dialogSpacing.gap / 2 },
  btn: {
    ...typography.control,
    width: "100%",
    padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`,
    cursor: "default",
    borderRadius: radius.sm,
  },
};
