import React from "react";
import { Modal } from "./Modal";
import { colors, font, radius, dialogSpacing } from "../styles/theme";
import * as m from "~/paraglide/messages";

interface Props {
  message: string;
  onClose: () => void;
}

export function AlertModal({ message, onClose }: Props) {
  return (
    <Modal title={m["common.notice"]()} size="approve" onClose={onClose}>
      <div style={styles.message}>{message}</div>
      <div style={styles.footer}>
        <button style={styles.btnOk} onClick={onClose}>{m["common.ok"]()}</button>
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
};
