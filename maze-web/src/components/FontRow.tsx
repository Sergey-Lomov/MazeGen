import React from "react";
import { typography } from "../styles/theme";
import { Inline } from "./Layout";
import { FontButton } from "./FontButton";

/** Shared labeled font-picker row: label + `FontButton`, mirrors `ColorRow` / `SelectRow` so a font
 *  param lines up with the other params in a settings list. */
export function FontRow({ label, family, onChange, disabled, resetButton, onPreview, onOpen, onCancel }: {
  label: string;
  family: string;
  onChange: (family: string) => void;
  disabled?: boolean;
  /** Trailing control (the per-field link-status icon); the label stays `flex: 1`. */
  resetButton?: React.ReactNode;
  /** Forwarded to `FontButton`. */
  onPreview?: (family: string) => void;
  /** Forwarded to `FontButton`. */
  onOpen?: () => void;
  /** Forwarded to `FontButton`. */
  onCancel?: () => void;
}) {
  return (
    <Inline gap="groupGap">
      <span style={{ ...styles.label, ...(disabled ? { opacity: 0.4 } : {}) }}>{label}</span>
      <FontButton family={family} title={label} onChange={onChange} disabled={disabled} onPreview={onPreview} onOpen={onOpen} onCancel={onCancel} />
      {resetButton}
    </Inline>
  );
}

const styles: Record<string, React.CSSProperties> = {
  label: { flex: 1, ...typography.body },
};
