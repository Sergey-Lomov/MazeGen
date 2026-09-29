import React from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { ui, radius, dialogSpacing, typography, inset } from "../styles/theme";
import * as m from "~/paraglide/messages";

interface Props {
  title?: string;
  message?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({ title = m["common.confirm"](), message, onConfirm, onCancel }: Props) {
  return (
    <Modal title={title} size="approve" onClose={onCancel} onConfirm={onConfirm}>
      {message && <div style={styles.message}>{message}</div>}
      <div style={{ ...styles.footer, ...(message ? styles.footerWithMessage : {}) }}>
        <Button variant="secondary" layoutStyle={styles.btnCancel} onClick={onCancel}>{m["common.cancel"]()}</Button>
        <Button variant="primary" layoutStyle={styles.btnOk} onClick={onConfirm}>{m["common.ok"]()}</Button>
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
  },
  footerWithMessage: {
    paddingTop: dialogSpacing.paddingY,
    borderTop: `1px solid ${ui.border.default}`,
  },
  btnOk: {
    ...typography.control,
    padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`,
    cursor: "default",
    borderRadius: radius.sm,
  },
  btnCancel: {
    ...typography.control,
    padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`,
    cursor: "default",
    borderRadius: radius.sm,
  },
};
