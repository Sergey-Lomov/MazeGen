import React from "react";
import { Modal } from "./Modal";
import { colors, font, radius, dialogSpacing } from "../styles/theme";
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
    fontSize: font.lg,
    color: colors.textMuted,
    lineHeight: 1.5,
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: dialogSpacing.gap,
    paddingTop: dialogSpacing.paddingY,
    borderTop: `1px solid ${colors.borderMid}`,
  },
  btnOk: {
    background: colors.bgBtnPrimary,
    border: "none",
    color: colors.textWhite,
    padding: "5px 12px",
    cursor: "pointer",
    borderRadius: radius.sm,
    fontSize: font.lg,
  },
  btnCancel: {
    background: colors.bgInput,
    border: `1px solid ${colors.borderStrong}`,
    color: colors.textMuted,
    padding: "5px 12px",
    cursor: "pointer",
    borderRadius: radius.sm,
    fontSize: font.lg,
  },
};
