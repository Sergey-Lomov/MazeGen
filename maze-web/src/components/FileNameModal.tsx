import React, { useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { sharedStyles } from "../styles/shared";
import { dialogSpacing, inset, radius, typography, ui } from "../styles/theme";
import * as m from "~/paraglide/messages";

interface Props {
  defaultBaseName: string;
  extension: string;
  onConfirm: (fileName: string) => void;
  onCancel: () => void;
}

/** Formats a compact local timestamp (day, hour, minute, second) that is safe in file names. */
export function timestampedBaseName(prefix: string, date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${prefix}-${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** Collects the editable base of a download name. The required extension is shown separately and
 *  never becomes editable. */
export function FileNameModal({ defaultBaseName, extension, onConfirm, onCancel }: Props) {
  const [baseName, setBaseName] = useState(defaultBaseName);
  const canConfirm = baseName.trim().length > 0;
  const confirm = () => {
    if (canConfirm) onConfirm(`${baseName}${extension}`);
  };

  return (
    <Modal title={m["file_name.title"]()} size="approveWide" layoutStyle={{ width: "min(460px, calc(100vw - 32px))" }} onClose={onCancel} onConfirm={canConfirm ? confirm : undefined}>
      <label style={styles.label}>
        {m["file_name.label"]()}
        <div style={styles.fileNameRow}>
          <input
            autoFocus
            type="text"
            name="file-name"
            value={baseName}
            onChange={(event) => setBaseName(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            style={styles.input}
          />
          <span aria-hidden="true" style={styles.extension}>{extension}</span>
        </div>
      </label>
      <div style={styles.footer}>
        <Button variant="secondary" dialogAction layoutStyle={styles.button} onClick={onCancel}>{m["common.cancel"]()}</Button>
        <Button variant="primary" dialogAction layoutStyle={styles.button} disabled={!canConfirm} onClick={confirm}>{m["file_name.save"]()}</Button>
      </div>
    </Modal>
  );
}

const styles: Record<string, React.CSSProperties> = {
  label: { ...sharedStyles.fieldLabel },
  fileNameRow: { display: "flex", alignItems: "center", gap: 4 },
  input: { ...sharedStyles.input, flex: 1, minWidth: 0, boxSizing: "border-box" },
  extension: { ...typography.field, color: ui.text.tertiary, flexShrink: 0 },
  footer: { display: "flex", justifyContent: "flex-end", gap: dialogSpacing.gap, paddingTop: dialogSpacing.paddingY, borderTop: `1px solid ${ui.border.default}` },
  button: { ...typography.control, padding: `${inset.buttonInsetY}px ${inset.buttonInsetX}px`, cursor: "default", borderRadius: radius.sm },
};
