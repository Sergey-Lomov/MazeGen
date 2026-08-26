import React, { useMemo } from "react";
import { useMazeStore } from "../../store/mazeStore";
import { Modal } from "../Modal";
import { Button } from "../Button";
import { Switch } from "../Switch";
import { cellExistsAt } from "../../pixi/fieldEditUtils";
import { resolveFieldAtOf } from "../../store/storeHelpers";
import { ui, radius, dialogSpacing, typography, inset } from "../../styles/theme";
import * as m from "~/paraglide/messages";

interface Props {
  onClose: () => void;
}

type FloorRowStatus = "current" | "available" | "no_cell";

/** Multi-floor picker for an in-progress preset elevator placement (GitHub issue #357) — the first
 * click (`presetElevatorPending.origin`) already fixed the elevator's own `(x, y)` point and its
 * origin floor; this dialog only decides *which other floors* it also reaches. Mirrors
 * `CopyFloorDialog`'s row layout (including bottom-to-top floor order — `floors[0]` is "Floor 1",
 * the bottom floor, same convention `FloorSwitcher`/`CopyFloorDialog` use), but every row is an
 * independent toggle (`Switch`) instead of a single-select list. Each row also carries a status:
 * `"current"` (the origin floor — always on, can't be turned off), `"available"` (has a cell at the
 * elevator's own point, off by default), or `"no_cell"` (no cell there — can't be selected at all,
 * GitHub issue #357 follow-up: silently letting a floor without a cell be picked would create a
 * client-invalid elevator, see `computeInvalidElevatorIds`). */
export function PresetElevatorFloorDialog({ onClose }: Props) {
  const floors = useMazeStore((s) => s.floors);
  const floorFields = useMazeStore((s) => s.floorFields);
  const tessellationKind = useMazeStore((s) => s.tessellationKind);
  const hexOrientation = useMazeStore((s) => s.hexOrientation);
  const triOrientation = useMazeStore((s) => s.triOrientation);
  const pending = useMazeStore((s) => s.presetElevatorPending);
  const toggleFloor = useMazeStore((s) => s.togglePresetElevatorFloor);
  const confirm = useMazeStore((s) => s.confirmPresetElevatorPlacement);

  const resolveFieldAt = useMemo(
    () => resolveFieldAtOf({ floors, floorFields, tessellationKind, hexOrientation, triOrientation }),
    [floors, floorFields, tessellationKind, hexOrientation, triOrientation],
  );

  if (!pending) return null;
  const originLevel = pending.origin.level ?? 0;
  const canConfirm = pending.floors.size >= 2;

  const statusOf = (index: number): FloorRowStatus => {
    if (index === originLevel) return "current";
    return cellExistsAt(resolveFieldAt, pending.origin.point, index === 0 ? undefined : index) ? "available" : "no_cell";
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
        <Button variant="secondary" layoutStyle={styles.btnCancel} onClick={onClose}>{m["common.cancel"]()}</Button>
        <Button
          variant="primary"
          layoutStyle={styles.btnOk}
          disabled={!canConfirm}
          onClick={() => { confirm(); onClose(); }}
        >
          {m["common.confirm"]()}
        </Button>
      </div>
    </Modal>
  );
}

// Mirrors CopyFloorDialog's row look and ConfirmModal's footer button styling.
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
