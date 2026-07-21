import React from "react";
import { Modal } from "./Modal";
import { ui, radius, dialogSpacing, typography, inset } from "../styles/theme";
import * as m from "~/paraglide/messages";

interface Props {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({ message, onConfirm, onCancel }: Props) {
  return (
    <Modal title={m["common.confirm"]()} size="approve" onClose={onCancel}>
      <div style={styles.message}>{message}</div>
      <div style={styles.footer}>
        <button className="hoverable" style={styles.btnCancel} onClick={onCancel}>{m["common.cancel"]()}</button>
        <button className="hoverable-accent" style={styles.btnOk} onClick={onConfirm}>{m["common.ok"]()}</button>
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
    background: ui.accent.base,
    border: "none",
    color: ui.text.inverse,
    padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`,
    cursor: "default",
    borderRadius: radius.sm,
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
