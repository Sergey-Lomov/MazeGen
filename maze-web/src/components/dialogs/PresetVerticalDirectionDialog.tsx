import React from "react";
import { useMazeStore } from "../../store/mazeStore";
import { Modal } from "../Modal";
import { Button } from "../Button";
import { radius, dialogSpacing, typography, inset } from "../../styles/theme";
import * as m from "~/paraglide/messages";

interface Props {
  onClose: () => void;
}

/** Direction picker for an in-progress preset vertical-passage placement (GitHub issue #357
 * follow-up: single-click placement) — shown only when the clicked floor has a cell on *both*
 * adjacent floors (`presetVerticalPassagePending.availableDirections.length === 2`); when only one
 * direction is available, `startPresetVerticalPassagePlacement` creates the entry immediately and
 * this dialog is never opened. Two plain buttons, no footer Confirm/Cancel — picking a direction
 * both confirms and closes in one action. */
export function PresetVerticalDirectionDialog({ onClose }: Props) {
  const pending = useMazeStore((s) => s.presetVerticalPassagePending);
  const choose = useMazeStore((s) => s.choosePresetVerticalPassageDirection);

  if (!pending) return null;

  return (
    <Modal title={m["preset.vertical_direction_dialog_title"]()} size="approve" onClose={onClose}>
      <div style={styles.row}>
        <Button variant="primary" layoutStyle={styles.btn} onClick={() => { choose("up"); onClose(); }}>
          {m["preset.vertical_direction_up"]()}
        </Button>
        <Button variant="primary" layoutStyle={styles.btn} onClick={() => { choose("down"); onClose(); }}>
          {m["preset.vertical_direction_down"]()}
        </Button>
      </div>
    </Modal>
  );
}

const styles: Record<string, React.CSSProperties> = {
  row: {
    display: "flex",
    gap: dialogSpacing.gap,
  },
  btn: {
    ...typography.control,
    flex: 1,
    padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`,
    cursor: "default",
    borderRadius: radius.sm,
    textAlign: "center",
  },
};
