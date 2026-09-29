import React from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { ui, radius, dialogSpacing, typography, inset } from "../styles/theme";
import * as m from "~/paraglide/messages";

interface Props {
  message: string;
  onClose: () => void;
  title?: string;
}

export function AlertModal({ message, onClose, title }: Props) {
  return (
    <Modal title={title ?? m["common.notice"]()} size="approve" onClose={onClose} onConfirm={onClose}>
      <div style={styles.message}>{message}</div>
      <div style={styles.footer}>
        <Button variant="primary" layoutStyle={styles.btnOk} onClick={onClose}>{m["common.ok"]()}</Button>
      </div>
    </Modal>
  );
}

const styles: Record<string, React.CSSProperties> = {
  message: {
    ...typography.message,
    lineHeight: 1.5,
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
};
