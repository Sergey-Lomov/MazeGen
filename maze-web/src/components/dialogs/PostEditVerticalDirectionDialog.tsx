import React from "react";
import { useMazeStore } from "../../store/mazeStore";
import { Modal } from "../Modal";
import { Button } from "../Button";
import { radius, dialogSpacing, typography, inset } from "../../styles/theme";
import * as m from "~/paraglide/messages";

interface Props {
  onClose: () => void;
}

/** Direction picker for an in-progress post-edit vertical-passage placement (GitHub issue #341) —
 * mirrors `PresetVerticalDirectionDialog`, shown only when the clicked node's own point has a cell
 * on *both* adjacent floors (`postEditVerticalPassagePending.availableDirections.length === 2`). */
export function PostEditVerticalDirectionDialog({ onClose }: Props) {
  const pending = useMazeStore((s) => s.postEditVerticalPassagePending);
  const choose = useMazeStore((s) => s.choosePostEditVerticalPassageDirection);

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
