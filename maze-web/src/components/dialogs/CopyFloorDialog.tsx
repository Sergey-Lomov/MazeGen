import React, { useState } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { Modal } from "../Modal";
import { Button } from "../Button";
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

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [includeTopology, setIncludeTopology] = useState(true);

  function handleConfirm() {
    if (!selectedId) return;
    copyFloorField(selectedId, includeTopology);
    onClose();
  }

  return (
    <Modal title={m["field.copy_floor_title"]()} size="approve" onClose={onClose} onConfirm={selectedId ? handleConfirm : undefined}>
      <div style={styles.list}>
        {[...floors].reverse().map((floor) => {
          const disabled = floor.id === activeFloorId;
          const selected = floor.id === selectedId;
          return (
            <button
              key={floor.id}
              className={disabled ? undefined : selected ? "hoverable-selected" : "hoverable"}
              style={{
                ...styles.item,
                ...(selected ? styles.itemSelected : {}),
                ...(disabled ? styles.itemDisabled : {}),
              }}
              disabled={disabled}
              onClick={() => setSelectedId(floor.id)}
            >
              <span style={styles.itemLabel}>{floor.title}</span>
            </button>
          );
        })}
      </div>
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

// Mirrors `SeedHistoryDialog`'s row look and `ConfirmModal`'s footer button styling.
const styles: Record<string, React.CSSProperties> = {
  list: {
    display: "flex",
    flexDirection: "column",
  },
  item: {
    ...typography.control,
    background: "none",
    border: "none",
    textAlign: "left" as const,
    padding: `6px ${dialogSpacing.paddingX}px`,
    color: ui.text.secondary,
    cursor: "default",
    width: "100%",
    display: "flex",
    alignItems: "center",
  },
  itemSelected: {
    background: ui.accent.base,
    color: ui.text.inverse,
  },
  itemDisabled: {
    opacity: 0.4,
    cursor: "default",
  },
  itemLabel: {
    flex: 1,
  },
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
  btnOkDisabled: {
    opacity: 0.4,
  },
  btnCancel: {
    ...typography.control,
    padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`,
    cursor: "default",
    borderRadius: radius.sm,
  },
};
