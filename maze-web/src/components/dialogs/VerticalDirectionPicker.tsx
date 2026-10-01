import type React from "react";
import { Modal } from "../Modal";
import { Button } from "../Button";
import { radius, dialogSpacing, typography, inset } from "../../styles/theme";
import * as m from "~/paraglide/messages";

interface Props {
  title: string;
  onSelect: (direction: "up" | "down") => void;
  onClose: () => void;
}

export function VerticalDirectionPicker({ title, onSelect, onClose }: Props) {
  return (
    <Modal title={title} size="approve" onClose={onClose}>
      <div style={styles.row}>
        <Button variant="primary" layoutStyle={styles.button} onClick={() => onSelect("up")}>{m["preset.vertical_direction_up"]()}</Button>
        <Button variant="primary" layoutStyle={styles.button} onClick={() => onSelect("down")}>{m["preset.vertical_direction_down"]()}</Button>
      </div>
    </Modal>
  );
}

const styles: Record<string, React.CSSProperties> = {
  row: { display: "flex", gap: dialogSpacing.gap },
  button: { ...typography.control, flex: 1, padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`, cursor: "default", borderRadius: radius.sm, textAlign: "center" },
};
