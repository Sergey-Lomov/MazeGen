import React from "react";
import { typography } from "../styles/theme";
import { Inline } from "./Layout";
import { FontButton } from "./FontButton";
import type { LabelFont } from "../pixi/renderers/fontChoice";

/** Shared labeled font-picker row: label + `FontButton`, mirrors `ColorRow` / `SelectRow` so a font
 *  param lines up with the other params in a settings list. */
export function FontRow({ label, font, onChange, disabled, resetButton, onPreview, onOpen, onCancel }: {
  label: string;
  font: LabelFont;
  onChange: (font: LabelFont) => void;
  disabled?: boolean;
  /** Trailing control (the per-field link-status icon); the label stays `flex: 1`. */
  resetButton?: React.ReactNode;
  /** Forwarded to `FontButton`. */
  onPreview?: (font: LabelFont) => void;
  /** Forwarded to `FontButton`. */
  onOpen?: () => void;
  /** Forwarded to `FontButton`. */
  onCancel?: () => void;
}) {
  return (
    <Inline gap="groupGap">
      <span style={{ ...styles.label, ...(disabled ? { opacity: 0.4 } : {}) }}>{label}</span>
      <FontButton font={font} title={label} onChange={onChange} disabled={disabled} onPreview={onPreview} onOpen={onOpen} onCancel={onCancel} />
      {resetButton}
    </Inline>
  );
}

const styles: Record<string, React.CSSProperties> = {
  label: { flex: 1, ...typography.body },
};
