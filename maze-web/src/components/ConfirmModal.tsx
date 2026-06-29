import React from "react";
import { Modal } from "./Modal";
import { ui, radius, dialogSpacing, typography } from "../styles/theme";
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
        <button style={styles.btnCancel} onClick={onCancel}>{m["common.cancel"]()}</button>
        <button style={styles.btnOk} onClick={onConfirm}>{m["common.ok"]()}</button>
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
    padding: "5px 12px",
    cursor: "pointer",
    borderRadius: radius.sm,
  },
  btnCancel: {
    ...typography.control,
    background: ui.bg.input,
    border: `1px solid ${ui.border.strong}`,
    color: ui.text.secondary,
    padding: "5px 12px",
    cursor: "pointer",
    borderRadius: radius.sm,
  },
};
