import React, { useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { Modal } from "../Modal";
import { Switch } from "../Switch";
import { cellExistsAt } from "../../pixi/fieldEditUtils";
import { resolveFieldAtOf } from "../../store/storeHelpers";
import { ui, radius, dialogSpacing, typography, inset } from "../../styles/theme";
import * as m from "~/paraglide/messages";

interface Props {
  onClose: () => void;
}

type FloorRowStatus = "current" | "available" | "no_cell";

/** Multi-floor picker for an in-progress post-edit elevator placement (GitHub issue #341) —
 * mirrors `PresetElevatorFloorDialog`, addressed by the clicked node's own `(x, y)` point instead
 * of a `PresetEndpoint`'s cell. */
export function PostEditElevatorFloorDialog({ onClose }: Props) {
  const floors = useMazeStore((s) => s.floors);
  const floorFields = useMazeStore((s) => s.floorFields);
  const tessellationKind = useMazeStore((s) => s.tessellationKind);
  const hexOrientation = useMazeStore((s) => s.hexOrientation);
  const triOrientation = useMazeStore((s) => s.triOrientation);
  const nodes = useMazeStore((s) => s.nodes);
  const pending = useMazeStore((s) => s.postEditElevatorPending);
  const toggleFloor = useMazeStore((s) => s.togglePostEditElevatorFloor);
  const confirm = useMazeStore((s) => s.confirmPostEditElevatorPlacement);

  const resolveFieldAt = useMemo(
    () => resolveFieldAtOf({ floors, floorFields, tessellationKind, hexOrientation, triOrientation }),
    [floors, floorFields, tessellationKind, hexOrientation, triOrientation],
  );

  if (!pending || pending.origin.kind !== "node") return null;
  const originId = pending.origin.id;
  const originNode = nodes.find((n) => n.id === originId);
  if (!originNode) return null;
  const originLevel = originNode.level ?? 0;
  const point: [number, number] = [originNode.x, originNode.y];
  const canConfirm = pending.floors.size >= 2;

  const statusOf = (index: number): FloorRowStatus => {
    if (index === originLevel) return "current";
    return cellExistsAt(resolveFieldAt, point, index === 0 ? undefined : index) ? "available" : "no_cell";
  };
  const statusLabel: Record<FloorRowStatus, string> = {
    current: m["preset.elevator_floor_status_current"](),
    available: m["preset.elevator_floor_status_available"](),
    no_cell: m["preset.elevator_floor_status_no_cell"](),
  };

  return (
    <Modal title={m["preset.elevator_floor_dialog_title"]()} size="approve" onClose={onClose}>
      <p style={styles.hint}>{m["preset.elevator_floor_dialog_hint"]()}</p>
      <div style={styles.list}>
        {floors.map((_, index) => index).reverse().map((index) => {
          const floor = floors[index];
          const status = statusOf(index);
          const checked = pending.floors.has(index);
          const disabled = status !== "available";
          return (
            <div key={floor.id} style={styles.item}>
              <span style={styles.itemLabel}>
                {`${index + 1}: ${floor.title}`} <span style={styles.itemStatus}>({statusLabel[status]})</span>
              </span>
              <Switch checked={checked} disabled={disabled} onChange={() => !disabled && toggleFloor(index)} />
            </div>
          );
        })}
      </div>
      <div style={styles.footer}>
        <button className="hoverable" style={styles.btnCancel} onClick={onClose}>{m["common.cancel"]()}</button>
        <button
          className="hoverable-accent"
          style={{ ...styles.btnOk, ...(canConfirm ? {} : styles.btnOkDisabled) }}
          disabled={!canConfirm}
          onClick={() => { confirm(); onClose(); }}
        >
          {m["common.confirm"]()}
        </button>
      </div>
    </Modal>
  );
}

// Mirrors PresetElevatorFloorDialog's row look and ConfirmModal's footer button styling.
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
  },
  item: {
    ...typography.control,
    padding: `6px ${dialogSpacing.paddingX}px`,
    color: ui.text.secondary,
    width: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  itemLabel: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  itemStatus: {
    ...typography.caption,
    color: ui.text.tertiary,
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
    background: ui.accent.base,
    border: "none",
    color: ui.text.inverse,
    padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`,
    cursor: "default",
    borderRadius: radius.sm,
  },
  btnOkDisabled: {
    opacity: 0.4,
  },
  btnCancel: {
    ...typography.control,
    background: ui.bg.input,
    border: `1px solid ${ui.border.strong}`,
    color: ui.text.secondary,
    padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`,
    cursor: "default",
    borderRadius: radius.sm,
  },
};
