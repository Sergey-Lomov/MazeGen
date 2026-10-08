import React from "react";
import { sharedStyles } from "../styles/shared";
import { typography } from "../styles/theme";
import { Inline } from "./Layout";
import { TextInput } from "./TextInput";

/** Shared labeled text-input row — label + single-line `<input type="text">`, mirrors
 *  `ColorRow`/`SelectRow`/`ToggleRow`'s label + control shape so a free-text param lines up
 *  identically in the same settings list. Draft/commit handling (an invalid keystroke shows but
 *  doesn't commit) is `TextInput`'s job, same convention as `NumberInput` — no error styling of
 *  its own, same as `NumberInput`'s row callers. */
export function TextFieldRow({
  label,
  value,
  onChange,
  normalize,
  isValid,
  disabled,
  inputWidth = 100,
  resetButton,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Silently reshapes a draft before the invalid-check — see `TextInput`'s own doc. */
  normalize?: (raw: string) => string;
  /** Classifies the (already `normalize`d) draft — see `TextInput`'s own doc. Valid by default
   *  (any text is valid). */
  isValid?: (raw: string) => boolean;
  disabled?: boolean;
  /** Fixed field width so the label column stays consistent across rows (like `ColorRow`'s swatch). */
  inputWidth?: number;
  /** Trailing control (GitHub issue #652's per-field link-status icon, `LinkStatusIcon`) — the
   *  label stays `flex: 1`, so this never shrinks it. */
  resetButton?: React.ReactNode;
}) {
  return (
    <Inline gap="groupGap">
      <span style={{ ...styles.label, ...(disabled ? { opacity: 0.4 } : {}) }}>{label}</span>
      <TextInput
        name={label}
        style={{ ...sharedStyles.textFieldSm, width: inputWidth, flexShrink: 0 }}
        value={value}
        onChange={onChange}
        normalize={normalize}
        isValid={isValid}
        disabled={disabled}
        aria-label={label}
      />
      {resetButton}
    </Inline>
  );
}

const styles: Record<string, React.CSSProperties> = {
  label: { flex: 1, ...typography.body },
};
