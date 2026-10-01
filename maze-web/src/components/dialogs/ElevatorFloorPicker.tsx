import type React from "react";
import { Modal } from "../Modal";
import { Button } from "../Button";
import { Switch } from "../Switch";
import { ui, radius, dialogSpacing, typography, inset } from "../../styles/theme";
import * as m from "~/paraglide/messages";

export type ElevatorFloorStatus = "current" | "available" | "no_cell";

export interface ElevatorFloorRow {
  key: string;
  index: number;
  label: string;
  status: ElevatorFloorStatus;
  statusLabel: string;
  checked: boolean;
}

interface Props {
  title: string;
  hint: string;
  rows: ElevatorFloorRow[];
  selectedFloorCount: number;
  minimumFloors?: number;
  onToggle: (row: ElevatorFloorRow) => void;
  onConfirm: () => void;
  onClose: () => void;
}

/** Shared floor-list presentation for preset and post-edit elevator placement. */
export function ElevatorFloorPicker({
  title, hint, rows, selectedFloorCount, minimumFloors = 2, onToggle, onConfirm, onClose,
}: Props) {
  const canConfirm = selectedFloorCount >= minimumFloors;
  return (
    <Modal title={title} size="approve" onClose={onClose} onConfirm={canConfirm ? onConfirm : undefined}>
      <p style={styles.hint}>{hint}</p>
      <div style={styles.list}>
        {rows.map((row) => {
          const disabled = row.status !== "available";
          return (
            <div key={row.key} style={styles.item}>
              <span style={styles.itemLabel}>{row.label} <span style={styles.itemStatus}>({row.statusLabel})</span></span>
              <Switch checked={row.checked} disabled={disabled} onChange={() => !disabled && onToggle(row)} />
            </div>
          );
        })}
      </div>
      <div style={styles.footer}>
        <Button variant="secondary" layoutStyle={styles.button} onClick={onClose}>{m["common.cancel"]()}</Button>
        <Button variant="primary" layoutStyle={styles.button} disabled={!canConfirm} onClick={onConfirm}>{m["common.confirm"]()}</Button>
      </div>
    </Modal>
  );
}

const styles: Record<string, React.CSSProperties> = {
  hint: { ...typography.control, color: ui.text.secondary, margin: 0, paddingBottom: dialogSpacing.paddingY },
  list: { display: "flex", flexDirection: "column" },
  item: { ...typography.control, padding: `6px ${dialogSpacing.paddingX}px`, color: ui.text.secondary, width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between" },
  itemLabel: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  itemStatus: { ...typography.caption, color: ui.text.tertiary },
  footer: { display: "flex", justifyContent: "flex-end", gap: dialogSpacing.gap, paddingTop: dialogSpacing.paddingY, borderTop: `1px solid ${ui.border.default}` },
  button: { ...typography.control, padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`, cursor: "default", borderRadius: radius.sm },
};
