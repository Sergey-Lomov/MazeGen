import React, { useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { Modal } from "../Modal";
import { Button } from "../Button";
import { SelectableList, SelectableRow } from "../SelectableList";
import { Switch } from "../Switch";
import { ui, radius, dialogSpacing, typography, inset } from "../../styles/theme";
import * as m from "~/paraglide/messages";

interface Props {
  onClose: () => void;
}

export function CopyFloorDialog({ onClose }: Props) {
  const floors = useMazeStore((s) => s.floors);
  const activeFloorId = useMazeStore((s) => s.activeFloorId);
  const copyFloorField = useMazeStore((s) => s.copyFloorField);

  // Topmost floor first.
  const displayedFloors = [...floors].reverse();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [includeTopology, setIncludeTopology] = useState(true);

  function handleConfirm() {
    if (!selectedId) return;
    copyFloorField(selectedId, includeTopology);
    onClose();
  }

  return (
    <Modal title={m["field.copy_floor_title"]()} size="approve" onClose={onClose} onConfirm={selectedId ? handleConfirm : undefined}>
      <SelectableList
        appearance="dialog"
        autoFocus
        selected={selectedId}
        values={displayedFloors.filter((floor) => floor.id !== activeFloorId).map((floor) => floor.id)}
        onSelect={setSelectedId}
        ariaLabel={m["field.copy_floor_title"]()}
      >
        {displayedFloors.map((floor) => (
          <SelectableRow key={floor.id} value={floor.id} selected={floor.id === selectedId} disabled={floor.id === activeFloorId}>
            {floor.title}
          </SelectableRow>
        ))}
      </SelectableList>
      <div style={styles.toggleRow}>
        <span>{m["field.copy_floor_include_topology"]()}</span>
        <Switch checked={includeTopology} onChange={setIncludeTopology} ariaLabel={m["field.copy_floor_include_topology"]()} />
      </div>
      <div style={styles.footer}>
        <Button variant="secondary" dialogAction layoutStyle={styles.btnCancel} onClick={onClose}>{m["common.cancel"]()}</Button>
        <Button
          variant="primary"
          dialogAction
          layoutStyle={styles.btnOk}
          disabled={!selectedId}
          onClick={handleConfirm}
        >
          {m["common.confirm"]()}
        </Button>
      </div>
    </Modal>
  );
}

// Footer button styling mirrors `ConfirmModal`.
const styles: Record<string, React.CSSProperties> = {
  toggleRow: {
    ...typography.control,
    color: ui.text.secondary,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: `${dialogSpacing.paddingY}px ${dialogSpacing.paddingX}px`,
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: dialogSpacing.gap,
    paddingTop: dialogSpacing.paddingY,
    borderTop: `1px solid ${ui.border.default}`,
  },
  btnOk: {
    ...typography.control,
    padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`,
    cursor: "default",
    borderRadius: radius.sm,
  },
  btnCancel: {
    ...typography.control,
    padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`,
    cursor: "default",
    borderRadius: radius.sm,
  },
};
