import React, { useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { sharedStyles } from "../styles/shared";
import { dialogSpacing, inset, radius, typography, ui } from "../styles/theme";
import { lastSavedFileName, supportsInPlaceSave } from "../store/projectExport/fileSave";
import * as m from "~/paraglide/messages";

interface Props {
  defaultBaseName: string;
  extension: string;
  /** When set, the confirmed base name is remembered under this key and prefills the dialog next
   *  time instead of `defaultBaseName`. */
  rememberKey?: string;
  /** Writes to a user-chosen file (GitHub issue #1077). Offered only in browsers that support it
   *  (`supportsInPlaceSave`); then `onConfirm` becomes the separate "Download" action. */
  onSaveInPlace?: (fileName: string) => void;
  onConfirm: (fileName: string) => void;
  onCancel: () => void;
}

const LAST_NAME_STORAGE_PREFIX = "maze:lastFileBaseName:";

/** Returns the base name last confirmed under `key`, or null when none is stored. */
export function readLastBaseName(key: string): string | null {
  try {
    const value = localStorage.getItem(LAST_NAME_STORAGE_PREFIX + key);
    return value !== null && value.trim().length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** The file saved in place this session wins over the remembered name, then the generated one. */
function initialBaseName(rememberKey: string | undefined, extension: string, defaultBaseName: string): string {
  if (rememberKey === undefined) return defaultBaseName;
  const saved = lastSavedFileName(rememberKey);
  if (saved !== null && saved.endsWith(extension) && saved.length > extension.length) return saved.slice(0, -extension.length);
  return readLastBaseName(rememberKey) ?? defaultBaseName;
}

function writeLastBaseName(key: string, baseName: string): void {
  try {
    localStorage.setItem(LAST_NAME_STORAGE_PREFIX + key, baseName);
  } catch {
    // Storage may be unavailable; the name is simply not remembered.
  }
}

/** Formats a compact local timestamp (day, hour, minute, second) that is safe in file names. */
export function timestampedBaseName(prefix: string, date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${prefix}-${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** Collects the editable base of a download name. The required extension is shown separately and
 *  never becomes editable. */
export function FileNameModal({ defaultBaseName, extension, rememberKey, onSaveInPlace, onConfirm, onCancel }: Props) {
  const inPlace = onSaveInPlace !== undefined && supportsInPlaceSave();
  const [baseName, setBaseName] = useState(() => initialBaseName(rememberKey, extension, defaultBaseName));
  const canConfirm = baseName.trim().length > 0;
  const submit = (action: (fileName: string) => void) => {
    if (!canConfirm) return;
    if (rememberKey !== undefined) writeLastBaseName(rememberKey, baseName);
    action(`${baseName}${extension}`);
  };
  const confirm = () => submit(inPlace ? onSaveInPlace : onConfirm);

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
        {inPlace && <Button variant="secondary" dialogAction layoutStyle={styles.button} disabled={!canConfirm} onClick={() => submit(onConfirm)}>{m["file_name.download"]()}</Button>}
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
