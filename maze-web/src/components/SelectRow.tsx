import React from "react";
import { sharedStyles } from "../styles/shared";
import { typography } from "../styles/theme";
import { Inline } from "./Layout";
import { InfoIconButton } from "./InfoIconButton";

/** Shared labeled `<select>` row — label + native select, mirrors `ColorRow`/`ToggleRow`'s label +
 *  control shape so an enum param lines up identically in the same settings list. */
export function SelectRow<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  info,
  resetButton,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  /** Opens an info popup for this row — renders a small clickable "ℹ" after the select, before
   *  `resetButton`. */
  info?: () => void;
  /** Trailing control (GitHub issue #322's per-field "Shared style" reset button,
   *  `OverrideResetButton`) — the label stays `flex: 1`, so this never shrinks it. */
  resetButton?: React.ReactNode;
}) {
  return (
    <Inline gap="groupGap">
      <span style={{ ...styles.label, ...(disabled ? { opacity: 0.4 } : {}) }}>{label}</span>
      <select
        style={sharedStyles.selectSm}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>
        ))}
      </select>
      {info && <InfoIconButton onClick={info} />}
      {resetButton}
    </Inline>
  );
}

const styles: Record<string, React.CSSProperties> = {
  label: { flex: 1, ...typography.body },
};
