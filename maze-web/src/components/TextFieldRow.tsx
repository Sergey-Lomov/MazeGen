import React from "react";
import { sharedStyles } from "../styles/shared";
import { typography, ui } from "../styles/theme";
import { Inline } from "./Layout";

/** Shared labeled text-input row — label + single-line `<input type="text">`, mirrors
 *  `ColorRow`/`SelectRow`/`ToggleRow`'s label + control shape so a free-text param lines up
 *  identically in the same settings list. */
export function TextFieldRow({
  label,
  value,
  onChange,
  disabled,
  invalid,
  inputWidth = 100,
  resetButton,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Render the field with an error border and `aria-invalid` (validation is the caller's job). */
  invalid?: boolean;
  /** Fixed field width so the label column stays consistent across rows (like `ColorRow`'s swatch). */
  inputWidth?: number;
  /** Trailing control (GitHub issue #322's per-field "Shared style" reset button,
   *  `OverrideResetButton`) — the label stays `flex: 1`, so this never shrinks it. */
  resetButton?: React.ReactNode;
}) {
  return (
    <Inline gap="groupGap">
      <span style={{ ...styles.label, ...(disabled ? { opacity: 0.4 } : {}) }}>{label}</span>
      <input
        type="text"
        name={label}
        style={{ ...sharedStyles.textFieldSm, ...(invalid ? styles.invalid : null), width: inputWidth, flexShrink: 0 }}
        value={value}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={invalid}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
      />
      {resetButton}
    </Inline>
  );
}

const styles: Record<string, React.CSSProperties> = {
  label: { flex: 1, ...typography.body },
  invalid: { borderColor: ui.text.error },
};
